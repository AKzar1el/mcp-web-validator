# V09 — Mobile/desktop rendering and interaction parity

V09 is a local-only, bounded diagnostic for comparing **the same authorized HTML document** in two isolated Chromium viewports. Google uses mobile-first indexing and recommends equivalent primary content, headings, important links, robots directives, metadata, images and structured data between mobile and desktop experiences; a mobile visual difference does **not** by itself prove a Google indexing or ranking problem.

## MCP entry point

Local Node/stdio: \`browser.viewport_parity\`

Modes:

1. \`supplied_html\`: pass \`page_url\` and \`html\` already obtained through an authorized source. No website request is made. The same inert HTML is rendered twice with its inline styles (including CSS media queries), but all JavaScript and external resources are disabled.
2. \`public_html\`: pass a safe query-free public \`url\`. Reuse V07's guarded public HTML fetch: one robots.txt request and, only if explicitly allowed, a single HTTP 200 text/html GET with DNS-pinned public-address protection and **no redirects**. Then compare the same HTML in the two isolated viewports.

### Example

\`\`\`json
{
  "mode": "supplied_html",
  "page_url": "https://example.com/",
  "html": "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Sample</title><style>@media(max-width:600px){nav{display:none}}</style></head><body><nav><a href=\"/guide\">Guide</a></nav><main><h1>Sample</h1><details><summary>More</summary><p>Details</p></details></main></body></html>"
}
\`\`\`

### Fixed browser settings

| Evidence | Mobile | Desktop |
| --- | --- | --- |
| CSS viewport | 375 × 812 | 1440 × 900 |
| Device scale | 2 | 1 |
| Mobile viewport emulation | Enabled | Disabled |
| Touch support | Enabled | Disabled |
| Page JavaScript | Disabled | Disabled |
| External CSS/JS/images/fonts/API | Aborted | Aborted |
| Browser process | Same fresh sandboxed Chromium; separate page per viewport | Same |

No Googlebot impersonation, user login, browser history, persistent storage, screenshots, form submissions, link activation or arbitrary button clicks are used. The **only native interaction performed** is an optional touch-tap on a visible \`<details><summary>\` in the mobile view and Enter on the desktop summary, with script execution disabled. Up to 12 real Tab focus steps per viewport are observed without activating controls.

## What the report means

The fixed, redacted output measures:

- Whether title, description, first H1, canonical hints, noindex declarations and JSON-LD block counts agree; **equivalence of counts is not validation of structured-data payload correctness**.
- Main-text tokens present in each DOM versus *visibly rendered* with computed CSS. CSS-hidden mobile text is **not** reported as missing from the DOM. Hidden tab or accordion content may be intentional and can still be relevant to indexing.
- Up to 120 same-origin, query-free internal anchor targets and visible/navigation subsets. A collapsed mobile menu that keeps links in the DOM is **not** reported as missing page links; visible navigation differences are informational.
- Horizontal overflow against the **requested physical CSS viewport width**, including cases where mobile emulation expands \`window.innerWidth\` to fit oversized elements. This is a review lead, not a verified visitor experience when external resources are blocked.
- Up to 120 inspected interactive controls, 12 Tab targets, presence of native summary toggle, and controls with a bounding-box width/height below 24 CSS pixels. Small targets are informational; WCAG spacing exemptions and actual usability are **not** certified.

Full-resource, fully hydrated mobile versus desktop rendering requires a separately authorized browser/resource-loading workflow. V09 deliberately does **not** load a site framework, third-party CSS, API data, lazy-loaded interactive elements or dynamically served mobile-specific documents. It cannot establish Google Web Rendering Service behavior, indexed content, Core Web Vitals or search-ranking causality.

## Bounds and privacy

- One supplied page, maximum 400,000 UTF-8 bytes of HTML; each view independently samples at most 4,000 text tokens, 120 anchor hrefs, 120 controls and 12 keyboard Tab steps.
- At most 16 fixed diagnostic findings. Output contains only statuses, booleans, bounded counts and generic explanations; it never echoes supplied HTML, page URLs, titles, headings, tokens, link paths, attributes, secret strings or browser errors.
- Uses pinned sandboxed Chromium, denies all browser network requests, removes executable scripts, embedded frames, unsafe event handlers and meta refresh before rendering. Inert JSON-LD script blocks are retained for metadata-count comparison.
- A 25-second browser deadline limits stalled samples; unknown evidence remains unknown rather than being labeled a passing SEO or WCAG audit.
- A public HTML sample has separate robots authorization and a bounded full-document GET. No background scheduler, GSC, GA4 or live website writes.

References: [Google Mobile-first indexing](https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing), [Puppeteer setViewport](https://pptr.dev/api/puppeteer.page.setviewport), [Puppeteer viewport configuration](https://pptr.dev/api/puppeteer.viewport).

## Acceptance gates

Pure analyzer tests for metadata parity, genuinely missing vs CSS-hidden content, collapsed navigation, overflow, limited interaction evidence, privacy and malformed inputs. Real Chromium rendering with CSS media queries and safe details tap/Enter. Actual stdio MCP list/call, public robots-gated canary when feasible, complete local and hosted regression suites, fresh installed npm tarball smoke, manifest sync/check, Worker dry-run, code review and squash merge. GitHub merge does not deploy the hosted Worker.
