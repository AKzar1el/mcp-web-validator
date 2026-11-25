/**
 * V02 local opt-in availability history. Separate from site-audit snapshots:
 * stores only ten compact HTTP outcome observations; hosted Worker stays
 * stateless. Uses the same guarded .mcp-validator directory convention.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AVAILABILITY_FAILURE_CODES,
  validateAvailabilityObservation,
  type AvailabilityObservation,
} from "../http-crawl/availability-observations.js";
import { safeHttpResourceUrl } from "../http-crawl/non-html-directives.js";

export const MAX_AVAILABILITY_HISTORY = 10;
export const MAX_AVAILABILITY_HISTORY_FILE_BYTES = 24_000;
const SUBDIRECTORY = ".mcp-validator";
const FILENAME = "availability-history.json";

const observationSchema = z.object({
  observed_at: z.string().max(40),
  status_code: z.number().int().min(100).max(599).optional(),
  failure: z.enum(AVAILABILITY_FAILURE_CODES).optional(),
  cf_challenge: z.boolean().optional(),
  elapsed_ms: z.number().int().min(0).max(120_000).optional(),
}).strict();
const storedRecordSchema = z.object({
  id: z.string().uuid(),
  saved_at: z.string().datetime({ offset: true }),
  url: z.string().max(512),
  observation: observationSchema,
}).strict();
const persistedSchema = z.object({
  version: z.literal(1),
  items: z.array(storedRecordSchema).max(MAX_AVAILABILITY_HISTORY),
}).strict();

type PersistedRecord = z.infer<typeof storedRecordSchema>;
export interface AvailabilitySavedRecord {
  id: string;
  saved_at: string;
  observation: AvailabilityObservation;
}
export interface AvailabilityStoreResponse {
  count: number;
  records: AvailabilitySavedRecord[];
  saved_id?: string;
  evicted_id?: string;
}

function rootDirectory(): string {
  const configured = process.env.MCP_WEB_VALIDATOR_WORKSPACE_ROOT;
  if (configured === undefined) return os.homedir();
  if (!path.isAbsolute(configured)) throw new Error("Workspace root must be an absolute path.");
  return configured;
}

async function historyPath(root: string, create: boolean): Promise<string> {
  const resolvedRoot = await fs.realpath(root);
  const dir = path.join(resolvedRoot, SUBDIRECTORY);
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const entry = await fs.lstat(dir).catch((cause: NodeJS.ErrnoException) => {
    if (!create && cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (!entry) return path.join(dir, FILENAME);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Availability history directory must be a real directory.");
  }
  const actualDir = await fs.realpath(dir);
  if (path.dirname(actualDir) !== resolvedRoot) {
    throw new Error("Availability history must remain inside its configured workspace root.");
  }
  return path.join(actualDir, FILENAME);
}

async function readHistory(root: string): Promise<PersistedRecord[]> {
  const file = await historyPath(root, false);
  const info = await fs.lstat(file).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    info.size > MAX_AVAILABILITY_HISTORY_FILE_BYTES) {
    throw new Error("Availability history must be a bounded regular file, not a link.");
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw new Error("Availability history is unreadable; nothing was changed.");
  }
  const parsed = persistedSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error("Availability history has invalid fields; nothing was changed.");
  }
  for (const record of parsed.data.items) {
    if (!safeHttpResourceUrl(record.url)) {
      throw new Error("Availability history has an unsafe URL label; nothing was changed.");
    }
    validateAvailabilityObservation(record.observation);
  }
  return parsed.data.items;
}

async function writeHistory(root: string, items: PersistedRecord[]): Promise<void> {
  const file = await historyPath(root, true);
  const contents = JSON.stringify({ version: 1, items });
  if (Buffer.byteLength(contents, "utf8") > MAX_AVAILABILITY_HISTORY_FILE_BYTES) {
    throw new Error("Availability history would exceed the 24 KB file limit.");
  }
  const temporary = path.join(path.dirname(file), "." + FILENAME + "." + randomUUID() + ".tmp");
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await fs.rm(temporary, { force: true });
  }
}

function response(items: PersistedRecord[], url: string,
  savedId?: string, evictedId?: string): AvailabilityStoreResponse {
  const records = items.filter((item) => item.url === url)
    .map(({ id, saved_at, observation }) => ({ id, saved_at, observation }));
  return {
    count: records.length, records,
    ...(savedId ? { saved_id: savedId } : {}),
    ...(evictedId ? { evicted_id: evictedId } : {}),
  };
}

let pendingSave: Promise<unknown> = Promise.resolve();

/** Read-only, bounded, exact-URL history lookup. No global list or raw URL output. */
export async function getAvailabilityHistory(
  url: string, root = rootDirectory(),
): Promise<AvailabilityStoreResponse> {
  const safe = safeHttpResourceUrl(url);
  if (!safe) throw new Error("History lookup requires a safe query-free URL label.");
  return response(await readHistory(root), safe);
}

/** Opt-in single HTTP observation save, with atomic write and ten-item eviction. */
export function saveAvailabilityObservation(
  url: string, observation: AvailabilityObservation, root = rootDirectory(),
): Promise<AvailabilityStoreResponse> {
  const safe = safeHttpResourceUrl(url);
  if (!safe) throw new Error("History save requires a safe query-free URL label.");
  validateAvailabilityObservation(observation);
  const parsedObservation = observationSchema.parse(observation);
  const action = async (): Promise<AvailabilityStoreResponse> => {
    const items = await readHistory(root);
    const sameUrl = items.filter((item) => item.url === safe);
    const last = sameUrl.at(-1);
    if (last && Date.parse(parsedObservation.observed_at) <=
      Date.parse(last.observation.observed_at)) {
      if (Date.parse(parsedObservation.observed_at) === Date.parse(last.observation.observed_at) &&
        JSON.stringify(last.observation) === JSON.stringify(parsedObservation)) {
        return response(items, safe, last.id);
      }
      throw new Error("Saved observations must advance chronologically for each exact URL.");
    }
    const newItem: PersistedRecord = {
      id: randomUUID(), saved_at: new Date().toISOString(), url: safe,
      observation: parsedObservation,
    };
    const next = [...items, newItem];
    const removed = next.length > MAX_AVAILABILITY_HISTORY ? next.shift() : undefined;
    await writeHistory(root, next);
    // The archive is globally capped; never disclose an ID that belongs to
    // some other exact URL when its oldest record is evicted.
    return response(next, safe, newItem.id, removed?.url === safe ? removed.id : undefined);
  };
  const request = pendingSave.then(action, action);
  pendingSave = request.catch(() => undefined);
  return request;
}
