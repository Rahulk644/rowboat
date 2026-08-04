export type SelfHostedAudioChannel = 'mic' | 'system';
export type SelfHostedAudioFlag = 'discontinuity';

export type SelfHostedAudioMetadata = {
  sourceId?: string;
  startSample: number;
  sampleCount: number;
  sampleRate: number;
  sequence: number;
  flags: SelfHostedAudioFlag[];
};

export type CapturedSelfHostedAudio = {
  channel: SelfHostedAudioChannel;
  startSample: number;
  sampleCount: number;
  discontinuityAtCapture: boolean;
};

type ChannelState = {
  nextCapturedSample: number;
  nextSequence: number;
  discontinuityAtNextCapture: boolean;
  discontinuityBeforeNextSend: boolean;
};

const SAMPLE_RATE = 16_000;

/**
 * Separates capture position from successful transport sequence. Captured
 * packets keep their sample position across retries; only an acknowledged
 * channel feed advances its transport sequence. This prevents a failed
 * system feed from replaying a successful microphone packet.
 */
export class SelfHostedMeetingAudioClock {
  private readonly states: Record<SelfHostedAudioChannel, ChannelState> = {
    mic: this.newChannelState(),
    system: this.newChannelState(),
  };

  capture(channel: SelfHostedAudioChannel, sampleCount: number): CapturedSelfHostedAudio {
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) throw new Error('sampleCount must be positive');
    const state = this.states[channel];
    const packet: CapturedSelfHostedAudio = {
      channel,
      startSample: state.nextCapturedSample,
      sampleCount,
      discontinuityAtCapture: state.discontinuityAtNextCapture,
    };
    state.nextCapturedSample += sampleCount;
    state.discontinuityAtNextCapture = false;
    return packet;
  }

  /** Record captured audio that cannot enter the bounded renderer backlog. */
  discard(channel: SelfHostedAudioChannel, sampleCount: number): void {
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) throw new Error('sampleCount must be positive');
    const state = this.states[channel];
    state.nextCapturedSample += sampleCount;
    state.discontinuityAtNextCapture = true;
  }

  metadataFor(packet: CapturedSelfHostedAudio): SelfHostedAudioMetadata {
    const state = this.states[packet.channel];
    const discontinuity = packet.discontinuityAtCapture || state.discontinuityBeforeNextSend;
    return {
      startSample: packet.startSample,
      sampleCount: packet.sampleCount,
      sampleRate: SAMPLE_RATE,
      sequence: state.nextSequence,
      flags: discontinuity ? ['discontinuity'] : [],
    };
  }

  /** Call only after Electron main positively acknowledged this channel. */
  acknowledge(channel: SelfHostedAudioChannel): void {
    const state = this.states[channel];
    state.nextSequence += 1;
    state.discontinuityBeforeNextSend = false;
  }

  /** The failed packet was not accepted; flag the next queued packet's gap. */
  markTransportDrop(channel: SelfHostedAudioChannel): void {
    this.states[channel].discontinuityBeforeNextSend = true;
  }

  private newChannelState(): ChannelState {
    return {
      nextCapturedSample: 0,
      nextSequence: 0,
      discontinuityAtNextCapture: false,
      discontinuityBeforeNextSend: false,
    };
  }
}
