import { z } from 'zod';
import {
  resolveMeetingSpeakerUpsert,
  type ConfirmedVoiceProfileMatch,
  type MeetingSpeakerEvidence,
} from './meeting-speaker-resolver.js';

export type MeetingAudioChannel = 'mic' | 'system';
export type MeetingAudioFeedFlag = 'discontinuity' | 'recovered' | 'silence';
export type MeetingCaptureHealthState = 'starting' | 'ready' | 'stalled' | 'recovering' | 'failed' | 'off';
export type MeetingTranscriptFinality = 'interim' | 'stable' | 'final';
export type MeetingTranscriptTimingConfidence = 'high' | 'medium' | 'low';
export type MeetingTranscriptTimingSource = 'feed-window' | 'model-token';
export type MeetingSpeakerKind = 'self' | 'named' | 'cluster' | 'unknown';

/**
 * Metadata for one PCM batch. It is optional at the IPC boundary while the
 * legacy renderer is still sending raw base64; the main process synthesizes
 * the missing 16 kHz sample clock deterministically.
 */
export type MeetingAudioFeedMetadata = {
  sourceId?: string;
  startSample?: number;
  sampleCount?: number;
  sampleRate?: number;
  sequence?: number;
  flags?: MeetingAudioFeedFlag[];
};

export type MeetingAudioFeed = {
  sourceId: string;
  channel: MeetingAudioChannel;
  epoch: number;
  startSample: number;
  sampleCount: number;
  sampleRate: number;
  sequence: number;
  flags: MeetingAudioFeedFlag[];
};

export type MeetingCaptureHealth = {
  meetingId: string;
  channel: MeetingAudioChannel;
  epoch: number;
  state: MeetingCaptureHealthState;
  sequence: number;
  lastFrameSample: number;
  restartCount: number;
  reason?: string;
};

export type MeetingTranscriptSpeaker = {
  kind: MeetingSpeakerKind;
  id?: string;
  displayName?: string;
};

/** Canonical v2 transcript upsert. Time is always meeting-relative samples. */
export type MeetingTranscriptSegment = {
  meetingId: string;
  segmentId: string;
  revision: number;
  epoch: number;
  startSample: number;
  endSample: number;
  timingConfidence: MeetingTranscriptTimingConfidence;
  timingSource?: MeetingTranscriptTimingSource;
  channel: MeetingAudioChannel;
  text: string;
  finality: MeetingTranscriptFinality;
  clusterIds: string[];
  overlap: boolean;
  speaker: MeetingTranscriptSpeaker;
  attributionSource: string;
  attributionConfidence: number;
  supersedes: string[];
};

export type MeetingTranscriptionSnapshot = {
  // Legacy fields remain until the renderer has fully adopted v2.
  session: string;
  full: string;
  committed: string;
  tentative: string;
  changed: boolean;
  final: boolean;
  revision: number;
  inputMs: number;
  bufferedMs: number;
  // Canonical v2 additions. `segments` contains idempotent upserts, not a
  // text-prefix replacement. A consumer retains prior records by id.
  version: 2;
  epoch: number;
  feed?: MeetingAudioFeed;
  captureHealth: MeetingCaptureHealth;
  segments: MeetingTranscriptSegment[];
};

/** Inputs a future bridge can submit after normalizing AX/diarization data. */
export type SpeakerEvidenceApplicationOptions = {
  voiceProfilesBySegment?: Readonly<Record<string, ConfirmedVoiceProfileMatch | undefined>>;
  stableClusterIdsBySegment?: Readonly<Record<string, readonly string[] | undefined>>;
  playbackReferenceHealthy?: boolean;
  outputRouteIsolated?: boolean;
  micLeakSuspected?: boolean;
};

type WorkerSnapshot = Omit<MeetingTranscriptionSnapshot, 'version' | 'epoch' | 'feed' | 'captureHealth' | 'segments'>;

type SelfHostedConfig = {
  baseUrl: URL;
  token: string;
};

type ChannelState = {
  sourceId: string;
  epoch: number;
  nextSample: number;
  nextSequence: number;
  pendingStartSample: number | null;
  committed: string;
  interimSegmentId: string | null;
  interimRevision: number;
  lastFeed?: MeetingAudioFeed;
  health: MeetingCaptureHealth;
};

type ActiveMeeting = {
  sessions: Record<MeetingAudioChannel, string>;
  language: string;
  channels: Record<MeetingAudioChannel, ChannelState>;
  segments: Map<string, MeetingTranscriptSegment>;
  corrections: Map<string, { displayName: string; rememberVoice: boolean }>;
  speakerEvidence: MeetingSpeakerEvidence[];
  pendingAttributionUpserts: Map<string, MeetingTranscriptSegment>;
};

const SnapshotSchema = z.object({
  session: z.string(),
  full: z.string(),
  committed: z.string(),
  tentative: z.string(),
  changed: z.boolean(),
  final: z.boolean(),
  revision: z.number().int().nonnegative(),
  inputMs: z.number().int().nonnegative(),
  bufferedMs: z.number().int().nonnegative(),
});

const AudioFeedMetadataSchema = z.object({
  sourceId: z.string().min(1).max(160).optional(),
  startSample: z.number().int().nonnegative().optional(),
  sampleCount: z.number().int().positive().optional(),
  sampleRate: z.number().int().positive().max(192_000).optional(),
  sequence: z.number().int().nonnegative().optional(),
  flags: z.array(z.enum(['discontinuity', 'recovered', 'silence'])).max(3).optional(),
});

const MAX_PCM_BYTES = 64 * 1024;
const SAMPLE_RATE = 16_000;
const MAX_SPEAKER_EVIDENCE = 1_024;
const SPEAKER_EVIDENCE_HISTORY_SAMPLES = SAMPLE_RATE * 120;
const MAX_PENDING_ATTRIBUTION_UPSERTS = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function safeMeetingId(meetingId: string): string {
  const normalized = meetingId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  if (!normalized) throw new Error('A meeting id is required');
  return normalized;
}

function unknownSpeaker(): MeetingTranscriptSpeaker {
  return { kind: 'unknown', displayName: 'Unknown speaker' };
}

function segmentId(meetingId: string, channel: MeetingAudioChannel, epoch: number, suffix: string): string {
  return `${meetingId}:${channel}:e${epoch}:${suffix}`;
}

function isPrefix(prefix: string, text: string): boolean {
  return text.startsWith(prefix);
}

/**
 * Applies v2 upserts deterministically. Replaying an equal revision or an
 * older revision is a no-op, so reconnect/retry paths cannot duplicate text.
 */
export function mergeMeetingTranscriptSegments(
  current: Iterable<MeetingTranscriptSegment>,
  upserts: Iterable<MeetingTranscriptSegment>,
): MeetingTranscriptSegment[] {
  const byId = new Map<string, MeetingTranscriptSegment>();
  for (const segment of current) byId.set(segment.segmentId, segment);
  for (const candidate of upserts) {
    const existing = byId.get(candidate.segmentId);
    if (!existing || candidate.revision > existing.revision) byId.set(candidate.segmentId, candidate);
  }
  return [...byId.values()].sort((a, b) => (
    a.epoch - b.epoch || a.startSample - b.startSample || a.endSample - b.endSample || a.segmentId.localeCompare(b.segmentId)
  ));
}

/**
 * The self-hosted worker is intentionally reachable only through a local SSH
 * or VPN tunnel. This keeps the bearer token away from arbitrary remote hosts
 * and makes an accidental public transcription endpoint fail closed.
 */
export function loadSelfHostedMeetingConfig(): SelfHostedConfig | null {
  const rawBaseUrl = envValue('ROWBOAT_MEETING_STT_URL');
  const token = envValue('ROWBOAT_MEETING_STT_TOKEN');
  if (!rawBaseUrl || !token) return null;
  if (token.length < 32) {
    throw new Error('ROWBOAT_MEETING_STT_TOKEN must contain at least 32 characters');
  }

  const baseUrl = new URL(rawBaseUrl);
  if (baseUrl.protocol !== 'http:' || !LOOPBACK_HOSTS.has(baseUrl.hostname)) {
    throw new Error('ROWBOAT_MEETING_STT_URL must be an http:// loopback URL');
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('ROWBOAT_MEETING_STT_URL must not contain credentials, a query, or a fragment');
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
  return { baseUrl, token };
}

function newChannelState(meetingId: string, channel: MeetingAudioChannel): ChannelState {
  return {
    sourceId: `${meetingId}.${channel}`,
    epoch: 0,
    nextSample: 0,
    nextSequence: 0,
    pendingStartSample: null,
    committed: '',
    interimSegmentId: null,
    interimRevision: 0,
    health: {
      meetingId,
      channel,
      epoch: 0,
      state: 'starting',
      sequence: 0,
      lastFrameSample: 0,
      restartCount: 0,
    },
  };
}

export class SelfHostedMeetingTranscription {
  private readonly active = new Map<string, ActiveMeeting>();
  private computeTail: Promise<void> = Promise.resolve();

  getStatus(): { provider: 'deepgram' | 'self-hosted-nemotron'; configured: boolean; reason?: string } {
    try {
      const configured = loadSelfHostedMeetingConfig() !== null;
      return { provider: configured ? 'self-hosted-nemotron' : 'deepgram', configured };
    } catch (error) {
      return {
        provider: 'deepgram', configured: false,
        reason: error instanceof Error ? error.message : 'Invalid self-hosted transcription configuration',
      };
    }
  }

  async begin(meetingId: string, language: string): Promise<void> {
    const config = this.requireConfig();
    const id = safeMeetingId(meetingId);
    if (this.active.has(id)) throw new Error('Meeting transcription session already exists');
    const sessions = { mic: `${id}.mic`, system: `${id}.system` } satisfies Record<MeetingAudioChannel, string>;
    // The qualified Nemotron worker accepts automatic detection and its
    // explicit English locale (`en-US`), but rejects bare ISO-639 values such
    // as `en`. Keep mixed-language meetings on automatic detection; callers
    // may opt into the one explicitly qualified locale when needed.
    const normalizedLanguage = language.trim() === 'en-US' ? 'en-US' : 'auto';
    try {
      await this.beginSessions(config, sessions, normalizedLanguage);
      this.active.set(id, {
        sessions,
        language: normalizedLanguage,
        channels: { mic: newChannelState(id, 'mic'), system: newChannelState(id, 'system') },
        segments: new Map(),
        corrections: new Map(),
        speakerEvidence: [],
        pendingAttributionUpserts: new Map(),
      });
    } catch (error) {
      await this.bestEffortReset(config, sessions.mic);
      await this.bestEffortReset(config, sessions.system);
      throw error;
    }
  }

  async feed(
    meetingId: string,
    channel: MeetingAudioChannel,
    pcmBase64: string,
    metadata?: MeetingAudioFeedMetadata,
  ): Promise<MeetingTranscriptionSnapshot> {
    const config = this.requireConfig();
    const active = this.requireActive(meetingId);
    const pcm = Buffer.from(pcmBase64, 'base64');
    if (pcm.length === 0 || pcm.length > MAX_PCM_BYTES || pcm.length % 2 !== 0) {
      throw new Error('Meeting audio must be non-empty little-endian signed-16 PCM within 64 KiB');
    }
    const parsedMetadata = AudioFeedMetadataSchema.parse(metadata ?? {});
    return this.serialized(async () => {
      const state = active.channels[channel];
      const feed = this.prepareFeed(state, channel, pcm.length / 2, parsedMetadata);
      // A capture discontinuity is also an ASR-prefix boundary. Reset only
      // the affected named session before forwarding the first new frame so a
      // worker cannot return text from the prior epoch as if it belonged to
      // this interval. The other channel keeps its existing session/model.
      if (feed.epoch !== state.epoch) {
        await this.request(config, '/stream/reset', active.sessions[channel]);
        await this.request(config, '/stream/begin', active.sessions[channel], undefined, active.language);
        this.beginNewEpoch(state, 'capture discontinuity', feed.epoch);
      }
      const worker = SnapshotSchema.parse(await this.request(config, '/stream/feed', active.sessions[channel], pcm));
      this.commitFeed(state, feed);
      return this.adaptSnapshot(safeMeetingId(meetingId), active, channel, worker, feed);
    });
  }

  async finalize(meetingId: string): Promise<Record<MeetingAudioChannel, MeetingTranscriptionSnapshot>> {
    const config = this.requireConfig();
    const id = safeMeetingId(meetingId);
    const active = this.requireActive(id);
    try {
      const mic = await this.serialized(async () => {
        const worker = SnapshotSchema.parse(await this.request(config, '/stream/finalize', active.sessions.mic));
        return this.adaptSnapshot(id, active, 'mic', worker, active.channels.mic.lastFeed, true);
      });
      const system = await this.serialized(async () => {
        const worker = SnapshotSchema.parse(await this.request(config, '/stream/finalize', active.sessions.system));
        return this.adaptSnapshot(id, active, 'system', worker, active.channels.system.lastFeed, true);
      });
      return { mic, system };
    } finally {
      this.active.delete(id);
      await this.bestEffortReset(config, active.sessions.mic);
      await this.bestEffortReset(config, active.sessions.system);
    }
  }

  async restart(meetingId: string): Promise<void> {
    const config = this.requireConfig();
    const active = this.requireActive(meetingId);
    await this.bestEffortReset(config, active.sessions.mic);
    await this.bestEffortReset(config, active.sessions.system);
    this.beginNewEpoch(active.channels.mic, 'transcription session restarted');
    this.beginNewEpoch(active.channels.system, 'transcription session restarted');
    await this.beginSessions(config, active.sessions, active.language);
  }

  /**
   * Recovers only the failed named ASR session. Callers must not replay a
   * successfully acknowledged sibling channel: doing so would create a new
   * interval for already-accepted PCM and eventually duplicate its text.
   */
  async restartChannel(meetingId: string, channel: MeetingAudioChannel): Promise<void> {
    const config = this.requireConfig();
    const active = this.requireActive(meetingId);
    await this.serialized(async () => {
      await this.request(config, '/stream/reset', active.sessions[channel]);
      await this.request(config, '/stream/begin', active.sessions[channel], undefined, active.language);
      this.beginNewEpoch(active.channels[channel], 'transcription channel restarted');
    });
  }

  /** In-memory meeting-local correction; durable voice enrollment stays opt-in and out of this slice. */
  correctSpeaker(
    meetingId: string | undefined,
    segmentIdValue: string,
    displayName: string,
    rememberVoice: boolean,
  ): MeetingTranscriptSegment | null {
    const name = displayName.trim();
    if (!name || name.length > 160) throw new Error('A speaker name between 1 and 160 characters is required');
    const active = meetingId ? this.active.get(safeMeetingId(meetingId)) : this.findActiveSegment(segmentIdValue);
    if (!active) return null;
    const existing = active.segments.get(segmentIdValue);
    if (!existing) return null;
    const revision = existing.revision + 1;
    const corrected: MeetingTranscriptSegment = {
      ...existing,
      revision,
      speaker: { kind: 'named', id: `correction:${segmentIdValue}`, displayName: name },
      attributionSource: 'explicit-user-correction',
      attributionConfidence: 1,
      supersedes: existing.supersedes,
    };
    active.corrections.set(segmentIdValue, { displayName: name, rememberVoice });
    active.segments.set(segmentIdValue, corrected);
    return corrected;
  }

  /**
   * Applies one bounded batch of normalized speaker evidence. This is a
   * main-process seam for the Rust bridge: it has no renderer/IPC dependency,
   * and it emits only higher-revision canonical segment upserts.
   */
  applySpeakerEvidence(
    meetingId: string,
    evidence: readonly MeetingSpeakerEvidence[],
    options: SpeakerEvidenceApplicationOptions = {},
  ): { segments: MeetingTranscriptSegment[] } {
    const active = this.requireActive(meetingId);
    this.retainSpeakerEvidence(active, evidence);
    const updated = this.resolveStoredSpeakerEvidence(active, active.segments.keys(), options);
    this.enqueueAttributionUpserts(active, updated);
    this.pruneSpeakerEvidence(active);
    return { segments: updated };
  }

  private resolveStoredSpeakerEvidence(
    active: ActiveMeeting,
    segmentIds: Iterable<string>,
    options: SpeakerEvidenceApplicationOptions = {},
  ): MeetingTranscriptSegment[] {
    const updated: MeetingTranscriptSegment[] = [];
    for (const segmentIdValue of segmentIds) {
      const segment = active.segments.get(segmentIdValue);
      if (!segment) continue;
      const segmentEvidence = active.speakerEvidence.filter((item) => (
        item.endSample > segment.startSample && item.startSample < segment.endSample
      ));
      const voiceProfile = options.voiceProfilesBySegment?.[segment.segmentId];
      const stableClusterIds = options.stableClusterIdsBySegment?.[segment.segmentId];
      // Do not touch unrelated historical records when a bridge batch covers
      // another interval. A remembered explicit correction remains in the
      // resolver input for the intervals that are re-evaluated.
      if (!segmentEvidence.length && !voiceProfile && !stableClusterIds) continue;
      const correction = active.corrections.get(segment.segmentId);
      const upsert = resolveMeetingSpeakerUpsert(segment, {
        correction: correction ? { displayName: correction.displayName } : undefined,
        micHealth: active.channels[segment.channel].health,
        playbackReferenceHealthy: options.playbackReferenceHealthy,
        outputRouteIsolated: options.outputRouteIsolated,
        micLeakSuspected: options.micLeakSuspected,
        evidence: segmentEvidence,
        voiceProfile,
        stableClusterIds: stableClusterIds ? [...stableClusterIds] : undefined,
      });
      if (!upsert) continue;
      active.segments.set(upsert.segmentId, upsert);
      updated.push(upsert);
    }
    return updated.sort((a, b) => (
      a.epoch - b.epoch || a.startSample - b.startSample || a.segmentId.localeCompare(b.segmentId)
    ));
  }

  private retainSpeakerEvidence(active: ActiveMeeting, evidence: readonly MeetingSpeakerEvidence[]): void {
    for (const raw of evidence) {
      const startSample = Number.isSafeInteger(raw.startSample) ? raw.startSample : -1;
      const endSample = Number.isSafeInteger(raw.endSample) ? raw.endSample : -1;
      if (startSample < 0 || endSample <= startSample) continue;
      const source = typeof raw.source === 'string' ? raw.source.trim().slice(0, 80) : '';
      if (!source) continue;
      const participantId = typeof raw.participantId === 'string' ? raw.participantId.trim().slice(0, 160) || undefined : undefined;
      const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim().slice(0, 160) || undefined : undefined;
      const confidence = Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : 0;
      const normalized: MeetingSpeakerEvidence = {
        source, participantId, displayName,
        isSelf: raw.isSelf === true,
        isActive: raw.isActive === true,
        isMuted: raw.isMuted === true,
        startSample, endSample, confidence,
      };
      const duplicate = active.speakerEvidence.some((item) => (
        item.source === normalized.source
        && item.participantId === normalized.participantId
        && item.displayName === normalized.displayName
        && item.isSelf === normalized.isSelf
        && item.isActive === normalized.isActive
        && item.isMuted === normalized.isMuted
        && item.startSample === normalized.startSample
        && item.endSample === normalized.endSample
        && item.confidence === normalized.confidence
      ));
      if (!duplicate) active.speakerEvidence.push(normalized);
    }
    active.speakerEvidence.sort((a, b) => a.endSample - b.endSample || a.startSample - b.startSample);
    if (active.speakerEvidence.length > MAX_SPEAKER_EVIDENCE) {
      active.speakerEvidence.splice(0, active.speakerEvidence.length - MAX_SPEAKER_EVIDENCE);
    }
  }

  private enqueueAttributionUpserts(active: ActiveMeeting, upserts: readonly MeetingTranscriptSegment[]): void {
    for (const upsert of upserts) {
      const existing = active.pendingAttributionUpserts.get(upsert.segmentId);
      if (existing && existing.revision >= upsert.revision) continue;
      // Move a revised record to the newest position so the bounded queue
      // always drops the stalest delivery, never its higher revision.
      active.pendingAttributionUpserts.delete(upsert.segmentId);
      active.pendingAttributionUpserts.set(upsert.segmentId, upsert);
    }
    while (active.pendingAttributionUpserts.size > MAX_PENDING_ATTRIBUTION_UPSERTS) {
      const oldest = active.pendingAttributionUpserts.keys().next().value;
      if (!oldest) break;
      active.pendingAttributionUpserts.delete(oldest);
    }
  }

  private pruneSpeakerEvidence(active: ActiveMeeting): void {
    const latestObserved = Math.max(
      ...Object.values(active.channels).map((channel) => channel.nextSample),
      ...active.speakerEvidence.map((item) => item.endSample),
    );
    // Do not use a single finalization watermark here: mic and system ASR
    // sessions advance independently, so a fast mic final can precede a
    // delayed system segment that still needs the same AX observation.
    const historyFloor = Math.max(0, latestObserved - SPEAKER_EVIDENCE_HISTORY_SAMPLES);
    active.speakerEvidence = active.speakerEvidence.filter((item) => item.endSample > historyFloor);
    if (active.speakerEvidence.length > MAX_SPEAKER_EVIDENCE) {
      active.speakerEvidence.splice(0, active.speakerEvidence.length - MAX_SPEAKER_EVIDENCE);
    }
  }

  async reset(meetingId: string): Promise<void> {
    const config = this.requireConfig();
    const id = safeMeetingId(meetingId);
    const active = this.active.get(id);
    if (!active) return;
    this.active.delete(id);
    await this.bestEffortReset(config, active.sessions.mic);
    await this.bestEffortReset(config, active.sessions.system);
  }

  private findActiveSegment(segmentIdValue: string): ActiveMeeting | undefined {
    for (const active of this.active.values()) if (active.segments.has(segmentIdValue)) return active;
    return undefined;
  }

  private prepareFeed(
    state: ChannelState,
    channel: MeetingAudioChannel,
    actualSampleCount: number,
    metadata: MeetingAudioFeedMetadata,
  ): MeetingAudioFeed {
    const flags = [...new Set(metadata.flags ?? [])];
    const discontinuity = flags.includes('discontinuity');
    const epoch = state.epoch + (discontinuity ? 1 : 0);
    const sourceId = metadata.sourceId ?? state.sourceId;
    const startSample = metadata.startSample ?? state.nextSample;
    const sampleCount = metadata.sampleCount ?? actualSampleCount;
    const sampleRate = metadata.sampleRate ?? SAMPLE_RATE;
    const sequence = metadata.sequence ?? state.nextSequence;
    if (sampleCount !== actualSampleCount) throw new Error('Meeting audio sampleCount does not match PCM payload');
    if (sampleRate !== SAMPLE_RATE) throw new Error(`Meeting audio must be ${SAMPLE_RATE} Hz PCM for this worker`);
    if (!discontinuity && sourceId !== state.sourceId) throw new Error('Audio source changes require a discontinuity flag');
    if (!discontinuity && startSample !== state.nextSample) throw new Error('Audio frames must be contiguous within an epoch');
    if (sequence !== state.nextSequence) throw new Error('Audio frame sequence is not contiguous');
    return { sourceId, channel, epoch, startSample, sampleCount, sampleRate, sequence, flags };
  }

  private commitFeed(state: ChannelState, feed: MeetingAudioFeed): void {
    if (feed.epoch !== state.epoch) this.beginNewEpoch(state, 'capture discontinuity', feed.epoch);
    state.sourceId = feed.sourceId;
    state.nextSample = feed.startSample + feed.sampleCount;
    state.nextSequence = feed.sequence + 1;
    state.lastFeed = feed;
    state.pendingStartSample ??= feed.startSample;
    state.health = {
      ...state.health,
      epoch: state.epoch,
      state: 'ready',
      sequence: feed.sequence,
      lastFrameSample: state.nextSample,
      restartCount: state.health.restartCount + (feed.flags.includes('recovered') ? 1 : 0),
      reason: feed.flags.includes('recovered') ? 'capture recovered' : undefined,
    };
  }

  private beginNewEpoch(state: ChannelState, reason: string, epoch = state.epoch + 1): void {
    state.epoch = epoch;
    state.pendingStartSample = null;
    state.committed = '';
    state.interimSegmentId = null;
    state.interimRevision = 0;
    state.health = {
      ...state.health,
      epoch,
      state: 'recovering',
      restartCount: state.health.restartCount + 1,
      reason,
    };
  }

  private adaptSnapshot(
    meetingId: string,
    active: ActiveMeeting,
    channel: MeetingAudioChannel,
    worker: WorkerSnapshot,
    feed?: MeetingAudioFeed,
    finalizing = false,
  ): MeetingTranscriptionSnapshot {
    const state = active.channels[channel];
    const endSample = feed ? feed.startSample + feed.sampleCount : state.nextSample;
    const startSample = state.pendingStartSample ?? endSample;
    const updates: MeetingTranscriptSegment[] = [];
    const priorInterim = state.interimSegmentId;
    const finalizingSnapshot = finalizing || worker.final;
    let supersededPriorInterim = false;

    // Nemotron streams a cumulative committed prefix plus a revisable tail.
    // A stable prefix closes one audio window; its identity derives from that
    // window's start sample, rather than from delivery order. The next
    // tentative tail therefore has a new deterministic ID and can coexist in
    // the same snapshot without being mistaken for the just-superseded tail.
    if (worker.committed && isPrefix(state.committed, worker.committed)) {
      const appended = worker.committed.slice(state.committed.length).trim();
      if (appended) {
        const id = segmentId(meetingId, channel, state.epoch, `stable:${startSample}`);
        updates.push({
          meetingId, segmentId: id, revision: 0, epoch: state.epoch,
          startSample, endSample,
          timingConfidence: 'low', timingSource: 'feed-window', channel, text: appended,
          finality: finalizingSnapshot ? 'final' : 'stable',
          clusterIds: [], overlap: false, speaker: unknownSpeaker(),
          attributionSource: 'self-hosted-feed-window', attributionConfidence: 0,
          supersedes: priorInterim ? [priorInterim] : [],
        });
        state.pendingStartSample = endSample;
        supersededPriorInterim = priorInterim !== null;
      }
      state.committed = worker.committed;
    }

    const tentative = worker.tentative.trim();
    if (tentative && !finalizingSnapshot) {
      const tentativeStartSample = state.pendingStartSample ?? endSample;
      const id = segmentId(meetingId, channel, state.epoch, `provisional:${tentativeStartSample}`);
      const previous = active.segments.get(id);
      const interim: MeetingTranscriptSegment = {
        meetingId, segmentId: id,
        revision: previous ? previous.revision + 1 : 0,
        epoch: state.epoch,
        startSample: tentativeStartSample,
        endSample,
        timingConfidence: 'low', timingSource: 'feed-window', channel, text: tentative,
        finality: 'interim', clusterIds: [], overlap: false, speaker: unknownSpeaker(),
        attributionSource: 'self-hosted-feed-window', attributionConfidence: 0,
        supersedes: [],
      };
      updates.push(interim);
      state.interimSegmentId = id;
      state.interimRevision = interim.revision;
    } else {
      state.interimSegmentId = null;
    }

    if (finalizingSnapshot) {
      // The final response is the authoritative cumulative text for the
      // current window. Convert only its not-yet-committed tail to a stable
      // segment and tombstone the revisable provisional record. Promoting the
      // provisional record itself would leave the same words both in the
      // final full window and in older stable fragments.
      const finalText = worker.full.trim();
      if (finalText && isPrefix(state.committed, finalText)) {
        const finalTail = finalText.slice(state.committed.length).trim();
        if (finalTail) {
          const finalStartSample = state.pendingStartSample ?? startSample;
          const finalId = segmentId(meetingId, channel, state.epoch, `stable:${finalStartSample}`);
          const previous = active.segments.get(finalId);
          updates.push({
            meetingId, segmentId: finalId,
            revision: previous ? previous.revision + 1 : 0,
            epoch: state.epoch,
            startSample: finalStartSample,
            endSample,
            timingConfidence: 'low', timingSource: 'feed-window', channel, text: finalTail,
            finality: 'final', clusterIds: [], overlap: false, speaker: unknownSpeaker(),
            attributionSource: 'self-hosted-feed-window', attributionConfidence: 0,
            supersedes: priorInterim ? [priorInterim] : [],
          });
          state.committed = finalText;
          state.pendingStartSample = endSample;
          supersededPriorInterim = priorInterim !== null;
        }
      }

      // If there is no final tail (for example, all text was already
      // committed), one existing stable segment still carries the tombstone so
      // the renderer removes the provisional record. This is a real revision,
      // not a duplicate transcript line.
      if (priorInterim && !supersededPriorInterim) {
        const stable = [...active.segments.values()]
          .filter((segment) => segment.channel === channel && segment.epoch === state.epoch && segment.segmentId !== priorInterim)
          .sort((left, right) => right.endSample - left.endSample || right.revision - left.revision)[0];
        if (stable) {
          updates.push({
            ...stable,
            revision: stable.revision + 1,
            finality: 'final',
            supersedes: [...new Set([...(stable.supersedes ?? []), priorInterim])],
          });
          supersededPriorInterim = true;
        }
      }

      const updateIds = new Set(updates.map((update) => update.segmentId));
      for (const existing of active.segments.values()) {
        if (
          existing.channel !== channel
          || existing.epoch !== state.epoch
          || existing.finality === 'final'
          || existing.segmentId === priorInterim
          || updateIds.has(existing.segmentId)
        ) continue;
        updates.push({ ...existing, revision: existing.revision + 1, finality: 'final' });
      }
    }

    // Main owns the same tombstone semantics as the renderer. Otherwise a
    // later finalize would see an already-superseded provisional record and
    // incorrectly promote it to a second final fragment.
    if (supersededPriorInterim && priorInterim) {
      active.segments.delete(priorInterim);
      active.pendingAttributionUpserts.delete(priorInterim);
    }

    const merged = mergeMeetingTranscriptSegments(active.segments.values(), updates);
    active.segments = new Map(merged.map((segment) => [segment.segmentId, segment]));
    const accepted = updates.filter((update) => active.segments.get(update.segmentId)?.revision === update.revision);
    // AX/evidence often arrives before the corresponding ASR text because
    // the stream has model look-ahead. Re-evaluate exactly the records this
    // snapshot created or revised against the bounded retained history.
    const attributed = this.resolveStoredSpeakerEvidence(active, accepted.map((segment) => segment.segmentId));
    this.pruneSpeakerEvidence(active);
    const pending = [...active.pendingAttributionUpserts.values()];
    const emitted = mergeMeetingTranscriptSegments([], [...accepted, ...attributed, ...pending]);
    for (const queued of pending) {
      const delivered = emitted.find((segment) => segment.segmentId === queued.segmentId);
      if (delivered && delivered.revision >= queued.revision) {
        active.pendingAttributionUpserts.delete(queued.segmentId);
      }
    }
    return {
      ...worker,
      version: 2,
      epoch: state.epoch,
      feed,
      captureHealth: { ...state.health },
      segments: emitted,
    };
  }

  private requireConfig(): SelfHostedConfig {
    const config = loadSelfHostedMeetingConfig();
    if (!config) throw new Error('Self-hosted meeting transcription is not configured');
    return config;
  }

  private requireActive(meetingId: string): ActiveMeeting {
    const active = this.active.get(safeMeetingId(meetingId));
    if (!active) throw new Error('Meeting transcription session is not active');
    return active;
  }

  private async beginSessions(config: SelfHostedConfig, sessions: Record<MeetingAudioChannel, string>, language: string): Promise<void> {
    await this.serialized(() => this.request(config, '/stream/begin', sessions.mic, undefined, language));
    await this.serialized(() => this.request(config, '/stream/begin', sessions.system, undefined, language));
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.computeTail.then(operation, operation);
    this.computeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async bestEffortReset(config: SelfHostedConfig, session: string): Promise<void> {
    try {
      await this.serialized(() => this.request(config, '/stream/reset', session));
    } catch {
      // Reset is cleanup. Preserve the original failure/final transcript.
    }
  }

  private async request(config: SelfHostedConfig, path: string, session: string, body?: Buffer, language?: string): Promise<unknown> {
    const url = new URL(config.baseUrl);
    const basePath = config.baseUrl.pathname === '/' ? '' : config.baseUrl.pathname;
    url.pathname = `${basePath}${path}`.replace(/\/{2,}/g, '/');
    url.search = '';
    url.searchParams.set('session', session);
    if (language) url.searchParams.set('language', language);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
    const requestBody = body ? Uint8Array.from(body).buffer : undefined;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/octet-stream' },
        body: requestBody,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = {};
      if (text) {
        try { parsed = JSON.parse(text); } catch { throw new Error(`Transcription worker returned invalid JSON (${response.status})`); }
      }
      if (!response.ok) {
        const message = typeof parsed === 'object' && parsed && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${response.status}`;
        throw new Error(`Transcription worker request failed: ${message}`);
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const selfHostedMeetingTranscription = new SelfHostedMeetingTranscription();
