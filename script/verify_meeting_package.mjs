#!/usr/bin/env node

/**
 * Validate the meeting-capable Rowboat macOS bundle without starting Electron.
 * This checks the app bundle that receives Accessibility, not a temporary
 * generic Electron development process.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE_NAME = 'meeting-bridge';
const RELEASE_BUNDLE_ID = 'com.rowboat.app';
const CONTRIBUTOR_BUNDLE_ID = 'com.rowboat.meetings-dev';
const LOCALVQE_AEC_200K_MODEL_SHA256 =
  'b6e43138588a83bfe903ab5e143b4020b91c1e1629f5a575ac5855ff0003c731';

export function parseArguments(argv) {
  let app;
  let requireLocalVqeAec = false;
  let requireStableTccIdentity = false;
  let requireContributorBuild = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--app' && !app && argv[index + 1]) {
      app = argv[index + 1];
      index += 1;
    } else if (argument === '--require-localvqe-aec') {
      requireLocalVqeAec = true;
    } else if (argument === '--require-stable-tcc-identity') {
      requireStableTccIdentity = true;
    } else if (argument === '--require-contributor-build') {
      requireContributorBuild = true;
    } else {
      throw new Error(
        'Usage: verify_meeting_package.mjs --app /absolute/path/to/Rowboat.app [--require-contributor-build] [--require-localvqe-aec] [--require-stable-tcc-identity]',
      );
    }
  }

  if (!app) {
    throw new Error(
      'Usage: verify_meeting_package.mjs --app /absolute/path/to/Rowboat.app [--require-contributor-build] [--require-localvqe-aec] [--require-stable-tcc-identity]',
    );
  }
  if (!path.isAbsolute(app)) throw new Error('The app path must be absolute');
  return { app: path.resolve(app), requireContributorBuild, requireLocalVqeAec, requireStableTccIdentity };
}

function localVqePackageLayout(app) {
  const bridgeDirectory = path.dirname(meetingPackageLayout(app).bridge);
  return Object.freeze({
    library: path.join(bridgeDirectory, 'liblocalvqe.0.1.0.dylib'),
    model: path.join(bridgeDirectory, 'localvqe-v1.4-aec-200K-f32.gguf'),
    apacheLicense: path.join(bridgeDirectory, 'licenses', 'APACHE-2.0.txt'),
    localVqeNotice: path.join(bridgeDirectory, 'licenses', 'LOCALVQE-NOTICE.txt'),
    webRtcLicense: path.join(bridgeDirectory, 'licenses', 'WEBRTC-AEC3-BSD-3-CLAUSE.txt'),
    thirdPartyNotices: path.join(bridgeDirectory, 'licenses', 'THIRD_PARTY_NOTICES.md'),
  });
}

export function meetingPackageLayout(app, contributorBuild = false) {
  const contents = path.join(app, 'Contents');
  return Object.freeze({
    infoPlist: path.join(contents, 'Info.plist'),
    mainExecutable: path.join(contents, 'MacOS', contributorBuild ? 'Rowboat Meetings Dev' : 'rowboat'),
    bridge: path.join(contents, 'Resources', BRIDGE_NAME, 'darwin', BRIDGE_NAME),
    contributorMarker: path.join(contents, 'Resources', 'meeting-contributor-build.json'),
  });
}

function requireRegularExecutable(file, label) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
  fs.accessSync(file, fs.constants.X_OK);
}

function requireRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
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

function command(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    throw new Error(`${path.basename(executable)} failed (${result.status ?? 'unknown'}): ${output.trim()}`);
  }
  return output;
}

function signingDetails(app) {
  // `codesign -d` deliberately writes its report to stderr. Capture both
  // streams so the physical qualification log says exactly which authority
  // and designated requirement macOS will evaluate for Accessibility.
  const report = command('/usr/bin/codesign', ['-dvvv', '-r-', app]);
  const authority = [...report.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim());
  const designatedRequirement = report.match(/^designated\s*=>\s*(.+)$/mi)?.[1]?.trim()
    ?? 'not reported';
  const teamIdentifier = report.match(/^TeamIdentifier=(.+)$/mi)?.[1]?.trim()
    ?? 'not set';
  const adHoc = /^Signature=adhoc$/mi.test(report)
    || /\bcdhash\b/i.test(designatedRequirement)
    || teamIdentifier === 'not set';
  return {
    authority: authority.length ? authority : [adHoc ? 'ad-hoc' : 'unavailable'],
    designatedRequirement,
    teamIdentifier,
    adHoc,
  };
}

/**
 * Screen Recording and other TCC decisions are keyed to the app's designated
 * requirement. An ad-hoc signature has a cdhash requirement, so changing code
 * yields a new identity and cannot reliably retain the previous approval.
 *
 * This is deliberately a verification gate rather than an attempt to copy or
 * edit TCC state. Only a persistent, Apple-team signing identity is safe to
 * present as an install that should retain privacy approvals across updates.
 */
export function requireStableTccIdentity(signing) {
  if (signing.adHoc || /\bcdhash\b/i.test(signing.designatedRequirement)) {
    throw new Error(
      'This Rowboat bundle is ad-hoc signed and has a build-specific designated requirement. '
      + 'Use ROWBOAT_LOCAL_SIGNING_IDENTITY with an Apple Development or Developer ID Application certificate.',
    );
  }
  if (!signing.teamIdentifier || signing.teamIdentifier === 'not set') {
    throw new Error(
      'This Rowboat bundle has no TeamIdentifier. A stable TCC install requires an Apple Development or Developer ID Application signing identity.',
    );
  }
}

export function verifyMeetingPackage(app, {
  requireContributorBuild = false,
  requireLocalVqeAec = false,
  requireStableTccIdentity: requireStableTcc = false,
} = {}) {
  const layout = meetingPackageLayout(app, requireContributorBuild);
  const appStat = fs.statSync(app);
  if (!appStat.isDirectory() || path.extname(app) !== '.app') throw new Error('Expected a Rowboat .app bundle');
  for (const file of [layout.infoPlist, layout.mainExecutable, layout.bridge]) {
    if (!fs.existsSync(file)) throw new Error(`Required packaged resource is missing: ${file}`);
  }
  requireRegularExecutable(layout.mainExecutable, 'Rowboat executable');
  requireRegularExecutable(layout.bridge, 'Meeting bridge');

  const bundleId = command('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleIdentifier', layout.infoPlist]).trim();
  const expectedBundleId = requireContributorBuild ? CONTRIBUTOR_BUNDLE_ID : RELEASE_BUNDLE_ID;
  if (bundleId !== expectedBundleId) {
    throw new Error(`Unexpected Rowboat bundle identifier: ${bundleId || '(empty)'}`);
  }
  if (requireContributorBuild) {
    requireRegularFile(layout.contributorMarker, 'Contributor build marker');
    const marker = JSON.parse(fs.readFileSync(layout.contributorMarker, 'utf8'));
    if (marker?.schemaVersion !== 1 || marker?.kind !== 'rowboat-meetings-contributor') {
      throw new Error('Contributor build marker is invalid');
    }
  }

  // The bridge is an independently executed nested binary, so check it
  // directly as well as the outer app's sealed resource tree.
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  command('/usr/bin/codesign', ['--verify', '--strict', layout.bridge]);
  const localVqeAssets = requireLocalVqeAec ? localVqePackageLayout(app) : undefined;
  if (localVqeAssets) {
    for (const file of [
      localVqeAssets.library,
      localVqeAssets.model,
      localVqeAssets.apacheLicense,
      localVqeAssets.localVqeNotice,
      localVqeAssets.webRtcLicense,
      localVqeAssets.thirdPartyNotices,
    ]) {
      if (!fs.existsSync(file)) throw new Error(`Required packaged LocalVQE asset is missing: ${file}`);
    }
    requireRegularExecutable(localVqeAssets.library, 'LocalVQE dylib');
    requireRegularFile(localVqeAssets.model, 'LocalVQE model');
    for (const file of [localVqeAssets.apacheLicense, localVqeAssets.localVqeNotice, localVqeAssets.webRtcLicense, localVqeAssets.thirdPartyNotices]) {
      requireRegularFile(file, 'AEC third-party notice');
    }
    if (sha256File(localVqeAssets.model) !== LOCALVQE_AEC_200K_MODEL_SHA256) {
      throw new Error('Packaged LocalVQE model checksum does not match the reviewed asset');
    }
    if (!fs.readFileSync(localVqeAssets.apacheLicense, 'utf8').includes('Apache License')) {
      throw new Error('Packaged Apache-2.0 license text is invalid');
    }
    if (!fs.readFileSync(localVqeAssets.localVqeNotice, 'utf8').includes('Richard Sherwood Palethorpe')) {
      throw new Error('Packaged LocalVQE attribution notice is invalid');
    }
    if (!fs.readFileSync(localVqeAssets.webRtcLicense, 'utf8').includes('The WebRTC project authors')) {
      throw new Error('Packaged WebRTC BSD-3-Clause notice is invalid');
    }
    command('/usr/bin/codesign', ['--verify', '--strict', localVqeAssets.library]);
  }
  const signing = signingDetails(app);
  if (requireStableTcc) requireStableTccIdentity(signing);
  return { bundleId, ...layout, ...(localVqeAssets ? { localVqeAssets } : {}), signing };
}

export function executeCli(
  argv,
  {
    verify = verifyMeetingPackage,
    stdout = (line) => process.stdout.write(line),
    stderr = (line) => process.stderr.write(line),
  } = {},
) {
  try {
    const { app, requireContributorBuild, requireLocalVqeAec, requireStableTccIdentity: requireStableTcc } = parseArguments(argv);
    const result = verify(app, { requireContributorBuild, requireLocalVqeAec, requireStableTccIdentity: requireStableTcc });
    stdout(
      `Verified ${result.bundleId}\n${result.bridge}\n`
      + (result.localVqeAssets ? `Verified LocalVQE assets: ${result.localVqeAssets.library}\n` : '')
      + `Authority: ${result.signing.authority.join(' | ')}\n`
      + `TeamIdentifier: ${result.signing.teamIdentifier}\n`
      + `Designated requirement: ${result.signing.designatedRequirement}\n`,
    );
    return 0;
  } catch (error) {
    stderr(`Rowboat meeting package verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = executeCli(process.argv.slice(2));
}
