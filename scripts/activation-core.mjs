import { spawn } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_ORIGIN = "https://github.com/AKzar1el/mcp-web-validator.git";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MARKER = ".mcp-web-validator-activated.json";

export function defaultActivationHome() {
  return process.env.MCP_WEB_VALIDATOR_ACTIVATION_HOME
    ? path.resolve(process.env.MCP_WEB_VALIDATOR_ACTIVATION_HOME)
    : path.join(os.homedir(), ".cache", "mcp-web-validator-activation");
}

export async function runCommand(command, args, { cwd, timeoutMs = 60_000, env = process.env } = {}) {
  const npmOnWindows = process.platform === "win32" && command === "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, windowsHide: true, shell: npmOnWindows, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let error = "";
    const maxChars = 16_384;
    const append = (current, buffer) => (current + buffer.toString("utf8")).slice(-maxChars);
    child.stdout.on("data", (data) => { output = append(output, data); });
    child.stderr.on("data", (data) => { error = append(error, data); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (exitCode === 0) return resolve(output.trim());
      reject(new Error(`${command} ${args[0] ?? ""} failed (${signal || exitCode}): ${error || output}`));
    });
  });
}

function revisionDir(home, sha) {
  if (!SHA_PATTERN.test(sha)) throw new Error("Invalid upstream commit identifier.");
  return path.join(home, "revisions", sha);
}

async function validatedRevision(home, sha) {
  if (!SHA_PATTERN.test(sha || "")) return null;
  const root = revisionDir(home, sha);
  try {
    if ((await lstat(root)).isSymbolicLink()) return null;
    const info = JSON.parse(await readFile(path.join(root, MARKER), "utf8"));
    if (info.sha !== sha || info.schema !== 1) return null;
    const entry = path.join(root, "dist", "index.js");
    await access(entry);
    const canonicalRoot = await realpath(root);
    const canonicalEntry = await realpath(entry);
    if (!canonicalEntry.startsWith(canonicalRoot + path.sep)) return null;
    return entry;
  } catch {
    return null;
  }
}

async function currentRevision(home) {
  try {
    const state = JSON.parse(await readFile(path.join(home, "active.json"), "utf8"));
    const entry = await validatedRevision(home, state.sha);
    return entry ? { entry, sha: state.sha, source: "cached" } : null;
  } catch {
    return null;
  }
}

async function publishState(home, sha) {
  const temp = path.join(home, `active.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify({ schema: 1, sha })}\n`, { flag: "wx" });
    await rename(temp, path.join(home, "active.json"));
  } finally {
    await rm(temp, { force: true });
  }
}

async function installer(checkout) {
  const packageJson = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
  if (packageJson.name !== "mcp-web-validator") throw new Error("Unexpected package identity.");
  const env = { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "true", npm_config_update_notifier: "false" };
  await runCommand("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: checkout, env, timeoutMs: 180_000,
  });
  await runCommand("npm", ["run", "build"], { cwd: checkout, env, timeoutMs: 90_000 });
  await runCommand(process.execPath, ["scripts/smoke-activation.mjs"], {
    cwd: checkout, env, timeoutMs: 120_000,
  });
}

async function checkoutRevision(home, origin, sha, install, log) {
  const existing = await validatedRevision(home, sha);
  if (existing) return existing;

  const staging = await mkdtemp(path.join(home, ".staging-"));
  const checkout = path.join(staging, "source");
  try {
    await runCommand("git", ["clone", "--depth", "1", "--single-branch", "--branch", "main", origin, checkout], {
      timeoutMs: 90_000,
    });
    const actualSha = await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout, timeoutMs: 10_000 });
    if (actualSha !== sha) throw new Error("main changed during fetch; retry on the next activation.");
    await install(checkout);
    await access(path.join(checkout, "dist", "index.js"));
    await writeFile(path.join(checkout, MARKER), `${JSON.stringify({ schema: 1, sha })}\n`, { flag: "wx" });
    const destination = revisionDir(home, sha);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(checkout, destination);
    log(`Prepared and verified upstream main ${sha.slice(0, 12)}.`);
    return path.join(destination, "dist", "index.js");
  } finally {
    // Only remove the unique staging directory created by mkdtemp, never a worktree.
    if (path.dirname(staging) !== path.resolve(home) || !path.basename(staging).startsWith(".staging-")) {
      throw new Error("Staging cleanup refused an unexpected path.");
    }
    if (!(await lstat(staging)).isSymbolicLink()) await rm(staging, { recursive: true, force: true });
  }
}

export async function selectActivation({
  home = defaultActivationHome(),
  origin = DEFAULT_ORIGIN,
  fallback,
  install = installer,
  log = (line) => console.error(`[web-validator activation] ${line}`),
  offline = process.env.MCP_WEB_VALIDATOR_UPDATE_POLICY === "offline",
} = {}) {
  home = path.resolve(home);
  const fallbackEntry = async () => {
    const last = await currentRevision(home);
    if (last) return last;
    if (fallback) {
      try {
        await access(fallback);
        return { entry: fallback, sha: null, source: "local-fallback" };
      } catch { /* No safe existing fallback. */ }
    }
    throw new Error("No previously verified or local MCP build is available.");
  };
  if (offline) return fallbackEntry();
  await mkdir(home, { recursive: true });
  const lock = path.join(home, ".activation-lock");
  try {
    await mkdir(lock);
  } catch (cause) {
    if (cause.code !== "EEXIST") throw cause;
    log("Another activation owns the update lock; starting the last verified build.");
    return fallbackEntry();
  }
  try {
    const ref = await runCommand("git", ["ls-remote", "--heads", origin, "main"], { timeoutMs: 20_000 });
    const match = /^([0-9a-f]{40})\s+refs\/heads\/main$/m.exec(ref);
    if (!match) throw new Error("Upstream main did not return a valid commit.");
    const sha = match[1];
    const last = await currentRevision(home);
    if (last?.sha === sha) return last;
    const entry = await checkoutRevision(home, origin, sha, install, log);
    await publishState(home, sha);
    return { entry, sha, source: "upstream-main" };
  } catch (cause) {
    log(`Update unavailable: ${cause.message}. Keeping last known-good build.`);
    return fallbackEntry();
  } finally {
    // We own the lock because only the successful mkdir above reaches this block.
    await rmdir(lock);
  }
}
