#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const help = "Usage: node scripts/deep-audit-optional.mjs --engine=siteone|unlighthouse --url=https://your-site.example --allow-host=your-site.example [--max-pages=1..4] [--paths=/,/about] [--execute]";

function safeHttpsSite(value) {
  if (typeof value !== "string" || value.length > 256) throw new Error("Supply a short HTTPS URL");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid HTTPS URL"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password
    || url.port || url.search || url.hash || url.pathname !== "/"
    || !/^[a-z0-9.-]+$/.test(host) || isIP(host)
    || !host.includes(".") || host.endsWith(".")
    || /(?:^localhost$|\.localhost$|\.local$|\.internal$|\.test$|\.invalid$|\.example$|\.onion$|\.home\.arpa$)/.test(host)) {
    throw new Error("Deep audit requires an explicitly authorized public HTTPS origin without credentials");
  }
  return url;
}

export function buildDeepAuditPlan(options) {
  const engine = options.engine;
  if (!["siteone", "unlighthouse"].includes(engine)) throw new Error(help);
  const site = safeHttpsSite(options.url);
  if (options.allowHost !== site.hostname) {
    throw new Error("Specify --allow-host with the exact owned website hostname");
  }
  const maxPages = options.maxPages === undefined ? 1 : Number(options.maxPages);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 4) {
    throw new Error("Deep audit max pages must be 1..4");
  }
  const paths = options.paths === undefined ? ["/"] : String(options.paths).split(",");
  if (!paths.length || paths.length > maxPages || new Set(paths).size !== paths.length
    || paths.some((s) => !/^\/(?:[a-zA-Z0-9_~!$&'()+,;=:@%/-]{0,150})$/.test(s)
      || s.includes("//") || s.includes("..") || /%(?:2f|5c|2e)/i.test(s))) {
    throw new Error("Supply 1..maxPages explicit, relative, query-free URL paths");
  }
  const directory = path.join(projectRoot, ".mcp-validator", "optional-deep-audits", engine);
  const executable = engine === "siteone" ? "siteone-crawler" : "unlighthouse-ci";
  // No auto-downloading or installing heavyweight packages on this 8 GB host.
  const args = engine === "siteone"
    ? [
        "--url=" + site.href,
        ...(maxPages === 1 ? ["--single-page"] : []),
        "--workers=1", "--max-reqs-per-sec=1", "--memory-limit=384M",
        "--max-visited-urls=" + maxPages, "--max-queue-length=16",
        "--max-skipped-urls=16", "--max-depth=1", "--timeout=6",
        "--no-cache", "--output=json", "--output-html-report=",
        "--output-text-file=",
        "--output-json-file=" + path.join(directory, "report.json"),
      ]
    : [
        "--site", site.href, "--urls", paths.join(","),
        "--mobile", "--samples", "1",
        "--output-path", directory,
      ];
  return { engine, site: site.origin, maxPages, paths,
    executable, args, directory, timeoutMs: engine === "siteone" ? 90_000 : 180_000 };
}

function parseOptions(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument === "--execute") { options.execute = true; continue; }
    if (argument === "--help") { options.help = true; continue; }
    const pair = /^--(engine|url|allow-host|max-pages|paths)=(.+)$/.exec(argument);
    if (!pair) throw new Error("Unknown deep audit argument");
    const names = { engine: "engine", url: "url", "allow-host": "allowHost",
      "max-pages": "maxPages", paths: "paths" };
    if (Object.hasOwn(options, names[pair[1]])) throw new Error("Duplicate audit argument");
    options[names[pair[1]]] = pair[2];
  }
  return options;
}

async function executePlan(plan) {
  await mkdir(plan.directory, { recursive: true });
  // Do not forward credentials to third-party CLI processes.
  const keys = ["PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "TEMP", "TMP", "SystemRoot", "ComSpec", "ProgramFiles", "ProgramFiles(x86)"];
  const env = {};
  for (const key of keys) if (process.env[key]) env[key] = process.env[key];
  await new Promise((resolve, reject) => {
    const child = spawn(plan.executable, plan.args, {
      cwd: projectRoot, env, stdio: "ignore", windowsHide: true, shell: false,
    });
    const timeout = setTimeout(() => child.kill(), plan.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error.code === "ENOENT"
        ? new Error("Optional " + plan.executable + " is not installed on PATH") : error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(plan.engine + " exited unsuccessfully (code "
        + String(code) + ", signal " + String(signal) + ")"));
    });
  });
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  if (opts.help) { console.log(help); return; }
  const plan = buildDeepAuditPlan(opts);
  if (!opts.execute) {
    console.log(JSON.stringify({ status: "dry_run", note:
      "No executable was launched. Third-party crawlers run only after --execute; DNS/network safety is enforced by their own engine.",
      ...plan }, null, 2));
    return;
  }
  await executePlan(plan);
  console.log(JSON.stringify({ status: "completed", engine: plan.engine,
    maxPages: plan.maxPages, outputDirectory: plan.directory }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Deep audit not completed: " + error.message);
    process.exitCode = 1;
  });
}
