#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readFile, realpath, lstat, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const help = "Usage: node scripts/deep-audit-optional.mjs --engine=siteone --url=https://your-owned-site.com --allow-host=your-owned-site.com [--max-pages=1..4] [--execute]. Set MCP_WEB_VALIDATOR_SITEONE_BIN to an installed native SiteOne executable when not on PATH.";

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
  if (engine !== "siteone") throw new Error(
    "Only independently verified SiteOne is supported; the unverified Unlighthouse adapter was removed. " + help);
  const site = safeHttpsSite(options.url);
  if (options.allowHost !== site.hostname) {
    throw new Error("Specify --allow-host with the exact owned website hostname");
  }
  const maxPages = options.maxPages === undefined ? 1 : Number(options.maxPages);
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 4) {
    throw new Error("Deep audit max pages must be 1..4");
  }
  if (options.paths !== undefined) {
    throw new Error("SiteOne does not accept explicit paths; use --max-pages only");
  }
  // Never write audit reports inside an installed npm package or npx cache.
  const directory = path.resolve(process.cwd(), ".mcp-validator", "optional-deep-audits", engine);
  const executable = process.env.MCP_WEB_VALIDATOR_SITEONE_BIN || "siteone-crawler";
  const args = [
        "--url=" + site.href,
        ...(maxPages === 1 ? ["--single-page"] : []),
        "--workers=1", "--max-reqs-per-sec=1", "--memory-limit=384M",
        "--max-visited-urls=" + maxPages, "--max-queue-length=16",
        "--max-skipped-urls=16", "--max-depth=1", "--timeout=6",
        "--no-cache", "--output=json", "--output-html-report=",
        "--output-text-file=",
        "--output-json-file=" + path.join(directory, "report.json"),
      ];
  return { engine, site: site.origin, maxPages,
    executable, args, directory, timeoutMs: 90_000 };
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

function isPublicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && c <= 2) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

async function siteoneExecutable(name) {
  if (!path.isAbsolute(name)) {
    if (name !== "siteone-crawler") throw new Error("Invalid SiteOne executable name");
    return name;
  }
  if (!["siteone-crawler", "siteone-crawler.exe"].includes(path.basename(name).toLowerCase())) {
    throw new Error("SiteOne executable must be the native siteone-crawler binary");
  }
  const info = await lstat(name);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid SiteOne executable file");
  return realpath(name);
}

async function executePlan(plan) {
  await mkdir(plan.directory, { recursive: true });
  const runDir = await mkdtemp(path.join(plan.directory, "run-"));
  const binary = await siteoneExecutable(plan.executable);
  const host = new URL(plan.site).hostname;
  const addresses = await lookup(host, { all: true });
  // Refuse known private DNS answers before invoking this separate crawler.
  // This is a preflight, not a guarantee against DNS rebinding or redirects.
  if (!addresses.length || addresses.some((item) => item.family === 4
    && !isPublicIPv4(item.address))) {
    throw new Error("SiteOne target resolves to a forbidden network address");
  }
  const permitted = addresses.find((item) => item.family === 4 && isPublicIPv4(item.address));
  if (!permitted) throw new Error("SiteOne requires a verified public IPv4 address");
  const args = plan.args.map((arg) => arg.startsWith("--output-json-file=")
    ? "--output-json-file=" + path.join(runDir, "report.json") : arg);
  // SiteOne 2.5.1 Windows --resolve rewrites valid public IPs to loopback
  // (observed twice as "no working URL"); do not use a broken DNS override.
  // As a result this cannot guarantee DNS pinning. Execute on owned sites only.
  // Do not forward credentials to third-party CLI processes.
  const keys = ["PATH", "Path", "SystemRoot", "ComSpec", "ProgramFiles", "ProgramFiles(x86)"];
  const env = {};
  for (const key of keys) if (process.env[key]) env[key] = process.env[key];
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TEMP", "TMP"]) env[key] = runDir;
  let diagnostics = "";
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: runDir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
      });
      for (const pipe of [child.stdout, child.stderr]) {
        pipe.on("data", (chunk) => {
          diagnostics = (diagnostics + String(chunk)).slice(-16_384);
        });
      }
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
  } catch (error) {
    // Keep bounded troubleshooting output in the private ignored workdir,
    // never interpolate site URLs/HTML into public MCP responses.
    await writeFile(path.join(runDir, "diagnostics.txt"), diagnostics.slice(-16_384));
    throw error;
  }
  const report = path.join(runDir, "report.json");
  const meta = await stat(report);
  if (!meta.isFile() || meta.size < 20 || meta.size > 2_000_000) {
    throw new Error("SiteOne completed without a bounded JSON audit report");
  }
  const audit = JSON.parse(await readFile(report, "utf8"));
  if (!audit || typeof audit !== "object" || Array.isArray(audit)
    || !Number.isSafeInteger(audit.stats?.totalUrls)
    || audit.stats.totalUrls < 1 || audit.stats.totalUrls > plan.maxPages
    || (Array.isArray(audit.error) && audit.error.length > 0)) {
    throw new Error("SiteOne returned an empty, partial or out-of-budget audit report");
  }
  return { runDir, reportBytes: meta.size, urlsCrawled: audit.stats.totalUrls };
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  if (opts.help) { console.log(help); return; }
  const plan = buildDeepAuditPlan(opts);
  if (!opts.execute) {
    console.log(JSON.stringify({ status: "dry_run", note:
      "No executable was launched. Execution performs public DNS preflight but cannot pin DNS; use only owned, trusted sites.",
      ...plan }, null, 2));
    return;
  }
  const finished = await executePlan(plan);
  console.log(JSON.stringify({ status: "completed", engine: plan.engine,
    maxPages: plan.maxPages, urlsCrawled: finished.urlsCrawled,
    reportBytes: finished.reportBytes,
    outputDirectory: finished.runDir }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Deep audit not completed: " + error.message);
    process.exitCode = 1;
  });
}
