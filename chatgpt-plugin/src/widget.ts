export const WIDGET_URI = "ui://web-validator/results-v1.html";

/**
 * A dependency-free, read-only result viewer. It never fetches from the
 * network, so the widget CSP can remain intentionally empty.
 */
export const WIDGET_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Web Validator results</title>
    <style>
      :root { color: #172033; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; background: #f8fafc; }
      main { padding: 16px; }
      h1 { margin: 0 0 8px; font-size: 18px; }
      p { color: #526070; line-height: 1.45; }
      pre { margin: 12px 0 0; max-height: 360px; overflow: auto; padding: 12px; border-radius: 10px; background: #0f172a; color: #e2e8f0; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
      .status { font-size: 13px; color: #526070; }
    </style>
  </head>
  <body>
    <main>
      <h1>Web Validator</h1>
      <p id="status" class="status">Waiting for validation results…</p>
      <pre id="result" hidden></pre>
    </main>
    <script type="module">
      const status = document.getElementById("status");
      const result = document.getElementById("result");

      function render(toolResult) {
        const data = toolResult && toolResult.structuredContent;
        if (!data) return;
        const error = data.error;
        status.textContent = error ? error : "Validation complete.";
        result.textContent = JSON.stringify(data, null, 2);
        result.hidden = false;
      }

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method !== "ui/notifications/tool-result") return;
        render(message.params);
      }, { passive: true });
    </script>
  </body>
</html>`;
