#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline");

const herdr = process.env.HERDR_BIN_PATH || "herdr";

function herdrCommand(args) {
  const result = spawnSync(herdr, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `herdr ${args.join(" ")} failed`);
  }
  return result.stdout || "";
}

function herdrJson(args) {
  const stdout = herdrCommand(args);
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`invalid Herdr response: ${error.message}`);
  }
  if (envelope.error) throw new Error(envelope.error.message || envelope.error.code || "Herdr request failed");
  return envelope.result;
}

function parseContext() {
  try {
    return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
  } catch (error) {
    throw new Error(`invalid HERDR_PLUGIN_CONTEXT_JSON: ${error.message}`);
  }
}

function repoContext(ctx) {
  const workspace = ctx.workspace_cwd || ctx.focused_pane_cwd;
  const worktree = ctx.worktree || {};
  const repoRoot = worktree.repo_root || gitRoot(workspace);
  const checkout = worktree.checkout_path || workspace;
  const branch = worktree.branch || gitBranch(checkout);
  return {
    workspace,
    workspaceId: ctx.workspace_id || process.env.HERDR_WORKSPACE_ID || null,
    checkout,
    repoRoot,
    branch,
    repoName: worktree.repo_name || (repoRoot ? path.basename(repoRoot) : "unknown"),
  };
}

function gitRoot(cwd) {
  if (!cwd) return null;
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitBranch(cwd) {
  if (!cwd) return null;
  const result = spawnSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readJson(file) {
  if (!file || !fs.existsSync(file)) return { actions: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || !Array.isArray(parsed.actions)) {
    throw new Error(`${file} must contain an {\"actions\": [...]} array`);
  }
  return parsed;
}

function loadActions(repo) {
  const globalFile = path.join(
    process.env.HERDR_PLUGIN_CONFIG_DIR || ".",
    "actions.json",
  );
  const repoFile = repo.repoRoot ? path.join(repo.repoRoot, ".herdr", "actions.json") : null;
  const checkoutFile = repo.checkout ? path.join(repo.checkout, ".herdr", "actions.json") : null;
  const files = [globalFile, repoFile, checkoutFile].filter((file, index, all) => (
    file && all.findIndex((candidate) => candidate && path.resolve(candidate) === path.resolve(file)) === index
  ));
  const merged = new Map();

  // Later scopes override earlier scopes by action id, while all other actions
  // remain visible: global -> repository -> active worktree/checkout.
  for (const file of files) {
    for (const action of readJson(file).actions) merged.set(action.id, action);
  }

  return [...merged.values()]
    .filter((action) => action.enabled !== false)
    .filter((action) => action.repoRoots === undefined || matchesRepo(action.repoRoots, repo.repoRoot))
    .map(validateAction)
    .sort((a, b) => a.title.localeCompare(b.title));
}

function matchesRepo(patterns, repoRoot) {
  const values = Array.isArray(patterns) ? patterns : [patterns];
  return values.some((value) => {
    if (typeof value !== "string") return false;
    if (value.endsWith("*")) return repoRoot?.startsWith(value.slice(0, -1));
    return path.resolve(value) === path.resolve(repoRoot || "");
  });
}

function validateAction(action) {
  if (!action || typeof action !== "object") throw new Error("each action must be an object");
  if (!action.id || !action.title) throw new Error("each action needs id and title");
  if (!Array.isArray(action.command) || action.command.length === 0 || action.command.some((x) => typeof x !== "string")) {
    throw new Error(`action ${action.id} needs a non-empty command argv array`);
  }
  const cwd = action.cwd || "workspace";
  if (!["workspace", "worktree", "repo"].includes(cwd)) {
    throw new Error(`action ${action.id} has invalid cwd: ${cwd}`);
  }
  const mode = action.mode || "run";
  if (!["run", "pane", "tab"].includes(mode)) {
    throw new Error(`action ${action.id} has invalid mode: ${mode}`);
  }
  const direction = action.direction || "right";
  if (!["right", "down"].includes(direction)) {
    throw new Error(`action ${action.id} has invalid pane direction: ${direction}`);
  }
  const entrypoint = action.entrypoint || "shell";
  if (!["shell", "exec"].includes(entrypoint)) {
    throw new Error(`action ${action.id} has invalid entrypoint: ${entrypoint}`);
  }
  return {
    description: "",
    confirm: false,
    keepOpen: false,
    focus: true,
    ...action,
    cwd,
    mode,
    direction,
    entrypoint,
  };
}

function stateFile() {
  const directory = process.env.HERDR_PLUGIN_STATE_DIR;
  return directory ? path.join(directory, "persistent-panes.json") : null;
}

function readPersistentState() {
  const file = stateFile();
  if (!file || !fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePersistentState(entries) {
  const file = stateFile();
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(entries, null, 2)}\n`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function persistentCommand(action) {
  const command = action.command.map(shellQuote).join(" ");
  return action.entrypoint === "exec" ? `exec ${command}` : command;
}

function persistentActions(repo) {
  const state = readPersistentState();
  const active = [];

  for (const entry of state) {
    if (entry.checkout !== repo.checkout || entry.repoRoot !== repo.repoRoot) {
      active.push(entry);
      continue;
    }
    try {
      herdrJson(entry.kind === "tab"
        ? ["tab", "get", entry.tabId]
        : ["pane", "get", entry.paneId]);
      active.push(entry);
    } catch {
      // The pane/tab was closed outside the picker; discard its stop entry.
    }
  }

  if (active.length !== state.length) writePersistentState(active);

  return active
    .filter((entry) => entry.checkout === repo.checkout && entry.repoRoot === repo.repoRoot)
    .map((entry) => ({
      id: `stop:${entry.key}`,
      title: `Stop: ${entry.title}`,
      description: entry.kind === "tab"
        ? `Close tab ${entry.tabId}`
        : `Close pane ${entry.paneId}`,
      mode: "stop",
      kind: entry.kind,
      paneId: entry.paneId,
      tabId: entry.tabId,
      confirm: true,
      cwd: "workspace",
    }));
}

function actionCwd(action, repo) {
  if (action.cwd === "repo") return repo.repoRoot || repo.workspace;
  if (action.cwd === "workspace") return repo.workspace;
  return repo.checkout || repo.workspace;
}

function printList(actions, repo) {
  console.log(`Active: ${repo.repoName} | ${repo.branch || "no branch"} | ${repo.checkout || "no workspace"}`);
  for (const action of actions) console.log(`${action.id}\t${action.title}\t${action.description}`);
}

function pickWithFzf(actions, repo) {
  if (!actions.length) return null;
  const lines = actions.map((action) => `${action.id}\t${action.title}\t${action.description}`);
  const header = `${repo.repoName} / ${repo.branch || "no branch"} — Enter runs, Esc cancels`;
  const result = spawnSync("fzf", [
    "--height=80%",
    "--layout=reverse",
    "--border",
    "--prompt=Action > ",
    "--header", header,
    "--delimiter", "\\t",
    "--with-nth", "2..",
    "--no-multi",
  ], { input: `${lines.join("\n")}\n`, encoding: "utf8" });

  if (result.error && result.error.code === "ENOENT") return pickNumbered(actions);
  if (result.status !== 0) return null;
  return actions.find((action) => action.id === result.stdout.trim().split("\t", 1)[0]) || null;
}

function pickNumbered(actions) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log("fzf is unavailable; choose an action (empty cancels):");
    actions.forEach((action, index) => console.log(`${index + 1}. ${action.title} — ${action.description}`));
    rl.question("> ", (answer) => {
      rl.close();
      const index = Number.parseInt(answer, 10) - 1;
      resolve(Number.isInteger(index) && actions[index] ? actions[index] : null);
    });
  });
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function stopPersistent(action, repo) {
  const state = readPersistentState();
  const entry = state.find((candidate) => candidate.key === action.id.slice("stop:".length));
  if (!entry) throw new Error(`persistent target is no longer registered: ${action.title}`);

  if (action.confirm) {
    const answer = await ask(`Close ${action.title}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) return 0;
  }

  if (entry.kind === "tab") {
    herdrJson(["tab", "close", entry.tabId]);
  } else {
    herdrJson(["pane", "close", entry.paneId]);
  }
  writePersistentState(state.filter((candidate) => candidate.key !== entry.key));
  console.log(`closed ${entry.title}`);
  return 0;
}

function startPane(action, repo) {
  const cwd = actionCwd(action, repo);
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`action cwd does not exist: ${cwd}`);

  const key = `${repo.checkout}:${action.id}`;
  const existing = readPersistentState().find((entry) => entry.key === key);
  if (existing) {
    throw new Error(`${action.title} is already running in ${existing.kind} ${existing.tabId || existing.paneId}; choose its Stop action first`);
  }

  const splitArgs = [
    "pane", "split", "--current",
    "--direction", action.direction,
    "--cwd", cwd,
    action.focus === false ? "--no-focus" : "--focus",
  ];
  if (action.ratio !== undefined) splitArgs.push("--ratio", String(action.ratio));

  const split = herdrJson(splitArgs);
  const paneId = split?.pane?.pane_id;
  if (!paneId) throw new Error("Herdr did not return the new pane id");

  const title = action.label || action.paneLabel || action.title;
  herdrJson(["pane", "rename", paneId, title]);

  const command = persistentCommand(action);
  try {
    herdrCommand(["pane", "run", paneId, command]);
  } catch (error) {
    try { herdrJson(["pane", "close", paneId]); } catch {}
    throw error;
  }

  const state = readPersistentState().filter((entry) => entry.paneId !== paneId);
  state.push({
    key: `${repo.checkout}:${action.id}`,
    kind: "pane",
    actionId: action.id,
    title,
    paneId,
    repoRoot: repo.repoRoot,
    checkout: repo.checkout,
    workspace: repo.workspace,
    startedAt: new Date().toISOString(),
  });
  writePersistentState(state);
  console.log(`started ${title} in ${paneId}`);
  return 0;
}

function startTab(action, repo) {
  const cwd = actionCwd(action, repo);
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`action cwd does not exist: ${cwd}`);
  if (!repo.workspaceId) throw new Error("Herdr did not provide the active workspace id");

  const key = `${repo.checkout}:${action.id}`;
  const existing = readPersistentState().find((entry) => entry.key === key);
  if (existing) {
    throw new Error(`${action.title} is already running in ${existing.kind} ${existing.tabId || existing.paneId}; choose its Stop action first`);
  }

  const title = action.label || action.tabLabel || action.title;
  const createArgs = [
    "tab", "create",
    "--workspace", repo.workspaceId,
    "--cwd", cwd,
    "--label", title,
    action.focus === false ? "--no-focus" : "--focus",
  ];
  const created = herdrJson(createArgs);
  const tabId = created?.tab?.tab_id;
  const paneId = created?.root_pane?.pane_id;
  if (!tabId || !paneId) throw new Error("Herdr did not return the new tab and root pane ids");

  if (action.paneLabel) herdrJson(["pane", "rename", paneId, action.paneLabel]);

  const command = persistentCommand(action);
  try {
    herdrCommand(["pane", "run", paneId, command]);
  } catch (error) {
    try { herdrJson(["tab", "close", tabId]); } catch {}
    throw error;
  }

  const state = readPersistentState().filter((entry) => entry.paneId !== paneId && entry.tabId !== tabId);
  state.push({
    key,
    kind: "tab",
    actionId: action.id,
    title,
    tabId,
    paneId,
    repoRoot: repo.repoRoot,
    checkout: repo.checkout,
    workspace: repo.workspace,
    startedAt: new Date().toISOString(),
  });
  writePersistentState(state);
  console.log(`started ${title} in tab ${tabId}`);
  return 0;
}

async function run(action, repo) {
  if (action.mode === "stop") return stopPersistent(action, repo);

  if (action.confirm) {
    const answer = await ask(`Run ${action.title}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) return 0;
  }

  if (action.mode === "pane") return startPane(action, repo);
  if (action.mode === "tab") return startTab(action, repo);

  const cwd = actionCwd(action, repo);
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`action cwd does not exist: ${cwd}`);

  console.log(`\n▶ ${action.title}`);
  console.log(`  cwd: ${cwd}`);
  const result = spawnSync(action.command[0], action.command.slice(1), {
    cwd,
    env: {
      ...process.env,
      HERDR_ACTION_ID: action.id,
      HERDR_ACTION_CONTEXT_JSON: JSON.stringify(repo),
    },
    stdio: "inherit",
  });

  if (result.error) throw result.error;
  if (action.keepOpen) await ask("\nPress Enter to close… ");
  return result.status ?? 1;
}

async function main() {
  const ctx = parseContext();
  const repo = repoContext(ctx);
  const actions = [
    ...loadActions(repo),
    ...persistentActions(repo),
  ].sort((a, b) => a.title.localeCompare(b.title));

  if (process.argv.includes("--list")) {
    printList(actions, repo);
    return;
  }

  const requested = process.argv.indexOf("--run");
  if (requested !== -1) {
    const action = actions.find((candidate) => candidate.id === process.argv[requested + 1]);
    if (!action) throw new Error(`unknown configured action: ${process.argv[requested + 1]}`);
    process.exitCode = await run(action, repo);
    return;
  }

  if (!actions.length) {
    console.log(`No actions configured for ${repo.repoName}.`);
    console.log(`Add ${repo.repoRoot ? path.join(repo.repoRoot, ".herdr", "actions.json") : "actions.json"}.`);
    return;
  }

  const selected = await pickWithFzf(actions, repo);
  if (selected) process.exitCode = await run(selected, repo);
}

main().catch((error) => {
  console.error(`action picker: ${error.message}`);
  process.exitCode = 1;
});
