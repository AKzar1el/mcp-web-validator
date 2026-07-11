export const WIDGET_URI = "ui://web-validator/results-v2.html";

/**
 * A dependency-free, read-only result viewer. It never fetches from the
 * network and renders all tool data through textContent.
 */
export const WIDGET_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Web Validator results</title>
    <style>
      :root {
        color-scheme: light dark;
        --background: #f8fafc;
        --surface: #ffffff;
        --text: #172033;
        --muted: #526070;
        --border: #dbe3ec;
        --accent: #2563eb;
        --error: #b42318;
        --warning: #9a6700;
        --info: #175cd3;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--background); color: var(--text); }
      main { padding: 16px; }
      header { display: flex; align-items: center; gap: 10px; }
      .mark { display: grid; width: 32px; height: 32px; place-items: center; border-radius: 9px; background: var(--accent); color: white; font-weight: 800; }
      h1 { margin: 0; font-size: 18px; }
      h2 { margin: 18px 0 8px; font-size: 14px; }
      p { margin: 3px 0 0; color: var(--muted); line-height: 1.45; }
      .status { font-size: 13px; }
      .status.error { color: var(--error); font-weight: 650; }
      .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); gap: 8px; margin-top: 14px; }
      .metric { min-width: 0; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
      .metric strong { display: block; font-size: 19px; }
      .metric span { color: var(--muted); font-size: 11px; }
      .findings { display: grid; gap: 8px; }
      .finding { border: 1px solid var(--border); border-left: 4px solid var(--info); border-radius: 9px; padding: 10px 11px; background: var(--surface); }
      .finding.error { border-left-color: var(--error); }
      .finding.warning { border-left-color: var(--warning); }
      .finding.info { border-left-color: var(--info); }
      .finding-title { margin: 0; color: var(--text); font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
      .finding-meta { margin-top: 4px; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
      .empty { margin-top: 14px; border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--surface); color: var(--muted); font-size: 13px; }
      [hidden] { display: none !important; }
      @media (prefers-color-scheme: dark) {
        :root { --background: #111827; --surface: #182233; --text: #f1f5f9; --muted: #aab7c7; --border: #334155; --accent: #3b82f6; --error: #f97066; --warning: #fdb022; --info: #84adff; }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div class="mark" aria-hidden="true">✓</div>
        <div>
          <h1>Web Validator</h1>
          <p id="status" class="status" role="status" aria-live="polite">Waiting for validation results…</p>
        </div>
      </header>
      <div id="metrics" class="metrics" hidden></div>
      <div id="sections"></div>
      <div id="empty" class="empty" hidden>No issues were found in the returned checks.</div>
    </main>
    <script type="module">
      const status = document.getElementById("status");
      const metrics = document.getElementById("metrics");
      const sections = document.getElementById("sections");
      const empty = document.getElementById("empty");

      const labels = {
        html_errors: "HTML errors",
        html_warnings: "HTML warnings",
        html_info: "HTML info",
        css_errors: "CSS errors",
        seo_issues: "SEO issues",
        schema_issues: "Schema issues",
        links_checked: "Links checked",
        broken_links: "Broken links",
        total_issues: "Total issues",
        errors: "Validation messages",
        issues: "Findings",
        html_messages: "HTML messages",
        css_messages: "CSS messages",
        seo_findings: "SEO and accessibility findings",
        schema_findings: "Schema findings",
        links: "Link results",
      };

      function makeElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = String(text);
        return element;
      }

      function severityFor(item) {
        if (item && typeof item === "object") {
          if (item.ok === false) return "error";
          if (item.type === "error" || item.severity === "error") return "error";
          if (item.type === "warning" || item.severity === "warning") return "warning";
        }
        return "info";
      }

      function findingText(item) {
        if (!item || typeof item !== "object") return String(item);
        return item.message || item.url || "Validation result";
      }

      function findingMeta(item) {
        if (!item || typeof item !== "object") return "";
        const parts = [];
        if (item.category) parts.push(item.category);
        if (item.type) parts.push(item.type);
        else if (item.severity) parts.push(item.severity);
        if (item.line !== undefined) parts.push("line " + item.line + (item.column !== undefined ? ", column " + item.column : ""));
        if (item.status !== undefined) parts.push("HTTP status " + item.status);
        if (item.context) parts.push(item.context);
        return parts.join(" · ");
      }

      function renderArray(key, values) {
        if (!Array.isArray(values) || values.length === 0) return false;
        const section = document.createElement("section");
        section.appendChild(makeElement("h2", "", labels[key] || key));
        const list = makeElement("div", "findings");
        list.setAttribute("role", "list");
        for (const item of values) {
          const severity = severityFor(item);
          const card = makeElement("article", "finding " + severity);
          card.setAttribute("role", "listitem");
          card.appendChild(makeElement("p", "finding-title", findingText(item)));
          const meta = findingMeta(item);
          if (meta) card.appendChild(makeElement("p", "finding-meta", meta));
          list.appendChild(card);
        }
        section.appendChild(list);
        sections.appendChild(section);
        return true;
      }

      function addMetric(value, label) {
        const card = makeElement("div", "metric");
        card.appendChild(makeElement("strong", "", value));
        card.appendChild(makeElement("span", "", label));
        metrics.appendChild(card);
      }

      function renderData(data) {
        if (!data || typeof data !== "object") return;
        metrics.replaceChildren();
        sections.replaceChildren();
        empty.hidden = true;

        status.textContent = data.error || "Validation complete.";
        status.classList.toggle("error", Boolean(data.error));

        const metricKeys = ["html_errors", "html_warnings", "html_info", "css_errors", "seo_issues", "schema_issues", "links_checked", "broken_links", "total_issues"];
        for (const key of metricKeys) {
          if (typeof data[key] === "number") addMetric(data[key], labels[key]);
        }
        if (Array.isArray(data.errors) && !metricKeys.some((key) => typeof data[key] === "number")) {
          addMetric(data.errors.length, labels.errors);
        }
        metrics.hidden = metrics.childElementCount === 0;

        let hasFindings = false;
        for (const key of ["errors", "issues", "html_messages", "css_messages", "seo_findings", "schema_findings", "links"]) {
          hasFindings = renderArray(key, data[key]) || hasFindings;
        }
        empty.hidden = hasFindings || Boolean(data.error);
      }

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method !== "ui/notifications/tool-result") return;
        renderData(message.params && message.params.structuredContent);
      }, { passive: true });

      window.addEventListener("openai:set_globals", (event) => {
        renderData(event.detail && event.detail.globals && event.detail.globals.toolOutput);
      }, { passive: true });

      renderData(window.openai && window.openai.toolOutput);
    </script>
  </body>
</html>`;
