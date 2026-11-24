const assert = require("node:assert/strict");
const vscode = require("vscode");
exports.run = async function () {
  const ext = vscode.extensions.getExtension("tomiseregi.digestseo-web-validator");
  assert.ok(ext, "extension discovered by real VS Code host");
  await ext.activate();
  const doc = await vscode.workspace.openTextDocument({ language: "html", content: '<!doctype html><html><head><title>Test</title><meta name="robots" content="noindex"><script type="application/ld+json">{broken</script></head><body></body></html>' });
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand("digestseoWebValidator.review");
  const findings = vscode.languages.getDiagnostics(doc.uri).filter(x => x.source === "DigestSEO");
  assert.ok(findings.some(x => x.code === "declared_noindex"), JSON.stringify(findings));
  assert.ok(findings.some(x => x.code === "invalid_json"), JSON.stringify(findings));
  await vscode.commands.executeCommand("digestseoWebValidator.clear");
  assert.equal(vscode.languages.getDiagnostics(doc.uri).filter(x => x.source === "DigestSEO").length, 0);
  if (process.env.EDITOR_TEST_RECEIPT) require("node:fs").writeFileSync(process.env.EDITOR_TEST_RECEIPT, JSON.stringify({ extension: ext.id, version: vscode.version, status: "passed" }), { flag: "wx" });
  console.log("DIGESTSEO_EXTENSION_HOST_OK " + vscode.version);
};
