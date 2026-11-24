import { build } from "esbuild";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const out = resolve(here, "dist");
await mkdir(out, { recursive: true });
const result = await build({
  absWorkingDir: here,
  entryPoints: ["src/review.ts"],
  outfile: "dist/review.cjs",
  bundle: true,
  platform: "node",
  target: "node20.18",
  format: "cjs",
  minify: true,
  legalComments: "eof",
  metafile: true,
  nodePaths: [resolve(here, "node_modules")],
  logLevel: "info",
});
await copyFile(resolve(here, "src/extension.cjs"), resolve(out, "extension.cjs"));
// Include notices for every dependency whose code is bundled.
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const path = resolve(here, input).split(sep);
  const i = path.lastIndexOf("node_modules");
  if (i < 0) continue;
  const length = path[i + 1]?.startsWith("@") ? 3 : 2;
  packages.add(path.slice(0, i + length).join(sep));
}
const notices = [];
const missing = [];
for (const root of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const names = (await readdir(root)).filter(name => /^(license|copying|notice)([._-].*|$)/i.test(name));
  notices.push(pkg.name + "@" + pkg.version + " (" + (pkg.license ?? "see license") + ")");
  if (!names.length) {
    if (pkg.name === "boolbase" && pkg.version === "1.0.0" && pkg.license === "ISC") {
      notices.push("Upstream ISC notice (https://github.com/fb55/boolbase/blob/master/LICENSE)\n" + await readFile(resolve(here, "third-party/boolbase-1.0.0.LICENSE"), "utf8"));
    } else missing.push(pkg.name + "@" + pkg.version);
  }
  for (const name of names.sort()) {
    notices.push(name + "\n" + await readFile(resolve(root, name), "utf8"));
  }
}
if (missing.length) throw new Error("Missing license notices: " + missing.join(", "));
await writeFile(resolve(out, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n"), "utf8");
await copyFile(resolve(repo, "LICENSE"), resolve(here, "LICENSE"));
await copyFile(resolve(repo, "icon.png"), resolve(here, "icon.png"));
