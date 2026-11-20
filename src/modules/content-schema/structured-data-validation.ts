/**
 * P1-07: conservative, bounded JSON-LD structural review profiles.
 *
 * Intentionally NOT a full JSON-LD processor, Schema.org ontology validator,
 * Google Rich Results Test, or eligibility/ranking prediction.
 * No remote contexts, URLs or schema documents are resolved.
 */
import { normalizedEvidenceDate } from "./citation-methodology-consistency.js";

export const MAX_SUPPORTED_SCHEMA_HTML_BYTES = 250_000;
export const MAX_SUPPORTED_SCHEMA_SCRIPTS = 12;
export const MAX_SUPPORTED_SCHEMA_SCRIPT_BYTES = 64_000;
export const MAX_SUPPORTED_SCHEMA_NODES = 64;
export const MAX_SUPPORTED_SCHEMA_FINDINGS = 12;

export const SUPPORTED_SCHEMA_TYPES = [
  "Article", "NewsArticle", "BlogPosting", "Product",
  "BreadcrumbList", "FAQPage", "Organization", "WebSite",
] as const;
export type SupportedSchemaType = typeof SUPPORTED_SCHEMA_TYPES[number];
export type SchemaFindingCode =
  | "empty_block" | "invalid_json" | "invalid_document" | "invalid_graph"
  | "large_block_skipped" | "context_unverified" | "type_unverified"
  | "unsupported_type" | "missing_profile_field" | "invalid_field_type"
  | "invalid_date" | "product_evidence_missing" | "invalid_offer"
  | "invalid_price" | "invalid_currency" | "breadcrumb_too_short"
  | "breadcrumb_invalid_position" | "breadcrumb_duplicate_position"
  | "breadcrumb_gap" | "breadcrumb_item_missing"
  | "faq_question_incomplete" | "reference_unresolved";

export interface StructuredSchemaFinding {
  code: SchemaFindingCode;
  severity: "error" | "warning" | "info";
  block: number;
  node: number;
  type?: SupportedSchemaType;
  property?: string;
  message: string;
}

export interface SupportedSchemaReview {
  scope: "bounded_jsonld_structural_profiles";
  blocks_seen: number;
  blocks_checked: number;
  blocks_skipped: number;
  nodes_examined: number;
  supported_nodes: number;
  unsupported_nodes: number;
  context_unverified_nodes: number;
  types_checked: SupportedSchemaType[];
  errors: number;
  warnings: number;
  unverified: number;
  coverage_limited: boolean;
  limitations: string[];
  total_findings: number;
  findings: StructuredSchemaFinding[];
  findings_truncated: boolean;
}

type JsonRecord = Record<string, unknown>;
type Context = { vocab: boolean; prefixes: ReadonlySet<string> };
const EMPTY_CONTEXT: Context = { vocab: false, prefixes: new Set<string>() };
const schemaRoot = /^https?:\/\/schema\.org\/?$/i;
const validType = new Set<string>(SUPPORTED_SCHEMA_TYPES);
const severityOrder = { error: 0, warning: 1, info: 2 } as const;
const safeProperties = new Set([
  "@context", "@type", "@graph", "headline", "author", "datePublished", "dateModified",
  "name", "image", "offers", "review", "aggregateRating", "price", "priceSpecification",
  "lowPrice", "priceCurrency", "itemListElement", "item", "position", "mainEntity",
  "acceptedAnswer", "text", "url",
]);

function obj(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}
function text(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
function absoluteHttp(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 1024) return false;
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) &&
      !!parsed.hostname && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
function schemaContext(value: unknown, parent: Context): Context {
  if (value === undefined) return parent;
  const contexts = Array.isArray(value) ? value.slice(0, 8) : [value];
  let vocab = false;
  const prefixes = new Set<string>();
  for (const entry of contexts) {
    if (typeof entry === "string" && schemaRoot.test(entry)) vocab = true;
    if (obj(entry)) {
      if (typeof entry["@vocab"] === "string" && schemaRoot.test(entry["@vocab"])) vocab = true;
      for (const [key, prefix] of Object.entries(entry).slice(0, 32)) {
        if (/^[a-z][a-z0-9_-]{0,24}$/i.test(key) && typeof prefix === "string" &&
          schemaRoot.test(prefix)) prefixes.add(key);
      }
    }
  }
  return { vocab, prefixes };
}
function normalizedType(value: string, context: Context): SupportedSchemaType | undefined {
  const direct = /^https?:\/\/schema\.org\/([a-zA-Z]+)$/i.exec(value)?.[1];
  const prefixed = /^([a-z][a-z0-9_-]{0,24}):([a-zA-Z]+)$/i.exec(value);
  const candidate = direct ?? (prefixed && context.prefixes.has(prefixed[1])
    ? prefixed[2] : context.vocab ? value : undefined);
  return candidate && validType.has(candidate) ? candidate as SupportedSchemaType : undefined;
}
function validPrice(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim());
}

export function reviewSupportedJsonLd(scriptTexts: readonly string[], blocksSeen = scriptTexts.length): SupportedSchemaReview {
  if (!Number.isSafeInteger(blocksSeen) || blocksSeen < scriptTexts.length ||
    scriptTexts.length > MAX_SUPPORTED_SCHEMA_SCRIPTS) {
    throw new Error("JSON-LD script sample is outside the 12-block limit.");
  }
  const findings: StructuredSchemaFinding[] = [];
  const types = new Set<SupportedSchemaType>();
  let checked = 0;
  let skipped = blocksSeen - scriptTexts.length;
  let nodesExamined = 0;
  let supported = 0;
  let unsupported = 0;
  let unknownContext = 0;
  let hitNodeLimit = false;

  function issue(code: SchemaFindingCode, severity: StructuredSchemaFinding["severity"],
    block: number, node: number, message: string, type?: SupportedSchemaType, property?: string) {
    findings.push({
      code, severity, block, node,
      ...(type ? { type } : {}),
      ...(property && safeProperties.has(property) ? { property } : {}),
      message,
    });
  }
  function field(record: JsonRecord, property: string, type: SupportedSchemaType,
    block: number, node: number, requiredProfile = false) {
    const value = record[property];
    if (value === undefined || value === null || value === "") {
      if (requiredProfile) {
        issue("missing_profile_field", "warning", block, node,
          "This property is expected by the selected limited review profile; absence is not proof of invalid Schema.org markup.", type, property);
      }
      return false;
    }
    if (!text(value)) {
      issue("invalid_field_type", "warning", block, node,
        "The explicit property is not a nonempty text value in the selected review profile.", type, property);
      return false;
    }
    return true;
  }
  function dateField(record: JsonRecord, property: "datePublished" | "dateModified",
    type: SupportedSchemaType, block: number, node: number) {
    if (record[property] === undefined) return;
    if (typeof record[property] !== "string" || !normalizedEvidenceDate(record[property])) {
      issue("invalid_date", "warning", block, node,
        "An explicit article date is not a calendar-valid ISO date or timezone-qualified timestamp.", type, property);
    }
  }
  function checkProduct(record: JsonRecord, block: number, node: number) {
    const type = "Product" as const;
    field(record, "name", type, block, node, true);
    if (record.offers === undefined && record.review === undefined && record.aggregateRating === undefined) {
      issue("product_evidence_missing", "warning", block, node,
        "The limited Product snippet review profile expects offers, review or aggregateRating; no rich-result eligibility is asserted.", type);
    }
    if (record.offers === undefined) return;
    const offers = values(record.offers).slice(0, 8);
    if (Array.isArray(record.offers) && record.offers.length > 8) hitNodeLimit = true;
    for (const offer of offers) {
      if (!obj(offer)) {
        issue("invalid_offer", "warning", block, node,
          "An offers entry must be a structured object for this review profile.", type, "offers");
        continue;
      }
      if (text(offer["@id"]) && Object.keys(offer).length === 1) {
        issue("reference_unresolved", "info", block, node,
          "The offer is a reference only; this offline review does not resolve linked graph objects.", type, "offers");
        continue;
      }
      const offerType = typeof offer["@type"] === "string" ? offer["@type"].split("/").at(-1) : undefined;
      const priceProperty = offerType === "AggregateOffer" ? "lowPrice" : "price";
      let candidate: unknown = offer[priceProperty];
      if (candidate === undefined && obj(offer.priceSpecification)) {
        candidate = offer.priceSpecification.price;
      }
      if (candidate === undefined) {
        issue("missing_profile_field", "warning", block, node,
          "The nested offer has no observed price/lowPrice or priceSpecification.price for this review profile.", type, priceProperty);
      } else if (!validPrice(candidate)) {
        issue("invalid_price", "warning", block, node,
          "The nested offer price is not a nonnegative numeric value.", type, priceProperty);
      }
      const currency = offer.priceCurrency ??
        (obj(offer.priceSpecification) ? offer.priceSpecification.priceCurrency : undefined);
      if (currency !== undefined && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))) {
        issue("invalid_currency", "warning", block, node,
          "The explicit offer currency does not have a three-letter uppercase ISO-style code.", type, "priceCurrency");
      }
    }
  }
  function checkBreadcrumbs(record: JsonRecord, block: number, node: number) {
    const type = "BreadcrumbList" as const;
    const entries = record.itemListElement === undefined ? [] : values(record.itemListElement);
    if (entries.length < 2) {
      issue("breadcrumb_too_short", "warning", block, node,
        "The limited breadcrumb display profile expects at least two ListItem entries.", type, "itemListElement");
    }
    if (entries.length > 16) hitNodeLimit = true;
    const positions: number[] = [];
    for (const [index, entry] of entries.slice(0, 16).entries()) {
      if (!obj(entry)) {
        issue("invalid_field_type", "warning", block, node,
          "An itemListElement entry is not a structured ListItem object.", type, "itemListElement");
        continue;
      }
      const position = entry.position;
      if (!Number.isInteger(position) || typeof position !== "number" || position <= 0 || position > 10000) {
        issue("breadcrumb_invalid_position", "warning", block, node,
          "A breadcrumb ListItem has no positive integer position.", type, "position");
      } else if (positions.includes(position)) {
        issue("breadcrumb_duplicate_position", "warning", block, node,
          "Two breadcrumb ListItems share an explicit position.", type, "position");
      } else {
        positions.push(position);
      }
      const childName = obj(entry.item) ? entry.item.name : undefined;
      if (!text(entry.name) && !text(childName)) {
        issue("missing_profile_field", "warning", block, node,
          "A breadcrumb ListItem lacks a name in either the item or the item itself.", type, "name");
      }
      if (index < entries.length - 1 && entry.item === undefined) {
        issue("breadcrumb_item_missing", "warning", block, node,
          "A nonfinal breadcrumb ListItem lacks an explicit item target.", type, "item");
      }
      if (entry.item !== undefined && !(absoluteHttp(entry.item) ||
        (obj(entry.item) && (text(entry.item["@id"]) || text(entry.item.name))))) {
        issue("invalid_field_type", "warning", block, node,
          "A breadcrumb item target is not a supported absolute URL or Thing object.", type, "item");
      }
    }
    if (positions.length >= 2 && positions.length === Math.min(entries.length, 16)) {
      const sorted = [...positions].sort((a, b) => a - b);
      if (sorted.some((p, i) => p !== i + 1)) {
        issue("breadcrumb_gap", "warning", block, node,
          "Breadcrumb positions do not form a contiguous one-based sequence.", type, "position");
      }
    }
  }
  function checkFAQ(record: JsonRecord, block: number, node: number) {
    const type = "FAQPage" as const;
    if (record.mainEntity === undefined) {
      issue("missing_profile_field", "warning", block, node,
        "The limited FAQ review profile expects a mainEntity Question.", type, "mainEntity");
      return;
    }
    const questions = values(record.mainEntity);
    if (questions.length > 16) hitNodeLimit = true;
    for (const question of questions.slice(0, 16)) {
      if (!obj(question)) {
        issue("faq_question_incomplete", "warning", block, node,
          "A mainEntity entry is not a structured Question object.", type, "mainEntity");
        continue;
      }
      if (text(question["@id"]) && Object.keys(question).length === 1) {
        issue("reference_unresolved", "info", block, node,
          "A Question reference is not resolved in this limited offline review.", type, "mainEntity");
        continue;
      }
      if (!text(question.name)) {
        issue("faq_question_incomplete", "warning", block, node,
          "The FAQ Question lacks a nonempty text name.", type, "name");
      }
      const answers = question.acceptedAnswer === undefined ? [] : values(question.acceptedAnswer);
      if (answers.length === 0 || !answers.some((answer) => obj(answer) &&
        text(answer.text))) {
        issue("faq_question_incomplete", "warning", block, node,
          "The FAQ Question lacks an acceptedAnswer with a nonempty text property.", type, "acceptedAnswer");
      }
    }
  }
  function checkNode(record: JsonRecord, type: SupportedSchemaType, block: number, node: number) {
    switch (type) {
      case "Article":
      case "NewsArticle":
      case "BlogPosting":
        field(record, "headline", type, block, node, true); // Google recommends but does not require it.
        if (record.author === undefined) {
          issue("missing_profile_field", "info", block, node,
            "Author is a recommended Article property, not a required one.", type, "author");
        } else if (!(obj(record.author) || Array.isArray(record.author))) {
          issue("invalid_field_type", "info", block, node,
            "An author is best described by a Person or Organization object for the selected review profile.", type, "author");
        }
        dateField(record, "datePublished", type, block, node);
        dateField(record, "dateModified", type, block, node);
        break;
      case "Product":
        checkProduct(record, block, node);
        break;
      case "BreadcrumbList":
        checkBreadcrumbs(record, block, node);
        break;
      case "FAQPage":
        checkFAQ(record, block, node);
        break;
      case "Organization":
      case "WebSite":
        field(record, "name", type, block, node, true);
        if (record.url !== undefined && !absoluteHttp(record.url)) {
          issue("invalid_field_type", "info", block, node,
            "The supplied URL cannot be confirmed as an absolute HTTP(S) URL in this limited profile.", type, "url");
        }
        break;
    }
  }
  for (const [index, source] of scriptTexts.entries()) {
    const block = index + 1;
    const size = new TextEncoder().encode(source).byteLength;
    if (size > MAX_SUPPORTED_SCHEMA_SCRIPT_BYTES) {
      skipped += 1;
      issue("large_block_skipped", "info", block, 0,
        "This JSON-LD block exceeds the per-block parsing cap and was not inspected.");
      continue;
    }
    if (!source.trim()) {
      checked += 1;
      issue("empty_block", "warning", block, 0,
        "An explicit JSON-LD block is empty.");
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(source.replace(/^\uFEFF/, ""));
    } catch {
      checked += 1;
      issue("invalid_json", "error", block, 0,
        "The JSON-LD block contains invalid JSON syntax; use the existing syntax checker for detailed diagnostics.");
      continue;
    }
    checked += 1;
    const roots = Array.isArray(document) ? document : [document];
    if (roots.length === 0 || roots.some((value) => !obj(value))) {
      issue("invalid_document", "error", block, 0,
        "The JSON-LD document root must be a nonempty object or array of objects.");
      continue;
    }
    const work: Array<{ value: JsonRecord; context: Context }> =
      roots.map((value) => ({ value: value as JsonRecord, context: EMPTY_CONTEXT }));
    while (work.length > 0) {
      if (nodesExamined >= MAX_SUPPORTED_SCHEMA_NODES) {
        hitNodeLimit = true;
        break;
      }
      const next = work.shift()!;
      const node = ++nodesExamined;
      const ctx = schemaContext(next.value["@context"], next.context);
      const graph = next.value["@graph"];
      if (graph !== undefined) {
        const graphNodes = Array.isArray(graph) ? graph : [graph];
        if (graphNodes.some((value) => !obj(value))) {
          issue("invalid_graph", "warning", block, node,
            "The explicit @graph contains a nonobject entry; this limited reviewer did not interpret it.");
        }
        // Cap queued work before loading any unbounded nested graph.
        for (const item of graphNodes) {
          if (obj(item) && work.length < MAX_SUPPORTED_SCHEMA_NODES) work.push({ value: item, context: ctx });
          else if (obj(item)) hitNodeLimit = true;
        }
      }
      const typeValue = next.value["@type"];
      if (typeValue === undefined) {
        if (graph === undefined && Object.keys(next.value).some((key) => !key.startsWith("@"))) {
          unknownContext += 1;
          issue("type_unverified", "info", block, node,
            "This JSON-LD node has no explicit @type for the supported review profiles.");
        }
        continue;
      }
      const typeNames = values(typeValue);
      if (typeNames.length === 0 || typeNames.some((value) => typeof value !== "string")) {
        unknownContext += 1;
        issue("type_unverified", "info", block, node,
          "The JSON-LD @type is not a comparable string or array of strings.");
        continue;
      }
      const known = new Set<SupportedSchemaType>();
      for (const name of typeNames.slice(0, 8)) {
        const normalized = normalizedType(name as string, ctx);
        if (normalized) known.add(normalized);
        else if (typeof name === "string" && validType.has(name)) {
          unknownContext += 1;
          issue("context_unverified", "info", block, node,
            "This known type has no supported Schema.org context, so profile checks were skipped.");
        } else {
          unsupported += 1;
          issue("unsupported_type", "info", block, node,
            "A declared JSON-LD type falls outside this explicit small set of structural profiles.");
        }
      }
      if (typeNames.length > 8) hitNodeLimit = true;
      for (const kind of known) {
        supported += 1;
        types.add(kind);
        checkNode(next.value, kind, block, node);
      }
    }
  }
  const ordered = findings.sort((a, b) =>
    severityOrder[a.severity] - severityOrder[b.severity] ||
    a.block - b.block || a.node - b.node || a.code.localeCompare(b.code));
  const errors = ordered.filter((f) => f.severity === "error").length;
  const warnings = ordered.filter((f) => f.severity === "warning").length;
  return {
    scope: "bounded_jsonld_structural_profiles",
    blocks_seen: blocksSeen,
    blocks_checked: checked,
    blocks_skipped: skipped,
    nodes_examined: nodesExamined,
    supported_nodes: supported,
    unsupported_nodes: unsupported,
    context_unverified_nodes: unknownContext,
    types_checked: SUPPORTED_SCHEMA_TYPES.filter((type) => types.has(type)),
    errors, warnings, unverified: ordered.filter((f) => f.severity === "info").length,
    coverage_limited: true,
    limitations: [
      "Only explicit sampled JSON-LD and a fixed small set of structural review profiles are inspected; no full JSON-LD expansion, alias resolution, external context fetching, microdata or RDFa.",
      "Profile warnings do not prove invalid Schema.org markup; passing checks do not establish content truth, Google eligibility, rich-result display, crawlability or ranking.",
      ...(skipped || hitNodeLimit || blocksSeen > scriptTexts.length
        ? ["A parsing or sampling cap was reached; excluded declarations remain unverified."] : []),
      ...(unsupported || unknownContext
        ? ["Unknown types or contexts are not evaluated; use a complete standards-aware validator for those types."] : []),
    ],
    total_findings: ordered.length,
    findings: ordered.slice(0, MAX_SUPPORTED_SCHEMA_FINDINGS),
    findings_truncated: ordered.length > MAX_SUPPORTED_SCHEMA_FINDINGS,
  };
}
