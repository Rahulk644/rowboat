import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findCrossChannelEchoSuppressions,
  mergeMeetingTranscriptSegments,
  SelfHostedMeetingTranscription,
  type MeetingTranscriptSegment,
  loadSelfHostedMeetingConfig,
} from './meeting-transcription.js';

const TOKEN = 'rowboat-test-token-that-is-at-least-32-characters';

function echoSegment(
  channel: 'mic' | 'system',
  segmentId: string,
  text: string,
  startSample = 0,
  endSample = 16_000,
): MeetingTranscriptSegment {
  return {
    meetingId: 'echo-meeting', segmentId, revision: 2, epoch: 0,
    startSample, endSample, timingConfidence: 'low', timingSource: 'feed-window',
    channel, text, finality: 'stable', clusterIds: [], overlap: false,
    speaker: { kind: 'unknown', displayName: 'Unknown speaker' },
    attributionSource: 'self-hosted-feed-window', attributionConfidence: 0, supersedes: [],
  };
}

test('self-hosted provider stays loopback-only and completes two source sessions', async (t) => {
  const originalUrl = process.env.ROWBOAT_MEETING_STT_URL;
  const originalToken = process.env.ROWBOAT_MEETING_STT_TOKEN;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ROWBOAT_MEETING_STT_URL;
    else process.env.ROWBOAT_MEETING_STT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ROWBOAT_MEETING_STT_TOKEN;
    else process.env.ROWBOAT_MEETING_STT_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  });

  process.env.ROWBOAT_MEETING_STT_TOKEN = TOKEN;
  process.env.ROWBOAT_MEETING_STT_URL = 'https://speech.example.com';
  assert.throws(() => loadSelfHostedMeetingConfig(), /loopback URL/);

  const requests: Array<{ path: string; session: string; language: string | null; bytes: number }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input.toString());
    const headers = new Headers(init?.headers);
    const body = init?.body ? Buffer.from(init.body as ArrayBuffer) : Buffer.alloc(0);
    const session = url.searchParams.get('session') ?? '';
    requests.push({
      path: url.pathname,
      session,
      language: url.searchParams.get('language'),
      bytes: body.length,
    });
    assert.equal(headers.get('Authorization'), `Bearer ${TOKEN}`);
    const payload = url.pathname === '/stream/feed' || url.pathname === '/stream/finalize'
      ? {
          session,
          full: session.endsWith('.mic') ? 'local words' : 'remote words',
          committed: session.endsWith('.mic') ? 'local words' : 'remote words',
          tentative: '',
          changed: true,
          final: url.pathname === '/stream/finalize',
          revision: 1,
          inputMs: Math.floor(body.length / 32),
          bufferedMs: 0,
        }
      : { ok: true, session };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  process.env.ROWBOAT_MEETING_STT_URL = 'http://127.0.0.1:18091';

  const provider = new SelfHostedMeetingTranscription();
  assert.deepEqual(provider.getStatus(), {
    provider: 'self-hosted-nemotron',
    configured: true,
  });

  await provider.begin('meeting A', 'en');
  const pcm = Buffer.from([0, 0, 1, 0]).toString('base64');
  const snapshot = await provider.feed('meeting A', 'mic', pcm);
  assert.equal(snapshot.full, 'local words');
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.epoch, 0);
  assert.equal(snapshot.feed?.startSample, 0);
  assert.deepEqual(snapshot.segments.map(({ text, timingConfidence, timingSource }) => ({ text, timingConfidence, timingSource })), [
    { text: 'local words', timingConfidence: 'low', timingSource: 'feed-window' },
  ]);
  assert.equal(snapshot.segments[0]?.speaker.kind, 'unknown');
  await provider.restart('meeting A');
  const final = await provider.finalize('meeting A');
  assert.equal(final.mic.final, true);
  assert.equal(final.system.full, 'remote words');

  assert.deepEqual(
    requests.map(({ path, session }) => [path, session]),
    [
      ['/stream/begin', 'meeting-A.mic'],
      ['/stream/begin', 'meeting-A.system'],
      ['/stream/feed', 'meeting-A.mic'],
      ['/stream/reset', 'meeting-A.mic'],
      ['/stream/reset', 'meeting-A.system'],
      ['/stream/begin', 'meeting-A.mic'],
      ['/stream/begin', 'meeting-A.system'],
      ['/stream/finalize', 'meeting-A.mic'],
      ['/stream/finalize', 'meeting-A.system'],
      ['/stream/reset', 'meeting-A.mic'],
      ['/stream/reset', 'meeting-A.system'],
    ],
  );
  assert.equal(requests[2].bytes, 4);
  assert.deepEqual(
    requests.filter(({ path }) => path === '/stream/begin').map(({ language }) => language),
    ['auto', 'auto', 'auto', 'auto'],
  );
});

test('canonical v2 segment merging is idempotent and accepts only higher revisions', () => {
  const base: MeetingTranscriptSegment = {
    meetingId: 'm', segmentId: 'm:mic:e0:stable:0', revision: 0, epoch: 0,
    startSample: 0, endSample: 16_000, timingConfidence: 'low', timingSource: 'feed-window',
    channel: 'mic', text: 'first words', finality: 'stable', clusterIds: [], overlap: false,
    speaker: { kind: 'unknown', displayName: 'Unknown speaker' },
    attributionSource: 'self-hosted-feed-window', attributionConfidence: 0, supersedes: [],
  };
  const ignored = { ...base, text: 'stale replay' };
  const revised = { ...base, revision: 1, text: 'first words', finality: 'final' as const };
  assert.deepEqual(mergeMeetingTranscriptSegments([base], [ignored]), [base]);
  assert.deepEqual(mergeMeetingTranscriptSegments([base], [revised]), [revised]);
});

test('opt-in PCM diagnostics expose only ephemeral per-channel pipeline metadata', async (t) => {
  const originalUrl = process.env.ROWBOAT_MEETING_STT_URL;
  const originalToken = process.env.ROWBOAT_MEETING_STT_TOKEN;
  const originalDiagnostics = process.env.ROWBOAT_MEETING_PCM_DIAGNOSTICS;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ROWBOAT_MEETING_STT_URL;
    else process.env.ROWBOAT_MEETING_STT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ROWBOAT_MEETING_STT_TOKEN;
    else process.env.ROWBOAT_MEETING_STT_TOKEN = originalToken;
    if (originalDiagnostics === undefined) delete process.env.ROWBOAT_MEETING_PCM_DIAGNOSTICS;
    else process.env.ROWBOAT_MEETING_PCM_DIAGNOSTICS = originalDiagnostics;
    globalThis.fetch = originalFetch;
  });

  delete process.env.ROWBOAT_MEETING_PCM_DIAGNOSTICS;
  process.env.ROWBOAT_MEETING_STT_TOKEN = TOKEN;
  process.env.ROWBOAT_MEETING_STT_URL = 'http://127.0.0.1:18091';
  globalThis.fetch = async (input) => {
    const url = new URL(input.toString());
    const session = url.searchParams.get('session') ?? '';
    const payload = url.pathname === '/stream/feed' || url.pathname === '/stream/finalize'
      ? {
          session, full: '', committed: '', tentative: '', changed: false,
          final: url.pathname === '/stream/finalize', revision: 0, inputMs: 560, bufferedMs: 0,
        }
      : { ok: true, session };
    return new Response(JSON.stringify(payload), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = new SelfHostedMeetingTranscription();
  await provider.begin('diagnostic meeting', 'auto');
  assert.deepEqual(provider.getPcmDiagnostics(), { enabled: false, activeMeetings: [] });
  provider.getPcmDiagnostics(true);

  const audible = Buffer.from([0, 0, 0xff, 0x7f]).toString('base64');
  const silent = Buffer.alloc(4).toString('base64');
  await provider.feed('diagnostic meeting', 'mic', audible, {
    startSample: 0, sampleCount: 2, sampleRate: 16_000, sequence: 0,
  });
  await provider.feed('diagnostic meeting', 'system', silent, {
    startSample: 0, sampleCount: 2, sampleRate: 16_000, sequence: 0,
  });

  const diagnostics = provider.getPcmDiagnostics();
  assert.equal(diagnostics.enabled, true);
  assert.equal(diagnostics.activeMeetings.length, 1);
  const { mic, system } = diagnostics.activeMeetings[0]!;
  assert.deepEqual(
    Object.keys(mic).sort(),
    [
      'acceptedBatches', 'acceptedSamples', 'signalBatches', 'workerRequests', 'workerResponses',
      'workerFailures', 'changedResponses', 'emittedSegmentUpserts', 'lastSequence', 'lastFeedAgeMs',
      'lastWorkerResponseAgeMs', 'lastWorkerInputMs', 'lastWorkerBufferedMs',
    ].sort(),
  );
  assert.deepEqual(
    { acceptedBatches: mic.acceptedBatches, acceptedSamples: mic.acceptedSamples, signalBatches: mic.signalBatches,
      workerRequests: mic.workerRequests, workerResponses: mic.workerResponses, workerFailures: mic.workerFailures,
      changedResponses: mic.changedResponses, emittedSegmentUpserts: mic.emittedSegmentUpserts, lastSequence: mic.lastSequence,
      lastWorkerInputMs: mic.lastWorkerInputMs, lastWorkerBufferedMs: mic.lastWorkerBufferedMs },
    { acceptedBatches: 1, acceptedSamples: 2, signalBatches: 1, workerRequests: 1, workerResponses: 1,
      workerFailures: 0, changedResponses: 0, emittedSegmentUpserts: 0, lastSequence: 0,
      lastWorkerInputMs: 560, lastWorkerBufferedMs: 0 },
  );
  assert.equal(system.signalBatches, 0);
  assert.equal(system.workerResponses, 1);
  assert.equal(JSON.stringify(diagnostics).includes('diagnostic-meeting'), false);

  await provider.finalize('diagnostic meeting');
  assert.deepEqual(provider.getPcmDiagnostics(), { enabled: false, activeMeetings: [] });
});

test('suppresses one exact, interval-aligned system echo from the mic channel', () => {
  const system = echoSegment('system', 'system-1', 'please review the deployment plan before lunch');
  const mic = echoSegment('mic', 'mic-1', 'please review the deployment plan before lunch');
  const suppression = findCrossChannelEchoSuppressions([system, mic]);

  assert.deepEqual(suppression.suppressedMicSegmentIds, ['mic-1']);
  assert.deepEqual(suppression.systemUpserts, [{
    ...system,
    revision: 3,
    supersedes: ['mic-1'],
  }]);
});

test('suppresses one very close STT revision only with strong time alignment', () => {
  const system = echoSegment('system', 'system-1', 'please review the deployment plan before lunch');
  const mic = echoSegment('mic', 'mic-1', 'please review deployment plan before lunch', 800, 16_000);
  const suppression = findCrossChannelEchoSuppressions([system, mic]);

  assert.deepEqual(suppression.suppressedMicSegmentIds, ['mic-1']);
  assert.equal(suppression.systemUpserts[0]?.supersedes.includes('mic-1'), true);
});

test('suppresses a contiguous run of short aligned echo fragments', () => {
  const pairs = [
    ['you always attract', 'you always attract that'],
    ['that kind of person', 'kind of person'],
    ['because that is', 'because that is'],
  ].flatMap(([micText, systemText], index) => {
    const start = index * 16_000;
    const end = start + 16_000;
    return [
      echoSegment('mic', `mic-${index}`, micText!, start, end),
      echoSegment('system', `system-${index}`, systemText!, start, end),
    ];
  });

  const suppression = findCrossChannelEchoSuppressions(pairs);

  assert.deepEqual(suppression.suppressedMicSegmentIds, ['mic-0', 'mic-1', 'mic-2']);
  assert.deepEqual(
    suppression.systemUpserts.map((segment) => segment.supersedes),
    [['mic-0'], ['mic-1'], ['mic-2']],
  );
});

test('preserves an isolated short match and breaks an echo run around different simultaneous speech', () => {
  const isolatedMic = echoSegment('mic', 'mic-isolated', 'yes');
  const isolatedSystem = echoSegment('system', 'system-isolated', 'yes');
  assert.deepEqual(findCrossChannelEchoSuppressions([isolatedMic, isolatedSystem]), {
    suppressedMicSegmentIds: [], systemUpserts: [],
  });

  const segments = [
    echoSegment('mic', 'mic-before', 'please review that', 0, 16_000),
    echoSegment('system', 'system-before', 'please review that', 0, 16_000),
    echoSegment('mic', 'mic-local', 'my local interruption is different', 16_000, 32_000),
    echoSegment('system', 'system-remote', 'the remote speaker keeps talking', 16_000, 32_000),
    echoSegment('mic', 'mic-after', 'yes continue', 32_000, 48_000),
    echoSegment('system', 'system-after', 'yes continue', 32_000, 48_000),
  ];
  assert.deepEqual(findCrossChannelEchoSuppressions(segments), {
    suppressedMicSegmentIds: [], systemUpserts: [],
  });
});

test('suppresses a unique feed-boundary split without erasing different overlap', () => {
  const splitMic = echoSegment('mic', 'mic-split', 'looking woman same', 0, 32_000);
  const systemA = echoSegment('system', 'system-a', 'look', 0, 16_000);
  const systemB = echoSegment('system', 'system-b', 'ing woman same', 16_000, 32_000);
  const suppression = findCrossChannelEchoSuppressions([splitMic, systemA, systemB]);

  assert.deepEqual(suppression.suppressedMicSegmentIds, ['mic-split']);
  assert.deepEqual(suppression.systemUpserts.map((segment) => ({
    segmentId: segment.segmentId,
    supersedes: segment.supersedes,
  })), [{ segmentId: 'system-b', supersedes: ['mic-split'] }]);

  const localSpeech = echoSegment('mic', 'mic-local-overlap', 'my own simultaneous answer', 0, 32_000);
  assert.deepEqual(findCrossChannelEchoSuppressions([localSpeech, systemA, systemB]), {
    suppressedMicSegmentIds: [], systemUpserts: [],
  });
});

test('preserves different simultaneous speakers and any ambiguous echo graph', () => {
  const system = echoSegment('system', 'system-1', 'please review the deployment plan before lunch');
  const differentMic = echoSegment('mic', 'mic-different', 'we should postpone the planning meeting until tomorrow');
  const sameMicA = echoSegment('mic', 'mic-echo-a', 'please review the deployment plan before lunch');
  const sameMicB = echoSegment('mic', 'mic-echo-b', 'please review the deployment plan before lunch');

  assert.deepEqual(findCrossChannelEchoSuppressions([system, differentMic]), {
    suppressedMicSegmentIds: [], systemUpserts: [],
  });
  assert.deepEqual(findCrossChannelEchoSuppressions([system, sameMicA, sameMicB]), {
    suppressedMicSegmentIds: [], systemUpserts: [],
  });
});

test('main emits one canonical system upsert when the matching mic segment is echo', async (t) => {
  const originalUrl = process.env.ROWBOAT_MEETING_STT_URL;
  const originalToken = process.env.ROWBOAT_MEETING_STT_TOKEN;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ROWBOAT_MEETING_STT_URL;
    else process.env.ROWBOAT_MEETING_STT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ROWBOAT_MEETING_STT_TOKEN;
    else process.env.ROWBOAT_MEETING_STT_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  });

  process.env.ROWBOAT_MEETING_STT_TOKEN = TOKEN;
  process.env.ROWBOAT_MEETING_STT_URL = 'http://127.0.0.1:18091';
  globalThis.fetch = async (input) => {
    const url = new URL(input.toString());
    const session = url.searchParams.get('session') ?? '';
    if (url.pathname === '/stream/feed') {
      return new Response(JSON.stringify({
        session,
        full: 'please review the deployment plan before lunch',
        committed: 'please review the deployment plan before lunch',
        tentative: '', changed: true, final: false, revision: 1, inputMs: 0, bufferedMs: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, session }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = new SelfHostedMeetingTranscription();
  await provider.begin('echo pair', 'en');
  const pcm = Buffer.alloc(32_000).toString('base64');
  const mic = await provider.feed('echo pair', 'mic', pcm, {
    startSample: 0, sampleCount: 16_000, sampleRate: 16_000, sequence: 0,
  });
  assert.equal(mic.segments[0]?.speaker.kind, 'unknown');
  const qualified = provider.applySpeakerEvidence('echo pair', [], { outputRouteIsolated: true });
  assert.deepEqual(qualified.segments.map((segment) => ({
    kind: segment.speaker.kind,
    displayName: segment.speaker.displayName,
    source: segment.attributionSource,
  })), [{ kind: 'self', displayName: 'You', source: 'qualified-mic' }]);
  const system = await provider.feed('echo pair', 'system', pcm, {
    startSample: 0, sampleCount: 16_000, sampleRate: 16_000, sequence: 0,
  });

  assert.deepEqual(system.segments.map((segment) => ({
    segmentId: segment.segmentId,
    revision: segment.revision,
    supersedes: segment.supersedes,
  })), [{
    segmentId: 'echo-pair:system:e0:stable:0',
    revision: 1,
    supersedes: ['echo-pair:mic:e0:stable:0'],
  }]);
});

test('revised provisional windows become deterministic stable windows without final duplicates', async (t) => {
  const originalUrl = process.env.ROWBOAT_MEETING_STT_URL;
  const originalToken = process.env.ROWBOAT_MEETING_STT_TOKEN;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ROWBOAT_MEETING_STT_URL;
    else process.env.ROWBOAT_MEETING_STT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ROWBOAT_MEETING_STT_TOKEN;
    else process.env.ROWBOAT_MEETING_STT_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  });

  process.env.ROWBOAT_MEETING_STT_TOKEN = TOKEN;
  process.env.ROWBOAT_MEETING_STT_URL = 'http://127.0.0.1:18091';
  const liveSnapshots = [
    { full: 'this time taken you', committed: 'this time', tentative: 'taken you', revision: 1 },
    { full: 'this time taken you are shown', committed: 'this time', tentative: 'taken you are shown', revision: 2 },
    { full: 'this time taken you are showing', committed: 'this time taken you', tentative: 'are showing', revision: 3 },
  ];
  const finalSnapshot = {
    full: 'this time taken you are showing is this the av',
    committed: 'this time taken you',
    tentative: 'are showing is this the av',
    revision: 4,
  };
  let systemFeed = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input.toString());
    const session = url.searchParams.get('session') ?? '';
    if (url.pathname === '/stream/feed') {
      const snapshot = session.endsWith('.system') ? liveSnapshots[systemFeed++]! : {
        full: '', committed: '', tentative: '', revision: 0,
      };
      return new Response(JSON.stringify({
        session, ...snapshot, changed: true, final: false, inputMs: 0, bufferedMs: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/stream/finalize') {
      const snapshot = session.endsWith('.system') ? finalSnapshot : {
        full: '', committed: '', tentative: '', revision: 0,
      };
      return new Response(JSON.stringify({
        session, ...snapshot, changed: true, final: true, inputMs: 0, bufferedMs: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, session }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };

  const provider = new SelfHostedMeetingTranscription();
  await provider.begin('revised window', 'en');
  const pcm = Buffer.alloc(32_000).toString('base64');
  const first = await provider.feed('revised window', 'system', pcm, {
    startSample: 0, sampleCount: 16_000, sampleRate: 16_000, sequence: 0,
  });
  assert.deepEqual(first.segments.map((segment) => [segment.segmentId, segment.revision, segment.text]), [
    ['revised-window:system:e0:stable:0', 0, 'this time'],
    ['revised-window:system:e0:provisional:16000', 0, 'taken you'],
  ]);

  const revised = await provider.feed('revised window', 'system', pcm, {
    startSample: 16_000, sampleCount: 16_000, sampleRate: 16_000, sequence: 1,
  });
  assert.deepEqual(revised.segments.map((segment) => [segment.segmentId, segment.revision, segment.text]), [
    ['revised-window:system:e0:provisional:16000', 1, 'taken you are shown'],
  ]);

  const committed = await provider.feed('revised window', 'system', pcm, {
    startSample: 32_000, sampleCount: 16_000, sampleRate: 16_000, sequence: 2,
  });
  assert.deepEqual(committed.segments.map((segment) => [segment.segmentId, segment.text, segment.supersedes]), [
    ['revised-window:system:e0:stable:16000', 'taken you', ['revised-window:system:e0:provisional:16000']],
    ['revised-window:system:e0:provisional:48000', 'are showing', []],
  ]);

  const final = await provider.finalize('revised window');
  const finalSegments = final.system.segments;
  assert.equal(finalSegments.some((segment) => segment.segmentId.includes(':provisional:')), false);
  assert.deepEqual(
    finalSegments
      .filter((segment) => segment.segmentId.includes(':stable:'))
      .map((segment) => [segment.segmentId, segment.finality, segment.text]),
    [
      ['revised-window:system:e0:stable:0', 'final', 'this time'],
      ['revised-window:system:e0:stable:16000', 'final', 'taken you'],
      ['revised-window:system:e0:stable:48000', 'final', 'are showing is this the av'],
    ],
  );
  assert.deepEqual(
    finalSegments.find((segment) => segment.segmentId.endsWith(':stable:48000'))?.supersedes,
    ['revised-window:system:e0:provisional:48000'],
  );
});

test('a discontinuity resets only its worker session and starts a non-duplicating epoch', async (t) => {
  const originalUrl = process.env.ROWBOAT_MEETING_STT_URL;
  const originalToken = process.env.ROWBOAT_MEETING_STT_TOKEN;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ROWBOAT_MEETING_STT_URL;
    else process.env.ROWBOAT_MEETING_STT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ROWBOAT_MEETING_STT_TOKEN;
    else process.env.ROWBOAT_MEETING_STT_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  });
  process.env.ROWBOAT_MEETING_STT_TOKEN = TOKEN;
  process.env.ROWBOAT_MEETING_STT_URL = 'http://127.0.0.1:18091';

  const requests: string[] = [];
  let micWasReset = false;
  globalThis.fetch = async (input) => {
    const url = new URL(input.toString());
    const session = url.searchParams.get('session') ?? '';
    requests.push(`${url.pathname}:${session}`);
    if (url.pathname === '/stream/reset' && session.endsWith('.mic')) micWasReset = true;
    if (url.pathname === '/stream/feed') {
      const afterGap = session.endsWith('.mic') && micWasReset;
      const text = afterGap ? 'after gap' : 'before gap';
      return new Response(JSON.stringify({
        session, full: text, committed: text, tentative: '', changed: true,
        final: false, revision: 1, inputMs: 0, bufferedMs: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, session }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const provider = new SelfHostedMeetingTranscription();
  await provider.begin('meeting gap', 'en');
  const pcm = Buffer.from([0, 0, 1, 0]).toString('base64');
  const before = await provider.feed('meeting gap', 'mic', pcm, {
    startSample: 0, sampleCount: 2, sampleRate: 16_000, sequence: 0,
  });
  const after = await provider.feed('meeting gap', 'mic', pcm, {
    startSample: 2, sampleCount: 2, sampleRate: 16_000, sequence: 1, flags: ['discontinuity'],
  });

  assert.equal(before.segments[0]?.text, 'before gap');
  assert.equal(after.epoch, 1);
  assert.equal(after.segments[0]?.text, 'after gap');
  assert.equal(after.segments.some((segment) => segment.text.includes('before gap')), false);
  assert.deepEqual(after.feed, {
    sourceId: 'meeting-gap.mic', channel: 'mic', epoch: 1,
    startSample: 2, sampleCount: 2, sampleRate: 16_000, sequence: 1, flags: ['discontinuity'],
  });
  assert.ok(requests.includes('/stream/reset:meeting-gap.mic'));
  assert.ok(requests.includes('/stream/begin:meeting-gap.mic'));
  const correction = provider.correctSpeaker('meeting gap', before.segments[0]!.segmentId, 'Akbar', false);
  assert.equal(correction?.revision, 1);
  assert.equal(correction?.speaker.displayName, 'Akbar');
});

test('main-process evidence batch names distinct intervals, preserves overlap, and ignores rosters', async (t) => {
  const originalUrl = process.env.ROWBOAT_MEETING_STT_URL;
  const originalToken = process.env.ROWBOAT_MEETING_STT_TOKEN;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ROWBOAT_MEETING_STT_URL;
    else process.env.ROWBOAT_MEETING_STT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ROWBOAT_MEETING_STT_TOKEN;
    else process.env.ROWBOAT_MEETING_STT_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  });
  process.env.ROWBOAT_MEETING_STT_TOKEN = TOKEN;
  process.env.ROWBOAT_MEETING_STT_URL = 'http://127.0.0.1:18091';

  const committed = [
    'first remote',
    'first remote second remote',
    'first remote second remote overlap words',
    'first remote second remote overlap words roster words',
  ];
  let systemFeed = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input.toString());
    const session = url.searchParams.get('session') ?? '';
    if (url.pathname === '/stream/feed') {
      const text = session.endsWith('.system') ? committed[systemFeed++]! : '';
      return new Response(JSON.stringify({
        session, full: text, committed: text, tentative: '', changed: true,
        final: false, revision: systemFeed, inputMs: 0, bufferedMs: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, session }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const provider = new SelfHostedMeetingTranscription();
  await provider.begin('speaker evidence', 'en');
  const pcm = Buffer.alloc(32_000).toString('base64');
  for (let index = 0; index < committed.length; index++) {
    await provider.feed('speaker evidence', 'system', pcm, {
      startSample: index * 16_000,
      sampleCount: 16_000,
      sampleRate: 16_000,
      sequence: index,
    });
  }

  const firstTwo = provider.applySpeakerEvidence('speaker evidence', [
    { source: 'zoom_ax', participantId: 'akbar', displayName: 'Akbar', isActive: true, startSample: 0, endSample: 16_000, confidence: 1 },
    { source: 'zoom_ax', participantId: 'parminder', displayName: 'Parminder', isActive: true, startSample: 16_000, endSample: 32_000, confidence: 1 },
  ]);
  assert.deepEqual(firstTwo.segments.map((item) => item.speaker.displayName), ['Akbar', 'Parminder']);
  assert.deepEqual(firstTwo.segments.map((item) => item.revision), [1, 1]);
  const corrected = provider.correctSpeaker('speaker evidence', firstTwo.segments[0]!.segmentId, 'Akbar confirmed', false);
  assert.equal(corrected?.revision, 2);
  const correctionWins = provider.applySpeakerEvidence('speaker evidence', [
    { source: 'zoom_ax', participantId: 'parminder', displayName: 'Parminder', isActive: true, startSample: 0, endSample: 16_000, confidence: 1 },
  ]);
  assert.deepEqual(correctionWins, { segments: [] });

  const overlap = provider.applySpeakerEvidence('speaker evidence', [
    { source: 'zoom_ax', participantId: 'akbar', displayName: 'Akbar', isActive: true, startSample: 32_000, endSample: 48_000, confidence: 1 },
    { source: 'zoom_ax', participantId: 'parminder', displayName: 'Parminder', isActive: true, startSample: 32_000, endSample: 48_000, confidence: 1 },
  ]);
  assert.equal(overlap.segments.length, 1);
  assert.equal(overlap.segments[0]?.overlap, true);
  assert.deepEqual(overlap.segments[0]?.speaker, { kind: 'unknown', displayName: 'Akbar + Parminder' });

  const rosterOnly = provider.applySpeakerEvidence('speaker evidence', [
    { source: 'zoom_ax', participantId: 'roster', displayName: 'Roster only', isActive: false, startSample: 48_000, endSample: 64_000, confidence: 1 },
  ]);
  assert.deepEqual(rosterOnly, { segments: [] });
});

test('evidence received before delayed ASR is applied when its interval is created', async (t) => {
  const originalUrl = process.env.ROWBOAT_MEETING_STT_URL;
  const originalToken = process.env.ROWBOAT_MEETING_STT_TOKEN;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ROWBOAT_MEETING_STT_URL;
    else process.env.ROWBOAT_MEETING_STT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ROWBOAT_MEETING_STT_TOKEN;
    else process.env.ROWBOAT_MEETING_STT_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  });
  process.env.ROWBOAT_MEETING_STT_TOKEN = TOKEN;
  process.env.ROWBOAT_MEETING_STT_URL = 'http://127.0.0.1:18091';
  globalThis.fetch = async (input) => {
    const url = new URL(input.toString());
    const session = url.searchParams.get('session') ?? '';
    if (url.pathname === '/stream/feed') {
      return new Response(JSON.stringify({
        session, full: 'Akbar speaks first', committed: 'Akbar speaks first', tentative: '', changed: true,
        final: false, revision: 1, inputMs: 1_000, bufferedMs: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, session }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const provider = new SelfHostedMeetingTranscription();
  await provider.begin('early evidence', 'en');
  assert.deepEqual(provider.applySpeakerEvidence('early evidence', [
    { source: 'zoom_ax', participantId: 'akbar', displayName: 'Akbar', isActive: true, startSample: 0, endSample: 16_000, confidence: 1 },
  ]), { segments: [] });

  const snapshot = await provider.feed('early evidence', 'system', Buffer.alloc(32_000).toString('base64'), {
    startSample: 0, sampleCount: 16_000, sampleRate: 16_000, sequence: 0,
  });
  assert.equal(snapshot.segments.length, 1);
  assert.equal(snapshot.segments[0]?.revision, 1);
  assert.deepEqual(snapshot.segments[0]?.speaker, { kind: 'named', id: 'akbar', displayName: 'Akbar' });
  assert.equal(snapshot.segments[0]?.attributionSource, 'zoom_ax');
});

test('a fast mic final does not prune evidence needed by delayed system ASR', async (t) => {
  const originalUrl = process.env.ROWBOAT_MEETING_STT_URL;
  const originalToken = process.env.ROWBOAT_MEETING_STT_TOKEN;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ROWBOAT_MEETING_STT_URL;
    else process.env.ROWBOAT_MEETING_STT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ROWBOAT_MEETING_STT_TOKEN;
    else process.env.ROWBOAT_MEETING_STT_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  });
  process.env.ROWBOAT_MEETING_STT_TOKEN = TOKEN;
  process.env.ROWBOAT_MEETING_STT_URL = 'http://127.0.0.1:18091';
  globalThis.fetch = async (input) => {
    const url = new URL(input.toString());
    const session = url.searchParams.get('session') ?? '';
    if (url.pathname === '/stream/feed') {
      const mic = session.endsWith('.mic');
      const text = mic ? 'local final' : 'remote delayed';
      return new Response(JSON.stringify({
        session, full: text, committed: text, tentative: '', changed: true,
        final: mic, revision: 1, inputMs: mic ? 2_000 : 1_000, bufferedMs: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, session }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const provider = new SelfHostedMeetingTranscription();
  await provider.begin('cross channel watermark', 'en');
  provider.applySpeakerEvidence('cross channel watermark', [
    { source: 'zoom_ax', participantId: 'akbar', displayName: 'Akbar', isActive: true, startSample: 0, endSample: 16_000, confidence: 1 },
  ]);
  await provider.feed('cross channel watermark', 'mic', Buffer.alloc(64_000).toString('base64'), {
    startSample: 0, sampleCount: 32_000, sampleRate: 16_000, sequence: 0,
  });
  const delayedSystem = await provider.feed('cross channel watermark', 'system', Buffer.alloc(32_000).toString('base64'), {
    startSample: 0, sampleCount: 16_000, sampleRate: 16_000, sequence: 0,
  });
  assert.deepEqual(delayedSystem.segments[0]?.speaker, { kind: 'named', id: 'akbar', displayName: 'Akbar' });
  assert.equal(delayedSystem.segments[0]?.revision, 1);
});

test('post-transcript evidence is delivered in the next snapshot exactly once', async (t) => {
  const originalUrl = process.env.ROWBOAT_MEETING_STT_URL;
  const originalToken = process.env.ROWBOAT_MEETING_STT_TOKEN;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ROWBOAT_MEETING_STT_URL;
    else process.env.ROWBOAT_MEETING_STT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ROWBOAT_MEETING_STT_TOKEN;
    else process.env.ROWBOAT_MEETING_STT_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  });
  process.env.ROWBOAT_MEETING_STT_TOKEN = TOKEN;
  process.env.ROWBOAT_MEETING_STT_URL = 'http://127.0.0.1:18091';
  globalThis.fetch = async (input) => {
    const url = new URL(input.toString());
    const session = url.searchParams.get('session') ?? '';
    if (url.pathname === '/stream/feed') {
      return new Response(JSON.stringify({
        session, full: 'remote words', committed: 'remote words', tentative: '', changed: false,
        final: false, revision: 1, inputMs: 1_000, bufferedMs: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, session }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const provider = new SelfHostedMeetingTranscription();
  await provider.begin('queued attribution', 'en');
  const pcm = Buffer.alloc(32_000).toString('base64');
  const initial = await provider.feed('queued attribution', 'system', pcm, {
    startSample: 0, sampleCount: 16_000, sampleRate: 16_000, sequence: 0,
  });
  assert.equal(initial.segments[0]?.revision, 0);
  assert.equal(initial.segments[0]?.speaker.kind, 'unknown');

  const immediate = provider.applySpeakerEvidence('queued attribution', [
    { source: 'zoom_ax', participantId: 'akbar', displayName: 'Akbar', isActive: true, startSample: 0, endSample: 16_000, confidence: 1 },
  ]);
  assert.equal(immediate.segments[0]?.revision, 1);

  const next = await provider.feed('queued attribution', 'system', pcm, {
    startSample: 16_000, sampleCount: 16_000, sampleRate: 16_000, sequence: 1,
  });
  assert.equal(next.segments.length, 1);
  assert.equal(next.segments[0]?.revision, 1);
  assert.deepEqual(next.segments[0]?.speaker, { kind: 'named', id: 'akbar', displayName: 'Akbar' });

  const afterDelivery = await provider.feed('queued attribution', 'system', pcm, {
    startSample: 32_000, sampleCount: 16_000, sampleRate: 16_000, sequence: 2,
  });
  assert.deepEqual(afterDelivery.segments, []);
});

test('restartChannel resets only the failed ASR session and preserves sibling epoch', async (t) => {
  const originalUrl = process.env.ROWBOAT_MEETING_STT_URL;
  const originalToken = process.env.ROWBOAT_MEETING_STT_TOKEN;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.ROWBOAT_MEETING_STT_URL;
    else process.env.ROWBOAT_MEETING_STT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ROWBOAT_MEETING_STT_TOKEN;
    else process.env.ROWBOAT_MEETING_STT_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  });
  process.env.ROWBOAT_MEETING_STT_TOKEN = TOKEN;
  process.env.ROWBOAT_MEETING_STT_URL = 'http://127.0.0.1:18091';
  const paths: string[] = [];
  let micFeed = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input.toString());
    const session = url.searchParams.get('session') ?? '';
    paths.push(`${url.pathname}:${session}`);
    if (url.pathname === '/stream/feed') {
      const text = session.endsWith('.mic')
        ? (micFeed++ === 0 ? 'mic first' : 'mic first second')
        : 'remote first';
      return new Response(JSON.stringify({
        session, full: text, committed: text, tentative: '', changed: true,
        final: false, revision: 1, inputMs: 0, bufferedMs: 0,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, session }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const provider = new SelfHostedMeetingTranscription();
  await provider.begin('partial pair', 'en');
  const pcm = Buffer.from([0, 0, 1, 0]).toString('base64');
  const firstMic = await provider.feed('partial pair', 'mic', pcm, {
    startSample: 0, sampleCount: 2, sampleRate: 16_000, sequence: 0,
  });
  await provider.restartChannel('partial pair', 'system');
  const nextMic = await provider.feed('partial pair', 'mic', pcm, {
    startSample: 2, sampleCount: 2, sampleRate: 16_000, sequence: 1,
  });
  const retriedSystem = await provider.feed('partial pair', 'system', pcm, {
    startSample: 0, sampleCount: 2, sampleRate: 16_000, sequence: 0,
  });

  assert.equal(firstMic.epoch, 0);
  assert.equal(nextMic.epoch, 0);
  assert.equal(nextMic.segments[0]?.text, 'second');
  assert.equal(retriedSystem.epoch, 1);
  assert.ok(paths.includes('/stream/reset:partial-pair.system'));
  assert.ok(paths.includes('/stream/begin:partial-pair.system'));
  assert.equal(paths.includes('/stream/reset:partial-pair.mic'), false);
});
