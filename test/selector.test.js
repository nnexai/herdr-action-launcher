const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const {
  allocatePort, launchEnv, persistentCommand, repoContext, resolveHealth, resolvedCommand, validateAction,
} = require("../selector");
const { withStateLock } = require("../state");

const selector = path.resolve(__dirname, "../selector.js");
const plugin = path.resolve(__dirname, "../selector");

function child(argv, env) {
  return new Promise((resolve, reject) => {
    const subprocess = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    subprocess.stdout.on("data", (chunk) => { stdout += chunk; });
    subprocess.stderr.on("data", (chunk) => { stderr += chunk; });
    subprocess.once("error", reject);
    subprocess.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("launcher state and command contracts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "action-launcher-test-"));
  const previousState = process.env.HERDR_PLUGIN_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(root, "state");
  t.after(() => {
    if (previousState === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = previousState;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(checkout);

  await t.test("saved assignment stays stable while its listener is bound", async () => {
    const slot = `${checkout}:BOUND_PORT`;
    const port = await allocatePort(slot);
    const server = net.createServer();
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    try {
      assert.equal(await allocatePort(slot), port);
      const env = { ...process.env };
      const result = await child(["-e", `require(${JSON.stringify(plugin)}).allocatePort(process.argv[1]).then(console.log)`, slot], env);
      assert.equal(Number(success(result)), port);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  await t.test("canonical checkout roots share slots but linked worktrees do not", async () => {
    git(checkout, "init", "--quiet");
    git(checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "fixture");
    const worktree = path.join(root, "linked");
    git(checkout, "worktree", "add", "--quiet", "-b", "fixture-linked", worktree);
    const subdir = path.join(checkout, "nested");
    fs.mkdirSync(subdir);
    const alias = path.join(root, "alias");
    fs.symlinkSync(checkout, alias);
    const repo = repoContext({ workspace_cwd: subdir });
    const linked = repoContext({ workspace_cwd: worktree });
    assert.equal(repo.checkout, fs.realpathSync(checkout));
    assert.equal(repoContext({ workspace_cwd: alias }).checkout, repo.checkout);
    assert.notEqual(linked.checkout, repo.checkout);
    const action = { env: {}, ports: { PORT: "auto" } };
    assert.equal((await launchEnv(action, repo)).PORT, (await launchEnv(action, { checkout: alias })).PORT);
    assert.notEqual((await launchEnv(action, repo)).PORT, (await launchEnv(action, linked)).PORT);
  });

  await t.test("parallel subprocess slots preserve all assignments", async () => {
    const slots = Array.from({ length: 8 }, (_, index) => `${checkout}:PARALLEL_${index}`);
    const results = await Promise.all(slots.map((slot) => child([
      "-e", `require(${JSON.stringify(plugin)}).allocatePort(process.argv[1]).then(console.log)`, slot,
    ], { ...process.env })));
    const values = results.map((result) => Number(success(result)));
    assert.equal(new Set(values).size, slots.length);
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.HERDR_PLUGIN_STATE_DIR, "ports.json"), "utf8"));
    slots.forEach((slot, index) => assert.equal(saved[slot], values[index]));
  });

  await t.test("env and interpolated argv retain spaces and shell quotes", async () => {
    const value = `a space and 'single' and "double" $HOME; $(exit 90)`;
    const action = validateAction({
      id: "quotes", title: "Quotes", entrypoint: "exec",
      env: { MARKER: value, PORT: "overridden" }, ports: { PORT: 32123 },
      health: { url: "http://localhost:${PORT}/" },
      command: [process.execPath, "-e", "console.log(JSON.stringify({env:process.env.MARKER,args:process.argv.slice(1)}))", "${MARKER}", "${PORT}"],
    });
    const env = await launchEnv(action, { checkout });
    assert.deepEqual(resolveHealth(action, env), { url: "http://localhost:32123/" });
    const expected = { env: value, args: [value, "32123"] };
    const argv = resolvedCommand(action, env);
    const direct = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", env: { ...process.env, ...env } });
    assert.deepEqual(JSON.parse(success(direct)), expected);
    const persistent = spawnSync("sh", ["-c", persistentCommand(action, env)], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(success(persistent)), expected);
  });

  await t.test("malformed registry fails without resetting assignments", async () => {
    const file = path.join(process.env.HERDR_PLUGIN_STATE_DIR, "ports.json");
    const saved = fs.readFileSync(file, "utf8");
    try {
      for (const malformed of ["{broken", '{"saved":0}', "[]"]) {
        fs.writeFileSync(file, malformed);
        await assert.rejects(allocatePort(`${checkout}:INVALID`), /invalid/);
        assert.equal(fs.readFileSync(file, "utf8"), malformed);
      }
    } finally { fs.writeFileSync(file, saved); }
  });

  await t.test("auto allocation requires persistence; fixed ports do not", async () => {
    const directory = process.env.HERDR_PLUGIN_STATE_DIR;
    delete process.env.HERDR_PLUGIN_STATE_DIR;
    try {
      await assert.rejects(allocatePort(`${checkout}:NO_STATE`), /HERDR_PLUGIN_STATE_DIR/);
      assert.deepEqual(await launchEnv({ ports: { PORT: 32123 } }, { checkout }), { PORT: "32123" });
    } finally { process.env.HERDR_PLUGIN_STATE_DIR = directory; }
  });

  await t.test("lock release preserves an unexpected owner's token", async () => {
    const lock = path.join(process.env.HERDR_PLUGIN_STATE_DIR, ".state-lock");
    await withStateLock(() => {
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 1, token: "different-owner" }));
    });
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token, "different-owner");
    fs.rmSync(lock, { recursive: true });
  });

  await t.test("pane services split the invocation source without ambient pane env", async () => {
    const state = path.join(root, "pane-state");
    const config = path.join(root, "pane-config");
    fs.mkdirSync(state);
    fs.mkdirSync(config);
    const socket = path.join(root, "pane.sock");
    fs.writeFileSync(socket, "fixture pathname, not a live socket");
    const herdr = path.join(root, "pane-herdr");
    fs.copyFileSync(path.join(__dirname, "fixtures/herdr-cli"), herdr);
    fs.chmodSync(herdr, 0o700);
    const action = {
      id: "pane-service", title: "Pane service", mode: "pane", entrypoint: "exec",
      command: ["echo", "${MARKER}", "${PORT}"], env: { MARKER: "source 'pane' value" },
      ports: { PORT: "auto" }, health: { port: "PORT" },
    };
    fs.writeFileSync(path.join(config, "actions.json"), JSON.stringify({ actions: [action] }));
    const source = { pane_id: "source-pane", workspace_id: "source-workspace" };
    const unrelated = { pane_id: "unrelated-pane", workspace_id: "other-workspace" };
    const fakeFile = path.join(state, "fake-herdr.json");
    const initial = { next: 1, panes: [source, unrelated], tabs: [], commands: [] };
    fs.writeFileSync(fakeFile, JSON.stringify(initial));
    const foreign = { key: `${checkout}:${action.id}`, session: "foreign", socketPath: "/foreign/socket", paneId: "unrelated-pane", checkout, repoRoot: checkout };
    const registry = path.join(state, "persistent-panes.json");
    fs.writeFileSync(registry, JSON.stringify([foreign]));
    const context = { workspace_cwd: checkout, workspace_id: source.workspace_id, focused_pane_id: source.pane_id };
    const env = {
      ...process.env, HERDR_BIN_PATH: herdr, HERDR_PLUGIN_STATE_DIR: state,
      HERDR_PLUGIN_CONFIG_DIR: config, HERDR_SOCKET_PATH: socket,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
    };
    delete env.HERDR_PANE_ID;
    const missing = await child([selector, "--run", action.id], {
      ...env, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ ...context, focused_pane_id: undefined }),
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /source pane id/);
    assert.deepEqual(JSON.parse(fs.readFileSync(fakeFile, "utf8")), initial);
    assert.deepEqual(JSON.parse(fs.readFileSync(registry, "utf8")), [foreign]);
    assert.ok(!fs.existsSync(path.join(state, "ports.json")));
    const mismatched = await child([selector, "--run", action.id], {
      ...env, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ ...context, focused_pane_id: unrelated.pane_id }),
    });
    assert.equal(mismatched.status, 1);
    assert.match(mismatched.stderr, /source pane does not belong/);
    assert.deepEqual(JSON.parse(fs.readFileSync(fakeFile, "utf8")), initial);
    assert.deepEqual(JSON.parse(fs.readFileSync(registry, "utf8")), [foreign]);
    assert.ok(!fs.existsSync(path.join(state, "ports.json")));

    success(await child([selector, "--run", action.id], env));
    const fake = JSON.parse(fs.readFileSync(fakeFile, "utf8"));
    assert.deepEqual(fake.panes.slice(0, 2), [source, unrelated]);
    assert.equal(fake.splits.length, 1);
    assert.deepEqual(fake.splits[0].slice(0, 4), ["pane", "split", "--pane", source.pane_id]);
    const saved = JSON.parse(fs.readFileSync(registry, "utf8"));
    assert.deepEqual(saved[0], foreign);
    assert.equal(saved.length, 2);
    const service = saved[1];
    assert.equal(service.paneId, fake.panes[2].pane_id);
    assert.equal(service.kind, "pane");
    assert.equal(service.session, "fixture");
    assert.equal(service.socketPath, fs.realpathSync(socket));
    assert.equal(service.checkout, checkout);
    assert.equal(service.repoRoot, checkout);
    assert.equal(service.workspace, checkout);
    assert.ok(!("tabId" in service));
    const ports = JSON.parse(fs.readFileSync(path.join(state, "ports.json"), "utf8"));
    assert.deepEqual(service.health, { port: ports[`${checkout}:PORT`] });
    assert.equal(fake.commands[0], persistentCommand(validateAction(action), {
      MARKER: action.env.MARKER, PORT: String(service.health.port),
    }));
    const listing = success(await child([selector, "--list"], env));
    assert.match(listing, /Stop: Pane service/);
    assert.deepEqual(JSON.parse(fs.readFileSync(registry, "utf8")), saved);
    const previousPane = process.env.HERDR_PANE_ID;
    process.env.HERDR_PANE_ID = "ambient-pane";
    try {
      assert.equal(repoContext(context).paneId, source.pane_id);
      assert.equal(repoContext({ workspace_cwd: checkout }).paneId, "ambient-pane");
    } finally {
      if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = previousPane;
    }
  });

  await t.test("concurrent services retain rows and exact session provenance", async () => {
    const state = path.join(root, "services-state");
    const config = path.join(root, "config");
    fs.mkdirSync(state);
    fs.mkdirSync(config);
    const socket = path.join(root, "fixture.sock");
    fs.writeFileSync(socket, "fixture pathname, not a live socket");
    const socketAlias = path.join(root, "socket-alias");
    fs.symlinkSync(socket, socketAlias);
    const herdr = path.join(root, "fake-herdr");
    fs.copyFileSync(path.join(__dirname, "fixtures/herdr-cli"), herdr);
    fs.chmodSync(herdr, 0o700);
    const actions = ["first", "second"].map((id) => ({
      id, title: id, mode: "tab", command: ["echo", "${MARKER}", "${PORT}"],
      env: { MARKER: "service 'value' with spaces" }, ports: { PORT: "auto" }, health: { port: "PORT" },
    }));
    fs.writeFileSync(path.join(config, "actions.json"), JSON.stringify({ actions }));
    const foreign = { key: `${checkout}:first`, session: "foreign", socketPath: "/foreign/socket", paneId: "pane-2", tabId: "tab-1", checkout, repoRoot: checkout };
    const legacy = { key: `${checkout}:second`, paneId: "legacy", checkout, repoRoot: checkout };
    const registry = path.join(state, "persistent-panes.json");
    fs.writeFileSync(registry, JSON.stringify([foreign, legacy]));
    const env = {
      ...process.env, HERDR_BIN_PATH: herdr, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: config,
      HERDR_SOCKET_PATH: socketAlias, HERDR_SESSION: "wrong-inherited-session", HERDR_SESSION_NAME: "also-wrong",
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: checkout, workspace_id: "workspace-fixture" }),
    };
    const results = await Promise.all(["first", "second", "first"].map((id) => child([selector, "--run", id], env)));
    assert.deepEqual(results.map((result) => result.status).sort(), [0, 0, 1], JSON.stringify(results));
    assert.match(results.find((result) => result.status === 1).stderr, /already running/);
    const saved = JSON.parse(fs.readFileSync(registry, "utf8"));
    assert.equal(saved.length, 4);
    assert.deepEqual(saved[0], foreign);
    assert.deepEqual(saved[1], legacy);
    const services = saved.filter((entry) => entry.session === "fixture");
    assert.equal(services.length, 2);
    services.forEach((entry) => {
      assert.equal(entry.socketPath, fs.realpathSync(socket));
      assert.equal(typeof entry.health.port, "number");
      assert.equal(entry.health.port, services[0].health.port);
      assert.ok(entry.paneId && entry.tabId);
    });
    const duplicate = await child([selector, "--run", "first"], env);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already running/);
    assert.deepEqual(JSON.parse(fs.readFileSync(registry, "utf8")), saved);

    const fakeFile = path.join(state, "fake-herdr.json");
    const fake = JSON.parse(fs.readFileSync(fakeFile, "utf8"));
    const closed = services[0];
    fake.panes = fake.panes.filter((pane) => pane.pane_id !== closed.paneId);
    fake.tabs = fake.tabs.filter((tab) => tab.tab_id !== closed.tabId);
    fs.writeFileSync(fakeFile, JSON.stringify(fake));
    success(await child([selector, "--list"], env));
    const pruned = JSON.parse(fs.readFileSync(registry, "utf8"));
    assert.equal(pruned.length, 3);
    assert.deepEqual(pruned.slice(0, 2), [foreign, legacy]);
    assert.ok(!pruned.some((entry) => entry.session === "fixture" && entry.key === closed.key));
  });
});
