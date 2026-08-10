#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const home = os.homedir();
const activeDir = process.env.CLIPROXY_AUTH_DIR || path.join(home, '.cli-proxy-api');
const profilesDir = process.env.CLAUDEX_ACCOUNT_DIR || path.join(home, '.cli-proxy-api-accounts');
const stateFile = path.join(profilesDir, 'active-profile');
const serviceName = process.env.CLAUDEX_PROXY_SERVICE_NAME || 'cliproxyapi';
const cliproxyapiBin = process.env.CLIPROXYAPI_BIN || 'cliproxyapi';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

function validName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Some systems do not support chmod on all file systems.
  }
}

function profileDir(name) {
  return path.join(profilesDir, name);
}

function credentialFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith('codex-') && entry.name.endsWith('.json'))
    .map((entry) => path.join(dir, entry.name));
}

function readActiveProfile() {
  try {
    return fs.readFileSync(stateFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeActiveProfile(name) {
  ensureDir(profilesDir);
  fs.writeFileSync(stateFile, `${name}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(stateFile, 0o600);
  } catch {
    // Some systems do not support chmod on all file systems.
  }
}

function moveCredential(file, destinationDir) {
  ensureDir(destinationDir);
  fs.renameSync(file, path.join(destinationDir, path.basename(file)));
}

function profileCredentialFile(name) {
  const current = readActiveProfile();
  const activeFiles = credentialFiles(activeDir);
  const dir = name === current && activeFiles.length === 1 ? activeDir : profileDir(name);
  const files = credentialFiles(dir);
  return files.length === 1 ? files[0] : null;
}

function profileEmail(name) {
  const file = profileCredentialFile(name);
  if (!file) return 'email unavailable';
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof data.email === 'string' && data.email ? data.email : 'email unavailable';
  } catch {
    return 'email unavailable';
  }
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function serviceMode() {
  const configured = (process.env.CLAUDEX_PROXY_SERVICE || 'auto').toLowerCase();
  if (['none', 'off', 'disabled'].includes(configured)) return 'none';
  if (configured === 'brew' || configured === 'homebrew') return 'brew';
  if (['systemd', 'systemctl'].includes(configured)) return 'systemd';
  if (configured !== 'auto') throw new Error(`Unsupported CLAUDEX_PROXY_SERVICE: ${configured}`);

  if (process.platform === 'darwin' && commandExists('brew')) return 'brew';
  if (commandExists('systemctl')) return 'systemd';
  return 'none';
}

function runService(mode, action) {
  if (mode === 'none') return;

  const args = mode === 'brew'
    ? ['services', action, serviceName]
    : ['--user', action, serviceName];
  const command = mode === 'brew' ? 'brew' : 'systemctl';
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

function withProxyStopped(work) {
  const mode = serviceMode();
  if (mode === 'none') {
    console.warn('Proxy restart is disabled or no supported service manager was found.');
    return work();
  }

  console.log(`Stopping CLIProxyAPI with ${mode}...`);
  runService(mode, 'stop');
  try {
    return work();
  } finally {
    runService(mode, 'start');
  }
}

function resolveConfigFile() {
  if (process.env.CLIPROXY_CONFIG) return process.env.CLIPROXY_CONFIG;
  const candidates = [
    '/opt/homebrew/etc/cliproxyapi.conf',
    '/usr/local/etc/cliproxyapi.conf',
    path.join(home, '.config', 'cliproxyapi.conf'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function login() {
  const args = [];
  const configFile = resolveConfigFile();
  if (configFile) args.push('--config', configFile);
  args.push('--codex-login');

  const result = spawnSync(cliproxyapiBin, args, { stdio: 'inherit' });
  if (result.error) throw new Error(`Cannot run ${cliproxyapiBin}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${cliproxyapiBin} login failed`);
}

function listAccounts() {
  ensureDir(activeDir);
  ensureDir(profilesDir);
  const current = readActiveProfile();
  const names = fs.readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
  if (current && !names.includes(current)) names.push(current);
  names.sort();

  if (names.length === 0) {
    console.log('No saved accounts.');
    return;
  }

  const activeCount = credentialFiles(activeDir).length;
  for (const name of names) {
    const active = name === current;
    const count = active && activeCount === 1 ? 1 : credentialFiles(profileDir(name)).length;
    console.log(`${active ? '*' : ' '} ${name} (${profileEmail(name)}, ${count} credential)`);
  }
}

function useAccount(name) {
  if (!validName(name)) throw new Error('Invalid account name.');
  const targetDir = profileDir(name);
  const targetFiles = credentialFiles(targetDir);
  const activeFiles = credentialFiles(activeDir);
  const current = readActiveProfile();

  if (!fs.existsSync(targetDir)) throw new Error(`Unknown account profile: ${name}`);
  if (targetFiles.length !== 1) throw new Error(`Profile '${name}' must contain exactly one Codex credential.`);
  if (activeFiles.length > 1) throw new Error('More than one active Codex credential exists.');
  if (current === name && activeFiles.length === 1) {
    console.log(`Already active: ${name}`);
    return;
  }
  if (activeFiles.length === 1 && !current) {
    throw new Error('The active credential is not registered.');
  }

  withProxyStopped(() => {
    if (activeFiles.length === 1) {
      const currentDir = profileDir(current);
      if (credentialFiles(currentDir).length !== 0) {
        throw new Error(`Current profile '${current}' already contains a credential.`);
      }
      moveCredential(activeFiles[0], currentDir);
    }
    moveCredential(targetFiles[0], activeDir);
    writeActiveProfile(name);
  });
  console.log(`Active account: ${name}`);
}

function addAccount(name) {
  if (!validName(name)) throw new Error('Use only letters, numbers, dot, underscore, or hyphen in the name.');
  const targetDir = profileDir(name);
  const current = readActiveProfile();
  const activeFiles = credentialFiles(activeDir);

  if (fs.existsSync(targetDir)) throw new Error(`Account profile already exists: ${name}`);
  if (activeFiles.length > 1) throw new Error('More than one active Codex credential exists.');
  if (activeFiles.length === 1 && !current) throw new Error('The active account is not registered.');

  ensureDir(targetDir);
  try {
    withProxyStopped(() => {
      if (activeFiles.length === 1) {
        const currentDir = profileDir(current);
        if (credentialFiles(currentDir).length !== 0) {
          throw new Error(`Current profile '${current}' already contains a credential.`);
        }
        moveCredential(activeFiles[0], currentDir);
      }

      console.log(`Starting Codex login for profile: ${name}`);
      login();

      const newFiles = credentialFiles(activeDir);
      if (newFiles.length !== 1) throw new Error('Login did not create exactly one Codex credential.');
      moveCredential(newFiles[0], targetDir);
      moveCredential(credentialFiles(targetDir)[0], activeDir);
      writeActiveProfile(name);
    });
  } catch (error) {
    const currentDir = current ? profileDir(current) : '';
    const restoreFiles = currentDir ? credentialFiles(currentDir) : [];
    if (restoreFiles.length === 1 && credentialFiles(activeDir).length === 0) {
      moveCredential(restoreFiles[0], activeDir);
      if (current) writeActiveProfile(current);
    }
    try {
      if (credentialFiles(targetDir).length === 0) fs.rmdirSync(targetDir);
    } catch {
      // Keep a non-empty profile for manual recovery.
    }
    throw error;
  }
  console.log(`Active account: ${name}`);
}

function renameAccount(oldName, newName) {
  if (!validName(oldName) || !validName(newName)) throw new Error('Invalid account name.');
  const oldDir = profileDir(oldName);
  const newDir = profileDir(newName);
  if (!fs.existsSync(oldDir)) throw new Error(`Unknown account profile: ${oldName}`);
  if (fs.existsSync(newDir)) throw new Error(`Account profile already exists: ${newName}`);
  fs.renameSync(oldDir, newDir);
  if (readActiveProfile() === oldName) writeActiveProfile(newName);
  console.log(`Renamed ${oldName} to ${newName}`);
}

function usage() {
  console.log(`Usage:
  claudex-switch list
  claudex-switch current
  claudex-switch use NAME
  claudex-switch add NAME
  claudex-switch rename OLD_NAME NEW_NAME

Environment:
  CLAUDEX_PROXY_SERVICE=auto|brew|systemd|none
  CLAUDEX_PROXY_SERVICE_NAME=cliproxyapi
  CLIPROXY_CONFIG=/path/to/cliproxyapi.conf
  CLIPROXY_AUTH_DIR=/path/to/auth-dir
  CLAUDEX_ACCOUNT_DIR=/path/to/profile-dir
  CLIPROXYAPI_BIN=cliproxyapi`);
}

function main(argv) {
  ensureDir(activeDir);
  ensureDir(profilesDir);
  const [command, first, second] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }
  if (command === 'list') return listAccounts();
  if (command === 'current') {
    const current = readActiveProfile();
    if (!current) throw new Error('No active account profile is recorded.');
    console.log(current);
    return;
  }
  if (command === 'use' && first) return useAccount(first);
  if (command === 'add' && first) return addAccount(first);
  if (command === 'rename' && first && second) return renameAccount(first, second);
  throw new Error('Invalid command. Use --help for usage.');
}

try {
  main(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
