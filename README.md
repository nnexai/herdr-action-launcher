# Herdr Action Launcher

A repository-aware action picker for [Herdr](https://herdr.dev/).

It keeps Herdr's native agent harness intact while providing one fzf action
picker for manual workspace actions configured globally or in a repository's
`.herdr/actions.json` file.

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

## Configuration

The launcher merges:

1. the global plugin config directory's `actions.json`;
2. `<repo-root>/.herdr/actions.json`.

Repo-local actions override global actions with the same `id`.

```json
{
  "actions": [
    {
      "id": "dev-server",
      "title": "Start dev server",
      "description": "Start the dev server in a dedicated tab.",
      "mode": "tab",
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

## License

[MIT](LICENSE) © 2026 Konni Hartmann.
