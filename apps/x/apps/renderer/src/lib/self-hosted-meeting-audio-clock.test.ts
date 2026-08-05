import { describe, expect, it } from 'vitest';
import { SelfHostedMeetingAudioClock } from './self-hosted-meeting-audio-clock';

describe('SelfHostedMeetingAudioClock', () => {
  it('keeps a successful mic packet out of a retried system channel', () => {
    const clock = new SelfHostedMeetingAudioClock();
    const mic = clock.capture('mic', 8_960);
    const system = clock.capture('system', 8_960);
    expect(clock.metadataFor(mic)).toMatchObject({ startSample: 0, sequence: 0, flags: [] });
    clock.acknowledge('mic');
    expect(clock.metadataFor(system)).toMatchObject({ startSample: 0, sequence: 0, flags: [] });
    // Retrying the failed system packet keeps its original position/sequence.
    expect(clock.metadataFor(system)).toMatchObject({ startSample: 0, sequence: 0, flags: [] });
    clock.acknowledge('system');
    const nextMic = clock.capture('mic', 8_960);
    expect(clock.metadataFor(nextMic)).toMatchObject({ startSample: 8_960, sequence: 1, flags: [] });
  });

  it('turns a renderer backlog drop into one explicit next-frame discontinuity', () => {
    const clock = new SelfHostedMeetingAudioClock();
    clock.discard('mic', 8_960);
    const afterDrop = clock.capture('mic', 8_960);
    expect(clock.metadataFor(afterDrop)).toMatchObject({ startSample: 8_960, sequence: 0, flags: ['discontinuity'] });
    clock.acknowledge('mic');
    const following = clock.capture('mic', 8_960);
    expect(clock.metadataFor(following)).toMatchObject({ startSample: 17_920, sequence: 1, flags: [] });
  });

  it('marks the first later packet after a permanently failed feed', () => {
    const clock = new SelfHostedMeetingAudioClock();
    const lost = clock.capture('system', 8_960);
    expect(clock.metadataFor(lost).flags).toEqual([]);
    clock.markTransportDrop('system');
    const afterFailure = clock.capture('system', 8_960);
    expect(clock.metadataFor(afterFailure)).toMatchObject({ startSample: 8_960, sequence: 0, flags: ['discontinuity'] });
  });

  it('marks only the recovered source with a discontinuity and recovered epoch flag', () => {
    const clock = new SelfHostedMeetingAudioClock();
    clock.capture('mic', 8_960);
    clock.capture('system', 8_960);
    clock.acknowledge('mic');
    clock.acknowledge('system');
    clock.markSourceRecovered('system');

    const nextMic = clock.capture('mic', 8_960);
    const nextSystem = clock.capture('system', 8_960);
    expect(clock.metadataFor(nextMic)).toMatchObject({ startSample: 8_960, sequence: 1, flags: [] });
    expect(clock.metadataFor(nextSystem)).toMatchObject({
      startSample: 8_960,
      sequence: 1,
      flags: ['discontinuity', 'recovered'],
    });
  });
});
