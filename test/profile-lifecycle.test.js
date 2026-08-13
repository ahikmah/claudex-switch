'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createProfileLifecycle } = require('../lib/profile-lifecycle');
const packageMetadata = require('../package.json');

function writeCredential(directory, filename, email, extra = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, filename),
    JSON.stringify({ email, ...extra }),
    { mode: 0o600 },
  );
}

function createHarness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-switch-'));
  const activeDir = path.join(root, 'active');
  const profilesDir = path.join(root, 'profiles');
  const lockFile = path.join(profilesDir, '.operation.lock');
  const transactionFile = path.join(profilesDir, '.transaction.json');
  const output = { stdout: [], stderr: [] };
  const events = [];
  const signalSource = options.signalSource || new EventEmitter();
  let loginNumber = 0;

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const lifecycleOptions = {
    filesystem: options.filesystem || fs,
    activeDir,
    profilesDir,
    signalSource,
    lockFile,
    transactionFile,
    withProxyStopped(work) {
      events.push('proxy:before');
      const result = work();
      events.push('proxy:after');
      return result;
    },
    login() {
      loginNumber += 1;
      writeCredential(activeDir, `codex-login-${loginNumber}.json`, `login-${loginNumber}@example.com`);
    },
  };
  if (options.isSessionRunning) lifecycleOptions.isSessionRunning = options.isSessionRunning;
  if (options.isProcessRunning) lifecycleOptions.isProcessRunning = options.isProcessRunning;
  if (options.proxyService) lifecycleOptions.proxyService = options.proxyService;
  if (options.withProxyStopped) lifecycleOptions.withProxyStopped = options.withProxyStopped;
  if (options.operationLock) lifecycleOptions.operationLock = options.operationLock;
  if (options.recoveryStore) lifecycleOptions.recoveryStore = options.recoveryStore;
  if (options.login) lifecycleOptions.login = options.login;
  if (options.onlineHealthCheck) lifecycleOptions.onlineHealthCheck = options.onlineHealthCheck;
  if (options.confirmProfileDeletion) {
    lifecycleOptions.confirmProfileDeletion = options.confirmProfileDeletion;
  }

  const lifecycle = createProfileLifecycle(lifecycleOptions);

  function run(argv) {
    output.stdout.length = 0;
    output.stderr.length = 0;
    const code = lifecycle.run(argv, {
      stdout: (line) => output.stdout.push(line),
      stderr: (line) => output.stderr.push(line),
    });
    return { code, stdout: [...output.stdout], stderr: [...output.stderr] };
  }

  return { root, activeDir, profilesDir, lockFile, transactionFile, events, signalSource, run };
}

function setActiveProfile(profilesDir, name) {
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(path.join(profilesDir, 'active-profile'), `${name}\n`, { mode: 0o600 });
}

function readActiveProfile(profilesDir) {
  return fs.readFileSync(path.join(profilesDir, 'active-profile'), 'utf8').trim();
}

function credentialNames(directory) {
  return fs.readdirSync(directory).sort();
}

function permissionMode(target) {
  return fs.statSync(target).mode & 0o777;
}

function generatedIdentity(recordedPath, currentPath = recordedPath) {
  const stats = fs.lstatSync(currentPath);
  return { path: recordedPath, device: stats.dev, inode: stats.ino };
}

function readJson(result) {
  assert.equal(result.stdout.length, 1);
  return JSON.parse(result.stdout[0]);
}

test('list shows active and inactive Profiles with email addresses', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'same@example.com', { scope: 'personal' });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'same@example.com', { scope: 'team' });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['list']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, [
    '* personal (same@example.com, active)',
    '  team (same@example.com, ready)',
  ]);
  assert.deepEqual(result.stderr, []);
});

test('current reports the active Profile', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['current']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ['Active Profile: personal (personal@example.com, active)']);
});

test('version prints the package version without reading Profile storage', (t) => {
  const harness = createHarness(t);

  const long = harness.run(['--version']);
  const short = harness.run(['-v']);

  assert.equal(long.code, 0);
  assert.deepEqual(long.stdout, [packageMetadata.version]);
  assert.deepEqual(long.stderr, []);
  assert.equal(short.code, 0);
  assert.deepEqual(short.stdout, [packageMetadata.version]);
  assert.equal(fs.existsSync(harness.activeDir), false);
  assert.equal(fs.existsSync(harness.profilesDir), false);
});

test('list, current, and doctor share the read-only JSON Profile contract', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'same@example.com', { scope: 'personal' });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'same@example.com', { scope: 'team' });
  setActiveProfile(harness.profilesDir, 'personal');

  const list = harness.run(['list', '--json']);
  const current = harness.run(['current', '--json']);
  const doctor = harness.run(['doctor', '--json']);

  const expectedProfiles = [
    {
      name: 'personal',
      email: 'same@example.com',
      active: true,
      status: 'active',
      errorCodes: [],
    },
    {
      name: 'team',
      email: 'same@example.com',
      active: false,
      status: 'ready',
      errorCodes: [],
    },
  ];

  assert.equal(list.code, 0);
  assert.deepEqual(readJson(list), {
    schemaVersion: 1,
    profiles: expectedProfiles,
    issues: [],
  });
  assert.equal(current.code, 0);
  assert.deepEqual(readJson(current), {
    schemaVersion: 1,
    profile: expectedProfiles[0],
    issues: [],
  });
  assert.equal(doctor.code, 0);
  assert.deepEqual(readJson(doctor), {
    schemaVersion: 1,
    profiles: expectedProfiles,
    issues: [],
  });
});

test('read-only inspection does not create or change storage', (t) => {
  const harness = createHarness(t);
  const before = fs.readdirSync(harness.root).sort();

  const list = harness.run(['list', '--json']);
  const current = harness.run(['current', '--json']);
  const doctor = harness.run(['doctor', '--json']);

  assert.equal(list.code, 0);
  assert.equal(current.code, 3);
  assert.equal(doctor.code, 0);
  assert.deepEqual(readJson(current), {
    schemaVersion: 1,
    profile: null,
    issues: [{
      code: 'no-active-profile',
      profile: null,
      message: 'No active Profile is recorded.',
    }],
  });
  assert.deepEqual(fs.readdirSync(harness.root).sort(), before);
  assert.equal(fs.existsSync(harness.profilesDir), false);
  assert.equal(fs.existsSync(harness.activeDir), false);
});

test('doctor reports malformed, missing, multiple, and unexpected Credential storage', (t) => {
  const harness = createHarness(t);
  const malformedDir = path.join(harness.profilesDir, 'malformed');
  const missingDir = path.join(harness.profilesDir, 'missing');
  const multipleDir = path.join(harness.profilesDir, 'multiple');
  const unexpectedDir = path.join(harness.profilesDir, 'unexpected');
  fs.mkdirSync(malformedDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(malformedDir, 'codex-bad.json'),
    '{"email":"bad@example.com","access_token":"secret-token"',
    { mode: 0o600 },
  );
  fs.mkdirSync(missingDir, { recursive: true, mode: 0o700 });
  writeCredential(multipleDir, 'codex-one.json', 'one@example.com', { token: 'one' });
  writeCredential(multipleDir, 'codex-two.json', 'two@example.com', { token: 'two' });
  writeCredential(unexpectedDir, 'credential.txt', 'unexpected@example.com', { access_token: 'secret-token' });

  const result = harness.run(['doctor', '--json']);
  const report = readJson(result);
  const profiles = new Map(report.profiles.map((profile) => [profile.name, profile]));

  assert.equal(result.code, 3);
  assert.equal(profiles.get('malformed').status, 'invalid');
  assert.ok(profiles.get('malformed').errorCodes.includes('malformed-credential'));
  assert.equal(profiles.get('missing').status, 'invalid');
  assert.ok(profiles.get('missing').errorCodes.includes('missing-credential'));
  assert.equal(profiles.get('multiple').status, 'invalid');
  assert.ok(profiles.get('multiple').errorCodes.includes('multiple-credentials'));
  assert.equal(profiles.get('unexpected').status, 'invalid');
  assert.ok(profiles.get('unexpected').errorCodes.includes('unexpected-file'));
  assert.deepEqual(
    new Set(report.issues.map((issue) => issue.code)),
    new Set(['malformed-credential', 'missing-credential', 'multiple-credentials', 'unexpected-file']),
  );
  assert.doesNotMatch(JSON.stringify(report), /secret-token/);
});

test('doctor reports symlinked Profile storage and non-private permissions', (t) => {
  const harness = createHarness(t);
  const outside = path.join(harness.root, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });
  writeCredential(outside, 'codex-outside.json', 'outside@example.com');
  fs.mkdirSync(harness.profilesDir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(outside, path.join(harness.profilesDir, 'linked'), 'dir');

  const linkedCredentialDir = path.join(harness.profilesDir, 'linked-credential');
  writeCredential(linkedCredentialDir, 'codex-linked.json', 'linked@example.com');
  const target = path.join(harness.root, 'target.json');
  fs.writeFileSync(target, JSON.stringify({ email: 'linked@example.com', access_token: 'secret-token' }), { mode: 0o600 });
  fs.unlinkSync(path.join(linkedCredentialDir, 'codex-linked.json'));
  fs.symlinkSync(target, path.join(linkedCredentialDir, 'codex-linked.json'));

  const publicDir = path.join(harness.profilesDir, 'public');
  writeCredential(publicDir, 'codex-public.json', 'public@example.com');
  fs.chmodSync(publicDir, 0o755);
  fs.chmodSync(path.join(publicDir, 'codex-public.json'), 0o644);

  const result = harness.run(['doctor', '--json']);
  const report = readJson(result);
  const profiles = new Map(report.profiles.map((profile) => [profile.name, profile]));

  assert.equal(result.code, 3);
  assert.ok(profiles.get('linked').errorCodes.includes('symlinked-profile'));
  assert.ok(profiles.get('linked-credential').errorCodes.includes('symlinked-credential'));
  assert.ok(profiles.get('public').errorCodes.includes('permissions'));
  assert.ok(report.issues.some((issue) => issue.code === 'symlinked-profile'));
  assert.ok(report.issues.some((issue) => issue.code === 'symlinked-credential'));
  assert.ok(report.issues.some((issue) => issue.code === 'permissions'));
  assert.doesNotMatch(JSON.stringify(report), /secret-token/);
});

test('doctor allows duplicate email values but rejects exact duplicate Credential data', (t) => {
  const harness = createHarness(t);
  writeCredential(path.join(harness.profilesDir, 'personal'), 'codex-personal.json', 'same@example.com', { token: 'personal' });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'same@example.com', { token: 'team' });
  writeCredential(path.join(harness.profilesDir, 'duplicate-one'), 'codex-one.json', 'duplicate@example.com', { token: 'duplicate-secret' });
  writeCredential(path.join(harness.profilesDir, 'duplicate-two'), 'codex-two.json', 'duplicate@example.com', { token: 'duplicate-secret' });

  const result = harness.run(['doctor', '--json']);
  const report = readJson(result);
  const profiles = new Map(report.profiles.map((profile) => [profile.name, profile]));

  assert.equal(result.code, 3);
  assert.equal(profiles.get('personal').status, 'ready');
  assert.equal(profiles.get('team').status, 'ready');
  assert.equal(profiles.get('duplicate-one').status, 'invalid');
  assert.equal(profiles.get('duplicate-two').status, 'invalid');
  assert.ok(profiles.get('duplicate-one').errorCodes.includes('duplicate-credential'));
  assert.ok(profiles.get('duplicate-two').errorCodes.includes('duplicate-credential'));
  assert.ok(report.issues.some((issue) => issue.code === 'duplicate-credential'));
  assert.doesNotMatch(JSON.stringify(report), /duplicate-secret/);
});

test('doctor reports an active Credential without a matching Profile', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-orphan.json', 'orphan@example.com', { token: 'secret-token' });
  writeCredential(path.join(harness.profilesDir, 'known'), 'codex-known.json', 'known@example.com', { token: 'known' });

  const result = harness.run(['doctor', '--json']);
  const report = readJson(result);
  const orphan = report.profiles.find((profile) => profile.active);

  assert.equal(result.code, 3);
  assert.equal(orphan.name, null);
  assert.equal(orphan.email, 'orphan@example.com');
  assert.equal(orphan.status, 'unregistered');
  assert.deepEqual(orphan.errorCodes, ['unregistered-credential']);
  assert.ok(report.issues.some((issue) => issue.code === 'unregistered-credential'));
  assert.doesNotMatch(JSON.stringify(report), /secret-token/);
});

test('doctor reports unsafe active Credential permissions and incomplete recovery', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com', { token: 'secret-token' });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');
  fs.chmodSync(path.join(harness.activeDir, 'codex-personal.json'), 0o644);
  fs.writeFileSync(
    harness.transactionFile,
    JSON.stringify({ schemaVersion: 1, status: 'recovery-required', operation: 'use' }),
    { mode: 0o600 },
  );

  const result = harness.run(['doctor', '--json']);
  const report = readJson(result);
  const personal = report.profiles.find((profile) => profile.name === 'personal');

  assert.equal(result.code, 3);
  assert.equal(personal.status, 'invalid');
  assert.ok(personal.errorCodes.includes('permissions'));
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-required'));
  assert.doesNotMatch(JSON.stringify(report), /secret-token/);
});

test('doctor human output reports health and issue codes', (t) => {
  const harness = createHarness(t);
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'empty'), { recursive: true, mode: 0o700 });

  const result = harness.run(['doctor']);

  assert.equal(result.code, 3);
  assert.deepEqual(result.stdout, [
    'Profile health:',
    '  empty (email unavailable, invalid)',
    '  team (team@example.com, ready)',
    "Issue [missing-credential]: Profile 'empty' has no Codex Credential.",
  ]);
  assert.deepEqual(result.stderr, []);
});

test('doctor marks every Profile invalid when shared storage permissions are unsafe', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');
  setActiveProfile(harness.profilesDir, 'personal');
  fs.chmodSync(harness.profilesDir, 0o755);

  const result = harness.run(['doctor', '--json']);
  const report = readJson(result);
  const profiles = new Map(report.profiles.map((profile) => [profile.name, profile]));

  assert.equal(result.code, 3);
  assert.equal(profiles.get('personal').status, 'invalid');
  assert.equal(profiles.get('team').status, 'invalid');
  assert.ok(profiles.get('personal').errorCodes.includes('permissions'));
  assert.ok(profiles.get('team').errorCodes.includes('permissions'));
});

test('doctor --repair fixes deterministic directory and file permissions', (t) => {
  const harness = createHarness(t);
  const inactiveDir = path.join(harness.profilesDir, 'team');
  const inactiveCredential = path.join(inactiveDir, 'codex-team.json');
  const activeCredential = path.join(harness.activeDir, 'codex-personal.json');
  const stateFile = path.join(harness.profilesDir, 'active-profile');
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(inactiveDir, 'codex-team.json', 'team@example.com');
  setActiveProfile(harness.profilesDir, 'personal');
  fs.chmodSync(harness.activeDir, 0o755);
  fs.chmodSync(harness.profilesDir, 0o755);
  fs.chmodSync(inactiveDir, 0o500);
  fs.chmodSync(activeCredential, 0o644);
  fs.chmodSync(inactiveCredential, 0o400);
  fs.chmodSync(stateFile, 0o400);

  const result = harness.run(['doctor', '--repair']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stderr, []);
  assert.ok(result.stdout.some((line) => line.startsWith('Repair [permissions-repaired]:')));
  assert.equal(permissionMode(harness.activeDir), 0o700);
  assert.equal(permissionMode(harness.profilesDir), 0o700);
  assert.equal(permissionMode(inactiveDir), 0o700);
  assert.equal(permissionMode(activeCredential), 0o600);
  assert.equal(permissionMode(inactiveCredential), 0o600);
  assert.equal(permissionMode(stateFile), 0o600);
});

test('doctor --repair uses the session warning and --force bypasses only that warning', (t) => {
  let sessionRunning = true;
  const harness = createHarness(t, { isSessionRunning: () => sessionRunning });
  fs.mkdirSync(harness.profilesDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(harness.profilesDir, 0o755);

  const humanWarning = harness.run(['doctor', '--repair']);
  const warned = harness.run(['doctor', '--repair', '--json']);
  const warningReport = readJson(warned);

  assert.equal(humanWarning.code, 3);
  assert.deepEqual(humanWarning.stderr, []);
  assert.ok(humanWarning.stdout.some((line) => line.startsWith('Issue [session-running]:')));
  assert.equal(warned.code, 3);
  assert.deepEqual(warned.stderr, []);
  assert.ok(warningReport.issues.some((issue) => issue.code === 'session-running'));
  assert.equal(permissionMode(harness.profilesDir), 0o755);

  const forced = harness.run(['doctor', '--repair', '--json', '--force']);
  assert.equal(forced.code, 0);
  assert.equal(permissionMode(harness.profilesDir), 0o700);
  sessionRunning = false;
});

test('doctor --repair changes Profile root permissions only while holding the lock', (t) => {
  let profilesDir;
  let lockFile;
  let changedWithoutLock = false;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'chmodSync') return target[property];
      return (file, mode) => {
        if (file === profilesDir && !target.existsSync(lockFile)) changedWithoutLock = true;
        return target.chmodSync(file, mode);
      };
    },
  });
  const harness = createHarness(t, { filesystem });
  profilesDir = harness.profilesDir;
  lockFile = harness.lockFile;
  fs.mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(profilesDir, 0o755);

  const result = harness.run(['doctor', '--repair']);

  assert.equal(result.code, 0);
  assert.equal(changedWithoutLock, false);
  assert.equal(permissionMode(profilesDir), 0o700);
});

test('doctor --repair JSON reports a Profile root permission repair', (t) => {
  const harness = createHarness(t);
  fs.mkdirSync(harness.profilesDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(harness.profilesDir, 0o755);

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.equal(permissionMode(harness.profilesDir), 0o700);
  assert.ok(report.repairs.some((repair) => (
    repair.code === 'permissions-repaired' && repair.target === 'Profile storage'
  )));
  assert.deepEqual(report.issues, []);
});

test('doctor --repair does not create storage when there is nothing to repair', (t) => {
  const harness = createHarness(t);

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.deepEqual(report, {
    schemaVersion: 1,
    profiles: [],
    issues: [],
    repairs: [],
  });
  assert.equal(fs.existsSync(harness.activeDir), false);
  assert.equal(fs.existsSync(harness.profilesDir), false);
});

test('doctor --online reports healthy Profiles with the common JSON contract', (t) => {
  const checks = [];
  let loginCalls = 0;
  const harness = createHarness(t, {
    login() {
      loginCalls += 1;
      throw new Error('reauthentication must not start');
    },
    onlineHealthCheck({ profile, credentialFile }) {
      checks.push({ profile, credentialFile });
      return { status: 'valid' };
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'same@example.com', { scope: 'personal' });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'same@example.com', { scope: 'team' });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['doctor', '--online', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.deepEqual(report, {
    schemaVersion: 1,
    profiles: [
      {
        name: 'personal',
        email: 'same@example.com',
        active: true,
        status: 'active',
        errorCodes: [],
      },
      {
        name: 'team',
        email: 'same@example.com',
        active: false,
        status: 'ready',
        errorCodes: [],
      },
    ],
    issues: [],
  });
  assert.deepEqual(checks.map(({ profile, credentialFile }) => ({
    profile,
    credentialFile: path.basename(credentialFile),
  })), [
    {
      profile: {
        name: 'personal',
        email: 'same@example.com',
        active: true,
        status: 'active',
        errorCodes: [],
      },
      credentialFile: 'codex-personal.json',
    },
    {
      profile: {
        name: 'team',
        email: 'same@example.com',
        active: false,
        status: 'ready',
        errorCodes: [],
      },
      credentialFile: 'codex-team.json',
    },
  ]);
  assert.equal(loginCalls, 0);
  assert.deepEqual(harness.events, []);
});

test('doctor --online reports a rejected Credential as needs-reauth in human output', (t) => {
  let loginCalls = 0;
  const harness = createHarness(t, {
    login() {
      loginCalls += 1;
      throw new Error('reauthentication must not start');
    },
    onlineHealthCheck() {
      return { status: 'unauthorized' };
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');
  const before = fs.readFileSync(path.join(harness.activeDir, 'codex-personal.json'), 'utf8');

  const result = harness.run(['doctor', '--online']);

  assert.equal(result.code, 3);
  assert.deepEqual(result.stdout, [
    'Profile health:',
    '* personal (personal@example.com, needs-reauth)',
    "Issue [credential-rejected]: Online check rejected the Credential for Profile 'personal'. Reauthentication is required.",
  ]);
  assert.deepEqual(result.stderr, []);
  assert.equal(fs.readFileSync(path.join(harness.activeDir, 'codex-personal.json'), 'utf8'), before);
  assert.equal(loginCalls, 0);
  assert.deepEqual(harness.events, []);
});

test('doctor --online reports an expired Credential as needs-reauth', (t) => {
  const harness = createHarness(t, {
    onlineHealthCheck() {
      return { status: 'expired' };
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['doctor', '--online', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.deepEqual(report.profiles[0], {
    name: 'personal',
    email: 'personal@example.com',
    active: true,
    status: 'needs-reauth',
    errorCodes: ['credential-expired'],
  });
  assert.deepEqual(report.issues, [{
    code: 'credential-expired',
    profile: 'personal',
    message: "Online check rejected the Credential for Profile 'personal'. Reauthentication is required.",
  }]);
});

test('doctor --online reports a network failure as unknown with a non-zero exit code', (t) => {
  const harness = createHarness(t, {
    onlineHealthCheck() {
      const error = new Error('provider is unavailable');
      error.code = 'network-error';
      throw error;
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['doctor', '--online', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.deepEqual(report, {
    schemaVersion: 1,
    profiles: [{
      name: 'personal',
      email: 'personal@example.com',
      active: true,
      status: 'unknown',
      errorCodes: ['network-error'],
    }],
    issues: [{
      code: 'network-error',
      profile: 'personal',
      message: "Online check could not confirm the Credential for Profile 'personal'.",
    }],
  });
});

test('offline doctor does not call the online health adapter', (t) => {
  const harness = createHarness(t, {
    onlineHealthCheck() {
      throw new Error('offline diagnosis must not check the Provider');
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['doctor', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.equal(report.profiles[0].status, 'active');
  assert.deepEqual(report.issues, []);
});

test('doctor --repair removes a stale operation lock after its owner stops', (t) => {
  const checkedPids = [];
  const lockEvents = [];
  const harness = createHarness(t, {
    isProcessRunning(pid) {
      checkedPids.push(pid);
      return false;
    },
    operationLock: {
      acquire(command) {
        lockEvents.push(`acquire:${command}`);
        return () => lockEvents.push('release');
      },
    },
  });
  fs.mkdirSync(harness.profilesDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(harness.lockFile, JSON.stringify({
    schemaVersion: 1,
    operation: 'use',
    pid: 4242,
    startedAt: '2026-08-13T00:00:00.000Z',
  }), { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.deepEqual(checkedPids, [4242]);
  assert.deepEqual(lockEvents, ['acquire:doctor --repair', 'release']);
  assert.equal(fs.existsSync(harness.lockFile), false);
  assert.ok(report.repairs.some((repair) => repair.code === 'stale-operation-lock-removed'));
  assert.deepEqual(report.issues, []);
});

test('doctor --repair reports an active operation lock and leaves it unchanged', (t) => {
  const checkedPids = [];
  const harness = createHarness(t, {
    isProcessRunning(pid) {
      checkedPids.push(pid);
      return true;
    },
  });
  const lockContent = JSON.stringify({
    schemaVersion: 1,
    operation: 'reauth',
    pid: 5151,
    startedAt: '2026-08-13T00:00:00.000Z',
  });
  fs.mkdirSync(harness.profilesDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(harness.lockFile, lockContent, { mode: 0o644 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.deepEqual(checkedPids, [5151]);
  assert.equal(fs.readFileSync(harness.lockFile, 'utf8'), lockContent);
  assert.equal(permissionMode(harness.lockFile), 0o644);
  assert.deepEqual(report.repairs, []);
  assert.ok(report.issues.some((issue) => issue.code === 'operation-in-progress'));
});

test('doctor --repair reports an active lock before a running session', (t) => {
  const harness = createHarness(t, {
    isProcessRunning: () => true,
    isSessionRunning: () => true,
  });
  const lockContent = JSON.stringify({
    schemaVersion: 1,
    operation: 'use',
    pid: 5252,
    startedAt: '2026-08-13T00:00:00.000Z',
  });
  fs.mkdirSync(harness.profilesDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(harness.lockFile, lockContent, { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.deepEqual(result.stderr, []);
  assert.equal(fs.readFileSync(harness.lockFile, 'utf8'), lockContent);
  assert.ok(report.issues.some((issue) => issue.code === 'operation-in-progress'));
});

test('doctor --repair restores a deterministic staged transaction', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const personalDir = path.join(harness.profilesDir, 'personal');
  const teamDir = path.join(harness.profilesDir, 'team');
  const originalActiveCredential = path.join(harness.activeDir, 'codex-personal.json');
  const stagedPersonalCredential = path.join(personalDir, 'codex-personal.json');
  const originalTeamCredential = path.join(teamDir, 'codex-team.json');
  const stagedTeamCredential = path.join(harness.activeDir, 'codex-team.json');
  const stateFile = path.join(harness.profilesDir, 'active-profile');
  fs.mkdirSync(personalDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(teamDir, { recursive: true, mode: 0o700 });
  writeCredential(personalDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(harness.activeDir, 'codex-team.json', 'team@example.com', {
    access_token: 'secret-token',
  });
  setActiveProfile(harness.profilesDir, 'team');
  fs.writeFileSync(harness.transactionFile, JSON.stringify({
    schemaVersion: 1,
    operation: 'use',
    pid: 6262,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [
      {
        type: 'move',
        source: originalActiveCredential,
        destination: stagedPersonalCredential,
        generated: false,
        started: true,
        applied: true,
      },
      {
        type: 'move',
        source: originalTeamCredential,
        destination: stagedTeamCredential,
        generated: false,
        started: true,
        applied: true,
      },
      {
        type: 'state',
        path: stateFile,
        beforeExists: true,
        beforeMode: 0o600,
        beforeProfile: 'personal',
        started: true,
        applied: true,
      },
    ],
    generatedCredentialPaths: [],
    generatedCredentialIdentities: [],
    credentialPathsBefore: [originalActiveCredential, originalTeamCredential],
    credentialIdentitiesBefore: [
      generatedIdentity(originalActiveCredential, stagedPersonalCredential),
      generatedIdentity(originalTeamCredential, stagedTeamCredential),
    ],
    errorCode: 'rollback-failed',
    error: 'Rollback failed. Manual Profile recovery is required.',
  }), { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(harness.transactionFile), false);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(originalActiveCredential), true);
  assert.equal(fs.existsSync(stagedPersonalCredential), false);
  assert.equal(fs.existsSync(originalTeamCredential), true);
  assert.equal(fs.existsSync(stagedTeamCredential), false);
  assert.ok(report.repairs.some((repair) => repair.code === 'transaction-restored'));
  assert.deepEqual(report.issues, []);
  assert.doesNotMatch(JSON.stringify(report), /secret-token/);
});

test('doctor --repair does not restore a transaction while its owner runs', (t) => {
  const checkedPids = [];
  const harness = createHarness(t, {
    isProcessRunning(pid) {
      checkedPids.push(pid);
      return true;
    },
  });
  const teamDir = path.join(harness.profilesDir, 'team');
  const originalCredential = path.join(teamDir, 'codex-team.json');
  const stagedCredential = path.join(harness.activeDir, 'codex-team.json');
  fs.mkdirSync(teamDir, { recursive: true, mode: 0o700 });
  writeCredential(harness.activeDir, 'codex-team.json', 'team@example.com');
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'use',
    pid: 6363,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'active',
    steps: [{
      type: 'move',
      source: originalCredential,
      destination: stagedCredential,
      generated: false,
      started: true,
      applied: true,
    }],
    generatedCredentialPaths: [],
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.deepEqual(checkedPids, [6363]);
  assert.equal(fs.existsSync(stagedCredential), true);
  assert.equal(fs.existsSync(originalCredential), false);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-owner-active'));
});

test('doctor --repair leaves an ambiguous transaction unchanged and mutations blocked', (t) => {
  const harness = createHarness(t);
  const teamDir = path.join(harness.profilesDir, 'team');
  const originalCredential = path.join(teamDir, 'codex-team.json');
  const stagedCredential = path.join(harness.activeDir, 'codex-team.json');
  writeCredential(teamDir, 'codex-team.json', 'original@example.com', {
    access_token: 'original-secret',
  });
  writeCredential(harness.activeDir, 'codex-team.json', 'staged@example.com', {
    access_token: 'staged-secret',
  });
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'use',
    pid: 7373,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [{
      type: 'move',
      source: originalCredential,
      destination: stagedCredential,
      generated: false,
      started: true,
      applied: false,
    }],
    generatedCredentialPaths: [],
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });
  const originalBefore = fs.readFileSync(originalCredential, 'utf8');
  const stagedBefore = fs.readFileSync(stagedCredential, 'utf8');

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(fs.readFileSync(originalCredential, 'utf8'), originalBefore);
  assert.equal(fs.readFileSync(stagedCredential, 'utf8'), stagedBefore);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
  assert.doesNotMatch(JSON.stringify(report), /original-secret|staged-secret/);

  const mutation = harness.run(['use', 'team', '--force']);
  assert.equal(mutation.code, 3);
  assert.match(mutation.stderr[0], /recovery is required/i);
});

test('doctor --repair preflights every rollback step before changing state', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const createdDir = path.join(harness.profilesDir, 'new-profile');
  const unexpected = path.join(createdDir, 'unexpected.txt');
  const stateFile = path.join(harness.profilesDir, 'active-profile');
  fs.mkdirSync(createdDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(unexpected, 'keep me', { mode: 0o600 });
  setActiveProfile(harness.profilesDir, 'team');
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'add',
    pid: 7575,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [
      {
        type: 'mkdir',
        path: createdDir,
        started: true,
        created: true,
      },
      {
        type: 'state',
        path: stateFile,
        beforeExists: true,
        beforeMode: 0o600,
        beforeProfile: 'personal',
        started: true,
        applied: true,
      },
    ],
    generatedCredentialPaths: [],
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(readActiveProfile(harness.profilesDir), 'team');
  assert.equal(fs.readFileSync(unexpected, 'utf8'), 'keep me');
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
});

test('doctor --repair rejects a state change without its required use move', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const stateFile = path.join(harness.profilesDir, 'active-profile');
  fs.mkdirSync(harness.profilesDir, { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'team');
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'use',
    pid: 7585,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [{
      type: 'state',
      path: stateFile,
      beforeExists: true,
      beforeMode: 0o600,
      beforeProfile: 'personal',
      started: true,
      applied: true,
    }],
    generatedCredentialPaths: [],
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(readActiveProfile(harness.profilesDir), 'team');
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
});

test('doctor --repair rejects a use state that does not match its Credential move', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const activeCredential = path.join(harness.activeDir, 'codex-personal.json');
  const storedCredential = path.join(harness.profilesDir, 'personal', 'codex-personal.json');
  fs.mkdirSync(path.dirname(storedCredential), { recursive: true, mode: 0o700 });
  writeCredential(path.dirname(storedCredential), path.basename(storedCredential), 'personal@example.com');
  setActiveProfile(harness.profilesDir, 'team');
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'use',
    pid: 7586,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [
      {
        type: 'move',
        source: activeCredential,
        destination: storedCredential,
        generated: false,
        started: true,
        applied: true,
      },
      {
        type: 'state',
        path: path.join(harness.profilesDir, 'active-profile'),
        beforeExists: true,
        beforeMode: 0o600,
        beforeProfile: 'other',
        started: true,
        applied: true,
      },
    ],
    generatedCredentialPaths: [],
    credentialPathsBefore: [activeCredential],
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(readActiveProfile(harness.profilesDir), 'team');
  assert.equal(fs.existsSync(activeCredential), false);
  assert.equal(fs.existsSync(storedCredential), true);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
});

test('doctor --repair removes a directory created before its journal marker was saved', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const createdDir = path.join(harness.profilesDir, 'new-profile');
  fs.mkdirSync(harness.activeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(createdDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(harness.transactionFile, JSON.stringify({
    schemaVersion: 1,
    operation: 'add',
    pid: 7676,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [{
      type: 'mkdir',
      path: createdDir,
      started: true,
      created: false,
    }],
    generatedCredentialPaths: [],
  }), { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);

  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(createdDir), false);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('doctor --repair does not trust generated paths for an unrelated operation', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const teamCredential = path.join(harness.profilesDir, 'team', 'codex-team.json');
  writeCredential(path.dirname(teamCredential), path.basename(teamCredential), 'team@example.com', {
    access_token: 'team-secret',
  });
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'use',
    pid: 7878,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [],
    generatedCredentialPaths: [teamCredential],
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });
  const credentialBefore = fs.readFileSync(teamCredential, 'utf8');

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(fs.readFileSync(teamCredential, 'utf8'), credentialBefore);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
  assert.doesNotMatch(JSON.stringify(report), /team-secret/);
});

test('doctor --repair does not treat the old active Credential as generated by add', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const activeCredential = path.join(harness.activeDir, 'codex-personal.json');
  const targetDir = path.join(harness.profilesDir, 'team');
  const claimedDestination = path.join(targetDir, 'codex-personal.json');
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com', {
    access_token: 'personal-secret',
  });
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'add',
    pid: 7898,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [
      {
        type: 'mkdir',
        path: targetDir,
        started: true,
        created: true,
      },
      {
        type: 'move',
        source: activeCredential,
        destination: claimedDestination,
        generated: true,
        started: false,
        applied: false,
      },
    ],
    generatedCredentialPaths: [activeCredential],
    generatedCredentialIdentities: [generatedIdentity(activeCredential)],
    credentialPathsBefore: [],
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });
  const credentialBefore = fs.readFileSync(activeCredential, 'utf8');

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(fs.readFileSync(activeCredential, 'utf8'), credentialBefore);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
  assert.doesNotMatch(JSON.stringify(report), /personal-secret/);
});

test('doctor --repair restores add when a generated Credential reuses the old path', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const personalDir = path.join(harness.profilesDir, 'personal');
  const targetDir = path.join(harness.profilesDir, 'team');
  const activeCredential = path.join(harness.activeDir, 'codex-personal.json');
  const storedCredential = path.join(personalDir, 'codex-personal.json');
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  writeCredential(personalDir, 'codex-personal.json', 'personal@example.com', {
    access_token: 'old-secret',
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'team@example.com', {
    access_token: 'new-secret',
  });
  setActiveProfile(harness.profilesDir, 'personal');
  fs.writeFileSync(harness.transactionFile, JSON.stringify({
    schemaVersion: 1,
    operation: 'add',
    pid: 7897,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [
      {
        type: 'mkdir',
        path: targetDir,
        started: true,
        created: true,
      },
      {
        type: 'move',
        source: activeCredential,
        destination: storedCredential,
        generated: false,
        started: true,
        applied: true,
      },
    ],
    generatedCredentialPaths: [activeCredential],
    generatedCredentialIdentities: [generatedIdentity(activeCredential)],
    credentialPathsBefore: [activeCredential],
    credentialIdentitiesBefore: [generatedIdentity(activeCredential, storedCredential)],
  }), { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(storedCredential), false);
  assert.equal(fs.existsSync(activeCredential), true);
  assert.match(fs.readFileSync(activeCredential, 'utf8'), /old-secret/);
  assert.equal(fs.existsSync(targetDir), false);
  assert.equal(fs.existsSync(harness.transactionFile), false);
  assert.ok(report.repairs.some((repair) => repair.code === 'transaction-restored'));
  assert.doesNotMatch(JSON.stringify(report), /old-secret|new-secret/);
});

test('doctor --repair removes all recorded generated Credentials', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const targetDir = path.join(harness.profilesDir, 'team');
  const firstCredential = path.join(harness.activeDir, 'codex-first.json');
  const secondCredential = path.join(harness.activeDir, 'codex-second.json');
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  writeCredential(harness.activeDir, 'codex-first.json', 'first@example.com');
  writeCredential(harness.activeDir, 'codex-second.json', 'second@example.com');
  fs.writeFileSync(harness.transactionFile, JSON.stringify({
    schemaVersion: 1,
    operation: 'add',
    pid: 7896,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [{
      type: 'mkdir',
      path: targetDir,
      started: true,
      created: true,
    }],
    generatedCredentialPaths: [firstCredential, secondCredential],
    generatedCredentialIdentities: [
      generatedIdentity(firstCredential),
      generatedIdentity(secondCredential),
    ],
    credentialPathsBefore: [],
    credentialIdentitiesBefore: [],
  }), { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(firstCredential), false);
  assert.equal(fs.existsSync(secondCredential), false);
  assert.equal(fs.existsSync(targetDir), false);
  assert.equal(fs.existsSync(harness.transactionFile), false);
  assert.ok(report.repairs.some((repair) => repair.code === 'transaction-restored'));
});

test('doctor --repair leaves a partly recorded generated set unchanged', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const personalDir = path.join(harness.profilesDir, 'personal');
  const targetDir = path.join(harness.profilesDir, 'team');
  const oldActiveCredential = path.join(harness.activeDir, 'codex-personal.json');
  const storedCredential = path.join(personalDir, 'codex-personal.json');
  const recordedCredential = path.join(harness.activeDir, 'codex-first.json');
  const unrecordedCredential = path.join(harness.activeDir, 'codex-second.json');
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  writeCredential(personalDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(harness.activeDir, 'codex-first.json', 'first@example.com');
  writeCredential(harness.activeDir, 'codex-second.json', 'second@example.com');
  setActiveProfile(harness.profilesDir, 'personal');
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'add',
    pid: 7895,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [
      {
        type: 'mkdir',
        path: targetDir,
        started: true,
        created: true,
      },
      {
        type: 'move',
        source: oldActiveCredential,
        destination: storedCredential,
        generated: false,
        started: true,
        applied: true,
      },
    ],
    generatedCredentialPaths: [recordedCredential],
    generatedCredentialIdentities: [generatedIdentity(recordedCredential)],
    credentialPathsBefore: [oldActiveCredential],
    credentialIdentitiesBefore: [generatedIdentity(oldActiveCredential, storedCredential)],
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(fs.existsSync(recordedCredential), true);
  assert.equal(fs.existsSync(unrecordedCredential), true);
  assert.equal(fs.existsSync(storedCredential), true);
  assert.equal(fs.existsSync(oldActiveCredential), false);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
});

test('doctor --repair leaves an unrecorded first generated Credential unchanged', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const targetDir = path.join(harness.profilesDir, 'team');
  const generatedCredential = path.join(harness.activeDir, 'codex-first.json');
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  writeCredential(harness.activeDir, 'codex-first.json', 'first@example.com');
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'add',
    pid: 7894,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [{
      type: 'mkdir',
      path: targetDir,
      started: true,
      created: true,
    }],
    generatedCredentialPaths: [],
    generatedCredentialIdentities: [],
    credentialPathsBefore: [],
    credentialIdentitiesBefore: [],
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(fs.existsSync(generatedCredential), true);
  assert.equal(fs.existsSync(targetDir), true);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
});

test('doctor --repair restores add after generated Credential discovery', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const personalDir = path.join(harness.profilesDir, 'personal');
  const targetDir = path.join(harness.profilesDir, 'team');
  const originalActiveCredential = path.join(harness.activeDir, 'codex-personal.json');
  const storedPersonalCredential = path.join(personalDir, 'codex-personal.json');
  const generatedCredential = path.join(harness.activeDir, 'codex-new.json');
  fs.mkdirSync(personalDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  writeCredential(personalDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(harness.activeDir, 'codex-new.json', 'new@example.com', {
    access_token: 'new-secret',
  });
  setActiveProfile(harness.profilesDir, 'personal');
  fs.writeFileSync(harness.transactionFile, JSON.stringify({
    schemaVersion: 1,
    operation: 'add',
    pid: 7899,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [
      {
        type: 'mkdir',
        path: targetDir,
        started: true,
        created: true,
      },
      {
        type: 'move',
        source: originalActiveCredential,
        destination: storedPersonalCredential,
        generated: false,
        started: true,
        applied: true,
      },
    ],
    generatedCredentialPaths: [generatedCredential],
    generatedCredentialIdentities: [generatedIdentity(generatedCredential)],
    credentialPathsBefore: [originalActiveCredential],
  }), { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(generatedCredential), false);
  assert.equal(fs.existsSync(originalActiveCredential), true);
  assert.equal(fs.existsSync(storedPersonalCredential), false);
  assert.equal(fs.existsSync(targetDir), false);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(harness.transactionFile), false);
  assert.ok(report.repairs.some((repair) => repair.code === 'transaction-restored'));
  assert.doesNotMatch(JSON.stringify(report), /new-secret/);
});

test('doctor --repair clears legacy non-Credential login artifacts after rollback', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const personalDir = path.join(harness.profilesDir, 'personal');
  const targetDir = path.join(harness.profilesDir, 'team');
  const originalActiveCredential = path.join(harness.activeDir, 'codex-personal.json');
  const storedPersonalCredential = path.join(personalDir, 'codex-personal.json');
  const generatedCredential = path.join(harness.activeDir, 'codex-generated.json');
  const logsDirectory = path.join(harness.activeDir, 'logs');
  fs.mkdirSync(personalDir, { recursive: true, mode: 0o700 });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  setActiveProfile(harness.profilesDir, 'personal');
  writeCredential(harness.activeDir, 'codex-generated.json', 'generated@example.com');
  const generatedCredentialIdentity = generatedIdentity(generatedCredential);
  fs.unlinkSync(generatedCredential);
  fs.mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(logsDirectory, 'session.log'), 'keep this log\n', { mode: 0o600 });
  fs.writeFileSync(harness.transactionFile, JSON.stringify({
    schemaVersion: 1,
    operation: 'add',
    pid: 7900,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [
      {
        type: 'mkdir',
        path: targetDir,
        started: true,
        created: true,
      },
      {
        type: 'move',
        source: originalActiveCredential,
        destination: storedPersonalCredential,
        generated: false,
        started: true,
        applied: true,
      },
    ],
    generatedCredentialPaths: [generatedCredential, logsDirectory],
    generatedCredentialIdentities: [
      generatedCredentialIdentity,
      generatedIdentity(logsDirectory),
    ],
    credentialPathsBefore: [originalActiveCredential],
    credentialIdentitiesBefore: [generatedIdentity(originalActiveCredential)],
    loginDirectory: harness.activeDir,
    errorCode: 'rollback-failed',
    error: 'Rollback failed. Manual Profile recovery is required.',
  }), { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(harness.transactionFile), false);
  assert.equal(fs.existsSync(originalActiveCredential), true);
  assert.equal(fs.existsSync(storedPersonalCredential), false);
  assert.equal(fs.existsSync(targetDir), false);
  assert.equal(fs.existsSync(path.join(logsDirectory, 'session.log')), true);
  assert.ok(report.repairs.some((repair) => repair.code === 'transaction-record-cleared'));
  assert.deepEqual(report.issues, []);
});

test('doctor --repair does not remove an incomplete completed record', (t) => {
  const harness = createHarness(t);
  fs.mkdirSync(harness.profilesDir, { recursive: true, mode: 0o700 });
  const transaction = JSON.stringify({ schemaVersion: 1, status: 'committed' });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
});

test('doctor --repair clears a complete committed record without rolling it back', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const activeCredential = path.join(harness.activeDir, 'codex-team.json');
  const storedCredential = path.join(harness.profilesDir, 'team', 'codex-team.json');
  writeCredential(path.dirname(storedCredential), path.basename(storedCredential), 'team@example.com');
  fs.writeFileSync(harness.transactionFile, JSON.stringify({
    schemaVersion: 1,
    operation: 'deactivate',
    pid: 7761,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'committed',
    cleanupReady: true,
    steps: [
      {
        type: 'move',
        source: activeCredential,
        destination: storedCredential,
        generated: false,
        started: true,
        applied: true,
      },
      {
        type: 'state',
        path: path.join(harness.profilesDir, 'active-profile'),
        beforeExists: true,
        beforeMode: 0o600,
        beforeProfile: 'team',
        started: true,
        applied: true,
      },
    ],
    generatedCredentialPaths: [],
    generatedCredentialIdentities: [],
    credentialPathsBefore: [activeCredential],
    credentialIdentitiesBefore: [generatedIdentity(activeCredential, storedCredential)],
  }), { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(activeCredential), false);
  assert.equal(fs.existsSync(storedCredential), true);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'active-profile')), false);
  assert.equal(fs.existsSync(harness.transactionFile), false);
  assert.ok(report.repairs.some((repair) => repair.code === 'transaction-record-cleared'));
});

test('doctor --repair clears a complete rolled-back record', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const activeCredential = path.join(harness.activeDir, 'codex-team.json');
  const storedCredential = path.join(harness.profilesDir, 'team', 'codex-team.json');
  writeCredential(harness.activeDir, 'codex-team.json', 'team@example.com');
  fs.mkdirSync(path.dirname(storedCredential), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'team');
  fs.writeFileSync(harness.transactionFile, JSON.stringify({
    schemaVersion: 1,
    operation: 'deactivate',
    pid: 7762,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'rolled-back',
    cleanupReady: true,
    steps: [
      {
        type: 'move',
        source: activeCredential,
        destination: storedCredential,
        generated: false,
        started: true,
        applied: true,
      },
      {
        type: 'state',
        path: path.join(harness.profilesDir, 'active-profile'),
        beforeExists: true,
        beforeMode: 0o600,
        beforeProfile: 'team',
        started: true,
        applied: true,
      },
    ],
    generatedCredentialPaths: [],
    generatedCredentialIdentities: [],
    credentialPathsBefore: [activeCredential],
    credentialIdentitiesBefore: [generatedIdentity(activeCredential)],
  }), { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(activeCredential), true);
  assert.equal(fs.existsSync(storedCredential), false);
  assert.equal(readActiveProfile(harness.profilesDir), 'team');
  assert.equal(fs.existsSync(harness.transactionFile), false);
  assert.ok(report.repairs.some((repair) => repair.code === 'transaction-record-cleared'));
});

test('doctor --repair clears a rolled-back switch with two Credential moves', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const personalCredential = path.join(harness.activeDir, 'codex-personal.json');
  const stagedPersonalCredential = path.join(harness.profilesDir, 'personal', 'codex-personal.json');
  const teamCredential = path.join(harness.profilesDir, 'team', 'codex-team.json');
  const stagedTeamCredential = path.join(harness.activeDir, 'codex-team.json');
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.dirname(teamCredential), path.basename(teamCredential), 'team@example.com');
  fs.mkdirSync(path.dirname(stagedPersonalCredential), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');
  fs.writeFileSync(harness.transactionFile, JSON.stringify({
    schemaVersion: 1,
    operation: 'use',
    pid: 7763,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'rolled-back',
    cleanupReady: true,
    steps: [
      {
        type: 'move',
        source: personalCredential,
        destination: stagedPersonalCredential,
        generated: false,
        started: true,
        applied: true,
      },
      {
        type: 'move',
        source: teamCredential,
        destination: stagedTeamCredential,
        generated: false,
        started: true,
        applied: true,
      },
      {
        type: 'state',
        path: path.join(harness.profilesDir, 'active-profile'),
        beforeExists: true,
        beforeMode: 0o600,
        beforeProfile: 'personal',
        started: true,
        applied: true,
      },
    ],
    generatedCredentialPaths: [],
    generatedCredentialIdentities: [],
    credentialPathsBefore: [personalCredential, teamCredential],
    credentialIdentitiesBefore: [
      generatedIdentity(personalCredential),
      generatedIdentity(teamCredential),
    ],
  }), { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(personalCredential), true);
  assert.equal(fs.existsSync(stagedPersonalCredential), false);
  assert.equal(fs.existsSync(teamCredential), true);
  assert.equal(fs.existsSync(stagedTeamCredential), false);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(harness.transactionFile), false);
  assert.ok(report.repairs.some((repair) => repair.code === 'transaction-record-cleared'));
});

test('doctor --repair keeps a staged Reauthentication when the old Credential is gone', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const teamDir = path.join(harness.profilesDir, 'team');
  const stagedCredential = path.join(teamDir, 'codex-new.json');
  const newCredential = path.join(harness.activeDir, 'codex-new.json');
  const oldCredential = path.join(harness.activeDir, 'codex-old.json');
  fs.mkdirSync(teamDir, { recursive: true, mode: 0o700 });
  writeCredential(harness.activeDir, 'codex-new.json', 'team@example.com', {
    access_token: 'new-secret',
  });
  setActiveProfile(harness.profilesDir, 'team');
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'reauth',
    pid: 7777,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [{
      type: 'move',
      source: stagedCredential,
      destination: newCredential,
      generated: true,
      started: true,
      applied: true,
    }],
    generatedCredentialPaths: [stagedCredential],
    generatedCredentialIdentities: [generatedIdentity(stagedCredential, newCredential)],
    credentialPathsBefore: [oldCredential],
    preservedCredentialPath: oldCredential,
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });
  const credentialBefore = fs.readFileSync(newCredential, 'utf8');

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(fs.readFileSync(newCredential, 'utf8'), credentialBefore);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
  assert.doesNotMatch(JSON.stringify(report), /new-secret/);
});

test('doctor --repair reports malformed Reauthentication provenance as ambiguous JSON', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const oldCredential = path.join(harness.activeDir, 'codex-old.json');
  writeCredential(harness.activeDir, 'codex-old.json', 'team@example.com');
  setActiveProfile(harness.profilesDir, 'team');
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'reauth',
    pid: 7878,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [],
    generatedCredentialPaths: [],
    generatedCredentialIdentities: [],
    credentialPathsBefore: [null],
    preservedCredentialPath: oldCredential,
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.deepEqual(result.stderr, []);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
});

test('doctor --repair leaves an unrecorded active Reauthentication Credential unchanged', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const teamDir = path.join(harness.profilesDir, 'team');
  const oldCredential = path.join(harness.activeDir, 'codex-old.json');
  const newCredential = path.join(teamDir, 'codex-new.json');
  writeCredential(harness.activeDir, 'codex-old.json', 'team@example.com');
  writeCredential(teamDir, 'codex-new.json', 'team@example.com');
  setActiveProfile(harness.profilesDir, 'team');
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'reauth',
    pid: 7879,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [],
    generatedCredentialPaths: [],
    generatedCredentialIdentities: [],
    credentialPathsBefore: [oldCredential],
    credentialIdentitiesBefore: [generatedIdentity(oldCredential)],
    preservedCredentialPath: oldCredential,
    loginDirectory: teamDir,
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(fs.existsSync(oldCredential), true);
  assert.equal(fs.existsSync(newCredential), true);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
});

test('doctor --repair removes a staged Reauthentication and keeps the old Credential', (t) => {
  const harness = createHarness(t, { isProcessRunning: () => false });
  const personalDir = path.join(harness.profilesDir, 'personal');
  const stagedCredential = path.join(personalDir, 'codex-new.json');
  const newCredential = path.join(harness.activeDir, 'codex-new.json');
  const oldCredential = path.join(harness.activeDir, 'codex-old.json');
  fs.mkdirSync(personalDir, { recursive: true, mode: 0o700 });
  writeCredential(harness.activeDir, 'codex-old.json', 'personal@example.com', {
    access_token: 'old-secret',
  });
  writeCredential(harness.activeDir, 'codex-new.json', 'personal@example.com', {
    access_token: 'new-secret',
  });
  setActiveProfile(harness.profilesDir, 'personal');
  fs.writeFileSync(harness.transactionFile, JSON.stringify({
    schemaVersion: 1,
    operation: 'reauth',
    pid: 7979,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [
      {
        type: 'move',
        source: stagedCredential,
        destination: newCredential,
        generated: true,
        started: true,
        applied: true,
      },
      {
        type: 'delete-file',
        path: oldCredential,
        started: false,
        applied: false,
      },
    ],
    generatedCredentialPaths: [stagedCredential],
    generatedCredentialIdentities: [generatedIdentity(stagedCredential, newCredential)],
    credentialPathsBefore: [oldCredential],
    preservedCredentialPath: oldCredential,
  }), { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(newCredential), false);
  assert.equal(fs.existsSync(oldCredential), true);
  assert.equal(fs.existsSync(harness.transactionFile), false);
  assert.ok(report.repairs.some((repair) => repair.code === 'transaction-restored'));
  assert.doesNotMatch(JSON.stringify(report), /old-secret|new-secret/);
});

test('doctor --repair rejects a transaction that treats a storage root as a staged item', (t) => {
  const harness = createHarness(t);
  const unsafeSource = path.join(harness.profilesDir, 'team');
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(harness.profilesDir, { recursive: true, mode: 0o700 });
  const transaction = JSON.stringify({
    schemaVersion: 1,
    operation: 'use',
    pid: 7474,
    startedAt: '2026-08-13T00:00:00.000Z',
    status: 'recovery-required',
    steps: [{
      type: 'move',
      source: unsafeSource,
      destination: harness.activeDir,
      generated: false,
      started: true,
      applied: true,
    }],
    generatedCredentialPaths: [],
  });
  fs.writeFileSync(harness.transactionFile, transaction, { mode: 0o600 });

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(fs.existsSync(harness.activeDir), true);
  assert.equal(fs.existsSync(unsafeSource), false);
  assert.equal(fs.readFileSync(harness.transactionFile, 'utf8'), transaction);
  assert.ok(report.issues.some((issue) => issue.code === 'recovery-ambiguous'));
});

test('doctor --repair reports a symlinked Profile root without changing its target', (t) => {
  const harness = createHarness(t);
  const outside = path.join(harness.root, 'outside-profiles');
  const outsideCredential = path.join(outside, 'codex-outside.json');
  fs.mkdirSync(outside, { mode: 0o755 });
  fs.writeFileSync(outsideCredential, JSON.stringify({
    email: 'outside@example.com',
    access_token: 'outside-secret',
  }), { mode: 0o644 });
  fs.symlinkSync(outside, harness.profilesDir, 'dir');
  const credentialBefore = fs.readFileSync(outsideCredential, 'utf8');

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.deepEqual(report.repairs, []);
  assert.ok(report.issues.some((issue) => issue.code === 'unsafe-profile-storage'));
  assert.equal(permissionMode(outside), 0o755);
  assert.equal(permissionMode(outsideCredential), 0o644);
  assert.equal(fs.readFileSync(outsideCredential, 'utf8'), credentialBefore);
  assert.doesNotMatch(JSON.stringify(report), /outside-secret/);
});

test('doctor --repair leaves unexpected Profile storage unchanged', (t) => {
  const harness = createHarness(t);
  const teamDir = path.join(harness.profilesDir, 'team');
  const credential = path.join(teamDir, 'codex-team.json');
  const unexpected = path.join(teamDir, 'notes.txt');
  writeCredential(teamDir, 'codex-team.json', 'team@example.com');
  fs.writeFileSync(unexpected, 'manual note', { mode: 0o666 });
  fs.chmodSync(teamDir, 0o755);
  fs.chmodSync(credential, 0o644);
  fs.chmodSync(unexpected, 0o666);
  const unexpectedBefore = fs.readFileSync(unexpected, 'utf8');

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(permissionMode(teamDir), 0o755);
  assert.equal(permissionMode(credential), 0o644);
  assert.equal(permissionMode(unexpected), 0o666);
  assert.equal(fs.readFileSync(unexpected, 'utf8'), unexpectedBefore);
  assert.ok(report.issues.some((issue) => issue.code === 'unexpected-file'));
});

test('doctor --repair leaves an invalid Profile directory unchanged', (t) => {
  const harness = createHarness(t);
  const invalidDir = path.join(harness.profilesDir, 'doctor');
  const credential = path.join(invalidDir, 'codex-doctor.json');
  writeCredential(invalidDir, 'codex-doctor.json', 'invalid@example.com');
  fs.chmodSync(invalidDir, 0o755);
  fs.chmodSync(credential, 0o644);

  const result = harness.run(['doctor', '--repair', '--json']);
  const report = readJson(result);

  assert.equal(result.code, 3);
  assert.equal(permissionMode(invalidDir), 0o755);
  assert.equal(permissionMode(credential), 0o644);
  assert.ok(report.issues.some((issue) => issue.code === 'invalid-profile-name'));
});

test('read command arguments use stable invalid-input and unsafe-state exit codes', (t) => {
  const harness = createHarness(t);

  const invalidCommand = harness.run(['not-a-command']);
  const invalidJsonUse = harness.run(['use', 'personal', '--json']);
  const invalidJsonReauth = harness.run(['reauth', 'personal', '--json']);
  const invalidJsonDelete = harness.run(['delete', 'personal', '--json', '--yes']);
  const invalidDeactivateName = harness.run(['deactivate', 'personal']);
  const invalidAccountChangeList = harness.run(['list', '--allow-account-change']);
  const invalidAccountChangeUse = harness.run(['use', 'personal', '--allow-account-change']);
  const invalidYesUse = harness.run(['use', 'personal', '--yes']);
  const invalidRepairList = harness.run(['list', '--repair']);
  const invalidOnlineList = harness.run(['list', '--online']);
  const invalidOnlineRepair = harness.run(['doctor', '--online', '--repair']);
  const invalidOnlineHelp = harness.run(['help', '--online']);
  const help = harness.run(['help']);
  const unknownReauth = harness.run(['reauth', 'missing']);
  const unsafe = harness.run(['doctor', '--json', '--force']);

  assert.equal(invalidCommand.code, 2);
  assert.equal(invalidJsonUse.code, 2);
  assert.equal(invalidJsonReauth.code, 2);
  assert.equal(invalidJsonDelete.code, 2);
  assert.equal(invalidDeactivateName.code, 2);
  assert.equal(invalidAccountChangeList.code, 2);
  assert.equal(invalidAccountChangeUse.code, 2);
  assert.equal(invalidYesUse.code, 2);
  assert.equal(invalidRepairList.code, 2);
  assert.equal(invalidOnlineList.code, 2);
  assert.equal(invalidOnlineRepair.code, 2);
  assert.equal(invalidOnlineHelp.code, 2);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.some((line) => line.includes('doctor --online [--json]')));
  assert.ok(help.stdout.some((line) => line.includes('doctor --repair [--json] [--force]')));
  assert.ok(help.stdout.some((line) => line.includes('reauth NAME')));
  assert.ok(help.stdout.some((line) => line.includes('deactivate [--force]')));
  assert.ok(help.stdout.some((line) => line.includes('delete NAME [--yes] [--force]')));
  assert.equal(unknownReauth.code, 2);
  assert.match(unknownReauth.stderr[0], /unknown profile/i);
  assert.equal(unsafe.code, 2);
});

test('release help documents the Profile lifecycle contract', (t) => {
  const harness = createHarness(t);
  const result = harness.run(['help']);
  const help = result.stdout.join('\n');

  assert.equal(result.code, 0);
  assert.match(help, /--json:.*list, current, and doctor/);
  assert.match(help, /--online:.*doctor only.*read-only/);
  assert.match(help, /--repair:.*doctor only.*deterministic/);
  assert.match(help, /--force:.*bypass only the session warning/);
  assert.match(help, /--yes:.*delete only.*exact Profile-name confirmation/);
  assert.match(help, /--allow-account-change:.*reauth only.*Provider account email/);
  assert.match(help, /Profile names .*letters, numbers, dot, underscore, or hyphen/);
  assert.match(help, /Email addresses may repeat.*exact duplicate Credential data/);
  assert.match(help, /failed rollback.*doctor --repair/);
  assert.match(help, /Remote Provider accounts are never deleted/);
  assert.match(help, /schemaVersion: 1/);
  assert.match(help, /active, ready, needs-reauth, invalid, unregistered, unknown/);
  assert.match(help, /0 success, 1 operation or service failure, 2 invalid input, 3 unsafe or incomplete state/);
  assert.match(packageMetadata.version, /^\d+\.\d+\.\d+$/);
});

test('the package command entry point is executable', () => {
  const commandFile = path.join(__dirname, '..', 'bin', 'claudex-switch.js');
  assert.notEqual(fs.statSync(commandFile).mode & 0o111, 0);
});

test('use switches the active Credential and preserves the old Profile', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'Work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'work']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ['Active Profile: Work']);
  assert.equal(readActiveProfile(harness.profilesDir), 'Work');
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-work.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), ['codex-personal.json']);
  assert.deepEqual(harness.events, ['proxy:before', 'proxy:after']);
});

test('use refuses duplicate storage for the already active Profile', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'personal'), 'codex-duplicate.json', 'personal@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'personal', '--force']);

  assert.equal(result.code, 3);
  assert.match(result.stderr[0], /exactly one Codex Credential|duplicate Credential storage/i);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
});

test('add logs in and makes the new Profile active', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['add', 'team']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, [
    'Starting Codex login for Profile: team',
    'Active Profile: team',
  ]);
  assert.equal(readActiveProfile(harness.profilesDir), 'team');
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-login-1.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), ['codex-personal.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'team')), []);
});

test('add makes a generated public Credential private before validation', (t) => {
  const harness = createHarness(t, {
    login(directory) {
      writeCredential(directory, 'codex-login-public.json', 'team@example.com');
      fs.chmodSync(path.join(directory, 'codex-login-public.json'), 0o644);
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['add', 'team', '--force']);

  assert.equal(result.code, 0);
  assert.equal(readActiveProfile(harness.profilesDir), 'team');
  assert.equal(permissionMode(path.join(harness.activeDir, 'codex-login-public.json')), 0o600);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('add detects a generated Credential that reuses the old active path', (t) => {
  let harness;
  harness = createHarness(t, {
    login() {
      writeCredential(harness.activeDir, 'codex-personal.json', 'team@example.com');
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['add', 'team']);

  assert.equal(result.code, 0);
  assert.equal(readActiveProfile(harness.profilesDir), 'team');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(harness.activeDir, 'codex-personal.json'), 'utf8')).email,
    'team@example.com',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(harness.profilesDir, 'personal', 'codex-personal.json'), 'utf8')).email,
    'personal@example.com',
  );
});

test('deactivate keeps the active Profile as a ready deactivated Profile', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['deactivate']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ['Deactivated Profile: personal']);
  assert.deepEqual(result.stderr, []);
  assert.deepEqual(credentialNames(harness.activeDir), []);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), ['codex-personal.json']);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'active-profile')), false);
  assert.deepEqual(harness.events, ['proxy:before', 'proxy:after']);

  const list = harness.run(['list']);
  assert.equal(list.code, 0);
  assert.deepEqual(list.stdout, ['  personal (personal@example.com, ready)']);

  const current = harness.run(['current']);
  assert.equal(current.code, 3);
  assert.deepEqual(current.stdout, []);
  assert.match(current.stderr[0], /no active profile/i);
});

test('deactivate preserves a stopped proxy service after success', (t) => {
  const runningEvents = [];
  let running = true;
  const runningHarness = createHarness(t, {
    proxyService: {
      isRunning: () => running,
      stop() {
        runningEvents.push('stop');
        running = false;
      },
      start() {
        runningEvents.push('start');
        running = true;
      },
    },
  });
  writeCredential(runningHarness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(runningHarness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(runningHarness.profilesDir, 'personal');

  const runningResult = runningHarness.run(['deactivate']);

  assert.equal(runningResult.code, 0);
  assert.deepEqual(runningEvents, ['stop', 'start']);
  assert.equal(running, true);

  const stoppedEvents = [];
  const stoppedHarness = createHarness(t, {
    proxyService: {
      isRunning: () => false,
      stop: () => stoppedEvents.push('stop'),
      start: () => stoppedEvents.push('start'),
    },
  });
  writeCredential(stoppedHarness.activeDir, 'codex-team.json', 'team@example.com');
  fs.mkdirSync(path.join(stoppedHarness.profilesDir, 'team'), { recursive: true, mode: 0o700 });
  setActiveProfile(stoppedHarness.profilesDir, 'team');

  const stoppedResult = stoppedHarness.run(['deactivate']);

  assert.equal(stoppedResult.code, 0);
  assert.deepEqual(stoppedEvents, []);
});

test('deactivate uses the session warning and --force bypasses only that warning', (t) => {
  let sessionRunning = true;
  const harness = createHarness(t, { isSessionRunning: () => sessionRunning });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const warned = harness.run(['deactivate']);
  const forced = harness.run(['deactivate', '--force']);

  assert.equal(warned.code, 1);
  assert.match(warned.stderr[0], /claudex or proxy session is running/i);
  assert.equal(forced.code, 0);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'active-profile')), false);
  sessionRunning = false;
});

test('deactivate reports an already empty active selection without changing Profiles', (t) => {
  const serviceEvents = [];
  const harness = createHarness(t, {
    proxyService: {
      isRunning: () => true,
      stop: () => serviceEvents.push('stop'),
      start: () => serviceEvents.push('start'),
    },
  });
  writeCredential(path.join(harness.profilesDir, 'personal'), 'codex-personal.json', 'personal@example.com');

  const result = harness.run(['deactivate']);

  assert.equal(result.code, 3);
  assert.match(result.stderr[0], /no active profile/i);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), ['codex-personal.json']);
  assert.deepEqual(serviceEvents, []);
});

test('deactivate rolls back when moving the active Credential fails', (t) => {
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'renameSync') return target[property];
      return () => {
        throw new Error('simulated deactivation move failure');
      };
    },
  });
  const harness = createHarness(t, { filesystem });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['deactivate']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated deactivation move failure/);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), []);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('deactivate restores the active Profile when removing its selection fails', (t) => {
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'unlinkSync') return target[property];
      return (file) => {
        if (path.basename(file) === 'active-profile') {
          throw new Error('simulated active selection removal failure');
        }
        return target.unlinkSync(file);
      };
    },
  });
  const harness = createHarness(t, { filesystem });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['deactivate']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated active selection removal failure/);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), []);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('deactivate reports a proxy restart failure after committing the empty active state', (t) => {
  const serviceEvents = [];
  const harness = createHarness(t, {
    proxyService: {
      isRunning: () => true,
      stop() {
        serviceEvents.push('stop');
      },
      start() {
        serviceEvents.push('start');
        throw new Error('simulated deactivation proxy restart failure');
      },
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['deactivate']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated deactivation proxy restart failure/);
  assert.deepEqual(serviceEvents, ['stop', 'start']);
  assert.deepEqual(credentialNames(harness.activeDir), []);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), ['codex-personal.json']);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'active-profile')), false);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('delete removes an inactive Profile after exact-name confirmation', (t) => {
  const confirmations = [];
  const harness = createHarness(t, {
    confirmProfileDeletion(name) {
      confirmations.push(name);
      return 'team';
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['delete', 'team']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ['Deleted Profile: team']);
  assert.deepEqual(result.stderr, []);
  assert.deepEqual(confirmations, ['team']);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'team')), false);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.deepEqual(harness.events, ['proxy:before', 'proxy:after']);
  assert.deepEqual(fs.readdirSync(harness.profilesDir).sort(), ['active-profile', 'personal']);
});

test('delete requires confirmation to match the stored Profile name exactly', (t) => {
  const serviceEvents = [];
  const harness = createHarness(t, {
    confirmProfileDeletion: () => 'team',
    proxyService: {
      isRunning: () => true,
      stop: () => serviceEvents.push('stop'),
      start: () => serviceEvents.push('start'),
    },
  });
  writeCredential(path.join(harness.profilesDir, 'Team'), 'codex-team.json', 'team@example.com');

  const result = harness.run(['delete', 'team', '--force']);

  assert.equal(result.code, 2);
  assert.match(result.stderr[0], /exactly match Profile 'Team'/);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'Team')), ['codex-team.json']);
  assert.deepEqual(serviceEvents, []);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('delete uses the session warning before confirmation', (t) => {
  let sessionRunning = true;
  const confirmations = [];
  const harness = createHarness(t, {
    isSessionRunning: () => sessionRunning,
    confirmProfileDeletion(name) {
      confirmations.push(name);
      return name;
    },
  });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');

  const warned = harness.run(['delete', 'team']);
  const forced = harness.run(['delete', 'team', '--force']);

  assert.equal(warned.code, 1);
  assert.match(warned.stderr[0], /claudex or proxy session is running/i);
  assert.deepEqual(confirmations, ['team']);
  assert.equal(forced.code, 0);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'team')), false);
  sessionRunning = false;
});

test('delete --yes removes the last Profile without interactive confirmation', (t) => {
  const harness = createHarness(t);
  writeCredential(path.join(harness.profilesDir, 'personal'), 'codex-personal.json', 'personal@example.com');

  const result = harness.run(['delete', 'personal', '--yes']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ['Deleted Profile: personal']);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'personal')), false);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'active-profile')), false);
  assert.deepEqual(credentialNames(harness.activeDir), []);
});

test('delete refuses the active Profile and instructs the user to deactivate it', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['delete', 'personal', '--yes']);

  assert.equal(result.code, 2);
  assert.match(result.stderr[0], /active.*deactivate/i);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'personal')), true);
});

test('delete reports recovery when directory removal fails after permanent Credential deletion', (t) => {
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'rmdirSync') return target[property];
      return (directory) => {
        if (path.basename(directory) === 'team') {
          throw new Error('simulated Profile directory removal failure');
        }
        return target.rmdirSync(directory);
      };
    },
  });
  const harness = createHarness(t, {
    filesystem,
    confirmProfileDeletion: () => 'team',
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const failed = harness.run(['delete', 'team']);
  const blocked = harness.run(['delete', 'team', '--yes', '--force']);

  assert.equal(failed.code, 3);
  assert.match(failed.stderr[0], /rollback failed|recovery/i);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'team')), true);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'team')), []);
  assert.equal(fs.existsSync(harness.transactionFile), true);
  assert.equal(blocked.code, 3);
  assert.match(blocked.stderr[0], /recovery/i);
});

test('delete refuses symlinked and unexpected Profile storage without changing it', (t) => {
  const symlinkHarness = createHarness(t);
  const outside = path.join(symlinkHarness.root, 'outside');
  writeCredential(outside, 'codex-team.json', 'team@example.com');
  fs.mkdirSync(symlinkHarness.profilesDir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(outside, path.join(symlinkHarness.profilesDir, 'team'), 'dir');

  const symlinked = symlinkHarness.run(['delete', 'team', '--yes', '--force']);

  assert.equal(symlinked.code, 3);
  assert.match(symlinked.stderr[0], /symlink|unsafe/i);
  assert.equal(fs.lstatSync(path.join(symlinkHarness.profilesDir, 'team')).isSymbolicLink(), true);
  assert.deepEqual(credentialNames(outside), ['codex-team.json']);

  const unexpectedHarness = createHarness(t);
  const targetDir = path.join(unexpectedHarness.profilesDir, 'team');
  writeCredential(targetDir, 'codex-team.json', 'team@example.com');
  fs.writeFileSync(path.join(targetDir, 'unexpected.txt'), 'keep me\n', { mode: 0o600 });

  const unexpected = unexpectedHarness.run(['delete', 'team', '--yes', '--force']);

  assert.equal(unexpected.code, 3);
  assert.match(unexpected.stderr[0], /unexpected file|unsafe/i);
  assert.deepEqual(credentialNames(targetDir), ['codex-team.json', 'unexpected.txt']);
});

test('delete leaves the Profile unchanged when Credential removal fails', (t) => {
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'unlinkSync') return target[property];
      return (file) => {
        if (path.basename(file) === 'codex-team.json') {
          throw new Error('simulated Credential removal failure');
        }
        return target.unlinkSync(file);
      };
    },
  });
  const harness = createHarness(t, { filesystem });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');

  const result = harness.run(['delete', 'team', '--yes']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated Credential removal failure/);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'team')), ['codex-team.json']);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('delete preserves a stopped proxy service after success', (t) => {
  let running = true;
  const runningEvents = [];
  const runningHarness = createHarness(t, {
    proxyService: {
      isRunning: () => running,
      stop() {
        runningEvents.push('stop');
        running = false;
      },
      start() {
        runningEvents.push('start');
        running = true;
      },
    },
  });
  writeCredential(path.join(runningHarness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');

  const runningResult = runningHarness.run(['delete', 'team', '--yes']);

  assert.equal(runningResult.code, 0);
  assert.deepEqual(runningEvents, ['stop', 'start']);
  assert.equal(running, true);

  const stoppedEvents = [];
  const stoppedHarness = createHarness(t, {
    proxyService: {
      isRunning: () => false,
      stop: () => stoppedEvents.push('stop'),
      start: () => stoppedEvents.push('start'),
    },
  });
  writeCredential(path.join(stoppedHarness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');

  const stoppedResult = stoppedHarness.run(['delete', 'team', '--yes']);

  assert.equal(stoppedResult.code, 0);
  assert.deepEqual(stoppedEvents, []);
});

test('delete reports proxy restart failure after permanent local deletion', (t) => {
  const harness = createHarness(t, {
    proxyService: {
      isRunning: () => true,
      stop() {},
      start() {
        throw new Error('simulated deletion proxy restart failure');
      },
    },
  });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');

  const result = harness.run(['delete', 'team', '--yes']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated deletion proxy restart failure/);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'team')), false);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('reauth replaces the active Profile Credential after validation', (t) => {
  const harness = createHarness(t, {
    login(loginDirectory) {
      writeCredential(loginDirectory, 'codex-reauthenticated.json', 'personal@example.com', {
        access_token: 'new-secret',
      });
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com', {
    access_token: 'old-secret',
  });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'personal']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, [
    'Starting Codex login for Profile: personal',
    'Reauthenticated Profile: personal',
  ]);
  assert.deepEqual(result.stderr, []);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-reauthenticated.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), []);
  assert.deepEqual(harness.events, ['proxy:before', 'proxy:after']);
});

test('reauth replaces an inactive Profile Credential without selecting it', (t) => {
  const harness = createHarness(t, {
    login() {
      writeCredential(harness.activeDir, 'codex-team-reauthenticated.json', 'team@example.com', {
        access_token: 'new-secret',
      });
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com', {
    access_token: 'personal-secret',
  });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com', {
    access_token: 'old-secret',
  });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'team']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, [
    'Starting Codex login for Profile: team',
    'Reauthenticated Profile: team',
  ]);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), []);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'team')), ['codex-team-reauthenticated.json']);
  assert.deepEqual(harness.events, ['proxy:before', 'proxy:after']);
});

test('reauth replaces a deactivated Profile Credential without creating an active Profile', (t) => {
  const harness = createHarness(t, {
    login() {
      writeCredential(harness.activeDir, 'codex-team-new.json', 'team@example.com');
    },
  });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com', {
    access_token: 'old-secret',
  });

  const result = harness.run(['reauth', 'team']);

  assert.equal(result.code, 0);
  assert.deepEqual(credentialNames(harness.activeDir), []);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'team')), ['codex-team-new.json']);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'active-profile')), false);
});

test('reauth keeps the old Credential until validation', (t) => {
  let oldCredentialWasKept = false;
  const harness = createHarness(t, {
    login() {
      const storedFiles = fs.readdirSync(harness.activeDir)
        .filter((name) => name.startsWith('codex-') && name.endsWith('.json'));
      oldCredentialWasKept = storedFiles.length === 1
        && JSON.parse(fs.readFileSync(path.join(harness.activeDir, storedFiles[0]), 'utf8')).email
          === 'personal@example.com';
      writeCredential(harness.activeDir, 'codex-new.json', 'personal@example.com');
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'personal']);

  assert.equal(result.code, 0);
  assert.equal(oldCredentialWasKept, true);
});

test('reauth keeps the old Credential when login fails', (t) => {
  const harness = createHarness(t, {
    login() {
      throw new Error('simulated login failure');
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com', {
    access_token: 'old-secret',
  });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'personal']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated login failure/);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(harness.activeDir, 'codex-personal.json'), 'utf8')).access_token,
    'old-secret',
  );
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), []);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('reauth keeps the old Credential when the new Credential is malformed', (t) => {
  const harness = createHarness(t, {
    login() {
      fs.mkdirSync(harness.activeDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(harness.activeDir, 'codex-malformed.json'),
        '{"email":"broken@example.com"',
        { mode: 0o600 },
      );
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com', {
    access_token: 'old-secret',
  });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'personal']);

  assert.equal(result.code, 3);
  assert.match(result.stderr[0], /malformed/);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), []);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('reauth keeps the old Credential when login creates multiple Credentials', (t) => {
  const harness = createHarness(t, {
    login() {
      writeCredential(harness.activeDir, 'codex-one.json', 'one@example.com');
      writeCredential(harness.activeDir, 'codex-two.json', 'two@example.com');
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com', {
    access_token: 'old-secret',
  });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'personal']);

  assert.equal(result.code, 3);
  assert.match(result.stderr[0], /exactly one|more than one/i);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), []);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('reauth rejects an existing Profile with duplicate Credential data', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'same@example.com', {
    access_token: 'same-secret',
  });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'same@example.com', {
    access_token: 'same-secret',
  });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'personal']);

  assert.equal(result.code, 3);
  assert.match(result.stderr[0], /duplicated/i);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('reauth rejects new Credential data duplicated in another Profile', (t) => {
  const harness = createHarness(t, {
    login() {
      writeCredential(harness.activeDir, 'codex-new.json', 'team@example.com', {
        access_token: 'same-secret',
      });
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com', {
    access_token: 'old-secret',
  });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com', {
    access_token: 'same-secret',
  });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'personal']);

  assert.equal(result.code, 3);
  assert.match(result.stderr[0], /duplicated/i);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'team')), ['codex-team.json']);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('reauth rejects a changed Provider account email without opt-in', (t) => {
  const harness = createHarness(t, {
    login() {
      writeCredential(harness.activeDir, 'codex-new.json', 'new@example.com', {
        access_token: 'new-secret',
      });
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'old@example.com', {
    access_token: 'old-secret',
  });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'personal']);

  assert.equal(result.code, 2);
  assert.match(result.stderr[0], /email changed|allow-account-change/i);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), []);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('reauth allows a changed Provider account email with explicit opt-in', (t) => {
  const harness = createHarness(t, {
    login() {
      writeCredential(harness.activeDir, 'codex-new.json', 'new@example.com', {
        access_token: 'new-secret',
      });
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'old@example.com', {
    access_token: 'old-secret',
  });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'personal', '--allow-account-change']);

  assert.equal(result.code, 0);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-new.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), []);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('reauth allows the same Provider account email in separate Profiles', (t) => {
  const harness = createHarness(t, {
    login() {
      writeCredential(harness.activeDir, 'codex-team-new.json', 'same@example.com', {
        access_token: 'team-new-secret',
      });
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'same@example.com', {
    access_token: 'personal-secret',
  });
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'same@example.com', {
    access_token: 'team-old-secret',
  });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'team']);
  const list = harness.run(['list']);

  assert.equal(result.code, 0);
  assert.equal(list.code, 0);
  assert.deepEqual(list.stdout, [
    '* personal (same@example.com, active)',
    '  team (same@example.com, ready)',
  ]);
});

test('reauth uses the session warning and --force bypasses only that warning', (t) => {
  let sessionRunning = true;
  const harness = createHarness(t, {
    isSessionRunning: () => sessionRunning,
    login() {
      writeCredential(harness.activeDir, 'codex-new.json', 'personal@example.com');
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const warned = harness.run(['reauth', 'personal']);
  const forced = harness.run(['reauth', 'personal', '--force']);

  assert.equal(warned.code, 1);
  assert.match(warned.stderr[0], /claudex or proxy session is running/i);
  assert.equal(forced.code, 0);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-new.json']);
  assert.deepEqual(harness.events, ['proxy:before', 'proxy:after']);
  sessionRunning = false;
});

test('reauth preserves a running proxy service state', (t) => {
  const serviceEvents = [];
  const harness = createHarness(t, {
    proxyService: {
      isRunning: () => true,
      stop() {
        serviceEvents.push('stop');
      },
      start() {
        serviceEvents.push('start');
      },
    },
    login() {
      writeCredential(harness.activeDir, 'codex-new.json', 'personal@example.com');
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'personal', '--force']);

  assert.equal(result.code, 0);
  assert.deepEqual(serviceEvents, ['stop', 'start']);
});

test('reauth starts a stopped proxy service only for the active Profile', (t) => {
  const activeEvents = [];
  const activeHarness = createHarness(t, {
    proxyService: {
      isRunning: () => false,
      stop: () => activeEvents.push('stop'),
      start: () => activeEvents.push('start'),
    },
    login() {
      writeCredential(path.join(activeHarness.profilesDir, 'personal'), 'codex-new.json', 'personal@example.com');
    },
  });
  writeCredential(activeHarness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(activeHarness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(activeHarness.profilesDir, 'personal');

  const activeResult = activeHarness.run(['reauth', 'personal', '--force']);

  assert.equal(activeResult.code, 0);
  assert.deepEqual(activeEvents, ['start']);

  const inactiveEvents = [];
  const inactiveHarness = createHarness(t, {
    proxyService: {
      isRunning: () => false,
      stop: () => inactiveEvents.push('stop'),
      start: () => inactiveEvents.push('start'),
    },
    login() {
      writeCredential(inactiveHarness.activeDir, 'codex-new.json', 'team@example.com');
    },
  });
  writeCredential(inactiveHarness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(inactiveHarness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(inactiveHarness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');
  setActiveProfile(inactiveHarness.profilesDir, 'personal');

  const inactiveResult = inactiveHarness.run(['reauth', 'team', '--force']);

  assert.equal(inactiveResult.code, 0);
  assert.deepEqual(inactiveEvents, []);
});

test('reauth rolls back a failed inactive Profile replacement', (t) => {
  let renameCount = 0;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'renameSync') return target[property];
      return (source, destination) => {
        renameCount += 1;
        if (renameCount === 2) throw new Error('simulated reauth move failure');
        return target.renameSync(source, destination);
      };
    },
  });
  const harness = createHarness(t, {
    filesystem,
    login() {
      writeCredential(harness.activeDir, 'codex-new.json', 'team@example.com');
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['reauth', 'team']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated reauth move failure/);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), []);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'team')), ['codex-team.json']);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('reauth reports recovery when rollback also fails', (t) => {
  let renameCount = 0;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'renameSync') return target[property];
      return (source, destination) => {
        renameCount += 1;
        if (renameCount === 2 || renameCount === 3) throw new Error('simulated reauth rollback failure');
        return target.renameSync(source, destination);
      };
    },
  });
  const harness = createHarness(t, {
    filesystem,
    login() {
      writeCredential(harness.activeDir, 'codex-new.json', 'team@example.com');
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'team@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const failed = harness.run(['reauth', 'team']);
  const blocked = harness.run(['reauth', 'team', '--force']);

  assert.equal(failed.code, 3);
  assert.match(failed.stderr[0], /rollback failed|recovery/i);
  assert.equal(fs.existsSync(harness.transactionFile), true);
  assert.equal(blocked.code, 3);
  assert.match(blocked.stderr[0], /recovery/i);
});

test('rename keeps the Credential and updates the active Profile name', (t) => {
  const harness = createHarness(t);
  writeCredential(path.join(harness.profilesDir, 'Work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'Work');

  const result = harness.run(['rename', 'work', 'personal']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ['Renamed Profile work to personal']);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), ['codex-work.json']);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'Work')), false);
});

test('rename rejects an ambiguous Profile without one Credential', (t) => {
  const harness = createHarness(t);
  fs.mkdirSync(path.join(harness.profilesDir, 'empty'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['rename', 'empty', 'new-name', '--force']);

  assert.equal(result.code, 3);
  assert.match(result.stderr[0], /exactly one Codex Credential/i);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'empty')), true);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'new-name')), false);
});

test('Profile names reject reserved names and case-insensitive collisions', (t) => {
  const harness = createHarness(t);
  writeCredential(path.join(harness.profilesDir, 'Work'), 'codex-work.json', 'work@example.com');
  writeCredential(path.join(harness.profilesDir, 'Team'), 'codex-team.json', 'team@example.com');

  const collision = harness.run(['add', 'work']);
  const reserved = harness.run(['add', 'list']);
  const invalid = harness.run(['add', 'not valid']);
  const useReserved = harness.run(['use', 'list']);
  const renameCollision = harness.run(['rename', 'work', 'team']);
  const renameInvalid = harness.run(['rename', 'work', 'not valid']);

  assert.equal(collision.code, 2);
  assert.match(collision.stderr[0], /already exists/i);
  assert.equal(reserved.code, 2);
  assert.match(reserved.stderr[0], /reserved/i);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr[0], /letters, numbers/i);
  assert.equal(useReserved.code, 2);
  assert.match(useReserved.stderr[0], /reserved/i);
  assert.equal(renameCollision.code, 2);
  assert.match(renameCollision.stderr[0], /already exists/i);
  assert.equal(renameInvalid.code, 2);
  assert.match(renameInvalid.stderr[0], /letters, numbers/i);
});

test('current fails when no active Profile is recorded', (t) => {
  const harness = createHarness(t);

  const result = harness.run(['current']);

  assert.equal(result.code, 3);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr[0], /no active profile/i);
});

test('Profile mutation writes private recovery metadata without Credential values', (t) => {
  const transactionSnapshots = [];
  const transactionModes = [];
  const harness = createHarness(t, {
    withProxyStopped(work) {
      transactionSnapshots.push(fs.readFileSync(harness.transactionFile, 'utf8'));
      transactionModes.push(fs.statSync(harness.transactionFile).mode & 0o777);
      return work();
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'work']);

  assert.equal(result.code, 0);
  assert.equal(transactionSnapshots.length, 1);
  assert.deepEqual(transactionModes, [0o600]);
  assert.match(transactionSnapshots[0], /"operation"\s*:\s*"use"/);
  assert.doesNotMatch(transactionSnapshots[0], /personal@example\.com|work@example\.com/);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('lock and recovery behavior use injectable runtime adapters', (t) => {
  let transaction = null;
  const events = [];
  const harness = createHarness(t, {
    operationLock: {
      acquire(command) {
        events.push(`acquire:${command}`);
        return () => events.push('release');
      },
    },
    recoveryStore: {
      read: () => transaction,
      write: (next) => {
        transaction = next;
      },
      remove: () => {
        transaction = null;
      },
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'work', '--force']);

  assert.equal(result.code, 0);
  assert.deepEqual(events, ['acquire:use', 'release']);
  assert.equal(transaction, null);
  assert.equal(fs.existsSync(harness.lockFile), false);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('concurrent Profile mutation fails with a lock error', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  setActiveProfile(harness.profilesDir, 'personal');
  fs.writeFileSync(harness.lockFile, '{"pid":1234}\n', { mode: 0o600 });

  const result = harness.run(['use', 'work', '--force']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /another profile mutation is in progress/i);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
});

test('a concurrent mutation started during an active operation fails atomically', (t) => {
  let secondResult;
  const secondErrors = [];
  const harness = createHarness(t, {
    withProxyStopped(work) {
      const second = createProfileLifecycle({
        activeDir: harness.activeDir,
        profilesDir: harness.profilesDir,
      });
      secondResult = second.run(['use', 'work', '--force'], {
        stdout: () => {},
        stderr: (line) => secondErrors.push(line),
      });
      return work();
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const firstResult = harness.run(['use', 'work', '--force']);

  assert.equal(firstResult.code, 0);
  assert.equal(secondResult, 1);
  assert.match(secondErrors[0], /another profile mutation is in progress/i);
});

test('file operation failure rolls back the previous Profile state', (t) => {
  let renameCount = 0;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'renameSync') return target[property];
      return (source, destination) => {
        renameCount += 1;
        if (renameCount === 2) throw new Error('simulated file operation failure');
        return target.renameSync(source, destination);
      };
    },
  });
  const harness = createHarness(t, { filesystem });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'work']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated file operation failure/);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'personal')), false);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'work')), ['codex-work.json']);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('add failure removes the new Credential and restores the current Profile', (t) => {
  let renameCount = 0;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'renameSync') return target[property];
      return (source, destination) => {
        renameCount += 1;
        if (renameCount === 3) throw new Error('simulated new Credential move failure');
        return target.renameSync(source, destination);
      };
    },
  });
  const harness = createHarness(t, { filesystem });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['add', 'team']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated new Credential move failure/);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'personal')), false);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'team')), false);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('add ignores non-Credential login directories during rollback', (t) => {
  const harness = createHarness(t, {
    login(directory) {
      writeCredential(directory, 'codex-login-1.json', 'login-1@example.com');
      const logsDirectory = path.join(directory, 'logs');
      fs.mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(logsDirectory, 'session.log'), 'login log\n', { mode: 0o600 });
      throw new Error('simulated login failure');
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['add', 'team', '--force']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated login failure/);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json', 'logs']);
  assert.equal(fs.existsSync(path.join(harness.activeDir, 'logs', 'session.log')), true);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'team')), false);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('cancelled login rolls back and releases the Profile operation lock', (t) => {
  let cancelLogin = true;
  let signalSource;
  const harness = createHarness(t, {
    login(directory) {
      if (cancelLogin) {
        cancelLogin = false;
        signalSource.emit('SIGINT');
        throw new Error('simulated login cancellation');
      }
      writeCredential(directory, 'codex-login.json', 'team@example.com');
    },
  });
  signalSource = harness.signalSource;
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const cancelled = harness.run(['add', 'team', '--force']);

  assert.equal(cancelled.code, 130);
  assert.match(cancelled.stderr[0], /Profile mutation cancelled/i);
  assert.equal(fs.existsSync(harness.lockFile), false);
  assert.equal(fs.existsSync(harness.transactionFile), false);
  assert.equal(fs.existsSync(path.join(harness.profilesDir, 'team')), false);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');

  const retried = harness.run(['add', 'team', '--force']);

  assert.equal(retried.code, 0);
  assert.equal(fs.existsSync(harness.lockFile), false);
  assert.equal(fs.existsSync(harness.transactionFile), false);
  assert.equal(readActiveProfile(harness.profilesDir), 'team');
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-login.json']);
});

test('add rollback removes a generated Credential symlink', (t) => {
  const outside = path.join(os.tmpdir(), `claudex-switch-generated-${process.pid}.json`);
  fs.writeFileSync(outside, JSON.stringify({ email: 'outside@example.com' }), { mode: 0o600 });
  t.after(() => fs.rmSync(outside, { force: true }));
  const harness = createHarness(t, {
    login() {
      fs.symlinkSync(outside, path.join(harness.activeDir, 'codex-generated.json'));
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['add', 'team', '--force']);

  assert.equal(result.code, 3);
  assert.match(result.stderr[0], /symlink|unsafe/i);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.equal(fs.existsSync(path.join(harness.activeDir, 'codex-generated.json')), false);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('rollback failure leaves recovery state and blocks later mutations', (t) => {
  let renameCount = 0;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'renameSync') return target[property];
      return (source, destination) => {
        renameCount += 1;
        if (renameCount === 2 || renameCount === 3) {
          throw new Error('simulated rollback failure');
        }
        return target.renameSync(source, destination);
      };
    },
  });
  const harness = createHarness(t, { filesystem });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const failed = harness.run(['use', 'work']);
  const blocked = harness.run(['use', 'work', '--force']);

  assert.equal(failed.code, 3);
  assert.match(failed.stderr[0], /rollback failed|recovery/i);
  assert.equal(fs.existsSync(harness.transactionFile), true);
  assert.equal(blocked.code, 3);
  assert.match(blocked.stderr[0], /recovery/i);
});

test('state-changing commands warn about running sessions and --force bypasses only the warning', (t) => {
  let sessionRunning = true;
  const harness = createHarness(t, { isSessionRunning: () => sessionRunning });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const warned = harness.run(['use', 'work']);
  const forced = harness.run(['use', 'work', '--force']);

  assert.equal(warned.code, 1);
  assert.match(warned.stderr[0], /claudex or proxy session is running/i);
  assert.deepEqual(harness.events, ['proxy:before', 'proxy:after']);
  assert.equal(forced.code, 0);
  assert.equal(readActiveProfile(harness.profilesDir), 'work');
  sessionRunning = false;
});

test('mutation stops when the session check fails', (t) => {
  const harness = createHarness(t, {
    isSessionRunning: () => {
      throw new Error('simulated session check failure');
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'work']);
  const forcedResult = harness.run(['use', 'work', '--force']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated session check failure/);
  assert.equal(forcedResult.code, 1);
  assert.match(forcedResult.stderr[0], /simulated session check failure/);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(harness.lockFile), false);
});

test('--force cannot bypass validation or unsafe Profile storage', (t) => {
  const harness = createHarness(t);
  const invalid = harness.run(['add', 'not valid', '--force']);
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr[0], /letters, numbers/i);
  assert.equal(fs.existsSync(harness.lockFile), false);

  const outside = path.join(harness.root, 'outside');
  writeCredential(outside, 'codex-work.json', 'work@example.com');
  fs.symlinkSync(outside, path.join(harness.profilesDir, 'work'), 'dir');
  setActiveProfile(harness.profilesDir, 'personal');

  const unsafe = harness.run(['use', 'work', '--force']);

  assert.equal(unsafe.code, 3);
  assert.match(unsafe.stderr[0], /unsafe/i);
  assert.equal(fs.existsSync(harness.lockFile), false);
});

test('mutation safety rejects hidden entries and public Credential files', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  fs.mkdirSync(path.join(harness.profilesDir, '.unexpected'), { mode: 0o700 });
  const hiddenEntry = harness.run(['use', 'work', '--force']);
  fs.rmdirSync(path.join(harness.profilesDir, '.unexpected'));

  assert.equal(hiddenEntry.code, 3);
  assert.match(hiddenEntry.stderr[0], /unexpected entry/i);

  fs.chmodSync(path.join(harness.activeDir, 'codex-personal.json'), 0o644);
  const publicCredential = harness.run(['use', 'work', '--force']);

  assert.equal(publicCredential.code, 3);
  assert.match(publicCredential.stderr[0], /private/i);
});

test('use starts the proxy service when it was stopped', (t) => {
  let running = true;
  const serviceEvents = [];
  const harness = createHarness(t, {
    proxyService: {
      isRunning: () => running,
      stop() {
        serviceEvents.push('stop');
        running = false;
      },
      start() {
        serviceEvents.push('start');
        running = true;
      },
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const runningResult = harness.run(['use', 'work', '--force']);
  running = false;
  const stoppedResult = harness.run(['use', 'personal', '--force']);

  assert.equal(runningResult.code, 0);
  assert.equal(stoppedResult.code, 0);
  assert.deepEqual(serviceEvents, ['stop', 'start', 'start']);
});

test('using the active Profile starts a stopped proxy service without moving Credentials', (t) => {
  const serviceEvents = [];
  const harness = createHarness(t, {
    proxyService: {
      isRunning: () => false,
      stop: () => serviceEvents.push('stop'),
      start: () => serviceEvents.push('start'),
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(path.join(harness.profilesDir, 'personal'), { recursive: true, mode: 0o700 });
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'personal', '--force']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ['Already active: personal']);
  assert.deepEqual(serviceEvents, ['start']);
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-personal.json']);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('proxy stop failure attempts to restore a previously running service', (t) => {
  const serviceEvents = [];
  const harness = createHarness(t, {
    proxyService: {
      isRunning: () => true,
      stop() {
        serviceEvents.push('stop');
        throw new Error('simulated proxy stop failure');
      },
      start() {
        serviceEvents.push('start');
      },
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'work', '--force']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated proxy stop failure/);
  assert.deepEqual(serviceEvents, ['stop', 'start']);
  assert.equal(readActiveProfile(harness.profilesDir), 'personal');
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('proxy restart failure keeps the committed Profile selection', (t) => {
  const harness = createHarness(t, {
    proxyService: {
      isRunning: () => true,
      stop() {},
      start() {
        throw new Error('simulated proxy restart failure');
      },
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'work', '--force']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated proxy restart failure/);
  assert.equal(readActiveProfile(harness.profilesDir), 'work');
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-work.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), ['codex-personal.json']);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('proxy start failure after a stopped service keeps the committed Profile selection', (t) => {
  const harness = createHarness(t, {
    proxyService: {
      isRunning: () => false,
      stop() {
        throw new Error('should not stop a stopped proxy');
      },
      start() {
        throw new Error('simulated proxy start failure');
      },
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'work', '--force']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /simulated proxy start failure/);
  assert.equal(readActiveProfile(harness.profilesDir), 'work');
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-work.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), ['codex-personal.json']);
  assert.equal(fs.existsSync(harness.transactionFile), false);
});

test('rollback recovery remains visible when proxy restart also fails', (t) => {
  let renameCount = 0;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property !== 'renameSync') return target[property];
      return (source, destination) => {
        renameCount += 1;
        if (renameCount === 2 || renameCount === 3) throw new Error('simulated rollback failure');
        return target.renameSync(source, destination);
      };
    },
  });
  const harness = createHarness(t, {
    filesystem,
    proxyService: {
      isRunning: () => true,
      stop() {},
      start() {
        throw new Error('simulated proxy restart failure');
      },
    },
  });
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'work', '--force']);

  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /manual Profile recovery is required/i);
  assert.match(result.stderr[0], /proxy restart also failed/i);
  assert.equal(fs.existsSync(harness.transactionFile), true);
});
