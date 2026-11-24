const vscode = require("vscode");
const { reviewDocument } = require("./review.cjs");

function activate(context) {
  const collection = vscode.languages.createDiagnosticCollection("digestseo");
  context.subscriptions.push(collection);

  function review(document, manual = false) {
    if (!document || document.languageId !== "html") return;
    const config = vscode.workspace.getConfiguration("digestseoWebValidator", document.uri);
    if (!manual && !config.get("onSave", true)) {
      collection.delete(document.uri);
      return;
    }
    let findings;
    try {
      findings = reviewDocument(document.getText(), config.get("pageUrl", ""));
    } catch {
      findings = [{ code: "review_failed", severity: "info", message: "The bounded local review could not complete. No conclusions were drawn." }];
    }
    const severity = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, info: vscode.DiagnosticSeverity.Information };
    const size = document.getText().length;
    const diagnostics = findings.map(finding => {
      // Metadata findings are document-level; only parser locations are exact.
      const start = Math.max(0, Math.min(size, finding.start ?? 0));
      const end = Math.max(start, Math.min(size, finding.end ?? start + 1));
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(document.positionAt(start), document.positionAt(end)),
        finding.message, severity[finding.severity],
      );
      diagnostic.source = "DigestSEO";
      diagnostic.code = finding.code;
      return diagnostic;
    });
    collection.set(document.uri, diagnostics);
    if (manual) vscode.window.setStatusBarMessage(
      "DigestSEO: " + diagnostics.length + " local review observation(s)", 4000,
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("digestseoWebValidator.review", () => {
      const active = vscode.window.activeTextEditor?.document;
      if (active?.languageId === "html") review(active, true);
      else vscode.window.setStatusBarMessage("DigestSEO: open an HTML document first.", 4000);
    }),
    vscode.commands.registerCommand("digestseoWebValidator.clear", () => collection.clear()),
    vscode.workspace.onDidSaveTextDocument(document => review(document)),
    vscode.workspace.onDidOpenTextDocument(document => review(document)),
    vscode.workspace.onDidChangeTextDocument(event => collection.delete(event.document.uri)),
    vscode.workspace.onDidCloseTextDocument(document => collection.delete(document.uri)),
  );
  for (const editor of vscode.window.visibleTextEditors.slice(0, 8)) review(editor.document);
}

exports.activate = activate;
