#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

function context() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch {
    return {};
  }
}

const ctx = context();
const herdr = process.env.HERDR_BIN_PATH || "herdr";
const plugin = process.env.HERDR_PLUGIN_ID || "nnex.action-launcher";
const cwd = ctx.focused_pane_cwd || ctx.workspace_cwd;
const args = [
  "plugin", "pane", "open",
  "--plugin", plugin,
  "--entrypoint", "selector",
  "--placement", "popup",
  "--focus",
];

// Popup/overlay panes always target Herdr's active pane. Forwarding a
// workspace id is rejected by Herdr for these placement modes; the active
// workspace is already the correct target when the keybinding is invoked.
if (cwd && fs.existsSync(cwd)) args.push("--cwd", cwd);

const result = spawnSync(herdr, args, { stdio: "inherit" });
if (result.error) {
  console.error(`could not open action picker: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
