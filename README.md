# Herdr Action Launcher

A repository-aware action picker for [Herdr](https://herdr.dev/).

It keeps Herdr's native agent harness intact while providing one fzf action
picker for manual workspace actions configured globally or in a repository's
`.herdr/actions.json` file.

![Workspace Actions picker](docs/assets/action-launcher.png)

## Features

- one popup picker for the active workspace, repository, or worktree;
- repo-local actions with global defaults and ID-based overrides;
- one-off commands run directly in the picker;
- persistent services in a split pane or dedicated tab;
- dynamic `Stop: ...` actions for persistent services;
- no runtime dependencies beyond Node.js, Herdr, and fzf.

## Install from GitHub

Install the published repository directly into Herdr's managed plugin storage:

```bash
herdr plugin install nnexai/herdr-action-launcher --yes
```

You can pin a branch, tag, or commit with `--ref`:

```bash
herdr plugin install nnexai/herdr-action-launcher --ref main --yes
```

Herdr-managed installs do not require a local checkout. To migrate from a
local development link, unlink it first:

```bash
herdr plugin unlink nnex.action-launcher
herdr plugin install nnexai/herdr-action-launcher --yes
```

Herdr keeps the plugin's config and state directories when reinstalling. To
refresh a GitHub-managed install later, reinstall it:

```bash
herdr plugin uninstall nnex.action-launcher
herdr plugin install nnexai/herdr-action-launcher --ref main --yes
```

For local development instead, use:

```bash
herdr plugin link /path/to/herdr-action-launcher
```

Bind the plugin action in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+alt+a"
type = "plugin_action"
command = "nnex.action-launcher.open"
description = "Workspace actions"
```

Then reload Herdr:

```bash
herdr server reload-config
```

The action schema and persistent pane/tab examples are shown below.

## Global actions

Global actions are stored in the plugin config directory:

```bash
herdr plugin config-dir nnex.action-launcher
```

For example, `actions.json` can define Lazygit for every workspace:

```json
{
  "actions": [
    {
      "id": "open-lazygit",
      "title": "Open Lazygit in tab",
      "description": "Open Lazygit in an auto-closing tab for the active workspace.",
      "mode": "tab",
      "entrypoint": "exec",
      "command": ["lazygit"],
      "cwd": "workspace",
      "tabLabel": "lazygit"
    }
  ]
}
```

## Configuration

The launcher merges action files in this order:

1. global: the plugin config directory's `actions.json`;
2. repository: `<repo-root>/.herdr/actions.json`, when the cwd belongs to a Git repository;
3. active checkout/worktree: `<active-checkout>/.herdr/actions.json` (the Git checkout root, even when the active cwd is a subdirectory; otherwise the active cwd).

Actions are merged by `id`, so later scopes override an earlier action with the
same name while all other global and repository actions remain visible. This
allows a committed repository action set to provide defaults while an ignored
`.herdr/actions.json` in an active worktree adds or overrides local commands.

```json
{
  "actions": [
    {
      "id": "dev-server",
      "title": "Start dev server",
      "description": "Start the dev server in a dedicated tab.",
      "mode": "tab",
      "entrypoint": "exec",
      "command": ["npm", "run", "dev"],
      "cwd": "worktree",
      "tabLabel": "dev server"
    }
  ]
}
```

Use `mode: "run"` (the default) for one-off commands, `mode: "pane"` for a
persistent split pane, and `mode: "tab"` for a persistent dedicated tab.
Persistent targets receive a dynamic stop action, and closing their Herdr
pane/tab also terminates the process.

For pane and tab actions, `entrypoint` defaults to `"shell"`: the command runs
inside the pane's interactive shell, which remains after the command exits.
Set `entrypoint: "exec"` to replace that shell with the command; Herdr then
removes the pane/tab when the command exits.

## Environment, ports and health

Any action (`run`, `pane`, `tab`) can declare its environment:

```json
{
  "id": "dev-server",
  "title": "Start dev server",
  "mode": "tab",
  "command": ["npm", "run", "dev", "--", "--port", "${PORT}"],
  "env": { "NODE_ENV": "development" },
  "ports": { "PORT": "auto" },
  "health": { "port": "PORT" }
}
```

- `env`: extra `NAME: "value"` variables exported to the command, including persistent
  pane/tab commands. Values and interpolated argv are shell-quoted independently, so
  spaces and quotes remain part of their original argument.
- `ports`: `NAME: "auto"` initially picks a free local port (range 20000-39999) and
  exports it as `NAME`; a fixed number is exported as configured without allocation.
  Assignments are persisted in the plugin state directory (`ports.json`) per canonical
  checkout path and name, shared by actions in that checkout, and never silently move,
  including while the service is listening. Separate worktrees have independent slots.
  Concurrent launchers serialize allocation and service registration. An unavailable
  state directory or malformed port registry fails the action instead of losing assignments.
  This cannot reserve a port against unrelated programs between the initial check and bind;
  if another process takes an assigned port, resolve that conflict rather than expecting
  the launcher to silently choose a different one.
- `${NAME}` in `command` arguments is replaced before quoting with the resolved `env`
  or `ports` value (port names override `env`; unknown names stay as is).
- `health`: optional target recorded with the running service so tools such as Cockpit can
  show its status. Use exactly one of `{"port": 5173}`, `{"port": "PORT"}` (an env or port
  name) or `{"url": "http://localhost:${PORT}/"}`. The launcher resolves it to a concrete
  port or URL in its state file and does not probe it.

Cockpit's services sidebar is status-only: start services through this action picker,
and click a running service in Cockpit to focus its pane. The launcher records
`session` and canonical `socketPath` alongside its pane/tab IDs and resolved health
target in `persistent-panes.json`. Persistent launches require `HERDR_SOCKET_PATH`
to uniquely match a running session from `herdr session list --json`; inherited session
names cannot override that socket. Entries without this provenance are not offered as
Stop actions, and pruning/closing never removes another session's registrations.

State files are atomically replaced with private permissions under one bounded
cross-process lock. The launcher does not steal stale locks; if a process dies holding
`<plugin-state-dir>/.state-lock`, inspect its `owner.json` PID and token and ensure the
owner is gone before manually removing that lock.

The `cwd` field accepts:

- `workspace`: the active Herdr workspace cwd;
- `worktree`: the active checkout/worktree path;
- `repo`: the repository root.

## License

[MIT](LICENSE) © 2026 Konni Hartmann.
