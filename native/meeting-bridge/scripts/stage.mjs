#!/usr/bin/env node

/**
 * Build and stage the meeting bridge for an Electron Forge package.
 *
 * This deliberately accepts only the platform/architecture tuples Forge
 * supports for the alpha. Cargo is spawned with an argument vector, never a
 * shell command, so package parameters cannot become shell syntax.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_NAME = 'meeting-bridge';

const TARGETS = Object.freeze({
  darwin: Object.freeze({ arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }),
  win32: Object.freeze({ arm64: 'aarch64-pc-windows-msvc', x64: 'x86_64-pc-windows-msvc' }),
  linux: Object.freeze({ arm64: 'aarch64-unknown-linux-gnu', x64: 'x86_64-unknown-linux-gnu' }),
});

export function bridgeBinaryName(platform) {
  if (platform === 'win32') return `${BRIDGE_NAME}.exe`;
  if (platform === 'darwin' || platform === 'linux') return BRIDGE_NAME;
  throw new Error(`Unsupported meeting bridge platform: ${String(platform)}`);
}

export function bridgeTarget(platform, arch) {
  const target = TARGETS[platform]?.[arch];
  if (!target) {
    throw new Error(`Unsupported meeting bridge target: ${String(platform)}/${String(arch)}`);
  }
  return target;
}

export function bridgeFeatures(platform) {
  // The macOS alpha package must carry the bounded Anarlog compatibility
  // boundary. The feature never grants Accessibility permission by itself.
  return platform === 'darwin' ? ['anarlog-ax'] : [];
}

export function bridgeBuildPlan({ platform, arch, repositoryRoot, outputRoot }) {
  if (!path.isAbsolute(repositoryRoot) || !path.isAbsolute(outputRoot)) {
    throw new Error('repositoryRoot and outputRoot must be absolute paths');
  }
  const target = bridgeTarget(platform, arch);
  const binary = bridgeBinaryName(platform);
  const manifestPath = path.join(repositoryRoot, 'native', 'meeting-bridge', 'Cargo.toml');
  const features = bridgeFeatures(platform);
  const cargoArgs = [
    'build',
    '--locked',
    '--release',
    '--manifest-path', manifestPath,
    '--target', target,
    ...(features.length ? ['--features', features.join(',')] : []),
  ];
  const source = path.join(
    repositoryRoot,
    'native',
    'meeting-bridge',
    'target',
    target,
    'release',
    binary,
  );
  const destinationDirectory = path.join(outputRoot, BRIDGE_NAME, platform);
  return Object.freeze({
    platform,
    arch,
    target,
    binary,
    cargoArgs: Object.freeze(cargoArgs),
    source,
    destination: path.join(destinationDirectory, binary),
  });
}

/** Build through Cargo and stage exactly one platform executable. */
export function stageMeetingBridge(options) {
  const plan = bridgeBuildPlan(options);
  const runCargo = options.runCargo ?? execFileSync;
  runCargo('cargo', plan.cargoArgs, {
    cwd: options.repositoryRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (!fs.existsSync(plan.source)) {
    throw new Error(`Cargo completed without producing ${plan.source}`);
  }
  fs.mkdirSync(path.dirname(plan.destination), { recursive: true });
  fs.copyFileSync(plan.source, plan.destination);
  if (plan.platform !== 'win32') fs.chmodSync(plan.destination, 0o755);
  return plan;
}

export function parseStageArguments(argv) {
  const values = new Map();
  const supported = new Set(['--platform', '--arch', '--repository-root', '--output-root']);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!supported.has(key)) throw new Error(`Unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
    index += 1;
  }
  const platform = values.get('--platform');
  const arch = values.get('--arch');
  const repositoryRoot = values.get('--repository-root');
  const outputRoot = values.get('--output-root');
  if (!platform || !arch || !repositoryRoot || !outputRoot) {
    throw new Error('Required: --platform, --arch, --repository-root, --output-root');
  }
  return { platform, arch, repositoryRoot, outputRoot };
}

function invokedAsCli() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (invokedAsCli()) {
  try {
    const plan = stageMeetingBridge(parseStageArguments(process.argv.slice(2)));
    process.stdout.write(`Staged ${plan.binary} for ${plan.platform}/${plan.arch} at ${plan.destination}${os.EOL}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`meeting-bridge staging failed: ${message}${os.EOL}`);
    process.exitCode = 1;
  }
}
