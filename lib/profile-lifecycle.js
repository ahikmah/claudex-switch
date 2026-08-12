'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_PROFILE_NAMES = new Set([
  'add',
  'current',
  'doctor',
  'help',
  'list',
  'reauth',
  'delete',
  'deactivate',
  'rename',
  'use',
]);

function createProfileLifecycle(options = {}) {
  const filesystem = options.filesystem || fs;
  const activeDir = options.activeDir;
  const profilesDir = options.profilesDir;
  const stateFile = options.stateFile || path.join(profilesDir || '', 'active-profile');
  const withProxyStopped = options.withProxyStopped || ((work) => work());
  const login = options.login || (() => {
    throw new Error('Codex login is not configured.');
  });

  if (!activeDir || !profilesDir) {
    throw new Error('Profile storage directories are required.');
  }

  function ensureDir(directory) {
    filesystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      filesystem.chmodSync(directory, 0o700);
    } catch {
      // Some systems do not support chmod on all file systems.
    }
  }

  function profileDir(name) {
    return path.join(profilesDir, name);
  }

  function normalizeName(name) {
    return name.toLowerCase();
  }

  function validateProfileName(name) {
    if (typeof name !== 'string' || !PROFILE_NAME_PATTERN.test(name)) {
      throw new Error('Use only letters, numbers, dot, underscore, or hyphen in the Profile name.');
    }
    if (RESERVED_PROFILE_NAMES.has(normalizeName(name))) {
      throw new Error(`Profile name is reserved: ${name}`);
    }
  }

  function readActiveProfile() {
    try {
      return filesystem.readFileSync(stateFile, 'utf8').trim();
    } catch {
      return '';
    }
  }

  function writeActiveProfile(name) {
    ensureDir(profilesDir);
    filesystem.writeFileSync(stateFile, `${name}\n`, { mode: 0o600 });
    try {
      filesystem.chmodSync(stateFile, 0o600);
    } catch {
      // Some systems do not support chmod on all file systems.
    }
  }

  function profileDirectories() {
    ensureDir(profilesDir);
    return filesystem.readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  }

  function findExistingProfile(name) {
    if (typeof name !== 'string') return null;
    return profileDirectories().find((candidate) => normalizeName(candidate) === normalizeName(name)) || null;
  }

  function profileNameInUse(name) {
    const existing = findExistingProfile(name);
    if (existing) return existing;
    const current = readActiveProfile();
    return current && normalizeName(current) === normalizeName(name) ? current : null;
  }

  function credentialFiles(directory) {
    if (!filesystem.existsSync(directory)) return [];
    return filesystem.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith('codex-') && entry.name.endsWith('.json'))
      .map((entry) => path.join(directory, entry.name));
  }

  function moveCredential(file, destinationDir) {
    ensureDir(destinationDir);
    filesystem.renameSync(file, path.join(destinationDir, path.basename(file)));
  }

  function profileCredentialFile(name) {
    const current = readActiveProfile();
    const activeFiles = credentialFiles(activeDir);
    const actualName = findExistingProfile(name) || name;
    const currentName = findExistingProfile(current) || current;
    const directory = current && normalizeName(actualName) === normalizeName(currentName) && activeFiles.length === 1
      ? activeDir
      : profileDir(actualName);
    const files = credentialFiles(directory);
    return files.length === 1 ? files[0] : null;
  }

  function profileEmail(name) {
    const file = profileCredentialFile(name);
    if (!file) return 'email unavailable';
    try {
      const data = JSON.parse(filesystem.readFileSync(file, 'utf8'));
      return typeof data.email === 'string' && data.email ? data.email : 'email unavailable';
    } catch {
      return 'email unavailable';
    }
  }

  function requireExistingProfile(name) {
    validateProfileName(name);
    const existing = findExistingProfile(name);
    if (!existing) throw new Error(`Unknown Profile: ${name}`);
    return existing;
  }

  function listProfiles(io) {
    ensureDir(activeDir);
    ensureDir(profilesDir);
    const current = readActiveProfile();
    const names = profileDirectories();
    if (current && !names.some((name) => normalizeName(name) === normalizeName(current))) {
      names.push(current);
    }
    names.sort();

    if (names.length === 0) {
      io.stdout('No saved Profiles.');
      return;
    }

    const activeFiles = credentialFiles(activeDir);
    for (const name of names) {
      const active = Boolean(current) && normalizeName(name) === normalizeName(current);
      const count = active && activeFiles.length === 1 ? 1 : credentialFiles(profileDir(name)).length;
      io.stdout(`${active ? '*' : ' '} ${name} (${profileEmail(name)}, ${count} credential)`);
    }
  }

  function useProfile(name, io) {
    const targetName = requireExistingProfile(name);
    const targetDir = profileDir(targetName);
    const targetFiles = credentialFiles(targetDir);
    const activeFiles = credentialFiles(activeDir);
    const current = readActiveProfile();
    const currentName = findExistingProfile(current) || current;

    if (targetFiles.length !== 1) {
      throw new Error(`Profile '${targetName}' must contain exactly one Codex Credential.`);
    }
    if (activeFiles.length > 1) {
      throw new Error('More than one active Codex Credential exists.');
    }
    if (current && normalizeName(currentName) === normalizeName(targetName) && activeFiles.length === 1) {
      io.stdout(`Already active: ${targetName}`);
      return;
    }
    if (activeFiles.length === 1 && !current) {
      throw new Error('The active Credential is not registered.');
    }

    withProxyStopped(() => {
      if (activeFiles.length === 1) {
        const currentDir = profileDir(currentName);
        if (credentialFiles(currentDir).length !== 0) {
          throw new Error(`Current Profile '${currentName}' already contains a Credential.`);
        }
        moveCredential(activeFiles[0], currentDir);
      }
      moveCredential(targetFiles[0], activeDir);
      writeActiveProfile(targetName);
    });
    io.stdout(`Active Profile: ${targetName}`);
  }

  function addProfile(name, io) {
    validateProfileName(name);
    if (profileNameInUse(name)) {
      throw new Error(`Profile name already exists: ${name}`);
    }
    const targetDir = profileDir(name);
    const current = readActiveProfile();
    const currentName = findExistingProfile(current) || current;
    const activeFiles = credentialFiles(activeDir);

    if (activeFiles.length > 1) {
      throw new Error('More than one active Codex Credential exists.');
    }
    if (activeFiles.length === 1 && !current) {
      throw new Error('The active Credential is not registered.');
    }

    ensureDir(targetDir);
    try {
      withProxyStopped(() => {
        if (activeFiles.length === 1) {
          const currentDir = profileDir(currentName);
          if (credentialFiles(currentDir).length !== 0) {
            throw new Error(`Current Profile '${currentName}' already contains a Credential.`);
          }
          moveCredential(activeFiles[0], currentDir);
        }

        io.stdout(`Starting Codex login for Profile: ${name}`);
        login();

        const newFiles = credentialFiles(activeDir);
        if (newFiles.length !== 1) {
          throw new Error('Login did not create exactly one Codex Credential.');
        }
        moveCredential(newFiles[0], targetDir);
        moveCredential(credentialFiles(targetDir)[0], activeDir);
        writeActiveProfile(name);
      });
    } catch (error) {
      const currentDir = currentName ? profileDir(currentName) : '';
      const restoreFiles = currentDir ? credentialFiles(currentDir) : [];
      if (restoreFiles.length === 1 && credentialFiles(activeDir).length === 0) {
        moveCredential(restoreFiles[0], activeDir);
        if (current) writeActiveProfile(currentName);
      }
      try {
        if (credentialFiles(targetDir).length === 0) filesystem.rmdirSync(targetDir);
      } catch {
        // Keep a non-empty Profile for manual recovery.
      }
      throw error;
    }
    io.stdout(`Active Profile: ${name}`);
  }

  function renameProfile(oldName, newName, io) {
    validateProfileName(oldName);
    validateProfileName(newName);
    const existingOldName = requireExistingProfile(oldName);
    if (profileNameInUse(newName)) {
      throw new Error(`Profile name already exists: ${newName}`);
    }
    filesystem.renameSync(profileDir(existingOldName), profileDir(newName));
    if (normalizeName(readActiveProfile()) === normalizeName(existingOldName)) {
      writeActiveProfile(newName);
    }
    io.stdout(`Renamed Profile ${oldName} to ${newName}`);
  }

  function usage(io) {
    io.stdout(`Usage:
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

  function run(argv, io = { stdout: console.log, stderr: console.error }) {
    ensureDir(activeDir);
    ensureDir(profilesDir);
    const [command, first, second] = argv;

    try {
      if (!command || command === 'help' || command === '--help' || command === '-h') {
        usage(io);
        return 0;
      }
      if (command === 'list') {
        listProfiles(io);
        return 0;
      }
      if (command === 'current') {
        const current = readActiveProfile();
        if (!current) throw new Error('No active Profile is recorded.');
        io.stdout(current);
        return 0;
      }
      if (command === 'use' && first) {
        useProfile(first, io);
        return 0;
      }
      if (command === 'add' && first) {
        addProfile(first, io);
        return 0;
      }
      if (command === 'rename' && first && second) {
        renameProfile(first, second, io);
        return 0;
      }
      throw new Error('Invalid command. Use --help for usage.');
    } catch (error) {
      io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  return { run };
}

module.exports = { createProfileLifecycle };
