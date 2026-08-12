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
const LOCK_FILE_NAME = '.operation.lock';
const TRANSACTION_FILE_NAME = '.transaction.json';
const TRANSACTION_SCHEMA_VERSION = 1;

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
      throw new Error(`Unsafe Profile storage: ${directory} must be a real directory.`);
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
      throw new Error(`Unsafe Profile storage: ${description} must be a regular file.`);
    }
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Unsafe Profile storage: ${description} must be private.`);
    }
  }

  function assertPrivateMode(stats, description) {
    if ((stats.mode & 0o077) !== 0) {
      throw new Error(`Unsafe Profile storage: ${description} must be private.`);
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
        throw new Error(`Profile names conflict without case differences: ${seen.get(normalized)}, ${name}. Manual resolution is required.`);
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
      throw new Error(`Credential file ${credentialFileName(file)} ${reason}.`);
    }
  }

  function safeCredentialFiles(directory, label, requireExactlyOne) {
    if (!pathExists(directory)) {
      if (requireExactlyOne) throw new Error(`Profile '${label}' does not exist.`);
      return [];
    }

    const directoryStats = filesystem.lstatSync(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new Error(`Unsafe Profile storage: Profile '${label}' must be a real directory.`);
    }
    assertPrivateMode(directoryStats, `Profile '${label}'`);

    const files = [];
    for (const entry of filesystem.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stats = filesystem.lstatSync(file);
      if (stats.isSymbolicLink()) {
        throw new Error(`Unsafe Profile storage: Profile '${label}' contains a symlink.`);
      }
      if (!stats.isFile()) {
        throw new Error(`Unsafe Profile storage: Profile '${label}' contains an unexpected entry.`);
      }
      assertPrivateMode(stats, `Credential file ${entry.name}`);
      if (!entry.name.startsWith('codex-') || !entry.name.endsWith('.json')) {
        throw new Error(`Unsafe Profile storage: Profile '${label}' contains an unexpected file.`);
      }
      files.push(file);
    }

    for (const file of files) validateCredentialFile(file);
    if (requireExactlyOne && files.length !== 1) {
      throw new Error(`Profile '${label}' must contain exactly one Codex Credential.`);
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
        throw new Error('Unsafe Profile storage: the active Credential is a symlink.');
      }
      if (entry.name.startsWith('codex-') && entry.name.endsWith('.json')) {
        if (!stats.isFile()) {
          throw new Error('Unsafe Profile storage: the active Credential is not a regular file.');
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
    if (current) validateProfileName(current);
    for (const name of profileDirectories()) {
      const files = safeCredentialFiles(profileDir(name), name, false);
      const active = Boolean(current) && normalizeName(name) === normalizeName(current);
      const expectedCount = active && activeFiles.length === 1 ? 0 : 1;
      if (files.length !== expectedCount) {
        throw new Error(`Profile '${name}' must contain exactly one Codex Credential.`);
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
        throw new Error(`Unsafe Profile storage: ${entry.name} is a symlink.`);
      }
      if (allowedRootFiles.has(entryPath)) {
        if (!stats.isFile()) {
          throw new Error(`Unsafe Profile storage: ${entry.name} must be a regular file.`);
        }
        assertPrivateMode(stats, entry.name);
        continue;
      }
      if (entry.name.startsWith('.') || !stats.isDirectory()) {
        throw new Error(`Unsafe Profile storage: ${entry.name} is an unexpected entry.`);
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
      throw new Error('Profile recovery record is invalid. Manual Profile recovery is required.');
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
      throw new Error('Profile recovery is required before another mutation.');
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
      throw new Error('Profile recovery is required before another mutation.');
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
      throw new Error('Unsafe Profile storage: active Profile state must be a regular file.');
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
        throw new Error('generated Credential storage is unsafe');
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
      throw new Error('a recorded Profile move is missing');
    }
    throw new Error('a recorded Profile move is ambiguous');
  }

  function restoreState(step) {
    if (step.beforeExists) {
      const stats = pathExists(step.path) ? filesystem.lstatSync(step.path) : null;
      if (stats && stats.isSymbolicLink()) throw new Error('active Profile state became a symlink');
      const content = step.beforeContent !== undefined
        ? step.beforeContent
        : step.beforeProfile
          ? `${step.beforeProfile}\n`
          : null;
      if (content === null) throw new Error('the previous active Profile state is unavailable');
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
      if (stats.isSymbolicLink()) throw new Error('active Profile state became a symlink');
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
        throw new Error('a recorded Profile directory is unsafe');
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
      throw new Error('rollback failed');
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
            throw new Error('Profile mutation failed and rollback failed. Manual Profile recovery is required.');
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
          throw new Error('Profile mutation could not start and recovery is required.');
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
      if (current) validateProfileName(current);
      const currentName = findExistingProfile(current) || current;

      if (activeFiles.length > 1) {
        throw new Error('More than one active Codex Credential exists.');
      }
      if (current && normalizeName(currentName) === normalizeName(targetName) && activeFiles.length === 1) {
        if (targetFiles.length !== 0) {
          throw new Error(`Active Profile '${targetName}' has duplicate Credential storage.`);
        }
        return { noop: true, targetName };
      }
      if (targetFiles.length !== 1) {
        throw new Error(`Profile '${targetName}' must contain exactly one Codex Credential.`);
      }
      if (activeFiles.length === 1 && !current) {
        throw new Error('The active Credential is not registered.');
      }
      return { targetName, targetFiles, activeFiles, currentName };
    }, (transaction, prepared) => {
      if (prepared.activeFiles.length === 1) {
        const currentDir = profileDir(prepared.currentName);
        const currentFiles = safeCredentialFiles(currentDir, prepared.currentName, false);
        if (currentFiles.length !== 0) {
          throw new Error(`Current Profile '${prepared.currentName}' already contains a Credential.`);
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
        throw new Error(`Profile name already exists: ${name}`);
      }
      const targetDir = profileDir(name);
      const current = readActiveProfile();
      if (current) validateProfileName(current);
      const currentName = findExistingProfile(current) || current;
      const activeFiles = safeActiveCredentialFiles();

      if (activeFiles.length > 1) {
        throw new Error('More than one active Codex Credential exists.');
      }
      if (activeFiles.length === 1 && !current) {
        throw new Error('The active Credential is not registered.');
      }
      if (current) {
        const currentFiles = safeCredentialFiles(profileDir(currentName), currentName, false);
        if (currentFiles.length !== 0) {
          throw new Error(`Current Profile '${currentName}' already contains a Credential.`);
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
        throw new Error('Login did not create exactly one Codex Credential.');
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
        throw new Error(`Profile name already exists: ${newName}`);
      }
      const current = readActiveProfile();
      if (current) validateProfileName(current);
      const oldFiles = safeCredentialFiles(profileDir(existingOldName), existingOldName, false);
      const activeFiles = safeActiveCredentialFiles();
      const oldIsActive = Boolean(current) && normalizeName(current) === normalizeName(existingOldName);
      const hasOneCredential = !oldIsActive
        ? oldFiles.length === 1
        : (activeFiles.length === 1 && oldFiles.length === 0)
          || (activeFiles.length === 0 && oldFiles.length === 1);
      if (!hasOneCredential) {
        throw new Error(`Profile '${existingOldName}' must contain exactly one Codex Credential.`);
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
  claudex-switch list
  claudex-switch current
  claudex-switch use NAME [--force]
  claudex-switch add NAME [--force]
  claudex-switch rename OLD_NAME NEW_NAME [--force]

Environment:
  CLAUDEX_PROXY_SERVICE=auto|brew|systemd|none
  CLAUDEX_PROXY_SERVICE_NAME=cliproxyapi
  CLIPROXY_CONFIG=/path/to/cliproxyapi.conf
  CLIPROXY_AUTH_DIR=/path/to/auth-dir
  CLAUDEX_ACCOUNT_DIR=/path/to/profile-dir
  CLIPROXYAPI_BIN=cliproxyapi`);
  }

  function parseArguments(argv) {
    const force = argv.includes('--force');
    return {
      force,
      positional: argv.filter((argument) => argument !== '--force'),
    };
  }

  function run(argv, io = { stdout: console.log, stderr: console.error }) {
    try {
      ensureDir(activeDir);
      ensureDir(profilesDir);
      const parsed = parseArguments(argv);
      const [command, first, second] = parsed.positional;

      if (!command || command === 'help' || command === '--help' || command === '-h') {
        if (parsed.force) throw new Error('--force can be used only with a Profile mutation.');
        usage(io);
        return 0;
      }
      if (command === 'list') {
        if (parsed.force) throw new Error('--force can be used only with a Profile mutation.');
        listProfiles(io);
        return 0;
      }
      if (command === 'current') {
        if (parsed.force) throw new Error('--force can be used only with a Profile mutation.');
        const current = readActiveProfile();
        if (!current) throw new Error('No active Profile is recorded.');
        io.stdout(current);
        return 0;
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
      throw new Error('Invalid command. Use --help for usage.');
    } catch (error) {
      io.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  return { run };
}

module.exports = { createProfileLifecycle };
