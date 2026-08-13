'use strict';

const crypto = require('node:crypto');
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
const LOCK_FILE_NAME = '.operation.lock';
const TRANSACTION_FILE_NAME = '.transaction.json';
const TRANSACTION_SCHEMA_VERSION = 1;
const INSPECTION_SCHEMA_VERSION = 1;
const PROFILE_MUTATION_OPERATIONS = new Set([
  'add',
  'deactivate',
  'delete',
  'reauth',
  'rename',
  'use',
]);
const LOCK_OPERATIONS = new Set([...PROFILE_MUTATION_OPERATIONS, 'doctor --repair']);

function createProfileLifecycle(options = {}) {
  const filesystem = options.filesystem || fs;
  const activeDir = options.activeDir;
  const profilesDir = options.profilesDir;
  const stateFile = options.stateFile || path.join(profilesDir || '', 'active-profile');
  const lockFile = options.lockFile || path.join(profilesDir || '', LOCK_FILE_NAME);
  const transactionFile = options.transactionFile || path.join(profilesDir || '', TRANSACTION_FILE_NAME);
  const withProxyStopped = options.withProxyStopped || ((work) => work());
  const proxyService = options.proxyService || null;
  const isSessionRunning = options.isSessionRunning || options.sessionCheck || (() => false);
  const isProcessRunning = options.isProcessRunning || ((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error && error.code === 'ESRCH') return false;
      if (error && error.code === 'EPERM') return true;
      throw error;
    }
  });
  const confirmProfileDeletion = options.confirmProfileDeletion || (() => {
    throw invalidInputError('Interactive Profile deletion is not configured. Use --yes to confirm deletion.');
  });
  const login = options.login || (() => {
    throw new Error('Codex login is not configured.');
  });
  const operationLock = options.operationLock || {
    acquire: (command) => acquireOperationLockFile(command),
  };
  const recoveryStore = options.recoveryStore || {
    read: () => readTransactionFile(),
    write: (transaction) => writeTransactionFile(transaction),
    remove: () => removeTransactionFile(),
  };

  if (!activeDir || !profilesDir) {
    throw new Error('Profile storage directories are required.');
  }

  function pathExists(target) {
    try {
      filesystem.lstatSync(target);
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  function ensureDir(directory) {
    if (!pathExists(directory)) {
      filesystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const stats = filesystem.lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw unsafeStateError(`Unsafe Profile storage: ${directory} must be a real directory.`);
    }
    try {
      filesystem.chmodSync(directory, 0o700);
    } catch {
      // Some systems do not support chmod on all file systems.
    }
  }

  function ensureOperationLockDirectory() {
    if (!pathExists(profilesDir)) {
      filesystem.mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
    }
    const stats = filesystem.lstatSync(profilesDir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw unsafeStateError(`Unsafe Profile storage: ${profilesDir} must be a real directory.`);
    }
  }

  function assertRegularFile(file, description) {
    if (!pathExists(file)) return;
    const stats = filesystem.lstatSync(file);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw unsafeStateError(`Unsafe Profile storage: ${description} must be a regular file.`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw unsafeStateError(`Unsafe Profile storage: ${description} must be private.`);
    }
  }

  function assertPrivateMode(stats, description) {
    if ((stats.mode & 0o077) !== 0) {
      throw unsafeStateError(`Unsafe Profile storage: ${description} must be private.`);
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
      throw invalidInputError('Use only letters, numbers, dot, underscore, or hyphen in the Profile name.');
    }
    if (RESERVED_PROFILE_NAMES.has(normalizeName(name))) {
      throw invalidInputError(`Profile name is reserved: ${name}`);
    }
  }

  function validateStoredProfileName(name) {
    try {
      validateProfileName(name);
    } catch {
      throw unsafeStateError(`Stored Profile name is invalid: ${name}`);
    }
  }

  function readActiveProfile() {
    try {
      return filesystem.readFileSync(stateFile, 'utf8').trim();
    } catch {
      return '';
    }
  }

  function writePrivateJson(file, value) {
    filesystem.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try {
      filesystem.chmodSync(file, 0o600);
    } catch {
      // Some systems do not support chmod on all file systems.
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
    const names = filesystem.readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
    const seen = new Map();
    for (const name of names) {
      const normalized = normalizeName(name);
      if (seen.has(normalized)) {
        throw unsafeStateError(`Profile names conflict without case differences: ${seen.get(normalized)}, ${name}. Manual resolution is required.`);
      }
      seen.set(normalized, name);
    }
    return names;
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
    if (!pathExists(directory)) return [];
    return filesystem.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith('codex-') && entry.name.endsWith('.json'))
      .map((entry) => path.join(directory, entry.name));
  }

  function credentialFileName(file) {
    return path.basename(file);
  }

  function isCredentialFileName(name) {
    return name.startsWith('codex-') && name.endsWith('.json');
  }

  function validateCredentialFile(file) {
    try {
      const data = JSON.parse(filesystem.readFileSync(file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
      if (typeof data.email !== 'string' || !data.email) throw new Error('missing email');
      return data;
    } catch (error) {
      const reason = error && error.message === 'missing email'
        ? 'is missing a Provider account email'
        : 'is malformed';
      throw unsafeStateError(`Credential file ${credentialFileName(file)} ${reason}.`);
    }
  }

  function validateGeneratedCredentialFile(file, label) {
    let stats;
    try {
      stats = filesystem.lstatSync(file);
    } catch {
      throw unsafeStateError(`Login did not create a valid Codex Credential for Profile '${label}'.`);
    }
    if (stats.isSymbolicLink()) {
      throw unsafeStateError(`The new Credential for Profile '${label}' is a symlink.`);
    }
    if (!stats.isFile()) {
      throw unsafeStateError(`The new Credential for Profile '${label}' is not a regular file.`);
    }
    assertPrivateMode(stats, `Credential file ${credentialFileName(file)}`);
    return validateCredentialFile(file);
  }

  function safeCredentialFiles(directory, label, requireExactlyOne) {
    if (!pathExists(directory)) {
      if (requireExactlyOne) throw unsafeStateError(`Profile '${label}' does not exist.`);
      return [];
    }

    const directoryStats = filesystem.lstatSync(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw unsafeStateError(`Unsafe Profile storage: Profile '${label}' must be a real directory.`);
    }
    assertPrivateMode(directoryStats, `Profile '${label}'`);

    const files = [];
    for (const entry of filesystem.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stats = filesystem.lstatSync(file);
      if (stats.isSymbolicLink()) {
        throw unsafeStateError(`Unsafe Profile storage: Profile '${label}' contains a symlink.`);
      }
      if (!stats.isFile()) {
        throw unsafeStateError(`Unsafe Profile storage: Profile '${label}' contains an unexpected entry.`);
      }
      assertPrivateMode(stats, `Credential file ${entry.name}`);
      if (!entry.name.startsWith('codex-') || !entry.name.endsWith('.json')) {
        throw unsafeStateError(`Unsafe Profile storage: Profile '${label}' contains an unexpected file.`);
      }
      files.push(file);
    }

    for (const file of files) validateCredentialFile(file);
    if (requireExactlyOne && files.length !== 1) {
      throw unsafeStateError(`Profile '${label}' must contain exactly one Codex Credential.`);
    }
    return files;
  }

  function safeActiveCredentialFiles() {
    ensureDir(activeDir);
    const files = [];
    for (const entry of filesystem.readdirSync(activeDir, { withFileTypes: true })) {
      const file = path.join(activeDir, entry.name);
      const stats = filesystem.lstatSync(file);
      if (stats.isSymbolicLink() && entry.name.startsWith('codex-') && entry.name.endsWith('.json')) {
        throw unsafeStateError('Unsafe Profile storage: the active Credential is a symlink.');
      }
      if (entry.name.startsWith('codex-') && entry.name.endsWith('.json')) {
        if (!stats.isFile()) {
          throw unsafeStateError('Unsafe Profile storage: the active Credential is not a regular file.');
        }
        assertPrivateMode(stats, `Credential file ${entry.name}`);
        files.push(file);
      }
    }
    for (const file of files) validateCredentialFile(file);
    return files;
  }

  function assertSafeProfileDirectories(activeFiles) {
    const current = readActiveProfile();
    if (current) validateStoredProfileName(current);
    for (const name of profileDirectories()) {
      const files = safeCredentialFiles(profileDir(name), name, false);
      const active = Boolean(current) && normalizeName(name) === normalizeName(current);
      const expectedCount = active && activeFiles.length === 1 ? 0 : 1;
      if (files.length !== expectedCount) {
        throw unsafeStateError(`Profile '${name}' must contain exactly one Codex Credential.`);
      }
    }
  }

  function assertSafeMutationStorage() {
    ensureDir(activeDir);
    ensureDir(profilesDir);

    const runtimeFiles = [stateFile];
    if (!options.operationLock) runtimeFiles.push(lockFile);
    if (!options.recoveryStore) runtimeFiles.push(transactionFile);
    const allowedRootFiles = new Set(runtimeFiles.map((file) => path.resolve(file)));
    for (const entry of filesystem.readdirSync(profilesDir, { withFileTypes: true })) {
      const entryPath = path.resolve(path.join(profilesDir, entry.name));
      const stats = filesystem.lstatSync(entryPath);
      if (stats.isSymbolicLink()) {
        throw unsafeStateError(`Unsafe Profile storage: ${entry.name} is a symlink.`);
      }
      if (allowedRootFiles.has(entryPath)) {
        if (!stats.isFile()) {
          throw unsafeStateError(`Unsafe Profile storage: ${entry.name} must be a regular file.`);
        }
        assertPrivateMode(stats, entry.name);
        continue;
      }
      if (entry.name.startsWith('.') || !stats.isDirectory()) {
        throw unsafeStateError(`Unsafe Profile storage: ${entry.name} is an unexpected entry.`);
      }
    }

    assertRegularFile(stateFile, 'active Profile state');
    if (!options.operationLock) assertRegularFile(lockFile, 'Profile operation lock');
    if (!options.recoveryStore) assertRegularFile(transactionFile, 'Profile recovery record');
    const activeFiles = safeActiveCredentialFiles();
    assertSafeProfileDirectories(activeFiles);
  }

  function moveCredential(file, destinationDir, transaction, generated = false) {
    journalEnsureDir(transaction, destinationDir);
    journalMove(transaction, file, path.join(destinationDir, path.basename(file)), generated);
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
    if (!existing) throw invalidInputError(`Unknown Profile: ${name}`);
    return existing;
  }

  function assertActiveCredentialState(activeFiles, current) {
    if (activeFiles.length > 1) {
      throw unsafeStateError('More than one active Codex Credential exists.');
    }
    if (activeFiles.length === 1 && !current) {
      throw unsafeStateError('The active Credential is not registered.');
    }
  }

  function canonicalCredentialValue(value) {
    if (Array.isArray(value)) return value.map((item) => canonicalCredentialValue(item));
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalCredentialValue(value[key]);
      return result;
    }, {});
  }

  function credentialFingerprint(value) {
    return crypto.createHash('sha256')
      .update(JSON.stringify(canonicalCredentialValue(value)))
      .digest('hex');
  }

  function assertCredentialIsNotDuplicated(file, profileName, excludedFiles = []) {
    const fingerprint = credentialFingerprint(validateCredentialFile(file));
    const excluded = new Set([file, ...excludedFiles].map((candidate) => path.resolve(candidate)));
    const candidates = [
      ...credentialFiles(activeDir),
      ...profileDirectories().flatMap((name) => credentialFiles(profileDir(name))),
    ];
    for (const candidate of candidates) {
      if (excluded.has(path.resolve(candidate))) continue;
      if (credentialFingerprint(validateCredentialFile(candidate)) === fingerprint) {
        throw unsafeStateError(`Profile '${profileName}' contains Credential data duplicated elsewhere.`);
      }
    }
  }

  function inspectProfiles() {
    const report = {
      schemaVersion: INSPECTION_SCHEMA_VERSION,
      profiles: [],
      issues: [],
    };
    const issueKeys = new Set();
    const states = [];
    const stateByName = new Map();

    function addIssue(code, profile, message) {
      const profileName = profile || null;
      const key = `${code}:${profileName || ''}`;
      if (issueKeys.has(key)) return;
      issueKeys.add(key);
      report.issues.push({ code, profile: profileName, message });
    }

    function addProfileIssue(state, code, message) {
      if (!state.errorCodes.includes(code)) state.errorCodes.push(code);
      addIssue(code, state.name, message);
    }

    function createState(name) {
      const state = {
        name,
        email: null,
        active: false,
        status: 'invalid',
        errorCodes: [],
        credentialCount: 0,
        candidates: [],
        localValid: false,
      };
      states.push(state);
      if (typeof name === 'string') stateByName.set(normalizeName(name), state);
      return state;
    }

    function findState(name) {
      if (typeof name !== 'string') return null;
      return stateByName.get(normalizeName(name)) || null;
    }

    function inspectCredential(file, owner) {
      const candidate = {
        owner,
        valid: false,
        errorCodes: [],
        email: null,
        fingerprint: null,
      };
      function candidateIssue(code, message) {
        if (!candidate.errorCodes.includes(code)) candidate.errorCodes.push(code);
        if (owner) addProfileIssue(owner, code, message);
        else addIssue(code, null, message);
      }
      let stats;
      try {
        stats = filesystem.lstatSync(file);
      } catch {
        candidateIssue(
          owner ? 'missing-credential' : 'missing-active-credential',
          owner ? `Credential storage for Profile '${owner.name}' is missing.` : 'The active Credential is missing.',
        );
        return candidate;
      }
      if (stats.isSymbolicLink()) {
        candidateIssue(
          'symlinked-credential',
          owner ? `Profile '${owner.name}' contains a symlinked Credential.` : 'The active Credential is a symlink.',
        );
        return candidate;
      }
      if (!stats.isFile()) {
        candidateIssue(
          'unexpected-file',
          owner ? `Profile '${owner.name}' contains an unexpected Credential entry.` : 'The active Credential is not a regular file.',
        );
        return candidate;
      }
      if ((stats.mode & 0o077) !== 0) {
        candidateIssue(
          'permissions',
          owner ? `Credential permissions for Profile '${owner.name}' are not private.` : 'The active Credential permissions are not private.',
        );
      }
      let data;
      try {
        data = JSON.parse(filesystem.readFileSync(file, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
        if (typeof data.email !== 'string' || !data.email) throw new Error('missing email');
      } catch {
        candidateIssue(
          'malformed-credential',
          owner ? `Credential data for Profile '${owner.name}' is malformed.` : 'The active Credential data is malformed.',
        );
        return candidate;
      }
      candidate.valid = true;
      candidate.email = data.email;
      candidate.fingerprint = credentialFingerprint(data);
      return candidate;
    }

    function inspectProfileDirectory(state, directory) {
      let stats;
      try {
        stats = filesystem.lstatSync(directory);
      } catch {
        addProfileIssue(state, 'missing-profile-storage', `Profile '${state.name}' storage is missing.`);
        return;
      }
      if (stats.isSymbolicLink()) {
        addProfileIssue(state, 'symlinked-profile', `Profile '${state.name}' storage is a symlink.`);
        return;
      }
      if (!stats.isDirectory()) {
        addProfileIssue(state, 'unexpected-file', `Profile '${state.name}' storage is not a directory.`);
        return;
      }
      if ((stats.mode & 0o077) !== 0) {
        addProfileIssue(state, 'permissions', `Profile '${state.name}' storage permissions are not private.`);
      }

      let entries;
      try {
        entries = filesystem.readdirSync(directory, { withFileTypes: true });
      } catch {
        addProfileIssue(state, 'unreadable-storage', `Profile '${state.name}' storage cannot be read.`);
        return;
      }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        const isCredentialName = entry.name.startsWith('codex-') && entry.name.endsWith('.json');
        if (entry.isSymbolicLink()) {
          if (isCredentialName) {
            state.credentialCount += 1;
            inspectCredential(file, state);
          } else {
            addProfileIssue(state, 'symlinked-entry', `Profile '${state.name}' contains a symlink.`);
          }
          continue;
        }
        if (!entry.isFile() || !isCredentialName) {
          addProfileIssue(state, 'unexpected-file', `Profile '${state.name}' contains an unexpected file.`);
          continue;
        }
        state.credentialCount += 1;
        const candidate = inspectCredential(file, state);
        if (candidate.valid) state.candidates.push(candidate);
      }
    }

    function inspectActiveStorage() {
      const result = {
        count: 0,
        candidates: [],
        unsafe: false,
        errorCodes: [],
      };
      function activeIssue(code, message) {
        if (!result.errorCodes.includes(code)) result.errorCodes.push(code);
        addIssue(code, null, message);
        result.unsafe = true;
      }
      let stats;
      try {
        stats = filesystem.lstatSync(activeDir);
      } catch (error) {
        if (error && error.code === 'ENOENT') return result;
        activeIssue('unreadable-active-storage', 'The active Credential storage cannot be read.');
        return result;
      }
      if (stats.isSymbolicLink()) {
        activeIssue('symlinked-active-storage', 'The active Credential storage is a symlink.');
        return result;
      }
      if (!stats.isDirectory()) {
        activeIssue('unsafe-active-storage', 'The active Credential storage is not a directory.');
        return result;
      }
      if ((stats.mode & 0o077) !== 0) {
        activeIssue('permissions', 'The active Credential storage permissions are not private.');
      }
      let entries;
      try {
        entries = filesystem.readdirSync(activeDir, { withFileTypes: true });
      } catch {
        activeIssue('unreadable-active-storage', 'The active Credential storage cannot be read.');
        return result;
      }
      for (const entry of entries) {
        if (!entry.name.startsWith('codex-') || !entry.name.endsWith('.json')) continue;
        result.count += 1;
        const candidate = inspectCredential(path.join(activeDir, entry.name), null);
        if (candidate.valid) result.candidates.push(candidate);
        for (const code of candidate.errorCodes) {
          if (!result.errorCodes.includes(code)) result.errorCodes.push(code);
          result.unsafe = true;
        }
      }
      return result;
    }

    function inspectStateFile() {
      let stats;
      try {
        stats = filesystem.lstatSync(stateFile);
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        addIssue('unreadable-active-state', null, 'The active Profile state cannot be read.');
        return null;
      }
      if (stats.isSymbolicLink() || !stats.isFile()) {
        addIssue('unsafe-active-state', null, 'The active Profile state is not a regular file.');
        return null;
      }
      if ((stats.mode & 0o077) !== 0) {
        addIssue('permissions', null, 'The active Profile state permissions are not private.');
      }
      let value;
      try {
        value = filesystem.readFileSync(stateFile, 'utf8').trim();
      } catch {
        addIssue('unreadable-active-state', null, 'The active Profile state cannot be read.');
        return null;
      }
      if (!value) return null;
      try {
        validateProfileName(value);
      } catch {
          addIssue('invalid-active-profile', null, 'The active Profile state contains an invalid Profile name.');
        return null;
      }
      return value;
    }

    function inspectProfileRoot() {
      let stats;
      try {
        stats = filesystem.lstatSync(profilesDir);
      } catch (error) {
        if (error && error.code === 'ENOENT') return [];
        addIssue('unreadable-profile-storage', null, 'The Profile storage cannot be read.');
        return [];
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        addIssue('unsafe-profile-storage', null, 'The Profile storage is not a real directory.');
        return [];
      }
      if ((stats.mode & 0o077) !== 0) {
        addIssue('permissions', null, 'The Profile storage permissions are not private.');
      }

      let entries;
      try {
        entries = filesystem.readdirSync(profilesDir, { withFileTypes: true });
      } catch {
        addIssue('unreadable-profile-storage', null, 'The Profile storage cannot be read.');
        return [];
      }
      const allowedFiles = new Set([stateFile, lockFile, transactionFile].map((file) => path.resolve(file)));
      const profileEntries = [];
      for (const entry of entries) {
        const entryPath = path.resolve(path.join(profilesDir, entry.name));
        if (allowedFiles.has(entryPath)) continue;
        const state = createState(entry.name);
        if (entry.isSymbolicLink()) {
          addProfileIssue(state, 'symlinked-profile', `Profile '${entry.name}' storage is a symlink.`);
          profileEntries.push(state);
          continue;
        }
        if (!entry.isDirectory()) {
          addProfileIssue(state, 'unexpected-file', `Profile storage contains an unexpected entry '${entry.name}'.`);
          profileEntries.push(state);
          continue;
        }
        try {
          validateProfileName(entry.name);
        } catch {
          addProfileIssue(state, 'invalid-profile-name', `Profile name '${entry.name}' is invalid.`);
        }
        inspectProfileDirectory(state, path.join(profilesDir, entry.name));
        profileEntries.push(state);
      }
      const seen = new Map();
      for (const state of profileEntries) {
        const normalized = normalizeName(state.name);
        if (seen.has(normalized)) {
          addProfileIssue(state, 'profile-name-conflict', `Profile name '${state.name}' conflicts with '${seen.get(normalized).name}'.`);
          addProfileIssue(seen.get(normalized), 'profile-name-conflict', `Profile name '${seen.get(normalized).name}' conflicts with '${state.name}'.`);
        } else {
          seen.set(normalized, state);
        }
      }
      return profileEntries;
    }

    function inspectRecoveryArtifacts() {
      let lockStats;
      try {
        lockStats = filesystem.lstatSync(lockFile);
      } catch (error) {
        if (!error || error.code === 'ENOENT') lockStats = null;
        else addIssue('unreadable-operation-lock', null, 'The Profile operation lock cannot be read.');
      }
      if (lockStats) {
        if (lockStats.isSymbolicLink() || !lockStats.isFile()) {
          addIssue('unsafe-operation-lock', null, 'The Profile operation lock is not a regular file.');
        } else if ((lockStats.mode & 0o077) !== 0) {
          addIssue('permissions', null, 'The Profile operation lock permissions are not private.');
        } else {
          addIssue('operation-in-progress', null, 'A Profile operation lock is present.');
        }
      }

      let transactionStats;
      try {
        transactionStats = filesystem.lstatSync(transactionFile);
      } catch (error) {
        if (!error || error.code === 'ENOENT') transactionStats = null;
        else addIssue('unreadable-recovery-record', null, 'The Profile recovery record cannot be read.');
      }
      if (transactionStats) {
        if (transactionStats.isSymbolicLink() || !transactionStats.isFile()) {
          addIssue('unsafe-recovery-record', null, 'The Profile recovery record is not a regular file.');
        } else if ((transactionStats.mode & 0o077) !== 0) {
          addIssue('permissions', null, 'The Profile recovery record permissions are not private.');
        }
        try {
          const value = JSON.parse(filesystem.readFileSync(transactionFile, 'utf8'));
          if (!value || value.schemaVersion !== TRANSACTION_SCHEMA_VERSION || !value.status) throw new Error('invalid');
          addIssue('recovery-required', null, 'Profile recovery is required before normal operations continue.');
        } catch {
          addIssue('invalid-recovery-record', null, 'The Profile recovery record is invalid.');
        }
      }
    }

    const profileEntries = inspectProfileRoot();
    const storedActiveName = inspectStateFile();
    const activeStorage = inspectActiveStorage();
    inspectRecoveryArtifacts();

    const fingerprints = new Map();
    for (const candidate of [
      ...activeStorage.candidates,
      ...profileEntries.flatMap((state) => state.candidates),
    ]) {
      if (!fingerprints.has(candidate.fingerprint)) fingerprints.set(candidate.fingerprint, []);
      fingerprints.get(candidate.fingerprint).push(candidate);
    }
    let activeDuplicate = false;
    for (const candidates of fingerprints.values()) {
      if (candidates.length < 2) continue;
      for (const candidate of candidates) {
        if (candidate.owner) {
          addProfileIssue(candidate.owner, 'duplicate-credential', `Profile '${candidate.owner.name}' contains Credential data duplicated elsewhere.`);
        } else {
          activeDuplicate = true;
          addIssue('duplicate-credential', null, 'The active Credential data is duplicated elsewhere.');
        }
      }
    }

    const storedState = findState(storedActiveName);
    const activeCandidate = activeStorage.candidates.length === 1 ? activeStorage.candidates[0] : null;
    const activeIsValid = activeStorage.count === 1
      && activeCandidate
      && activeCandidate.valid
      && activeCandidate.errorCodes.length === 0
      && !activeStorage.unsafe
      && !activeDuplicate;

    let activeState = storedState;
    if (storedActiveName && !activeState) {
      activeState = createState(storedActiveName);
      activeState.active = true;
      activeState.email = activeCandidate ? activeCandidate.email : null;
      activeState.status = activeIsValid ? 'unregistered' : 'invalid';
      activeState.errorCodes.push('unregistered-credential');
      addIssue('unregistered-credential', storedActiveName, `The active Credential has no matching Profile '${storedActiveName}'.`);
    } else if (activeState) {
      activeState.active = true;
    }

    if (activeState) {
      for (const code of activeStorage.errorCodes) {
        if (!activeState.errorCodes.includes(code)) activeState.errorCodes.push(code);
      }
      for (const candidate of activeStorage.candidates) {
        for (const code of candidate.errorCodes) {
          if (!activeState.errorCodes.includes(code)) activeState.errorCodes.push(code);
        }
      }
      if (activeDuplicate) {
        addProfileIssue(activeState, 'duplicate-credential', `Active Profile '${activeState.name}' contains Credential data duplicated elsewhere.`);
      }
      if (activeState.credentialCount > 0) {
        addProfileIssue(activeState, 'duplicate-credential-storage', `Active Profile '${activeState.name}' has Credential data in both active and Profile storage.`);
      }
      if (activeIsValid && activeState.credentialCount === 0 && activeState.errorCodes.length === 0) {
        activeState.email = activeCandidate.email;
        activeState.status = 'active';
      } else {
        if (activeStorage.count === 0) {
          addProfileIssue(activeState, 'missing-active-credential', `Active Profile '${activeState.name}' has no active Credential.`);
        } else if (activeStorage.count > 1) {
          addProfileIssue(activeState, 'multiple-active-credentials', 'More than one active Credential exists.');
        }
        if (!activeState.email && activeState.candidates.length === 1) activeState.email = activeState.candidates[0].email;
        activeState.status = 'invalid';
      }
    } else if (activeStorage.count > 0) {
      const unregistered = createState(null);
      unregistered.active = true;
      unregistered.email = activeCandidate ? activeCandidate.email : null;
      unregistered.status = activeIsValid ? 'unregistered' : 'invalid';
      unregistered.errorCodes.push('unregistered-credential');
      for (const code of activeStorage.errorCodes) {
        if (!unregistered.errorCodes.includes(code)) unregistered.errorCodes.push(code);
      }
      for (const candidate of activeStorage.candidates) {
        for (const code of candidate.errorCodes) {
          if (!unregistered.errorCodes.includes(code)) unregistered.errorCodes.push(code);
        }
      }
      if (activeDuplicate && !unregistered.errorCodes.includes('duplicate-credential')) {
        unregistered.errorCodes.push('duplicate-credential');
      }
      addIssue('unregistered-credential', null, 'An active Credential has no matching active Profile.');
      if (activeStorage.count > 1) {
        unregistered.errorCodes.push('multiple-active-credentials');
        addIssue('multiple-active-credentials', null, 'More than one active Credential exists.');
      }
    }

    for (const state of states) {
      if (state.active) continue;
      if (state.credentialCount === 0) {
        addProfileIssue(state, 'missing-credential', `Profile '${state.name}' has no Codex Credential.`);
      } else if (state.credentialCount > 1) {
        addProfileIssue(state, 'multiple-credentials', `Profile '${state.name}' contains more than one Codex Credential.`);
      } else if (state.candidates.length === 1 && state.candidates[0].valid && state.errorCodes.length === 0) {
        state.localValid = true;
        state.email = state.candidates[0].email;
      } else if (state.candidates.length === 1 && state.candidates[0].valid && !state.email) {
        state.email = state.candidates[0].email;
      }
      if (!state.active) state.status = state.localValid ? 'ready' : 'invalid';
    }

    const invalidatingGlobalIssueCodes = new Set([
      'permissions',
      'unreadable-profile-storage',
      'unsafe-profile-storage',
      'unreadable-active-storage',
      'symlinked-active-storage',
      'unsafe-active-storage',
      'unreadable-active-state',
      'unsafe-active-state',
      'invalid-active-profile',
    ]);
    const globalStorageIssues = report.issues
      .filter((issue) => issue.profile === null && invalidatingGlobalIssueCodes.has(issue.code));
    for (const state of states) {
      for (const issue of globalStorageIssues) {
        if (!state.errorCodes.includes(issue.code)) state.errorCodes.push(issue.code);
      }
      if (globalStorageIssues.length > 0) state.status = 'invalid';
    }

    report.profiles = states
      .map((state) => ({
        name: state.name,
        email: state.email,
        active: state.active,
        status: state.status,
        errorCodes: [...state.errorCodes],
      }))
      .sort((left, right) => {
        if (left.name === null) return -1;
        if (right.name === null) return 1;
        return left.name.localeCompare(right.name);
      });
    return report;
  }

  function formatProfile(profile) {
    const name = profile.name === null ? '<unregistered>' : profile.name;
    const email = profile.email || 'email unavailable';
    return `${name} (${email}, ${profile.status})`;
  }

  function writeInspectionIssues(report, io) {
    for (const issue of report.issues) {
      io.stdout(`Issue [${issue.code}]: ${issue.message}`);
    }
  }

  function listProfiles(io, json) {
    const report = inspectProfiles();
    if (json) {
      io.stdout(JSON.stringify(report));
      return report.issues.length > 0 ? 3 : 0;
    }
    if (report.profiles.length === 0) {
      io.stdout('No saved Profiles.');
    } else {
      for (const profile of report.profiles) {
        io.stdout(`${profile.active ? '*' : ' '} ${formatProfile(profile)}`);
      }
    }
    writeInspectionIssues(report, io);
    return report.issues.length > 0 ? 3 : 0;
  }

  function currentProfile(io, json) {
    const report = inspectProfiles();
    const profile = report.profiles.find((candidate) => candidate.active) || null;
    const issues = profile
      ? report.issues
      : [...report.issues, {
        code: 'no-active-profile',
        profile: null,
        message: 'No active Profile is recorded.',
      }];
    if (json) {
      io.stdout(JSON.stringify({
        schemaVersion: INSPECTION_SCHEMA_VERSION,
        profile,
        issues,
      }));
      return issues.length > 0 ? 3 : 0;
    }
    if (!profile) throw createCommandError('No active Profile is recorded.', 3);
    io.stdout(`Active Profile: ${formatProfile(profile)}`);
    writeInspectionIssues(report, io);
    return report.issues.length > 0 ? 3 : 0;
  }

  function doctor(io, json) {
    const report = inspectProfiles();
    if (json) {
      io.stdout(JSON.stringify(report));
    } else {
      if (report.profiles.length === 0) io.stdout('No saved Profiles.');
      else {
        io.stdout('Profile health:');
        for (const profile of report.profiles) io.stdout(`${profile.active ? '*' : ' '} ${formatProfile(profile)}`);
      }
      if (report.issues.length === 0) io.stdout('No Profile health issues.');
      else writeInspectionIssues(report, io);
    }
    return report.issues.length > 0 ? 3 : 0;
  }

  function repairPrivateMode(target, targetName, expectedType, expectedMode, repairs) {
    let stats;
    try {
      stats = filesystem.lstatSync(target);
    } catch {
      return;
    }
    if (stats.isSymbolicLink()) return;
    const typeMatches = expectedType === 'directory' ? stats.isDirectory() : stats.isFile();
    if (!typeMatches || (stats.mode & 0o777) === expectedMode) return;
    try {
      filesystem.chmodSync(target, expectedMode);
      if ((filesystem.lstatSync(target).mode & 0o777) !== expectedMode) return;
      recordPermissionRepair(repairs, targetName);
    } catch {
      // The final inspection reports permissions that the file system did not change.
    }
  }

  function recordPermissionRepair(repairs, targetName) {
    if (repairs.some((repair) => (
      repair.code === 'permissions-repaired' && repair.target === targetName
    ))) return;
    repairs.push({
      code: 'permissions-repaired',
      target: targetName,
      message: `${targetName} permissions are now private.`,
    });
  }

  function readRealDirectoryEntries(directory) {
    try {
      const stats = filesystem.lstatSync(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
      return filesystem.readdirSync(directory, { withFileTypes: true });
    } catch {
      return null;
    }
  }

  function profileRootEntriesAreExpected(entries) {
    const allowedFiles = new Set([stateFile, lockFile, transactionFile].map((file) => path.resolve(file)));
    return entries.every((entry) => {
      const entryPath = path.resolve(path.join(profilesDir, entry.name));
      if (allowedFiles.has(entryPath)) return entry.isFile() && !entry.isSymbolicLink();
      return validRecoveryProfileName(entry.name)
        && entry.isDirectory()
        && !entry.isSymbolicLink();
    });
  }

  function repairActivePermissions(repairs) {
    const entries = readRealDirectoryEntries(activeDir);
    if (!entries) return;
    const credentials = entries.filter((entry) => isCredentialFileName(entry.name));
    if (
      credentials.length > 1
      || credentials.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    ) return;
    repairPrivateMode(
      activeDir,
      'active Credential storage',
      'directory',
      0o700,
      repairs,
    );
    if (credentials.length === 1) {
      repairPrivateMode(
        path.join(activeDir, credentials[0].name),
        'active Credential file',
        'file',
        0o600,
        repairs,
      );
    }
  }

  function repairProfilePermissions(name, repairs) {
    const directory = profileDir(name);
    const entries = readRealDirectoryEntries(directory);
    if (
      !entries
      || entries.length > 1
      || entries.some((entry) => (
        !entry.isFile()
        || entry.isSymbolicLink()
        || !isCredentialFileName(entry.name)
      ))
    ) return;
    repairPrivateMode(directory, `Profile '${name}' storage`, 'directory', 0o700, repairs);
    if (entries.length === 1) {
      repairPrivateMode(
        path.join(directory, entries[0].name),
        `Credential file for Profile '${name}'`,
        'file',
        0o600,
        repairs,
      );
    }
  }

  function repairPrivatePermissions(repairs) {
    repairActivePermissions(repairs);
    const entries = readRealDirectoryEntries(profilesDir);
    if (!entries || !profileRootEntriesAreExpected(entries)) return;

    repairPrivateMode(profilesDir, 'Profile storage', 'directory', 0o700, repairs);
    repairPrivateMode(stateFile, 'active Profile state', 'file', 0o600, repairs);
    repairPrivateMode(lockFile, 'Profile operation lock', 'file', 0o600, repairs);
    repairPrivateMode(transactionFile, 'Profile recovery record', 'file', 0o600, repairs);
    for (const entry of entries) {
      if (validRecoveryProfileName(entry.name) && entry.isDirectory()) {
        repairProfilePermissions(entry.name, repairs);
      }
    }
  }

  function operationLockRepairState() {
    let stats;
    let content;
    try {
      stats = filesystem.lstatSync(lockFile);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        return { blockedCode: 'unsafe-operation-lock' };
      }
      content = filesystem.readFileSync(lockFile, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return { absent: true };
      return { blockedCode: 'unreadable-operation-lock' };
    }

    let metadata;
    try {
      metadata = JSON.parse(content);
    } catch {
      return { blockedCode: 'invalid-operation-lock' };
    }
    if (
      !metadata
      || metadata.schemaVersion !== TRANSACTION_SCHEMA_VERSION
      || !LOCK_OPERATIONS.has(metadata.operation)
      || !Number.isSafeInteger(metadata.pid)
      || metadata.pid <= 0
      || typeof metadata.startedAt !== 'string'
      || !metadata.startedAt
    ) {
      return { blockedCode: 'invalid-operation-lock' };
    }

    let ownerRunning;
    try {
      ownerRunning = Boolean(isProcessRunning(metadata.pid));
    } catch {
      return { blockedCode: 'operation-lock-owner-unknown' };
    }
    if (ownerRunning) return { blockedCode: 'operation-in-progress' };
    return { stale: true, stats, content };
  }

  function removeStaleOperationLock(lockState, repairs) {
    let currentStats;
    let currentContent;
    try {
      currentStats = filesystem.lstatSync(lockFile);
      currentContent = filesystem.readFileSync(lockFile, 'utf8');
    } catch {
      return false;
    }
    if (
      currentStats.isSymbolicLink()
      || !currentStats.isFile()
      || currentStats.dev !== lockState.stats.dev
      || currentStats.ino !== lockState.stats.ino
      || currentContent !== lockState.content
    ) {
      return false;
    }
    try {
      filesystem.unlinkSync(lockFile);
    } catch {
      return false;
    }
    repairs.push({
      code: 'stale-operation-lock-removed',
      target: 'Profile operation lock',
      message: 'The stale Profile operation lock was removed.',
    });
    return true;
  }

  function addRepairIssue(report, code, message) {
    if (report.issues.some((issue) => issue.code === code && issue.profile === null)) return;
    report.issues.push({ code, profile: null, message });
  }

  function managedRecoveryRoot(candidate) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
    const resolvedCandidate = path.resolve(candidate);
    return [path.resolve(activeDir), path.resolve(profilesDir)]
      .sort((left, right) => right.length - left.length)
      .find((root) => {
        const relative = path.relative(root, resolvedCandidate);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      }) || null;
  }

  function recoveryPathParts(root, candidate) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return relative.split(path.sep);
  }

  function validRecoveryProfileName(name) {
    return PROFILE_NAME_PATTERN.test(name) && !RESERVED_PROFILE_NAMES.has(normalizeName(name));
  }

  function recoveryMoveKind(candidate) {
    const activeParts = recoveryPathParts(activeDir, candidate);
    if (
      activeParts
      && activeParts.length === 1
      && isCredentialFileName(activeParts[0])
    ) {
      return 'credential';
    }
    const profileParts = recoveryPathParts(profilesDir, candidate);
    if (!profileParts) return null;
    if (profileParts.length === 1 && validRecoveryProfileName(profileParts[0])) {
      return 'profile-directory';
    }
    if (
      profileParts.length === 2
      && validRecoveryProfileName(profileParts[0])
      && isCredentialFileName(profileParts[1])
    ) {
      return 'credential';
    }
    return null;
  }

  function isRecoveryProfileDirectory(candidate) {
    const parts = recoveryPathParts(profilesDir, candidate);
    return Boolean(parts && parts.length === 1 && validRecoveryProfileName(parts[0]));
  }

  function isStoredRecoveryCredential(candidate) {
    const parts = recoveryPathParts(profilesDir, candidate);
    return Boolean(
      parts
      && parts.length === 2
      && validRecoveryProfileName(parts[0])
      && isCredentialFileName(parts[1]),
    );
  }

  function recoveryPathState(candidate) {
    const root = managedRecoveryRoot(candidate);
    if (!root) return { safe: false, exists: false };
    try {
      const rootStats = filesystem.lstatSync(root);
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        return { safe: false, exists: true };
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return { safe: false, exists: false };
    }
    const relative = path.relative(root, path.resolve(candidate));
    let current = root;
    for (const part of relative ? relative.split(path.sep) : []) {
      current = path.join(current, part);
      let stats;
      try {
        stats = filesystem.lstatSync(current);
      } catch (error) {
        if (error && error.code === 'ENOENT') return { safe: true, exists: false };
        return { safe: false, exists: false };
      }
      if (stats.isSymbolicLink()) return { safe: false, exists: true };
    }
    try {
      const stats = filesystem.lstatSync(candidate);
      return {
        safe: !stats.isSymbolicLink() && (stats.isFile() || stats.isDirectory()),
        exists: true,
        stats,
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { safe: true, exists: false };
      return { safe: false, exists: false };
    }
  }

  function recoveryLoginDirectory(transaction) {
    if (!['add', 'reauth'].includes(transaction.operation)) {
      return {
        valid: transaction.loginDirectory === undefined,
        directory: null,
      };
    }
    if (transaction.loginDirectory !== undefined && typeof transaction.loginDirectory !== 'string') {
      return { valid: false, directory: null };
    }

    let expectedDirectory;
    if (transaction.operation === 'add') {
      expectedDirectory = path.resolve(activeDir);
    } else if (
      typeof transaction.preservedCredentialPath !== 'string'
      || recoveryMoveKind(transaction.preservedCredentialPath) !== 'credential'
    ) {
      return { valid: false, directory: null };
    } else if (path.resolve(path.dirname(transaction.preservedCredentialPath)) === path.resolve(activeDir)) {
      let activeProfile;
      try {
        const state = recoveryPathState(stateFile);
        if (!state.safe || !state.exists || !state.stats.isFile()) {
          return { valid: false, directory: null };
        }
        activeProfile = filesystem.readFileSync(stateFile, 'utf8').trim();
      } catch {
        return { valid: false, directory: null };
      }
      if (!validRecoveryProfileName(activeProfile)) return { valid: false, directory: null };
      expectedDirectory = path.resolve(profileDir(activeProfile));
    } else {
      if (!isStoredRecoveryCredential(transaction.preservedCredentialPath)) {
        return { valid: false, directory: null };
      }
      expectedDirectory = path.resolve(activeDir);
    }

    const directory = transaction.loginDirectory === undefined
      ? expectedDirectory
      : path.resolve(transaction.loginDirectory);
    const state = recoveryPathState(directory);
    return {
      valid: directory === expectedDirectory
        && state.safe
        && state.exists
        && state.stats.isDirectory(),
      directory,
    };
  }

  function transactionHasDeterministicRollback(transaction) {
    if (
      !transaction
      || transaction.schemaVersion !== TRANSACTION_SCHEMA_VERSION
      || !PROFILE_MUTATION_OPERATIONS.has(transaction.operation)
      || !Number.isSafeInteger(transaction.pid)
      || transaction.pid <= 0
      || typeof transaction.startedAt !== 'string'
      || !transaction.startedAt
      || !['active', 'recovery-required', 'rolled-back'].includes(transaction.status)
      || !Array.isArray(transaction.steps)
      || !Array.isArray(transaction.generatedCredentialPaths)
      || (
        transaction.generatedCredentialIdentities !== undefined
        && !Array.isArray(transaction.generatedCredentialIdentities)
      )
      || (transaction.credentialPathsBefore !== undefined && !Array.isArray(transaction.credentialPathsBefore))
      || (
        transaction.credentialIdentitiesBefore !== undefined
        && !Array.isArray(transaction.credentialIdentitiesBefore)
      )
    ) {
      return false;
    }
    const loginDirectory = recoveryLoginDirectory(transaction);
    if (!loginDirectory.valid) return false;

    if (
      new Set(transaction.generatedCredentialPaths).size !== transaction.generatedCredentialPaths.length
      || transaction.generatedCredentialPaths.some((candidate) => (
        typeof candidate !== 'string' || recoveryMoveKind(candidate) !== 'credential'
      ))
    ) return false;

    const nonGeneratedPaths = new Set();
    const nonGeneratedCredentialMoves = [];
    const profileDirectoryMoves = [];
    const generatedMoves = [];
    const directorySteps = [];
    const deletionSteps = [];
    const stateSteps = [];
    let stateStepCount = 0;
    const pathStates = new Map();
    const virtualExistence = new Map();

    function recoveryState(candidate) {
      const key = path.resolve(candidate);
      if (!pathStates.has(key)) pathStates.set(key, recoveryPathState(candidate));
      return pathStates.get(key);
    }

    function pathExistsInPlan(candidate) {
      const key = path.resolve(candidate);
      if (virtualExistence.has(key)) return virtualExistence.get(key);
      return recoveryState(candidate).exists;
    }

    function setPathExistsInPlan(candidate, exists) {
      virtualExistence.set(path.resolve(candidate), exists);
    }

    for (const step of transaction.steps) {
      if (!step || typeof step.type !== 'string') return false;
      if (step.type === 'move') {
        if (
          typeof step.source !== 'string'
          || typeof step.destination !== 'string'
          || typeof step.started !== 'boolean'
          || typeof step.applied !== 'boolean'
          || typeof step.generated !== 'boolean'
          || (step.applied && !step.started)
        ) {
          return false;
        }
        const sourceKind = recoveryMoveKind(step.source);
        if (
          !sourceKind
          || recoveryMoveKind(step.destination) !== sourceKind
          || path.resolve(step.source) === path.resolve(step.destination)
        ) return false;
        if (
          (sourceKind === 'profile-directory' && transaction.operation !== 'rename')
          || (sourceKind === 'credential' && ['delete', 'rename'].includes(transaction.operation))
          || (step.generated && !['add', 'reauth'].includes(transaction.operation))
        ) return false;
        const source = recoveryState(step.source);
        const destination = recoveryState(step.destination);
        if (!source.safe || !destination.safe) return false;
        if (source.exists && (sourceKind === 'credential' ? !source.stats.isFile() : !source.stats.isDirectory())) {
          return false;
        }
        if (destination.exists && (sourceKind === 'credential' ? !destination.stats.isFile() : !destination.stats.isDirectory())) {
          return false;
        }
        if (step.generated) {
          generatedMoves.push(step);
          continue;
        }
        if (sourceKind === 'credential') nonGeneratedCredentialMoves.push(step);
        else profileDirectoryMoves.push(step);
        nonGeneratedPaths.add(path.resolve(step.source));
        nonGeneratedPaths.add(path.resolve(step.destination));
        continue;
      }
      if (step.type === 'state') {
        if (
          typeof step.path !== 'string'
          || path.resolve(step.path) !== path.resolve(stateFile)
          || typeof step.started !== 'boolean'
          || typeof step.applied !== 'boolean'
          || (step.applied && !step.started)
          || typeof step.beforeExists !== 'boolean'
          || !Number.isInteger(step.beforeMode)
          || (step.beforeMode & 0o077) !== 0
          || (step.beforeMode & 0o700) === 0
          || (step.beforeExists && (
            typeof step.beforeProfile !== 'string'
            || !validRecoveryProfileName(step.beforeProfile)
          ))
        ) {
          return false;
        }
        if (!['add', 'deactivate', 'rename', 'use'].includes(transaction.operation)) return false;
        stateStepCount += 1;
        stateSteps.push(step);
        const state = recoveryState(step.path);
        if (!state.safe || (state.exists && !state.stats.isFile()) || stateStepCount > 1) return false;
        continue;
      }
      if (step.type === 'mkdir') {
        if (
          typeof step.path !== 'string'
          || !isRecoveryProfileDirectory(step.path)
          || typeof step.started !== 'boolean'
          || typeof step.created !== 'boolean'
          || (step.created && !step.started)
        ) {
          return false;
        }
        if (!['add', 'reauth', 'use'].includes(transaction.operation)) return false;
        const directory = recoveryState(step.path);
        if (!directory.safe || (directory.exists && !directory.stats.isDirectory())) return false;
        if (!step.started && directory.exists) return false;
        directorySteps.push(step);
        continue;
      }
      if (['delete-file', 'delete-directory'].includes(step.type)) {
        if (
          typeof step.path !== 'string'
          || (step.type === 'delete-file' && recoveryMoveKind(step.path) !== 'credential')
          || (step.type === 'delete-directory' && !isRecoveryProfileDirectory(step.path))
          || typeof step.started !== 'boolean'
          || typeof step.applied !== 'boolean'
          || (step.applied && !step.started)
        ) {
          return false;
        }
        if (
          !['delete', 'reauth'].includes(transaction.operation)
          || (step.type === 'delete-directory' && transaction.operation !== 'delete')
        ) return false;
        const target = recoveryState(step.path);
        if (!target.safe || !target.exists) return false;
        if (
          step.applied
          || (step.type === 'delete-file' && !target.stats.isFile())
          || (step.type === 'delete-directory' && !target.stats.isDirectory())
        ) return false;
        deletionSteps.push(step);
        continue;
      }
      return false;
    }

    if (stateStepCount > 0) {
      if (
        (transaction.operation === 'add' && generatedMoves.length === 0)
        || (['deactivate', 'use'].includes(transaction.operation) && nonGeneratedCredentialMoves.length === 0)
        || (transaction.operation === 'rename' && profileDirectoryMoves.length === 0)
      ) return false;

      const stateStep = stateSteps[0];
      const movesFromActiveToStored = nonGeneratedCredentialMoves.filter((step) => {
        const sourceParts = recoveryPathParts(activeDir, step.source);
        const destinationParts = recoveryPathParts(profilesDir, step.destination);
        return sourceParts
          && sourceParts.length === 1
          && destinationParts
          && destinationParts.length === 2;
      });
      if (stateStep.beforeExists) {
        if (['add', 'deactivate', 'use'].includes(transaction.operation)) {
          const hasMatchingCredentialMove = movesFromActiveToStored.some((step) => {
            const destinationParts = recoveryPathParts(profilesDir, step.destination);
            return normalizeName(destinationParts[0]) === normalizeName(stateStep.beforeProfile);
          });
          if (!hasMatchingCredentialMove) return false;
        } else if (transaction.operation === 'rename') {
          const hasMatchingDirectoryMove = profileDirectoryMoves.some((step) => {
            const sourceParts = recoveryPathParts(profilesDir, step.source);
            return sourceParts
              && sourceParts.length === 1
              && normalizeName(sourceParts[0]) === normalizeName(stateStep.beforeProfile);
          });
          if (!hasMatchingDirectoryMove) return false;
        }
      } else if (
        ['deactivate', 'rename'].includes(transaction.operation)
        || movesFromActiveToStored.length > 0
      ) {
        return false;
      }
    }

    const recordedGeneratedPaths = transaction.generatedCredentialPaths.map((candidate) => path.resolve(candidate));
    const generatedIdentities = transaction.generatedCredentialIdentities || [];
    const credentialPathsBefore = transaction.credentialPathsBefore || [];
    const credentialIdentitiesBefore = transaction.credentialIdentitiesBefore || [];
    const generatedPaths = generatedCandidatePaths(transaction);
    const generatedPathKeys = new Set([...generatedPaths].map((candidate) => path.resolve(candidate)));
    const credentialPathKeysBefore = credentialPathsBefore.map((candidate) => (
      typeof candidate === 'string' ? path.resolve(candidate) : candidate
    ));
    const identityKey = (identity) => `${identity.device}:${identity.inode}`;
    const identityIsValid = (identity, expectedPath) => Boolean(
      identity
      && typeof identity.path === 'string'
      && path.resolve(identity.path) === path.resolve(expectedPath)
      && typeof identity.device === 'number'
      && Number.isFinite(identity.device)
      && typeof identity.inode === 'number'
      && Number.isFinite(identity.inode)
    );
    if (
      credentialPathsBefore.some((candidate) => (
        typeof candidate !== 'string' || recoveryMoveKind(candidate) !== 'credential'
      ))
      || new Set(credentialPathKeysBefore).size !== credentialPathKeysBefore.length
      || (
        transaction.credentialIdentitiesBefore !== undefined
        && credentialIdentitiesBefore.length !== credentialPathsBefore.length
      )
      || credentialIdentitiesBefore.some((identity, index) => (
        !identityIsValid(identity, credentialPathsBefore[index])
      ))
    ) return false;

    const originalPlansByPath = new Map();
    if (transaction.credentialIdentitiesBefore !== undefined) {
      for (const [index, identity] of credentialIdentitiesBefore.entries()) {
        let possibleLocations = new Set([path.resolve(credentialPathsBefore[index])]);
        const planPaths = new Set(possibleLocations);
        let moveUncertain = false;
        for (const step of nonGeneratedCredentialMoves) {
          const source = path.resolve(step.source);
          const destination = path.resolve(step.destination);
          if (transaction.status === 'rolled-back') {
            if (planPaths.has(source) || planPaths.has(destination)) {
              planPaths.add(source);
              planPaths.add(destination);
            }
            continue;
          }
          if (!possibleLocations.has(source)) continue;
          if (moveUncertain || possibleLocations.size !== 1) return false;
          planPaths.add(destination);
          if (!step.started) {
            moveUncertain = true;
          } else if (!step.applied) {
            possibleLocations.add(destination);
            moveUncertain = true;
          } else {
            possibleLocations = new Set([destination]);
          }
        }

        const existingLocations = [...possibleLocations].filter((candidate) => {
          const state = recoveryState(candidate);
          return state.safe && state.exists && state.stats.isFile();
        });
        if (existingLocations.length !== 1) return false;
        const currentStats = recoveryState(existingLocations[0]).stats;
        if (currentStats.dev !== identity.device || currentStats.ino !== identity.inode) return false;
        const plan = { identity, currentPath: existingLocations[0] };
        for (const candidate of planPaths) {
          if (!originalPlansByPath.has(candidate)) originalPlansByPath.set(candidate, []);
          originalPlansByPath.get(candidate).push(plan);
        }
      }
    }

    if (recordedGeneratedPaths.length > 0) {
      if (
        !['add', 'reauth'].includes(transaction.operation)
        || generatedIdentities.length !== recordedGeneratedPaths.length
      ) return false;
    } else if (generatedMoves.length > 0 || generatedIdentities.length > 0) {
      return false;
    }

    if (generatedIdentities.some((identity, index) => (
      !identityIsValid(identity, recordedGeneratedPaths[index])
    ))) return false;

    const generatedGroups = new Map();
    for (const [index, identity] of generatedIdentities.entries()) {
      const key = identityKey(identity);
      if (!generatedGroups.has(key)) {
        generatedGroups.set(key, {
          identity,
          recordedPaths: [],
          paths: new Set(),
          moves: [],
        });
      }
      const group = generatedGroups.get(key);
      group.recordedPaths.push(recordedGeneratedPaths[index]);
      group.paths.add(recordedGeneratedPaths[index]);
    }

    let pendingGeneratedMoves = generatedMoves.map((step, index) => ({ step, index }));
    while (pendingGeneratedMoves.length > 0) {
      let assignedMove = false;
      const remainingMoves = [];
      for (const item of pendingGeneratedMoves) {
        const source = path.resolve(item.step.source);
        const destination = path.resolve(item.step.destination);
        const matchingGroups = [...generatedGroups.values()].filter((group) => (
          group.paths.has(source) || group.paths.has(destination)
        ));
        if (matchingGroups.length > 1) return false;
        if (matchingGroups.length === 0) {
          remainingMoves.push(item);
          continue;
        }
        const [group] = matchingGroups;
        group.paths.add(source);
        group.paths.add(destination);
        group.moves.push(item);
        assignedMove = true;
      }
      if (!assignedMove && remainingMoves.length > 0) return false;
      pendingGeneratedMoves = remainingMoves;
    }

    for (const group of generatedGroups.values()) {
      let possibleLocations = new Set([group.recordedPaths[0]]);
      const sortedMoves = group.moves.sort((left, right) => left.index - right.index);
      for (const [groupMoveIndex, item] of sortedMoves.entries()) {
        const source = path.resolve(item.step.source);
        const destination = path.resolve(item.step.destination);
        if (possibleLocations.size !== 1 || !possibleLocations.has(source)) return false;
        if (!item.step.started || !item.step.applied) {
          if (groupMoveIndex !== sortedMoves.length - 1) return false;
          if (item.step.started) possibleLocations.add(destination);
          continue;
        }
        possibleLocations = new Set([destination]);
      }

      const existingPaths = [];
      for (const candidate of group.paths) {
        if (recoveryMoveKind(candidate) !== 'credential') return false;
        const state = recoveryState(candidate);
        if (!state.safe || (state.exists && !state.stats.isFile())) return false;
        if (state.exists) existingPaths.push(candidate);
        const originalPlans = originalPlansByPath.get(candidate) || [];
        if (nonGeneratedPaths.has(candidate) && (
          originalPlans.length === 0
          || originalPlans.some((plan) => identityKey(plan.identity) === identityKey(group.identity))
        )) return false;
        setPathExistsInPlan(candidate, false);
      }
      if (transaction.status === 'rolled-back') {
        if (existingPaths.some((candidate) => !(
          (originalPlansByPath.get(candidate) || []).some((plan) => plan.currentPath === candidate)
        ))) return false;
      } else {
        if (
          existingPaths.length > 1
          || (existingPaths.length === 1 && !possibleLocations.has(existingPaths[0]))
        ) return false;
        if (existingPaths.length === 1) {
          const stats = recoveryState(existingPaths[0]).stats;
          if (stats.dev !== group.identity.device || stats.ino !== group.identity.inode) return false;
        }
      }
    }

    const knownCredentialPaths = new Set([
      ...credentialPathKeysBefore,
      ...[...generatedPaths].map((candidate) => path.resolve(candidate)),
      ...nonGeneratedCredentialMoves.flatMap((step) => [
        path.resolve(step.source),
        path.resolve(step.destination),
      ]),
      ...deletionSteps
        .filter((step) => step.type === 'delete-file')
        .map((step) => path.resolve(step.path)),
    ]);
    const knownCredentialIdentities = new Set(
      transaction.credentialIdentitiesBefore === undefined
        ? []
        : [
          ...credentialIdentitiesBefore.map(identityKey),
          ...generatedIdentities.map(identityKey),
        ],
    );
    const touchedCredentialDirectories = new Set(
      [...knownCredentialPaths].map((candidate) => path.dirname(candidate)),
    );
    if (['add', 'reauth'].includes(transaction.operation)) {
      touchedCredentialDirectories.add(path.resolve(activeDir));
      touchedCredentialDirectories.add(loginDirectory.directory);
      for (const step of directorySteps) {
        touchedCredentialDirectories.add(path.resolve(step.path));
      }
    }
    for (const directory of touchedCredentialDirectories) {
      const directoryState = recoveryState(directory);
      if (!directoryState.safe || (directoryState.exists && !directoryState.stats.isDirectory())) return false;
      if (!directoryState.exists) continue;
      let entries;
      try {
        entries = filesystem.readdirSync(directory, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const entry of entries) {
        if (!isCredentialFileName(entry.name)) continue;
        const candidate = path.resolve(path.join(directory, entry.name));
        const state = recoveryState(candidate);
        if (
          !knownCredentialPaths.has(candidate)
          || !state.safe
          || !state.exists
          || !state.stats.isFile()
          || (
            knownCredentialIdentities.size > 0
            && !knownCredentialIdentities.has(`${state.stats.dev}:${state.stats.ino}`)
          )
        ) return false;
      }
    }

    if (transaction.operation === 'add' && generatedPaths.size > 0) {
      const createdDirectories = new Set(directorySteps.map((step) => path.resolve(step.path)));
      for (const candidate of generatedPaths) {
        if (
          isStoredRecoveryCredential(candidate)
          && !createdDirectories.has(path.resolve(path.dirname(candidate)))
        ) return false;
      }
      const activeBefore = stateSteps.length === 1
        ? stateSteps[0].beforeExists
        : Boolean(readActiveProfile());
      const activeCredentialPathsBefore = credentialPathsBefore.filter((candidate) => {
        const parts = recoveryPathParts(activeDir, candidate);
        return parts && parts.length === 1;
      });
      if (
        (activeBefore && activeCredentialPathsBefore.length !== 1)
        || (!activeBefore && activeCredentialPathsBefore.length !== 0)
        || (activeBefore && !nonGeneratedCredentialMoves.some((step) => (
          path.resolve(step.source) === path.resolve(activeCredentialPathsBefore[0])
        )))
      ) return false;
    }
    if (transaction.operation === 'reauth') {
      if (
        typeof transaction.preservedCredentialPath !== 'string'
        || recoveryMoveKind(transaction.preservedCredentialPath) !== 'credential'
        || generatedPathKeys.has(path.resolve(transaction.preservedCredentialPath))
        || !credentialPathsBefore.some((candidate) => (
          path.resolve(candidate) === path.resolve(transaction.preservedCredentialPath)
        ))
      ) return false;
      const preserved = recoveryState(transaction.preservedCredentialPath);
      if (!preserved.safe || !preserved.exists || !preserved.stats.isFile()) return false;
      const credentialDeletions = deletionSteps.filter((step) => step.type === 'delete-file');
      if (
        credentialDeletions.length > 1
        || (credentialDeletions.length === 1 && (
          path.resolve(credentialDeletions[0].path) !== path.resolve(transaction.preservedCredentialPath)
        ))
      ) return false;
    } else if (transaction.preservedCredentialPath !== undefined) {
      return false;
    }
    const movedPaths = new Set([
      ...nonGeneratedPaths,
      ...[...generatedPaths].map((candidate) => path.resolve(candidate)),
    ]);
    if (deletionSteps.some((step) => movedPaths.has(path.resolve(step.path)))) return false;

    if (transaction.status === 'rolled-back') {
      for (const step of stateSteps) {
        const state = recoveryState(step.path);
        if (state.exists !== step.beforeExists) return false;
        if (state.exists) {
          try {
            if (filesystem.readFileSync(step.path, 'utf8').trim() !== step.beforeProfile) return false;
          } catch {
            return false;
          }
        }
      }
      for (const step of profileDirectoryMoves) {
        const source = recoveryState(step.source);
        const destination = recoveryState(step.destination);
        if (!source.exists || !source.stats.isDirectory() || destination.exists) return false;
      }
      if (directorySteps.some((step) => recoveryState(step.path).exists)) return false;
      return true;
    }

    for (const step of [...transaction.steps].reverse()) {
      if (step.type !== 'move' || step.generated) continue;
      const sourceExists = pathExistsInPlan(step.source);
      const destinationExists = pathExistsInPlan(step.destination);
      if (!step.started) {
        if (!sourceExists || destinationExists) return false;
        continue;
      }
      if (sourceExists && !destinationExists) continue;
      if (!sourceExists && destinationExists) {
        setPathExistsInPlan(step.source, true);
        setPathExistsInPlan(step.destination, false);
        continue;
      }
      return false;
    }

    for (const step of transaction.steps.filter((candidate) => candidate.type === 'state')) {
      if (step.started && transaction.status !== 'rolled-back') continue;
      const stateExists = pathExistsInPlan(step.path);
      if (stateExists !== step.beforeExists) return false;
      if (stateExists) {
        try {
          if (filesystem.readFileSync(step.path, 'utf8').trim() !== step.beforeProfile) return false;
        } catch {
          return false;
        }
      }
    }

    for (const step of [...directorySteps].reverse()) {
      if (!step.started || !pathExistsInPlan(step.path)) continue;
      let entries;
      try {
        entries = filesystem.readdirSync(step.path, { withFileTypes: true });
      } catch {
        return false;
      }
      if (entries.some((entry) => pathExistsInPlan(path.join(step.path, entry.name)))) {
        return false;
      }
      setPathExistsInPlan(step.path, false);
    }
    return true;
  }

  function transactionHasSafeRolledBackRecord(transaction) {
    return Boolean(
      transaction
      && transaction.status === 'rolled-back'
      && transaction.cleanupReady === true
      && Array.isArray(transaction.generatedCredentialPaths)
      && Array.isArray(transaction.generatedCredentialIdentities)
      && Array.isArray(transaction.credentialPathsBefore)
      && Array.isArray(transaction.credentialIdentitiesBefore)
      && transaction.generatedCredentialPaths.length === transaction.generatedCredentialIdentities.length
      && transaction.credentialPathsBefore.length === transaction.credentialIdentitiesBefore.length
      && transactionHasDeterministicRollback(transaction)
    );
  }

  function transactionHasSafeCommittedRecord(transaction) {
    if (
      !transaction
      || transaction.schemaVersion !== TRANSACTION_SCHEMA_VERSION
      || !PROFILE_MUTATION_OPERATIONS.has(transaction.operation)
      || !Number.isSafeInteger(transaction.pid)
      || transaction.pid <= 0
      || typeof transaction.startedAt !== 'string'
      || !transaction.startedAt
      || transaction.status !== 'committed'
      || transaction.cleanupReady !== true
      || !Array.isArray(transaction.steps)
      || transaction.steps.length === 0
      || !Array.isArray(transaction.generatedCredentialPaths)
      || !Array.isArray(transaction.generatedCredentialIdentities)
      || !Array.isArray(transaction.credentialPathsBefore)
      || !Array.isArray(transaction.credentialIdentitiesBefore)
      || transaction.generatedCredentialPaths.length !== transaction.generatedCredentialIdentities.length
      || transaction.credentialPathsBefore.length !== transaction.credentialIdentitiesBefore.length
    ) return false;
    if (!recoveryLoginDirectory(transaction).valid) return false;

    function validIdentity(identity, expectedPath) {
      return Boolean(
        identity
        && typeof identity.path === 'string'
        && path.resolve(identity.path) === path.resolve(expectedPath)
        && typeof identity.device === 'number'
        && Number.isFinite(identity.device)
        && typeof identity.inode === 'number'
        && Number.isFinite(identity.inode)
      );
    }

    if (
      transaction.generatedCredentialPaths.some((candidate) => (
        typeof candidate !== 'string' || recoveryMoveKind(candidate) !== 'credential'
      ))
      || transaction.credentialPathsBefore.some((candidate) => (
        typeof candidate !== 'string' || recoveryMoveKind(candidate) !== 'credential'
      ))
      || transaction.generatedCredentialIdentities.some((identity, index) => (
        !validIdentity(identity, transaction.generatedCredentialPaths[index])
      ))
      || transaction.credentialIdentitiesBefore.some((identity, index) => (
        !validIdentity(identity, transaction.credentialPathsBefore[index])
      ))
    ) return false;

    let hasGeneratedMove = false;
    let hasCredentialMove = false;
    let hasProfileMove = false;
    let hasStateStep = false;
    let hasCredentialDeletion = false;
    let hasDirectoryDeletion = false;
    for (const step of transaction.steps) {
      if (!step || typeof step.type !== 'string') return false;
      if (step.type === 'move') {
        const sourceKind = typeof step.source === 'string' && recoveryMoveKind(step.source);
        if (
          !sourceKind
          || typeof step.destination !== 'string'
          || recoveryMoveKind(step.destination) !== sourceKind
          || path.resolve(step.source) === path.resolve(step.destination)
          || step.started !== true
          || step.applied !== true
          || typeof step.generated !== 'boolean'
          || (sourceKind === 'profile-directory' && transaction.operation !== 'rename')
          || (sourceKind === 'credential' && ['delete', 'rename'].includes(transaction.operation))
          || (step.generated && !['add', 'reauth'].includes(transaction.operation))
          || !recoveryPathState(step.source).safe
          || !recoveryPathState(step.destination).safe
        ) return false;
        if (step.generated) hasGeneratedMove = true;
        else if (sourceKind === 'credential') hasCredentialMove = true;
        else hasProfileMove = true;
        continue;
      }
      if (step.type === 'state') {
        if (
          typeof step.path !== 'string'
          || path.resolve(step.path) !== path.resolve(stateFile)
          || step.started !== true
          || step.applied !== true
          || typeof step.beforeExists !== 'boolean'
          || !Number.isInteger(step.beforeMode)
          || (step.beforeMode & 0o077) !== 0
          || (step.beforeMode & 0o700) === 0
          || (step.beforeExists && (
            typeof step.beforeProfile !== 'string'
            || !validRecoveryProfileName(step.beforeProfile)
          ))
          || !['add', 'deactivate', 'rename', 'use'].includes(transaction.operation)
          || !recoveryPathState(step.path).safe
          || hasStateStep
        ) return false;
        hasStateStep = true;
        continue;
      }
      if (step.type === 'mkdir') {
        if (
          typeof step.path !== 'string'
          || !isRecoveryProfileDirectory(step.path)
          || step.started !== true
          || step.created !== true
          || !['add', 'reauth', 'use'].includes(transaction.operation)
          || !recoveryPathState(step.path).safe
        ) return false;
        continue;
      }
      if (step.type === 'delete-file' || step.type === 'delete-directory') {
        if (
          typeof step.path !== 'string'
          || step.started !== true
          || step.applied !== true
          || !['delete', 'reauth'].includes(transaction.operation)
          || (step.type === 'delete-file' && recoveryMoveKind(step.path) !== 'credential')
          || (step.type === 'delete-directory' && (
            transaction.operation !== 'delete' || !isRecoveryProfileDirectory(step.path)
          ))
          || !recoveryPathState(step.path).safe
          || recoveryPathState(step.path).exists
        ) return false;
        if (step.type === 'delete-file') hasCredentialDeletion = true;
        else hasDirectoryDeletion = true;
        continue;
      }
      return false;
    }

    const operationComplete = {
      add: hasGeneratedMove && hasStateStep,
      deactivate: hasCredentialMove && hasStateStep,
      delete: hasCredentialDeletion && hasDirectoryDeletion,
      reauth: hasGeneratedMove && hasCredentialDeletion,
      rename: hasProfileMove,
      use: hasCredentialMove && hasStateStep,
    };
    return operationComplete[transaction.operation] === true;
  }

  function repairTransaction(repairs) {
    let transaction;
    try {
      transaction = readTransaction();
    } catch {
      return {
        code: 'recovery-ambiguous',
        message: 'The Profile recovery record is not safe for automatic repair.',
      };
    }
    if (!transaction) return null;
    const terminalRecord = ['committed', 'rolled-back'].includes(transaction.status);
    const safeRecord = terminalRecord
      ? transaction.status === 'committed'
        ? transactionHasSafeCommittedRecord(transaction)
        : transactionHasSafeRolledBackRecord(transaction)
      : transactionHasDeterministicRollback(transaction);
    if (!safeRecord) {
      return {
        code: 'recovery-ambiguous',
        message: 'The staged Profile transaction has no single safe automatic repair.',
      };
    }
    try {
      if (isProcessRunning(transaction.pid)) {
        return {
          code: 'recovery-owner-active',
          message: 'The staged Profile transaction owner is still running.',
        };
      }
    } catch {
      return {
        code: 'recovery-owner-unknown',
        message: 'The staged Profile transaction owner could not be checked.',
      };
    }
    if (terminalRecord) {
      try {
        removeTransaction();
      } catch {
        return {
          code: 'recovery-ambiguous',
          message: 'The completed Profile recovery record could not be removed safely.',
        };
      }
      repairs.push({
        code: 'transaction-record-cleared',
        target: 'Profile recovery transaction',
        message: 'The completed Profile recovery record was removed.',
      });
      return null;
    }
    try {
      rollbackTransaction(transaction);
    } catch {
      return {
        code: 'recovery-ambiguous',
        message: 'The staged Profile transaction could not be restored safely.',
      };
    }
    repairs.push({
      code: 'transaction-restored',
      target: 'Profile recovery transaction',
      message: 'The staged Profile transaction was restored to its previous state.',
    });
    return null;
  }

  function writeRepairReport(report, io, json) {
    if (json) {
      io.stdout(JSON.stringify(report));
      return;
    }
    for (const repair of report.repairs) io.stdout(`Repair [${repair.code}]: ${repair.message}`);
    if (report.profiles.length === 0) io.stdout('No saved Profiles.');
    else {
      io.stdout('Profile health:');
      for (const profile of report.profiles) io.stdout(`${profile.active ? '*' : ' '} ${formatProfile(profile)}`);
    }
    if (report.issues.length === 0) io.stdout('No Profile health issues.');
    else writeInspectionIssues(report, io);
  }

  function repairProfiles(io, json, force) {
    const repairs = [];
    let profileRootNeedsPermissionRepair = false;
    let profileRootMissing = false;
    try {
      const rootStats = filesystem.lstatSync(profilesDir);
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        const report = { ...inspectProfiles(), repairs };
        writeRepairReport(report, io, json);
        return 3;
      }
      profileRootNeedsPermissionRepair = (rootStats.mode & 0o777) !== 0o700;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        const report = { ...inspectProfiles(), repairs };
        writeRepairReport(report, io, json);
        return 3;
      }
      profileRootMissing = true;
    }
    if (profileRootMissing) {
      const report = { ...inspectProfiles(), repairs };
      writeRepairReport(report, io, json);
      return report.issues.length > 0 ? 3 : 0;
    }
    const lockState = operationLockRepairState();
    if (lockState.blockedCode) {
      const report = { ...inspectProfiles(), repairs };
      const messages = {
        'invalid-operation-lock': 'The Profile operation lock is invalid and was not changed.',
        'operation-in-progress': 'A Profile operation is still running, so its lock was not changed.',
        'operation-lock-owner-unknown': 'The Profile operation lock owner could not be checked.',
      };
      if (messages[lockState.blockedCode]) {
        addRepairIssue(report, lockState.blockedCode, messages[lockState.blockedCode]);
      }
      writeRepairReport(report, io, json);
      return 3;
    }
    const sessionRunning = Boolean(isSessionRunning());
    if (!force && sessionRunning) {
      const report = { ...inspectProfiles(), repairs };
      addRepairIssue(
        report,
        'session-running',
        'A Claudex or proxy session is running. Close it before changing Profiles or use --force.',
      );
      writeRepairReport(report, io, json);
      return 3;
    }
    if (lockState.stale && !removeStaleOperationLock(lockState, repairs)) {
      const report = { ...inspectProfiles(), repairs };
      addRepairIssue(report, 'operation-lock-changed', 'The Profile operation lock changed during repair and was not removed.');
      writeRepairReport(report, io, json);
      return 3;
    }

    let releaseLock;
    try {
      releaseLock = operationLock.acquire('doctor --repair');
    } catch {
      const report = { ...inspectProfiles(), repairs };
      let lockExists = false;
      try {
        lockExists = pathExists(lockFile);
      } catch {
        // The inspection report contains the available storage error.
      }
      if (lockExists) {
        addRepairIssue(report, 'operation-in-progress', 'Another Profile operation acquired the lock first.');
      } else {
        addRepairIssue(report, 'operation-lock-acquire-failed', 'The repair could not acquire the Profile operation lock.');
      }
      writeRepairReport(report, io, json);
      return lockExists ? 3 : 1;
    }
    let recoveryIssue = null;
    try {
      repairPrivatePermissions(repairs);
      if (
        profileRootNeedsPermissionRepair
        && (filesystem.lstatSync(profilesDir).mode & 0o777) === 0o700
      ) {
        recordPermissionRepair(repairs, 'Profile storage');
      }
      recoveryIssue = repairTransaction(repairs);
      repairPrivatePermissions(repairs);
    } finally {
      releaseLock();
    }

    const report = { ...inspectProfiles(), repairs };
    if (recoveryIssue) addRepairIssue(report, recoveryIssue.code, recoveryIssue.message);
    writeRepairReport(report, io, json);
    return report.issues.length > 0 ? 3 : 0;
  }

  function createCommandError(message, exitCode) {
    const error = new Error(message);
    error.exitCode = exitCode;
    return error;
  }

  function invalidInputError(message) {
    return createCommandError(message, 2);
  }

  function unsafeStateError(message) {
    return createCommandError(message, 3);
  }

  function readTransactionFile() {
    if (!pathExists(transactionFile)) return null;
    assertRegularFile(transactionFile, 'Profile recovery record');
    try {
      const transaction = JSON.parse(filesystem.readFileSync(transactionFile, 'utf8'));
      if (!transaction || transaction.schemaVersion !== TRANSACTION_SCHEMA_VERSION || !transaction.status) {
        throw new Error('invalid record');
      }
      return transaction;
    } catch {
      throw unsafeStateError('Profile recovery record is invalid. Manual Profile recovery is required.');
    }
  }

  function writeTransactionFile(transaction) {
    ensureDir(profilesDir);
    writePrivateJson(transactionFile, transaction);
  }

  function removeFile(file) {
    try {
      filesystem.unlinkSync(file);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  function removeTransactionFile() {
    if (pathExists(transactionFile)) removeFile(transactionFile);
  }

  function readTransaction() {
    return recoveryStore.read();
  }

  function writeTransaction(transaction) {
    recoveryStore.write(transaction);
  }

  function removeTransaction() {
    recoveryStore.remove();
  }

  function assertNoRecovery() {
    if (readTransaction()) {
      throw unsafeStateError('Profile recovery is required before another mutation.');
    }
  }

  function acquireOperationLockFile(command) {
    ensureOperationLockDirectory();
    const metadata = {
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      operation: command,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    try {
      filesystem.writeFileSync(lockFile, `${JSON.stringify(metadata)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      try {
        filesystem.chmodSync(lockFile, 0o600);
      } catch {
        // Some systems do not support chmod on all file systems.
      }
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        throw new Error('Another Profile mutation is in progress.');
      }
      throw new Error('Cannot create the Profile operation lock.');
    }

    return () => removeFile(lockFile);
  }

  function credentialIdentity(file) {
    const stats = filesystem.lstatSync(file);
    return {
      path: file,
      device: stats.dev,
      inode: stats.ino,
    };
  }

  function createTransaction(command, prepared) {
    if (pathExists(transactionFile)) {
      throw unsafeStateError('Profile recovery is required before another mutation.');
    }
    const credentialPathsBefore = [...new Set([
      ...(Array.isArray(prepared.activeFiles) ? prepared.activeFiles : []),
      ...(Array.isArray(prepared.targetFiles) ? prepared.targetFiles : []),
      ...(prepared.activeFile ? [prepared.activeFile] : []),
      ...(prepared.oldFile ? [prepared.oldFile] : []),
      ...(prepared.targetFile ? [prepared.targetFile] : []),
    ])];
    const transaction = {
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      operation: command,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      status: 'active',
      steps: [],
      generatedCredentialPaths: [],
      generatedCredentialIdentities: [],
      credentialPathsBefore,
      credentialIdentitiesBefore: credentialPathsBefore.map(credentialIdentity),
    };
    if (command === 'add') transaction.loginDirectory = activeDir;
    if (command === 'reauth') {
      transaction.preservedCredentialPath = prepared.oldFile;
      transaction.loginDirectory = prepared.targetIsActive
        ? profileDir(prepared.targetName)
        : activeDir;
    }
    writeTransaction(transaction);
    return transaction;
  }

  function addStep(transaction, step) {
    transaction.steps.push(step);
    writeTransaction(transaction);
  }

  function updateStep(transaction, step, fields) {
    Object.assign(step, fields);
    writeTransaction(transaction);
  }

  function journalEnsureDir(transaction, directory) {
    if (pathExists(directory)) {
      ensureDir(directory);
      return;
    }

    const step = { type: 'mkdir', path: directory, started: false, created: false };
    addStep(transaction, step);
    updateStep(transaction, step, { started: true });
    ensureDir(directory);
    updateStep(transaction, step, { created: true });
  }

  function journalMove(transaction, source, destination, generated = false) {
    const step = {
      type: 'move',
      source,
      destination,
      generated,
      started: false,
      applied: false,
    };
    addStep(transaction, step);
    updateStep(transaction, step, { started: true });
    filesystem.renameSync(source, destination);
    updateStep(transaction, step, { applied: true });
  }

  function journalPermanentRemoval(transaction, type, target, remove) {
    const step = {
      type,
      path: target,
      started: false,
      applied: false,
    };
    addStep(transaction, step);
    updateStep(transaction, step, { started: true });
    remove();
    updateStep(transaction, step, { applied: true });
  }

  function snapshotStateFile() {
    if (!pathExists(stateFile)) {
      return { exists: false, content: '', mode: 0o600 };
    }
    const stats = filesystem.lstatSync(stateFile);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw unsafeStateError('Unsafe Profile storage: active Profile state must be a regular file.');
    }
    return {
      exists: true,
      content: filesystem.readFileSync(stateFile, 'utf8'),
      mode: stats.mode & 0o777,
    };
  }

  function journalWriteActiveProfile(transaction, name) {
    const step = createStateStep(transaction);
    updateStep(transaction, step, { started: true });
    writeActiveProfile(name);
    updateStep(transaction, step, { applied: true });
  }

  function createStateStep(transaction) {
    const snapshot = snapshotStateFile();
    const step = {
      type: 'state',
      path: stateFile,
      beforeExists: snapshot.exists,
      beforeMode: snapshot.mode,
      beforeProfile: snapshot.exists && PROFILE_NAME_PATTERN.test(snapshot.content.trim())
        ? snapshot.content.trim()
        : null,
      started: false,
      applied: false,
    };
    Object.defineProperty(step, 'beforeContent', {
      configurable: true,
      enumerable: false,
      value: snapshot.content,
      writable: true,
    });
    addStep(transaction, step);
    return step;
  }

  function journalRemoveActiveProfile(transaction) {
    const step = createStateStep(transaction);
    updateStep(transaction, step, { started: true });
    removeFile(stateFile);
    updateStep(transaction, step, { applied: true });
  }

  function markGeneratedCredential(transaction, file) {
    if (!transaction.generatedCredentialPaths.includes(file)) {
      const identity = credentialIdentity(file);
      transaction.generatedCredentialPaths.push(file);
      transaction.generatedCredentialIdentities.push(identity);
      writeTransaction(transaction);
    }
  }

  function credentialIdentityMatches(transaction, file) {
    const identity = (transaction.credentialIdentitiesBefore || []).find((candidate) => (
      path.resolve(candidate.path) === path.resolve(file)
    ));
    if (!identity) return false;
    try {
      const stats = filesystem.lstatSync(file);
      return !stats.isSymbolicLink()
        && stats.isFile()
        && stats.dev === identity.device
        && stats.ino === identity.inode;
    } catch {
      return false;
    }
  }

  function captureGeneratedCredentials(transaction, originalFiles, directory = activeDir) {
    const entries = filesystem.readdirSync(directory, { withFileTypes: true });
    const stillOriginal = new Set(originalFiles.filter((file) => (
      pathExists(file) && credentialIdentityMatches(transaction, file)
    )));
    const generated = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (!stillOriginal.has(file)) {
        markGeneratedCredential(transaction, file);
        generated.push(file);
      }
    }
    return generated;
  }

  function generatedCandidatePaths(transaction) {
    const candidates = new Set(transaction.generatedCredentialPaths);
    const generatedSteps = transaction.steps.filter((step) => step.type === 'move' && step.generated);
    for (const step of generatedSteps) {
      candidates.add(step.source);
      candidates.add(step.destination);
    }
    return candidates;
  }

  function removeGeneratedCredentials(transaction) {
    for (const file of generatedCandidatePaths(transaction)) {
      if (!pathExists(file)) continue;
      const stats = filesystem.lstatSync(file);
      if (stats.isSymbolicLink() || stats.isFile()) {
        removeFile(file);
      } else if (stats.isDirectory()) {
        filesystem.rmdirSync(file);
      } else {
        throw unsafeStateError('generated Credential storage is unsafe');
      }
    }
  }

  function rollbackMove(step) {
    const sourceExists = pathExists(step.source);
    const destinationExists = pathExists(step.destination);
    if (sourceExists && !destinationExists) return;
    if (!sourceExists && destinationExists) {
      filesystem.renameSync(step.destination, step.source);
      return;
    }
    if (!sourceExists && !destinationExists) {
      throw unsafeStateError('a recorded Profile move is missing');
    }
    throw unsafeStateError('a recorded Profile move is ambiguous');
  }

  function rollbackPermanentRemoval(step) {
    if (pathExists(step.path) && !step.applied) return;
    throw unsafeStateError('a recorded permanent Profile deletion cannot be rolled back');
  }

  function restoreState(step) {
    if (step.beforeExists) {
      const stats = pathExists(step.path) ? filesystem.lstatSync(step.path) : null;
      if (stats && stats.isSymbolicLink()) throw unsafeStateError('active Profile state became a symlink');
      const content = step.beforeContent !== undefined
        ? step.beforeContent
        : step.beforeProfile
          ? `${step.beforeProfile}\n`
          : null;
      if (content === null) throw unsafeStateError('the previous active Profile state is unavailable');
      filesystem.writeFileSync(step.path, content, { mode: step.beforeMode || 0o600 });
      try {
        filesystem.chmodSync(step.path, step.beforeMode || 0o600);
      } catch {
        // Some systems do not support chmod on all file systems.
      }
      return;
    }
    if (pathExists(step.path)) {
      const stats = filesystem.lstatSync(step.path);
      if (stats.isSymbolicLink()) throw unsafeStateError('active Profile state became a symlink');
      removeFile(step.path);
    }
  }

  function removeCreatedDirectories(transaction) {
    const directories = transaction.steps
      .filter((step) => step.type === 'mkdir' && step.started)
      .reverse();
    for (const step of directories) {
      if (!pathExists(step.path)) continue;
      const stats = filesystem.lstatSync(step.path);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw unsafeStateError('a recorded Profile directory is unsafe');
      }
      filesystem.rmdirSync(step.path);
    }
  }

  function rollbackTransaction(transaction) {
    const failures = [];
    try {
      removeGeneratedCredentials(transaction);
    } catch (error) {
      failures.push(error);
    }

    for (const step of [...transaction.steps].reverse()) {
      try {
        if (step.type === 'state' && step.started) {
          restoreState(step);
        } else if (step.type === 'move' && step.started && !step.generated) {
          rollbackMove(step);
        } else if (['delete-file', 'delete-directory'].includes(step.type) && step.started) {
          rollbackPermanentRemoval(step);
        }
      } catch (error) {
        failures.push(error);
      }
    }

    try {
      removeCreatedDirectories(transaction);
    } catch (error) {
      failures.push(error);
    }

    if (failures.length > 0) {
      throw unsafeStateError('rollback failed');
    }

    transaction.status = 'rolled-back';
    transaction.cleanupReady = true;
    writeTransaction(transaction);
    removeTransaction();
  }

  function completeTransaction(transaction) {
    transaction.status = 'committed';
    transaction.cleanupReady = true;
    writeTransaction(transaction);
    removeTransaction();
  }

  function runWithProxyStatePreserved(work) {
    if (!proxyService) return withProxyStopped(work);
    const wasRunning = Boolean(proxyService.isRunning());
    if (!wasRunning) return work();
    try {
      proxyService.stop();
    } catch (stopError) {
      try {
        proxyService.start();
      } catch (restartError) {
        const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
        throw new Error(`${stopMessage} Proxy restart also failed.`);
      }
      throw stopError;
    }
    let result;
    let operationError = null;
    try {
      result = work();
    } catch (error) {
      operationError = error;
    }
    try {
      proxyService.start();
    } catch (restartError) {
      if (operationError) {
        const operationMessage = operationError instanceof Error ? operationError.message : String(operationError);
        throw new Error(`${operationMessage} Proxy restart also failed.`);
      }
      throw restartError;
    }
    if (operationError) throw operationError;
    return result;
  }

  function runMutation(command, force, prepare, operation) {
    const releaseLock = operationLock.acquire(command);
    let transaction = null;
    let callbackStarted = false;
    try {
      assertNoRecovery();
      assertSafeMutationStorage();
      const sessionRunning = Boolean(isSessionRunning());
      if (!force && sessionRunning) {
        throw new Error('A Claudex or proxy session is running. Close it before changing Profiles or use --force.');
      }

      const prepared = prepare();
      if (prepared && prepared.noop) return prepared;

      transaction = createTransaction(command, prepared);
      return runWithProxyStatePreserved(() => {
        callbackStarted = true;
        try {
          operation(transaction, prepared);
          completeTransaction(transaction);
          return prepared;
        } catch (error) {
          if (transaction.status === 'committed') throw error;
          try {
            rollbackTransaction(transaction);
          } catch (rollbackError) {
            transaction.status = 'recovery-required';
            transaction.errorCode = 'rollback-failed';
            transaction.error = 'Rollback failed. Manual Profile recovery is required.';
            try {
              writeTransaction(transaction);
            } catch {
              // Keep the original recovery failure when the record itself cannot be updated.
            }
            throw unsafeStateError('Profile mutation failed and rollback failed. Manual Profile recovery is required.');
          }
          throw error;
        }
      });
    } catch (error) {
      if (transaction && !callbackStarted && transaction.status === 'active') {
        try {
          removeTransaction();
        } catch {
          transaction.status = 'recovery-required';
          transaction.errorCode = 'transaction-cleanup-failed';
          transaction.error = 'Transaction cleanup failed. Manual Profile recovery is required.';
          try {
            writeTransaction(transaction);
          } catch {
            // The lock and service error remain the actionable information.
          }
          throw unsafeStateError('Profile mutation could not start and recovery is required.');
        }
      }
      throw error;
    } finally {
      releaseLock();
    }
  }

  function useProfile(name, io, force) {
    const result = runMutation('use', force, () => {
      const targetName = requireExistingProfile(name);
      const targetFiles = safeCredentialFiles(profileDir(targetName), targetName, false);
      const activeFiles = safeActiveCredentialFiles();
      const current = readActiveProfile();
      if (current) validateStoredProfileName(current);
      const currentName = findExistingProfile(current) || current;

      assertActiveCredentialState(activeFiles, current);
      if (current && normalizeName(currentName) === normalizeName(targetName) && activeFiles.length === 1) {
        if (targetFiles.length !== 0) {
          throw unsafeStateError(`Active Profile '${targetName}' has duplicate Credential storage.`);
        }
        return { noop: true, targetName };
      }
      if (targetFiles.length !== 1) {
        throw unsafeStateError(`Profile '${targetName}' must contain exactly one Codex Credential.`);
      }
      return { targetName, targetFiles, activeFiles, currentName };
    }, (transaction, prepared) => {
      if (prepared.activeFiles.length === 1) {
        const currentDir = profileDir(prepared.currentName);
        const currentFiles = safeCredentialFiles(currentDir, prepared.currentName, false);
        if (currentFiles.length !== 0) {
          throw unsafeStateError(`Current Profile '${prepared.currentName}' already contains a Credential.`);
        }
        moveCredential(prepared.activeFiles[0], currentDir, transaction);
      }
      moveCredential(prepared.targetFiles[0], activeDir, transaction);
      journalWriteActiveProfile(transaction, prepared.targetName);
    });
    if (result && result.noop) {
      io.stdout(`Already active: ${result.targetName}`);
      return;
    }
    io.stdout(`Active Profile: ${result.targetName}`);
  }

  function addProfile(name, io, force) {
    runMutation('add', force, () => {
      validateProfileName(name);
      if (profileNameInUse(name) || pathExists(profileDir(name))) {
        throw invalidInputError(`Profile name already exists: ${name}`);
      }
      const targetDir = profileDir(name);
      const current = readActiveProfile();
      if (current) validateStoredProfileName(current);
      const currentName = findExistingProfile(current) || current;
      const activeFiles = safeActiveCredentialFiles();

      assertActiveCredentialState(activeFiles, current);
      if (current) {
        const currentFiles = safeCredentialFiles(profileDir(currentName), currentName, false);
        if (currentFiles.length !== 0) {
          throw unsafeStateError(`Current Profile '${currentName}' already contains a Credential.`);
        }
      }
      return { targetDir, currentName, activeFiles };
    }, (transaction, prepared) => {
      journalEnsureDir(transaction, prepared.targetDir);
      if (prepared.activeFiles.length === 1) {
        moveCredential(prepared.activeFiles[0], profileDir(prepared.currentName), transaction);
      }

      const newFile = loginForProfile(transaction, prepared.activeFiles, name, io);
      moveCredential(newFile, prepared.targetDir, transaction, true);
      moveCredential(path.join(prepared.targetDir, credentialFileName(newFile)), activeDir, transaction, true);
      journalWriteActiveProfile(transaction, name);
    });
    io.stdout(`Active Profile: ${name}`);
  }

  function deactivateProfile(io, force) {
    const result = runMutation('deactivate', force, () => {
      const current = readActiveProfile();
      if (!current) throw unsafeStateError('No active Profile is recorded.');
      validateStoredProfileName(current);

      const targetName = findExistingProfile(current);
      if (!targetName) {
        throw unsafeStateError(`Active Profile '${current}' does not exist.`);
      }

      const activeFiles = safeActiveCredentialFiles();
      const targetFiles = safeCredentialFiles(profileDir(targetName), targetName, false);
      assertActiveCredentialState(activeFiles, current);
      if (activeFiles.length !== 1 || targetFiles.length !== 0) {
        throw unsafeStateError(`Active Profile '${targetName}' must contain exactly one active Codex Credential.`);
      }

      return { targetName, activeFile: activeFiles[0] };
    }, (transaction, prepared) => {
      moveCredential(prepared.activeFile, profileDir(prepared.targetName), transaction);
      journalRemoveActiveProfile(transaction);
    });
    io.stdout(`Deactivated Profile: ${result.targetName}`);
  }

  function deleteProfile(name, io, force, confirmed) {
    const result = runMutation('delete', force, () => {
      const targetName = requireExistingProfile(name);
      const current = readActiveProfile();
      if (current) validateStoredProfileName(current);
      const currentName = findExistingProfile(current) || current;
      if (current && normalizeName(currentName) === normalizeName(targetName)) {
        throw invalidInputError(`Profile '${targetName}' is active. Deactivate it before deletion.`);
      }

      const targetFiles = safeCredentialFiles(profileDir(targetName), targetName, true);
      if (!confirmed && confirmProfileDeletion(targetName) !== targetName) {
        throw invalidInputError(`Deletion confirmation must exactly match Profile '${targetName}'.`);
      }
      return { targetName, targetFile: targetFiles[0] };
    }, (transaction, prepared) => {
      journalPermanentRemoval(
        transaction,
        'delete-file',
        prepared.targetFile,
        () => removeFile(prepared.targetFile),
      );
      const targetDir = profileDir(prepared.targetName);
      journalPermanentRemoval(
        transaction,
        'delete-directory',
        targetDir,
        () => filesystem.rmdirSync(targetDir),
      );
    });
    io.stdout(`Deleted Profile: ${result.targetName}`);
  }

  function loginForProfile(
    transaction,
    originalActiveFiles,
    name,
    io,
    loginDirectory = activeDir,
    originalLoginFiles = originalActiveFiles,
  ) {
    journalEnsureDir(transaction, loginDirectory);
    io.stdout(`Starting Codex login for Profile: ${name}`);
    let loginError = null;
    try {
      login(loginDirectory);
    } catch (error) {
      loginError = error;
    }
    const generatedActiveFiles = captureGeneratedCredentials(
      transaction,
      originalActiveFiles,
      activeDir,
    );
    if (loginDirectory !== activeDir) {
      for (const file of generatedActiveFiles) {
        journalMove(
          transaction,
          file,
          reauthCredentialDestination(loginDirectory, file),
          true,
        );
      }
    }
    const newFiles = captureGeneratedCredentials(
      transaction,
      originalLoginFiles,
      loginDirectory,
    );
    if (loginError) throw loginError;
    if (newFiles.length !== 1) {
      throw unsafeStateError('Login did not create exactly one Codex Credential.');
    }
    validateGeneratedCredentialFile(newFiles[0], name);
    return newFiles[0];
  }

  function reauthCredentialDestination(directory, file) {
    const original = path.join(directory, credentialFileName(file));
    if (!pathExists(original)) return original;
    return path.join(directory, `codex-reauth-${crypto.randomUUID()}.json`);
  }

  function reauthProfile(name, io, force, allowAccountChange) {
    const result = runMutation('reauth', force, () => {
      const targetName = requireExistingProfile(name);
      const targetFiles = safeCredentialFiles(profileDir(targetName), targetName, false);
      const activeFiles = safeActiveCredentialFiles();
      const current = readActiveProfile();
      if (current) validateStoredProfileName(current);
      const currentName = findExistingProfile(current) || current;
      const targetIsActive = Boolean(current)
        && normalizeName(currentName) === normalizeName(targetName);

      assertActiveCredentialState(activeFiles, current);

      let oldFile;
      if (targetIsActive) {
        if (targetFiles.length !== 0 || activeFiles.length !== 1) {
          throw unsafeStateError(`Active Profile '${targetName}' must contain exactly one active Codex Credential.`);
        }
        oldFile = activeFiles[0];
      } else {
        if (targetFiles.length !== 1) {
          throw unsafeStateError(`Profile '${targetName}' must contain exactly one Codex Credential.`);
        }
        oldFile = targetFiles[0];
      }

      if (!targetIsActive && activeFiles.length === 1) {
        const currentFiles = safeCredentialFiles(profileDir(currentName), currentName, false);
        if (currentFiles.length !== 0) {
          throw unsafeStateError(`Current Profile '${currentName}' already contains a Credential.`);
        }
      }

      const oldCredential = validateCredentialFile(oldFile);
      assertCredentialIsNotDuplicated(oldFile, targetName);
      return {
        targetName,
        targetIsActive,
        currentName,
        activeFiles,
        oldFile,
        oldEmail: oldCredential.email,
      };
    }, (transaction, prepared) => {
      if (!prepared.targetIsActive && prepared.activeFiles.length === 1) {
        moveCredential(
          prepared.activeFiles[0],
          profileDir(prepared.currentName),
          transaction,
        );
      }

      const loginDirectory = prepared.targetIsActive
        ? profileDir(prepared.targetName)
        : activeDir;
      const originalLoginFiles = prepared.targetIsActive
        ? prepared.targetFiles
        : prepared.activeFiles;
      const newFile = loginForProfile(
        transaction,
        prepared.activeFiles,
        prepared.targetName,
        io,
        loginDirectory,
        originalLoginFiles,
      );
      const newCredential = validateCredentialFile(newFile);
      assertCredentialIsNotDuplicated(newFile, prepared.targetName, [prepared.oldFile]);
      if (newCredential.email !== prepared.oldEmail && !allowAccountChange) {
        throw invalidInputError(
          `Provider account email changed from ${prepared.oldEmail} to ${newCredential.email}; use --allow-account-change to continue.`,
        );
      }

      if (prepared.targetIsActive) {
        journalMove(
          transaction,
          newFile,
          reauthCredentialDestination(activeDir, newFile),
          true,
        );
      } else {
        journalMove(
          transaction,
          newFile,
          reauthCredentialDestination(profileDir(prepared.targetName), newFile),
          true,
        );
        if (prepared.activeFiles.length === 1) {
          moveCredential(
            path.join(profileDir(prepared.currentName), credentialFileName(prepared.activeFiles[0])),
            activeDir,
            transaction,
          );
        }
      }
      journalPermanentRemoval(
        transaction,
        'delete-file',
        prepared.oldFile,
        () => removeFile(prepared.oldFile),
      );
    });
    io.stdout(`Reauthenticated Profile: ${result.targetName}`);
  }

  function renameProfile(oldName, newName, io, force) {
    runMutation('rename', force, () => {
      validateProfileName(oldName);
      validateProfileName(newName);
      const existingOldName = requireExistingProfile(oldName);
      if (profileNameInUse(newName) || pathExists(profileDir(newName))) {
        throw invalidInputError(`Profile name already exists: ${newName}`);
      }
      const current = readActiveProfile();
      if (current) validateStoredProfileName(current);
      const oldFiles = safeCredentialFiles(profileDir(existingOldName), existingOldName, false);
      const activeFiles = safeActiveCredentialFiles();
      const oldIsActive = Boolean(current) && normalizeName(current) === normalizeName(existingOldName);
      const hasOneCredential = !oldIsActive
        ? oldFiles.length === 1
        : (activeFiles.length === 1 && oldFiles.length === 0)
          || (activeFiles.length === 0 && oldFiles.length === 1);
      if (!hasOneCredential) {
        throw unsafeStateError(`Profile '${existingOldName}' must contain exactly one Codex Credential.`);
      }
      return { existingOldName, current };
    }, (transaction, prepared) => {
      journalMove(transaction, profileDir(prepared.existingOldName), profileDir(newName));
      if (prepared.current && normalizeName(prepared.current) === normalizeName(prepared.existingOldName)) {
        journalWriteActiveProfile(transaction, newName);
      }
    });
    io.stdout(`Renamed Profile ${oldName} to ${newName}`);
  }

  function usage(io) {
    io.stdout(`Usage:
  claudex-switch list [--json]
  claudex-switch current [--json]
  claudex-switch doctor [--json]
  claudex-switch doctor --repair [--json] [--force]
  claudex-switch use NAME [--force]
  claudex-switch add NAME [--force]
  claudex-switch reauth NAME [--allow-account-change] [--force]
  claudex-switch deactivate [--force]
  claudex-switch delete NAME [--yes] [--force]
  claudex-switch rename OLD_NAME NEW_NAME [--force]

Repair:
  doctor --repair fixes private modes, removes a stale lock only after its owner stops,
  and restores only a transaction with one safe rollback result.
  Symlinked, unexpected, or ambiguous storage stays unchanged.

Environment:
  CLAUDEX_PROXY_SERVICE=auto|brew|systemd|none
  CLAUDEX_PROXY_SERVICE_NAME=cliproxyapi
  CLIPROXY_CONFIG=/path/to/cliproxyapi.conf
  CLIPROXY_AUTH_DIR=/path/to/auth-dir
  CLAUDEX_ACCOUNT_DIR=/path/to/profile-dir
  CLIPROXYAPI_BIN=cliproxyapi

Health statuses: active, ready, needs-reauth, invalid, unregistered, unknown
Exit codes: 0 success, 1 operation or service failure, 2 invalid input, 3 unsafe or incomplete state`);
  }

  function parseArguments(argv) {
    const force = argv.includes('--force');
    const json = argv.includes('--json');
    const repair = argv.includes('--repair');
    const yes = argv.includes('--yes');
    const allowAccountChange = argv.includes('--allow-account-change');
    return {
      force,
      json,
      repair,
      yes,
      allowAccountChange,
      positional: argv.filter((argument) => ![
        '--force',
        '--json',
        '--repair',
        '--yes',
        '--allow-account-change',
      ].includes(argument)),
    };
  }

  function run(argv, io = { stdout: console.log, stderr: console.error }) {
    try {
      const parsed = parseArguments(argv);
      const [command, first, second] = parsed.positional;

      if (!command || command === 'help' || command === '--help' || command === '-h') {
        if (parsed.force) throw createCommandError('--force can be used only with a Profile mutation.', 2);
        if (parsed.json) throw createCommandError('--json can be used only with list, current, or doctor.', 2);
        if (parsed.repair) throw createCommandError('--repair can be used only with doctor.', 2);
        if (parsed.allowAccountChange) {
          throw createCommandError('--allow-account-change can be used only with reauth.', 2);
        }
        if (parsed.yes) throw createCommandError('--yes can be used only with delete.', 2);
        usage(io);
        return 0;
      }
      if (parsed.allowAccountChange && command !== 'reauth') {
        throw createCommandError('--allow-account-change can be used only with reauth.', 2);
      }
      if (parsed.yes && command !== 'delete') {
        throw createCommandError('--yes can be used only with delete.', 2);
      }
      if (parsed.repair && command !== 'doctor') {
        throw createCommandError('--repair can be used only with doctor.', 2);
      }
      if (command === 'list') {
        if (parsed.force) throw createCommandError('--force can be used only with a Profile mutation.', 2);
        if (parsed.positional.length !== 1) throw createCommandError('Invalid command. Use --help for usage.', 2);
        return listProfiles(io, parsed.json);
      }
      if (command === 'current') {
        if (parsed.force) throw createCommandError('--force can be used only with a Profile mutation.', 2);
        if (parsed.positional.length !== 1) throw createCommandError('Invalid command. Use --help for usage.', 2);
        return currentProfile(io, parsed.json);
      }
      if (command === 'doctor') {
        if (parsed.positional.length !== 1) throw createCommandError('Invalid command. Use --help for usage.', 2);
        if (parsed.repair) return repairProfiles(io, parsed.json, parsed.force);
        if (parsed.force) throw createCommandError('--force can be used only with a Profile mutation.', 2);
        return doctor(io, parsed.json);
      }
      if (parsed.json) {
        throw createCommandError('--json can be used only with list, current, or doctor.', 2);
      }
      if (command === 'use' && first && !second) {
        useProfile(first, io, parsed.force);
        return 0;
      }
      if (command === 'add' && first && !second) {
        addProfile(first, io, parsed.force);
        return 0;
      }
      if (command === 'deactivate' && parsed.positional.length === 1) {
        deactivateProfile(io, parsed.force);
        return 0;
      }
      if (command === 'delete' && first && parsed.positional.length === 2) {
        deleteProfile(first, io, parsed.force, parsed.yes);
        return 0;
      }
      if (command === 'reauth' && first && parsed.positional.length === 2) {
        reauthProfile(first, io, parsed.force, parsed.allowAccountChange);
        return 0;
      }
      if (command === 'rename' && first && second && parsed.positional.length === 3) {
        renameProfile(first, second, io, parsed.force);
        return 0;
      }
      throw createCommandError('Invalid command. Use --help for usage.', 2);
    } catch (error) {
      io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return error && Number.isInteger(error.exitCode) ? error.exitCode : 1;
    }
  }

  return { inspectProfiles, run };
}

module.exports = { createProfileLifecycle };
