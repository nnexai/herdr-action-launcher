#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline");
const { readState, writeState, withStateLock } = require("./state");

const herdr = process.env.HERDR_BIN_PATH || "herdr";
let selectedSocket = null;

function herdrCommand(args) {
  const env = { ...process.env };
  if (selectedSocket || env.HERDR_SOCKET_PATH) {
    delete env.HERDR_SESSION;
    delete env.HERDR_SESSION_NAME;
    env.HERDR_SOCKET_PATH = selectedSocket || env.HERDR_SOCKET_PATH;
  }
  const result = spawnSync(herdr, args, { encoding: "utf8", env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    let failure;
    for (const output of [result.stdout, result.stderr]) {
      try { failure = JSON.parse(output).error; } catch {}
      if (failure) break;
    }
    const error = new Error(failure?.message || result.stderr?.trim() || `herdr ${args.join(" ")} failed`);
    error.code = failure?.code;
    throw error;
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
  if (envelope.error) {
    const error = new Error(envelope.error.message || envelope.error.code || "Herdr request failed");
    error.code = envelope.error.code;
    throw error;
  }
  return envelope.result;
}

function serviceIdentity() {
  const socket = process.env.HERDR_SOCKET_PATH;
  if (!socket) throw new Error("HERDR_SOCKET_PATH is required for persistent services");
  const socketPath = fs.realpathSync(socket);
  selectedSocket = socketPath;
  const listed = JSON.parse(herdrCommand(["session", "list", "--json"]));
  if (!Array.isArray(listed.sessions)) throw new Error("Herdr did not return a sessions array");
  const matches = listed.sessions.filter((session) => {
    if (!session.running || typeof session.socket_path !== "string") return false;
    try { return fs.realpathSync(session.socket_path) === socketPath; } catch { return false; }
  });
  if (matches.length !== 1 || typeof matches[0].name !== "string") {
    throw new Error("HERDR_SOCKET_PATH must identify exactly one running Herdr session");
  }
  return { session: matches[0].name, socketPath };
}

function sameSession(entry, identity) {
  return entry.session === identity.session && entry.socketPath === identity.socketPath;
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
  const checkoutPath = worktree.checkout_path || gitRoot(workspace) || workspace;
  const checkout = checkoutPath ? fs.realpathSync(checkoutPath) : null;
  const repoRoot = worktree.repo_root || checkout;
  const branch = worktree.branch || gitBranch(checkout);
  return {
    workspace,
    workspaceId: ctx.workspace_id || process.env.HERDR_WORKSPACE_ID || null,
    paneId: ctx.focused_pane_id || process.env.HERDR_PANE_ID || null,
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
  const health = action.health ?? null;
  if (health !== null) {
    const portOk = Number.isInteger(health.port) ? health.port > 0 && health.port < 65536 : ENV_NAME.test(health.port ?? "");
    const valid = typeof health === "object" && (
      (health.url === undefined && portOk)
      || (typeof health.url === "string" && /^https?:\/\//.test(health.url) && health.port === undefined)
    );
    if (!valid) throw new Error(`action ${action.id} health needs exactly one of {"port": 1-65535 or an env/port name} or {"url": "http(s)://..."}`);
  }
  const env = action.env ?? {};
  if (typeof env !== "object" || Array.isArray(env) || Object.entries(env).some(([k, v]) => !ENV_NAME.test(k) || typeof v !== "string")) {
    throw new Error(`action ${action.id} env must be an object of NAME: "string" pairs`);
  }
  const ports = action.ports ?? {};
  if (typeof ports !== "object" || Array.isArray(ports) || Object.entries(ports).some(([k, v]) => (
    !ENV_NAME.test(k) || !(v === "auto" || (Number.isInteger(v) && v > 0 && v < 65536))
  ))) {
    throw new Error(`action ${action.id} ports must map NAME to "auto" or a fixed port number`);
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
    health,
  };
}

function readPersistentState() {
  return readState("persistent-panes.json", [], Array.isArray);
}

function writePersistentState(entries) {
  writeState("persistent-panes.json", entries);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PORT_RANGE = [20000, 39999];

// ${NAME} in command arguments is replaced with the action's resolved env
// value; unknown names are left untouched.
function interpolate(value, env) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => (name in env ? env[name] : match));
}

function resolvedCommand(action, env) {
  return action.command.map((part) => interpolate(part, env));
}

function persistentCommand(action, env) {
  const assignments = Object.entries(env).map(([name, value]) => shellQuote(`${name}=${value}`));
  const command = [...(assignments.length ? ["env", ...assignments] : []), ...resolvedCommand(action, env).map(shellQuote)].join(" ");
  return action.entrypoint === "exec" ? `exec ${command}` : command;
}

function readSlotPorts() {
  return readState("ports.json", {}, (value) => (
    value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.values(value).every((port) => Number.isInteger(port) && port > 0 && port < 65536)
  ));
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

// A saved (canonical checkout, NAME) assignment never moves, even while bound.
async function allocatePort(slot) {
  return withStateLock(async () => {
    const slots = readSlotPorts();
    if (Object.hasOwn(slots, slot)) return slots[slot];
    const taken = new Set(Object.values(slots));
    const [low, high] = PORT_RANGE;
    const span = high - low + 1;
    const start = crypto.createHash("sha256").update(slot).digest().readUInt32BE(0) % span;
    for (let offset = 0; offset < span; offset++) {
      const port = low + ((start + offset) % span);
      if (taken.has(port) || !(await isPortFree(port))) continue;
      slots[slot] = port;
      writeState("ports.json", slots);
      return port;
    }
    throw new Error(`no free port in ${low}-${high} for ${slot}`);
  });
}

// Explicit action env is exported first; resolved port names override it.
async function launchEnv(action, repo) {
  const env = { ...action.env };
  for (const [name, spec] of Object.entries(action.ports ?? {})) {
    if (spec === "auto" && !repo.checkout) throw new Error("automatic ports require a checkout or workspace");
    env[name] = String(spec === "auto" ? await allocatePort(`${fs.realpathSync(repo.checkout)}:${name}`) : spec);
  }
  return env;
}

// Health recorded for status displays: a concrete port or URL.
function resolveHealth(action, env) {
  const health = action.health;
  if (!health) return null;
  const lookup = (name) => {
    if (!(name in env)) throw new Error(`action ${action.id} health refers to ${name}, which is not in its environment`);
    return env[name];
  };
  if (health.url !== undefined) {
    return { url: health.url.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => lookup(name)) };
  }
  const port = typeof health.port === "string" ? Number(lookup(health.port)) : health.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`action ${action.id} health port ${health.port} is not a valid port`);
  }
  return { port };
}

function prunePersistentState(repo, identity) {
  const state = readPersistentState();
  const active = state.filter((entry) => {
    if (!sameSession(entry, identity) || entry.checkout !== repo.checkout || entry.repoRoot !== repo.repoRoot) return true;
    try {
      herdrJson(["pane", "get", entry.paneId]);
      if (entry.tabId) herdrJson(["tab", "get", entry.tabId]);
      return true;
    } catch (error) {
      // Transport and other unexpected failures must not erase registrations.
      if (error.code === "pane_not_found" || error.code === "tab_not_found") return false;
      throw error;
    }
  });
  if (active.length !== state.length) writePersistentState(active);
  return active;
}

async function persistentActions(repo) {
  if (!process.env.HERDR_PLUGIN_STATE_DIR || !process.env.HERDR_SOCKET_PATH) return [];
  const state = readPersistentState();
  if (!state.some((entry) => typeof entry.session === "string" && typeof entry.socketPath === "string"
    && entry.checkout === repo.checkout && entry.repoRoot === repo.repoRoot)) return [];
  const identity = serviceIdentity();
  return withStateLock(() => prunePersistentState(repo, identity)
    .filter((entry) => sameSession(entry, identity) && entry.checkout === repo.checkout && entry.repoRoot === repo.repoRoot)
    .map((entry) => ({
      id: `stop:${entry.key}`,
      title: `Stop: ${entry.title}`,
      description: entry.kind === "tab" ? `Close tab ${entry.tabId}` : `Close pane ${entry.paneId}`,
      mode: "stop",
      kind: entry.kind,
      paneId: entry.paneId,
      tabId: entry.tabId,
      ...identity,
      confirm: true,
      cwd: "workspace",
    })));
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
    "--height=100%",
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
  if (action.confirm) {
    const answer = await ask(`Close ${action.title}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) return 0;
  }
  const identity = serviceIdentity();
  if (!sameSession(action, identity)) throw new Error("persistent target belongs to a different Herdr session");
  return withStateLock(() => {
    const state = readPersistentState();
    const entry = state.find((candidate) => sameSession(candidate, identity)
      && candidate.key === action.id.slice("stop:".length)
      && candidate.checkout === repo.checkout && candidate.repoRoot === repo.repoRoot
      && candidate.paneId === action.paneId && candidate.tabId === action.tabId);
    if (!entry) throw new Error(`persistent target is no longer registered: ${action.title}`);
    herdrJson(["pane", "get", entry.paneId]);
    if (entry.tabId) herdrJson(["tab", "get", entry.tabId]);
    herdrJson(entry.kind === "tab" ? ["tab", "close", entry.tabId] : ["pane", "close", entry.paneId]);
    writePersistentState(state.filter((candidate) => candidate !== entry));
    console.log(`closed ${entry.title}`);
    return 0;
  });
}

async function startPersistent(action, repo) {
  const cwd = actionCwd(action, repo);
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`action cwd does not exist: ${cwd}`);
  const isTab = action.mode === "tab";
  if (isTab && !repo.workspaceId) throw new Error("Herdr did not provide the active workspace id");
  if (!isTab && (typeof repo.paneId !== "string" || !repo.paneId)) {
    throw new Error("Herdr did not provide the source pane id");
  }
  const identity = serviceIdentity();
  if (!isTab) {
    const source = herdrJson(["pane", "get", repo.paneId])?.pane;
    if (!source || (repo.workspaceId && source.workspace_id !== repo.workspaceId)) {
      throw new Error("source pane does not belong to the active workspace");
    }
  }
  // Port allocation uses the same lock; resolve it before the launch transaction.
  const env = await launchEnv(action, repo);
  const health = resolveHealth(action, env);
  const key = `${repo.checkout}:${action.id}`;
  const title = action.label || (isTab ? action.tabLabel : action.paneLabel) || action.title;

  return withStateLock(() => {
    const state = prunePersistentState(repo, identity);
    const existing = state.find((entry) => sameSession(entry, identity) && entry.key === key);
    if (existing) {
      throw new Error(`${action.title} is already running in ${existing.kind} ${existing.tabId || existing.paneId}; choose its Stop action first`);
    }
    const args = isTab ? [
      "tab", "create", "--workspace", repo.workspaceId, "--cwd", cwd, "--label", title,
      action.focus === false ? "--no-focus" : "--focus",
    ] : [
      "pane", "split", "--pane", repo.paneId, "--direction", action.direction, "--cwd", cwd,
      action.focus === false ? "--no-focus" : "--focus",
    ];
    if (!isTab && action.ratio !== undefined) args.push("--ratio", String(action.ratio));
    const created = herdrJson(args);
    const paneId = isTab ? created?.root_pane?.pane_id : created?.pane?.pane_id;
    const tabId = isTab ? created?.tab?.tab_id : undefined;
    if (!paneId || (isTab && !tabId)) throw new Error("Herdr did not return the new pane/tab ids");
    try {
      if (!isTab || action.paneLabel) herdrJson(["pane", "rename", paneId, isTab ? action.paneLabel : title]);
      herdrCommand(["pane", "run", paneId, persistentCommand(action, env)]);
      state.push({
        key,
        kind: action.mode,
        actionId: action.id,
        title,
        paneId,
        ...(isTab ? { tabId } : {}),
        repoRoot: repo.repoRoot,
        checkout: repo.checkout,
        workspace: repo.workspace,
        startedAt: new Date().toISOString(),
        health,
        ...identity,
      });
      writePersistentState(state);
    } catch (error) {
      try { herdrJson(isTab ? ["tab", "close", tabId] : ["pane", "close", paneId]); } catch {}
      throw error;
    }
    console.log(`started ${title} in ${isTab ? `tab ${tabId}` : paneId}`);
    return 0;
  });
}

async function run(action, repo) {
  if (action.mode === "stop") return stopPersistent(action, repo);

  if (action.confirm) {
    const answer = await ask(`Run ${action.title}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) return 0;
  }

  if (action.mode === "pane" || action.mode === "tab") return startPersistent(action, repo);

  const cwd = actionCwd(action, repo);
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`action cwd does not exist: ${cwd}`);

  const env = await launchEnv(action, repo);
  const argv = resolvedCommand(action, env);
  console.log(`\n▶ ${action.title}`);
  console.log(`  cwd: ${cwd}`);
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: {
      ...process.env,
      ...env,
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
    ...await persistentActions(repo),
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

if (require.main === module) {
  main().catch((error) => {
    console.error(`action picker: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  allocatePort, launchEnv, persistentCommand, persistentActions, repoContext,
  resolveHealth, resolvedCommand, run, startPersistent, stopPersistent, validateAction,
};
