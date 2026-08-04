import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeMeetingTranscriptSegments,
  SelfHostedMeetingTranscription,
  type MeetingTranscriptSegment,
  loadSelfHostedMeetingConfig,
} from './meeting-transcription.js';

const TOKEN = 'rowboat-test-token-that-is-at-least-32-characters';

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

  const requests: Array<{ path: string; session: string; bytes: number }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input.toString());
    const headers = new Headers(init?.headers);
    const body = init?.body ? Buffer.from(init.body as ArrayBuffer) : Buffer.alloc(0);
    const session = url.searchParams.get('session') ?? '';
    requests.push({ path: url.pathname, session, bytes: body.length });
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
  globalThis.fetch = async (input, init) => {
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
