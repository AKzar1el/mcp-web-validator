import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const MAX_AUDIT_HISTORY = 10;
export const MAX_AUDIT_SNAPSHOT_BYTES = 60_000;
const MAX_HISTORY_FILE_BYTES = 660_000;
const HISTORY_DIRECTORY = ".mcp-validator";
const HISTORY_FILE = "audit-history.json";

const publicUrl = z.string().max(2_048).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && Boolean(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash
      && !url.port;
  } catch {
    return false;
  }
}, "Only query-free, credential-free public HTTP(S) URLs may be saved.");

const count = z.number().int().nonnegative();
const severity = z.enum(["error", "warning", "info"]);
const category = z.enum(["HTML", "SEO", "Schema", "Accessibility"]);
const finding = z.object({
  code: z.string().max(120).optional(),
  severity,
  category,
  message: z.string().max(300),
});
const page = z.object({
  url: publicUrl,
  fetched_url: publicUrl.optional(),
  status: z.enum(["passed", "needs_attention", "partial", "failed", "skipped"]),
  http_status: z.number().int().min(200).max(299).optional(),
  redirects_followed: z.number().int().min(0).max(3).optional(),
  page_fetched: z.boolean(),
  html_validation_status: z.enum(["completed", "timeout", "unavailable", "not_run"]),
  html_errors: count,
  html_warnings: count,
  seo_errors: count,
  seo_warnings: count,
  schema_errors: count,
  schema_warnings: count,
  notes: count,
  health_score: z.number().int().min(0).max(100).optional(),
  failure_code: z.string().max(120).optional(),
  top_findings: z.array(finding).max(3),
});
const issueGroup = finding.extend({
  affected_pages: count,
  example_urls: z.array(publicUrl).max(3),
});

/**
 * Keep only the fields used by compare_site_audits.
 * Rich page signals, raw HTML, widget state and unrelated user-supplied fields
 * are deliberately not persisted; the hosted app remains completely stateless.
 */
export const compactAuditSnapshotSchema = z.object({
  site_url: publicUrl,
  sitemap_url: publicUrl.optional(),
  discovery: z.enum(["sitemap", "root_only", "partial"]),
  discovery_error: z.enum(["robots_unavailable", "sitemap_unavailable", "sitemap_invalid", "sitemap_query_unsupported"]).optional(),
  pages_discovered: count,
  pages_selected: count,
  pages_audited: count,
  pages_partial: count,
  pages_failed: count,
  pages_skipped_robots: count,
  truncated: z.boolean(),
  next_page_offset: count.optional(),
  discovery_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  audit_health_score: z.number().int().min(0).max(100).optional(),
  score_coverage_percent: z.number().int().min(0).max(100),
  pages: z.array(page).max(8),
  issue_groups: z.array(issueGroup).max(50),
  issue_groups_truncated: z.boolean(),
});

export type CompactAuditSnapshot = z.infer<typeof compactAuditSnapshotSchema>;

export interface AuditHistoryItem {
  id: string;
  saved_at: string;
  site_url: string;
}

interface PersistedItem extends AuditHistoryItem {
  snapshot: CompactAuditSnapshot;
}

const historySchema = z.object({
  version: z.literal(1),
  items: z.array(z.object({
    id: z.string().uuid(),
    saved_at: z.string().datetime({ offset: true }),
    site_url: publicUrl,
    snapshot: compactAuditSnapshotSchema,
  })).max(MAX_AUDIT_HISTORY),
});

export interface AuditHistoryResponse {
  count: number;
  items: AuditHistoryItem[];
  snapshot_json?: string;
  evicted_id?: string;
}

const basePath = (): string => {
  const configured = process.env.MCP_WEB_VALIDATOR_WORKSPACE_ROOT;
  if (configured === undefined) return os.homedir();
  if (!path.isAbsolute(configured)) {
    throw new Error("MCP_WEB_VALIDATOR_WORKSPACE_ROOT must be an absolute directory path.");
  }
  return configured;
};

async function historyFile(rootDirectory: string, create: boolean): Promise<string> {
  const root = await fs.realpath(rootDirectory);
  const dir = path.join(root, HISTORY_DIRECTORY);
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const entry = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => {
    if (!create && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!entry) return path.join(dir, HISTORY_FILE);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("The audit history directory must be a real directory, not a symbolic link.");
  }
  const realDir = await fs.realpath(dir);
  if (path.dirname(realDir) !== root) {
    throw new Error("Audit history directory must stay inside the configured root.");
  }
  return path.join(realDir, HISTORY_FILE);
}

async function readHistory(rootDirectory: string): Promise<PersistedItem[]> {
  const file = await historyFile(rootDirectory, false);
  const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_HISTORY_FILE_BYTES) {
    throw new Error("History must be a bounded regular file, not a link or oversized file.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw new Error("Audit history is unreadable or corrupt; no stored versions were modified.");
  }
  const result = historySchema.safeParse(parsed);
  if (!result.success) throw new Error("Audit history is invalid; no stored versions were modified.");
  return result.data.items;
}

async function writeHistory(rootDirectory: string, items: PersistedItem[]): Promise<void> {
  const file = await historyFile(rootDirectory, true);
  const contents = JSON.stringify({ version: 1, items });
  if (Buffer.byteLength(contents, "utf8") > MAX_HISTORY_FILE_BYTES) {
    throw new Error("The audit history file would exceed the configured size cap.");
  }
  const tmp = path.join(path.dirname(file), `.${HISTORY_FILE}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, file);
  } finally {
    if (handle) await handle.close();
    await fs.rm(tmp, { force: true });
  }
}

function summary(items: PersistedItem[]): AuditHistoryResponse {
  return {
    count: items.length,
    items: items.slice().reverse().map(({ id, saved_at, site_url }) => ({ id, saved_at, site_url })),
  };
}

// The stdio MCP server normally has one process. Serialize saves in-process
// so simultaneous client calls cannot overwrite one another's latest version.
let pendingSave: Promise<unknown> = Promise.resolve();

export function parseCompactAuditSnapshot(snapshotJson: string): CompactAuditSnapshot {
  if (Buffer.byteLength(snapshotJson, "utf8") > MAX_AUDIT_SNAPSHOT_BYTES) {
    throw new Error("Audit snapshot exceeds the 60 KB input limit.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(snapshotJson);
  } catch {
    throw new Error("Audit snapshot must be valid JSON.");
  }
  const parsed = compactAuditSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error("Audit snapshot must be a valid bounded audit_public_site structured result without secret-bearing URLs.");
  }
  const compact = JSON.stringify(parsed.data);
  if (Buffer.byteLength(compact, "utf8") > MAX_AUDIT_SNAPSHOT_BYTES) {
    throw new Error("Compact audit snapshot exceeds the 60 KB storage limit.");
  }
  return parsed.data;
}

export async function listAuditHistory(rootDirectory = basePath()): Promise<AuditHistoryResponse> {
  return summary(await readHistory(rootDirectory));
}

export async function getAuditHistorySnapshot(
  id: string,
  rootDirectory = basePath(),
): Promise<AuditHistoryResponse> {
  const items = await readHistory(rootDirectory);
  const found = items.find((item) => item.id === id);
  if (!found) throw new Error("The requested audit history version was not found.");
  return { ...summary(items), snapshot_json: JSON.stringify(found.snapshot) };
}

/**
 * P2-01: read selected immutable saved versions in *stored* chronological
 * order. A single guarded history read; no writes, ID discovery or archive
 * mutation. Reject evicted versions rather than silently substituting them.
 */
export async function getAuditHistoryVersions(
  ids: string[],
  rootDirectory = basePath(),
): Promise<Array<{ saved_at: string; snapshot: CompactAuditSnapshot }>> {
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > MAX_AUDIT_HISTORY
    || new Set(ids).size !== ids.length
    || ids.some((id) => !z.string().uuid().safeParse(id).success)) {
    throw new Error("Supply two to ten distinct saved audit version IDs, oldest first.");
  }
  const history = await readHistory(rootDirectory);
  const byId = new Map(history.map((item, index) => [item.id, { item, index }]));
  let previousIndex = -1;
  const result: Array<{ saved_at: string; snapshot: CompactAuditSnapshot }> = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) throw new Error("A requested saved audit history version was not found or was evicted.");
    if (entry.index <= previousIndex) {
      throw new Error("Saved audit version IDs must be ordered oldest to newest.");
    }
    previousIndex = entry.index;
    result.push({ saved_at: entry.item.saved_at, snapshot: entry.item.snapshot });
  }
  return result;
}

export function saveAuditHistorySnapshot(
  snapshotJson: string,
  rootDirectory = basePath(),
): Promise<AuditHistoryResponse> {
  const snapshot = parseCompactAuditSnapshot(snapshotJson);
  const action = async (): Promise<AuditHistoryResponse> => {
    const items = await readHistory(rootDirectory);
    const newItem: PersistedItem = {
      id: randomUUID(),
      saved_at: new Date().toISOString(),
      site_url: snapshot.site_url,
      snapshot,
    };
    const next = [...items, newItem];
    const evicted = next.length > MAX_AUDIT_HISTORY ? next.shift() : undefined;
    await writeHistory(rootDirectory, next);
    return {
      ...summary(next),
      ...(evicted ? { evicted_id: evicted.id } : {}),
    };
  };
  const request = pendingSave.then(action, action);
  pendingSave = request.catch(() => undefined);
  return request;
}
