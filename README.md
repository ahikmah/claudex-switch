# claudex-switch

Switch named Codex OAuth profiles used by Claudex through CLIProxyAPI.

`claudex-switch` keeps one Codex credential active at a time. It stores other
credentials in local profile folders. It does not send credentials to GitHub,
npm, or any other service.

## Requirements

- macOS with Homebrew
- `cliproxyapi` installed and available in `PATH`
- `jq` installed and available in `PATH`
- `zsh`

The default CLIProxyAPI configuration file is:

```text
/opt/homebrew/etc/cliproxyapi.conf
```

Set `CLIPROXY_CONFIG` to use another file. Set `CLIPROXY_AUTH_DIR` to use
another CLIProxyAPI credential directory.

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
