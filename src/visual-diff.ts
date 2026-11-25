import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveLocalFileWithinWorkspaceRoot } from "./network.js";
import type { ScreenshotResult } from "./screenshot.js";

/** Avoid decoding images larger than a normal 1080p viewport on an 8 GB laptop. */
export const MAX_VISUAL_DIFF_PIXELS = 2_073_600;
export const MAX_VISUAL_DIFF_PNG_BYTES = 12_000_000;

export type VisualDiffStatus =
  | "compared"
  | "missing_baseline"
  | "dimension_mismatch"
  | "over_budget"
  | "incomplete_capture"
  | "unavailable";

export interface VisualDiffResult {
  status: VisualDiffStatus;
  changed_pixels?: number;
  changed_percent?: number;
  pixels_compared?: number;
}

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_HEADER)
    || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Invalid PNG baseline");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width * height > MAX_VISUAL_DIFF_PIXELS) {
    throw new Error("PNG pixel dimensions exceed visual diff safety budget");
  }
  return { width, height };
}

async function boundedPng(pathname: string): Promise<Buffer> {
  const info = await fs.lstat(pathname);
  if (!info.isFile() || info.isSymbolicLink()
    || info.size < 24 || info.size > MAX_VISUAL_DIFF_PNG_BYTES) {
    throw new Error("PNG is not a bounded regular file");
  }
  return fs.readFile(pathname);
}

/** Compare one screenshot with a same-named baseline; no image bytes or DOM values escape. */
export async function compareScreenshotWithBaseline(
  capture: ScreenshotResult,
  referenceDirectory: string,
): Promise<VisualDiffResult> {
  if (capture.incompleteAssetCount) return { status: "incomplete_capture" };
  if (capture.width * capture.height > MAX_VISUAL_DIFF_PIXELS) {
    return { status: "over_budget" };
  }
  const reference = path.join(referenceDirectory, path.basename(capture.outputPath));
  try {
    // This also enforces an opt-in workspace root after resolving symlinks.
    const scoped = await resolveLocalFileWithinWorkspaceRoot(reference);
    const [baselineBytes, freshBytes] = await Promise.all([
      boundedPng(scoped),
      boundedPng(capture.outputPath).catch((cause: unknown) => {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }),
    ]);
    if (!freshBytes) return { status: "unavailable" };
    const original = pngDimensions(baselineBytes);
    const actual = pngDimensions(freshBytes);
    if (original.width !== actual.width || original.height !== actual.height
      || actual.width !== capture.width || actual.height !== capture.height) {
      return { status: "dimension_mismatch" };
    }
    const [{ PNG }, { default: pixelmatch }] = await Promise.all([
      import("pngjs"),
      import("pixelmatch"),
    ]);
    const before = PNG.sync.read(baselineBytes);
    const after = PNG.sync.read(freshBytes);
    if (before.width !== original.width || before.height !== original.height
      || after.width !== actual.width || after.height !== actual.height) {
      return { status: "unavailable" };
    }
    const changed = pixelmatch(before.data, after.data, null, actual.width, actual.height, {
      threshold: 0.1,
      includeAA: false,
    });
    const pixels = actual.width * actual.height;
    return {
      status: "compared",
      changed_pixels: changed,
      pixels_compared: pixels,
      changed_percent: Math.round(changed * 10000 / pixels) / 100,
    };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing_baseline" };
    }
    return { status: "unavailable" };
  }
}

/** Validate baseline location before rendering, so a baseline cannot be overwritten accidentally. */
export async function resolveVisualReferenceDirectory(
  baselineDirectory: string,
  outputDirectory: string,
): Promise<string> {
  const directory = await resolveLocalFileWithinWorkspaceRoot(baselineDirectory);
  const real = await fs.realpath(directory);
  if (!(await fs.stat(real)).isDirectory()) {
    throw new Error("Visual baseline must be an existing directory");
  }
  const output = await fs.realpath(outputDirectory);
  if (real === output) {
    throw new Error("Visual baseline directory must differ from screenshot output directory");
  }
  return real;
}
