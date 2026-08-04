import assert from 'node:assert/strict';
import test from 'node:test';
import type { MeetingTranscriptSegment } from './meeting-transcription.js';
import { resolveMeetingSpeaker, resolveMeetingSpeakerUpsert } from './meeting-speaker-resolver.js';

function segment(overrides: Partial<MeetingTranscriptSegment> = {}): MeetingTranscriptSegment {
  return {
    meetingId: 'meeting-1', segmentId: 'meeting-1:system:e0:stable:0', revision: 3, epoch: 0,
    startSample: 0, endSample: 16_000, timingConfidence: 'low', timingSource: 'feed-window',
    channel: 'system', text: 'hello', finality: 'stable', clusterIds: [], overlap: false,
    speaker: { kind: 'unknown', displayName: 'Unknown speaker' },
    attributionSource: 'unresolved', attributionConfidence: 0, supersedes: [],
    ...overrides,
  };
}

test('explicit correction wins every resolver path and creates one higher revision', () => {
  const original = segment({ channel: 'mic' });
  const upsert = resolveMeetingSpeakerUpsert(original, {
    correction: { displayName: 'Akbar' },
    micHealth: { meetingId: 'meeting-1', channel: 'mic', epoch: 0, state: 'ready', sequence: 1, lastFrameSample: 16_000, restartCount: 0 },
    outputRouteIsolated: true,
    evidence: [{ source: 'zoom_ax', displayName: 'Parminder', isActive: true, startSample: 0, endSample: 16_000, confidence: 1 }],
  });
  assert.equal(upsert?.revision, 4);
  assert.deepEqual(upsert?.speaker, { kind: 'named', id: 'correction:meeting-1:system:e0:stable:0', displayName: 'Akbar' });
  assert.equal(upsert?.attributionSource, 'explicit-user-correction');
});

test('qualified microphone resolves to You without Calendar or roster identity', () => {
  const resolution = resolveMeetingSpeaker(segment({ channel: 'mic' }), {
    micHealth: { meetingId: 'meeting-1', channel: 'mic', epoch: 0, state: 'ready', sequence: 1, lastFrameSample: 16_000, restartCount: 0 },
    playbackReferenceHealthy: true,
    // This is a roster-only observation: it must not name a turn.
    evidence: [{ source: 'zoom_ax', displayName: 'Parminder', isActive: false, startSample: 0, endSample: 16_000, confidence: 1 }],
  });
  assert.deepEqual(resolution.speaker, { kind: 'self', id: 'self', displayName: 'You' });
  assert.equal(resolution.attributionSource, 'qualified-mic');
});

test('dominant trusted AX active-speaker evidence requires 200ms and a 1.25 lead', () => {
  const resolution = resolveMeetingSpeaker(segment(), {
    evidence: [
      { source: 'zoom_ax', participantId: 'akbar', displayName: 'Akbar', isActive: true, startSample: 0, endSample: 12_000, confidence: 0.9 },
      { source: 'zoom_ax', participantId: 'parminder', displayName: 'Parminder', isActive: true, startSample: 0, endSample: 8_000, confidence: 0.8 },
      // A roster-only name has no effect even when it spans the interval.
      { source: 'zoom_ax', participantId: 'roster', displayName: 'Roster Person', isActive: false, startSample: 0, endSample: 16_000, confidence: 1 },
    ],
  });
  assert.deepEqual(resolution.speaker, { kind: 'named', id: 'akbar', displayName: 'Akbar' });
  assert.equal(resolution.overlap, false);
  assert.equal(resolution.attributionSource, 'zoom_ax');
});

test('simultaneous trusted speakers are preserved as overlap rather than forced into one name', () => {
  const resolution = resolveMeetingSpeaker(segment(), {
    evidence: [
      { source: 'zoom_ax', participantId: 'akbar', displayName: 'Akbar', isActive: true, startSample: 0, endSample: 12_000, confidence: 1 },
      { source: 'meet_ax', participantId: 'parminder', displayName: 'Parminder', isActive: true, startSample: 0, endSample: 12_000, confidence: 1 },
    ],
  });
  assert.equal(resolution.overlap, true);
  assert.deepEqual(resolution.speaker, { kind: 'unknown', displayName: 'Akbar + Parminder' });
  assert.equal(resolution.attributionSource, 'trusted-ax-overlap');
});

test('unqualified mic and passive roster evidence fail closed to a stable anonymous cluster', () => {
  const resolution = resolveMeetingSpeaker(segment({ channel: 'mic' }), {
    micHealth: { meetingId: 'meeting-1', channel: 'mic', epoch: 0, state: 'ready', sequence: 1, lastFrameSample: 16_000, restartCount: 0 },
    evidence: [{ source: 'zoom_ax', displayName: 'Parminder', isActive: false, startSample: 0, endSample: 16_000, confidence: 1 }],
    stableClusterIds: ['Speaker 2'],
  });
  assert.deepEqual(resolution.speaker, { kind: 'cluster', id: 'Speaker 2', displayName: 'Speaker 2' });
  assert.equal(resolution.attributionSource, 'stable-anonymous-cluster');
});

test('only a confirmed voice profile clearing similarity and runner-up margin names a segment', () => {
  const rejected = resolveMeetingSpeaker(segment(), {
    voiceProfile: {
      profileId: 'profile-akbar', displayName: 'Akbar', confirmed: true,
      similarity: 0.73, minimumSimilarity: 0.7, runnerUpSimilarity: 0.71, minimumMargin: 0.05,
    },
  });
  assert.equal(rejected.speaker.kind, 'unknown');

  const accepted = resolveMeetingSpeaker(segment(), {
    voiceProfile: {
      profileId: 'profile-akbar', displayName: 'Akbar', confirmed: true,
      similarity: 0.82, minimumSimilarity: 0.7, runnerUpSimilarity: 0.7, minimumMargin: 0.05,
    },
  });
  assert.deepEqual(accepted.speaker, { kind: 'named', id: 'profile-akbar', displayName: 'Akbar' });
  assert.equal(accepted.attributionSource, 'confirmed-voice-profile');
});

test('unchanged attribution yields no upsert', () => {
  const original = segment({
    speaker: { kind: 'cluster', id: 'Speaker 1', displayName: 'Speaker 1' },
    clusterIds: ['Speaker 1'], attributionSource: 'stable-anonymous-cluster', attributionConfidence: 0.5,
  });
  assert.equal(resolveMeetingSpeakerUpsert(original, { stableClusterIds: ['Speaker 1'] }), null);
});
