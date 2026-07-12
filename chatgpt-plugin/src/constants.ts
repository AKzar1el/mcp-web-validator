export const SERVER_VERSION = "0.5.0";
export const HTML_MAX_LENGTH = 200_000;
export const CSS_MAX_LENGTH = 200_000;
export const HOSTED_MAX_LINKS = 20;

/** Conservative hosted site-audit limits. A later async crawler can be broader. */
export const SITE_AUDIT_DEFAULT_MAX_PAGES = 5;
export const SITE_AUDIT_MAX_PAGES = 8;
export const SITE_AUDIT_CONCURRENCY = 2;
export const SITE_AUDIT_MAX_SITEMAPS = 4;
export const SITE_AUDIT_MAX_SITEMAP_URLS = 250;
export const SITE_AUDIT_MAX_ROBOTS_BYTES = 512 * 1024;
export const SITE_AUDIT_MAX_SITEMAP_BYTES = 1024 * 1024;
export const SITE_AUDIT_MAX_ISSUE_GROUPS = 50;
export const SITE_AUDIT_MAX_EXAMPLE_URLS = 3;
export const SITE_AUDIT_MAX_PAGE_FINDINGS = 3;

export const SERVICE_USER_AGENT =
  `DigestSEO-Web-Validator/${SERVER_VERSION} (+https://digestseo.com/validator-mcp/)`;
