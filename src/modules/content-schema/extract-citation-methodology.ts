import * as cheerio from "cheerio";
import {
  MAX_PROVENANCE_DECLARATIONS,
  MAX_PROVENANCE_HTML_BYTES,
  normalizedEvidenceDate,
  safeDatasetVersion,
  safeProvenanceId,
  safeProvenanceUrl,
  type CitationDeclaration,
  type DatasetDeclaration,
  type MethodologyDeclaration,
  type ProvenanceObservation,
} from "./citation-methodology-consistency.js";

/**
 * Static-only HTML adapter. Source links and declared dates are observed but
 * never dereferenced. Each runtime imports its own Cheerio installation.
 */
export function observeProvenancePage(html: string, rawUrl: string): ProvenanceObservation {
  const url = safeProvenanceUrl(rawUrl) ?? "";
  if (!url || !html || new TextEncoder().encode(html).byteLength > MAX_PROVENANCE_HTML_BYTES) {
    return { url, citations: [], datasets: [], methodologies: [],
      published_dates: [], modified_dates: [], invalid_dates: 0,
      declarations_truncated: false, eligible: false };
  }
  const $ = cheerio.load(html);
  const citations: CitationDeclaration[] = [];
  const datasets: DatasetDeclaration[] = [];
  const methodologies: MethodologyDeclaration[] = [];
  const published: string[] = [];
  const modified: string[] = [];
  let badDates = 0;
  let count = 0;
  let truncated = false;
  function slot(): boolean {
    count += 1;
    if (count > MAX_PROVENANCE_DECLARATIONS) { truncated = true; return false; }
    return true;
  }
  function date(raw: string | undefined, output: string[]): string | undefined {
    if (!raw) return undefined;
    const normalized = normalizedEvidenceDate(raw.trim());
    if (normalized) output.push(normalized);
    else badDates += 1;
    return normalized;
  }
  function citation(id: string | undefined, target: string | undefined) {
    if (!slot()) return;
    citations.push({
      ...(id && safeProvenanceId(id.trim()) ? { id: id.trim() } : {}),
      ...(target && safeProvenanceUrl(target.trim()) ? { url: safeProvenanceUrl(target.trim()) } : {}),
    });
  }
  function dataset(id: string | undefined, version?: string, asOf?: string, method?: string) {
    if (!slot()) return;
    const safeDate = asOf ? normalizedEvidenceDate(asOf.trim()) : undefined;
    if (asOf && !safeDate) badDates += 1;
    datasets.push({
      ...(id && safeProvenanceId(id.trim()) ? { id: id.trim() } : {}),
      ...(version && safeDatasetVersion(version.trim()) ? { version: version.trim() } : {}),
      ...(safeDate ? { as_of: safeDate } : {}),
      ...(method && safeProvenanceId(method.trim()) ? { methodology_id: method.trim() } : {}),
    });
  }
  function methodology(id: string | undefined, target?: string) {
    if (!slot()) return;
    methodologies.push({
      ...(id && safeProvenanceId(id.trim()) ? { id: id.trim() } : {}),
      ...(target && safeProvenanceUrl(target.trim()) ? { url: safeProvenanceUrl(target.trim()) } : {}),
    });
  }
  const allowedTypes = new Set(["Article", "NewsArticle", "ScholarlyArticle", "Report", "CreativeWork", "Dataset"]);
  const scripts = $('script[type="application/ld+json"]').toArray();
  if (scripts.length > 5) truncated = true;
  for (const element of scripts.slice(0, 5)) {
    const source = $(element).html() ?? "";
    if (source.length > 20_000) { truncated = true; continue; }
    try {
      const parsed: unknown = JSON.parse(source);
      const roots = Array.isArray(parsed) ? parsed.slice(0, 12) : [parsed];
      for (const root of roots) {
        if (!root || typeof root !== "object" || Array.isArray(root)) continue;
        const base = root as Record<string, unknown>;
        const graph = Array.isArray(base["@graph"]) ? base["@graph"].slice(0, 12) : [];
        if (Array.isArray(base["@graph"]) && base["@graph"].length > 12) truncated = true;
        for (const candidate of [base, ...graph]) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
          const object = candidate as Record<string, unknown>;
          const kind = object["@type"];
          const types = Array.isArray(kind) ? kind.filter((v): v is string => typeof v === "string")
            : typeof kind === "string" ? [kind] : [];
          const recognized = types.some((type) => allowedTypes.has(type) ||
            [...allowedTypes].some((allowed) => type.endsWith("/" + allowed)));
          if (!recognized) continue;
          const isDataset = types.some((type) => type === "Dataset" || type.endsWith("/Dataset"));
          if (!isDataset && typeof object.datePublished === "string") date(object.datePublished, published);
          if (!isDataset && typeof object.dateModified === "string") date(object.dateModified, modified);
          if (isDataset) {
            const identifier = typeof object.identifier === "string" ? object.identifier : undefined;
            const version = typeof object.version === "string" ? object.version : undefined;
            const asOf = typeof object.dateModified === "string" ? object.dateModified : undefined;
            // No semantic inference from arbitrary measurementTechnique prose.
            dataset(identifier, version, asOf);
          }
          if (object.citation !== undefined) {
            const raw = Array.isArray(object.citation) ? object.citation.slice(0, 16) : [object.citation];
            if (Array.isArray(object.citation) && object.citation.length > 16) truncated = true;
            for (const item of raw) {
              if (typeof item === "string") citation(undefined, item);
              else if (item && typeof item === "object" && !Array.isArray(item)) {
                const entry = item as Record<string, unknown>;
                citation(typeof entry.identifier === "string" ? entry.identifier : undefined,
                  typeof entry.url === "string" ? entry.url :
                    typeof entry["@id"] === "string" ? entry["@id"] : undefined);
              }
            }
          }
        }
      }
      if (Array.isArray(parsed) && parsed.length > 12) truncated = true;
    } catch {
      // Invalid JSON-LD is owned by the existing schema validator. This
      // evidence tool cannot treat its unparsed contents as verified claims.
      truncated = true;
    }
  }
  const headDateTags: Array<[string, string[]]> = [
    ['head meta[property="article:published_time"]', published],
    ['head meta[property="article:modified_time"]', modified],
    ['head meta[itemprop="datePublished"]', published],
    ['head meta[itemprop="dateModified"]', modified],
  ];
  for (const [selector, output] of headDateTags) {
    for (const element of $(selector).toArray().slice(0, 12)) {
      if (!slot()) continue;
      date($(element).attr("content"), output);
    }
  }
  $("template,script,style,noscript,nav,header,footer,aside,[hidden],[aria-hidden='true']").remove();
  const main = $("main,[role='main']").first();
  const article = $("article").first();
  const root = main.length ? main : article.length ? article : $("body").first();
  if (!root.length) return { url, citations, datasets, methodologies,
    published_dates: published, modified_dates: modified,
    invalid_dates: badDates, declarations_truncated: truncated, eligible: false };
  for (const element of root.find("time[datetime][itemprop]").toArray().slice(0, 24)) {
    if (!slot()) continue;
    const itemprop = $(element).attr("itemprop");
    if (itemprop === "datePublished") date($(element).attr("datetime"), published);
    if (itemprop === "dateModified") date($(element).attr("datetime"), modified);
  }
  const links = root.find("a[href],a[data-citation-id],a[data-methodology-id]").toArray();
  if (links.length > 150) truncated = true;
  for (const element of links.slice(0, 150)) {
    const link = $(element);
    const rel = (link.attr("rel") ?? "").toLowerCase().split(/\s+/);
    const bibliography = link.parents(
      '#references,#bibliography,.references,.bibliography,[role="doc-bibliography"]',
    ).length > 0;
    if (rel.includes("cite") || link.attr("data-citation-id") !== undefined || bibliography) {
      citation(link.attr("data-citation-id"), link.attr("href"));
    }
    if (link.attr("data-methodology-id") !== undefined) {
      methodology(link.attr("data-methodology-id"), link.attr("href"));
    }
  }
  const datasetNodes = root.find("[data-dataset-id],[data-dataset-version],[data-dataset-as-of]").toArray();
  if (datasetNodes.length > MAX_PROVENANCE_DECLARATIONS) truncated = true;
  for (const element of datasetNodes.slice(0, MAX_PROVENANCE_DECLARATIONS)) {
    const node = $(element);
    dataset(node.attr("data-dataset-id"), node.attr("data-dataset-version"),
      node.attr("data-dataset-as-of"), node.attr("data-methodology-id"));
  }
  return {
    url,
    citations: citations.slice(0, MAX_PROVENANCE_DECLARATIONS),
    datasets: datasets.slice(0, MAX_PROVENANCE_DECLARATIONS),
    methodologies: methodologies.slice(0, MAX_PROVENANCE_DECLARATIONS),
    published_dates: published.slice(0, MAX_PROVENANCE_DECLARATIONS),
    modified_dates: modified.slice(0, MAX_PROVENANCE_DECLARATIONS),
    invalid_dates: badDates,
    declarations_truncated: truncated,
    eligible: true,
  };
}
