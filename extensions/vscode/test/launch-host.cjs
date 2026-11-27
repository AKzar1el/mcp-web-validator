const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const exe = process.env.VSCODE_EXECUTABLE;
if (!exe || !path.isAbsolute(exe) || !fs.statSync(exe).isFile()) throw new Error("Set VSCODE_EXECUTABLE to an installed VS Code executable.");
const parent = path.join(root, ".test-host");
fs.mkdirSync(parent, { recursive: true });
if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("Test directory must not be a symlink.");
const run = fs.mkdtempSync(path.join(parent, "run-"));
const receipt = path.join(run, "receipt.json");
const user = path.join(run, "user", "User");
fs.mkdirSync(user, { recursive: true });
// Keep the disposable host offline from optional update and AI services.
// Never change the user's actual profile or workspace security settings.
fs.writeFileSync(path.join(user, "settings.json"), JSON.stringify({
  "update.mode": "none",
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  "telemetry.telemetryLevel": "off",
  "chat.disableAIFeatures": true,
  "workbench.startupEditor": "none",
}), { flag: "wx" });
const args = [
  "--new-window", "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-telemetry",
  "--user-data-dir=" + path.join(run, "user"), "--extensions-dir=" + path.join(run, "extensions"),
  "--extensionDevelopmentPath=" + root, "--extensionTestsPath=" + path.join(root, "test", "host.cjs"),
];
const env = { ...process.env, EDITOR_TEST_RECEIPT: receipt };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VSCODE_IPC_HOOK_CLI;
const child = spawn(exe, args, { env, stdio: "inherit", cwd: run, windowsHide: true });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  child.kill();
}, 300000);
child.on("error", error => {
  clearTimeout(timer);
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", code => {
  clearTimeout(timer);
  if (timedOut || code !== 0 || !fs.existsSync(receipt)) {
    console.error("Host test did not complete with a verified receipt. Exit:", code, "timeout:", timedOut, "run:", run);
    process.exitCode = 1;
    return;
  }
  const result = JSON.parse(fs.readFileSync(receipt, "utf8"));
  if (result.status !== "passed" || result.extension !== manifest.publisher + "." + manifest.name) {
    console.error("Host receipt mismatch.");
    process.exitCode = 1;
    return;
  }
  console.log("HOST_TEST_RECEIPT " + JSON.stringify(result));
});
