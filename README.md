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

List Profiles with their email addresses and health status:

```bash
claudex-switch list
```

Use `claudex-switch list --json` for stable machine-readable output.

Show the active Profile:

```bash
claudex-switch current
```

Use `claudex-switch current --json` for machine-readable output. Run an
offline health check with:

```bash
claudex-switch doctor
claudex-switch doctor --json
```

Health statuses are `active`, `ready`, `needs-reauth`, `invalid`,
`unregistered`, and `unknown`. Offline inspection does not contact the
provider or change local files. JSON output uses `schemaVersion: 1` and does
not include token values or Credential data.

Switch without a new login:

```bash
claudex-switch use work
```

Add a new profile. This saves the current profile, opens the Codex OAuth login,
and makes the new profile active:

```bash
claudex-switch add personal
```

Reauthenticate an existing Profile. The command keeps the Profile active or
inactive as it was before the command:

```bash
claudex-switch reauth personal
```

The old Credential stays available until the new login creates one valid local
Credential. A changed Provider account email stops the command unless you use
the explicit opt-in:

```bash
claudex-switch reauth personal --allow-account-change
```

Deactivate the active Profile without deleting its Credential:

```bash
claudex-switch deactivate
```

The Profile remains available with `ready` status. No Profile is selected
until you use it again.

Delete an inactive local Profile and its Credential permanently:

```bash
claudex-switch delete personal
```

Type the exact stored Profile name to confirm. For an approved script, use
`claudex-switch delete personal --yes`. An active Profile must be deactivated
before deletion. Deletion does not select another Profile, does not keep a
hidden Credential copy, and does not delete or change the remote Provider
account.

Rename a profile:

```bash
claudex-switch rename old personal
```

State-changing commands use an operation lock and a private recovery record in
the Profile directory. A failed file move is rolled back. If rollback also
fails, later state-changing commands stop until the Profile storage is
recovered.

If a Claudex or CLIProxyAPI session is running, the command prints a warning
and stops. Use `--force` only to continue past this warning. It does not skip
Profile validation, storage safety checks, the operation lock, or recovery
checks.

Exit code `0` means success, `1` means an operation or service failure, `2`
means invalid command or input, and `3` means unsafe or incomplete local
state.

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
