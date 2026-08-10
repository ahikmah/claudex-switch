# claudex-switch

[![npm version](https://img.shields.io/npm/v/claudex-switch?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/claudex-switch)
[![Node.js](https://img.shields.io/node/v/claudex-switch?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/ahikmah/claudex-switch?style=for-the-badge&logo=github)](https://github.com/ahikmah/claudex-switch/stargazers)
[![License](https://img.shields.io/github/license/ahikmah/claudex-switch?style=for-the-badge)](https://github.com/ahikmah/claudex-switch/blob/main/LICENSE)

Switch named Codex OAuth profiles used by Claudex through CLIProxyAPI.

`claudex-switch` keeps one Codex credential active at a time. It stores other
credentials in local profile folders. It does not send credentials to GitHub,
npm, or any other service.

## Requirements

- Node.js 18 or newer
- CLIProxyAPI installed and available in `PATH`

The tool detects a CLIProxyAPI configuration file at these locations:

```text
/opt/homebrew/etc/cliproxyapi.conf
/usr/local/etc/cliproxyapi.conf
~/.config/cliproxyapi.conf
```

Set `CLIPROXY_CONFIG` to use another file. Set `CLIPROXY_AUTH_DIR` to use
another CLIProxyAPI credential directory.

The tool detects Homebrew on macOS and systemd on Linux. Set
`CLAUDEX_PROXY_SERVICE=none` if you manage the CLIProxyAPI process yourself.
You can also set it to `brew` or `systemd`.

## Install

```bash
npm install --global claudex-switch
```

## Commands

List profiles and their email addresses:

```bash
claudex-switch list
```

Show the active profile:

```bash
claudex-switch current
```

Switch without a new login:

```bash
claudex-switch use work
```

Add a new profile. This saves the current profile, opens the Codex OAuth login,
and makes the new profile active:

```bash
claudex-switch add personal
```

Rename a profile:

```bash
claudex-switch rename old personal
```

## Safety

Close active Claudex sessions before switching profiles. Start a new Claudex
session after a switch.

The tool moves local credential files. It does not print their token values.
Do not commit files from the CLIProxyAPI credential directory.

## Local aliases

The package provides the `claudex-switch` command. You can add a short shell
alias:

```bash
alias cs='claudex-switch'
```

## License

MIT
