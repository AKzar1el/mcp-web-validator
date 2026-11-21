#!/usr/bin/env node
// Optional Codexify stdio launcher. Logs/update output must never enter MCP stdout.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectActivation } from "./activation-core.mjs";

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fallback = path.join(checkout, "dist", "index.js");

try {
  const selected = await selectActivation({ fallback });
  console.error(`[web-validator activation] Launching ${selected.source}${selected.sha ? ` (${selected.sha.slice(0, 12)})` : ""}.`);
  const server = spawn(process.execPath, [selected.entry], {
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!server.killed) server.kill(signal);
    });
  }
  server.once("error", (error) => {
    console.error(`[web-validator activation] MCP server launch failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  console.error(`[web-validator activation] Unable to start MCP: ${error.message}`);
  process.exitCode = 1;
}
