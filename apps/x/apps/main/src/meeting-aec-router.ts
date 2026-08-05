import type {
  BridgeAecInputFrame,
  BridgeAecResult,
} from './meeting-bridge.js';
import type { MeetingAudioFeedMetadata } from './meeting-transcription.js';

/** The renderer's self-hosted capture contract: 16 kHz signed-16 mono PCM. */
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const MAX_BATCH_BYTES = 64 * 1024;
// A native reblocker is allowed a few 20 ms frames of latency. If it stops
// returning output beyond this, raw is safer than keeping speech in memory.
const MAX_PENDING_BATCHES = 4;
// A fail-open call may release all four helper-held batches plus the current
// raw input. Keep exactly that bounded recovery burst so it can drain without
// manufacturing an avoidable renderer retry.
const MAX_PENDING_ASR_BATCHES = MAX_PENDING_BATCHES + 1;

export type AecBridgeTransport = {
  processAecFrame(
    meetingId: string,
    mic: BridgeAecInputFrame,
    render: BridgeAecInputFrame,
  ): Promise<BridgeAecResult | null>;
  flushAec(meetingId: string): Promise<BridgeAecResult | null>;
  updateAecOutputRoute(meetingId: string, outputRouteIsolated: boolean): Promise<BridgeAecResult | null>;
};

export type AecMicBatch = {
  pcmBase64: string;
  metadata: MeetingAudioFeedMetadata;
};

export type AecPairRouteResult = {
  /** Ordered 560 ms (or final-tail) microphone batches ready for ASR. */
  mic: AecMicBatch[];
  /** True only if the native helper accepted this pair. */
  active: boolean;
  /** A helper loss caused retained input to be returned to raw ASR. */
  failedOpen: boolean;
};

type PendingBatch = {
  metadata: Required<Pick<MeetingAudioFeedMetadata, 'sourceId' | 'startSample' | 'sampleCount' | 'sampleRate' | 'sequence' | 'flags'>>;
  original: Buffer;
  pieces: Array<Buffer | null>;
  bridgeEpoch: number;
};

/**
 * Electron-main-only bounded AEC transport shim.
 *
 * It keeps a maximum of four in-flight mic batches only until every original
 * 20 ms portion has either come back from the helper or been deliberately
 * released raw. It never logs or stores PCM. The coordinator may return zero,
 * one, or several delayed frames, so output is matched by immutable sample
 * position—not delivery order or the current renderer invocation.
 */
export class MeetingAecRouter {
  private readonly pending: PendingBatch[] = [];
  private unavailable = false;
  private bridgeEpoch = 0;
  private lastDiscontinuityStartSample: number | null = null;
  // Start carries the first route to the helper. Further renderer devicechange
  // calls only need this explicit transition when the boolean actually moves.
  private outputRouteIsolated: boolean | null = null;

  async processPair(
    transport: AecBridgeTransport | null,
    meetingId: string,
    micBase64: string,
    systemBase64: string,
    micMetadata?: MeetingAudioFeedMetadata,
    systemMetadata?: MeetingAudioFeedMetadata,
  ): Promise<AecPairRouteResult> {
    const parsed = parsePair(meetingId, micBase64, systemBase64, micMetadata, systemMetadata);
    if (!parsed) return { mic: [rawBatch(micBase64, micMetadata)], active: false, failedOpen: false };

    // A single source may restart while the paired capture clock continues.
    // That is an ASR discontinuity only for that source, but it is a native
    // AEC epoch boundary for *both* frames: retaining an old render reference
    // across a system or mic recovery risks cancelling fresh speech. Drain the
    // reblocker first so its old tail is emitted exactly once, then mark both
    // helper inputs with the shared boundary below. The original per-channel
    // metadata is never rewritten, so only the affected ASR channel carries
    // the user-visible discontinuity/recovered flags.
    let prior: AecMicBatch[] = [];
    if (parsed.aecBoundary) {
      prior = await this.flush(transport, meetingId);
    }

    if (!transport || this.unavailable) {
      return { mic: [...prior, rawBatch(micBase64, micMetadata)], active: false, failedOpen: false };
    }

    if (this.pending.length >= MAX_PENDING_BATCHES) {
      const mic = this.failOpen();
      return { mic: [...prior, ...mic, rawBatch(micBase64, micMetadata)], active: false, failedOpen: true };
    }

    const epoch = this.epochFor(parsed.micMetadata.startSample, parsed.aecBoundary);
    const pending = this.enqueue(parsed.micBytes, parsed.micMetadata, epoch);
    try {
      for (let offset = 0; offset < parsed.micBytes.length; offset += FRAME_BYTES) {
        // A final partial (less than 20 ms) tail cannot enter a 20 ms native
        // canceller. It is inserted raw immediately and is still ordered with
        // all preceding helper output.
        if (offset + FRAME_BYTES > parsed.micBytes.length) {
          this.resolveRawRange(pending, offset, parsed.micBytes.length - offset);
          continue;
        }
        const result = await transport.processAecFrame(
          meetingId,
          frameFor(parsed.micBytes, parsed.micMetadata, 'mic', offset, epoch, parsed.aecBoundary, parsed.aecRecovered),
          frameFor(parsed.systemBytes, parsed.systemMetadata, 'system', offset, epoch, parsed.aecBoundary, parsed.aecRecovered),
        );
        if (!result) {
          const mic = this.failOpen();
          return { mic: [...prior, ...mic], active: false, failedOpen: true };
        }
        this.acceptResult(meetingId, result);
      }
    } catch {
      const mic = this.failOpen();
      return { mic: [...prior, ...mic], active: false, failedOpen: true };
    }

    return { mic: [...prior, ...this.releaseReady()], active: true, failedOpen: false };
  }

  /**
   * Finalize/restart boundary: ask the helper to flush its bounded tail, then
   * release every still-unacknowledged original sample raw. No tail may vanish
   * merely because the LocalVQE reblocker lacks a full native hop.
   */
  async flush(transport: AecBridgeTransport | null, meetingId: string): Promise<AecMicBatch[]> {
    if (transport && !this.unavailable) {
      try {
        const result = await transport.flushAec(meetingId);
        if (result) this.acceptResult(meetingId, result);
      } catch {
        // The raw drain directly below is the fail-open response.
      }
    }
    this.forceRawUnresolved();
    return this.releaseReady();
  }

  /**
   * Applies an output-device change without rebuilding the router's sample
   * epoch. The helper raw-releases any reblocker holdback first; accepting that
   * result here preserves strict ASR ordering. If the command is unavailable
   * or malformed, every retained microphone batch is immediately raw-released.
   */
  async updateOutputRoute(
    transport: AecBridgeTransport | null,
    meetingId: string,
    outputRouteIsolated: boolean,
  ): Promise<AecMicBatch[]> {
    if (this.outputRouteIsolated === outputRouteIsolated) return [];
    this.outputRouteIsolated = outputRouteIsolated;
    if (!transport || this.unavailable) return this.failOpen();
    try {
      const result = await transport.updateAecOutputRoute(meetingId, outputRouteIsolated);
      if (!result) return this.failOpen();
      this.acceptResult(meetingId, result);
      return this.releaseReady();
    } catch {
      return this.failOpen();
    }
  }

  /** A new meeting has a fresh sample origin. Discard no audio: raw-release first. */
  reset(): AecMicBatch[] {
    this.unavailable = false;
    this.bridgeEpoch = 0;
    this.lastDiscontinuityStartSample = null;
    this.outputRouteIsolated = null;
    this.forceRawUnresolved();
    return this.releaseReady();
  }

  private enqueue(original: Buffer, metadata: NormalizedMetadata, bridgeEpoch: number): PendingBatch {
    const pieces = Array<Buffer | null>(Math.ceil(original.length / FRAME_BYTES)).fill(null);
    const batch: PendingBatch = { metadata, original, pieces, bridgeEpoch };
    this.pending.push(batch);
    return batch;
  }

  private acceptResult(meetingId: string, result: BridgeAecResult): void {
    if (result.meetingId !== meetingId) throw new Error('AEC helper returned a result for another meeting');
    for (const frame of result.frames) {
      if (frame.channel !== 'mic') throw new Error('AEC helper returned a non-microphone frame');
      const bytes = strictBase64(frame.pcmBase64);
      if (bytes.length !== FRAME_BYTES || frame.sampleRate !== SAMPLE_RATE) {
        throw new Error('AEC helper returned an invalid PCM frame');
      }
      const target = this.pending.find((batch) => (
        batch.metadata.startSample <= frame.startSample
        && frame.startSample + FRAME_SAMPLES <= batch.metadata.startSample + batch.metadata.sampleCount
        && batch.metadata.sourceId === frame.sourceId
        && batch.bridgeEpoch === frame.epoch
      ));
      if (!target) throw new Error('AEC helper returned an unrecognized microphone frame');
      const offsetSamples = frame.startSample - target.metadata.startSample;
      if (offsetSamples % FRAME_SAMPLES !== 0) throw new Error('AEC helper returned an unaligned microphone frame');
      const pieceIndex = offsetSamples / FRAME_SAMPLES;
      if (target.pieces[pieceIndex] !== null) throw new Error('AEC helper returned a duplicate microphone frame');
      target.pieces[pieceIndex] = bytes;
    }
  }

  private epochFor(startSample: number, aecBoundary: boolean): number {
    if (!aecBoundary) return this.bridgeEpoch;
    if (this.lastDiscontinuityStartSample !== startSample) {
      this.bridgeEpoch += 1;
      this.lastDiscontinuityStartSample = startSample;
    }
    return this.bridgeEpoch;
  }

  private resolveRawRange(batch: PendingBatch, offset: number, byteLength: number): void {
    const pieceIndex = Math.floor(offset / FRAME_BYTES);
    if (byteLength !== FRAME_BYTES || pieceIndex >= batch.pieces.length) {
      // A partial final tail shares a piece only with itself because every
      // preceding portion is exactly 640 bytes.
      batch.pieces[pieceIndex] = Buffer.from(batch.original.subarray(offset, offset + byteLength));
      return;
    }
    if (batch.pieces[pieceIndex] === null) {
      batch.pieces[pieceIndex] = Buffer.from(batch.original.subarray(offset, offset + byteLength));
    }
  }

  private forceRawUnresolved(): void {
    for (const batch of this.pending) {
      for (let index = 0; index < batch.pieces.length; index++) {
        if (batch.pieces[index] !== null) continue;
        const start = index * FRAME_BYTES;
        batch.pieces[index] = Buffer.from(batch.original.subarray(start, Math.min(start + FRAME_BYTES, batch.original.length)));
      }
    }
  }

  private failOpen(): AecMicBatch[] {
    this.unavailable = true;
    this.forceRawUnresolved();
    return this.releaseReady();
  }

  private releaseReady(): AecMicBatch[] {
    const released: AecMicBatch[] = [];
    while (this.pending[0]?.pieces.every((piece) => piece !== null)) {
      const batch = this.pending.shift()!;
      released.push({
        pcmBase64: Buffer.concat(batch.pieces as Buffer[]).toString('base64'),
        metadata: { ...batch.metadata },
      });
    }
    return released;
  }
}

/**
 * Holds completed AEC batches only until their named mic ASR session confirms
 * them. This closes the subtle partial-failure hole: if a result releases an
 * earlier batch and ASR accepts it before a later batch fails, a renderer IPC
 * retry drains only the retained suffix and never re-runs AEC/replays the
 * accepted prefix. PCM is bounded to the helper's four retained 560 ms
 * batches plus the current fail-open input, and remains in RAM.
 */
export class AecAsrDeliveryQueue<TSnapshot> {
  private readonly pending: AecMicBatch[] = [];
  private retryInputKey: string | null = null;
  // Electron IPC handlers are concurrent. Every caller deliberately wraps
  // its mutable MeetingAecRouter operation in getBatches(), so serializing the
  // complete accept transaction protects both the router and this delivery
  // queue. Without this tail, two accepts can both deliver pending[0] and then
  // shift different batches, duplicating PCM and corrupting ordering.
  private operationTail: Promise<void> = Promise.resolve();

  accept(
    inputKey: string,
    getBatches: () => Promise<readonly AecMicBatch[]>,
    deliver: (batch: AecMicBatch) => Promise<TSnapshot>,
  ): Promise<TSnapshot[]> {
    const operation = this.operationTail.then(() => this.acceptExclusive(inputKey, getBatches, deliver));
    // A rejected ASR delivery must not poison the per-meeting lock. The
    // caller still receives that rejection while the next retry can enter.
    this.operationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async acceptExclusive(
    inputKey: string,
    getBatches: () => Promise<readonly AecMicBatch[]>,
    deliver: (batch: AecMicBatch) => Promise<TSnapshot>,
  ): Promise<TSnapshot[]> {
    if (this.retryInputKey !== null) {
      if (this.retryInputKey === inputKey) {
        const snapshots = await this.drain(deliver);
        this.retryInputKey = null;
        return snapshots;
      }
      // Only the renderer retry carrying the exact capture identity may drain
      // a failed delivery. A concurrent route update/flush must not commit it
      // into the old worker before restartChannel resets that worker.
      throw new Error('AEC-to-ASR delivery retry is pending for another input');
    }

    // An older reblocked batch may be waiting on ASR while capture continues.
    // Drain it first, but do not mark the *new* raw input as routed unless the
    // private helper has actually accepted it.
    const snapshots = await this.drain(deliver);
    const batches = await getBatches();
    if (this.pending.length + batches.length > MAX_PENDING_ASR_BATCHES) {
      // Retain all audio. The caller's normal bounded retry will revisit this
      // exact input key and drain the queue rather than duplicate it.
      this.pending.push(...batches);
      this.retryInputKey = inputKey;
      throw new Error('AEC-to-ASR delivery backlog is full');
    }
    this.pending.push(...batches);
    this.retryInputKey = inputKey;
    snapshots.push(...await this.drain(deliver));
    this.retryInputKey = null;
    return snapshots;
  }

  get pendingBatches(): number {
    return this.pending.length;
  }

  private async drain(deliver: (batch: AecMicBatch) => Promise<TSnapshot>): Promise<TSnapshot[]> {
    const snapshots: TSnapshot[] = [];
    while (this.pending[0]) {
      const batch = this.pending[0];
      const snapshot = await deliver(batch);
      this.pending.shift();
      snapshots.push(snapshot);
    }
    return snapshots;
  }
}

type NormalizedMetadata = Required<Pick<MeetingAudioFeedMetadata, 'sourceId' | 'startSample' | 'sampleCount' | 'sampleRate' | 'sequence' | 'flags'>>;

function parsePair(
  meetingId: string,
  micBase64: string,
  systemBase64: string,
  micMetadata?: MeetingAudioFeedMetadata,
  systemMetadata?: MeetingAudioFeedMetadata,
): { micBytes: Buffer; systemBytes: Buffer; micMetadata: NormalizedMetadata; systemMetadata: NormalizedMetadata; aecBoundary: boolean; aecRecovered: boolean } | null {
  const micBytes = safelyDecode(micBase64);
  const systemBytes = safelyDecode(systemBase64);
  if (!micBytes || !systemBytes || micBytes.length !== systemBytes.length || micBytes.length === 0 || micBytes.length > MAX_BATCH_BYTES || micBytes.length % 2 !== 0) {
    return null;
  }
  const sampleCount = micBytes.length / 2;
  const mic = normalizeMetadata(meetingId, 'mic', micMetadata, sampleCount);
  const system = normalizeMetadata(meetingId, 'system', systemMetadata, sampleCount);
  if (!mic || !system || mic.sampleCount !== sampleCount || system.sampleCount !== sampleCount || mic.sampleRate !== SAMPLE_RATE || system.sampleRate !== SAMPLE_RATE) {
    return null;
  }
  // AEC is permitted only when the paired render and mic batches share an
  // explicit clock position. Independent session sequence counters remain
  // untouched; they are used again only when completed mic audio reaches ASR.
  if (mic.startSample !== system.startSample) return null;
  return {
    micBytes,
    systemBytes,
    micMetadata: mic,
    systemMetadata: system,
    aecBoundary: mic.flags.includes('discontinuity') || system.flags.includes('discontinuity'),
    aecRecovered: mic.flags.includes('recovered') || system.flags.includes('recovered'),
  };
}

function normalizeMetadata(
  meetingId: string,
  channel: 'mic' | 'system',
  input: MeetingAudioFeedMetadata | undefined,
  sampleCount: number,
): NormalizedMetadata | null {
  if (!input || input.startSample === undefined || input.sampleCount === undefined || input.sampleRate === undefined || input.sequence === undefined) return null;
  const flags = [...new Set(input.flags ?? [])];
  const values = [input.startSample, input.sampleCount, input.sampleRate, input.sequence];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0) || input.sampleCount <= 0 || input.sampleCount !== sampleCount) return null;
  if (flags.some((flag) => flag !== 'discontinuity' && flag !== 'recovered' && flag !== 'silence')) return null;
  return {
    sourceId: input.sourceId ?? `${meetingId}.${channel}`,
    startSample: input.startSample,
    sampleCount: input.sampleCount,
    sampleRate: input.sampleRate,
    sequence: input.sequence,
    flags,
  };
}

function frameFor(
  bytes: Buffer,
  metadata: NormalizedMetadata,
  channel: 'mic' | 'system',
  offset: number,
  epoch: number,
  aecBoundary: boolean,
  aecRecovered: boolean,
): BridgeAecInputFrame {
  const offsetSamples = offset / 2;
  return {
    sourceId: metadata.sourceId,
    channel,
    startSample: metadata.startSample + offsetSamples,
    sampleRate: SAMPLE_RATE,
    // Position-derived sequence keeps each source monotonic even though
    // renderer-to-ASR sequence remains one number per 560 ms batch.
    sequence: Math.floor((metadata.startSample + offsetSamples) / FRAME_SAMPLES),
    epoch,
    flags: {
      // The paired native processor must reset on either source's restart,
      // even though ASR metadata stays source-specific above.
      discontinuity: aecBoundary && offset === 0,
      recovered: aecRecovered && offset === 0,
      silence: metadata.flags.includes('silence'),
    },
    pcmBase64: bytes.subarray(offset, offset + FRAME_BYTES).toString('base64'),
  };
}

function rawBatch(pcmBase64: string, metadata?: MeetingAudioFeedMetadata): AecMicBatch {
  return { pcmBase64, metadata: metadata ?? {} };
}

function safelyDecode(value: string): Buffer | null {
  try {
    return strictBase64(value);
  } catch {
    return null;
  }
}

function strictBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid PCM base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('non-canonical PCM base64');
  return bytes;
}
