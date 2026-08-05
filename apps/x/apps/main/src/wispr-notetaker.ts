import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { watch, type FSWatcher } from 'chokidar';
import type { MeetingTranscriptSegment } from './meeting-transcription.js';
import {
  resolveMeetingSpeakerUpsert,
  type MeetingSpeakerEvidence,
} from './meeting-speaker-resolver.js';

const PROTOCOL_VERSION = 1;
const SAMPLE_RATE = 16_000;
const MAX_LINE_BYTES = 128 * 1024;
const MAX_TEXT_LENGTH = 20_000;
const ACTIVE_MEETING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MEETING_STATE_POLL_INTERVAL_MS = 500;
const MAX_RETAINED_SPEAKER_EVIDENCE = 2_048;
const EXTENSION_NAME = 'rowboat-notetaker';

export type WisprConnectorStatus = {
  supported: boolean;
  wisprInstalled: boolean;
  connectorInstalled: boolean;
  connected: boolean;
  extensionConnected: boolean;
  preferred: boolean;
  restartRequired: boolean;
  reason?: string;
};

export type WisprMeetingArtifact = {
  meetingId: string;
  title?: string;
  notes?: string;
  summary?: string;
  participantNames: string[];
  finalized: boolean;
  endedAt?: string | number;
};

export type WisprMeetingEvent = {
  type: 'transcript';
  rowboatMeetingId: string;
  wisprMeetingId: string;
  segments: MeetingTranscriptSegment[];
};

export type WisprMeetingDetectedEvent = {
  wisprMeetingId: string;
};

export type WisprMeetingEndedEvent = {
  rowboatMeetingId: string;
  wisprMeetingId: string;
};

type WisprSpeakerSource = 'mic' | 'system' | 'refined';

type WisprTranscriptEntry = {
  id: string;
  text: string;
  timestamp?: number;
  startEpochMs?: number;
  endEpochMs?: number;
  startRecordingMs?: number;
  endRecordingMs?: number;
  speaker: {
    id?: string;
    source: WisprSpeakerSource;
    name?: string;
  };
};

export type WisprSpeakerMap = ReadonlyMap<string, {
  personId: string;
  name: string;
  origin: string;
}>;

type PendingChunk = {
  segmentId: string;
  textKey: string;
  emittedAt: number;
  revision: number;
};

type ActiveSession = {
  rowboatMeetingId: string;
  wisprMeetingId: string | null;
  startedAt: number;
  sequence: number;
  pending: PendingChunk[];
  endNotified: boolean;
  recordingEpochMs?: number;
  evidenceClockStartedAt?: number;
  speakerEvidence: MeetingSpeakerEvidence[];
  speakerMap: WisprSpeakerMap;
  speakerMapFingerprint: string;
  segmentByEntryId: Map<string, {
    segmentId: string;
    revision: number;
    channel: 'mic' | 'system';
    fingerprint: string;
    segment?: MeetingTranscriptSegment;
  }>;
};

type SourceOptions = {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  flowSupportDirectory?: string;
  rowboatDirectory?: string;
  wisprApplicationPath?: string;
  extensionSourceRoot: string;
  now?: () => number;
  onEvent: (event: WisprMeetingEvent) => void;
  onDetected?: (event: WisprMeetingDetectedEvent) => void;
  onEnded?: (event: WisprMeetingEndedEvent) => void;
};

function safeId(value: string, max = 120): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, max) || 'wispr';
}

function textKey(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstFinite(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function firstIdentifier(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  }
  return undefined;
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    if (!parsed.trim()) return null;
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function assignmentPersonId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 160);
  const record = jsonRecord(value);
  return record ? firstIdentifier(record, ['personId', 'person_id', 'id'])?.slice(0, 160) : undefined;
}

/**
 * Wispr persists participant identities separately from diarization cluster
 * assignments. Only an explicit assignment may name a cluster; the passive
 * participant roster is never guessed onto transcript text.
 */
export function parseWisprSpeakerMap(value: unknown): WisprSpeakerMap {
  const root = jsonRecord(value);
  const people = jsonRecord(root?.people);
  const assignments = jsonRecord(root?.assignments);
  const resolved = new Map<string, { personId: string; name: string; origin: string }>();
  if (!people || !assignments) return resolved;

  const names = new Map<string, string>();
  for (const [personId, rawPerson] of Object.entries(people).slice(0, 256)) {
    const person = jsonRecord(rawPerson);
    const name = person ? firstString(person, ['name', 'displayName']) : undefined;
    if (personId && personId.length <= 160 && name && name.length <= 160) names.set(personId, name);
  }

  const precedence = ['user', 'dom', 'mic', 'llm', 'consensus'] as const;
  for (const [speakerId, rawAssignment] of Object.entries(assignments).slice(0, 256)) {
    if (!speakerId || speakerId.length > 160) continue;
    const assignment = jsonRecord(rawAssignment);
    if (!assignment) continue;
    for (const origin of precedence) {
      const personId = assignmentPersonId(assignment[origin]);
      const name = personId ? names.get(personId) : undefined;
      if (!personId || !name) continue;
      resolved.set(speakerId, { personId, name, origin });
      break;
    }
  }
  return resolved;
}

export function parseWisprTranscriptEntry(value: unknown): WisprTranscriptEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ('meta' in record) return null;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text || text.length > MAX_TEXT_LENGTH) return null;
  const id = firstString(record, ['id', 'entryId', 'segmentId']);
  const rawSpeaker = record.speaker;
  if (!id || !rawSpeaker || typeof rawSpeaker !== 'object' || Array.isArray(rawSpeaker)) return null;
  const speaker = rawSpeaker as Record<string, unknown>;
  const source = speaker.source;
  if (source !== 'mic' && source !== 'system' && source !== 'refined') return null;
  const timestamp = firstFinite(record, ['timestamp', 'timestampMs', 'wallClockMs']);
  const startEpochMs = firstFinite(record, ['startEpochMs', 'start_epoch_ms']);
  const endEpochMs = firstFinite(record, ['endEpochMs', 'end_epoch_ms']);
  const startRecordingMs = firstFinite(record, [
    'startRecordingMs', 'start_recording_ms', 'startRecordingActiveMs', 'startMs',
  ]);
  const endRecordingMs = firstFinite(record, [
    'endRecordingMs', 'end_recording_ms', 'endRecordingActiveMs', 'endMs',
  ]);
  return {
    id,
    text,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(startEpochMs !== undefined ? { startEpochMs } : {}),
    ...(endEpochMs !== undefined ? { endEpochMs } : {}),
    ...(startRecordingMs !== undefined ? { startRecordingMs } : {}),
    ...(endRecordingMs !== undefined ? { endRecordingMs } : {}),
    speaker: {
      id: firstIdentifier(speaker, ['id', 'speakerId']),
      source,
      name: firstString(speaker, ['name', 'displayName']),
    },
  };
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && !!item.trim());
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && !!item.trim())
      : [];
  } catch {
    return [];
  }
}

function lexicalText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(lexicalText).filter(Boolean).join('\n');
  const record = value as Record<string, unknown>;
  const root = lexicalText(record.root);
  const own = typeof record.text === 'string' ? record.text : '';
  const children = lexicalText(record.children);
  if (!own && !children) return root;
  if (!own) return children;
  if (!children) return own;
  return `${own}\n${children}`;
}

export function normalizeWisprRichText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
  try {
    const text = lexicalText(JSON.parse(trimmed)).replace(/\n{3,}/g, '\n\n').trim();
    return text || undefined;
  } catch {
    return trimmed;
  }
}

async function atomicJson(file: string, value: unknown, mode = 0o600): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  await fsp.chmod(temporary, mode);
  await fsp.rename(temporary, file);
}

async function readJson(file: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export class WisprNotetakerSource {
  private readonly platform: NodeJS.Platform;
  private readonly flowSupportDirectory: string;
  private readonly rowboatDirectory: string;
  private readonly wisprApplicationPath: string;
  private readonly extensionSourceRoot: string;
  private readonly now: () => number;
  private readonly onEvent: (event: WisprMeetingEvent) => void;
  private readonly onDetected?: (event: WisprMeetingDetectedEvent) => void;
  private readonly onEnded?: (event: WisprMeetingEndedEvent) => void;
  private readonly sockets = new Set<net.Socket>();
  private server: net.Server | null = null;
  private watcher: FSWatcher | null = null;
  private detectionWatcher: FSWatcher | null = null;
  private meetingStateTimer: NodeJS.Timeout | null = null;
  private meetingStatePollInFlight = false;
  private token = '';
  private authenticatedClients = 0;
  private restartRequired = false;
  private session: ActiveSession | null = null;
  private pendingWisprMeetingId: string | null = null;
  private pendingChunks: Array<{ meetingId: string; text: string; name?: string }> = [];

  constructor(options: SourceOptions) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.platform = options.platform ?? process.platform;
    this.flowSupportDirectory = options.flowSupportDirectory
      ?? path.join(homeDirectory, 'Library', 'Application Support', 'Wispr Flow');
    this.rowboatDirectory = options.rowboatDirectory ?? path.join(homeDirectory, '.rowboat');
    this.wisprApplicationPath = options.wisprApplicationPath ?? '/Applications/Wispr Flow.app';
    this.extensionSourceRoot = options.extensionSourceRoot;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
    this.onDetected = options.onDetected;
    this.onEnded = options.onEnded;
  }

  private get runDirectory(): string { return path.join(this.rowboatDirectory, 'run'); }
  private get socketPath(): string { return path.join(this.runDirectory, 'wispr-notetaker.sock'); }
  private get runtimeFile(): string { return path.join(this.runDirectory, 'wispr-notetaker.json'); }
  private get preferenceFile(): string { return path.join(this.rowboatDirectory, 'config', 'meeting-provider.json'); }
  private get integrationRoot(): string { return path.join(this.rowboatDirectory, 'integrations', 'wispr-flow'); }
  private get installedExtensionRoot(): string {
    return path.join(this.integrationRoot, 'extensions', EXTENSION_NAME);
  }
  private get customPathsFile(): string {
    return path.join(this.flowSupportDirectory, 'extensions', 'custom-paths.json');
  }
  private get extensionsStateFile(): string {
    return path.join(this.flowSupportDirectory, 'extensions', 'extensions-state.json');
  }

  async start(): Promise<void> {
    if (this.platform !== 'darwin' || this.server) return;
    await fsp.mkdir(this.runDirectory, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.runDirectory, 0o700);
    try {
      const stat = await fsp.lstat(this.socketPath);
      if (!stat.isSocket()) throw new Error('Refusing to replace a non-socket Wispr connector path');
      await fsp.unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    this.token = randomBytes(32).toString('base64url');
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await fsp.chmod(this.socketPath, 0o600);
    await atomicJson(this.runtimeFile, {
      v: PROTOCOL_VERSION,
      socketPath: this.socketPath,
      token: this.token,
      pid: process.pid,
    });
    const meetingsRoot = path.join(this.flowSupportDirectory, 'meetings');
    this.detectionWatcher = watch(meetingsRoot, { ignoreInitial: true, depth: 2 });
    const detect = (file: string) => {
      if (path.basename(file) !== 'live.ndjson') return;
      const meetingId = path.basename(path.dirname(file));
      void this.queueDetectedMeeting(meetingId);
    };
    this.detectionWatcher.on('add', detect);
    this.detectionWatcher.on('change', detect);
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let authenticated = false;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) return socket.destroy();
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: unknown;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!authenticated) {
          const hello = message as { v?: unknown; type?: unknown; token?: unknown };
          if (hello.v !== PROTOCOL_VERSION || hello.type !== 'hello' || hello.token !== this.token) {
            socket.destroy();
            return;
          }
          authenticated = true;
          this.authenticatedClients++;
          console.info('[WisprNotetaker] local connector authenticated');
          continue;
        }
        this.handleMessage(message);
      }
    });
    socket.once('close', () => {
      this.sockets.delete(socket);
      if (authenticated) {
        this.authenticatedClients = Math.max(0, this.authenticatedClients - 1);
        console.info('[WisprNotetaker] local connector disconnected');
      }
    });
    socket.on('error', () => {});
  }

  private handleMessage(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.v !== PROTOCOL_VERSION || message.type !== 'chunk') return;
    const meetingId = typeof message.meetingId === 'string' ? message.meetingId.trim() : '';
    const chunk = message.chunk;
    if (!meetingId || !chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return;
    const payload = chunk as Record<string, unknown>;
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : undefined;
    if (!text || text.length > MAX_TEXT_LENGTH) return;
    if (!this.session) {
      this.pendingChunks.push({ meetingId, text, ...(name ? { name } : {}) });
      this.pendingChunks = this.pendingChunks.slice(-256);
      void this.queueDetectedMeeting(meetingId);
      return;
    }
    void this.receiveChunk(meetingId, text, name);
  }

  private async queueDetectedMeeting(meetingId: string): Promise<void> {
    if (!(await this.isPreferred())) return;
    if (this.session) {
      if (!this.session.wisprMeetingId) await this.attachSession(meetingId, true);
      else if (this.session.wisprMeetingId === meetingId && !this.watcher) {
        await this.startWatcher(meetingId);
        await this.reconcileTranscriptFile(
          path.join(this.flowSupportDirectory, 'meetings', meetingId, 'live.ndjson'),
        );
      }
      return;
    }
    if (this.pendingWisprMeetingId === meetingId) return;
    this.pendingWisprMeetingId = meetingId;
    this.onDetected?.({ wisprMeetingId: meetingId });
  }

  async getStatus(): Promise<WisprConnectorStatus> {
    const supported = this.platform === 'darwin';
    const [preferred, connectorInstalled] = await Promise.all([
      this.isPreferred(),
      this.isConnectorInstalled(),
    ]);
    return {
      supported,
      wisprInstalled: supported && fs.existsSync(this.wisprApplicationPath),
      connectorInstalled,
      // Reading Wispr's local append-only meeting artifacts is the baseline
      // transport. The extension stream is only an optional latency boost;
      // Wispr can feature-gate that extension system independently.
      connected: supported
        && fs.existsSync(this.wisprApplicationPath)
        && fs.existsSync(this.flowSupportDirectory),
      extensionConnected: this.authenticatedClients > 0,
      preferred,
      restartRequired: this.restartRequired,
      ...(!supported ? { reason: 'The Wispr Flow connector is currently qualified on macOS only.' } : {}),
    };
  }

  async isPreferred(): Promise<boolean> {
    const value = await readJson(this.preferenceFile, {});
    return !!value && typeof value === 'object' && (value as Record<string, unknown>).provider === 'wispr-flow';
  }

  async setPreferred(preferred: boolean): Promise<void> {
    await atomicJson(this.preferenceFile, { provider: preferred ? 'wispr-flow' : 'automatic' });
  }

  private async isConnectorInstalled(): Promise<boolean> {
    if (!fs.existsSync(path.join(this.installedExtensionRoot, 'dist', 'index.js'))) return false;
    const customPaths = await readJson(this.customPathsFile, []);
    const enabled = await readJson(this.extensionsStateFile, {});
    return Array.isArray(customPaths)
      && customPaths.includes(this.integrationRoot)
      && !!enabled
      && typeof enabled === 'object'
      && (enabled as Record<string, unknown>)[EXTENSION_NAME] === true;
  }

  async install(): Promise<WisprConnectorStatus> {
    if (this.platform !== 'darwin') throw new Error('Wispr Flow local integration is currently available on macOS only');
    const source = path.join(this.extensionSourceRoot, 'extensions', EXTENSION_NAME);
    if (!fs.existsSync(path.join(source, 'dist', 'index.js'))) {
      throw new Error('The packaged Rowboat Wispr connector is missing');
    }
    await fsp.mkdir(path.dirname(this.installedExtensionRoot), { recursive: true, mode: 0o700 });
    await fsp.rm(this.installedExtensionRoot, { recursive: true, force: true });
    await fsp.cp(source, this.installedExtensionRoot, { recursive: true });

    const customRaw = await readJson(this.customPathsFile, []);
    const customPaths = Array.isArray(customRaw)
      ? customRaw.filter((item): item is string => typeof item === 'string')
      : [];
    if (!customPaths.includes(this.integrationRoot)) customPaths.push(this.integrationRoot);
    await atomicJson(this.customPathsFile, customPaths);

    const stateRaw = await readJson(this.extensionsStateFile, {});
    const state = stateRaw && typeof stateRaw === 'object' && !Array.isArray(stateRaw)
      ? { ...(stateRaw as Record<string, unknown>) }
      : {};
    state[EXTENSION_NAME] = true;
    await atomicJson(this.extensionsStateFile, state);
    await this.setPreferred(true);
    this.restartRequired = this.authenticatedClients === 0;
    return this.getStatus();
  }

  async begin(rowboatMeetingId: string): Promise<{
    wisprMeetingId?: string;
    segments: MeetingTranscriptSegment[];
  }> {
    if (!(await this.isPreferred())) throw new Error('Wispr Flow is not selected as the meeting source');
    if (!fs.existsSync(this.wisprApplicationPath)) throw new Error('Wispr Flow is not installed');
    await this.stopWatcher();
    this.session = {
      rowboatMeetingId: safeId(rowboatMeetingId),
      wisprMeetingId: null,
      startedAt: this.now(),
      sequence: 0,
      pending: [],
      endNotified: false,
      speakerEvidence: [],
      speakerMap: new Map(),
      speakerMapFingerprint: JSON.stringify([]),
      segmentByEntryId: new Map(),
    };
    const pendingMeetingId = this.pendingWisprMeetingId ?? await this.findActiveMeetingId();
    const pendingChunks = this.pendingChunks.filter((chunk) => !pendingMeetingId || chunk.meetingId === pendingMeetingId);
    this.pendingWisprMeetingId = null;
    this.pendingChunks = [];
    if (pendingMeetingId) {
      const initial: MeetingTranscriptSegment[] = [];
      this.session.wisprMeetingId = pendingMeetingId;
      await this.startWatcher(pendingMeetingId);
      for (const chunk of pendingChunks) {
        const provisional = await this.receiveChunk(chunk.meetingId, chunk.text, chunk.name, false);
        if (provisional) initial.push(provisional);
      }
      const live = path.join(this.flowSupportDirectory, 'meetings', pendingMeetingId, 'live.ndjson');
      initial.push(...await this.reconcileTranscriptFile(live, false));
      return { wisprMeetingId: pendingMeetingId, segments: initial };
    }
    return { segments: [] };
  }

  private async findActiveMeetingId(): Promise<string | null> {
    const databasePath = path.join(this.flowSupportDirectory, 'flow.sqlite');
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      database.exec('PRAGMA busy_timeout = 750');
      const rows = database.prepare(`
        SELECT id FROM Meetings
        WHERE isDeleted = 0 AND finalized = 0 AND endedAt IS NULL
        ORDER BY createdAt DESC LIMIT 8
      `).all() as Array<{ id?: unknown }>;
      for (const row of rows) {
        if (typeof row.id !== 'string' || !row.id) continue;
        const live = path.join(this.flowSupportDirectory, 'meetings', row.id, 'live.ndjson');
        try {
          const stat = await fsp.stat(live);
          if (this.now() - stat.mtimeMs <= ACTIVE_MEETING_MAX_AGE_MS) return row.id;
        } catch { /* candidate has no local transcript */ }
      }
    } catch { /* Wispr may not have created its database yet */ }
    finally { database?.close(); }
    return null;
  }

  private async attachSession(wisprMeetingId: string, emitInitial: boolean): Promise<MeetingTranscriptSegment[]> {
    const session = this.session;
    if (!session || (session.wisprMeetingId && session.wisprMeetingId !== wisprMeetingId)) return [];
    session.wisprMeetingId = wisprMeetingId;
    await this.startWatcher(wisprMeetingId);
    const live = path.join(this.flowSupportDirectory, 'meetings', wisprMeetingId, 'live.ndjson');
    return this.reconcileTranscriptFile(live, emitInitial);
  }

  private async receiveChunk(
    wisprMeetingId: string,
    text: string,
    name?: string,
    shouldEmit = true,
  ): Promise<MeetingTranscriptSegment | null> {
    const session = this.session;
    if (!session) return null;
    if (session.wisprMeetingId && session.wisprMeetingId !== wisprMeetingId) return null;
    const newlyAttached = !session.wisprMeetingId;
    if (!session.wisprMeetingId) {
      session.wisprMeetingId = wisprMeetingId;
      await this.startWatcher(wisprMeetingId);
    }

    const elapsedMs = Math.max(0, this.now() - session.startedAt);
    const words = Math.max(1, text.split(/\s+/).length);
    const segmentId = `${session.rowboatMeetingId}:wispr:pending:${session.sequence++}`;
    const speaker = name
      ? { kind: 'named' as const, id: `wispr-name:${safeId(name, 80)}`, displayName: name }
      : { kind: 'unknown' as const, displayName: 'Resolving speaker…' };
    const segment: MeetingTranscriptSegment = {
      meetingId: session.rowboatMeetingId,
      segmentId,
      revision: 0,
      epoch: 0,
      startSample: Math.round(elapsedMs * SAMPLE_RATE / 1000),
      endSample: Math.round((elapsedMs + Math.max(320, words * 260)) * SAMPLE_RATE / 1000),
      timingConfidence: 'low',
      channel: 'system',
      text,
      finality: 'final',
      clusterIds: [],
      overlap: false,
      speaker,
      attributionSource: 'wispr_extension_provisional',
      attributionConfidence: name ? 0.72 : 0,
      supersedes: [],
    };
    session.pending.push({ segmentId, textKey: textKey(text), emittedAt: this.now(), revision: 0 });
    session.pending = session.pending.filter((item) => this.now() - item.emittedAt < 60_000).slice(-256);
    if (shouldEmit) this.emit([segment]);
    if (newlyAttached) {
      await this.reconcileTranscriptFile(
        path.join(this.flowSupportDirectory, 'meetings', wisprMeetingId, 'live.ndjson'),
        shouldEmit,
      );
    }
    return segment;
  }

  private async startWatcher(wisprMeetingId: string): Promise<void> {
    await this.stopWatcher();
    await this.pollWisprMeetingState(wisprMeetingId, false);
    this.meetingStateTimer = setInterval(() => {
      if (this.meetingStatePollInFlight) return;
      this.meetingStatePollInFlight = true;
      void this.pollWisprMeetingState(wisprMeetingId)
        .finally(() => { this.meetingStatePollInFlight = false; });
    }, MEETING_STATE_POLL_INTERVAL_MS);
    this.meetingStateTimer.unref();
    const meetingDirectory = path.join(this.flowSupportDirectory, 'meetings', wisprMeetingId);
    // Chokidar climbs parent directories when asked to watch a missing file.
    // That is both noisy and unsafe here: the optional fast event can arrive
    // just before Wispr creates its meeting directory. Wait for the global
    // meetings watcher in that case, and otherwise watch only this one folder.
    if (!fs.existsSync(meetingDirectory)) return;
    const watcher = watch(meetingDirectory, {
      // Current contents are reconciled explicitly by the caller so initial
      // delivery cannot race the IPC response that creates Rowboat's note.
      ignoreInitial: true,
      depth: 0,
      // Wispr creates live/refined files during the session. Polling this one
      // tiny active directory avoids macOS fs.watch descriptor failures when
      // a new file appears, and also gives us a deterministic missed-event
      // recovery path at negligible cost (four stats/second).
      usePolling: true,
      interval: 250,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    this.watcher = watcher;
    const reconcile = async (file: string) => {
      const basename = path.basename(file);
      if (basename === 'live.ndjson' || basename === 'refined.ndjson') {
        await this.reconcileTranscriptFile(file);
        if (basename === 'refined.ndjson') this.notifyEnded(wisprMeetingId);
      }
    };
    watcher.on('add', (file) => { void reconcile(file); });
    watcher.on('change', (file) => { void reconcile(file); });
    // Do not return the IPC begin response until the watcher has completed its
    // initial scan. Otherwise a very short meeting can create refined.ndjson
    // inside the ignoreInitial window and Rowboat would miss the end signal.
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        watcher.off('error', onError);
        resolve();
      };
      const onError = (error: unknown) => {
        watcher.off('ready', onReady);
        reject(error);
      };
      watcher.once('ready', onReady);
      watcher.once('error', onError);
    });
    watcher.on('error', (error) => {
      console.warn('[WisprNotetaker] local meeting watcher error:', error instanceof Error ? error.message : String(error));
    });
  }

  private notifyEnded(wisprMeetingId: string): void {
    const session = this.session;
    if (!session || session.wisprMeetingId !== wisprMeetingId || session.endNotified) return;
    session.endNotified = true;
    this.onEnded?.({
      rowboatMeetingId: session.rowboatMeetingId,
      wisprMeetingId,
    });
  }

  /**
   * The native Zoom adapter may positively observe that the meeting surface
   * ended before Wispr finishes its own refinement pipeline. This closes
   * Rowboat immediately without writing to or controlling Wispr's private
   * state.
   */
  notifyExternalMeetingEnded(rowboatMeetingId: string): void {
    const session = this.session;
    if (!session || session.rowboatMeetingId !== safeId(rowboatMeetingId) || !session.wisprMeetingId) return;
    this.notifyEnded(session.wisprMeetingId);
  }

  setEvidenceClockOrigin(rowboatMeetingId: string, startedAtEpochMs: number): void {
    const session = this.session;
    if (!session || session.rowboatMeetingId !== safeId(rowboatMeetingId) || !Number.isFinite(startedAtEpochMs)) return;
    session.evidenceClockStartedAt = startedAtEpochMs;
  }

  applySpeakerEvidence(
    rowboatMeetingId: string,
    evidence: readonly MeetingSpeakerEvidence[],
  ): { segments: MeetingTranscriptSegment[] } {
    const session = this.session;
    if (!session || session.rowboatMeetingId !== safeId(rowboatMeetingId)) return { segments: [] };
    session.speakerEvidence.push(...evidence.filter((item) => (
      Number.isFinite(item.startSample) && Number.isFinite(item.endSample) && item.endSample >= item.startSample
    )));
    session.speakerEvidence = session.speakerEvidence.slice(-MAX_RETAINED_SPEAKER_EVIDENCE);
    const updates: MeetingTranscriptSegment[] = [];
    for (const tracked of session.segmentByEntryId.values()) {
      if (!tracked.segment) continue;
      const revised = this.resolveNativeSpeakerEvidence(session, tracked.segment);
      if (!revised) continue;
      tracked.segment = revised;
      tracked.revision = revised.revision;
      updates.push(revised);
    }
    if (updates.length > 0) this.emit(updates);
    return { segments: updates };
  }

  private translatedSpeakerEvidence(session: ActiveSession): MeetingSpeakerEvidence[] {
    if (session.recordingEpochMs === undefined || session.evidenceClockStartedAt === undefined) return [];
    const offsetSamples = Math.round(
      (session.evidenceClockStartedAt - session.recordingEpochMs) * SAMPLE_RATE / 1000,
    );
    return session.speakerEvidence.map((item) => ({
      ...item,
      startSample: item.startSample + offsetSamples,
      endSample: item.endSample + offsetSamples,
    }));
  }

  private resolveNativeSpeakerEvidence(
    session: ActiveSession,
    segment: MeetingTranscriptSegment,
  ): MeetingTranscriptSegment | null {
    if (segment.channel !== 'system') return null;
    if (
      segment.attributionSource === 'wispr_direct_name'
      || segment.attributionSource.startsWith('wispr_speaker_map:')
      || segment.attributionSource === 'wispr_refined_name'
    ) return null;
    const evidence = this.translatedSpeakerEvidence(session).filter((item) => (
      item.endSample > segment.startSample && item.startSample < segment.endSample
    ));
    if (evidence.length === 0) return null;
    return resolveMeetingSpeakerUpsert(segment, { evidence });
  }

  private async pollWisprMeetingState(wisprMeetingId: string, shouldEmit = true): Promise<void> {
    const session = this.session;
    if (!session || session.wisprMeetingId !== wisprMeetingId) return;
    const databasePath = path.join(this.flowSupportDirectory, 'flow.sqlite');
    if (!fs.existsSync(databasePath)) return;
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      // This runs on Electron main. Keep a transient Wispr writer lock below
      // one animation frame budget rather than pausing Rowboat's UI.
      database.exec('PRAGMA busy_timeout = 16');
      const row = database.prepare(`
        SELECT finalized, endedAt, speakerMap
        FROM Meetings WHERE id = ? LIMIT 1
      `)
        .get(wisprMeetingId) as Record<string, unknown> | undefined;
      if (!row) return;

      const nextSpeakerMap = parseWisprSpeakerMap(row.speakerMap);
      const nextFingerprint = JSON.stringify([...nextSpeakerMap.entries()]);
      if (nextFingerprint !== session.speakerMapFingerprint) {
        session.speakerMap = nextSpeakerMap;
        session.speakerMapFingerprint = nextFingerprint;
        const meetingDirectory = path.join(this.flowSupportDirectory, 'meetings', wisprMeetingId);
        await this.reconcileTranscriptFile(path.join(meetingDirectory, 'live.ndjson'), shouldEmit);
        await this.reconcileTranscriptFile(path.join(meetingDirectory, 'refined.ndjson'), shouldEmit);
      }

      const finalized = row.finalized === 1 || row.finalized === true;
      const ended = typeof row.endedAt === 'string' || typeof row.endedAt === 'number';
      if (finalized || ended) {
        const meetingDirectory = path.join(this.flowSupportDirectory, 'meetings', wisprMeetingId);
        await this.reconcileTranscriptFile(path.join(meetingDirectory, 'refined.ndjson'), shouldEmit);
        await this.reconcileTranscriptFile(path.join(meetingDirectory, 'live.ndjson'), shouldEmit);
        this.notifyEnded(wisprMeetingId);
      }
    } catch {
      // Wispr may hold a short SQLite write lock. The next bounded poll
      // retries; a transient local database failure never stops recording.
    } finally {
      database?.close();
    }
  }

  private async stopWatcher(): Promise<void> {
    if (this.meetingStateTimer) clearInterval(this.meetingStateTimer);
    this.meetingStateTimer = null;
    this.meetingStatePollInFlight = false;
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.close();
  }

  private async reconcileTranscriptFile(file: string, shouldEmit = true): Promise<MeetingTranscriptSegment[]> {
    const session = this.session;
    if (!session?.wisprMeetingId || !file.includes(session.wisprMeetingId)) return [];
    let contents: string;
    try { contents = await fsp.readFile(file, 'utf8'); } catch { return []; }
    const incoming: MeetingTranscriptSegment[] = [];
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { continue; }
      const entry = parseWisprTranscriptEntry(raw);
      if (!entry) continue;
      const segment = this.segmentFromEntry(session, entry, path.basename(file) === 'refined.ndjson');
      if (segment) incoming.push(segment);
    }
    if (shouldEmit && incoming.length > 0) this.emit(incoming);
    return incoming;
  }

  private segmentFromEntry(
    session: ActiveSession,
    entry: WisprTranscriptEntry,
    refined: boolean,
  ): MeetingTranscriptSegment | null {
    if (entry.startEpochMs !== undefined && entry.startRecordingMs !== undefined) {
      const recordingEpochMs = entry.startEpochMs - entry.startRecordingMs;
      if (Number.isFinite(recordingEpochMs)) session.recordingEpochMs = recordingEpochMs;
    }
    const mappedSpeaker = entry.speaker.id ? session.speakerMap.get(entry.speaker.id) : undefined;
    const resolvedName = entry.speaker.name ?? mappedSpeaker?.name;
    const fingerprint = JSON.stringify({
      text: entry.text,
      source: entry.speaker.source,
      speakerId: entry.speaker.id ?? null,
      speakerName: resolvedName ?? null,
      speakerMapOrigin: mappedSpeaker?.origin ?? null,
      start: entry.startRecordingMs ?? null,
      end: entry.endRecordingMs ?? null,
      refined,
    });
    let existing = session.segmentByEntryId.get(entry.id);
    if (!existing) {
      const pendingIndex = session.pending.findIndex((item) => item.textKey === textKey(entry.text));
      const pending = pendingIndex >= 0 ? session.pending.splice(pendingIndex, 1)[0] : undefined;
      existing = {
        segmentId: pending?.segmentId ?? `${session.rowboatMeetingId}:wispr:${safeId(entry.id, 100)}`,
        revision: pending ? pending.revision + 1 : 0,
        channel: entry.speaker.source === 'mic' ? 'mic' : 'system',
        fingerprint,
      };
      session.segmentByEntryId.set(entry.id, existing);
    } else {
      if (existing.fingerprint === fingerprint) return null;
      existing.revision++;
      existing.fingerprint = fingerprint;
      if (entry.speaker.source === 'mic') existing.channel = 'mic';
    }

    const fallbackMs = Math.max(0, (entry.timestamp ?? this.now()) - session.startedAt);
    const startMs = Math.max(0, entry.startRecordingMs ?? fallbackMs);
    const endMs = Math.max(startMs, entry.endRecordingMs ?? startMs);
    const channel = existing.channel;
    const speaker = channel === 'mic'
      ? { kind: 'self' as const, id: 'self', displayName: 'You' }
      : resolvedName
        ? {
            kind: 'named' as const,
            id: mappedSpeaker?.personId ?? entry.speaker.id ?? `wispr-name:${safeId(resolvedName, 80)}`,
            displayName: resolvedName,
          }
        : entry.speaker.id
          ? { kind: 'cluster' as const, id: entry.speaker.id, displayName: `Speaker ${entry.speaker.id}` }
          : { kind: 'unknown' as const, displayName: 'Unknown speaker' };
    const confidence = channel === 'mic' ? 1 : entry.speaker.name ? 0.96 : mappedSpeaker ? 0.9 : entry.speaker.id ? 0.7 : 0;
    let segment: MeetingTranscriptSegment = {
      meetingId: session.rowboatMeetingId,
      segmentId: existing.segmentId,
      revision: existing.revision,
      epoch: 0,
      startSample: Math.round(startMs * SAMPLE_RATE / 1000),
      endSample: Math.round(endMs * SAMPLE_RATE / 1000),
      timingConfidence: entry.startRecordingMs !== undefined ? 'high' : 'medium',
      timingSource: entry.startRecordingMs !== undefined ? 'model-token' : undefined,
      channel,
      text: entry.text,
      finality: 'final',
      clusterIds: entry.speaker.id ? [entry.speaker.id] : [],
      overlap: false,
      speaker,
      attributionSource: refined
        ? resolvedName ? 'wispr_refined_name' : 'wispr_refined'
        : channel === 'mic'
          ? 'wispr_mic_source'
          : entry.speaker.name
            ? 'wispr_direct_name'
            : mappedSpeaker
              ? `wispr_speaker_map:${mappedSpeaker.origin}`
              : entry.speaker.id ? 'wispr_cluster' : 'wispr_unresolved',
      attributionConfidence: confidence,
      supersedes: [],
    };
    const nativeResolution = this.resolveNativeSpeakerEvidence(session, segment);
    if (nativeResolution) segment = nativeResolution;
    existing.revision = segment.revision;
    existing.segment = segment;
    return segment;
  }

  private emit(segments: MeetingTranscriptSegment[]): void {
    const session = this.session;
    if (!session?.wisprMeetingId || segments.length === 0) return;
    this.onEvent({
      type: 'transcript',
      rowboatMeetingId: session.rowboatMeetingId,
      wisprMeetingId: session.wisprMeetingId,
      segments,
    });
  }

  async finalize(rowboatMeetingId: string): Promise<{ segments: MeetingTranscriptSegment[]; artifact?: WisprMeetingArtifact }> {
    const session = this.session;
    if (!session || session.rowboatMeetingId !== safeId(rowboatMeetingId)) return { segments: [] };
    const segments: MeetingTranscriptSegment[] = [];
    if (session.wisprMeetingId) {
      const meetingDirectory = path.join(this.flowSupportDirectory, 'meetings', session.wisprMeetingId);
      const refined = await this.reconcileTranscriptFile(path.join(meetingDirectory, 'refined.ndjson'));
      if (refined.length > 0) segments.push(...refined);
      else segments.push(...await this.reconcileTranscriptFile(path.join(meetingDirectory, 'live.ndjson')));
    }
    const artifact = session.wisprMeetingId ? this.readArtifact(session.wisprMeetingId) : undefined;
    await this.stopWatcher();
    this.session = null;
    return { segments, ...(artifact ? { artifact } : {}) };
  }

  private readArtifact(meetingId: string): WisprMeetingArtifact | undefined {
    const databasePath = path.join(this.flowSupportDirectory, 'flow.sqlite');
    if (!fs.existsSync(databasePath)) return undefined;
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      database.exec('PRAGMA busy_timeout = 750');
      const row = database.prepare(`
        SELECT id, title, notes, summary, participantNames, finalized, endedAt
        FROM Meetings WHERE id = ? LIMIT 1
      `).get(meetingId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        meetingId,
        ...(typeof row.title === 'string' && row.title.trim() ? { title: row.title.trim() } : {}),
        ...(normalizeWisprRichText(row.notes) ? { notes: normalizeWisprRichText(row.notes) } : {}),
        ...(normalizeWisprRichText(row.summary) ? { summary: normalizeWisprRichText(row.summary) } : {}),
        participantNames: jsonArray(row.participantNames),
        finalized: row.finalized === 1 || row.finalized === true,
        ...((typeof row.endedAt === 'string' || typeof row.endedAt === 'number') ? { endedAt: row.endedAt } : {}),
      };
    } catch {
      return undefined;
    } finally {
      database?.close();
    }
  }

  async reset(rowboatMeetingId?: string): Promise<void> {
    if (rowboatMeetingId && this.session?.rowboatMeetingId !== safeId(rowboatMeetingId)) return;
    await this.stopWatcher();
    this.session = null;
    this.pendingWisprMeetingId = null;
    this.pendingChunks = [];
  }

  async dispose(): Promise<void> {
    await this.reset();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.authenticatedClients = 0;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const detectionWatcher = this.detectionWatcher;
    this.detectionWatcher = null;
    if (detectionWatcher) await detectionWatcher.close();
    for (const file of [this.runtimeFile, this.socketPath]) {
      try { await fsp.unlink(file); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
