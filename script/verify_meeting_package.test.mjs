import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  executeCli,
  meetingPackageLayout,
  parseArguments,
  requireStableTccIdentity,
} from './verify_meeting_package.mjs';

test('meeting package layout is fixed beneath the Rowboat bundle resources', () => {
  const app = path.resolve('/tmp/Rowboat.app');
  assert.deepEqual(meetingPackageLayout(app), {
    infoPlist: '/tmp/Rowboat.app/Contents/Info.plist',
    mainExecutable: '/tmp/Rowboat.app/Contents/MacOS/rowboat',
    bridge: '/tmp/Rowboat.app/Contents/Resources/meeting-bridge/darwin/meeting-bridge',
    contributorMarker: '/tmp/Rowboat.app/Contents/Resources/meeting-contributor-build.json',
    helperExecutables: [
      '/tmp/Rowboat.app/Contents/Frameworks/Rowboat Helper.app/Contents/MacOS/Rowboat Helper',
      '/tmp/Rowboat.app/Contents/Frameworks/Rowboat Helper (GPU).app/Contents/MacOS/Rowboat Helper (GPU)',
      '/tmp/Rowboat.app/Contents/Frameworks/Rowboat Helper (Plugin).app/Contents/MacOS/Rowboat Helper (Plugin)',
      '/tmp/Rowboat.app/Contents/Frameworks/Rowboat Helper (Renderer).app/Contents/MacOS/Rowboat Helper (Renderer)',
    ],
  });
  const contributorLayout = meetingPackageLayout('/tmp/Rowboat Meetings Dev.app', true);
  assert.equal(
    contributorLayout.mainExecutable,
    '/tmp/Rowboat Meetings Dev.app/Contents/MacOS/Rowboat Meetings Dev',
  );
  assert.deepEqual(contributorLayout.helperExecutables, [
    '/tmp/Rowboat Meetings Dev.app/Contents/Frameworks/Rowboat Meetings Dev Helper.app/Contents/MacOS/Rowboat Meetings Dev Helper',
    '/tmp/Rowboat Meetings Dev.app/Contents/Frameworks/Rowboat Meetings Dev Helper (GPU).app/Contents/MacOS/Rowboat Meetings Dev Helper (GPU)',
    '/tmp/Rowboat Meetings Dev.app/Contents/Frameworks/Rowboat Meetings Dev Helper (Plugin).app/Contents/MacOS/Rowboat Meetings Dev Helper (Plugin)',
    '/tmp/Rowboat Meetings Dev.app/Contents/Frameworks/Rowboat Meetings Dev Helper (Renderer).app/Contents/MacOS/Rowboat Meetings Dev Helper (Renderer)',
  ]);
});

test('CLI carries the explicit LocalVQE verification requirement into package verification', () => {
  let received;
  const output = [];
  const exitCode = executeCli(['--app', '/Applications/Rowboat.app', '--require-localvqe-aec'], {
    verify: (app, options) => {
      received = { app, options };
      return {
        bundleId: 'com.rowboat.app',
        bridge: '/Applications/Rowboat.app/Contents/Resources/meeting-bridge/darwin/meeting-bridge',
        localVqeAssets: { library: '/Applications/Rowboat.app/Contents/Resources/meeting-bridge/darwin/liblocalvqe.0.1.0.dylib' },
        signing: {
          authority: ['Developer ID Application: Example'],
          designatedRequirement: 'identifier "com.rowboat.app" and anchor apple generic and certificate leaf[subject.OU] = TEAMID',
          teamIdentifier: 'TEAMID',
          adHoc: false,
        },
      };
    },
    stdout: (line) => output.push(line),
    stderr: (line) => { throw new Error(`unexpected stderr: ${line}`); },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(received, {
    app: '/Applications/Rowboat.app',
    options: { requireContributorBuild: false, requireLocalVqeAec: true, requireStableTccIdentity: false },
  });
  assert.match(output.join(''), /Verified LocalVQE assets/);
});

test('package verifier carries the stable TCC requirement into package verification', () => {
  let received;
  const exitCode = executeCli([
    '--require-stable-tcc-identity',
    '--app',
    '/Applications/Rowboat.app',
  ], {
    verify: (app, options) => {
      received = { app, options };
      return {
        bundleId: 'com.rowboat.app',
        bridge: '/Applications/Rowboat.app/Contents/Resources/meeting-bridge/darwin/meeting-bridge',
        signing: {
          authority: ['Apple Development: Example'],
          designatedRequirement: 'identifier "com.rowboat.app" and anchor apple generic and certificate leaf[subject.OU] = TEAMID',
          teamIdentifier: 'TEAMID',
          adHoc: false,
        },
      };
    },
    stdout: () => {},
    stderr: (line) => { throw new Error(`unexpected stderr: ${line}`); },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(received, {
    app: '/Applications/Rowboat.app',
    options: { requireContributorBuild: false, requireLocalVqeAec: false, requireStableTccIdentity: true },
  });
});

test('stable TCC identity rejects a build-specific ad-hoc requirement', () => {
  assert.throws(
    () => requireStableTccIdentity({
      authority: ['ad-hoc'],
      designatedRequirement: 'cdhash H"abc123"',
      teamIdentifier: 'not set',
      adHoc: true,
    }),
    /ad-hoc signed/,
  );
});

test('package verifier accepts one absolute app argument and independent gates', () => {
  assert.deepEqual(parseArguments(['--app', '/Applications/Rowboat.app']), {
    app: '/Applications/Rowboat.app',
    requireContributorBuild: false,
    requireLocalVqeAec: false,
    requireStableTccIdentity: false,
  });
  assert.deepEqual(parseArguments(['--app', '/Applications/Rowboat.app', '--require-localvqe-aec']), {
    app: '/Applications/Rowboat.app',
    requireContributorBuild: false,
    requireLocalVqeAec: true,
    requireStableTccIdentity: false,
  });
  assert.deepEqual(parseArguments(['--require-stable-tcc-identity', '--app', '/Applications/Rowboat.app']), {
    app: '/Applications/Rowboat.app',
    requireContributorBuild: false,
    requireLocalVqeAec: false,
    requireStableTccIdentity: true,
  });
  assert.deepEqual(parseArguments(['--require-contributor-build', '--app', '/tmp/Rowboat.app']), {
    app: '/tmp/Rowboat.app',
    requireContributorBuild: true,
    requireLocalVqeAec: false,
    requireStableTccIdentity: false,
  });
  assert.throws(() => parseArguments([]), /Usage/);
  assert.throws(() => parseArguments(['--app', 'relative.app']), /absolute/);
  assert.throws(() => parseArguments(['--app', '/one.app', '--extra']), /Usage/);
});
