import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MEETING_STT_KEYCHAIN_SERVICE = 'com.myassistant.desktop.meeting-transcription';
export const MEETING_STT_KEYCHAIN_ACCOUNT = 'private-server';
export const DEFAULT_MEETING_STT_URL = 'http://127.0.0.1:18091';

export type MeetingCredentialSource = 'environment' | 'config-file' | 'keychain' | 'missing' | 'invalid';

type MeetingCredentialOptions = {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  fileExists?: (file: string) => boolean;
  lstat?: (file: string) => fs.Stats;
  readFile?: (file: string) => string;
  readKeychain?: (service: string, account: string) => string | null;
};

function complete(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment.ROWBOAT_MEETING_STT_URL && environment.ROWBOAT_MEETING_STT_TOKEN);
}

function partial(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment.ROWBOAT_MEETING_STT_URL || environment.ROWBOAT_MEETING_STT_TOKEN);
}

function parseOwnerOnlyConfig(contents: string): Record<'ROWBOAT_MEETING_STT_URL' | 'ROWBOAT_MEETING_STT_TOKEN', string> | null {
  const values: Partial<Record<'ROWBOAT_MEETING_STT_URL' | 'ROWBOAT_MEETING_STT_TOKEN', string>> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    const key = separator < 0 ? '' : line.slice(0, separator);
    if (key !== 'ROWBOAT_MEETING_STT_URL' && key !== 'ROWBOAT_MEETING_STT_TOKEN') return null;
    if (values[key] !== undefined) return null;
    values[key] = line.slice(separator + 1);
  }
  if (!values.ROWBOAT_MEETING_STT_URL || !values.ROWBOAT_MEETING_STT_TOKEN) return null;
  return values as Record<'ROWBOAT_MEETING_STT_URL' | 'ROWBOAT_MEETING_STT_TOKEN', string>;
}

function readMacOsKeychain(service: string, account: string): string | null {
  try {
    const value = execFileSync('/usr/bin/security', [
      'find-generic-password', '-s', service, '-a', account, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Populate Electron main's private process environment from an explicitly
 * exported pair, an owner-only local file, or the exact existing Keychain
 * credential. This module never exposes the token to an IPC payload or logs.
 * It deliberately treats partial/malformed configuration as invalid rather
 * than combining values from different trust sources.
 */
export function initializeMeetingTranscriptionCredentials(
  options: MeetingCredentialOptions = {},
): MeetingCredentialSource {
  const environment = options.environment ?? process.env;
  if (complete(environment)) return 'environment';
  if (partial(environment)) return 'invalid';

  const homeDirectory = options.homeDirectory ?? os.homedir();
  const configPath = environment.ROWBOAT_MEETING_CONFIG_FILE
    ?? path.join(homeDirectory, '.rowboat', 'config', 'meeting-transcription.env');
  const fileExists = options.fileExists ?? fs.existsSync;
  const lstat = options.lstat ?? fs.lstatSync;
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'));
  if (fileExists(configPath)) {
    try {
      const stat = lstat(configPath);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return 'invalid';
      const values = parseOwnerOnlyConfig(readFile(configPath));
      if (!values) return 'invalid';
      environment.ROWBOAT_MEETING_STT_URL = values.ROWBOAT_MEETING_STT_URL;
      environment.ROWBOAT_MEETING_STT_TOKEN = values.ROWBOAT_MEETING_STT_TOKEN;
      return 'config-file';
    } catch {
      return 'invalid';
    }
  }

  if ((options.platform ?? process.platform) !== 'darwin') return 'missing';
  const token = (options.readKeychain ?? readMacOsKeychain)(
    MEETING_STT_KEYCHAIN_SERVICE,
    MEETING_STT_KEYCHAIN_ACCOUNT,
  );
  if (!token) return 'missing';
  environment.ROWBOAT_MEETING_STT_URL = DEFAULT_MEETING_STT_URL;
  environment.ROWBOAT_MEETING_STT_TOKEN = token;
  return 'keychain';
}
