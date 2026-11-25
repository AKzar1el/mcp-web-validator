/**
 * V09 local-only: compare bounded observed mobile/desktop Chromium viewports.
 * Browser collection is separate from this deterministic redacted analyzer.
 * Google WRS, dynamic JS hydration and actual indexing are NOT inferred.
 */
import { safeLinkPageUrl } from "../site-architecture/internal-link-quality.js";

export const MAX_PARITY_HTML_BYTES = 400_000;
export const MAX_PARITY_WORDS = 4_000;
export const MAX_PARITY_LINKS = 120;
export const MAX_PARITY_CONTROLS = 120;
export const MAX_PARITY_TAB_STEPS = 12;
export const MAX_PARITY_FINDINGS = 16;
export const MAX_PARITY_BROWSER_MS = 25_000;
export const MOBILE_VIEWPORT = { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true } as const;
export const DESKTOP_VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false } as const;

export const PARITY_FINDING_CODES = [
  "mobile_viewport_meta_missing", "mobile_horizontal_overflow",
  "mobile_title_missing", "mobile_description_missing",
  "title_mismatch", "description_mismatch", "mobile_h1_missing", "h1_mismatch",
  "mobile_main_text_less", "mobile_visible_main_text_less",
  "mobile_content_visibility_gap", "mobile_navigation_less",
  "mobile_links_less", "mobile_canonical_mismatch", "mobile_robots_mismatch",
  "mobile_structured_data_less", "mobile_controls_less",
  "mobile_keyboard_targets_less", "mobile_small_targets",
  "native_disclosure_parity", "resource_loads_blocked", "sample_limited",
] as const;
export type ParityFindingCode = typeof PARITY_FINDING_CODES[number];
export type ParityScope = "isolated_supplied_html_viewports" | "isolated_public_html_viewports";

export interface ViewportEvidence {
  width: number;
  height: number;
  effective_layout_width: number;
  viewport_meta_present: boolean;
  title: string;
  description: string;
  first_h1: string;
  h1_count: number;
  main_dom_words: string[];
  main_visible_words: string[];
  same_origin_links: string[];
  visible_links: string[];
  visible_nav_links: string[];
  canonical: string | "unverified" | null;
  noindex: boolean;
  jsonld_blocks: number;
  controls_seen: number;
  visible_controls: number;
  keyboard_focusable_controls: number;
  small_visible_controls: number;
  observed_keyboard_targets: number;
  keyboard_incomplete: boolean;
  disclosure_toggled: boolean | null;
  horizontal_overflow_px: number;
  sample_truncated: boolean;
}

export interface ViewportSummary {
  width: number;
  height: number;
  effective_layout_width: number;
  viewport_meta_present: boolean;
  title_present: boolean;
  description_present: boolean;
  h1_count: number;
  main_dom_words: number;
  main_visible_words: number;
  internal_links: number;
  visible_links: number;
  visible_nav_links: number;
  canonical: "missing" | "self" | "different" | "unverified";
  noindex_declared: boolean;
  jsonld_blocks: number;
  controls_seen: number;
  visible_controls: number;
  keyboard_focusable_controls: number;
  small_visible_controls: number;
  observed_keyboard_targets: number;
  keyboard_incomplete: boolean;
  disclosure_toggled: boolean | null;
  horizontal_overflow_px: number;
  sample_truncated: boolean;
}
export interface ParityFinding {
  code: ParityFindingCode;
  severity: "warning" | "info";
  count: number;
  message: string;
}
export interface ViewportParityReview {
  scope: ParityScope;
  browser_executed: boolean;
  scripts_disabled: true;
  mobile: ViewportSummary;
  desktop: ViewportSummary;
  titles_equivalent: boolean;
  descriptions_equivalent: boolean;
  h1_equivalent: boolean;
  canonicals_equivalent: boolean;
  robots_equivalent: boolean;
  structured_data_count_equivalent: boolean;
  mobile_missing_dom_tokens: number;
  mobile_missing_visible_tokens: number;
  mobile_missing_internal_links: number;
  mobile_missing_visible_links: number;
  blocked_resources: number;
  coverage_limited: true;
  limitations: string[];
  total_findings: number;
  findings: ParityFinding[];
  findings_truncated: boolean;
  error?: string;
}

const limitations = [
  "Two fixed Chromium viewport samples of one supplied/public HTML document are compared; this is not a Googlebot smartphone render, mobile-first indexing verdict, or full-site audit.",
  "All page JavaScript and external CSS, fonts, images and API resources are disabled in the isolated browser; media queries in inline styles are evaluated, but hydrated layouts are not.",
  "A mobile-hidden menu can be intentional responsive navigation; links and text hidden only with CSS may still exist in the DOM. Differences are review leads, not proven SEO or WCAG failures.",
  "Keyboard samples and one safe native disclosure toggle are limited; no arbitrary buttons/links are activated, no forms submitted, no screenshots stored, and no page text or URLs returned.",
];
const nonnegative = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 100_000;
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const normalized = (s: string) => s.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/gu," ").trim();
function checkEvidence(x: ViewportEvidence, target: "mobile" | "desktop"): void {
  const vp = target === "mobile" ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT;
  if (!x || typeof x !== "object" || x.width !== vp.width || x.height !== vp.height ||
    !nonnegative(x.effective_layout_width) || x.effective_layout_width > 5_000 ||
    typeof x.viewport_meta_present !== "boolean" ||
    typeof x.noindex !== "boolean" || typeof x.keyboard_incomplete !== "boolean" ||
    typeof x.sample_truncated !== "boolean" ||
    (x.disclosure_toggled !== null && typeof x.disclosure_toggled !== "boolean") ||
    !["title","description","first_h1"].every((k) =>
      typeof x[k as keyof ViewportEvidence] === "string" &&
      bytes(x[k as "title" | "description" | "first_h1"] as string) <= 1_024) ||
    ![x.h1_count, x.jsonld_blocks, x.controls_seen, x.visible_controls,
      x.keyboard_focusable_controls, x.small_visible_controls,
      x.observed_keyboard_targets, x.horizontal_overflow_px].every(nonnegative) ||
    x.visible_controls > x.controls_seen ||
    x.keyboard_focusable_controls > x.controls_seen ||
    x.small_visible_controls > x.visible_controls ||
    x.observed_keyboard_targets > MAX_PARITY_TAB_STEPS ||
    !Array.isArray(x.main_dom_words) || x.main_dom_words.length > MAX_PARITY_WORDS ||
    !Array.isArray(x.main_visible_words) || x.main_visible_words.length > MAX_PARITY_WORDS ||
    ![x.main_dom_words, x.main_visible_words].every((arr) => arr.every((w) =>
      typeof w === "string" && w.length > 0 && w.length <= 60 &&
      !/[\u0000-\u001f\u007f]/u.test(w))) ||
    ![x.same_origin_links, x.visible_links, x.visible_nav_links].every((arr) =>
      Array.isArray(arr) && arr.length <= MAX_PARITY_LINKS &&
      arr.every((url) => typeof url === "string" && bytes(url) <= 512 &&
        Boolean(safeLinkPageUrl(url)))) ||
    (x.canonical !== null && x.canonical !== "unverified" &&
      (typeof x.canonical !== "string" ||
        bytes(x.canonical) > 512 || !safeLinkPageUrl(x.canonical)))) {
    throw new Error("Invalid bounded " + target + " browser evidence.");
  }
}
function tokensWithout(a: string[], b: string[]) {
  const compared = new Set(b);
  return new Set(a.filter((word) => !compared.has(word))).size;
}
function uniqueWithout(a: string[], b: string[]) {
  const compared = new Set(b);
  return new Set(a.filter((url) => !compared.has(url))).size;
}
const summary = (e: ViewportEvidence, pageUrl: string): ViewportSummary => ({
  width: e.width, height: e.height,
  effective_layout_width: e.effective_layout_width,
  viewport_meta_present: e.viewport_meta_present,
  title_present: Boolean(e.title.trim()),
  description_present: Boolean(e.description.trim()),
  h1_count: e.h1_count, main_dom_words: e.main_dom_words.length,
  main_visible_words: e.main_visible_words.length,
  internal_links: new Set(e.same_origin_links).size,
  visible_links: new Set(e.visible_links).size,
  visible_nav_links: new Set(e.visible_nav_links).size,
  canonical: e.canonical === "unverified" ? "unverified" :
    !e.canonical ? "missing" :
    e.canonical === pageUrl ? "self" :
      safeLinkPageUrl(e.canonical) ? "different" : "unverified",
  noindex_declared: e.noindex, jsonld_blocks: e.jsonld_blocks,
  controls_seen: e.controls_seen,
  visible_controls: e.visible_controls,
  keyboard_focusable_controls: e.keyboard_focusable_controls,
  small_visible_controls: e.small_visible_controls,
  observed_keyboard_targets: e.observed_keyboard_targets,
  keyboard_incomplete: e.keyboard_incomplete,
  disclosure_toggled: e.disclosure_toggled,
  horizontal_overflow_px: e.horizontal_overflow_px,
  sample_truncated: e.sample_truncated,
});
function emptySummary(width: number, height: number): ViewportSummary {
  return {
    width, height, effective_layout_width: width,
    viewport_meta_present: false, title_present: false,
    description_present: false, h1_count: 0, main_dom_words: 0,
    main_visible_words: 0, internal_links: 0, visible_links: 0,
    visible_nav_links: 0, canonical: "unverified", noindex_declared: false,
    jsonld_blocks: 0, controls_seen: 0, visible_controls: 0,
    keyboard_focusable_controls: 0, small_visible_controls: 0,
    observed_keyboard_targets: 0, keyboard_incomplete: true,
    disclosure_toggled: null, horizontal_overflow_px: 0,
    sample_truncated: false,
  };
}
export function emptyViewportParityReview(
  scope: ParityScope = "isolated_supplied_html_viewports",
): ViewportParityReview {
  return {
    scope, browser_executed: false, scripts_disabled: true,
    mobile: emptySummary(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height),
    desktop: emptySummary(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height),
    titles_equivalent: false, descriptions_equivalent: false,
    h1_equivalent: false, canonicals_equivalent: false,
    robots_equivalent: false, structured_data_count_equivalent: false,
    mobile_missing_dom_tokens: 0, mobile_missing_visible_tokens: 0,
    mobile_missing_internal_links: 0, mobile_missing_visible_links: 0,
    blocked_resources: 0, coverage_limited: true, limitations,
    total_findings: 0, findings: [], findings_truncated: false,
  };
}
export function analyzeViewportParity(
  pageUrl: string, mobile: ViewportEvidence, desktop: ViewportEvidence,
  opts: { scope?: ParityScope; blockedResources?: number } = {},
): ViewportParityReview {
  const url = safeLinkPageUrl(pageUrl);
  if (!url) throw new Error("Use one safe same-origin query-free HTTP(S) page URL.");
  checkEvidence(mobile, "mobile");
  checkEvidence(desktop, "desktop");
  const origin = new URL(url).origin;
  for (const sample of [mobile, desktop]) {
    for (const label of [
      ...sample.same_origin_links, ...sample.visible_links, ...sample.visible_nav_links,
    ]) {
      if (new URL(label).origin !== origin) {
        throw new Error("Viewport link evidence must stay within the declared page origin.");
      }
    }
  }
  const report = emptyViewportParityReview(opts.scope);
  report.browser_executed = true;
  if (opts.blockedResources !== undefined &&
    (!nonnegative(opts.blockedResources) || opts.blockedResources > 1_000)) {
    throw new Error("Invalid bounded blocked-resource count.");
  }
  report.blocked_resources = opts.blockedResources ?? 0;
  report.mobile = summary(mobile, url);
  report.desktop = summary(desktop, url);
  report.titles_equivalent = normalized(mobile.title) === normalized(desktop.title);
  report.descriptions_equivalent = normalized(mobile.description) === normalized(desktop.description);
  report.h1_equivalent = mobile.h1_count === desktop.h1_count &&
    normalized(mobile.first_h1) === normalized(desktop.first_h1);
  report.canonicals_equivalent = mobile.canonical === desktop.canonical;
  report.robots_equivalent = mobile.noindex === desktop.noindex;
  report.structured_data_count_equivalent = mobile.jsonld_blocks === desktop.jsonld_blocks;
  report.mobile_missing_dom_tokens = tokensWithout(desktop.main_dom_words, mobile.main_dom_words);
  report.mobile_missing_visible_tokens = tokensWithout(desktop.main_visible_words, mobile.main_visible_words);
  report.mobile_missing_internal_links = uniqueWithout(desktop.same_origin_links, mobile.same_origin_links);
  report.mobile_missing_visible_links = uniqueWithout(desktop.visible_links, mobile.visible_links);

  const all: ParityFinding[] = [];
  const add = (code: ParityFindingCode, severity: "warning" | "info", count: number, message: string) => {
    if (count > 0) all.push({ code, severity, count, message });
  };
  if (!mobile.viewport_meta_present) add("mobile_viewport_meta_missing", "info", 1,
    "No responsive viewport meta declaration was observed; the mobile layout viewport may be wider than the device.");
  if (mobile.horizontal_overflow_px > 20) add("mobile_horizontal_overflow", "warning",
    mobile.horizontal_overflow_px, "Mobile layout extends horizontally beyond its effective viewport; inspect responsive overflow.");
  if (desktop.title.trim() && !mobile.title.trim()) add("mobile_title_missing", "warning", 1,
    "Mobile viewport lacks the page title present on desktop.");
  else if (!report.titles_equivalent) add("title_mismatch", "warning", 1,
    "Mobile and desktop title declarations differ.");
  if (desktop.description.trim() && !mobile.description.trim()) add("mobile_description_missing", "warning", 1,
    "Mobile viewport lacks the meta description observed on desktop.");
  else if (!report.descriptions_equivalent) add("description_mismatch", "info", 1,
    "Mobile and desktop meta description declarations differ.");
  if (desktop.h1_count > 0 && mobile.h1_count === 0) add("mobile_h1_missing", "warning", 1,
    "Mobile DOM lacks an H1 present on desktop.");
  else if (!report.h1_equivalent) add("h1_mismatch", "info", 1,
    "Mobile and desktop H1 structure or first heading differs.");
  if ((report.mobile_missing_dom_tokens >= 12 && desktop.main_dom_words.length >= 20) ||
    (report.mobile_missing_dom_tokens >= 4 && desktop.main_dom_words.length >= 8 &&
      mobile.main_dom_words.length * 2 <= desktop.main_dom_words.length))
    add("mobile_main_text_less", "warning", report.mobile_missing_dom_tokens,
      "Some distinct main-content words present on desktop are absent from the mobile DOM sample.");
  if (report.mobile_missing_visible_tokens >= 12 && desktop.main_visible_words.length >= 20)
    add("mobile_visible_main_text_less", "info", report.mobile_missing_visible_tokens,
      "Some main-content words visibly present on desktop were not visibly rendered at the mobile viewport.");
  if (mobile.main_dom_words.length >= 20 &&
    mobile.main_visible_words.length < Math.floor(mobile.main_dom_words.length * 0.5))
    add("mobile_content_visibility_gap", "info",
      mobile.main_dom_words.length - mobile.main_visible_words.length,
      "Most sampled mobile DOM words are not visually exposed at this viewport; CSS hiding or disclosures may be intentional.");
  if (desktop.visible_nav_links.length > mobile.visible_nav_links.length)
    add("mobile_navigation_less", "info",
      desktop.visible_nav_links.length - mobile.visible_nav_links.length,
      "Fewer navigation links are visible on mobile; check whether a collapsed menu exposes them without relying on scripting.");
  if (report.mobile_missing_internal_links)
    add("mobile_links_less", "warning", report.mobile_missing_internal_links,
      "Some same-origin link targets exist on desktop but not in the mobile DOM snapshot.");
  if (!report.canonicals_equivalent)
    add("mobile_canonical_mismatch", "warning", 1,
      "Mobile and desktop canonical preferences differ; check the effective HTML declarations.");
  if (!report.robots_equivalent)
    add("mobile_robots_mismatch", "warning", 1,
      "Mobile and desktop robots noindex signals differ; check intended indexing behavior.");
  if (mobile.jsonld_blocks < desktop.jsonld_blocks)
    add("mobile_structured_data_less", "info", desktop.jsonld_blocks - mobile.jsonld_blocks,
      "Fewer JSON-LD blocks are present in the mobile DOM; validate each version's structured data separately.");
  if (mobile.visible_controls < desktop.visible_controls)
    add("mobile_controls_less", "info", desktop.visible_controls - mobile.visible_controls,
      "Fewer interactive controls are visible on mobile; responsive UI differences may be intentional.");
  if (mobile.observed_keyboard_targets < desktop.observed_keyboard_targets)
    add("mobile_keyboard_targets_less", "info",
      desktop.observed_keyboard_targets - mobile.observed_keyboard_targets,
      "A smaller number of Tab targets was observed on mobile in this short isolated keyboard sample.");
  if (mobile.small_visible_controls)
    add("mobile_small_targets", "info", mobile.small_visible_controls,
      "Some mobile controls are under 24 CSS pixels in width or height; spacing exemptions and WCAG conformance were not assessed.");
  if (mobile.disclosure_toggled === false || desktop.disclosure_toggled === false)
    add("native_disclosure_parity", "warning", 1,
      "An inspected native details disclosure did not toggle in one viewport; verify behavior independently.");
  if (report.blocked_resources)
    add("resource_loads_blocked", "info", report.blocked_resources,
      "External resource requests were blocked by this diagnostic, so framework hydration and external styles are unknown.");
  if (mobile.sample_truncated || desktop.sample_truncated ||
    mobile.keyboard_incomplete || desktop.keyboard_incomplete)
    add("sample_limited", "info", 1,
      "A DOM, control or keyboard sample reached a fixed evidence limit or remained incomplete.");
  all.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1)
    || a.code.localeCompare(b.code));
  report.total_findings = all.length;
  report.findings = all.slice(0, MAX_PARITY_FINDINGS);
  report.findings_truncated = all.length > MAX_PARITY_FINDINGS;
  return report;
}
