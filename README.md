# claudex-switch

[![npm version](https://img.shields.io/npm/v/claudex-switch?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/claudex-switch)
[![Node.js](https://img.shields.io/node/v/claudex-switch?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/ahikmah/claudex-switch?style=for-the-badge&logo=github)](https://github.com/ahikmah/claudex-switch/stargazers)
[![License](https://img.shields.io/github/license/ahikmah/claudex-switch?style=for-the-badge)](https://github.com/ahikmah/claudex-switch/blob/main/LICENSE)

Switch named Codex OAuth Profiles used by Claudex through CLIProxyAPI.

`claudex-switch` keeps one Codex Credential active at a time. It stores other
Credentials in local Profile folders. Offline commands do not contact the
Provider or send Credential data to any service. `doctor --online` is the only
exception: it sends each locally valid Credential only to the Provider health
endpoint for the requested check. It does not send Credential data to GitHub
or npm.

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
another CLIProxyAPI Credential directory.

The tool detects Homebrew on macOS and systemd on Linux. Set
`CLAUDEX_PROXY_SERVICE=none` if you manage the CLIProxyAPI process yourself.
You can also set it to `brew` or `systemd`.

## Install

```bash
npm install --global claudex-switch
```

## Upgrade

Version `0.2.0` fixes the executable command file. Upgrade with:

```bash
npm install --global claudex-switch@0.2.0
```

You can also update the global package with:

```bash
npm update --global claudex-switch
```

## Commands

Show command help:

```bash
claudex-switch help
```

### Read Profiles

List Profiles with their email addresses and health status:

```bash
claudex-switch list
claudex-switch list --json
```

Show the active Profile:

```bash
claudex-switch current
claudex-switch current --json
```

`list`, `current`, and `doctor` are read-only commands. Their default output
does not contact the Provider.

### Diagnose and repair

Run an offline health check with:

```bash
claudex-switch doctor
claudex-switch doctor --json
```

Run an explicit read-only online Credential check with:

```bash
claudex-switch doctor --online
claudex-switch doctor --online --json
```

Online diagnosis checks each locally valid Credential through the online health
adapter. It does not start Reauthentication, change Credential or Profile
files, move Credentials, or restart the proxy. A rejected or expired
Credential is reported as `needs-reauth`. Provider or network uncertainty is
reported as `unknown` and returns exit code `3`. `--online` and `--repair`
cannot be used together.

Apply only repairs that have one safe result:

```bash
claudex-switch doctor --repair
claudex-switch doctor --repair --json
```

Repair sets known Profile directories to `0700` and known Credential, state,
lock, and transaction files to `0600`. It removes an operation lock only when
the recorded owner process is not running. It can also restore a staged
transaction when the recovery record and current files define one safe
rollback result.

Repair does not follow symlinks, change unexpected files, guess an ambiguous
transaction result, expose Credential data, or select another Profile. Unsafe
or incomplete state remains in place and returns exit code `3`. Human and JSON
output include stable issue and repair codes.

### Profile lifecycle

Switch without a new login:

```bash
claudex-switch use work
```

Add a new Profile. This saves the current Profile, opens the Codex OAuth login,
and makes the new Profile active:

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
before deletion. Deletion does not select another Profile and does not keep a
hidden Credential copy. Remote Provider accounts are never deleted or changed
by this command.

Rename a Profile:

```bash
claudex-switch rename old personal
```

### Profile names and email addresses

Profile names must:

- start with a letter or number;
- use only letters, numbers, dot (`.`), underscore (`_`), or hyphen (`-`);
- not use a reserved command name such as `add`, `current`, `doctor`, `help`,
  `list`, `reauth`, `delete`, `deactivate`, `rename`, or `use`.

Profile names are unique without case differences. For example, `Work` and
`work` cannot both exist. The stored spelling remains the display spelling.

Email addresses are display data, not Profile keys. Different Credentials may
use the same email address. Exact duplicate Credential data is rejected.

### Options

- `--json` is supported by `list`, `current`, and `doctor`. It uses JSON schema
  version `1`. It does not include Credential data or token values.
- `--online` is supported only by `doctor`. It performs the explicit online
  read-only Provider check described above.
- `--repair` is supported only by `doctor`. It applies only deterministic local
  repairs.
- `--force` is supported by Profile mutations and `doctor --repair`. It bypasses
  only the running-session warning.
- `--yes` is supported only by `delete`. It skips the exact Profile-name
  confirmation. Use it only in an approved script.
- `--allow-account-change` is supported only by `reauth`. It allows the new
  Credential to use a different Provider account email.

### Health statuses

| Status | Meaning |
| --- | --- |
| `active` | The selected Profile has one valid local Credential. |
| `ready` | An inactive Profile has one valid local Credential. |
| `needs-reauth` | An online check rejected or expired the Credential. |
| `invalid` | Local storage or Credential data is missing, malformed, or unsafe. |
| `unregistered` | An active Credential has no matching Profile. |
| `unknown` | An online Provider or network check could not determine the result. |

### Session warning and recovery

Profile mutations (`use`, `add`, `reauth`, `deactivate`, `delete`, and
`rename`) and `doctor --repair` use a private operation lock and a private
recovery record. If a Claudex or CLIProxyAPI session is running, the command
prints a warning and stops. Use `--force` only to continue past this warning.
It does not skip Profile validation, storage safety checks, the operation lock,
or recovery checks.

A failed file move is rolled back. If rollback also fails, later state-changing
commands stop until `doctor --repair` restores one safe transaction result or
reports that manual recovery is required. Repair leaves symlinked, unexpected,
or ambiguous storage unchanged. Recovery records do not contain Credential
values.

### Exit codes and JSON

- `0`: success.
- `1`: operation or proxy service failure.
- `2`: invalid command or input.
- `3`: unsafe or incomplete local state, including a failed online diagnosis.

JSON output uses `schemaVersion: 1`. Profile objects contain the Profile name,
display email, active flag, health status, and stable error codes. The output
does not include Credential files, Credential values, or token values.

## Safety

Close active Claudex sessions before changing Profiles. Start a new Claudex
session after a switch.

The tool moves local Credential files. It does not print their token values.
`delete` removes only the selected local Profile and its local Credential. It
does not delete, revoke, or change a remote Provider account. Do not commit
files from the CLIProxyAPI Credential directory.

## Local aliases

The package provides the `claudex-switch` command. You can add a short shell
alias:

```bash
alias cs='claudex-switch'
```

## License

MIT
