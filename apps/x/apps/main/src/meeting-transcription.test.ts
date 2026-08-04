import assert from 'node:assert/strict';
import test from 'node:test';
import { SelfHostedMeetingTranscription, loadSelfHostedMeetingConfig } from './meeting-transcription.js';

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
