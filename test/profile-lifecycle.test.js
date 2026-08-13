'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createProfileLifecycle } = require('../lib/profile-lifecycle');

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
  let loginNumber = 0;

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const lifecycleOptions = {
    filesystem: options.filesystem || fs,
    activeDir,
    profilesDir,
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
  if (options.proxyService) lifecycleOptions.proxyService = options.proxyService;
  if (options.withProxyStopped) lifecycleOptions.withProxyStopped = options.withProxyStopped;
  if (options.operationLock) lifecycleOptions.operationLock = options.operationLock;
  if (options.recoveryStore) lifecycleOptions.recoveryStore = options.recoveryStore;
  if (options.login) lifecycleOptions.login = options.login;

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

  return { root, activeDir, profilesDir, lockFile, transactionFile, events, run };
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

test('read command arguments use stable invalid-input and unsafe-state exit codes', (t) => {
  const harness = createHarness(t);

  const invalidCommand = harness.run(['not-a-command']);
  const invalidJsonUse = harness.run(['use', 'personal', '--json']);
  const unsafe = harness.run(['doctor', '--json', '--force']);

  assert.equal(invalidCommand.code, 2);
  assert.equal(invalidJsonUse.code, 2);
  assert.equal(unsafe.code, 2);
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

  assert.equal(result.code, 1);
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

  assert.equal(result.code, 1);
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

  assert.equal(collision.code, 1);
  assert.match(collision.stderr[0], /already exists/i);
  assert.equal(reserved.code, 1);
  assert.match(reserved.stderr[0], /reserved/i);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr[0], /letters, numbers/i);
  assert.equal(useReserved.code, 1);
  assert.match(useReserved.stderr[0], /reserved/i);
  assert.equal(renameCollision.code, 1);
  assert.match(renameCollision.stderr[0], /already exists/i);
  assert.equal(renameInvalid.code, 1);
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

  assert.equal(result.code, 1);
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

  assert.equal(failed.code, 1);
  assert.match(failed.stderr[0], /rollback failed|recovery/i);
  assert.equal(fs.existsSync(harness.transactionFile), true);
  assert.equal(blocked.code, 1);
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
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr[0], /letters, numbers/i);
  assert.equal(fs.existsSync(harness.lockFile), false);

  const outside = path.join(harness.root, 'outside');
  writeCredential(outside, 'codex-work.json', 'work@example.com');
  fs.symlinkSync(outside, path.join(harness.profilesDir, 'work'), 'dir');
  setActiveProfile(harness.profilesDir, 'personal');

  const unsafe = harness.run(['use', 'work', '--force']);

  assert.equal(unsafe.code, 1);
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

  assert.equal(hiddenEntry.code, 1);
  assert.match(hiddenEntry.stderr[0], /unexpected entry/i);

  fs.chmodSync(path.join(harness.activeDir, 'codex-personal.json'), 0o644);
  const publicCredential = harness.run(['use', 'work', '--force']);

  assert.equal(publicCredential.code, 1);
  assert.match(publicCredential.stderr[0], /private/i);
});

test('proxy service is stopped and restarted only when it was running', (t) => {
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
  assert.deepEqual(serviceEvents, ['stop', 'start']);
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
