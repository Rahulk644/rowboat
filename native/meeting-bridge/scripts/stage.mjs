#!/usr/bin/env node

/**
 * Build and stage the meeting bridge for an Electron Forge package.
 *
 * This deliberately accepts only the platform/architecture tuples Forge
 * supports for the alpha. Cargo is spawned with an argument vector, never a
 * shell command, so package parameters cannot become shell syntax.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_NAME = 'meeting-bridge';
export const LOCALVQE_AEC_200K_MODEL_SHA256 =
  'b6e43138588a83bfe903ab5e143b4020b91c1e1629f5a575ac5855ff0003c731';
export const LOCALVQE_LIBRARY_RESOURCE = 'liblocalvqe.0.1.0.dylib';
export const LOCALVQE_MODEL_RESOURCE = 'localvqe-v1.4-aec-200K-f32.gguf';
// Exact Meson wrap artifacts required by webrtc-audio-processing-sys 2.1.0.
// Keep these in a target-local cache, never in the source tree or package.
export const WEBRTC_AEC3_MESON_ARTIFACTS = Object.freeze([
  Object.freeze({
    filename: 'abseil-cpp-20240722.0.tar.gz',
    url: 'https://github.com/abseil/abseil-cpp/releases/download/20240722.0/abseil-cpp-20240722.0.tar.gz',
    sha256: 'f50e5ac311a81382da7fa75b97310e4b9006474f9560ac46f54a9967f07d4ae3',
  }),
  Object.freeze({
    filename: 'abseil-cpp_20240722.0-3_patch.zip',
    url: 'https://wrapdb.mesonbuild.com/v2/abseil-cpp_20240722.0-3/get_patch',
    sha256: '12dd8df1488a314c53e3751abd2750cf233b830651d168b6a9f15e7d0cf71f7b',
  }),
]);

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

export function bridgeFeatures(platform, aecAlpha = false) {
  // The macOS alpha package must carry the bounded Anarlog compatibility
  // boundary. The feature never grants Accessibility permission by itself.
  if (platform !== 'darwin') return [];
  return aecAlpha ? ['anarlog-ax', 'aec-localvqe', 'aec-webrtc-aec3'] : ['anarlog-ax'];
}

export function bridgeBuildPlan({ platform, arch, repositoryRoot, outputRoot, aecAlpha = false }) {
  if (!path.isAbsolute(repositoryRoot) || !path.isAbsolute(outputRoot)) {
    throw new Error('repositoryRoot and outputRoot must be absolute paths');
  }
  const target = bridgeTarget(platform, arch);
  const binary = bridgeBinaryName(platform);
  const manifestPath = path.join(repositoryRoot, 'native', 'meeting-bridge', 'Cargo.toml');
  if (aecAlpha && platform !== 'darwin') {
    throw new Error('LocalVQE AEC asset staging is currently supported only on darwin');
  }
  const features = bridgeFeatures(platform, aecAlpha);
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
    aecAlpha,
    target,
    binary,
    cargoArgs: Object.freeze(cargoArgs),
    source,
    destination: path.join(destinationDirectory, binary),
  });
}

function canonicalRegularFile(candidate, label) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path`);
  }
  let canonical;
  try {
    canonical = fs.realpathSync.native(candidate);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  const stat = fs.statSync(canonical);
  if (!stat.isFile()) throw new Error(`${label} must resolve to a regular file`);
  return canonical;
}

function sha256File(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function regularFileWithSha256(file, sha256) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && sha256File(file) === sha256;
  } catch {
    return false;
  }
}

function downloadMesonArtifact(url, destination) {
  execFileSync('/usr/bin/curl', [
    '--fail',
    '--location',
    '--proto', '=https',
    '--tlsv1.2',
    '--connect-timeout', '15',
    '--max-time', '120',
    '--output', destination,
    url,
  ], { shell: false, stdio: 'ignore' });
}

/**
 * Populate `MESON_PACKAGE_CACHE_DIR` with only the exact artifacts named by
 * the audited abseil-cpp Meson wrap. Existing verified files are reused
 * offline. A failed/mismatched download never reaches the cache path.
 */
export function provisionMesonPackageCache({
  cacheDirectory,
  artifacts = WEBRTC_AEC3_MESON_ARTIFACTS,
  download = downloadMesonArtifact,
}) {
  if (!path.isAbsolute(cacheDirectory)) {
    throw new Error('Meson package cache directory must be absolute');
  }
  fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact.filename !== 'string' || typeof artifact.url !== 'string'
      || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')
      || path.basename(artifact.filename) !== artifact.filename || !artifact.url.startsWith('https://')) {
      throw new Error('Invalid pinned Meson cache artifact');
    }
    const destination = path.join(cacheDirectory, artifact.filename);
    if (regularFileWithSha256(destination, artifact.sha256)) continue;
    // A stale partial cache is target-local/reproducible build output, never
    // user input. Remove it before atomically replacing it with verified data.
    fs.rmSync(destination, { force: true });
    const temporary = path.join(cacheDirectory, `.${artifact.filename}.${process.pid}.${randomUUID()}.download`);
    try {
      download(artifact.url, temporary);
      if (!regularFileWithSha256(temporary, artifact.sha256)) {
        throw new Error(`Meson artifact checksum mismatch: ${artifact.filename}`);
      }
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, destination);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to provision verified Meson artifact ${artifact.filename}: ${message}`);
    }
  }
  return cacheDirectory;
}

function validateMacOsDylib(library, arch) {
  if (process.platform !== 'darwin') {
    throw new Error('LocalVQE AEC assets must be staged on a macOS signing host');
  }
  if (path.extname(library) !== '.dylib') throw new Error('LocalVQE dylib must use the .dylib extension');
  const description = execFileSync('/usr/bin/file', ['-b', library], {
    encoding: 'utf8',
    shell: false,
  });
  if (!description.includes('Mach-O') || !description.includes('dynamically linked shared library')) {
    throw new Error('LocalVQE dylib is not a Mach-O dynamic library');
  }
  const requiredArchitecture = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x86_64' : undefined;
  if (!requiredArchitecture) throw new Error(`Unsupported LocalVQE dylib architecture: ${String(arch)}`);
  const availableArchitectures = execFileSync('/usr/bin/lipo', ['-archs', library], {
    encoding: 'utf8',
    shell: false,
  }).trim().split(/\s+/);
  if (!availableArchitectures.includes(requiredArchitecture)) {
    throw new Error(`LocalVQE dylib lacks the required ${requiredArchitecture} architecture`);
  }
}

/**
 * Stage only the reviewed LocalVQE AEC test assets. This path is intentionally
 * opt-in and rejects arbitrary model bytes before Cargo starts. The model
 * remains a data resource; Forge discovers and signs the Mach-O dylib as a
 * nested code object when it packages the enclosing Rowboat.app.
 */
export function stageLocalVqeAssets({ libraryPath, modelPath, destinationDirectory, arch }) {
  if (!path.isAbsolute(destinationDirectory)) {
    throw new Error('LocalVQE destinationDirectory must be absolute');
  }
  const library = canonicalRegularFile(libraryPath, 'LocalVQE dylib');
  const model = canonicalRegularFile(modelPath, 'LocalVQE model');
  const actualSha256 = sha256File(model);
  if (actualSha256 !== LOCALVQE_AEC_200K_MODEL_SHA256) {
    throw new Error('LocalVQE model checksum does not match the reviewed v1.4-AEC 200K asset');
  }
  validateMacOsDylib(library, arch);
  const destination = path.resolve(destinationDirectory);
  fs.mkdirSync(destination, { recursive: true });
  const stagedLibrary = path.join(destination, LOCALVQE_LIBRARY_RESOURCE);
  const stagedModel = path.join(destination, LOCALVQE_MODEL_RESOURCE);
  fs.copyFileSync(library, stagedLibrary);
  fs.copyFileSync(model, stagedModel);
  fs.chmodSync(stagedLibrary, 0o755);
  fs.chmodSync(stagedModel, 0o644);
  return Object.freeze({ library: stagedLibrary, model: stagedModel });
}

/** Build through Cargo and stage the helper plus explicit checked AEC assets. */
export function stageMeetingBridge(options) {
  const plan = bridgeBuildPlan(options);
  const localVqeAssets = plan.aecAlpha
    ? stageLocalVqeAssets({
        libraryPath: options.localVqeLibraryPath,
        modelPath: options.localVqeModelPath,
        destinationDirectory: path.dirname(plan.destination),
        arch: plan.arch,
      })
    : undefined;
  const mesonPackageCache = plan.aecAlpha
    ? provisionMesonPackageCache({
        cacheDirectory: path.join(
          options.repositoryRoot,
          'native',
          'meeting-bridge',
          'target',
          'meson-package-cache',
          plan.target,
        ),
        ...(options.provisionMesonPackageCache ? { download: options.provisionMesonPackageCache } : {}),
      })
    : undefined;
  const runCargo = options.runCargo ?? execFileSync;
  runCargo('cargo', plan.cargoArgs, {
    cwd: options.repositoryRoot,
    stdio: 'inherit',
    shell: false,
    ...(mesonPackageCache ? { env: { ...process.env, MESON_PACKAGE_CACHE_DIR: mesonPackageCache } } : {}),
  });
  if (!fs.existsSync(plan.source)) {
    throw new Error(`Cargo completed without producing ${plan.source}`);
  }
  fs.mkdirSync(path.dirname(plan.destination), { recursive: true });
  fs.copyFileSync(plan.source, plan.destination);
  if (plan.platform !== 'win32') fs.chmodSync(plan.destination, 0o755);
  let licenseFiles;
  if (plan.aecAlpha) {
    const licenseDirectory = path.join(path.dirname(plan.destination), 'licenses');
    const notices = [
      ['APACHE-2.0.txt', path.join(options.repositoryRoot, 'LICENSE')],
      ['LOCALVQE-NOTICE.txt', path.join(options.repositoryRoot, 'native', 'meeting-bridge', 'vendor', 'localvqe', 'NOTICE.txt')],
      ['WEBRTC-AEC3-BSD-3-CLAUSE.txt', path.join(options.repositoryRoot, 'native', 'meeting-bridge', 'vendor', 'webrtc-aec3', 'LICENSE')],
      ['THIRD_PARTY_NOTICES.md', path.join(options.repositoryRoot, 'native', 'meeting-bridge', 'THIRD_PARTY_NOTICES.md')],
    ];
    fs.mkdirSync(licenseDirectory, { recursive: true });
    licenseFiles = notices.map(([name, source]) => {
      const canonical = canonicalRegularFile(source, `${name} source`);
      const destination = path.join(licenseDirectory, name);
      fs.copyFileSync(canonical, destination);
      fs.chmodSync(destination, 0o644);
      return destination;
    });
  }
  return Object.freeze({
    ...plan,
    ...(localVqeAssets ? { localVqeAssets } : {}),
    ...(mesonPackageCache ? { mesonPackageCache } : {}),
    ...(licenseFiles ? { licenseFiles: Object.freeze(licenseFiles) } : {}),
  });
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
    const plan = stageMeetingBridge({
      ...parseStageArguments(process.argv.slice(2)),
      aecAlpha: process.env.ROWBOAT_MEETING_AEC_ALPHA === '1',
      localVqeLibraryPath: process.env.ROWBOAT_LOCALVQE_DYLIB_PATH,
      localVqeModelPath: process.env.ROWBOAT_LOCALVQE_MODEL_PATH,
    });
    process.stdout.write(`Staged ${plan.binary} for ${plan.platform}/${plan.arch} at ${plan.destination}${os.EOL}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`meeting-bridge staging failed: ${message}${os.EOL}`);
    process.exitCode = 1;
  }
}
