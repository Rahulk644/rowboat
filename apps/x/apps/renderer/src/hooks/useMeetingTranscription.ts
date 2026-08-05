import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { buildDeepgramListenUrl } from '@/lib/deepgram-listen-url';
import { finalizeDeepgramStream } from '@/lib/deepgram-finalize';
import { useRowboatAccount } from '@/hooks/useRowboatAccount';
import { fetchRowboatConfig } from '@/hooks/use-rowboat-config';
import {
    createTranscriptV2Block,
    isCanonicalTranscriptSnapshot,
    normalizeTranscriptSegments,
    removeTranscriptSegment,
    renderNewMeetingNote,
    replaceOwnedTranscriptV2Block,
    subscribeTranscriptSegmentRevisions,
    type TranscriptChannel,
    type TranscriptSegment,
    unknownSpeaker,
    upsertTranscriptSegments,
} from '@/lib/meeting-transcript-v2';
import {
    SelfHostedMeetingAudioClock,
    type CapturedSelfHostedAudio,
} from '@/lib/self-hosted-meeting-audio-clock';
import { CoalescedAsyncWriter } from '@/lib/coalesced-async-writer';
import { MeetingCaptureWatchdog, type MeetingCaptureChannel } from '@/lib/meeting-capture-watchdog';
import { isKnownIsolatedOutputLabel } from '@/lib/meeting-output-route';
import { MeetingLifecycleGate } from '@/lib/meeting-lifecycle-gate';
import {
    mergeWisprMeetingArtifact,
    type WisprMeetingArtifact,
} from '@/lib/wispr-meeting-artifact';

export type MeetingTranscriptionState = 'idle' | 'connecting' | 'recording' | 'stopping';

const DEEPGRAM_PARAMS = new URLSearchParams({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '2',
    multichannel: 'true',
    diarize: 'true',
    interim_results: 'true',
    smart_format: 'true',
    punctuate: 'true',
    language: 'en',
});
const DEEPGRAM_LISTEN_URL = `wss://api.deepgram.com/v1/listen?${DEEPGRAM_PARAMS.toString()}`;

// Nemotron's qualified streaming profile consumes 560 ms chunks at 16 kHz.
// Rowboat keeps microphone and system audio in separate named sessions so one
// loaded model can preserve source identity without running a second worker.
const SELF_HOSTED_BATCH_SAMPLES = 8_960;
const SELF_HOSTED_MAX_PENDING_BATCHES = 24;
const SELF_HOSTED_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000];
const CAPTURE_WATCHDOG_INTERVAL_MS = 1_000;

// RMS threshold for "someone is talking" on either channel. Drives silence
// detection while staying above faint room-noise levels on the microphone.
const SPEECH_RMS_THRESHOLD = 0.01;

// Silence handling. "Silence" = no audio above SPEECH_RMS_THRESHOLD on EITHER
// the mic or the system-audio channel (i.e. nobody — local or remote — talking).
// - After SILENCE_NUDGE_MS we ask the user (toast) whether to stop.
// - After SILENCE_BACKSTOP_MS we stop unconditionally.
// - Once past the linked calendar event's end time we use the shorter
//   POST_CALENDAR_END_SILENCE_MS, since a lull after the scheduled end is a
//   strong signal the meeting is actually over.
const SILENCE_NUDGE_MS = 2 * 60 * 1000;
const SILENCE_BACKSTOP_MS = 5 * 60 * 1000;
const POST_CALENDAR_END_SILENCE_MS = 2 * 60 * 1000;
// How often the silence checker runs.
const SILENCE_CHECK_INTERVAL_MS = 5 * 1000;

// On Linux getDisplayMedia loopback works too (Chromium captures the default
// sink's monitor through the PulseAudio layer), but the request needs special
// handling in main.ts — see setDisplayMediaRequestHandler there. Note that
// capturing the monitor *source* directly via enumerateDevices/getUserMedia
// is NOT an option: Chromium filters monitor sources out of device
// enumeration on Linux (audio_manager_pulse.cc), so they never appear.
const isLinux = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('linux');
const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');

// ---------------------------------------------------------------------------
// Headphone detection
// ---------------------------------------------------------------------------
async function detectHeadphones(): Promise<boolean> {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === 'audiooutput');
        const defaultOutput = outputs.find(d => d.deviceId === 'default');
        const label = (defaultOutput?.label ?? '').toLowerCase();
        return isKnownIsolatedOutputLabel(label);
    } catch {
        return false;
    }
}

function openMicrophoneCapture(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        },
    });
}

async function openSystemAudioCapture(): Promise<MediaStream> {
    const captureMode = await window.ipc
        .invoke('meeting:getSystemAudioCaptureMode', null)
        // A mismatched main/renderer pair must retain the old, known-safe
        // screen+loopback request rather than assume an audio-only path.
        .catch(() => ({ mode: 'screen-loopback' as const }));
    const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: true,
        video: captureMode.mode === 'audio-only-loopback' ? false : true,
    });
    stream.getVideoTracks().forEach(track => track.stop());
    if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach(track => track.stop());
        throw new Error('No audio track from getDisplayMedia');
    }
    return stream;
}

// ---------------------------------------------------------------------------
// Transcript formatting
// ---------------------------------------------------------------------------
interface SelfHostedSnapshot {
    full: string;
    committed: string;
    tentative: string;
    final: boolean;
    revision?: number;
    inputMs?: number;
    /** v2 bridge events carry revisioned interval-bearing records. */
    version?: number;
    segments?: unknown[];
}

type SelfHostedChannel = 'mic' | 'system';

function pcm16ToBase64(pcm: Int16Array): string {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function floatToPcm16(sample: number): number {
    const bounded = Math.max(-1, Math.min(1, sample));
    return bounded < 0 ? bounded * 0x8000 : bounded * 0x7fff;
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export interface CalendarEventMeta {
    summary?: string
    start?: { dateTime?: string; date?: string }
    end?: { dateTime?: string; date?: string }
    location?: string
    htmlLink?: string
    conferenceLink?: string
    source?: string
}

export type MeetingStopResult = {
    provider: 'rowboat' | 'wispr-flow'
    artifactImported: boolean
    title?: string
}

function formatTranscript(date: string, calendarEvent?: CalendarEventMeta, source = 'rowboat'): string {
    const noteTitle = calendarEvent?.summary || 'Meeting Notes';
    const lines = [
        '---',
        'type: meeting',
        `source: ${source}`,
        `title: ${noteTitle}`,
        `date: "${date}"`,
    ];
    if (calendarEvent) {
        // Serialize as a JSON string on one line — the frontmatter system
        // only supports flat key: value pairs, not nested YAML objects.
        const eventObj: Record<string, string> = {}
        if (calendarEvent.summary) eventObj.summary = calendarEvent.summary
        if (calendarEvent.start?.dateTime) eventObj.start = calendarEvent.start.dateTime
        else if (calendarEvent.start?.date) eventObj.start = calendarEvent.start.date
        if (calendarEvent.end?.dateTime) eventObj.end = calendarEvent.end.dateTime
        else if (calendarEvent.end?.date) eventObj.end = calendarEvent.end.date
        if (calendarEvent.location) eventObj.location = calendarEvent.location
        if (calendarEvent.htmlLink) eventObj.htmlLink = calendarEvent.htmlLink
        if (calendarEvent.conferenceLink) eventObj.conferenceLink = calendarEvent.conferenceLink
        if (calendarEvent.source) eventObj.source = calendarEvent.source
        lines.push(`calendar_event: '${JSON.stringify(eventObj).replace(/'/g, "''")}'`)
    }
    lines.push(
        '---',
        '',
        `# ${noteTitle}`,
        '',
    );
    return renderNewMeetingNote(lines.join('\n'), createTranscriptV2Block([]));
}

async function createMeetingNoteFile(
    calendarEvent: CalendarEventMeta | undefined,
    source: 'rowboat' | 'wispr-flow',
): Promise<string> {
    const now = new Date();
    const dateStr = now.toISOString();
    const dateFolder = dateStr.split('T')[0];
    const timestamp = dateStr.replace(/:/g, '-').replace(/\.\d+Z$/, '');
    const filename = calendarEvent?.summary
        ? calendarEvent.summary.replace(/[\\/*?:"<>|]/g, '').replace(/\s+/g, '_').substring(0, 100).trim()
        : `meeting-${timestamp}`;
    let notePath = `knowledge/Meetings/rowboat/${dateFolder}/${filename}.md`;
    if (calendarEvent?.summary) {
        try {
            const { exists } = await window.ipc.invoke('workspace:exists', { path: notePath });
            if (exists) notePath = `knowledge/Meetings/rowboat/${dateFolder}/${filename}-${timestamp}.md`;
        } catch { /* retain the first candidate */ }
    }
    await window.ipc.invoke('workspace:writeFile', {
        path: notePath,
        data: formatTranscript(dateStr, calendarEvent, source),
        opts: { encoding: 'utf8', mkdirp: true },
    });
    return notePath;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useMeetingTranscription(onAutoStop?: () => void) {
    const { refresh: refreshRowboatAccount } = useRowboatAccount();
    const [state, setState] = useState<MeetingTranscriptionState>('idle');
    const stateRef = useRef<MeetingTranscriptionState>('idle');
    const wsRef = useRef<WebSocket | null>(null);
    const selfHostedMeetingIdRef = useRef<string | null>(null);
    const wisprMeetingIdRef = useRef<string | null>(null);
    const transcriptMeetingIdRef = useRef<string | null>(null);
    const selfHostedCommittedRef = useRef<Record<SelfHostedChannel, string>>({ mic: '', system: '' });
    const selfHostedPcmRef = useRef({
        mic: new Int16Array(SELF_HOSTED_BATCH_SAMPLES),
        system: new Int16Array(SELF_HOSTED_BATCH_SAMPLES),
        length: 0,
    });
    const selfHostedFeedTailRef = useRef<Promise<void>>(Promise.resolve());
    const selfHostedPendingBatchesRef = useRef(0);
    const selfHostedFailureShownRef = useRef(false);
    const selfHostedAudioClockRef = useRef(new SelfHostedMeetingAudioClock());
    const micStreamRef = useRef<MediaStream | null>(null);
    const systemStreamRef = useRef<MediaStream | null>(null);
    const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const systemSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const mergerRef = useRef<ChannelMergerNode | null>(null);
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const captureWatchdogRef = useRef<MeetingCaptureWatchdog | null>(null);
    const captureWatchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const captureRecoveryRef = useRef<((channel: MeetingCaptureChannel, reason: string) => Promise<void>) | null>(null);
    const captureRecoveryInFlightRef = useRef(new Set<MeetingCaptureChannel>());
    const captureDeviceChangeListenerRef = useRef<(() => void) | null>(null);
    const transcriptSegmentsRef = useRef<TranscriptSegment[]>([]);
    const legacySegmentSequenceRef = useRef<Record<SelfHostedChannel, number>>({ mic: 0, system: 0 });
    const legacyInterimRevisionRef = useRef<Record<SelfHostedChannel, number>>({ mic: 0, system: 0 });
    const notePathRef = useRef<string>('');
    const transcriptWriterRef = useRef<CoalescedAsyncWriter | null>(null);
    const lifecycleGateRef = useRef(new MeetingLifecycleGate());
    const transcriptBlockMissingNotifiedRef = useRef(false);
    // Silence detection: timestamp of the last speech-level audio on either
    // channel, plus the interval that checks it. calendarEndMsRef holds the
    // linked event's end time (null if none).
    const lastAudioActivityRef = useRef<number>(0);
    const silenceCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const calendarEndMsRef = useRef<number | null>(null);
    const nudgeToastIdRef = useRef<string | number | null>(null);
    const onAutoStopRef = useRef(onAutoStop);
    onAutoStopRef.current = onAutoStop;

    const writeTranscriptToFile = useCallback(async () => {
        const notePath = notePathRef.current;
        if (!notePath) return;

        // Do not regenerate the note around the transcript. A person can be
        // typing scratchpad notes or editing generated notes while capture is
        // live, and our sole ownership boundary is the transcript-v2 fence.
        try {
            const existing = await window.ipc.invoke('workspace:readFile', { path: notePath, encoding: 'utf8' });
            const content = replaceOwnedTranscriptV2Block(
                existing.data,
                createTranscriptV2Block(transcriptSegmentsRef.current),
            );
            if (content === null) {
                console.warn('[meeting] Transcript block is missing; preserving the user-edited note');
                if (!transcriptBlockMissingNotifiedRef.current) {
                    transcriptBlockMissingNotifiedRef.current = true;
                    toast.error('Live transcript paused', {
                        description: 'Its transcript block was removed from this note. Recording continues safely.',
                        duration: 10_000,
                    });
                }
                return;
            }
            await window.ipc.invoke('workspace:writeFile', {
                path: notePath,
                data: content,
                opts: { encoding: 'utf8' },
            });
        } catch (err) {
            console.error('[meeting] Failed to write transcript:', err);
        }
    }, []);

    const scheduleDebouncedWrite = useCallback(() => {
        transcriptWriterRef.current ??= new CoalescedAsyncWriter(writeTranscriptToFile, 1000);
        transcriptWriterRef.current.schedule();
    }, [writeTranscriptToFile]);

    const upsertSegments = useCallback((incoming: TranscriptSegment[]) => {
        if (incoming.length === 0) return;
        transcriptSegmentsRef.current = upsertTranscriptSegments(transcriptSegmentsRef.current, incoming);
        scheduleDebouncedWrite();
    }, [scheduleDebouncedWrite]);

    // Corrections originate from a TipTap NodeView, not this hook. Sync its
    // returned higher revision before any subsequent debounced file write.
    useEffect(() => subscribeTranscriptSegmentRevisions((segments) => {
        const meetingId = transcriptMeetingIdRef.current;
        if (!meetingId) return;
        upsertSegments(segments.filter(segment => segment.meetingId === meetingId));
    }), [upsertSegments]);

    // Wispr owns capture and transcription in this mode. Electron main emits
    // fast final chunks first, then higher revisions from live/refined NDJSON
    // once source, timing, and speaker evidence are durable.
    useEffect(() => window.ipc.on('meeting:wispr:event', (event) => {
        const meetingId = wisprMeetingIdRef.current;
        if (!meetingId || event.rowboatMeetingId !== meetingId) return;
        upsertSegments(normalizeTranscriptSegments({ version: 2, segments: event.segments }));
    }), [upsertSegments]);

    const applySelfHostedSnapshot = useCallback((channel: SelfHostedChannel, snapshot: SelfHostedSnapshot) => {
        // Canonical bridge events have segment IDs, revisions, intervals, and
        // resolved speaker evidence. Prefer them wholesale over the legacy
        // text-prefix protocol. An empty v2 `segments` array is an intentional
        // no-op delta, not a legacy snapshot: falling through would replay the
        // cumulative `full`/`committed` text because the legacy cursor has
        // never advanced on this v2 session.
        const v2Segments = normalizeTranscriptSegments(snapshot);
        if (isCanonicalTranscriptSnapshot(snapshot)) {
            const meetingId = transcriptMeetingIdRef.current ?? undefined;
            if (v2Segments.length > 0) {
                upsertSegments(v2Segments.map(segment => ({ ...segment, meetingId: segment.meetingId ?? meetingId })));
            }
            return;
        }

        const previousCommitted = selfHostedCommittedRef.current[channel];
        const currentCommitted = snapshot.final ? snapshot.full : snapshot.committed;

        if (currentCommitted.startsWith(previousCommitted)) {
            const delta = currentCommitted.slice(previousCommitted.length).trim();
            if (delta) {
                const sequence = legacySegmentSequenceRef.current[channel]++;
                const endSample = Math.max(0, Math.round((snapshot.inputMs ?? 0) * 16));
                upsertSegments([{
                    meetingId: transcriptMeetingIdRef.current ?? undefined,
                    segmentId: `legacy:${channel}:${sequence}`,
                    revision: Math.max(0, snapshot.revision ?? 0),
                    startSample: endSample,
                    endSample,
                    timingConfidence: 'low',
                    channel,
                    text: delta,
                    finality: snapshot.final ? 'final' : 'stable',
                    clusterIds: [],
                    overlap: false,
                    // A legacy snapshot has no trustworthy identity. In
                    // particular, a mic snapshot is not evidence of `You`.
                    speaker: unknownSpeaker(),
                }]);
            }
            selfHostedCommittedRef.current[channel] = currentCommitted;
        } else if (currentCommitted !== previousCommitted) {
            // Stable committed prefixes must never be revised. Refuse to append
            // conflicting text instead of duplicating or silently corrupting the
            // meeting note; the next final snapshot remains recoverable in logs.
            console.warn('[meeting] Self-hosted committed prefix changed unexpectedly');
        }

        const interimId = `legacy:${channel}:interim`;
        if (snapshot.final || !snapshot.tentative.trim()) {
            transcriptSegmentsRef.current = removeTranscriptSegment(transcriptSegmentsRef.current, interimId);
        } else {
            const nextRevision = legacyInterimRevisionRef.current[channel] + 1;
            legacyInterimRevisionRef.current[channel] = nextRevision;
            const endSample = Math.max(0, Math.round((snapshot.inputMs ?? 0) * 16));
            upsertSegments([{
                meetingId: transcriptMeetingIdRef.current ?? undefined,
                segmentId: interimId,
                revision: nextRevision,
                startSample: endSample,
                endSample,
                timingConfidence: 'low',
                channel,
                text: snapshot.tentative.trim(),
                finality: 'interim',
                clusterIds: [],
                overlap: false,
                speaker: unknownSpeaker(),
            }]);
        }
        scheduleDebouncedWrite();
    }, [scheduleDebouncedWrite, upsertSegments]);

    const queueSelfHostedBatch = useCallback((mic: Int16Array, system: Int16Array) => {
        const meetingId = selfHostedMeetingIdRef.current;
        if (!meetingId) return;
        if (selfHostedPendingBatchesRef.current >= SELF_HOSTED_MAX_PENDING_BATCHES) {
            // The dropped pair still occupied capture time. Advance sample
            // positions and flag the next admitted packet rather than hiding
            // the gap behind contiguous-looking transcript timing.
            selfHostedAudioClockRef.current.discard('mic', mic.length);
            selfHostedAudioClockRef.current.discard('system', system.length);
            console.error('[meeting] Self-hosted transcription backlog full; dropping one bounded audio batch');
            if (!selfHostedFailureShownRef.current) {
                selfHostedFailureShownRef.current = true;
                toast.error('Live transcription is falling behind', {
                    description: 'Recording continues, but part of the live transcript may be missing.',
                    duration: 10_000,
                });
            }
            return;
        }
        const micBase64 = pcm16ToBase64(mic);
        const systemBase64 = pcm16ToBase64(system);
        const micPacket = selfHostedAudioClockRef.current.capture('mic', mic.length);
        const systemPacket = selfHostedAudioClockRef.current.capture('system', system.length);
        selfHostedPendingBatchesRef.current++;
        selfHostedFeedTailRef.current = selfHostedFeedTailRef.current.then(async () => {
            const feedChannel = async (
                channel: SelfHostedChannel,
                packet: CapturedSelfHostedAudio,
                pcmBase64: string,
            ): Promise<void> => {
                let lastError: unknown;
                for (let attempt = 0; attempt <= SELF_HOSTED_RECONNECT_DELAYS_MS.length; attempt++) {
                    try {
                        const snapshot = await window.ipc.invoke('meeting:transcription:feed', {
                            meetingId,
                            channel,
                            pcmBase64,
                            audio: selfHostedAudioClockRef.current.metadataFor(packet),
                        });
                        selfHostedAudioClockRef.current.acknowledge(channel);
                        // Once one channel is acknowledged, it is rendered and
                        // never replayed because its sibling later fails.
                        applySelfHostedSnapshot(channel, snapshot);
                        return;
                    } catch (error) {
                        lastError = error;
                        const delay = SELF_HOSTED_RECONNECT_DELAYS_MS[attempt];
                        if (delay === undefined || selfHostedMeetingIdRef.current !== meetingId) break;
                        console.warn(`[meeting] ${channel} transcription interrupted; reconnecting in ${delay}ms`);
                        await wait(delay);
                        await window.ipc.invoke('meeting:transcription:restartChannel', { meetingId, channel });
                        // Legacy snapshots begin a fresh worker prefix. Canonical
                        // v2 segment IDs/revisions remain independently safe.
                        selfHostedCommittedRef.current[channel] = '';
                    }
                }
                selfHostedAudioClockRef.current.markTransportDrop(channel);
                throw lastError;
            };

            // The paired operation is still normal renderer capture IPC: it
            // takes the same two bounded PCM batches this function already
            // owns, but returns transcript snapshots only—never cleaned PCM.
            // Electron main can therefore align the private native AEC lane
            // without granting any new renderer-facing audio capability. The
            // system channel remains below as an independently retryable ASR
            // feed, so a quiet/broken system worker cannot replay or block mic.
            const feedAecMic = async (): Promise<void> => {
                let lastError: unknown;
                for (let attempt = 0; attempt <= SELF_HOSTED_RECONNECT_DELAYS_MS.length; attempt++) {
                    try {
                        const snapshots = await window.ipc.invoke('meeting:transcription:feedAecPair', {
                            meetingId,
                            mic: {
                                pcmBase64: micBase64,
                                audio: selfHostedAudioClockRef.current.metadataFor(micPacket),
                            },
                            system: {
                                pcmBase64: systemBase64,
                                audio: selfHostedAudioClockRef.current.metadataFor(systemPacket),
                            },
                        });
                        selfHostedAudioClockRef.current.acknowledge('mic');
                        for (const snapshot of snapshots) applySelfHostedSnapshot('mic', snapshot);
                        return;
                    } catch (error) {
                        lastError = error;
                        const delay = SELF_HOSTED_RECONNECT_DELAYS_MS[attempt];
                        if (delay === undefined || selfHostedMeetingIdRef.current !== meetingId) break;
                        console.warn(`[meeting] mic transcription interrupted; reconnecting in ${delay}ms`);
                        await wait(delay);
                        await window.ipc.invoke('meeting:transcription:restartChannel', { meetingId, channel: 'mic' });
                        selfHostedCommittedRef.current.mic = '';
                    }
                }
                selfHostedAudioClockRef.current.markTransportDrop('mic');
                throw lastError;
            };

            let micAcknowledged = false;
            try {
                await feedAecMic();
                micAcknowledged = true;
                await feedChannel('system', systemPacket, systemBase64);
                selfHostedFailureShownRef.current = false;
            } catch (error) {
                // A failed mic prevents this pair's system PCM from being
                // attempted at all, so its next packet must expose that gap.
                if (!micAcknowledged) selfHostedAudioClockRef.current.markTransportDrop('system');
                throw error;
            }
        }).catch((error) => {
            console.error('[meeting] Self-hosted transcription feed failed:', error);
            if (!selfHostedFailureShownRef.current) {
                selfHostedFailureShownRef.current = true;
                toast.error('Live transcription connection lost', {
                    description: 'Rowboat will keep the meeting open so you can stop and retry safely.',
                    duration: 10_000,
                });
            }
        }).finally(() => {
            selfHostedPendingBatchesRef.current--;
        });
    }, [applySelfHostedSnapshot]);

    const flushSelfHostedPcm = useCallback(() => {
        const buffered = selfHostedPcmRef.current;
        if (buffered.length === 0) return;
        queueSelfHostedBatch(
            buffered.mic.slice(0, buffered.length),
            buffered.system.slice(0, buffered.length),
        );
        buffered.length = 0;
    }, [queueSelfHostedBatch]);

    const stopInputCapture = useCallback(() => {
        captureRecoveryRef.current = null;
        captureRecoveryInFlightRef.current.clear();
        if (captureWatchdogTimerRef.current) {
            clearInterval(captureWatchdogTimerRef.current);
            captureWatchdogTimerRef.current = null;
        }
        captureWatchdogRef.current = null;
        if (captureDeviceChangeListenerRef.current) {
            navigator.mediaDevices.removeEventListener('devicechange', captureDeviceChangeListenerRef.current);
            captureDeviceChangeListenerRef.current = null;
        }
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
        }
        if (micSourceRef.current) {
            micSourceRef.current.disconnect();
            micSourceRef.current = null;
        }
        if (systemSourceRef.current) {
            systemSourceRef.current.disconnect();
            systemSourceRef.current = null;
        }
        if (mergerRef.current) {
            mergerRef.current.disconnect();
            mergerRef.current = null;
        }
        if (audioCtxRef.current) {
            audioCtxRef.current.close();
            audioCtxRef.current = null;
        }
        if (micStreamRef.current) {
            micStreamRef.current.getTracks().forEach(t => t.stop());
            micStreamRef.current = null;
        }
        if (systemStreamRef.current) {
            systemStreamRef.current.getTracks().forEach(t => t.stop());
            systemStreamRef.current = null;
        }
    }, []);

    const cleanup = useCallback(async () => {
        const transcriptWriter = transcriptWriterRef.current;
        transcriptWriterRef.current = null;
        await transcriptWriter?.cancelAndSettle();
        if (silenceCheckRef.current) {
            clearInterval(silenceCheckRef.current);
            silenceCheckRef.current = null;
        }
        if (nudgeToastIdRef.current !== null) {
            toast.dismiss(nudgeToastIdRef.current);
            nudgeToastIdRef.current = null;
        }
        stopInputCapture();
        if (wsRef.current) {
            wsRef.current.onclose = null;
            wsRef.current.close();
            wsRef.current = null;
        }
        const selfHostedMeetingId = selfHostedMeetingIdRef.current;
        if (selfHostedMeetingId) {
            selfHostedMeetingIdRef.current = null;
            await window.ipc.invoke('meeting:transcription:reset', {
                meetingId: selfHostedMeetingId,
            }).catch((error) => console.error('[meeting] Failed to reset self-hosted transcription:', error));
        }
        const wisprMeetingId = wisprMeetingIdRef.current;
        if (wisprMeetingId) {
            wisprMeetingIdRef.current = null;
            await window.ipc.invoke('meeting:wispr:reset', {
                rowboatMeetingId: wisprMeetingId,
            }).catch((error) => console.error('[meeting] Failed to reset Wispr transcription:', error));
        }
    }, [stopInputCapture]);

    useEffect(() => () => {
        lifecycleGateRef.current.invalidate();
        void cleanup();
    }, [cleanup]);

    const start = useCallback(async (calendarEvent?: CalendarEventMeta): Promise<string | null> => {
        if (stateRef.current !== 'idle') return null;
        const lifecycleToken = lifecycleGateRef.current.begin('starting');
        if (lifecycleToken === null) return null;
        stateRef.current = 'connecting';
        setState('connecting');

        try {

        const selectedProvider = await window.ipc.invoke('meeting:transcription:getProvider', null);
        if (selectedProvider.provider === 'wispr-flow') {
            if (!selectedProvider.configured) throw new Error(selectedProvider.reason ?? 'Wispr Flow connector is not configured');
            const meetingId = `rowboat-${crypto.randomUUID()}`;
            const initial = await window.ipc.invoke('meeting:wispr:begin', { rowboatMeetingId: meetingId });

            transcriptSegmentsRef.current = [];
            transcriptBlockMissingNotifiedRef.current = false;
            transcriptMeetingIdRef.current = meetingId;
            wisprMeetingIdRef.current = meetingId;
            // Accept watcher events immediately after begin(). Creating the
            // Markdown note is asynchronous, but transcript-v2 upserts can be
            // safely buffered in memory until notePathRef is assigned.
            const notePath = await createMeetingNoteFile(calendarEvent, 'wispr-flow');
            notePathRef.current = notePath;
            if (initial.segments.length > 0) {
                upsertSegments(normalizeTranscriptSegments({ version: 2, segments: initial.segments }));
            }

            // Wispr remains the recording owner. Opening its Notetaker is a
            // supported local deep link; its automatic detection or ⌥M starts
            // capture, while Rowboat only mirrors resulting local artifacts.
            void window.ipc.invoke('meeting:wispr:openNotetaker', null).catch(() => {});
            stateRef.current = 'recording';
            setState('recording');
            return notePath;
        }

        // Run independent setup steps in parallel for faster startup
        const [headphoneResult, transcriptionResult, micResult, systemResult] = await Promise.allSettled([
            // 1. Detect headphones vs speakers
            detectHeadphones(),
            // 2. Select the main-process self-hosted provider when configured;
            // otherwise retain Rowboat's existing Deepgram path.
            (async () => {
                const provider = selectedProvider;
                if (provider.reason) console.warn('[meeting] Self-hosted provider unavailable:', provider.reason);
                if (provider.provider === 'self-hosted-nemotron') {
                    const meetingId = `rowboat-${crypto.randomUUID()}`;
                    // English is the product default for meetings. Automatic
                    // language detection repeatedly rendered Indian-English
                    // speech in Devanagari during the physical Zoom run; a
                    // future explicit language control can opt mixed calls
                    // back into `auto` without degrading the default path.
                    await window.ipc.invoke('meeting:transcription:begin', { meetingId, language: 'en-US' });
                    console.log('[meeting] Using self-hosted Nemotron provider');
                    return { kind: 'self-hosted' as const, meetingId };
                }
                // Token from account refresh; websocket URL from the
                // sign-in-independent bootstrap config store.
                const [account, rowboatConfig] = await Promise.all([
                    refreshRowboatAccount(),
                    fetchRowboatConfig(),
                ]);
                let ws: WebSocket;
                if (
                    account?.signedIn &&
                    account.accessToken &&
                    rowboatConfig?.websocketApiUrl
                ) {
                    const listenUrl = buildDeepgramListenUrl(rowboatConfig.websocketApiUrl, DEEPGRAM_PARAMS);
                    console.log('[meeting] Using Rowboat WebSocket');
                    ws = new WebSocket(listenUrl, ['bearer', account.accessToken]);
                } else {
                    const config = await window.ipc.invoke('voice:getConfig', null);
                    if (!config?.deepgram) {
                        throw new Error('No Deepgram config available');
                    }
                    console.log('[meeting] Using Deepgram API key');
                    ws = new WebSocket(DEEPGRAM_LISTEN_URL, ['token', config.deepgram.apiKey]);
                }
                const ok = await new Promise<boolean>((resolve) => {
                    ws.onopen = () => resolve(true);
                    ws.onerror = () => resolve(false);
                    setTimeout(() => resolve(false), 5000);
                });
                if (!ok) throw new Error('WebSocket failed to connect');
                console.log('[meeting] WebSocket connected');
                return { kind: 'deepgram' as const, ws };
            })(),
            // 3. Get mic stream
            openMicrophoneCapture(),
            // 4. Get system audio via getDisplayMedia (loopback). Works on all
            // platforms; on Linux main.ts answers this request with the
            // requesting frame as the throwaway video source (avoids the
            // flaky Wayland screen-capture portal) + Pulse loopback audio.
            openSystemAudioCapture().then((stream) => {
                console.log('[meeting] System audio captured');
                return stream;
            }),
        ]);

        if (!lifecycleGateRef.current.isCurrent(lifecycleToken)) {
            if (transcriptionResult.status === 'fulfilled') {
                if (transcriptionResult.value.kind === 'deepgram') transcriptionResult.value.ws.close();
                else await window.ipc.invoke('meeting:transcription:reset', { meetingId: transcriptionResult.value.meetingId }).catch(() => {});
            }
            if (micResult.status === 'fulfilled') micResult.value.getTracks().forEach(track => track.stop());
            if (systemResult.status === 'fulfilled') systemResult.value.getTracks().forEach(track => track.stop());
            return null;
        }

        // Check for failures — clean up any successful resources if something failed
        const failed = transcriptionResult.status === 'rejected'
            || micResult.status === 'rejected'
            || systemResult.status === 'rejected';

        if (failed) {
            if (transcriptionResult.status === 'rejected') console.error('[meeting] Transcription setup failed:', transcriptionResult.reason);
            if (micResult.status === 'rejected') console.error('[meeting] Microphone access denied:', micResult.reason);
            if (systemResult.status === 'rejected') {
                console.error('[meeting] System audio access denied:', systemResult.reason);
                if (isLinux) {
                    toast.error('Could not capture system audio', {
                        description: 'Meeting audio capture needs PipeWire or PulseAudio. Make sure one of them is running, then try again.',
                        duration: 10000,
                    });
                } else if (isMac) {
                    toast.error('Could not capture meeting audio', {
                        description: 'Allow Rowboat to record system audio in System Settings, then try again.',
                        duration: 10000,
                    });
                }
            }
            // Clean up any resources that did succeed
            if (transcriptionResult.status === 'fulfilled') {
                if (transcriptionResult.value.kind === 'deepgram') {
                    transcriptionResult.value.ws.close();
                } else {
                    void window.ipc.invoke('meeting:transcription:reset', {
                        meetingId: transcriptionResult.value.meetingId,
                    }).catch((error) => console.error('[meeting] Failed to reset partial transcription setup:', error));
                }
            }
            if (micResult.status === 'fulfilled') { micResult.value.getTracks().forEach(t => t.stop()); }
            if (systemResult.status === 'fulfilled') { systemResult.value.getTracks().forEach(t => t.stop()); }
            await cleanup();
            stateRef.current = 'idle';
            setState('idle');
            return null;
        }

        const usingHeadphones = headphoneResult.status === 'fulfilled' ? headphoneResult.value : false;
        console.log(`[meeting] Audio output mode: ${usingHeadphones ? 'headphones' : 'speakers'}`);

        transcriptSegmentsRef.current = [];
        legacySegmentSequenceRef.current = { mic: 0, system: 0 };
        legacyInterimRevisionRef.current = { mic: 0, system: 0 };
        transcriptBlockMissingNotifiedRef.current = false;
        selfHostedCommittedRef.current = { mic: '', system: '' };
        selfHostedPcmRef.current.length = 0;
        selfHostedFeedTailRef.current = Promise.resolve();
        selfHostedPendingBatchesRef.current = 0;
        selfHostedFailureShownRef.current = false;
        selfHostedAudioClockRef.current = new SelfHostedMeetingAudioClock();
        transcriptMeetingIdRef.current = transcriptionResult.value.kind === 'self-hosted'
            ? transcriptionResult.value.meetingId
            : `rowboat-${crypto.randomUUID()}`;

        if (transcriptionResult.value.kind === 'self-hosted') {
            selfHostedMeetingIdRef.current = transcriptionResult.value.meetingId;
        } else {
            const ws = transcriptionResult.value.ws;
            wsRef.current = ws;

            // Set up WS message handler
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (!data.channel?.alternatives?.[0]) return;
                const transcript = data.channel.alternatives[0].transcript;
                if (!transcript) return;

                const channelIndex = data.channel_index?.[0] ?? 0;
                const channel: TranscriptChannel = channelIndex === 0 ? 'mic' : 'system';
                const words = data.channel.alternatives[0].words as Array<{
                    start?: number
                    end?: number
                    speaker?: number | string
                }> | undefined;
                const firstWord = words?.[0];
                const lastWord = words?.[words.length - 1];
                const startSample = Math.max(0, Math.round((firstWord?.start ?? 0) * 16_000));
                const endSample = Math.max(startSample, Math.round((lastWord?.end ?? firstWord?.end ?? firstWord?.start ?? 0) * 16_000));
                const rawSpeakerId = channel === 'system' ? firstWord?.speaker : undefined;
                const hasCluster = rawSpeakerId !== undefined && rawSpeakerId !== null;
                const speaker = hasCluster
                    ? { kind: 'cluster' as const, id: String(rawSpeakerId), displayName: `Speaker ${rawSpeakerId}` }
                    : unknownSpeaker();
                const interimId = `deepgram:${channel}:interim`;

                if (data.is_final) {
                    transcriptSegmentsRef.current = removeTranscriptSegment(transcriptSegmentsRef.current, interimId);
                    const sequence = legacySegmentSequenceRef.current[channel]++;
                    upsertSegments([{
                        meetingId: transcriptMeetingIdRef.current ?? undefined,
                        segmentId: `deepgram:${channel}:${sequence}`,
                        revision: 0,
                        startSample,
                        endSample,
                        timingConfidence: words?.length ? 'medium' : 'low',
                        channel,
                        text: transcript,
                        finality: 'final',
                        clusterIds: hasCluster ? [String(rawSpeakerId)] : [],
                        overlap: false,
                        speaker,
                        attributionSource: hasCluster ? 'deepgram_diarization' : undefined,
                    }]);
                } else {
                    const currentInterim = transcriptSegmentsRef.current.find(segment => segment.segmentId === interimId);
                    upsertSegments([{
                        meetingId: transcriptMeetingIdRef.current ?? undefined,
                        segmentId: interimId,
                        revision: (currentInterim?.revision ?? -1) + 1,
                        startSample,
                        endSample,
                        timingConfidence: words?.length ? 'medium' : 'low',
                        channel,
                        text: transcript,
                        finality: 'interim',
                        clusterIds: hasCluster ? [String(rawSpeakerId)] : [],
                        overlap: false,
                        speaker,
                        attributionSource: hasCluster ? 'deepgram_diarization' : undefined,
                    }]);
                }
                scheduleDebouncedWrite();
            };

            ws.onclose = () => {
                console.log('[meeting] WebSocket closed');
                wsRef.current = null;
            };
        }

        const micStream = micResult.value;
        micStreamRef.current = micStream;

        const systemStream = systemResult.value;
        systemStreamRef.current = systemStream;

        // ----- Audio pipeline -----
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = audioCtx;

        const micSource = audioCtx.createMediaStreamSource(micStream);
        const systemSource = audioCtx.createMediaStreamSource(systemStream);
        const merger = audioCtx.createChannelMerger(2);

        micSourceRef.current = micSource;
        systemSourceRef.current = systemSource;
        mergerRef.current = merger;

        micSource.connect(merger, 0, 0);     // mic → channel 0
        systemSource.connect(merger, 0, 1);  // system audio → channel 1

        const processor = audioCtx.createScriptProcessor(4096, 2, 2);
        processorRef.current = processor;

        const captureWatchdog = new MeetingCaptureWatchdog();
        captureWatchdogRef.current = captureWatchdog;

        const attachEndedRecovery = (channel: MeetingCaptureChannel, stream: MediaStream) => {
            for (const track of stream.getAudioTracks()) {
                track.addEventListener('ended', () => {
                    void captureRecoveryRef.current?.(channel, 'track-ended');
                }, { once: true });
            }
        };

        const updateAecOutputRoute = async () => {
            const meetingId = selfHostedMeetingIdRef.current;
            if (!meetingId) return;
            try {
                // Route revalidation is intentionally independent from source
                // recovery. A harmless speaker/headphone change must never
                // reopen an otherwise healthy microphone or system stream.
                await window.ipc.invoke('meeting:transcription:captureReady', {
                    meetingId,
                    outputRouteIsolated: await detectHeadphones(),
                });
            } catch (error) {
                // AEC is attribution/capture enhancement only. Raw, paired
                // capture remains live when a best-effort route update fails.
                console.warn('[meeting] Failed to update AEC output route:', error);
            }
        };

        captureRecoveryRef.current = async (channel, reason) => {
            if (captureRecoveryInFlightRef.current.has(channel)) return;
            // A stale ended event may arrive after stop() closed the graph.
            if (audioCtxRef.current !== audioCtx || mergerRef.current !== merger || processorRef.current !== processor) return;
            captureRecoveryInFlightRef.current.add(channel);

            try {
                // Preserve every complete capture batch before replacing a
                // source. The main-process delivery queue owns any failed
                // suffix, so a renderer retry cannot replay accepted mic ASR.
                flushSelfHostedPcm();
                const nextStream = channel === 'mic'
                    ? await openMicrophoneCapture()
                    : await openSystemAudioCapture();

                if (audioCtxRef.current !== audioCtx || mergerRef.current !== merger || processorRef.current !== processor) {
                    nextStream.getTracks().forEach(track => track.stop());
                    return;
                }

                const nextSource = audioCtx.createMediaStreamSource(nextStream);
                const oldSource = channel === 'mic' ? micSourceRef.current : systemSourceRef.current;
                const oldStream = channel === 'mic' ? micStreamRef.current : systemStreamRef.current;

                // Connect the replacement before releasing the failed source,
                // keeping the shared graph alive. An ended source carries no
                // useful samples, and a live one is only replaced after an
                // explicit graph-stall recovery.
                nextSource.connect(merger, 0, channel === 'mic' ? 0 : 1);
                oldSource?.disconnect();
                oldStream?.getTracks().forEach(track => track.stop());

                if (channel === 'mic') {
                    micSourceRef.current = nextSource;
                    micStreamRef.current = nextStream;
                } else {
                    systemSourceRef.current = nextSource;
                    systemStreamRef.current = nextStream;
                }
                attachEndedRecovery(channel, nextStream);
                if (selfHostedMeetingIdRef.current) {
                    selfHostedAudioClockRef.current.markSourceRecovered(channel);
                }
                console.info(`[meeting] Recovered ${channel} capture after ${reason}`);
                void updateAecOutputRoute();
            } catch (error) {
                // Do not end a meeting because a source chooser/device was
                // unavailable. The unaffected channel remains live; the next
                // successful capture packet explicitly records the gap.
                if (selfHostedMeetingIdRef.current) {
                    selfHostedAudioClockRef.current.markTransportDrop(channel);
                }
                console.warn(`[meeting] Could not recover ${channel} capture after ${reason}:`, error);
                toast.warning(`Reconnect ${channel === 'mic' ? 'microphone' : 'system audio'}`, {
                    description: 'The meeting is still running. Reconnect this source to continue its transcript channel.',
                    duration: 10_000,
                    action: {
                        label: 'Reconnect',
                        onClick: () => { void captureRecoveryRef.current?.(channel, 'user-request'); },
                    },
                });
            } finally {
                captureRecoveryInFlightRef.current.delete(channel);
            }
        };

        attachEndedRecovery('mic', micStream);
        attachEndedRecovery('system', systemStream);

        const deviceChangeHandler = () => {
            const currentTracks = {
                mic: micStreamRef.current?.getAudioTracks()[0],
                system: systemStreamRef.current?.getAudioTracks()[0],
            };
            const affected = captureWatchdog.onDeviceChange({
                mic: currentTracks.mic && { readyState: currentTracks.mic.readyState, muted: currentTracks.mic.muted },
                system: currentTracks.system && { readyState: currentTracks.system.readyState, muted: currentTracks.system.muted },
            });
            for (const channel of affected) {
                void captureRecoveryRef.current?.(channel, 'device-change-ended-track');
            }
            // No healthy stream is touched here. This only lets the native AEC
            // choose the correct reference policy after output hardware moved.
            void updateAecOutputRoute();
        };
        navigator.mediaDevices.addEventListener('devicechange', deviceChangeHandler);
        captureDeviceChangeListenerRef.current = deviceChangeHandler;

        captureWatchdogTimerRef.current = setInterval(() => {
            const currentContext = audioCtxRef.current;
            if (!currentContext || currentContext !== audioCtx) return;
            if (currentContext.state === 'suspended') {
                // Resume first; suspended contexts are not proof of a capture
                // dropout and must never trigger source replacement by itself.
                void currentContext.resume().catch((error) => console.warn('[meeting] Failed to resume audio context:', error));
                return;
            }
            const stalledChannels = captureWatchdog.stalledChannels(currentContext.state);
            if (stalledChannels.length === 0) return;
            if (!captureWatchdog.rearmAfterStall()) {
                toast.error('Audio capture needs attention', {
                    description: 'Rowboat could not restart the capture graph. The meeting is still open; reconnect the affected source or stop safely.',
                    duration: 10_000,
                });
                return;
            }
            for (const channel of stalledChannels) {
                void captureRecoveryRef.current?.(channel, 'audio-callback-stalled');
            }
        }, CAPTURE_WATCHDOG_INTERVAL_MS);

        processor.onaudioprocess = (e) => {
            // This is a graph liveness signal, not a signal-energy test: a
            // quiet remote participant must keep the system capture healthy.
            captureWatchdog.recordAudioCallback();
            const micRaw = e.inputBuffer.getChannelData(0);
            const sysRaw = e.inputBuffer.getChannelData(1);

            // RMS of each channel is used for silence detection only. Audio
            // routing/AEC belongs to the meeting bridge; renderer capture must
            // retain both channels during double-talk.
            let micSum = 0;
            for (let i = 0; i < micRaw.length; i++) micSum += micRaw[i] * micRaw[i];
            const micRms = Math.sqrt(micSum / micRaw.length);
            let sysSum = 0;
            for (let i = 0; i < sysRaw.length; i++) sysSum += sysRaw[i] * sysRaw[i];
            const sysRms = Math.sqrt(sysSum / sysRaw.length);

            // Reset the silence clock whenever EITHER channel has speech-level
            // audio. Both channels continue to ASR even when they overlap.
            if (micRms > SPEECH_RMS_THRESHOLD || sysRms > SPEECH_RMS_THRESHOLD) {
                lastAudioActivityRef.current = Date.now();
            }

            if (selfHostedMeetingIdRef.current) {
                const buffered = selfHostedPcmRef.current;
                for (let i = 0; i < micRaw.length; i++) {
                    buffered.mic[buffered.length] = floatToPcm16(micRaw[i]);
                    buffered.system[buffered.length] = floatToPcm16(sysRaw[i]);
                    buffered.length++;
                    if (buffered.length === SELF_HOSTED_BATCH_SAMPLES) {
                        queueSelfHostedBatch(buffered.mic.slice(), buffered.system.slice());
                        buffered.length = 0;
                    }
                }
                return;
            }

            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

            // Interleave mic (ch0) + system audio (ch1) into stereo int16 PCM
            const int16 = new Int16Array(micRaw.length * 2);
            for (let i = 0; i < micRaw.length; i++) {
                int16[i * 2] = floatToPcm16(micRaw[i]);
                int16[i * 2 + 1] = floatToPcm16(sysRaw[i]);
            }
            wsRef.current.send(int16.buffer);
        };

        // Start the evidence sidecar immediately before connecting the graph,
        // so the bridge Start and renderer audio clock share the capture
        // origin. A bridge failure is attribution-only: it must never prevent
        // the active PCM transcription fallback from starting.
        const selfHostedCaptureMeetingId = selfHostedMeetingIdRef.current;
        if (selfHostedCaptureMeetingId) {
            try {
                await window.ipc.invoke('meeting:transcription:captureReady', {
                    meetingId: selfHostedCaptureMeetingId,
                    outputRouteIsolated: usingHeadphones,
                });
            } catch (error) {
                console.error('[meeting] Failed to mark capture ready:', error);
            }
        }

        merger.connect(processor);
        processor.connect(audioCtx.destination);

        const notePath = await createMeetingNoteFile(calendarEvent, 'rowboat');
        notePathRef.current = notePath;

        // Parse the linked event's end time (timed events only) so the silence
        // window can shorten once the meeting is past its scheduled end.
        const calEndMs = calendarEvent?.end?.dateTime ? Date.parse(calendarEvent.end.dateTime) : NaN;
        calendarEndMsRef.current = Number.isFinite(calEndMs) ? calEndMs : null;

        // Arm silence detection. Initialise the activity clock to "now" so the
        // checker is live from the very start of recording — a session that
        // never captures any audio still auto-stops at the backstop instead of
        // running forever.
        lastAudioActivityRef.current = Date.now();
        if (silenceCheckRef.current) clearInterval(silenceCheckRef.current);
        silenceCheckRef.current = setInterval(() => {
            const silentMs = Date.now() - lastAudioActivityRef.current;
            const endMs = calendarEndMsRef.current;
            const pastCalendarEnd = endMs != null && Date.now() > endMs;
            const hardStopMs = pastCalendarEnd ? POST_CALENDAR_END_SILENCE_MS : SILENCE_BACKSTOP_MS;

            if (silentMs >= hardStopMs) {
                console.log(`[meeting] ${Math.round(silentMs / 1000)}s of silence${pastCalendarEnd ? ' (past scheduled end)' : ''} — auto-stopping`);
                onAutoStopRef.current?.();
                return;
            }

            if (silentMs >= SILENCE_NUDGE_MS) {
                // Ask once; the toast persists until dismissed or acted on. Past
                // the scheduled end we skip straight to the hard stop above, so
                // the nudge only ever shows for an in-progress meeting.
                if (nudgeToastIdRef.current === null) {
                    nudgeToastIdRef.current = toast('Still in a meeting?', {
                        description: "It's been quiet for a couple of minutes.",
                        duration: Infinity,
                        action: {
                            label: 'Stop recording',
                            onClick: () => { onAutoStopRef.current?.(); },
                        },
                    });
                }
            } else if (nudgeToastIdRef.current !== null) {
                // Audio resumed before the backstop — retract the nudge.
                toast.dismiss(nudgeToastIdRef.current);
                nudgeToastIdRef.current = null;
            }
        }, SILENCE_CHECK_INTERVAL_MS);

        stateRef.current = 'recording';
        setState('recording');
        return notePath;
        } catch (error) {
            console.error('[meeting] Failed to start meeting capture:', error);
            await cleanup();
            stateRef.current = 'idle';
            setState('idle');
            toast.error('Could not start meeting notes', {
                description: 'Any opened audio streams and transcription session were closed. Try again.',
                duration: 10_000,
            });
            return null;
        } finally {
            lifecycleGateRef.current.finish(lifecycleToken);
        }
    }, [cleanup, scheduleDebouncedWrite, refreshRowboatAccount, queueSelfHostedBatch, upsertSegments, flushSelfHostedPcm]);

    const stop = useCallback(async (): Promise<MeetingStopResult | null> => {
        if (stateRef.current !== 'recording') return null;
        const lifecycleToken = lifecycleGateRef.current.begin('stopping');
        if (lifecycleToken === null) return null;
        const usesWispr = Boolean(wisprMeetingIdRef.current);
        let artifactImported = false;
        let importedWisprTitle: string | undefined;
        stateRef.current = 'stopping';
        setState('stopping');

        try {
        stopInputCapture();
        const selfHostedMeetingId = selfHostedMeetingIdRef.current;
        const wisprMeetingId = wisprMeetingIdRef.current;
        let wisprArtifact: WisprMeetingArtifact | undefined;
        try {
            if (wisprMeetingId) {
                const final = await window.ipc.invoke('meeting:wispr:finalize', {
                    rowboatMeetingId: wisprMeetingId,
                });
                upsertSegments(normalizeTranscriptSegments({ version: 2, segments: final.segments }));
                wisprArtifact = final.artifact;
                wisprMeetingIdRef.current = null;
            } else if (selfHostedMeetingId) {
                flushSelfHostedPcm();
                await selfHostedFeedTailRef.current;
                const final = await window.ipc.invoke('meeting:transcription:finalize', {
                    meetingId: selfHostedMeetingId,
                });
                applySelfHostedSnapshot('mic', final.mic);
                applySelfHostedSnapshot('system', final.system);
                selfHostedMeetingIdRef.current = null;
            } else {
                await finalizeDeepgramStream(wsRef.current, 2200);
            }
        } catch (error) {
            console.error('[meeting] Failed to finalize transcription:', error);
            toast.error('Could not finish the live transcript', {
                description: 'Rowboat kept the transcript received before the connection failed.',
                duration: 10_000,
            });
        } finally {
            // finalize() releases remote slots even when it fails. Clear the
            // renderer identity so cleanup cannot race a duplicate reset.
            if (selfHostedMeetingId) selfHostedMeetingIdRef.current = null;
            if (wisprMeetingId) wisprMeetingIdRef.current = null;
        }
        await cleanup();
        await writeTranscriptToFile();
        if (wisprArtifact && notePathRef.current) {
            try {
                const existing = await window.ipc.invoke('workspace:readFile', {
                    path: notePathRef.current,
                    encoding: 'utf8',
                });
                const merged = mergeWisprMeetingArtifact(existing.data, wisprArtifact);
                await window.ipc.invoke('workspace:writeFile', {
                    path: notePathRef.current,
                    data: merged.content,
                    opts: { encoding: 'utf8' },
                });
                artifactImported = true;
                importedWisprTitle = merged.title;
            } catch (error) {
                console.warn('[meeting] Could not import the final Wispr meeting artifact:', error);
            }
        }
        stateRef.current = 'idle';
        setState('idle');
        } finally {
            if (stateRef.current === 'stopping') {
                stateRef.current = 'idle';
                setState('idle');
            }
            lifecycleGateRef.current.finish(lifecycleToken);
        }
        return {
            provider: usesWispr ? 'wispr-flow' : 'rowboat',
            artifactImported,
            ...(importedWisprTitle ? { title: importedWisprTitle } : {}),
        };
    }, [cleanup, stopInputCapture, writeTranscriptToFile, flushSelfHostedPcm, applySelfHostedSnapshot, upsertSegments]);

    return { state, start, stop };
}
