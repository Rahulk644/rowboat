import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bridgeBinaryName,
  bridgeBuildPlan,
  parseStageArguments,
  stageMeetingBridge,
} from './stage.mjs';

test('build plans use a fixed target map and enable Anarlog only on macOS', () => {
  const repositoryRoot = path.resolve('repo');
  const outputRoot = path.resolve('stage', 'resources');
  const mac = bridgeBuildPlan({
    platform: 'darwin', arch: 'arm64', repositoryRoot, outputRoot,
  });
  assert.equal(mac.target, 'aarch64-apple-darwin');
  assert.deepEqual(mac.cargoArgs.slice(-2), ['--features', 'anarlog-ax']);
  assert.equal(mac.destination, path.join(outputRoot, 'meeting-bridge', 'darwin', 'meeting-bridge'));

  const windows = bridgeBuildPlan({
    platform: 'win32', arch: 'x64', repositoryRoot, outputRoot,
  });
  assert.equal(windows.target, 'x86_64-pc-windows-msvc');
  assert.equal(windows.binary, 'meeting-bridge.exe');
  assert.ok(!windows.cargoArgs.includes('--features'));
  assert.equal(windows.destination, path.join(outputRoot, 'meeting-bridge', 'win32', 'meeting-bridge.exe'));

  assert.throws(
    () => bridgeBuildPlan({ platform: 'freebsd', arch: 'x64', repositoryRoot, outputRoot }),
    /Unsupported meeting bridge target/,
  );
  assert.throws(() => bridgeBinaryName('../darwin'), /Unsupported meeting bridge platform/);
});

test('staging copies only the planned binary and does not invoke a shell', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-bridge-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'repo');
  const outputRoot = path.join(root, 'package', 'resources');
  const plan = bridgeBuildPlan({ platform: 'linux', arch: 'x64', repositoryRoot, outputRoot });
  fs.mkdirSync(path.dirname(plan.source), { recursive: true });
  fs.writeFileSync(plan.source, 'bridge binary');

  let command;
  let args;
  let options;
  const staged = stageMeetingBridge({
    platform: 'linux',
    arch: 'x64',
    repositoryRoot,
    outputRoot,
    runCargo: (nextCommand, nextArgs, nextOptions) => {
      command = nextCommand;
      args = nextArgs;
      options = nextOptions;
    },
  });

  assert.equal(command, 'cargo');
  assert.deepEqual(args, plan.cargoArgs);
  assert.equal(options.shell, false);
  assert.equal(staged.destination, plan.destination);
  assert.equal(fs.readFileSync(plan.destination, 'utf8'), 'bridge binary');
});

test('CLI parser rejects duplicate, unknown, and missing arguments', () => {
  assert.deepEqual(
    parseStageArguments([
      '--platform', 'darwin', '--arch', 'arm64', '--repository-root', '/repo', '--output-root', '/stage',
    ]),
    { platform: 'darwin', arch: 'arm64', repositoryRoot: '/repo', outputRoot: '/stage' },
  );
  assert.throws(() => parseStageArguments(['--platform', 'darwin']), /Required/);
  assert.throws(() => parseStageArguments(['--platform', 'darwin', '--wat', 'no']), /Unknown/);
  assert.throws(
    () => parseStageArguments([
      '--platform', 'darwin', '--platform', 'linux', '--arch', 'arm64', '--repository-root', '/repo', '--output-root', '/stage',
    ]),
    /Duplicate/,
  );
});
