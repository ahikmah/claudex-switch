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
    ensureDir(profilesDir);
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

  function createTransaction(command) {
    if (pathExists(transactionFile)) {
      throw unsafeStateError('Profile recovery is required before another mutation.');
    }
    const transaction = {
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      operation: command,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      status: 'active',
      steps: [],
      generatedCredentialPaths: [],
    };
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
    updateStep(transaction, step, { started: true });
    writeActiveProfile(name);
    updateStep(transaction, step, { applied: true });
  }

  function markGeneratedCredential(transaction, file) {
    if (!transaction.generatedCredentialPaths.includes(file)) {
      transaction.generatedCredentialPaths.push(file);
      writeTransaction(transaction);
    }
  }

  function captureGeneratedCredentials(transaction, originalActiveFiles) {
    const entries = filesystem.readdirSync(activeDir, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith('codex-') && entry.name.endsWith('.json'));
    const stillOriginal = new Set(originalActiveFiles.filter((file) => pathExists(file)));
    for (const entry of entries) {
      const file = path.join(activeDir, entry.name);
      if (!stillOriginal.has(file)) markGeneratedCredential(transaction, file);
    }
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
      .filter((step) => step.type === 'mkdir' && step.created)
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
    writeTransaction(transaction);
    removeTransaction();
  }

  function completeTransaction(transaction) {
    transaction.status = 'committed';
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

      transaction = createTransaction(command);
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

      if (activeFiles.length > 1) {
        throw unsafeStateError('More than one active Codex Credential exists.');
      }
      if (current && normalizeName(currentName) === normalizeName(targetName) && activeFiles.length === 1) {
        if (targetFiles.length !== 0) {
          throw unsafeStateError(`Active Profile '${targetName}' has duplicate Credential storage.`);
        }
        return { noop: true, targetName };
      }
      if (targetFiles.length !== 1) {
        throw unsafeStateError(`Profile '${targetName}' must contain exactly one Codex Credential.`);
      }
      if (activeFiles.length === 1 && !current) {
        throw unsafeStateError('The active Credential is not registered.');
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

      if (activeFiles.length > 1) {
        throw unsafeStateError('More than one active Codex Credential exists.');
      }
      if (activeFiles.length === 1 && !current) {
        throw unsafeStateError('The active Credential is not registered.');
      }
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

      io.stdout(`Starting Codex login for Profile: ${name}`);
      let loginError = null;
      try {
        login();
      } catch (error) {
        loginError = error;
      }
      captureGeneratedCredentials(transaction, prepared.activeFiles);
      if (loginError) throw loginError;

      const newFiles = safeActiveCredentialFiles();
      if (newFiles.length !== 1) {
        throw unsafeStateError('Login did not create exactly one Codex Credential.');
      }
      markGeneratedCredential(transaction, newFiles[0]);
      moveCredential(newFiles[0], prepared.targetDir, transaction, true);
      moveCredential(path.join(prepared.targetDir, credentialFileName(newFiles[0])), activeDir, transaction, true);
      journalWriteActiveProfile(transaction, name);
    });
    io.stdout(`Active Profile: ${name}`);
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
  claudex-switch use NAME [--force]
  claudex-switch add NAME [--force]
  claudex-switch rename OLD_NAME NEW_NAME [--force]

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
    return {
      force,
      json,
      positional: argv.filter((argument) => argument !== '--force' && argument !== '--json'),
    };
  }

  function run(argv, io = { stdout: console.log, stderr: console.error }) {
    try {
      const parsed = parseArguments(argv);
      const [command, first, second] = parsed.positional;

      if (!command || command === 'help' || command === '--help' || command === '-h') {
        if (parsed.force) throw createCommandError('--force can be used only with a Profile mutation.', 2);
        if (parsed.json) throw createCommandError('--json can be used only with list, current, or doctor.', 2);
        usage(io);
        return 0;
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
        if (parsed.force) throw createCommandError('--force can be used only with a Profile mutation.', 2);
        if (parsed.positional.length !== 1) throw createCommandError('Invalid command. Use --help for usage.', 2);
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
