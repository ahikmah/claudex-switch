#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createProfileLifecycle } = require('../lib/profile-lifecycle');

const home = os.homedir();
const activeDir = process.env.CLIPROXY_AUTH_DIR || path.join(home, '.cli-proxy-api');
const profilesDir = process.env.CLAUDEX_ACCOUNT_DIR || path.join(home, '.cli-proxy-api-accounts');
const serviceName = process.env.CLAUDEX_PROXY_SERVICE_NAME || 'cliproxyapi';
const cliproxyapiBin = process.env.CLIPROXYAPI_BIN || 'cliproxyapi';
const onlineHealthUrl = 'https://chatgpt.com/backend-api/codex/models';

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

function serviceIsRunning(mode) {
  if (mode === 'brew') {
    const result = spawnSync('brew', ['services', 'list', '--json'], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Cannot read Homebrew service state');
    let services;
    try {
      services = JSON.parse(result.stdout || '[]');
    } catch {
      throw new Error('Cannot read Homebrew service state');
    }
    if (!Array.isArray(services)) services = services.services || [];
    const service = services.find((entry) => (
      entry.name === serviceName || entry.service_name === serviceName
    ));
    return Boolean(service && (
      service.running === true
      || service.status === 'started'
      || service.status === 'running'
    ));
  }

  const result = spawnSync('systemctl', ['--user', 'is-active', '--quiet', serviceName], {
    stdio: 'ignore',
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if ([1, 3, 4].includes(result.status)) return false;
  throw new Error('Cannot read systemd service state');
}

function createProxyService() {
  let mode = null;

  return {
    isRunning() {
      mode = serviceMode();
      if (mode === 'none') {
        console.warn('Proxy restart is disabled or no supported service manager was found.');
        return false;
      }
      return serviceIsRunning(mode);
    },
    stop() {
      console.log(`Stopping CLIProxyAPI with ${mode}...`);
      runService(mode, 'stop');
    },
    start() {
      runService(mode, 'start');
    },
  };
}

function isRelevantSessionRunning() {
  const result = spawnSync(
    'pgrep',
    ['-f', '(^|/)(claude|claudex|claude-code|cliproxyapi)([[:space:]]|$)'],
    { encoding: 'utf8' },
  );
  if (result.error) throw new Error('Cannot check for running Claudex or proxy sessions.');
  if (result.status === 1) return false;
  if (result.status !== 0) throw new Error('Cannot check for running Claudex or proxy sessions.');
  return (result.stdout || '')
    .split(/\s+/)
    .filter(Boolean)
    .some((pid) => Number(pid) !== process.pid);
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

function login(directory = activeDir) {
  const args = [];
  const configFile = resolveConfigFile();
  if (configFile) args.push('--config', configFile);
  args.push('--codex-login');

  const result = spawnSync(cliproxyapiBin, args, {
    stdio: 'inherit',
    env: { ...process.env, CLIPROXY_AUTH_DIR: directory },
  });
  if (result.error) throw new Error(`Cannot run ${cliproxyapiBin}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${cliproxyapiBin} login failed`);
}

function escapeCurlConfigValue(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

function createOnlineHealthCheck() {
  return ({ credentialFile }) => {
    let credential;
    try {
      credential = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
    } catch {
      return { status: 'unknown', errorCode: 'online-check-failed' };
    }

    const token = credential.access_token || credential.token_data?.access_token;
    if (typeof token !== 'string' || !token) {
      return { status: 'unknown', errorCode: 'online-check-failed' };
    }
    const accountId = credential.account_id || credential.token_data?.account_id;
    const config = [
      `header = "Authorization: Bearer ${escapeCurlConfigValue(token)}"`,
      ...(typeof accountId === 'string' && accountId
        ? [`header = "ChatGPT-Account-ID: ${escapeCurlConfigValue(accountId)}"`]
        : []),
      `url = "${onlineHealthUrl}"`,
    ].join('\n');
    const result = spawnSync(
      'curl',
      [
        '--config', '-',
        '--silent',
        '--show-error',
        '--max-time', '15',
        '--output', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '--write-out', '%{http_code}',
      ],
      { input: `${config}\n`, encoding: 'utf8' },
    );
    if (result.error || result.status !== 0) {
      return { status: 'unknown', errorCode: 'network-error' };
    }
    const statusCode = Number((result.stdout || '').trim());
    if ([401, 403].includes(statusCode)) return { status: 'rejected' };
    if (statusCode >= 200 && statusCode < 300) return { status: 'valid' };
    return { status: 'unknown', errorCode: 'online-check-failed' };
  };
}

function confirmProfileDeletion(name) {
  fs.writeSync(1, `Type Profile name '${name}' to confirm permanent local deletion: `);
  const chunks = [];
  const buffer = Buffer.alloc(1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.toString('utf8', 0, bytesRead);
      chunks.push(chunk);
      if (chunk.includes('\n')) break;
    }
  } catch {
    throw new Error('Cannot read Profile deletion confirmation.');
  }
  if (!process.stdin.isTTY) fs.writeSync(1, '\n');
  return chunks.join('').split(/\r?\n/, 1)[0];
}

try {
  const lifecycle = createProfileLifecycle({
    activeDir,
    profilesDir,
    proxyService: createProxyService(),
    isSessionRunning: isRelevantSessionRunning,
    confirmProfileDeletion,
    login,
    onlineHealthCheck: createOnlineHealthCheck(),
  });
  process.exitCode = lifecycle.run(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
