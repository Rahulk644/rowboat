import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Electron-main supervisor for the native meeting bridge.
 *
 * This module is intentionally dormant unless `ROWBOAT_MEETING_BRIDGE_ENABLED`
 * is exactly `1`. The current meeting capture implementation remains the
 * rollback path. The bridge protocol is limited to small NDJSON control and
 * metadata messages; PCM is neither parsed nor sent to a renderer here.
 */

const PROTOCOL_VERSION = 1;
const MAX_EVENT_BYTES = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const PING_TIMEOUT_MS = 3_000;
const DEFAULT_RESTART_WINDOW_MS = 60_000;

export type MeetingBridgePaths = {
  /** Absolute Rowboat repository root in development. */
  repositoryRoot: string;
  /** Electron `process.resourcesPath` in a packaged app. */
  resourcesPath?: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
};

export type BridgeCaptureHealth = {
  meeting_id: string;
  channel: 'mic' | 'system';
  state: 'off' | 'starting' | 'ready' | 'stalled' | 'recovering' | 'failed';
  sequence: number;
  last_frame_sample: number | null;
  restart_count: number;
  reason: string | null;
};

/**
 * Electron-main-only normalized attribution evidence. It is intentionally
 * camelCase for the Rowboat protocol layer and must be resolved there before
 * any minimal display update; raw AX observations never go to the renderer.
 */
export type BridgeSpeakerEvidence = {
  meetingId: string;
  startSample: number;
  endSample: number;
  platform: string;
  surface: string;
  participantId?: string;
  displayName?: string;
  isSelf?: boolean;
  isActive?: boolean;
  isMuted?: boolean;
  source: 'zoom_ax' | 'meet_ax' | 'teams_ax' | 'generic_ax' | 'browser_extension' | 'voice_profile' | 'correction';
  confidence: number;
  observedAtSample: number;
  signals: string[];
};

export type BridgeEvent =
  | { type: 'ready'; protocol_version: number }
  | { type: 'pong'; request_id: string }
  | { type: 'capture_health'; health: BridgeCaptureHealth }
  | {
      type: 'audio_frame';
      metadata: {
        meeting_id: string;
        source_id: string;
        channel: 'mic' | 'system';
        start_sample: number;
        sample_count: number;
        sample_rate: number;
        sequence: number;
        epoch: number;
        flags: { discontinuity: boolean; recovered: boolean; silence: boolean };
      };
    }
  | { type: 'speaker_evidence'; evidence: BridgeSpeakerEvidence }
  | { type: 'backpressure'; channel: 'mic' | 'system'; dropped_frames: number; capacity: number }
  | { type: 'error'; code: string; message: string };

export type MeetingBridgeStatus = {
  state: 'disabled' | 'idle' | 'starting' | 'ready' | 'recovering' | 'failed';
  restartCount: number;
  reason?: string;
};

type BridgeSpawnOptions = Pick<SpawnOptions, 'env' | 'shell' | 'windowsHide'> & {
  stdio: 'pipe';
};

type SpawnChild = (
  executable: string,
  args: readonly string[],
  options: BridgeSpawnOptions,
) => ChildProcessWithoutNullStreams;

type TimerHandle = ReturnType<typeof setTimeout>;

export type MeetingBridgeSupervisorOptions = {
  enabled?: () => boolean;
  resolveBinary: () => string;
  spawn?: SpawnChild;
  onEvent?: (event: Exclude<BridgeEvent, { type: 'ready' } | { type: 'pong' }>) => void;
  onStatus?: (status: MeetingBridgeStatus) => void;
  handshakeTimeoutMs?: number;
  pingTimeoutMs?: number;
  restartBackoff?: {
    initialMs: number;
    maximumMs: number;
    maximumRestarts: number;
    windowMs?: number;
  };
};

type PendingPing = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: TimerHandle;
};

type PendingHandshake = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: TimerHandle;
};

type ChildListeners = {
  child: ChildProcessWithoutNullStreams;
  stdout: (chunk: Buffer) => void;
  stderr: () => void;
  error: () => void;
  close: () => void;
};

const DEFAULT_BACKOFF = {
  initialMs: 250,
  maximumMs: 5_000,
  maximumRestarts: 3,
  windowMs: DEFAULT_RESTART_WINDOW_MS,
} as const;

/** The bridge is an explicit opt-in while the existing capture path remains live. */
export function isMeetingBridgeEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.ROWBOAT_MEETING_BRIDGE_ENABLED === '1';
}

/**
 * Resolve a known platform binary without accepting a renderer-provided path.
 * Packaged builds must stage `meeting-bridge/<platform>/<binary>` as a resource;
 * development builds use Cargo's debug output beneath the repository root.
 */
export function resolveMeetingBridgeBinary(paths: MeetingBridgePaths): string {
  const platform = paths.platform ?? process.platform;
  const executable = platform === 'win32' ? 'meeting-bridge.exe' : 'meeting-bridge';
  const root = paths.isPackaged
    ? path.resolve(requireAbsolute(paths.resourcesPath, 'resourcesPath'), 'meeting-bridge', platform)
    : path.resolve(requireAbsolute(paths.repositoryRoot, 'repositoryRoot'), 'native', 'meeting-bridge', 'target', 'debug');
  const candidate = path.resolve(root, executable);
  if (path.dirname(candidate) !== root) {
    throw new Error('Meeting bridge binary path escaped its approved directory');
  }
  if (!fs.existsSync(candidate)) {
    throw new Error('Meeting bridge binary is unavailable');
  }

  // Reject a symlink escaping the packaged/development bridge directory. This
  // also catches a corrupted resource installation before it can be spawned.
  const realRoot = fs.realpathSync.native(root);
  const realCandidate = fs.realpathSync.native(candidate);
  if (realCandidate !== path.join(realRoot, executable)) {
    throw new Error('Meeting bridge binary did not resolve inside its approved directory');
  }
  const stat = fs.statSync(realCandidate);
  if (!stat.isFile()) throw new Error('Meeting bridge binary is not a regular file');
  if (platform !== 'win32' && (stat.mode & 0o111) === 0) {
    throw new Error('Meeting bridge binary is not executable');
  }
  return realCandidate;
}

function requireAbsolute(value: string | undefined, label: string): string {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return value;
}

function safeMeetingId(meetingId: string): string {
  const normalized = meetingId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96);
  if (!normalized) throw new Error('A meeting id is required');
  return normalized;
}

/**
 * Owns the native process solely in Electron main. Consumers get health and
 * metadata events; no renderer-facing API here can receive or return PCM.
 */
export class MeetingBridgeSupervisor {
  private readonly enabled: () => boolean;
  private readonly spawn: SpawnChild;
  private readonly backoff: Required<NonNullable<MeetingBridgeSupervisorOptions['restartBackoff']>>;
  private readonly pendingPings = new Map<string, PendingPing>();
  private child: ChildProcessWithoutNullStreams | null = null;
  private childListeners: ChildListeners | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private desiredMeetingId: string | null = null;
  private pendingHandshake: PendingHandshake | null = null;
  private handshakePromise: Promise<void> | null = null;
  private restartTimer: TimerHandle | null = null;
  private restartTimes: number[] = [];
  private status: MeetingBridgeStatus;

  constructor(private readonly options: MeetingBridgeSupervisorOptions) {
    this.enabled = options.enabled ?? isMeetingBridgeEnabled;
    this.spawn = options.spawn ?? ((executable, args, spawnOptions) => nodeSpawn(executable, args, spawnOptions));
    this.backoff = { ...DEFAULT_BACKOFF, ...options.restartBackoff };
    this.status = {
      state: this.enabled() ? 'idle' : 'disabled',
      restartCount: 0,
    };
  }

  getStatus(): MeetingBridgeStatus {
    return { ...this.status };
  }

  async start(meetingId: string): Promise<boolean> {
    if (!this.enabled()) {
      this.setStatus({ state: 'disabled', restartCount: 0 });
      return false;
    }
    this.desiredMeetingId = safeMeetingId(meetingId);
    await this.ensureReady();
    await this.writeCommand({ type: 'start', meeting_id: this.desiredMeetingId });
    return true;
  }

  /**
   * Start and handshake the helper before renderer capture begins. Warming is
   * deliberately not a capture command: it has no meeting id and cannot emit
   * attribution evidence.
   */
  async warm(): Promise<boolean> {
    if (!this.enabled()) {
      this.setStatus({ state: 'disabled', restartCount: 0 });
      return false;
    }
    try {
      await this.ensureReady();
      return true;
    } catch {
      // Alpha capture keeps the existing path authoritative. Do not schedule
      // a later cold start whose sample origin would no longer match audio.
      return false;
    }
  }

  /**
   * Send Start only to the already-handshaken helper. Unlike `start()`, this
   * refuses to spawn: renderer capture must not wait for a late native child.
   */
  async startIfReady(meetingId: string): Promise<boolean> {
    if (!this.enabled()) {
      this.setStatus({ state: 'disabled', restartCount: 0 });
      return false;
    }
    if (!this.child || this.status.state !== 'ready') return false;
    const normalizedMeetingId = safeMeetingId(meetingId);
    try {
      await this.writeCommand({ type: 'start', meeting_id: normalizedMeetingId });
      this.desiredMeetingId = normalizedMeetingId;
      return true;
    } catch {
      // The child may have died between the readiness check and this write.
      // Preserve current capture rather than permitting a replacement spawn.
      return false;
    }
  }

  async stop(): Promise<void> {
    const meetingId = this.desiredMeetingId;
    this.desiredMeetingId = null;
    this.clearRestartTimer();
    const child = this.child;
    this.rejectPending('Meeting bridge stopped');
    this.detachChild();
    if (!child) {
      this.setStatus({ state: this.enabled() ? 'idle' : 'disabled', restartCount: 0 });
      return;
    }
    try {
      await writeNdjson(child, { type: 'stop', meeting_id: meetingId ?? 'stopped' });
    } catch {
      // The process is being terminated immediately below; a failed graceful
      // stop cannot change the rollback capture path.
    }
    this.terminateChild(child);
    this.setStatus({ state: this.enabled() ? 'idle' : 'disabled', restartCount: 0 });
  }

  async ping(): Promise<void> {
    if (!this.child || this.status.state !== 'ready') {
      throw new Error('Meeting bridge is not ready');
    }
    const requestId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingPings.delete(requestId);
        reject(new Error('Meeting bridge ping timed out'));
      }, this.options.pingTimeoutMs ?? PING_TIMEOUT_MS);
      timeout.unref();
      this.pendingPings.set(requestId, { resolve, reject, timeout });
      this.writeCommand({ type: 'ping', request_id: requestId }).catch((error: unknown) => {
        clearTimeout(timeout);
        this.pendingPings.delete(requestId);
        reject(error instanceof Error ? error : new Error('Meeting bridge ping failed'));
      });
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.child && this.status.state === 'ready') return;
    if (this.pendingHandshake) {
      await this.handshakePromise;
      return;
    }
    await this.spawnAndHandshake();
  }

  private async spawnAndHandshake(): Promise<void> {
    this.clearRestartTimer();
    this.setStatus({ state: 'starting', restartCount: this.restartTimes.length });
    let executable: string;
    try {
      executable = this.options.resolveBinary();
    } catch {
      this.handleFailure('bridge binary unavailable');
      throw new Error('Meeting bridge binary is unavailable');
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawn(executable, [], {
        // Keep a short allow-list. The bridge gets no Rowboat/OAuth/VPS token
        // and secrets never appear in executable arguments or diagnostics.
        env: bridgeEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: 'pipe',
      });
    } catch {
      this.handleFailure('bridge spawn failed');
      throw new Error('Meeting bridge spawn failed');
    }
    this.child = child;
    this.stdoutBuffer = Buffer.alloc(0);
    const listeners: ChildListeners = {
      child,
      stdout: (chunk: Buffer) => this.onStdout(child, Buffer.from(chunk)),
      stderr: () => {
      // Drain stderr so a broken helper cannot block, but do not surface it:
      // process output could contain sensitive platform diagnostics.
      },
      error: () => this.onChildFailure(child, 'bridge process error'),
      close: () => this.onChildFailure(child, 'bridge process closed'),
    };
    this.childListeners = listeners;
    child.stdout.on('data', listeners.stdout);
    child.stderr.on('data', listeners.stderr);
    child.once('error', listeners.error);
    child.once('close', listeners.close);

    this.handshakePromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingHandshake?.timeout === timeout) this.pendingHandshake = null;
        this.onChildFailure(child, 'bridge handshake timed out');
        reject(new Error('Meeting bridge handshake timed out'));
      }, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
      timeout.unref();
      this.pendingHandshake = { resolve, reject, timeout };
    });
    await this.handshakePromise;
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return;
    const buffered = Buffer.concat([this.stdoutBuffer, chunk]);
    let cursor = 0;
    for (;;) {
      const newline = buffered.indexOf(0x0a, cursor);
      if (newline === -1) break;
      const line = buffered.subarray(cursor, newline);
      cursor = newline + 1;
      if (line.length === 0) continue;
      if (line.length > MAX_EVENT_BYTES) {
        this.onChildFailure(child, 'bridge event exceeded size limit');
        return;
      }
      let event: BridgeEvent;
      try {
        event = parseBridgeEvent(line);
      } catch {
        this.onChildFailure(child, 'bridge emitted an invalid event');
        return;
      }
      this.onEvent(event);
      if (child !== this.child) return;
    }
    const residual = buffered.subarray(cursor);
    if (residual.length > MAX_EVENT_BYTES) {
      this.onChildFailure(child, 'bridge event exceeded size limit');
      return;
    }
    this.stdoutBuffer = Buffer.from(residual);
  }

  private onEvent(event: BridgeEvent): void {
    if (event.type === 'ready') {
      if (event.protocol_version !== PROTOCOL_VERSION || !this.pendingHandshake) {
        this.onChildFailure(this.child, 'bridge protocol version mismatch');
        return;
      }
      const handshake = this.pendingHandshake;
      this.pendingHandshake = null;
      this.handshakePromise = null;
      clearTimeout(handshake.timeout);
      this.setStatus({ state: 'ready', restartCount: this.restartTimes.length });
      handshake.resolve();
      return;
    }
    if (event.type === 'pong') {
      const pending = this.pendingPings.get(event.request_id);
      if (!pending) return;
      this.pendingPings.delete(event.request_id);
      clearTimeout(pending.timeout);
      pending.resolve();
      return;
    }
    if (this.status.state !== 'ready') {
      this.onChildFailure(this.child, 'bridge emitted metadata before handshake');
      return;
    }
    this.options.onEvent?.(event);
  }

  private onChildFailure(child: ChildProcessWithoutNullStreams | null, reason: string): void {
    if (!child || child !== this.child) return;
    this.rejectPending(reason);
    this.detachChild();
    this.terminateChild(child);
    if (!this.enabled() || !this.desiredMeetingId) {
      this.setStatus({ state: this.enabled() ? 'idle' : 'disabled', restartCount: 0 });
      return;
    }
    this.handleFailure(reason);
  }

  private handleFailure(reason: string): void {
    if (!this.enabled() || !this.desiredMeetingId) return;
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((at) => now - at <= this.backoff.windowMs);
    if (this.restartTimes.length >= this.backoff.maximumRestarts) {
      this.setStatus({ state: 'failed', restartCount: this.restartTimes.length, reason: 'bridge recovery limit reached' });
      return;
    }
    this.restartTimes.push(now);
    const multiplier = 2 ** (this.restartTimes.length - 1);
    const delay = Math.min(this.backoff.initialMs * multiplier, this.backoff.maximumMs);
    this.setStatus({ state: 'recovering', restartCount: this.restartTimes.length, reason });
    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      const meetingId = this.desiredMeetingId;
      if (!meetingId || !this.enabled()) return;
      this.spawnAndHandshake()
        .then(() => this.writeCommand({ type: 'start', meeting_id: meetingId }))
        .catch(() => {
          // `spawnAndHandshake` already schedules a bounded retry.
      });
    }, delay);
    this.restartTimer.unref();
  }

  private async writeCommand(command: Record<string, string>): Promise<void> {
    if (!this.child) throw new Error('Meeting bridge is not running');
    await writeNdjson(this.child, command);
  }

  private detachChild(): void {
    const listeners = this.childListeners;
    if (listeners) {
      listeners.child.stdout.off('data', listeners.stdout);
      listeners.child.stderr.off('data', listeners.stderr);
      listeners.child.off('error', listeners.error);
      listeners.child.off('close', listeners.close);
    }
    this.childListeners = null;
    this.child = null;
    this.stdoutBuffer = Buffer.alloc(0);
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    try {
      if (!child.killed) child.kill();
    } catch {
      // A close/error race means the OS has already reclaimed this process.
    }
  }

  private rejectPending(reason: string): void {
    const handshake = this.pendingHandshake;
    this.pendingHandshake = null;
    this.handshakePromise = null;
    if (handshake) {
      clearTimeout(handshake.timeout);
      handshake.reject(new Error(reason));
    }
    for (const pending of this.pendingPings.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingPings.clear();
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private setStatus(status: MeetingBridgeStatus): void {
    this.status = status;
    this.options.onStatus?.({ ...status });
  }
}

function bridgeEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'USER', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR', 'COMSPEC'];
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function writeNdjson(child: ChildProcessWithoutNullStreams, command: Record<string, string>): Promise<void> {
  const line = `${JSON.stringify(command)}\n`;
  if (Buffer.byteLength(line) > MAX_EVENT_BYTES) return Promise.reject(new Error('Bridge command exceeds size limit'));
  return new Promise((resolve, reject) => {
    child.stdin.write(line, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function parseBridgeEvent(line: Buffer): BridgeEvent {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed.type !== 'string') throw new Error('event must be an object');
  switch (parsed.type) {
    case 'ready':
      assertKeys(parsed, ['type', 'protocol_version']);
      return { type: 'ready', protocol_version: integer(parsed.protocol_version) };
    case 'pong':
      assertKeys(parsed, ['type', 'request_id']);
      return { type: 'pong', request_id: string(parsed.request_id, 128) };
    case 'capture_health':
      assertKeys(parsed, ['type', 'health']);
      return { type: 'capture_health', health: parseHealth(parsed.health) };
    case 'audio_frame':
      assertKeys(parsed, ['type', 'metadata']);
      return { type: 'audio_frame', metadata: parseFrameMetadata(parsed.metadata) };
    case 'speaker_evidence':
      assertKeys(parsed, ['type', 'evidence']);
      return { type: 'speaker_evidence', evidence: parseSpeakerEvidence(parsed.evidence) };
    case 'backpressure':
      assertKeys(parsed, ['type', 'channel', 'dropped_frames', 'capacity']);
      return {
        type: 'backpressure',
        channel: channel(parsed.channel),
        dropped_frames: integer(parsed.dropped_frames),
        capacity: integer(parsed.capacity),
      };
    case 'error':
      assertKeys(parsed, ['type', 'code', 'message']);
      return { type: 'error', code: string(parsed.code, 128), message: string(parsed.message, 512) };
    default:
      throw new Error('unknown bridge event type');
  }
}

function parseHealth(value: unknown): BridgeCaptureHealth {
  if (!isRecord(value)) throw new Error('invalid health');
  assertKeys(value, ['meeting_id', 'channel', 'state', 'sequence', 'last_frame_sample', 'restart_count', 'reason']);
  const state = string(value.state, 32);
  if (!['off', 'starting', 'ready', 'stalled', 'recovering', 'failed'].includes(state)) throw new Error('invalid health state');
  return {
    meeting_id: string(value.meeting_id, 128),
    channel: channel(value.channel),
    state: state as BridgeCaptureHealth['state'],
    sequence: integer(value.sequence),
    last_frame_sample: value.last_frame_sample === null ? null : integer(value.last_frame_sample),
    restart_count: integer(value.restart_count),
    reason: value.reason === null ? null : string(value.reason, 240),
  };
}

function parseFrameMetadata(value: unknown): Extract<BridgeEvent, { type: 'audio_frame' }>['metadata'] {
  if (!isRecord(value)) throw new Error('invalid frame metadata');
  assertKeys(value, ['meeting_id', 'source_id', 'channel', 'start_sample', 'sample_count', 'sample_rate', 'sequence', 'epoch', 'flags']);
  if (!isRecord(value.flags)) throw new Error('invalid frame flags');
  assertKeys(value.flags, ['discontinuity', 'recovered', 'silence']);
  return {
    meeting_id: string(value.meeting_id, 128),
    source_id: string(value.source_id, 128),
    channel: channel(value.channel),
    start_sample: integer(value.start_sample),
    sample_count: integer(value.sample_count),
    sample_rate: integer(value.sample_rate),
    sequence: integer(value.sequence),
    epoch: integer(value.epoch),
    flags: {
      discontinuity: boolean(value.flags.discontinuity),
      recovered: boolean(value.flags.recovered),
      silence: boolean(value.flags.silence),
    },
  };
}

function parseSpeakerEvidence(value: unknown): BridgeSpeakerEvidence {
  if (!isRecord(value)) throw new Error('invalid speaker evidence');
  assertKeys(value, [
    'meeting_id', 'start_sample', 'end_sample', 'platform', 'surface', 'participant_id', 'display_name',
    'is_self', 'is_active', 'is_muted', 'source', 'confidence', 'observed_at_sample', 'signals',
  ]);
  const source = string(value.source, 32);
  if (!['zoom_ax', 'meet_ax', 'teams_ax', 'generic_ax', 'browser_extension', 'voice_profile', 'correction'].includes(source)) {
    throw new Error('invalid evidence source');
  }
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    throw new Error('invalid evidence confidence');
  }
  if (!Array.isArray(value.signals) || value.signals.length > 8) throw new Error('invalid evidence signals');
  return {
    meetingId: string(value.meeting_id, 128),
    startSample: integer(value.start_sample),
    endSample: integer(value.end_sample),
    platform: string(value.platform, 64),
    surface: string(value.surface, 128),
    participantId: optionalString(value.participant_id, 128),
    displayName: optionalString(value.display_name, 256),
    isSelf: optionalBoolean(value.is_self),
    isActive: optionalBoolean(value.is_active),
    isMuted: optionalBoolean(value.is_muted),
    source: source as BridgeSpeakerEvidence['source'],
    confidence: value.confidence,
    observedAtSample: integer(value.observed_at_sample),
    signals: value.signals.map((signal) => string(signal, 128)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new Error('unexpected event shape');
  }
}

function string(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum) {
    throw new Error('invalid string');
  }
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid integer');
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('invalid boolean');
  return value;
}

function optionalString(value: unknown, maximum: number): string | undefined {
  return value === null ? undefined : string(value, maximum);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return value === null ? undefined : boolean(value);
}

function channel(value: unknown): 'mic' | 'system' {
  if (value !== 'mic' && value !== 'system') throw new Error('invalid channel');
  return value;
}
