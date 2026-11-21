/**
 * V09 local-only browser comparator. Same sanitized HTML, separate mobile and
 * desktop pages, fixed viewports, scripts disabled and deny-all transport.
 * Only a native summary may receive Enter/tap; no links or forms activated.
 */
import { load } from "cheerio";
import {
  defaultScreenshotBrowserRuntime, type ScreenshotBrowserRuntime,
} from "../../screenshot.js";
import { safeHttpResourceUrl } from "../http-crawl/non-html-directives.js";
import { fetchGuardedPublicHtml } from "./raw-rendered-probe.js";
import {
  analyzeViewportParity, MAX_PARITY_HTML_BYTES, MAX_PARITY_BROWSER_MS,
  MOBILE_VIEWPORT, DESKTOP_VIEWPORT, MAX_PARITY_CONTROLS,
  MAX_PARITY_LINKS, MAX_PARITY_TAB_STEPS, MAX_PARITY_WORDS,
  type ViewportEvidence, type ViewportParityReview, type ParityScope,
} from "./viewport-parity.js";

const DENY_ALL_PROXY = "http://127.0.0.1:9";
const CONTROL_SELECTOR =
  'a[href],button,input:not([type="hidden"]),select,textarea,summary,'
  + '[tabindex],[role="button"],[role="link"],[role="checkbox"],[role="switch"]';
const textBytes = (s: string) => new TextEncoder().encode(s).byteLength;
const normalizedMarkup = (raw: string): string => {
  const $ = load(raw);
  $("script").filter((_, el) => {
    const type = ($(el).attr("type") ?? "").trim().toLowerCase();
    // Structured data is inert JSON, not executable JavaScript. Retain it for
    // equivalent mobile/desktop SEO metadata counts.
    return type !== "application/ld+json" && type !== "application/json";
  }).remove();
  $("iframe,frame,frameset,object,embed,portal").remove();
  $('meta[http-equiv="refresh" i]').remove();
  $("*").each((_, element) => {
    if (!("attribs" in element) || !element.attribs) return;
    for (const name of Object.keys(element.attribs)) {
      if (/^on[a-z]+$/iu.test(name)) $(element).removeAttr(name);
    }
  });
  return $.html();
};

export async function inspectViewportParity(
  html: string, pageUrl: string,
  runtime: ScreenshotBrowserRuntime = defaultScreenshotBrowserRuntime,
  scope: ParityScope = "isolated_supplied_html_viewports",
): Promise<ViewportParityReview> {
  if (!safeHttpResourceUrl(pageUrl) || typeof html !== "string" ||
    !html.trim() || textBytes(html) > MAX_PARITY_HTML_BYTES) {
    throw new Error("Provide one safe public URL label and HTML within the 400 KB byte limit.");
  }
  const safeMarkup = normalizedMarkup(html);
  if (textBytes(safeMarkup) > MAX_PARITY_HTML_BYTES) {
    throw new Error("The normalized HTML exceeded the bounded viewport input size.");
  }
  let browser: Awaited<ReturnType<ScreenshotBrowserRuntime["launch"]>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingFailure: unknown;
  let blocked = 0;
  try {
    browser = await runtime.launch(DENY_ALL_PROXY);
    timer = setTimeout(() => { void browser?.close().catch(() => {}); },
      MAX_PARITY_BROWSER_MS);
    timer.unref?.();
    const samples: ViewportEvidence[] = [];

    for (const [kind, vp] of [
      ["mobile", MOBILE_VIEWPORT], ["desktop", DESKTOP_VIEWPORT],
    ] as const) {
      const page = await browser.newPage();
      page.setDefaultTimeout(5_000);
      page.setDefaultNavigationTimeout(8_000);
      // Viewports must be configured before HTML is parsed: isMobile affects
      // meta viewport behavior, touch/scale and CSS media query evaluation.
      await page.setViewport({ ...vp });
      await page.setJavaScriptEnabled(false);
      await page.setOfflineMode(true);
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        blocked++;
        void request.abort("blockedbyclient").catch(() => {});
      });
      await page.setContent(safeMarkup, {
        waitUntil: "domcontentloaded", timeout: 8_000,
      });
      const snapshot: ViewportEvidence = await page.evaluate((
        url: string, selector: string, wordCap: number,
        linkCap: number, controlCap: number, requestedWidth: number,
      ) => {
        const dom: any = (globalThis as any).document;
        const win: any = globalThis as any;
        const compute: any = win.getComputedStyle;
        const withinViewport = (el: any): boolean => {
          if (!el || el.closest("[hidden],[inert],[aria-hidden='true']")) return false;
          const s = compute(el);
          const r = el.getBoundingClientRect();
          return s.display !== "none" &&
            s.visibility !== "hidden" && s.visibility !== "collapse" &&
            Number.parseFloat(s.opacity || "1") > 0 &&
            r.width > 0 && r.height > 0;
        };
        const words = (text: string): string[] =>
          (text.normalize("NFKC").toLocaleLowerCase("en")
            .match(/[\p{L}\p{N}]+/gu) ?? [])
            .filter((token) => token.length >= 2 && token.length <= 60)
            .slice(0, wordCap);
        const title = String(dom.querySelector("head title")?.textContent ?? "")
          .replace(/\s+/gu, " ").trim().slice(0, 256);
        const desc = String(dom.querySelector('head meta[name="description" i]')
          ?.getAttribute("content") ?? "").trim().slice(0, 256);
        const firstH1 = String(dom.querySelector("body h1")?.textContent ?? "")
          .replace(/\s+/gu, " ").trim().slice(0, 256);
        const main: any = dom.querySelector("main,[role='main'],article") ?? dom.body;
        const rawText = String(main?.textContent ?? "");
        const visibleText = String(main?.innerText ?? "");
        const rawTokens = words(rawText);
        const visibleTokens = words(visibleText);
        const anchors: any[] = Array.from(dom.querySelectorAll("body a[href]"));
        const origin = new URL(url).origin;
        let base = url;
        let foreignBase = false;
        const baseHref = dom.querySelector("head base[href]")?.getAttribute("href");
        if (baseHref) {
          try {
            const candidate = new URL(baseHref, url);
            if (candidate.origin === origin && !candidate.search &&
              !candidate.username && !candidate.password && !candidate.port) {
              base = candidate.href;
            } else foreignBase = true;
          } catch { foreignBase = true; }
        }
        const links: string[] = [], visibleLinks: string[] = [],
          navLinks: string[] = [];
        for (const anchor of anchors.slice(0, linkCap)) {
          const raw = String(anchor.getAttribute("href") ?? "").trim();
          if (!raw || raw.length > 1_024 || raw.startsWith("#") ||
            (foreignBase && !/^[a-z][a-z0-9+.-]*:/iu.test(raw) &&
              !raw.startsWith("//"))) continue;
          try {
            const resolved = new URL(raw, base);
            if (!["https:", "http:"].includes(resolved.protocol) ||
              resolved.origin !== origin || resolved.username ||
              resolved.password || resolved.port || resolved.search ||
              raw.includes("?")) continue;
            resolved.hash = "";
            const label = resolved.href;
            links.push(label);
            if (withinViewport(anchor)) {
              visibleLinks.push(label);
              if (anchor.closest("nav,header,footer,[role='navigation']")) {
                navLinks.push(label);
              }
            }
          } catch { /* Invalid/unsupported link is not evidence. */ }
        }
        const controls: any[] = Array.from(dom.querySelectorAll(selector));
        let visibleControls = 0, focusable = 0, smallTargets = 0;
        for (const el of controls.slice(0, controlCap)) {
          if (!withinViewport(el)) continue;
          visibleControls++;
          if (el.tabIndex >= 0 && !el.disabled) focusable++;
          const box = el.getBoundingClientRect();
          if (box.width < 24 || box.height < 24) smallTargets++;
        }
        const rawCanonicals: string[] = [];
        let canonicalDeclarations = 0;
        for (const link of Array.from(dom.querySelectorAll("head link[rel]")) as any[]) {
          if (!String(link.rel ?? "").toLowerCase().split(/\s+/u).includes("canonical")) continue;
          canonicalDeclarations++;
          try {
            const c = new URL(String(link.getAttribute("href")), url);
            c.hash = "";
            if (["http:","https:"].includes(c.protocol) &&
              !c.username && !c.password && !c.port && !c.search &&
              c.href.length <= 512) rawCanonicals.push(c.href);
          } catch { /* No reliable canonical label from this markup. */ }
        }
        const robots = Array.from(dom.querySelectorAll("head meta[name][content]")) as any[];
        const noindex = robots.some((meta) =>
          ["robots","googlebot"].includes(String(meta.name ?? "").toLowerCase()) &&
          /(?:^|[\s,;])(?:noindex|none)(?:$|[\s,;])/iu.test(String(meta.content ?? "")));
        const jsonld = Array.from(dom.querySelectorAll('script[type="application/ld+json" i]')).length;
        const effective = Math.round(Number(win.innerWidth) || 0);
        const scrollWidth = Math.round(Number(dom.documentElement?.scrollWidth) || effective);
        return {
          width: 0, height: 0,
          effective_layout_width: effective,
          viewport_meta_present: Boolean(dom.querySelector('head meta[name="viewport" i]')),
          title, description: desc, first_h1: firstH1,
          h1_count: dom.querySelectorAll("body h1").length,
          main_dom_words: rawTokens, main_visible_words: visibleTokens,
          same_origin_links: [...new Set(links)],
          visible_links: [...new Set(visibleLinks)],
          visible_nav_links: [...new Set(navLinks)],
          canonical: canonicalDeclarations === 0 ? null :
            canonicalDeclarations === 1 && rawCanonicals.length === 1
              ? rawCanonicals[0] : "unverified",
          noindex, jsonld_blocks: jsonld,
          controls_seen: controls.length, visible_controls: visibleControls,
          keyboard_focusable_controls: focusable,
          small_visible_controls: smallTargets,
          observed_keyboard_targets: 0, keyboard_incomplete: false,
          disclosure_toggled: null,
          // In mobile emulation, innerWidth may itself expand to the widest
          // unbreakable element. Compare against the configured CSS viewport,
          // otherwise a 650px element can incorrectly look like zero overflow.
          horizontal_overflow_px: Math.max(0, Math.max(scrollWidth, effective) - requestedWidth),
          sample_truncated: rawText.length > 65_536 ||
            visibleText.length > 65_536 || controls.length > controlCap ||
            anchors.length > linkCap || words(rawText).length >= wordCap ||
            words(visibleText).length >= wordCap,
        };
      }, pageUrl, CONTROL_SELECTOR, MAX_PARITY_WORDS,
      MAX_PARITY_LINKS, MAX_PARITY_CONTROLS, vp.width);
      // The evidence contract records the requested *CSS screen* dimensions.
      // Browser effective viewport width is recorded separately.
      snapshot.width = vp.width;
      snapshot.height = vp.height;

      const seen = new Set<number>();
      if (snapshot.keyboard_focusable_controls > 0) {
        try {
          await page.evaluate(() => { (globalThis as any).document.activeElement?.blur?.(); });
          for (let i = 0; i < MAX_PARITY_TAB_STEPS; i++) {
            await page.keyboard.press("Tab");
            const ordinal = await page.evaluate((selector: string, cap: number) => {
              const dom: any = (globalThis as any).document;
              const index = Array.from(dom.querySelectorAll(selector))
                .indexOf(dom.activeElement) + 1;
              return index <= cap ? index : 0;
            }, CONTROL_SELECTOR, MAX_PARITY_CONTROLS);
            if (!ordinal || seen.has(ordinal)) break;
            seen.add(ordinal);
          }
          snapshot.observed_keyboard_targets = seen.size;
          snapshot.keyboard_incomplete = snapshot.keyboard_focusable_controls > seen.size &&
            (seen.size >= MAX_PARITY_TAB_STEPS ||
              snapshot.controls_seen > MAX_PARITY_CONTROLS);
        } catch { snapshot.keyboard_incomplete = true; }
      }

      // Native <details> is the only element that can be activated. No arbitrary
      // click, link navigation or form submission is allowed in this diagnostic.
      const summary = await page.evaluate(() => {
        const dom: any = (globalThis as any).document;
        const el: any = dom.querySelector("details > summary");
        if (!el || el.closest("[hidden],[inert]")) return null;
        const s = (globalThis as any).getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const width = Number((globalThis as any).innerWidth);
        const height = Number((globalThis as any).innerHeight);
        if (s.display === "none" || s.visibility !== "visible" ||
          box.width < 1 || box.height < 1 || box.right <= 0 || box.bottom <= 0 ||
          box.left >= width || box.top >= height) return null;
        return {
          x: Math.min(width - 2, Math.max(2, box.left + box.width / 2)),
          y: Math.min(height - 2, Math.max(2, box.top + box.height / 2)),
          before: Boolean(el.parentElement?.open),
        };
      });
      if (summary) {
        try {
          if (kind === "mobile") {
            await page.touchscreen.tap(summary.x, summary.y);
          } else {
            await page.evaluate(() => {
              (globalThis as any).document.querySelector("details > summary")?.focus();
            });
            await page.keyboard.press("Enter");
          }
          const after = await page.evaluate(() =>
            Boolean((globalThis as any).document
              .querySelector("details > summary")?.parentElement?.open));
          snapshot.disclosure_toggled = summary.before !== after;
        } catch { snapshot.disclosure_toggled = false; }
      }
      samples.push(snapshot);
      await page.close();
    }
    return analyzeViewportParity(pageUrl, samples[0], samples[1], {
      scope, blockedResources: Math.min(1_000, blocked),
    });
  } catch (cause) {
    pendingFailure = cause;
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
    try { if (browser) await browser.close(); }
    catch (cause) { if (!pendingFailure) throw cause; }
  }
}

/** One public robots-gated HTML GET, then two isolated offline viewports. */
export async function inspectPublicViewportParity(
  url: string, runtime: ScreenshotBrowserRuntime = defaultScreenshotBrowserRuntime,
): Promise<ViewportParityReview> {
  const { page_url, raw_html } = await fetchGuardedPublicHtml(url);
  return inspectViewportParity(raw_html, page_url, runtime,
    "isolated_public_html_viewports");
}
