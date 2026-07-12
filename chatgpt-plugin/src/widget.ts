export const WIDGET_URI = "ui://web-validator/results-v5.html";

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
        --page: transparent;
        --surface: #ffffff;
        --surface-subtle: #f7f8fa;
        --surface-raised: #ffffff;
        --text: #182230;
        --muted: #596574;
        --border: #dfe4ea;
        --border-strong: #c9d1dc;
        --accent: #2563eb;
        --accent-soft: #eff6ff;
        --success: #067647;
        --success-soft: #ecfdf3;
        --warning: #8a5700;
        --warning-soft: #fff8e8;
        --error: #b42318;
        --error-soft: #fef3f2;
        --info: #175cd3;
        --info-soft: #eff8ff;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      :root[data-theme="light"] { color-scheme: light; }
      :root[data-theme="dark"] {
        color-scheme: dark;
        --surface: #171b22;
        --surface-subtle: #1e242d;
        --surface-raised: #1b2028;
        --text: #f3f5f7;
        --muted: #aab4c0;
        --border: #353d49;
        --border-strong: #485261;
        --accent: #75a7ff;
        --accent-soft: #172c4f;
        --success: #75d6aa;
        --success-soft: #15372b;
        --warning: #f5c76b;
        --warning-soft: #3a2c12;
        --error: #ff9b92;
        --error-soft: #43221f;
        --info: #9bc2ff;
        --info-soft: #172f55;
      }

      * { box-sizing: border-box; }

      html, body { min-width: 0; }

      body {
        margin: 0;
        padding: 8px;
        background: var(--page);
        color: var(--text);
        font-size: 14px;
        line-height: 1.5;
      }

      button, summary { font: inherit; }

      .app {
        width: 100%;
        max-width: 720px;
        margin: 0 auto;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: var(--surface);
      }

      .hero { padding: 20px 20px 18px; }

      .eyebrow {
        margin: 0 0 7px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      h1 {
        min-width: 0;
        margin: 0;
        font-size: clamp(19px, 4.5vw, 24px);
        line-height: 1.2;
        letter-spacing: -0.02em;
        overflow-wrap: anywhere;
      }

      .status-chip {
        display: inline-flex;
        flex: 0 0 auto;
        align-items: center;
        gap: 7px;
        min-height: 28px;
        padding: 4px 9px;
        border: 1px solid var(--border-strong);
        border-radius: 999px;
        background: var(--surface-subtle);
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
        white-space: nowrap;
      }

      .status-dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: currentColor;
      }

      .status-chip[data-tone="success"] { border-color: var(--success); background: var(--success-soft); color: var(--success); }
      .status-chip[data-tone="warning"],
      .status-chip[data-tone="partial"] { border-color: var(--warning); background: var(--warning-soft); color: var(--warning); }
      .status-chip[data-tone="error"] { border-color: var(--error); background: var(--error-soft); color: var(--error); }
      .status-chip[data-tone="info"] { border-color: var(--info); background: var(--info-soft); color: var(--info); }
      .status-chip[data-tone="loading"] .status-dot { animation: pulse 1.25s ease-in-out infinite; }

      .headline {
        margin: 15px 0 0;
        color: var(--text);
        font-size: 16px;
        font-weight: 700;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .detail {
        max-width: 64ch;
        margin: 5px 0 0;
        color: var(--muted);
        overflow-wrap: anywhere;
      }

      .content {
        display: grid;
        gap: 16px;
        padding: 0 20px 20px;
      }

      .metrics {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 108px), 1fr));
        gap: 8px;
        margin: 0;
      }

      .metric {
        min-width: 0;
        padding: 11px 12px;
        border: 1px solid var(--border);
        border-radius: 11px;
        background: var(--surface-subtle);
      }

      .metric dt {
        margin: 0;
        color: var(--muted);
        font-size: 11px;
        font-weight: 650;
        line-height: 1.3;
        overflow-wrap: anywhere;
      }

      .metric dd {
        margin: 3px 0 0;
        color: var(--text);
        font-size: 21px;
        font-variant-numeric: tabular-nums;
        font-weight: 750;
        line-height: 1.15;
      }

      .metric[data-tone="error"] dd { color: var(--error); }
      .metric[data-tone="warning"] dd { color: var(--warning); }
      .metric[data-tone="success"] dd { color: var(--success); }

      .notice-stack { display: grid; gap: 8px; }

      .notice,
      .action,
      .state-card {
        padding: 12px 13px;
        border: 1px solid var(--border);
        border-radius: 11px;
        background: var(--surface-subtle);
      }

      .notice[data-tone="warning"] { border-color: var(--warning); background: var(--warning-soft); }
      .notice[data-tone="error"] { border-color: var(--error); background: var(--error-soft); }
      .notice[data-tone="info"] { border-color: var(--info); background: var(--info-soft); }

      .notice-title,
      .action-label,
      .state-title {
        margin: 0;
        color: var(--text);
        font-size: 12px;
        font-weight: 750;
      }

      .notice-copy,
      .action-copy,
      .state-copy {
        margin: 3px 0 0;
        color: var(--muted);
        overflow-wrap: anywhere;
      }

      .action {
        border-left: 4px solid var(--accent);
        background: var(--accent-soft);
      }

      .action-label { color: var(--accent); }
      .action-copy { color: var(--text); font-weight: 600; }

      .section-stack { display: grid; gap: 18px; }

      .finding-section h2,
      .passing-section h2 {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin: 0 0 8px;
        color: var(--text);
        font-size: 13px;
        line-height: 1.3;
      }

      .section-count {
        color: var(--muted);
        font-size: 11px;
        font-weight: 650;
      }

      .finding-list {
        display: grid;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .finding {
        min-width: 0;
        padding: 11px 12px;
        border: 1px solid var(--border);
        border-left: 4px solid var(--info);
        border-radius: 10px;
        background: var(--surface-raised);
      }

      .finding[data-severity="error"] { border-left-color: var(--error); }
      .finding[data-severity="warning"] { border-left-color: var(--warning); }
      .finding[data-severity="success"] { border-left-color: var(--success); }

      .finding-topline {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .severity-badge {
        display: inline-flex;
        align-items: center;
        min-height: 22px;
        padding: 2px 7px;
        border-radius: 999px;
        background: var(--info-soft);
        color: var(--info);
        font-size: 10px;
        font-weight: 750;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .severity-badge[data-severity="error"] { background: var(--error-soft); color: var(--error); }
      .severity-badge[data-severity="warning"] { background: var(--warning-soft); color: var(--warning); }
      .severity-badge[data-severity="success"] { background: var(--success-soft); color: var(--success); }

      .finding-meta {
        min-width: 0;
        color: var(--muted);
        font-size: 11px;
        text-align: right;
        overflow-wrap: anywhere;
      }

      .finding-message {
        margin: 7px 0 0;
        color: var(--text);
        font-size: 13px;
        font-weight: 600;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }

      .finding-detail {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 11px;
        overflow-wrap: anywhere;
      }

      details { min-width: 0; }

      .more-results,
      .passing-results {
        margin-top: 8px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--surface-subtle);
      }

      .more-results > summary,
      .passing-results > summary {
        min-height: 44px;
        padding: 11px 12px;
        color: var(--text);
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .more-results[open] > summary,
      .passing-results[open] > summary { border-bottom: 1px solid var(--border); }

      .more-results .finding-list,
      .passing-results .finding-list { padding: 8px; }

      summary:focus-visible {
        outline: 3px solid var(--accent);
        outline-offset: 2px;
        border-radius: 8px;
      }

      .state-card {
        display: grid;
        grid-template-columns: auto 1fr;
        align-items: start;
        gap: 10px;
      }

      .state-card[data-tone="success"] { border-color: var(--success); background: var(--success-soft); }
      .state-card[data-tone="error"] { border-color: var(--error); background: var(--error-soft); }
      .state-card[data-tone="info"] { border-color: var(--info); background: var(--info-soft); }

      .state-symbol {
        display: grid;
        width: 24px;
        height: 24px;
        place-items: center;
        border: 1px solid currentColor;
        border-radius: 999px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 800;
      }

      .state-card[data-tone="success"] .state-symbol { color: var(--success); }
      .state-card[data-tone="error"] .state-symbol { color: var(--error); }
      .state-card[data-tone="info"] .state-symbol { color: var(--info); }

      .footer {
        padding-top: 2px;
        color: var(--muted);
        font-size: 11px;
        text-align: center;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      [hidden] { display: none !important; }

      @keyframes pulse {
        0%, 100% { opacity: 0.35; }
        50% { opacity: 1; }
      }

      @media (max-width: 420px) {
        body { padding: 4px; }
        .app { border-radius: 13px; }
        .hero { padding: 16px 14px 14px; }
        .content { gap: 14px; padding: 0 14px 16px; }
        .title-row { align-items: flex-start; flex-direction: column; gap: 9px; }
        .status-chip { min-height: 26px; }
        .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .finding-topline { align-items: flex-start; flex-direction: column; gap: 6px; }
        .finding-meta { text-align: left; }
      }

      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) {
          --surface: #171b22;
          --surface-subtle: #1e242d;
          --surface-raised: #1b2028;
          --text: #f3f5f7;
          --muted: #aab4c0;
          --border: #353d49;
          --border-strong: #485261;
          --accent: #75a7ff;
          --accent-soft: #172c4f;
          --success: #75d6aa;
          --success-soft: #15372b;
          --warning: #f5c76b;
          --warning-soft: #3a2c12;
          --error: #ff9b92;
          --error-soft: #43221f;
          --info: #9bc2ff;
          --info-soft: #172f55;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          scroll-behavior: auto !important;
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
        }
      }

      @media (forced-colors: active) {
        .app,
        .metric,
        .notice,
        .action,
        .state-card,
        .finding,
        .more-results,
        .passing-results,
        .status-chip { border-color: CanvasText; }

        .finding { border-left-width: 5px; }
        .status-dot { forced-color-adjust: none; background: currentColor; }
      }
    </style>
  </head>
  <body>
    <main id="app" class="app" aria-busy="true">
      <header class="hero">
        <p id="eyebrow" class="eyebrow">Web Validator</p>
        <div class="title-row">
          <h1 id="title">Preparing results</h1>
          <span id="status-chip" class="status-chip" data-tone="loading">
            <span class="status-dot" aria-hidden="true"></span>
            <span id="status-label">Running</span>
          </span>
        </div>
        <p id="headline" class="headline">Waiting for validation results…</p>
        <p id="detail" class="detail" hidden></p>
      </header>

      <div class="content">
        <section id="metrics-section" aria-labelledby="metrics-heading" hidden>
          <h2 id="metrics-heading" class="sr-only">Result summary</h2>
          <dl id="metrics" class="metrics"></dl>
        </section>

        <div id="notice-stack" class="notice-stack" hidden></div>

        <aside id="action" class="action" aria-labelledby="action-label" hidden>
          <p id="action-label" class="action-label">Fix first</p>
          <p id="action-copy" class="action-copy"></p>
        </aside>

        <div id="state" class="state-card" hidden>
          <span id="state-symbol" class="state-symbol" aria-hidden="true">✓</span>
          <div>
            <p id="state-title" class="state-title"></p>
            <p id="state-copy" class="state-copy"></p>
          </div>
        </div>

        <div id="sections" class="section-stack"></div>

        <footer class="footer">Read-only check · No changes were made</footer>
      </div>

      <p id="live-region" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>
    </main>

    <script type="module">
      const app = document.getElementById("app");
      const eyebrow = document.getElementById("eyebrow");
      const title = document.getElementById("title");
      const statusChip = document.getElementById("status-chip");
      const statusLabel = document.getElementById("status-label");
      const headline = document.getElementById("headline");
      const detail = document.getElementById("detail");
      const metricsSection = document.getElementById("metrics-section");
      const metrics = document.getElementById("metrics");
      const noticeStack = document.getElementById("notice-stack");
      const action = document.getElementById("action");
      const actionLabel = document.getElementById("action-label");
      const actionCopy = document.getElementById("action-copy");
      const state = document.getElementById("state");
      const stateSymbol = document.getElementById("state-symbol");
      const stateTitle = document.getElementById("state-title");
      const stateCopy = document.getElementById("state-copy");
      const sections = document.getElementById("sections");
      const liveRegion = document.getElementById("live-region");

      const MAX_VISIBLE_FINDINGS = 8;
      let receivedPrimaryResult = false;
      let currentLocale = "en";
      let latestRenderedPayload;

      const kindLabels = {
        html: "HTML validation",
        css: "CSS validation",
        seo: "SEO metadata audit",
        schema: "JSON-LD check",
        links: "Public link check",
        report: "Full validation report",
        site: "Public site audit",
        validation: "Validation results",
      };

      const countLabels = {
        errors: "Errors",
        warnings: "Warnings",
        info: "Notes",
        informational: "Notes",
        messages: "Messages",
        issues: "Issues",
        total: "Total",
        shown: "Shown",
        checked: "Checked",
        passed: "Passed",
        healthy: "Healthy",
        failed: "Failed",
        redirects: "Redirects",
        redirected: "Redirects",
        broken: "Broken",
        html: "HTML",
        css: "CSS",
        seo: "SEO",
        schema: "Schema",
        links: "Links",
        html_errors: "HTML errors",
        html_warnings: "HTML warnings",
        html_info: "HTML notes",
        css_errors: "CSS errors",
        seo_issues: "SEO issues",
        schema_issues: "Schema issues",
        links_checked: "Links checked",
        broken_links: "Broken links",
        total_issues: "Total issues",
      };

      const metricPriority = [
        "errors",
        "html_errors",
        "css_errors",
        "warnings",
        "html_warnings",
        "seo_issues",
        "schema_issues",
        "broken",
        "broken_links",
        "failed",
        "redirects",
        "redirected",
        "issues",
        "total_issues",
        "info",
        "informational",
        "html_info",
        "checked",
        "links_checked",
        "passed",
        "healthy",
        "total",
      ];

      function makeElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined && text !== null) element.textContent = String(text);
        return element;
      }

      function asObject(value) {
        return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
      }

      function asText(value, fallback) {
        return typeof value === "string" && value.trim() ? value.trim() : fallback;
      }

      function asNumber(value, fallback) {
        return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
      }

      function normalizeKey(value) {
        return String(value || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
      }

      function humanizeKey(value) {
        const key = normalizeKey(value);
        if (countLabels[key]) return countLabels[key];
        return key.split("_").filter(Boolean).map(function (part) {
          return part.charAt(0).toUpperCase() + part.slice(1);
        }).join(" ") || "Result";
      }

      function formatNumber(value) {
        try {
          return new Intl.NumberFormat(currentLocale).format(value);
        } catch {
          return String(value);
        }
      }

      function plural(value, singular, pluralForm) {
        return formatNumber(value) + " " + (value === 1 ? singular : pluralForm);
      }

      function normalizeSeverity(value) {
        const severity = normalizeKey(value);
        if (severity === "error" || severity === "failed" || severity === "broken") return "error";
        if (severity === "warning" || severity === "warn" || severity === "redirect" || severity === "redirected") return "warning";
        if (severity === "success" || severity === "passed" || severity === "healthy" || severity === "ok") return "success";
        return "info";
      }

      function inferKind(data) {
        if (Array.isArray(data.issue_groups)) return "site";
        if (Array.isArray(data.html_messages) || Array.isArray(data.css_messages) || Array.isArray(data.seo_findings)) return "report";
        if (Array.isArray(data.links)) return "links";
        if (Array.isArray(data.issues)) {
          const categories = data.issues.map(function (item) { return normalizeKey(item && item.category); });
          return categories.length > 0 && categories.every(function (category) { return category === "schema"; }) ? "schema" : "seo";
        }
        if (Array.isArray(data.messages)) return "html";
        if (Array.isArray(data.errors)) {
          if (data.errors.length === 0) return "validation";
          return data.errors.some(function (item) { return item && (item.type || item.column !== undefined); }) ? "html" : "css";
        }
        return "validation";
      }

      function sourceLabel(source, kind, item) {
        if (item && item.category) return String(item.category);
        const labels = {
          messages: "HTML",
          errors: kind === "css" ? "CSS" : "HTML",
          issues: kind === "schema" ? "Schema" : "SEO",
          html_messages: "HTML",
          css_messages: "CSS",
          seo_findings: "SEO",
          schema_findings: "Schema",
          links: "Links",
          issue_groups: "Site audit",
        };
        return labels[source] || "";
      }

      function normalizeFinding(item, source, kind) {
        if (!item || typeof item !== "object") {
          return {
            severity: source === "css_messages" || (source === "errors" && kind === "css") ? "error" : "info",
            badge: source === "css_messages" || (source === "errors" && kind === "css") ? "Error" : "Note",
            message: String(item),
            meta: sourceLabel(source, kind),
            detail: "",
          };
        }

        const isLink = source === "links" || typeof item.url === "string";
        const numericStatus = typeof item.status === "number" ? item.status : undefined;
        const isRedirect = isLink && numericStatus !== undefined && numericStatus >= 300 && numericStatus < 400;
        let severity;

        if (isLink) {
          severity = item.ok === false ? "error" : isRedirect ? "warning" : "success";
        } else if (source === "css_messages" || (source === "errors" && kind === "css")) {
          severity = "error";
        } else {
          severity = normalizeSeverity(item.severity || item.type);
        }

        const metaParts = [];
        const sourceName = sourceLabel(source, kind, item);
        if (sourceName) metaParts.push(sourceName);
        if (item.line !== undefined) {
          metaParts.push("Line " + item.line + (item.column !== undefined ? ", column " + item.column : ""));
        }
        if (item.status !== undefined) {
          metaParts.push(typeof item.status === "number" ? "HTTP " + item.status : humanizeKey(item.status));
        }
        if (item.context) metaParts.push(String(item.context));

        let badge = severity === "error" ? "Error" : severity === "warning" ? "Warning" : severity === "success" ? "Passed" : "Note";
        if (isRedirect) badge = "Redirect";
        if (isLink && item.ok === false && normalizeKey(item.status) === "failed") badge = "Failed";
        if (isLink && item.ok === false && normalizeKey(item.status) === "blocked") badge = "Blocked";

        return {
          severity,
          badge,
          message: isLink ? asText(item.url, asText(item.message, "Link result")) : asText(item.message, asText(item.url, "Validation result")),
          meta: metaParts.join(" · "),
          detail: isLink && item.message && item.message !== item.url ? String(item.message) : "",
        };
      }

      function collectFindings(data, kind) {
        const findings = [];
        const sources = ["messages", "errors", "issues", "html_messages", "css_messages", "seo_findings", "schema_findings", "links", "issue_groups"];
        for (const source of sources) {
          const values = data[source];
          if (!Array.isArray(values)) continue;
          for (const item of values) findings.push(normalizeFinding(item, source, kind));
        }
        return findings;
      }

      function countBySeverity(findings, severity) {
        return findings.filter(function (finding) { return finding.severity === severity; }).length;
      }

      function legacyOverview(data) {
        const kind = inferKind(data);
        const findings = collectFindings(data, kind);
        const errors = countBySeverity(findings, "error");
        const warnings = countBySeverity(findings, "warning");
        const info = countBySeverity(findings, "info");
        const passed = countBySeverity(findings, "success");
        const hasError = typeof data.error === "string" && data.error.trim();
        const status = hasError ? (findings.length > 0 ? "partial" : "failed") : errors > 0 ? "issues" : warnings > 0 || info > 0 ? "review" : "clean";
        let headlineText;
        let detailText;
        let counts;
        let total = errors + warnings + info;
        let shown = findings.length;

        if (kind === "html") {
          headlineText = errors > 0 ? plural(errors, "HTML error needs attention", "HTML errors need attention") : warnings + info > 0 ? plural(warnings + info, "HTML message to review", "HTML messages to review") : "No HTML validator issues were returned";
          detailText = errors > 0 ? plural(warnings, "warning", "warnings") + " and " + plural(info, "note", "notes") + " were also returned." : "Review the validator notes below or continue with the next check.";
          counts = { errors, warnings, info };
        } else if (kind === "css") {
          headlineText = errors > 0 ? plural(errors, "CSS syntax error found", "CSS syntax errors found") : "CSS parsed successfully";
          detailText = errors > 0 ? "Fix the syntax issue, then run validation again." : "No syntax errors were returned by the local parser.";
          counts = { errors };
        } else if (kind === "seo") {
          total = asNumber(data.total_issues, errors + warnings + info);
          headlineText = total > 0 ? plural(total, "on-page issue found", "on-page issues found") : "No covered on-page issues were detected";
          detailText = total > 0 ? "Prioritize errors before recommendations and informational notes." : "The covered metadata and accessibility checks passed.";
          counts = { errors, warnings, info };
        } else if (kind === "schema") {
          total = asNumber(data.total_issues, errors + warnings + info);
          headlineText = total > 0 ? plural(total, "JSON-LD issue found", "JSON-LD issues found") : "No JSON-LD syntax issues were found";
          detailText = total > 0 ? "Correct invalid or empty JSON-LD blocks, then check them again." : "No invalid JSON was returned by the syntax check.";
          counts = { errors, warnings, info };
        } else if (kind === "links") {
          total = findings.length;
          shown = findings.length;
          headlineText = errors > 0 ? plural(errors, "link needs attention", "links need attention") : warnings > 0 ? plural(warnings, "redirect needs review", "redirects need review") : total > 0 ? "All " + formatNumber(total) + " checked links responded successfully" : "No eligible public links were found";
          detailText = errors > 0 ? "Review failed and blocked links before the passing results." : total > 0 ? "Passing links are available below for reference." : "Add eligible HTTP or HTTPS links and run the check again.";
          counts = { checked: total, failed: errors, redirects: warnings, passed };
        } else if (kind === "report") {
          total = asNumber(data.html_errors, 0) + asNumber(data.html_warnings, 0) + asNumber(data.html_info, 0) + asNumber(data.css_errors, 0) + asNumber(data.seo_issues, 0) + asNumber(data.schema_issues, 0) + asNumber(data.broken_links, 0);
          headlineText = total > 0 ? plural(total, "finding needs review", "findings need review") : "No issues were detected in the completed checks";
          detailText = total > 0 ? "Start with blocking validation errors, then review SEO, schema, and link findings." : "The completed HTML, CSS, SEO, schema, and link checks returned clean results.";
          counts = {
            html_errors: asNumber(data.html_errors, 0),
            css_errors: asNumber(data.css_errors, 0),
            seo_issues: asNumber(data.seo_issues, 0),
            schema_issues: asNumber(data.schema_issues, 0),
            broken_links: asNumber(data.broken_links, 0),
            links_checked: asNumber(data.links_checked, 0),
          };
        } else if (kind === "site") {
          total = asNumber(data.pages_selected, 0);
          headlineText = total > 0 ? plural(total, "page selected for audit", "pages selected for audit") : "No eligible sitemap pages were selected";
          detailText = "Review the site-wide issue groups and page coverage before continuing the crawl.";
          counts = {
            pages_audited: asNumber(data.pages_audited, 0),
            pages_partial: asNumber(data.pages_partial, 0),
            pages_failed: asNumber(data.pages_failed, 0),
            audit_health_score: asNumber(data.audit_health_score, 0),
          };
        } else {
          headlineText = total > 0 ? plural(total, "finding returned", "findings returned") : "Validation complete";
          detailText = total > 0 ? "Review the findings below." : "No detailed findings were returned.";
          counts = { issues: total };
        }

        if (hasError) detailText = String(data.error);
        const firstActionable = findings.find(function (finding) { return finding.severity === "error"; }) || findings.find(function (finding) { return finding.severity === "warning"; });

        return {
          kind,
          status,
          title: kindLabels[kind] || kindLabels.validation,
          headline: headlineText,
          detail: detailText,
          total,
          shown,
          truncated: Boolean(data.truncated || data.seo_truncated || data.schema_truncated),
          counts,
          next_action: firstActionable ? firstActionable.message : "",
        };
      }

      function normalizeOverview(data) {
        const fallback = legacyOverview(data);
        const provided = asObject(data.overview);
        if (!provided) return fallback;

        const kind = normalizeKey(provided.kind) || fallback.kind;
        const nextActionObject = asObject(provided.next_action);
        const nextAction = typeof provided.next_action === "string"
          ? provided.next_action
          : nextActionObject
            ? asText(nextActionObject.message, asText(nextActionObject.text, ""))
            : fallback.next_action;

        return {
          kind,
          status: normalizeKey(provided.status) || fallback.status,
          title: asText(provided.title, kindLabels[kind] || fallback.title),
          headline: asText(provided.headline, fallback.headline),
          detail: asText(provided.detail, fallback.detail),
          total: asNumber(provided.total, fallback.total),
          shown: asNumber(provided.shown, fallback.shown),
          truncated: typeof provided.truncated === "boolean" ? provided.truncated : fallback.truncated,
          counts: provided.counts || fallback.counts,
          next_action: nextAction,
        };
      }

      function statusPresentation(statusValue, executionError) {
        const status = normalizeKey(statusValue);
        if (status === "not_applicable" || status === "not_applicable_yet" || status === "skipped" || status === "no_data") {
          return { tone: "info", label: "Not applicable", state: "not_applicable" };
        }
        if (status === "partial" || status === "incomplete") return { tone: "partial", label: "Partial results", state: "partial" };
        if (status === "failed" || status === "failure") return { tone: "error", label: "Couldn’t finish", state: "failed" };
        if (status === "error") {
          return executionError ? { tone: "error", label: "Couldn’t finish", state: "failed" } : { tone: "error", label: "Needs attention", state: "issues" };
        }
        if (status === "clean" || status === "passed" || status === "pass" || status === "success" || status === "ok") {
          return { tone: "success", label: "Passed", state: "clean" };
        }
        if (status === "issues" || status === "needs_attention" || status === "attention") {
          return { tone: "warning", label: "Needs attention", state: "issues" };
        }
        if (status === "review" || status === "warning" || status === "notes") {
          return { tone: "warning", label: "Review suggested", state: "review" };
        }
        return { tone: "info", label: "Complete", state: "complete" };
      }

      function toneForMetric(key, value, providedTone) {
        if (providedTone) return normalizeSeverity(providedTone);
        const normalized = normalizeKey(key);
        if (value > 0 && (normalized.includes("error") || normalized.includes("broken") || normalized === "failed")) return "error";
        if (value > 0 && (normalized.includes("warning") || normalized.includes("redirect"))) return "warning";
        if (normalized === "passed" || normalized === "healthy") return "success";
        return "info";
      }

      function countEntries(rawCounts) {
        const entries = [];
        if (Array.isArray(rawCounts)) {
          for (let index = 0; index < rawCounts.length; index += 1) {
            const item = asObject(rawCounts[index]);
            if (!item) continue;
            const value = asNumber(item.value, undefined);
            if (value === undefined) continue;
            const explicitLabel = asText(item.label, "");
            const key = normalizeKey(item.key || explicitLabel || "result_" + index);
            entries.push({
              key,
              label: explicitLabel || humanizeKey(key),
              value,
              tone: toneForMetric(key, value, item.tone),
            });
          }
          return entries;
        }

        const object = asObject(rawCounts);
        if (!object) return entries;
        for (const pair of Object.entries(object)) {
          const key = pair[0];
          const item = pair[1];
          if (typeof item === "number" && Number.isFinite(item) && item >= 0) {
            entries.push({ key: normalizeKey(key), label: humanizeKey(key), value: item, tone: toneForMetric(key, item) });
            continue;
          }
          const nested = asObject(item);
          if (!nested) continue;
          const value = asNumber(nested.value, undefined);
          if (value === undefined) continue;
          entries.push({
            key: normalizeKey(key),
            label: asText(nested.label, humanizeKey(key)),
            value,
            tone: toneForMetric(key, value, nested.tone),
          });
        }

        entries.sort(function (left, right) {
          const leftIndex = metricPriority.indexOf(left.key);
          const rightIndex = metricPriority.indexOf(right.key);
          return (leftIndex === -1 ? metricPriority.length : leftIndex) - (rightIndex === -1 ? metricPriority.length : rightIndex);
        });
        return entries;
      }

      function renderMetrics(overview) {
        metrics.replaceChildren();
        const limit = overview.kind === "report" || overview.kind === "site" ? 6 : 4;
        const entries = countEntries(overview.counts).slice(0, limit);
        for (const entry of entries) {
          const card = makeElement("div", "metric");
          card.dataset.tone = entry.tone;
          card.appendChild(makeElement("dt", "", entry.label));
          card.appendChild(makeElement("dd", "", formatNumber(entry.value)));
          metrics.appendChild(card);
        }
        metricsSection.hidden = entries.length === 0;
      }

      function addNotice(tone, headingText, copyText) {
        const notice = makeElement("div", "notice");
        notice.dataset.tone = tone;
        notice.appendChild(makeElement("p", "notice-title", headingText));
        notice.appendChild(makeElement("p", "notice-copy", copyText));
        noticeStack.appendChild(notice);
      }

      function renderNotices(overview, presentation, data) {
        noticeStack.replaceChildren();
        if (presentation.state === "partial") {
          addNotice("warning", "Some checks did not finish", "Completed results are shown below; retry to fill in the missing checks.");
        }
        if (overview.truncated) {
          const copy = overview.total > overview.shown
            ? "Showing " + formatNumber(overview.shown) + " of " + formatNumber(overview.total) + " findings. Totals include results not displayed here."
            : "This result was capped. Additional findings are not displayed here.";
          addNotice("info", "Result limit reached", copy);
        }
        noticeStack.hidden = noticeStack.childElementCount === 0;
      }

      function appendFinding(list, finding) {
        const card = makeElement("li", "finding");
        card.dataset.severity = finding.severity;
        const topLine = makeElement("div", "finding-topline");
        const badge = makeElement("span", "severity-badge", finding.badge);
        badge.dataset.severity = finding.severity;
        topLine.appendChild(badge);
        if (finding.meta) topLine.appendChild(makeElement("span", "finding-meta", finding.meta));
        card.appendChild(topLine);
        card.appendChild(makeElement("p", "finding-message", finding.message));
        if (finding.detail) card.appendChild(makeElement("p", "finding-detail", finding.detail));
        list.appendChild(card);
      }

      function makeFindingList(findings) {
        const list = makeElement("ol", "finding-list");
        for (const finding of findings) appendFinding(list, finding);
        return list;
      }

      function appendFindingsWhenOpened(details, findings) {
        let populated = false;
        details.addEventListener("toggle", function () {
          if (!details.open || populated) return;
          populated = true;
          details.appendChild(makeFindingList(findings));
        }, { passive: true });
      }

      function renderFindingGroup(label, findings, visibleBudget) {
        if (findings.length === 0) return 0;
        const section = makeElement("section", "finding-section");
        const heading = makeElement("h2");
        heading.appendChild(makeElement("span", "", label));
        heading.appendChild(makeElement("span", "section-count", formatNumber(findings.length)));
        section.appendChild(heading);

        const visibleCount = Math.min(visibleBudget, findings.length);
        const visible = findings.slice(0, visibleCount);
        if (visible.length > 0) section.appendChild(makeFindingList(visible));

        const remainder = findings.slice(visibleCount);
        if (remainder.length > 0) {
          const more = makeElement("details", "more-results");
          more.appendChild(makeElement("summary", "", "Show " + formatNumber(remainder.length) + " more " + label.toLowerCase()));
          appendFindingsWhenOpened(more, remainder);
          section.appendChild(more);
        }
        sections.appendChild(section);
        return visibleCount;
      }

      function renderPassingLinks(findings) {
        if (findings.length === 0) return;
        const section = makeElement("section", "passing-section");
        const heading = makeElement("h2");
        heading.appendChild(makeElement("span", "", "Passing links"));
        heading.appendChild(makeElement("span", "section-count", formatNumber(findings.length)));
        section.appendChild(heading);
        const details = makeElement("details", "passing-results");
        details.appendChild(makeElement("summary", "", "Show passing link results"));
        appendFindingsWhenOpened(details, findings);
        section.appendChild(details);
        sections.appendChild(section);
      }

      function renderSections(findings) {
        sections.replaceChildren();
        let visibleBudget = MAX_VISIBLE_FINDINGS;
        visibleBudget -= renderFindingGroup(
          "Errors",
          findings.filter(function (finding) { return finding.severity === "error"; }),
          visibleBudget,
        );
        visibleBudget -= renderFindingGroup(
          "Warnings",
          findings.filter(function (finding) { return finding.severity === "warning"; }),
          visibleBudget,
        );
        renderFindingGroup(
          "Notes",
          findings.filter(function (finding) { return finding.severity === "info"; }),
          visibleBudget,
        );
        renderPassingLinks(findings.filter(function (finding) { return finding.severity === "success"; }));
      }

      function renderAction(overview, presentation) {
        const nextAction = asText(overview.next_action, "");
        action.hidden = !nextAction;
        if (!nextAction) return;
        actionLabel.textContent = presentation.state === "clean" ? "Next step" : "Fix first";
        actionCopy.textContent = nextAction;
      }

      function renderState(overview, presentation, findings, data) {
        const actionableCount = findings.filter(function (finding) { return finding.severity !== "success"; }).length;
        const passingCount = findings.length - actionableCount;
        state.hidden = true;
        state.removeAttribute("role");

        if (presentation.state === "failed" && actionableCount === 0) {
          state.dataset.tone = "error";
          stateSymbol.textContent = "!";
          stateTitle.textContent = "This check couldn’t finish";
          stateCopy.textContent = asText(data.error, overview.detail || "Try again shortly.");
          state.setAttribute("role", "alert");
          state.hidden = false;
          return;
        }

        if (presentation.state === "not_applicable") {
          state.dataset.tone = "info";
          stateSymbol.textContent = "—";
          stateTitle.textContent = "Nothing applicable to check";
          stateCopy.textContent = "The supplied content did not include applicable input for this check.";
          state.hidden = false;
          return;
        }

        if (actionableCount === 0 && presentation.state === "clean") {
          state.dataset.tone = "success";
          stateSymbol.textContent = "✓";
          stateTitle.textContent = passingCount > 0 ? "All returned checks passed" : "No issues found";
          stateCopy.textContent = passingCount > 0 ? "Passing results are available below for reference." : "There are no detailed findings to review.";
          state.hidden = false;
          return;
        }

        if (findings.length === 0 && presentation.state !== "partial") {
          state.dataset.tone = "info";
          stateSymbol.textContent = "i";
          stateTitle.textContent = "No detailed findings returned";
          stateCopy.textContent = overview.detail || "The summary above contains the available result.";
          state.hidden = false;
        }
      }

      function renderData(value) {
        const data = asObject(value);
        if (!data) return;
        latestRenderedPayload = data;

        const overview = normalizeOverview(data);
        const findings = collectFindings(data, overview.kind);
        const executionError = typeof data.error === "string" && Boolean(data.error.trim());
        const presentation = statusPresentation(overview.status, executionError);

        eyebrow.textContent = "Web Validator · " + (kindLabels[overview.kind] || humanizeKey(overview.kind));
        title.textContent = overview.title;
        statusChip.dataset.tone = presentation.tone;
        statusLabel.textContent = presentation.label;
        headline.textContent = overview.headline;
        detail.textContent = overview.detail;
        detail.hidden = !overview.detail || (presentation.state === "failed" && executionError);

        renderMetrics(overview);
        renderNotices(overview, presentation, data);
        renderAction(overview, presentation);
        renderState(overview, presentation, findings, data);
        renderSections(findings);

        app.setAttribute("aria-busy", "false");
        liveRegion.textContent = overview.title + ". " + overview.headline;
      }

      function applyGlobals(globals) {
        const value = asObject(globals);
        if (!value) return;
        if (value.theme === "light" || value.theme === "dark") {
          document.documentElement.dataset.theme = value.theme;
        }
        const nextLocale = typeof value.locale === "string" ? value.locale.trim() : "";
        const localeChanged = Boolean(nextLocale) && nextLocale !== currentLocale;
        if (localeChanged) currentLocale = nextLocale;
        if (!receivedPrimaryResult && value.toolOutput !== undefined) {
          renderData(value.toolOutput);
        } else if (localeChanged && latestRenderedPayload) {
          renderData(latestRenderedPayload);
        }
      }

      window.addEventListener("message", function (event) {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0" || message.method !== "ui/notifications/tool-result") return;
        receivedPrimaryResult = true;
        renderData(message.params && message.params.structuredContent);
      }, { passive: true });

      window.addEventListener("openai:set_globals", function (event) {
        applyGlobals(event.detail && event.detail.globals);
      }, { passive: true });

      applyGlobals(window.openai);
    </script>
  </body>
</html>`;
