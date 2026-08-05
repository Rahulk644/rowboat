import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeCli,
  installPaths,
  parseArguments,
  resolveContributorDestination,
} from './install_contributor_macos.mjs';

const home = '/Users/contributor';

test('contributor installer defaults to a separate per-user Applications bundle', () => {
  assert.equal(
    resolveContributorDestination(undefined, home),
    '/Users/contributor/Applications/Rowboat Meetings Dev.app',
  );
  assert.deepEqual(
    installPaths('/Users/contributor/Applications/Rowboat Meetings Dev.app'),
    {
      stagingDirectory: '/Users/contributor/Applications/.rowboat-meeting-staging',
      backupDirectory: '/Users/contributor/Applications/.rowboat-meeting-backups',
      stagingPrefix: 'Rowboat Meetings Dev-staged-',
      backupPrefix: 'Rowboat Meetings Dev-replaced-',
    },
  );
});

test('contributor installer refuses the system Applications directory and nested destinations', () => {
  assert.throws(
    () => resolveContributorDestination('/Applications/Rowboat.app', home),
    /must install below/,
  );
  assert.throws(
    () => resolveContributorDestination('/Users/contributor/Applications/Meeting/Rowboat.app', home),
    /direct .app bundle/,
  );
  assert.throws(
    () => resolveContributorDestination('/Users/contributor/Applications/Rowboat', home),
    /direct .app bundle/,
  );
});

test('contributor installer parses only deliberate replacement requests', () => {
  assert.deepEqual(
    parseArguments([
      '--app',
      '/private/tmp/Rowboat.app',
      '--destination',
      '/Users/contributor/Applications/Rowboat Meetings Dev.app',
      '--replace',
    ]),
    {
      app: '/private/tmp/Rowboat.app',
      destination: '/Users/contributor/Applications/Rowboat Meetings Dev.app',
      replace: true,
    },
  );
  assert.throws(() => parseArguments(['--app', 'relative.app']), /absolute/);
  assert.throws(() => parseArguments(['--app', '/private/tmp/Rowboat.app', '--remove']), /Usage/);
});

test('CLI reports the exact installed contributor identity without launching it', () => {
  const output = [];
  const exitCode = executeCli(['--app', '/private/tmp/Rowboat.app'], {
    install: (options) => {
      assert.deepEqual(options, {
        app: '/private/tmp/Rowboat.app',
        destination: undefined,
        replace: false,
      });
      return {
        destination: '/Users/contributor/Applications/Rowboat Meetings Dev.app',
        replacedBackup: undefined,
        finalSigning: { teamIdentifier: 'TEAMID' },
      };
    },
    stdout: (line) => output.push(line),
    stderr: (line) => { throw new Error(`unexpected stderr: ${line}`); },
  });
  assert.equal(exitCode, 0);
  assert.match(output.join(''), /Rowboat Meetings Dev.app/);
  assert.match(output.join(''), /TeamIdentifier: TEAMID/);
});
