import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import {
  compareScreenshotWithBaseline,
  resolveVisualReferenceDirectory,
} from "../dist/visual-diff.js";

function pngPixel(r, g, b) {
  const png = new PNG({ width: 2, height: 2 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set([r, g, b, 255], offset);
  }
  return PNG.sync.write(png);
}

test("pixelmatch detects identical and changed captures without writing comparison images", async () => {
  const temp = await mkdtemp(join(tmpdir(), "wv-visual-diff-"));
  try {
    const before = join(temp, "baseline"), after = join(temp, "current");
    await mkdir(before); await mkdir(after);
    const filename = "mobile_2x2.png";
    await writeFile(join(before, filename), pngPixel(3, 3, 3));
    await writeFile(join(after, filename), pngPixel(3, 3, 3));
    const capture = { outputPath: join(after, filename), viewportName: "mobile",
      width: 2, height: 2 };
    const base = await resolveVisualReferenceDirectory(before, after);
    const equal = await compareScreenshotWithBaseline(capture, base);
    assert.equal(equal.status, "compared");
    assert.equal(equal.changed_pixels, 0);
    assert.equal(equal.changed_percent, 0);
    await writeFile(join(after, filename), pngPixel(240, 10, 10));
    const changed = await compareScreenshotWithBaseline(capture, base);
    assert.equal(changed.status, "compared");
    assert.equal(changed.changed_pixels, 4);
    assert.equal(changed.changed_percent, 100);
    const files = await import("node:fs/promises").then((fs) => fs.readdir(after));
    assert.deepEqual(files, [filename]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("visual compare flags missing, incomplete, corrupted and dimension-mismatched baselines", async () => {
  const temp = await mkdtemp(join(tmpdir(), "wv-visual-bounds-"));
  try {
    const before = join(temp, "old"), after = join(temp, "new");
    await mkdir(before); await mkdir(after);
    const filename = "desktop_2x2.png";
    const capture = { outputPath: join(after, filename), viewportName: "desktop",
      width: 2, height: 2 };
    await writeFile(join(after, filename), pngPixel(5, 5, 5));
    assert.equal((await compareScreenshotWithBaseline(capture, before)).status,
      "missing_baseline");
    assert.equal((await compareScreenshotWithBaseline(
      { ...capture, incompleteAssetCount: 1 }, before)).status, "incomplete_capture");
    await writeFile(join(before, filename), Buffer.from("no png"));
    assert.equal((await compareScreenshotWithBaseline(capture, before)).status,
      "unavailable");
    await writeFile(join(before, filename), pngPixel(0, 0, 0));
    assert.equal((await compareScreenshotWithBaseline(
      { ...capture, width: 3 }, before)).status, "dimension_mismatch");
    assert.equal((await compareScreenshotWithBaseline(
      { ...capture, width: 1_920, height: 1_200 }, before)).status, "over_budget");
    await assert.rejects(resolveVisualReferenceDirectory(after, after),
      /must differ/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
