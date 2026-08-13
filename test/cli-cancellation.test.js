'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const cli = path.resolve(__dirname, '../bin/claudex-switch.js');

function writeCredential(directory, filename, email) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, filename),
    JSON.stringify({ email }),
    { mode: 0o600 },
  );
}

function runCli(root, fakeLogin, args, extraEnv = {}) {
  const environment = {
    ...process.env,
    ...extraEnv,
    CLAUDEX_ACCOUNT_DIR: path.join(root, 'profiles'),
    CLAUDEX_PROXY_SERVICE: 'none',
    CLIPROXYAPI_BIN: fakeLogin,
    CLIPROXY_AUTH_DIR: path.join(root, 'active'),
  };
  const child = spawn(process.execPath, [cli, ...args], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ child, code, signal, stdout, stderr }));
  });
}

test('Ctrl-C during CLI login rolls back and allows the next mutation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-switch-cli-'));
  const activeDir = path.join(root, 'active');
  const profilesDir = path.join(root, 'profiles');
  const fakeLogin = path.join(root, 'fake-cliproxyapi');
  fs.writeFileSync(fakeLogin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

if (process.env.FAKE_LOGIN_MODE === 'success') {
  fs.writeFileSync(
    path.join(process.env.CLIPROXY_AUTH_DIR, 'codex-login.json'),
    JSON.stringify({ email: 'team@example.com' }),
    { mode: 0o600 },
  );
  process.exit(0);
}

setTimeout(() => process.kill(process.pid, 'SIGINT'), 300);
`, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeCredential(activeDir, 'codex-personal.json', 'personal@example.com');
  fs.mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(profilesDir, 'active-profile'), 'personal\n', { mode: 0o600 });

  const environment = {
    CLAUDEX_ACCOUNT_DIR: profilesDir,
    CLAUDEX_PROXY_SERVICE: 'none',
    CLIPROXYAPI_BIN: fakeLogin,
    CLIPROXY_AUTH_DIR: activeDir,
  };
  let signalSent = false;

  const firstResultPromise = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'add', 'team', '--force'], {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!signalSent && stdout.includes('Starting Codex login')) {
        signalSent = true;
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

  const firstResult = await firstResultPromise;

  assert.equal(signalSent, true);
  assert.equal(firstResult.code, 130);
  assert.equal(firstResult.signal, null);
  assert.match(firstResult.stderr, /Profile mutation cancelled/i);
  assert.equal(fs.existsSync(path.join(profilesDir, '.operation.lock')), false);
  assert.equal(fs.existsSync(path.join(profilesDir, '.transaction.json')), false);
  assert.equal(fs.existsSync(path.join(profilesDir, 'team')), false);
  assert.deepEqual(fs.readdirSync(activeDir), ['codex-personal.json']);

  const secondResult = await runCli(root, fakeLogin, ['add', 'team', '--force'], {
    ...environment,
    FAKE_LOGIN_MODE: 'success',
  });

  assert.equal(secondResult.code, 0);
  assert.match(secondResult.stdout, /Active Profile: team/);
  assert.equal(fs.existsSync(path.join(profilesDir, '.operation.lock')), false);
  assert.equal(fs.existsSync(path.join(profilesDir, '.transaction.json')), false);
});
