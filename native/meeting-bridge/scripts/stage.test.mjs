import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bridgeBinaryName,
  bridgeBuildPlan,
  parseStageArguments,
  provisionMesonPackageCache,
  stageMeetingBridge,
} from './stage.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('build plans use a fixed target map and enable Anarlog only on macOS', () => {
  const repositoryRoot = path.resolve('repo');
  const outputRoot = path.resolve('stage', 'resources');
  const mac = bridgeBuildPlan({
    platform: 'darwin', arch: 'arm64', repositoryRoot, outputRoot,
  });
  assert.equal(mac.target, 'aarch64-apple-darwin');
  assert.deepEqual(mac.cargoArgs.slice(-2), ['--features', 'anarlog-ax']);
  assert.equal(mac.destination, path.join(outputRoot, 'meeting-bridge', 'darwin', 'meeting-bridge'));

  const aecMac = bridgeBuildPlan({
    platform: 'darwin', arch: 'arm64', repositoryRoot, outputRoot, aecAlpha: true,
  });
  assert.deepEqual(aecMac.cargoArgs.slice(-2), ['--features', 'anarlog-ax,aec-localvqe,aec-webrtc-aec3']);

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
  assert.throws(
    () => bridgeBuildPlan({ platform: 'linux', arch: 'x64', repositoryRoot, outputRoot, aecAlpha: true }),
    /currently supported only on darwin/,
  );
  assert.throws(() => bridgeBinaryName('../darwin'), /Unsupported meeting bridge platform/);
});

test('AEC staging refuses unreviewed assets before invoking Cargo', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-bridge-aec-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'repo');
  const outputRoot = path.join(root, 'package', 'resources');
  const plan = bridgeBuildPlan({
    platform: 'darwin', arch: 'arm64', repositoryRoot, outputRoot, aecAlpha: true,
  });
  fs.mkdirSync(path.dirname(plan.source), { recursive: true });
  fs.writeFileSync(plan.source, 'bridge binary');
  const library = path.join(root, 'liblocalvqe.0.1.0.dylib');
  const model = path.join(root, 'unreviewed.gguf');
  fs.writeFileSync(library, 'not a Mach-O; checksum validation covers the model only');
  fs.writeFileSync(model, 'not the reviewed model');

  let cargoCalled = false;
  assert.throws(
    () => stageMeetingBridge({
      platform: 'darwin',
      arch: 'arm64',
      repositoryRoot,
      outputRoot,
      aecAlpha: true,
      localVqeLibraryPath: library,
      localVqeModelPath: model,
      runCargo: () => { cargoCalled = true; },
    }),
    /checksum/,
  );
  assert.equal(cargoCalled, false);
});

test('Meson package cache downloads exact pinned artifacts once and reuses verified files offline', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-bridge-meson-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const artifacts = [
    { filename: 'source.tar.gz', url: 'https://example.invalid/source', sha256: sha256('source') },
    { filename: 'patch.zip', url: 'https://example.invalid/patch', sha256: sha256('patch') },
  ];
  const cacheDirectory = path.join(root, 'target', 'meson-package-cache');
  const calls = [];
  const downloader = (url, destination) => {
    calls.push(url);
    fs.writeFileSync(destination, url.endsWith('/source') ? 'source' : 'patch');
  };

  assert.equal(provisionMesonPackageCache({ cacheDirectory, artifacts, download: downloader }), cacheDirectory);
  assert.equal(calls.length, 2);
  assert.equal(fs.readFileSync(path.join(cacheDirectory, 'source.tar.gz'), 'utf8'), 'source');
  assert.equal(fs.readFileSync(path.join(cacheDirectory, 'patch.zip'), 'utf8'), 'patch');

  assert.equal(provisionMesonPackageCache({
    cacheDirectory,
    artifacts,
    download: () => { throw new Error('offline cache should not download'); },
  }), cacheDirectory);
});

test('Meson package cache rejects a bad download before it can enter the reusable cache', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-bridge-meson-bad-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheDirectory = path.join(root, 'target', 'meson-package-cache');
  const artifacts = [{ filename: 'source.tar.gz', url: 'https://example.invalid/source', sha256: sha256('expected') }];
  assert.throws(
    () => provisionMesonPackageCache({
      cacheDirectory,
      artifacts,
      download: (_url, destination) => fs.writeFileSync(destination, 'tampered'),
    }),
    /checksum mismatch/,
  );
  assert.equal(fs.existsSync(path.join(cacheDirectory, 'source.tar.gz')), false);
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
