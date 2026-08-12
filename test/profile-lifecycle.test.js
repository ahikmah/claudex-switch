'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createProfileLifecycle } = require('../lib/profile-lifecycle');

function writeCredential(directory, filename, email) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, filename),
    JSON.stringify({ email }),
    { mode: 0o600 },
  );
}

function createHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-switch-'));
  const activeDir = path.join(root, 'active');
  const profilesDir = path.join(root, 'profiles');
  const output = { stdout: [], stderr: [] };
  const events = [];
  let loginNumber = 0;

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const lifecycle = createProfileLifecycle({
    activeDir,
    profilesDir,
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
  });

  function run(argv) {
    output.stdout.length = 0;
    output.stderr.length = 0;
    const code = lifecycle.run(argv, {
      stdout: (line) => output.stdout.push(line),
      stderr: (line) => output.stderr.push(line),
    });
    return { code, stdout: [...output.stdout], stderr: [...output.stderr] };
  }

  return { root, activeDir, profilesDir, events, run };
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

test('list shows active and inactive Profiles with email addresses', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'same@example.com');
  writeCredential(path.join(harness.profilesDir, 'team'), 'codex-team.json', 'same@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['list']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, [
    '* personal (same@example.com, 1 credential)',
    '  team (same@example.com, 1 credential)',
  ]);
  assert.deepEqual(result.stderr, []);
});

test('current reports the active Profile', (t) => {
  const harness = createHarness(t);
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['current']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ['personal']);
});

test('use switches the active Credential and preserves the old Profile', (t) => {
  const harness = createHarness(t);
  writeCredential(harness.activeDir, 'codex-personal.json', 'personal@example.com');
  writeCredential(path.join(harness.profilesDir, 'work'), 'codex-work.json', 'work@example.com');
  setActiveProfile(harness.profilesDir, 'personal');

  const result = harness.run(['use', 'work']);

  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, ['Active Profile: work']);
  assert.equal(readActiveProfile(harness.profilesDir), 'work');
  assert.deepEqual(credentialNames(harness.activeDir), ['codex-work.json']);
  assert.deepEqual(credentialNames(path.join(harness.profilesDir, 'personal')), ['codex-personal.json']);
  assert.deepEqual(harness.events, ['proxy:before', 'proxy:after']);
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

test('Profile names reject reserved names and case-insensitive collisions', (t) => {
  const harness = createHarness(t);
  fs.mkdirSync(path.join(harness.profilesDir, 'Work'), { recursive: true });
  fs.mkdirSync(path.join(harness.profilesDir, 'Team'), { recursive: true });

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

  assert.equal(result.code, 1);
  assert.deepEqual(result.stdout, []);
  assert.match(result.stderr[0], /no active profile/i);
});
