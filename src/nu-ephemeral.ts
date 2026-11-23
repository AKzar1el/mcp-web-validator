import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** One local Nu instance, on demand only. Never starts a background daemon. */
let busy = false;
// Java 25 cold startup on Windows with Defender/contended storage took >20s
// in a concurrent real-engine suite. This remains bounded, on-demand only.
const STARTUP_DEADLINE_MS = 40_000;

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback port");
    return address.port;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

async function trustedJavaExecutable(configured: string): Promise<string> {
  if (!path.isAbsolute(configured)
    || !["java.exe", "java"].includes(path.basename(configured).toLowerCase())) {
    throw new Error("Local Nu Java path must point to an absolute java executable");
  }
  const information = await lstat(configured);
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error("Local Nu Java path must be a regular executable");
  }
  return realpath(configured);
}

/** Executes Java 17+ Nu in private ephemeral Jetty bound to literal loopback. */
export async function withEphemeralNuChecker<T>(
  javaExecutable: string,
  action: (localUrl: string) => Promise<T>,
): Promise<T> {
  if (busy) throw new Error("Local Nu Checker is already running; retry checks serially");
  busy = true;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const javaPath = await trustedJavaExecutable(javaExecutable);
    const port = await availableLoopbackPort();
    // Do not forward credentials, proxies or user-controlled Java options.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "PATH", "Path", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    child = spawn(javaPath, [
      "-Xmx256m",
      "-Djava.awt.headless=true",
      "-Dnu.validator.servlet.bind-address=127.0.0.1",
      "-Dnu.validator.servlet.allow-forbidden-hosts=false",
      "-m", "vnu/nu.validator.servlet.Main", String(port),
    ], { shell: false, windowsHide: true, stdio: "ignore", env });
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    const url = "http://127.0.0.1:" + port + "/?out=json";
    const deadline = Date.now() + STARTUP_DEADLINE_MS;
    let ready = false;
    let lastStatus = "not-attempted";
    while (Date.now() < deadline) {
      if (spawnError) throw new Error("Nu Java process did not start");
      if (child.exitCode !== null) throw new Error("Nu Java process exited before readiness");
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/html; charset=utf-8" },
          body: "<!doctype html><html lang=\"en\"><title>Nu readiness</title></html>",
          redirect: "error",
          signal: AbortSignal.timeout(1_000),
        });
        await response.body?.cancel();
        lastStatus = String(response.status);
        if (response.ok) { ready = true; break; }
      } catch (cause) {
        lastStatus = cause instanceof Error ? cause.name : "unknown";
      }
      await delay(250);
    }
    if (!ready) {
      throw new Error("Nu Java process did not become ready within 40 seconds (HTTP " + lastStatus + ")");
    }
    return await action(url);
  } finally {
    if (child) {
      if (child.exitCode === null) child.kill();
      if (child.exitCode === null) {
        await new Promise<void>((resolve) => {
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            resolve();
          };
          child!.once("exit", finish);
          const timeout = setTimeout(() => {
            if (child!.exitCode === null) child!.kill("SIGKILL");
            finish();
          }, 1_500);
          timeout.unref();
        });
      }
    }
    busy = false;
  }
}
