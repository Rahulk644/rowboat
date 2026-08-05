#!/usr/bin/env node

/**
 * Install a contributor-signed Rowboat meeting build without touching the
 * release copy in /Applications.  TCC permissions are bound to the signed
 * code's designated requirement, so the source must pass the stable-identity
 * gate before this script will place it in the user's Applications directory.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { verifyMeetingPackage } from './verify_meeting_package.mjs';

const DEFAULT_APP_NAME = 'Rowboat Meetings Dev.app';
const STAGING_DIRECTORY = '.rowboat-meeting-staging';
const BACKUP_DIRECTORY = '.rowboat-meeting-backups';

function usage() {
  return 'Usage: install_contributor_macos.mjs --app /absolute/path/to/Rowboat.app [--destination /absolute/path] [--replace]';
}

export function parseArguments(argv) {
  let app;
  let destination;
  let replace = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--app' && !app && argv[index + 1]) {
      app = argv[index + 1];
      index += 1;
    } else if (argument === '--destination' && !destination && argv[index + 1]) {
      destination = argv[index + 1];
      index += 1;
    } else if (argument === '--replace' && !replace) {
      replace = true;
    } else {
      throw new Error(usage());
    }
  }

  if (!app || !path.isAbsolute(app)) {
    throw new Error(app ? 'The app path must be absolute' : usage());
  }
  if (destination && !path.isAbsolute(destination)) throw new Error('The destination path must be absolute');
  return { app: path.resolve(app), destination: destination ? path.resolve(destination) : undefined, replace };
}

/**
 * Contributor builds stay under the current user's Applications directory.
 * This avoids replacing a release copy under /Applications and makes the
 * separate local signing identity visible to the user in System Settings.
 */
export function resolveContributorDestination(destination, home) {
  if (!home || !path.isAbsolute(home)) throw new Error('A valid absolute HOME directory is required');
  const applications = path.join(path.resolve(home), 'Applications');
  const candidate = path.resolve(destination ?? path.join(applications, DEFAULT_APP_NAME));
  const relative = path.relative(applications, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Contributor builds must install below ${applications}`);
  }
  if (path.dirname(candidate) !== applications || path.extname(candidate) !== '.app') {
    throw new Error('The contributor destination must be a direct .app bundle inside ~/Applications');
  }
  return candidate;
}

export function installPaths(destination) {
  const applications = path.dirname(destination);
  const stem = path.basename(destination, '.app');
  return {
    stagingDirectory: path.join(applications, STAGING_DIRECTORY),
    backupDirectory: path.join(applications, BACKUP_DIRECTORY),
    stagingPrefix: `${stem}-staged-`,
    backupPrefix: `${stem}-replaced-`,
  };
}

function mustBeBundleDirectory(candidate, label) {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.extname(candidate) !== '.app') {
    throw new Error(`${label} must be a non-symlink .app bundle directory`);
  }
}

function unusedBundlePath(directory, prefix) {
  for (let sequence = 0; sequence < 100; sequence += 1) {
    const suffix = `${Date.now()}-${process.pid}-${sequence}.app`;
    const candidate = path.join(directory, `${prefix}${suffix}`);
    if (!fs.existsSync(candidate) && !fs.lstatSync(directory).isSymbolicLink()) return candidate;
  }
  throw new Error(`Could not allocate a unique bundle path in ${directory}`);
}

function runDitto(source, destination) {
  const copied = spawnSync('/usr/bin/ditto', [source, destination], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (copied.error) throw copied.error;
  if (copied.status !== 0) {
    throw new Error(`ditto failed (${copied.status ?? 'unknown'}): ${`${copied.stdout ?? ''}${copied.stderr ?? ''}`.trim()}`);
  }
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe install directory: ${directory}`);
}

/** Unlike existsSync, this treats a dangling symlink as an occupied target. */
function filesystemEntryExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertStablePackage(app, verify) {
  mustBeBundleDirectory(app, 'Source Rowboat app');
  return verify(app, { requireContributorBuild: true, requireStableTccIdentity: true });
}

export function installContributorBuild(
  { app, destination, replace },
  {
    home = process.env.HOME,
    verify = verifyMeetingPackage,
    copy = runDitto,
    platform = process.platform,
  } = {},
) {
  if (platform !== 'darwin') throw new Error('Contributor TCC installation is available only on macOS');
  const resolvedDestination = resolveContributorDestination(destination, home);
  const source = path.resolve(app);
  if (source === resolvedDestination) throw new Error('Source and contributor destination must be different bundles');

  const sourceVerification = assertStablePackage(source, verify);
  ensureDirectory(path.dirname(resolvedDestination));
  const destinationExists = filesystemEntryExists(resolvedDestination);
  if (destinationExists && !replace) {
    throw new Error(`Destination already exists: ${resolvedDestination}. Re-run with --replace to move that prior contributor build to a recoverable backup.`);
  }
  if (destinationExists) mustBeBundleDirectory(resolvedDestination, 'Existing contributor destination');

  const locations = installPaths(resolvedDestination);
  ensureDirectory(locations.stagingDirectory);
  const staging = unusedBundlePath(locations.stagingDirectory, locations.stagingPrefix);
  copy(source, staging);
  // Copy first and validate the copied bundle before moving an existing build.
  const installedVerification = assertStablePackage(staging, verify);

  let backup;
  if (destinationExists) {
    ensureDirectory(locations.backupDirectory);
    backup = unusedBundlePath(locations.backupDirectory, locations.backupPrefix);
    fs.renameSync(resolvedDestination, backup);
  }
  try {
    fs.renameSync(staging, resolvedDestination);
  } catch (error) {
    // The old application is recoverable even if the final atomic move fails.
    if (backup && !filesystemEntryExists(resolvedDestination)) fs.renameSync(backup, resolvedDestination);
    throw error;
  }
  const finalVerification = assertStablePackage(resolvedDestination, verify);
  return {
    destination: resolvedDestination,
    replacedBackup: backup,
    sourceSigning: sourceVerification.signing,
    installedSigning: installedVerification.signing,
    finalSigning: finalVerification.signing,
  };
}

export function executeCli(
  argv,
  {
    install = installContributorBuild,
    stdout = (line) => process.stdout.write(line),
    stderr = (line) => process.stderr.write(line),
  } = {},
) {
  try {
    const result = install(parseArguments(argv));
    stdout(
      `Installed contributor Rowboat at ${result.destination}\n`
      + (result.replacedBackup ? `Previous contributor build moved to ${result.replacedBackup}\n` : '')
      + `TeamIdentifier: ${result.finalSigning.teamIdentifier}\n`
      + 'Open this exact bundle from Finder, then grant permissions to this contributor-signed Rowboat entry once.\n',
    );
    return 0;
  } catch (error) {
    stderr(`Rowboat contributor installation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = executeCli(process.argv.slice(2));
}
