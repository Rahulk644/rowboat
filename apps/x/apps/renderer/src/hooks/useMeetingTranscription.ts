import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { buildDeepgramListenUrl } from '@/lib/deepgram-listen-url';
import { finalizeDeepgramStream } from '@/lib/deepgram-finalize';
import { useRowboatAccount } from '@/hooks/useRowboatAccount';
import { fetchRowboatConfig } from '@/hooks/use-rowboat-config';
import {
    createTranscriptV2Block,
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

// On macOS (ScreenCaptureKit) the system-audio track never fires "ended"/"mute"
// when the meeting ends, and its readyState stays "live" — only track.muted flips
// to true. But muted is ambiguous: it also goes true whenever no system audio is
// playing (a quiet but live meeting), so muted alone can't safely trigger a stop.
// See the poll in start() for how the muted signal is gated on the scheduled
// calendar end so a quiet stretch never cuts a live meeting short.
const TRACK_POLL_INTERVAL_MS = 3 * 1000;
const MUTE_POLLS_TO_STOP = 3;

// The ScreenCaptureKit quirk above is macOS-only; on Windows the track's "ended"
// event fires normally (handled by the listener in start()), so the poll below is
// gated to macOS.
const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
// On Linux getDisplayMedia loopback works too (Chromium captures the default
// sink's monitor through the PulseAudio layer), but the request needs special
// handling in main.ts — see setDisplayMediaRequestHandler there. Note that
// capturing the monitor *source* directly via enumerateDevices/getUserMedia
// is NOT an option: Chromium filters monitor sources out of device
// enumeration on Linux (audio_manager_pulse.cc), so they never appear.
const isLinux = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('linux');

// ---------------------------------------------------------------------------
// Headphone detection
// ---------------------------------------------------------------------------
async function detectHeadphones(): Promise<boolean> {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === 'audiooutput');
        const defaultOutput = outputs.find(d => d.deviceId === 'default');
        const label = (defaultOutput?.label ?? '').toLowerCase();
        // Heuristic: built-in speakers won't match these patterns
        const headphonePatterns = ['headphone', 'airpod', 'earpod', 'earphone', 'earbud', 'bluetooth', 'bt_', 'jabra', 'bose', 'sony wh', 'sony wf'];
        return headphonePatterns.some(p => label.includes(p));
    } catch {
        return false;
    }
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

function formatTranscript(date: string, calendarEvent?: CalendarEventMeta): string {
    const noteTitle = calendarEvent?.summary || 'Meeting Notes';
    const lines = [
        '---',
        'type: meeting',
        'source: rowboat',
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

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useMeetingTranscription(onAutoStop?: () => void) {
    const { refresh: refreshRowboatAccount } = useRowboatAccount();
    const [state, setState] = useState<MeetingTranscriptionState>('idle');
    const wsRef = useRef<WebSocket | null>(null);
    const selfHostedMeetingIdRef = useRef<string | null>(null);
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
    const processorRef = useRef<ScriptProcessorNode | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const transcriptSegmentsRef = useRef<TranscriptSegment[]>([]);
    const legacySegmentSequenceRef = useRef<Record<SelfHostedChannel, number>>({ mic: 0, system: 0 });
    const legacyInterimRevisionRef = useRef<Record<SelfHostedChannel, number>>({ mic: 0, system: 0 });
    const notePathRef = useRef<string>('');
    const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const transcriptBlockMissingNotifiedRef = useRef(false);
    // Silence detection: timestamp of the last speech-level audio on either
    // channel, plus the interval that checks it. calendarEndMsRef holds the
    // linked event's end time (null if none).
    const lastAudioActivityRef = useRef<number>(0);
    const silenceCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const calendarEndMsRef = useRef<number | null>(null);
    const nudgeToastIdRef = useRef<string | number | null>(null);
    // On macOS (ScreenCaptureKit) the system-audio track doesn't reliably fire
    // "ended"/"mute" when the meeting ends, so we poll its readyState/muted
    // state instead.
    const trackPollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
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
        if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
        writeTimerRef.current = setTimeout(() => {
            void writeTranscriptToFile();
        }, 1000);
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

    const applySelfHostedSnapshot = useCallback((channel: SelfHostedChannel, snapshot: SelfHostedSnapshot) => {
        // Canonical bridge events have segment IDs, revisions, intervals, and
        // resolved speaker evidence. Prefer them wholesale over the legacy
        // text-prefix protocol.
        const v2Segments = normalizeTranscriptSegments(snapshot);
        if (v2Segments.length > 0) {
            const meetingId = transcriptMeetingIdRef.current ?? undefined;
            upsertSegments(v2Segments.map(segment => ({ ...segment, meetingId: segment.meetingId ?? meetingId })));
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

            let micAcknowledged = false;
            try {
                await feedChannel('mic', micPacket, micBase64);
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
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
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

    const cleanup = useCallback(() => {
        if (writeTimerRef.current) {
            clearTimeout(writeTimerRef.current);
            writeTimerRef.current = null;
        }
        if (silenceCheckRef.current) {
            clearInterval(silenceCheckRef.current);
            silenceCheckRef.current = null;
        }
        if (nudgeToastIdRef.current !== null) {
            toast.dismiss(nudgeToastIdRef.current);
            nudgeToastIdRef.current = null;
        }
        if (trackPollingRef.current) {
            clearInterval(trackPollingRef.current);
            trackPollingRef.current = null;
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
            void window.ipc.invoke('meeting:transcription:reset', {
                meetingId: selfHostedMeetingId,
            }).catch((error) => console.error('[meeting] Failed to reset self-hosted transcription:', error));
        }
    }, [stopInputCapture]);

    const start = useCallback(async (calendarEvent?: CalendarEventMeta): Promise<string | null> => {
        if (state !== 'idle') return null;
        setState('connecting');

        // Run independent setup steps in parallel for faster startup
        const [headphoneResult, transcriptionResult, micResult, systemResult] = await Promise.allSettled([
            // 1. Detect headphones vs speakers
            detectHeadphones(),
            // 2. Select the main-process self-hosted provider when configured;
            // otherwise retain Rowboat's existing Deepgram path.
            (async () => {
                const provider = await window.ipc.invoke('meeting:transcription:getProvider', null);
                if (provider.reason) console.warn('[meeting] Self-hosted provider unavailable:', provider.reason);
                if (provider.provider === 'self-hosted-nemotron') {
                    const meetingId = `rowboat-${crypto.randomUUID()}`;
                    await window.ipc.invoke('meeting:transcription:begin', { meetingId, language: 'en' });
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
            navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            }),
            // 4. Get system audio via getDisplayMedia (loopback). Works on all
            // platforms; on Linux main.ts answers this request with the
            // requesting frame as the throwaway video source (avoids the
            // flaky Wayland screen-capture portal) + Pulse loopback audio.
            (async () => {
                const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
                stream.getVideoTracks().forEach(t => t.stop());
                if (stream.getAudioTracks().length === 0) {
                    stream.getTracks().forEach(t => t.stop());
                    throw new Error('No audio track from getDisplayMedia');
                }
                console.log('[meeting] System audio captured');
                return stream;
            })(),
        ]);

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
            cleanup();
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

        // If the shared source goes away (user closes the call window / clicks
        // "Stop sharing"), the track fires "ended" — treat that as the meeting
        // ending and stop. Our own cleanup() calls track.stop(), which does NOT
        // fire "ended", so this won't double-trigger on a manual stop.
        // On Linux the loopback stream mirrors the default output device, not
        // the meeting app, so it stays live after the meeting closes and
        // "ended" never fires — auto-stop on Linux comes from the silence
        // detector armed below.
        systemStream.getAudioTracks().forEach(track => {
            track.addEventListener('ended', () => {
                console.log('[meeting] system-audio track ended (shared source closed) — auto-stopping');
                onAutoStopRef.current?.();
            });
        });

        // On macOS the system-audio track's "ended"/"mute" events don't fire when
        // the meeting ends, so poll its state instead. (On Windows the "ended"
        // listener above already covers this, so the poll is macOS-only.)
        //
        //  - readyState === 'ended' is unambiguous (the source is gone) → stop now.
        //    It never actually fires on macOS (readyState stays 'live'); it's just
        //    a safety net should polling ever observe the track ending.
        //  - muted is ambiguous on macOS: it flips true both when the meeting ends
        //    AND when nothing is playing system audio (a quiet but live meeting).
        //    So we only treat sustained mute as "meeting over" once we're past the
        //    linked event's scheduled end — a dead audio track after the meeting
        //    was due to finish is a strong signal. With no calendar event, or
        //    before the scheduled end, we DON'T hard-stop on mute; the silence
        //    checker's nudge + backstop handles it, so a quiet stretch can never
        //    silently cut a live meeting short.
        const pollTrack = systemStream.getAudioTracks()[0];
        if (isMac && pollTrack) {
            let mutedPolls = 0;
            if (trackPollingRef.current) clearInterval(trackPollingRef.current);
            trackPollingRef.current = setInterval(() => {
                if (pollTrack.readyState === 'ended') {
                    console.log('[meeting] system-audio track ended (poll) — auto-stopping');
                    onAutoStopRef.current?.();
                    return;
                }
                if (pollTrack.muted) {
                    mutedPolls++;
                    const endMs = calendarEndMsRef.current;
                    const pastCalendarEnd = endMs != null && Date.now() > endMs;
                    if (pastCalendarEnd && mutedPolls >= MUTE_POLLS_TO_STOP) {
                        console.log('[meeting] system-audio track muted past scheduled end (poll) — auto-stopping');
                        onAutoStopRef.current?.();
                    }
                } else {
                    mutedPolls = 0;
                }
            }, TRACK_POLL_INTERVAL_MS);
        }

        // ----- Audio pipeline -----
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = audioCtx;

        const micSource = audioCtx.createMediaStreamSource(micStream);
        const systemSource = audioCtx.createMediaStreamSource(systemStream);
        const merger = audioCtx.createChannelMerger(2);

        micSource.connect(merger, 0, 0);     // mic → channel 0
        systemSource.connect(merger, 0, 1);  // system audio → channel 1

        const processor = audioCtx.createScriptProcessor(4096, 2, 2);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
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
                });
            } catch (error) {
                console.error('[meeting] Failed to mark capture ready:', error);
            }
        }

        merger.connect(processor);
        processor.connect(audioCtx.destination);

        // Create the note file, organized by date like voice memos
        const now = new Date();
        const dateStr = now.toISOString();
        const dateFolder = dateStr.split('T')[0]; // YYYY-MM-DD
        const timestamp = dateStr.replace(/:/g, '-').replace(/\.\d+Z$/, '');
        const filename = calendarEvent?.summary
            ? calendarEvent.summary.replace(/[\\/*?:"<>|]/g, '').replace(/\s+/g, '_').substring(0, 100).trim()
            : `meeting-${timestamp}`;
        let notePath = `knowledge/Meetings/rowboat/${dateFolder}/${filename}.md`;
        // Title-derived names collide within a day — every ad-hoc detection is
        // titled "Meeting", and recurring calendar events repeat their summary.
        // Never overwrite an earlier meeting's note: suffix with the timestamp.
        if (calendarEvent?.summary) {
            try {
                const { exists } = await window.ipc.invoke('workspace:exists', { path: notePath });
                if (exists) notePath = `knowledge/Meetings/rowboat/${dateFolder}/${filename}-${timestamp}.md`;
            } catch { /* fall through with the unsuffixed path */ }
        }
        notePathRef.current = notePath;

        // Parse the linked event's end time (timed events only) so the silence
        // window can shorten once the meeting is past its scheduled end.
        const calEndMs = calendarEvent?.end?.dateTime ? Date.parse(calendarEvent.end.dateTime) : NaN;
        calendarEndMsRef.current = Number.isFinite(calEndMs) ? calEndMs : null;

        const initialContent = formatTranscript(dateStr, calendarEvent);
        await window.ipc.invoke('workspace:writeFile', {
            path: notePath,
            data: initialContent,
            opts: { encoding: 'utf8', mkdirp: true },
        });

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

        setState('recording');
        return notePath;
    }, [state, cleanup, scheduleDebouncedWrite, refreshRowboatAccount, queueSelfHostedBatch, upsertSegments]);

    const stop = useCallback(async () => {
        if (state !== 'recording') return;
        setState('stopping');

        stopInputCapture();
        const selfHostedMeetingId = selfHostedMeetingIdRef.current;
        try {
            if (selfHostedMeetingId) {
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
        }
        cleanup();
        await writeTranscriptToFile();
        setState('idle');
    }, [state, cleanup, stopInputCapture, writeTranscriptToFile, flushSelfHostedPcm, applySelfHostedSnapshot]);

    return { state, start, stop };
}
