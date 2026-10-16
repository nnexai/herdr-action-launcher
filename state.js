const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

function stateDirectory() {
  const directory = process.env.HERDR_PLUGIN_STATE_DIR;
  if (!directory) throw new Error("HERDR_PLUGIN_STATE_DIR is required for persistent state");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return fs.realpathSync(directory);
}

function readState(name, fallback, valid) {
  const file = path.join(stateDirectory(), name);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid ${file}: ${error.message}`);
  }
  if (!valid(value)) throw new Error(`invalid state in ${file}`);
  return value;
}

function writeState(name, value) {
  const directory = stateDirectory();
  const file = path.join(directory, name);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
    const directoryDescriptor = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

// One lock covers both registries. Never steal a lock: a dead owner requires
// explicit recovery rather than risking a second writer during a slow launch.
async function withStateLock(operation) {
  const lock = path.join(stateDirectory(), ".state-lock");
  const ownerFile = path.join(lock, "owner.json");
  const owner = JSON.stringify({ pid: process.pid, token: crypto.randomUUID() });
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for plugin state lock ${lock}; inspect its owner before recovery`);
      await delay(25);
    }
  }
  try {
    fs.writeFileSync(ownerFile, owner, { flag: "wx", mode: 0o600 });
  } catch (error) {
    fs.rmdirSync(lock);
    throw error;
  }
  try {
    return await operation();
  } finally {
    if (fs.readFileSync(ownerFile, "utf8") === owner) {
      fs.unlinkSync(ownerFile);
      fs.rmdirSync(lock);
    }
  }
}

module.exports = { readState, writeState, withStateLock };
