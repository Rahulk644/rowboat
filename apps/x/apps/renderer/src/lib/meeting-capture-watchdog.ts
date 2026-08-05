export type MeetingCaptureChannel = 'mic' | 'system';

export type CaptureTrackState = {
  readyState: MediaStreamTrackState;
  muted: boolean;
};

/**
 * Metadata-only source watchdog. It deliberately never uses sample energy or
 * `muted` as a dropout signal: a quiet remote/system channel is a healthy
 * meeting state. The hook owns actual browser calls and asks it to recover
 * only tracks proven ended or a wholly stalled AudioContext callback stream.
 */
export class MeetingCaptureWatchdog {
  private lastAudioCallbackAt: number;
  private callbackStallReported = false;
  private recoveryAttempts = 0;
  private readonly now: () => number;
  private readonly callbackDeadlineMs: number;
  private readonly maxRecoveryAttempts: number;

  constructor(now: () => number = Date.now, callbackDeadlineMs = 3_000, maxRecoveryAttempts = 2) {
    this.now = now;
    this.callbackDeadlineMs = callbackDeadlineMs;
    this.maxRecoveryAttempts = maxRecoveryAttempts;
    this.lastAudioCallbackAt = now();
  }

  recordAudioCallback(): void {
    this.lastAudioCallbackAt = this.now();
    this.callbackStallReported = false;
    this.recoveryAttempts = 0;
  }

  /** A muted-but-live track is never returned here. */
  endedChannels(tracks: Partial<Record<MeetingCaptureChannel, CaptureTrackState>>): MeetingCaptureChannel[] {
    return (['mic', 'system'] as const).filter((channel) => tracks[channel]?.readyState === 'ended');
  }

  /**
   * A device change only revalidates current tracks. It must not stop/reopen a
   * healthy capture graph merely because output hardware was plugged in.
   */
  onDeviceChange(tracks: Partial<Record<MeetingCaptureChannel, CaptureTrackState>>): MeetingCaptureChannel[] {
    return this.endedChannels(tracks);
  }

  /**
   * Returns both channels only after the *graph callbacks* stop, not when
   * either channel is silent. The caller may first attempt `AudioContext.resume`
   * for a suspended context, then recover if callbacks remain absent.
   */
  stalledChannels(audioContextState: AudioContextState | undefined): MeetingCaptureChannel[] {
    if (audioContextState === 'suspended') return [];
    if (this.callbackStallReported || this.now() - this.lastAudioCallbackAt < this.callbackDeadlineMs) return [];
    this.callbackStallReported = true;
    return ['mic', 'system'];
  }

  /**
   * Re-arm a graph-wide callback recovery after a bounded grace period. A
   * real callback resets this budget; a dead graph can therefore retry twice
   * without getting stuck forever or spinning a source picker every second.
   */
  rearmAfterStall(): boolean {
    if (this.recoveryAttempts >= this.maxRecoveryAttempts) return false;
    this.recoveryAttempts += 1;
    this.lastAudioCallbackAt = this.now();
    this.callbackStallReported = false;
    return true;
  }
}
