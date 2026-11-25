import { defaultScreenshotBrowserRuntime, type ScreenshotBrowserRuntime } from "../../screenshot.js";
import { load } from "cheerio";
import { reduceAxeEvidence, unavailableAxeEvidence, type AxeSummary } from "./axe-review.js";

/** P1-12: bounded, browser-backed evidence from an inert, offline HTML sample. */
export const MAX_WCAG_HTML_BYTES = 180_000;
export const MAX_WCAG_CONTROLS = 120;
export const MAX_WCAG_TAB_STEPS = 24;
export const MAX_WCAG_FINDINGS = 12;
const DENY_ALL_PROXY = "http://127.0.0.1:9";
const CONTROL_SELECTOR =
  'a[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex],'
  + '[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="tab"],[role="menuitem"]';

export const WCAG_FINDING_CODES = [
  "missing_accessible_name",
  "positive_tabindex",
  "aria_hidden_focusable",
  "custom_role_not_keyboard_focusable",
  "potential_focus_indicator_absent",
  "focus_outside_viewport",
  "summary_enter_not_toggled",
] as const;
export type WcagFindingCode = typeof WCAG_FINDING_CODES[number];

export const WCAG_EVIDENCE_TYPES = ["rendered_dom", "keyboard_tab", "native_summary"] as const;
export type WcagEvidenceType = typeof WCAG_EVIDENCE_TYPES[number];

export interface WcagControlEvidence {
  index: number;
  visible: boolean;
  enabled: boolean;
  focusable: boolean;
  name_present: boolean;
  positive_tabindex: boolean;
  aria_hidden: boolean;
  custom_role_without_tab_stop: boolean;
}

export interface WcagFocusEvidence {
  index: number;
  outline_or_shadow_present: boolean;
  inside_viewport: boolean;
  opacity_zero: boolean;
  summary: boolean;
}

export interface WcagRenderedSnapshot {
  controls_seen: number;
  controls: WcagControlEvidence[];
  page_scripts_present: number;
}

export interface WcagFinding {
  code: WcagFindingCode;
  severity: "warning" | "info";
  evidence: WcagEvidenceType;
  control: number;
  message: string;
}

export interface WcagInteractionReview {
  scope: "offline_sandboxed_rendered_html";
  browser_executed: boolean;
  scripts_disabled: true;
  viewport_width: number;
  viewport_height: number;
  resources_blocked: number;
  scripts_present: number;
  controls_seen: number;
  controls_inspected: number;
  controls_truncated: boolean;
  visible_controls_without_name: number;
  positive_tabindex_controls: number;
  aria_hidden_focusable_controls: number;
  custom_roles_without_tab_stop: number;
  tab_steps: number;
  unique_tab_targets: number;
  focus_indicator_review_leads: number;
  focus_outside_viewport: number;
  native_summaries_tested: number;
  native_summaries_toggled: number;
  keyboard_sampling_incomplete: boolean;
  coverage_limited: true;
  limitations: string[];
  total_findings: number;
  findings: WcagFinding[];
  findings_truncated: boolean;
  axe?: AxeSummary;
  error?: string;
}

export interface WcagReviewOptions {
  viewportWidth?: number;
  viewportHeight?: number;
  maxTabSteps?: number;
  includeAxe?: boolean;
}

function boundedViewport(value: number | undefined, fallback: number, min: number, max: number): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < min || actual > max) {
    throw new Error("Unsupported WCAG viewport dimension");
  }
  return actual;
}

export function validateWcagInput(html: string, options: WcagReviewOptions = {}): {
  width: number; height: number; maxTabSteps: number;
} {
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new Error("Supply nonempty authorized HTML");
  }
  if (Buffer.byteLength(html, "utf8") > MAX_WCAG_HTML_BYTES) {
    throw new Error("HTML exceeds the WCAG byte limit");
  }
  const maxTabSteps = options.maxTabSteps ?? MAX_WCAG_TAB_STEPS;
  if (!Number.isSafeInteger(maxTabSteps) || maxTabSteps < 1 || maxTabSteps > MAX_WCAG_TAB_STEPS) {
    throw new Error("Unsupported keyboard sampling budget");
  }
  return {
    width: boundedViewport(options.viewportWidth, 960, 320, 1_440),
    height: boundedViewport(options.viewportHeight, 720, 360, 1_080),
    maxTabSteps,
  };
}

export function emptyWcagReview(options: WcagReviewOptions = {}): WcagInteractionReview {
  return {
    scope: "offline_sandboxed_rendered_html",
    browser_executed: false, scripts_disabled: true,
    viewport_width: options.viewportWidth ?? 960,
    viewport_height: options.viewportHeight ?? 720,
    resources_blocked: 0, scripts_present: 0,
    controls_seen: 0, controls_inspected: 0, controls_truncated: false,
    visible_controls_without_name: 0, positive_tabindex_controls: 0,
    aria_hidden_focusable_controls: 0, custom_roles_without_tab_stop: 0,
    tab_steps: 0, unique_tab_targets: 0, focus_indicator_review_leads: 0,
    focus_outside_viewport: 0, native_summaries_tested: 0,
    native_summaries_toggled: 0, keyboard_sampling_incomplete: false,
    coverage_limited: true,
    limitations: [
      "The inert Chromium accessibility evidence review could not complete; no browser verification is claimed.",
    ],
    total_findings: 0, findings: [], findings_truncated: false,
  };
}

/** Reduce only fixed-shape, no-content browser observations to deterministic findings. */
export function analyzeWcagEvidence(
  snapshot: WcagRenderedSnapshot,
  focusSamples: WcagFocusEvidence[],
  options: {
    viewportWidth: number; viewportHeight: number;
    resourcesBlocked?: number; tabSteps?: number;
    nativeSummariesTested?: number; nativeSummariesToggled?: number;
    keyboardIncomplete?: boolean;
  },
): WcagInteractionReview {
  const out = emptyWcagReview({
    viewportWidth: options.viewportWidth,
    viewportHeight: options.viewportHeight,
  });
  if (!Number.isSafeInteger(snapshot.controls_seen) || snapshot.controls_seen < 0
    || snapshot.controls.length > MAX_WCAG_CONTROLS
    || snapshot.controls_seen < snapshot.controls.length
    || focusSamples.length > MAX_WCAG_TAB_STEPS) {
    throw new Error("Invalid browser evidence bounds");
  }
  out.browser_executed = true;
  out.resources_blocked = Math.max(0, options.resourcesBlocked ?? 0);
  out.scripts_present = Math.max(0, snapshot.page_scripts_present);
  out.controls_seen = snapshot.controls_seen;
  out.controls_inspected = snapshot.controls.length;
  out.controls_truncated = snapshot.controls_seen > snapshot.controls.length;
  out.tab_steps = Math.min(options.tabSteps ?? focusSamples.length, MAX_WCAG_TAB_STEPS);
  out.native_summaries_tested = Math.min(1, options.nativeSummariesTested ?? 0);
  out.native_summaries_toggled = Math.min(out.native_summaries_tested, options.nativeSummariesToggled ?? 0);
  out.keyboard_sampling_incomplete = options.keyboardIncomplete ?? false;
  out.limitations = [
    "Only supplied HTML in a fresh, script-disabled, offline Chromium page was rendered; external styles, fonts, images, frames and dynamic JavaScript behavior were not loaded or executed.",
    "Only up to 120 DOM controls and 24 Tab steps at one viewport were sampled. This is not an exhaustive keyboard path, screen-reader test, accessibility-tree inspection or WCAG conformance assessment.",
    "Accessible names and focus visibility are conservative rendered-DOM/computed-style heuristics; CSS background/border indicators, occlusion and all assistive-technology semantics require manual review.",
    "Only a focused native <summary> may receive Enter. No links are activated, buttons clicked, form contents changed or submitted, or external resources requested by this tool.",
  ];
  const all: WcagFinding[] = [];
  function add(code: WcagFindingCode, severity: "warning" | "info",
    evidence: WcagEvidenceType, index: number, message: string) {
    all.push({ code, severity, evidence, control: index, message });
  }
  const inspected = new Set<number>();
  for (const item of snapshot.controls) {
    if (!Number.isSafeInteger(item.index) || item.index < 1
      || item.index > MAX_WCAG_CONTROLS || inspected.has(item.index)) {
      throw new Error("Invalid control evidence index");
    }
    inspected.add(item.index);
    if (!item.visible || !item.enabled) continue;
    if (!item.name_present) {
      out.visible_controls_without_name++;
      add("missing_accessible_name", "warning", "rendered_dom", item.index,
        "This visible control lacks a recognized accessible-name signal; verify the actual accessibility tree.");
    }
    if (item.positive_tabindex) {
      out.positive_tabindex_controls++;
      add("positive_tabindex", "warning", "rendered_dom", item.index,
        "A positive tabindex may reorder keyboard navigation; review intentional keyboard order.");
    }
    if (item.aria_hidden && item.focusable) {
      out.aria_hidden_focusable_controls++;
      add("aria_hidden_focusable", "warning", "rendered_dom", item.index,
        "A keyboard-focusable control is inside aria-hidden content; this may hide it from assistive technology.");
    }
    if (item.custom_role_without_tab_stop) {
      out.custom_roles_without_tab_stop++;
      add("custom_role_not_keyboard_focusable", "warning", "rendered_dom", item.index,
        "A custom interactive role has no native or declared Tab stop; check actual keyboard operation.");
    }
  }
  const unique = new Set<number>();
  for (const item of focusSamples) {
    if (!Number.isSafeInteger(item.index) || item.index < 1 || !inspected.has(item.index)
      || unique.has(item.index)) continue;
    unique.add(item.index);
    if ((!item.outline_or_shadow_present || item.opacity_zero)) {
      out.focus_indicator_review_leads++;
      add("potential_focus_indicator_absent", "info", "keyboard_tab", item.index,
        "After Tab, no computed outline/shadow or an opacity-zero state was observed; a different focus indicator may exist.");
    }
    if (!item.inside_viewport) {
      out.focus_outside_viewport++;
      add("focus_outside_viewport", "info", "keyboard_tab", item.index,
        "The sampled Tab focus target did not intersect the viewport; verify visibility and page scrolling.");
    }
  }
  out.unique_tab_targets = unique.size;
  if (out.native_summaries_tested && !out.native_summaries_toggled) {
    const summary = focusSamples.find((item) => item.summary);
    add("summary_enter_not_toggled", "warning", "native_summary", summary?.index ?? 1,
      "Enter did not toggle the sampled native details summary in the isolated browser.");
  }
  all.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1)
    || a.control - b.control || a.code.localeCompare(b.code));
  out.total_findings = all.length;
  out.findings = all.slice(0, MAX_WCAG_FINDINGS);
  out.findings_truncated = all.length > MAX_WCAG_FINDINGS;
  return out;
}

/**
 * Offline Chromium checks of supplied HTML: scripts disabled, network requests
 * aborted, no link clicks, no form submissions, no browser profile reuse.
 * The only Enter keypress is on a focused native HTML summary element.
 */
export async function reviewWcagInteractions(
  html: string,
  options: WcagReviewOptions = {},
  runtime: ScreenshotBrowserRuntime = defaultScreenshotBrowserRuntime,
): Promise<WcagInteractionReview> {
  const config = validateWcagInput(html, options);
  // Defense-in-depth: even with Chromium scripting explicitly disabled, do
  // not instantiate untrusted script, embedded frames or refresh navigation.
  const $ = load(html);
  const strippedScriptCount = $("script").length;
  $("script,iframe,frame,frameset,object,embed,portal").remove();
  $('meta[http-equiv="refresh" i]').remove();
  // axe runs as trusted local diagnostics only after author content is made inert.
  if (options.includeAxe) $('meta[http-equiv="Content-Security-Policy" i]').remove();
  $("*").each((_, element) => {
    if (!("attribs" in element) || !element.attribs) return;
    for (const name of Object.keys(element.attribs)) {
      if (/^on[a-z]+$/iu.test(name)) $(element).removeAttr(name);
    }
  });
  const inertHtml = $.html();
  let browser: Awaited<ReturnType<ScreenshotBrowserRuntime["launch"]>> | undefined;
  let pendingError: unknown;
  let browserDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // The pinned screenshot runtime launches a fresh sandboxed Chromium process.
    // Port 9 is deliberately not serviced: the transport cannot reach page URLs.
    browser = await runtime.launch(DENY_ALL_PROXY);
    // A hard deadline also covers keyboard/evaluation operations, which are
    // not governed by Puppeteer's navigation timeout.
    browserDeadline = setTimeout(() => {
      void browser?.close().catch(() => {});
    }, 20_000);
    browserDeadline.unref?.();
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    page.setDefaultNavigationTimeout(8_000);
    await page.setViewport({ width: config.width, height: config.height, deviceScaleFactor: 1 });
    await page.setJavaScriptEnabled(false);
    let blocked = 0;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      blocked++;
      void request.abort("blockedbyclient").catch(() => {});
    });
    await page.setContent(inertHtml, { waitUntil: "domcontentloaded", timeout: 8_000 });

    // All browser-side data is reduced to booleans/counts, never raw HTML/text,
    // attributes, CSS properties, input values, URLs, IDs or names.
    const snapshot = await page.evaluate((selector: string, cap: number) => {
      const dom = (globalThis as any).document;
      const compute = (globalThis as any).getComputedStyle;
      const all: any[] = Array.from(dom.querySelectorAll(selector));
      const controls: WcagControlEvidence[] = [];
      for (let i = 0; i < Math.min(all.length, cap); i++) {
        const element = all[i];
        const styles = compute(element);
        const box = element.getBoundingClientRect();
        const visible = styles.display !== "none" &&
          styles.visibility !== "hidden" && styles.visibility !== "collapse" &&
          box.width > 0 && box.height > 0 && !element.closest("[hidden],[inert]");
        const tag = String(element.tagName).toLowerCase();
        const type = String(element.getAttribute("type") ?? "").toLowerCase();
        const role = String(element.getAttribute("role") ?? "").toLowerCase();
        const native = ["button", "input", "select", "textarea", "a", "summary"].includes(tag);
        const customRole = ["button", "link", "checkbox", "switch", "tab", "menuitem"].includes(role);
        const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
        const describedBy = String(element.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/u).filter(Boolean).some((id) =>
            nonempty(dom.getElementById(id)?.textContent));
        const ariaLabel = nonempty(element.getAttribute("aria-label"));
        const associatedLabel = Boolean(element.labels &&
          Array.from(element.labels).some((label: any) => nonempty(label.textContent)));
        const labelWrapping = nonempty(element.closest("label")?.textContent);
        const title = nonempty(element.getAttribute("title"));
        const text = ["a", "button", "summary"].includes(tag) && nonempty(element.textContent);
        const alt = ["a", "button"].includes(tag) &&
          Array.from(element.querySelectorAll("img")).some((image: any) => nonempty(image.getAttribute("alt")));
        const inputAlt = tag === "input" && type === "image" && nonempty(element.getAttribute("alt"));
        // Submit/reset have user-agent default names; input[type=button]
        // without a value does not have that same fallback.
        const nativeSubmit = tag === "input" && (["submit", "reset"].includes(type)
          || (type === "button" && nonempty(element.value)));
        controls.push({
          index: i + 1,
          visible: Boolean(visible),
          enabled: !element.disabled && !element.closest("fieldset[disabled]"),
          focusable: visible && element.tabIndex >= 0,
          name_present: Boolean(describedBy || ariaLabel || associatedLabel ||
            labelWrapping || title || text || alt || inputAlt || nativeSubmit),
          positive_tabindex: element.tabIndex > 0,
          aria_hidden: Boolean(element.closest('[aria-hidden="true" i]')),
          custom_role_without_tab_stop: Boolean(customRole && !native && element.tabIndex < 0),
        });
      }
      return {
        controls_seen: all.length,
        controls,
        page_scripts_present: dom.querySelectorAll("script").length,
      } as WcagRenderedSnapshot;
    }, CONTROL_SELECTOR, MAX_WCAG_CONTROLS);
    snapshot.page_scripts_present += strippedScriptCount;

    const samples: WcagFocusEvidence[] = [];
    const focused = new Set<number>();
    let tabSteps = 0;
    let keyboardIncomplete = false;
    let summaryIndex: number | undefined;
    // Autofocus in supplied markup should not skip the first Tab stop.
    await page.evaluate(() => { (globalThis as any).document.activeElement?.blur?.(); });
    try {
      const maxSteps = Math.min(config.maxTabSteps, Math.max(2, snapshot.controls_seen + 1));
      for (let i = 0; i < maxSteps; i++) {
        await page.keyboard.press("Tab");
        tabSteps++;
        const entry = await page.evaluate((selector: string, cap: number) => {
          const dom = (globalThis as any).document;
          const compute = (globalThis as any).getComputedStyle;
          const current = dom.activeElement;
          if (!current) return null;
          const all: any[] = Array.from(dom.querySelectorAll(selector));
          const index = all.indexOf(current) + 1;
          if (index < 1 || index > cap) return null;
          const style = compute(current);
          const rect = current.getBoundingClientRect();
          const outline = style.outlineStyle !== "none" &&
            Number.parseFloat(style.outlineWidth) > 0;
          const shadow = style.boxShadow && style.boxShadow !== "none";
          const viewportWidth = (globalThis as any).innerWidth;
          const viewportHeight = (globalThis as any).innerHeight;
          return {
            index,
            outline_or_shadow_present: Boolean(outline || shadow),
            inside_viewport: Boolean(rect.width > 0 && rect.height > 0 &&
              rect.bottom > 0 && rect.right > 0 &&
              rect.left < viewportWidth && rect.top < viewportHeight),
            opacity_zero: Number.parseFloat(style.opacity) === 0,
            summary: String(current.tagName).toLowerCase() === "summary",
          } as WcagFocusEvidence;
        }, CONTROL_SELECTOR, MAX_WCAG_CONTROLS);
        if (!entry) {
          // The browser has left the sampled control set or no focus occurred.
          if (snapshot.controls_seen > MAX_WCAG_CONTROLS) keyboardIncomplete = true;
          break;
        }
        if (focused.has(entry.index)) break; // Wraparound is not a trap.
        focused.add(entry.index);
        samples.push(entry);
        if (entry.summary && summaryIndex === undefined) {
          summaryIndex = entry.index;
        }
      }
    } catch {
      keyboardIncomplete = true;
    }

    let summariesTested = 0;
    let summariesToggled = 0;
    if (summaryIndex !== undefined) {
      try {
        // Only focus the *same* native summary reached by Tab, not an unrelated
        // earlier summary that might be hidden or nested in an inactive widget.
        const summaryReady = await page.evaluate((selector: string, index: number) => {
          const dom = (globalThis as any).document;
          const s: any = dom.querySelectorAll(selector)[index - 1];
          if (!s || String(s.tagName).toLowerCase() !== "summary"
            || String(s.parentElement?.tagName).toLowerCase() !== "details") return false;
          (s as any).focus();
          return dom.activeElement === s;
        }, CONTROL_SELECTOR, summaryIndex);
        if (summaryReady) {
          summariesTested = 1;
          const before = await page.evaluate(() =>
            Boolean((globalThis as any).document.activeElement?.closest("details")?.open));
          await page.keyboard.press("Enter");
          const after = await page.evaluate(() =>
            Boolean((globalThis as any).document.activeElement?.closest("details")?.open));
          summariesToggled = before !== after ? 1 : 0;
        }
      } catch {
        keyboardIncomplete = true;
      }
    }
    const result = analyzeWcagEvidence(snapshot, samples, {
      viewportWidth: config.width, viewportHeight: config.height,
      resourcesBlocked: blocked, tabSteps,
      nativeSummariesTested: summariesTested,
      nativeSummariesToggled: summariesToggled,
      keyboardIncomplete,
    });
    if (options.includeAxe) {
      result.axe = unavailableAxeEvidence();
      try {
        const engine = await import("axe-core");
        // Author scripts and event attributes are gone; only our pinned local
        // axe source executes, with the deny-all network interceptor still on.
        await page.setJavaScriptEnabled(true);
        await page.evaluate(engine.default.source);
        const raw = await page.evaluate(async () => {
          const axe = (globalThis as any).axe;
          if (!axe || typeof axe.run !== "function") throw new Error("axe unavailable");
          const scan = await axe.run((globalThis as any).document, {
            runOnly: { type: "tag", values: [
              "wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa",
            ] },
            resultTypes: ["violations", "incomplete"],
          });
          return {
            version: axe.version,
            // Never move user DOM, selectors, URLs, names or HTML across CDP.
            violations: scan.violations.map((v: any) => ({
              id: v.id, impact: v.impact, nodes: v.nodes?.length ?? 0,
            })),
            incomplete: scan.incomplete.map(() => 0),
          };
        });
        result.axe = reduceAxeEvidence(raw);
      } catch {
        // A missing optional package or failed automation is not a clean pass.
        result.axe = unavailableAxeEvidence();
      }
    }
    return result;
  } catch (cause) {
    pendingError = cause;
    throw cause;
  } finally {
    if (browserDeadline) clearTimeout(browserDeadline);
    try {
      if (browser) await browser.close();
    } catch (cause) {
      if (!pendingError) throw cause;
    }
  }
}
