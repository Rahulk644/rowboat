import { z } from 'zod';

export type MeetingAudioChannel = 'mic' | 'system';

export type MeetingTranscriptionSnapshot = {
  session: string;
  full: string;
  committed: string;
  tentative: string;
  changed: boolean;
  final: boolean;
  revision: number;
  inputMs: number;
  bufferedMs: number;
};

type SelfHostedConfig = {
  baseUrl: URL;
  token: string;
};

type ActiveMeeting = {
  sessions: Record<MeetingAudioChannel, string>;
  language: string;
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

const MAX_PCM_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
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

function safeMeetingId(meetingId: string): string {
  const normalized = meetingId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  if (!normalized) throw new Error('A meeting id is required');
  return normalized;
}

export class SelfHostedMeetingTranscription {
  private readonly active = new Map<string, ActiveMeeting>();
  private computeTail: Promise<void> = Promise.resolve();

  getStatus(): { provider: 'deepgram' | 'self-hosted-nemotron'; configured: boolean; reason?: string } {
    try {
      const configured = loadSelfHostedMeetingConfig() !== null;
      return {
        provider: configured ? 'self-hosted-nemotron' : 'deepgram',
        configured,
      };
    } catch (error) {
      return {
        provider: 'deepgram',
        configured: false,
        reason: error instanceof Error ? error.message : 'Invalid self-hosted transcription configuration',
      };
    }
  }

  async begin(meetingId: string, language: string): Promise<void> {
    const config = this.requireConfig();
    const id = safeMeetingId(meetingId);
    if (this.active.has(id)) throw new Error('Meeting transcription session already exists');

    const sessions = {
      mic: `${id}.mic`,
      system: `${id}.system`,
    } satisfies Record<MeetingAudioChannel, string>;

    const normalizedLanguage = /^[a-z]{2}(?:-[A-Z]{2})?$/.test(language) ? language : 'en';
    try {
      await this.beginSessions(config, sessions, normalizedLanguage);
      this.active.set(id, { sessions, language: normalizedLanguage });
    } catch (error) {
      await this.bestEffortReset(config, sessions.mic);
      await this.bestEffortReset(config, sessions.system);
      throw error;
    }
  }

  async feed(meetingId: string, channel: MeetingAudioChannel, pcmBase64: string): Promise<MeetingTranscriptionSnapshot> {
    const config = this.requireConfig();
    const active = this.requireActive(meetingId);
    const pcm = Buffer.from(pcmBase64, 'base64');
    if (pcm.length === 0 || pcm.length > MAX_PCM_BYTES || pcm.length % 2 !== 0) {
      throw new Error('Meeting audio must be non-empty little-endian signed-16 PCM within 64 KiB');
    }
    return this.serialized(async () => {
      const result = await this.request(config, '/stream/feed', active.sessions[channel], pcm);
      return SnapshotSchema.parse(result);
    });
  }

  async finalize(meetingId: string): Promise<Record<MeetingAudioChannel, MeetingTranscriptionSnapshot>> {
    const config = this.requireConfig();
    const id = safeMeetingId(meetingId);
    const active = this.requireActive(id);
    try {
      const mic = await this.serialized(async () => SnapshotSchema.parse(
        await this.request(config, '/stream/finalize', active.sessions.mic),
      ));
      const system = await this.serialized(async () => SnapshotSchema.parse(
        await this.request(config, '/stream/finalize', active.sessions.system),
      ));
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
    await this.beginSessions(config, active.sessions, active.language);
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

  private async beginSessions(
    config: SelfHostedConfig,
    sessions: Record<MeetingAudioChannel, string>,
    language: string,
  ): Promise<void> {
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

  private async request(
    config: SelfHostedConfig,
    path: string,
    session: string,
    body?: Buffer,
    language?: string,
  ): Promise<unknown> {
    // Assign pathname directly. Constructing a relative URL from strings can
    // turn a leading `//` into a scheme-relative host and bypass the loopback
    // boundary when the configured base path is `/`.
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
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/octet-stream',
        },
        body: requestBody,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error(`Transcription worker returned invalid JSON (${response.status})`);
        }
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
