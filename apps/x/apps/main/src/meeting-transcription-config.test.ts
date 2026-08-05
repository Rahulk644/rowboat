import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MEETING_STT_URL,
  initializeMeetingTranscriptionCredentials,
  MEETING_STT_KEYCHAIN_ACCOUNT,
  MEETING_STT_KEYCHAIN_SERVICE,
} from './meeting-transcription-config.js';

const TOKEN = '0123456789abcdef0123456789abcdef';

test('normal packaged launch loads the exact private-server Keychain credential without a wrapper environment', () => {
  const environment: NodeJS.ProcessEnv = {};
  let requested: [string, string] | undefined;
  const source = initializeMeetingTranscriptionCredentials({
    environment,
    platform: 'darwin',
    homeDirectory: '/missing-home',
    fileExists: () => false,
    readKeychain: (service, account) => {
      requested = [service, account];
      return TOKEN;
    },
  });
  assert.equal(source, 'keychain');
  assert.deepEqual(requested, [MEETING_STT_KEYCHAIN_SERVICE, MEETING_STT_KEYCHAIN_ACCOUNT]);
  assert.equal(environment.ROWBOAT_MEETING_STT_URL, DEFAULT_MEETING_STT_URL);
  assert.equal(environment.ROWBOAT_MEETING_STT_TOKEN, TOKEN);
});

test('an exported credential pair wins and partial configuration never mixes with Keychain data', () => {
  const completeEnvironment: NodeJS.ProcessEnv = {
    ROWBOAT_MEETING_STT_URL: 'http://127.0.0.1:18091',
    ROWBOAT_MEETING_STT_TOKEN: TOKEN,
  };
  assert.equal(initializeMeetingTranscriptionCredentials({
    environment: completeEnvironment,
    readKeychain: () => { throw new Error('must not read Keychain'); },
  }), 'environment');

  const partialEnvironment: NodeJS.ProcessEnv = { ROWBOAT_MEETING_STT_URL: 'http://127.0.0.1:18091' };
  assert.equal(initializeMeetingTranscriptionCredentials({
    environment: partialEnvironment,
    readKeychain: () => TOKEN,
  }), 'invalid');
  assert.equal(partialEnvironment.ROWBOAT_MEETING_STT_TOKEN, undefined);
});
