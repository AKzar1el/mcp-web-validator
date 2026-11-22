# Web Validator: five-phase quality review

**Date:** 22 November 2026 (Europe/Ljubljana)
**Scope:** AKzar1el/mcp-web-validator v1.3.53, local stdio MCP, and the Cloudflare-hosted Web Validator at https://web-validator-mcp.digestseo.com/mcp
**Starting source:** GitHub main da877b74d8dd166b3c2b46010d446125a661077e
**Existing Worker version:** 75784b3a-121d-4bea-930b-871cfcd3d968

## Executive verdict

The tested workflows are functional and the labelled rule checks passed within their deliberately bounded scope. This is **not** evidence that the product has zero bugs, has fully audited any real website, or improves human/LLM agent productivity by a particular percentage.

The hosted surface provides 27 tools. The local MCP exposes 39 registered tools and was connected at v1.3.53. This review invoked all 27 hosted tool names using a combination of supplied-data fixtures and carefully capped live checks; it directly exercised a subset of local tools, especially audit history. The remaining local tools were not each subjected to a live task.

## Phase 1. Real-world tool functionality

- **22/22 supplied-data hosted calls returned non-error structured results**, median **53.5 ms**. Fourteen reported partial status because supplied evidence was deliberately insufficient; this is not equivalent to 22 complete audits.
- **4/4 focused live/validator workflows returned structured results**: HTML, CSS, validation report, and one user-owned public webpage audit. The digestseo.com page fetched at HTTP 200 and yielded one reported HTML error plus one warning, not independently adjudicated.
- An opt-in sitemap-first audit of user-owned tomiseregi.si discovered **135** page URLs, selected **1**, fully audited **0**, and recorded **1 partial** due to the external HTML validator timing out. Reported coverage was truncated. **Do not describe this as a full site audit.**
- Hosted-to-local interoperability saved and restored one compact audit in a disposable local history, then compared it with the hosted snapshot without fabricating regression pages. The first run encountered an intermittent default local MCP request timeout. The diagnostic retry passed after instrumenting stage timings and using bounded 90-second local inventory/history requests. The local cold connection took approximately 28 seconds in an isolated run.

## Phase 2. Productivity comparison

**12 paired workflow measurements, zero failed calls:**

| Workload | Baseline | Hosted MCP | Interpretation |
| --- | --- | --- | --- |
| SEO metadata, six repetitions | Prewritten Cheerio six-rule checker median **11.573 ms**; six expected checks | Metadata audit median **72.1 ms**, eight reported issues | Hosted is slower than this narrow in-process parser but provides broader structured diagnostics; extra findings were not independently counted as true positives |
| HTML validation, three alternating pairs | Direct W3C Nu API median **163.6 ms**, one error in each sample | Hosted validator median **152.7 ms**, one error in each sample | Same observed HTML error count; similar small-sample network latency |

**Limitation:** This is a latency and output comparison, not a measured human or LLM-agent productivity A/B. Baseline development cost, agent prompts, token usage, false-positive review time and repository task completion time were not measured. No claim of developer-hours, tokens or percentage productivity savings is warranted.

## Phase 3. Bugs, edge cases and safety

- Added a local Cloudflare Worker adversarial regression suite, quality-adversarial.test.ts, containing **9 sensitive-marker exposure checks and 36 mutated header/Unicode/control-character/large-value checks**: **45/45 tool calls** in two passing Vitest tests. No unexpected outbound fetch, literal sentinel leak, HTTP 500 or oversized output was observed in these controlled cases.
- Selected **31** existing timeout, redirect, private URL, untrusted origin, rate limit and body-size tests: **31 passed**, **143 skipped** by the intentional test-name filter. The full suite is a separate Phase 5 gate.
- Improved scripts/smoke-local-hosted-interop.mjs with stage-level timings and bounded 90-second local MCP tool request limits. The previously intermittent integration workflow passed on rerun. This changes diagnostics/test resilience, **not** production behavior.
- No evidence from these probes established a new core security issue or defect requiring production code changes.

These are scoped adversarial samples, not exhaustive fuzzing or a formal security certification. No load or stress testing was applied to public websites.

## Phase 4. Accuracy and useful guidance

Prespecified **10 features**, each with one positive and one negative caller-supplied observation:

1. Valid versus invalid JSON-LD syntax
2. Explicit Cloudflare challenge versus none
3. HTTP 429 observed versus healthy status
4. Declared redirect loop versus completed redirect
5. Explicit PDF noindex versus absent noindex
6. Insecure HTTPS form target versus relative form
7. Robots disallow versus allowed path
8. Invalid sitemap lastmod versus valid date
9. Duplicate titles on distinct canonical pages versus unique titles
10. Query URL variant versus reference-only input

The real hosted MCP returned **10 true positives, 10 true negatives, 0 false positives, 0 false negatives and 0 abstentions** for these specific evidence fields. All ten positive cases contained a finding and a substantive next-action recommendation. Guidance included appropriate cautions about sample coverage, Search Console, server/CDN logs, and unverified crawler/indexing behavior.

**Measured accuracy is 100% on this small selected artificial corpus only. This is not a population-wide accuracy estimate.** Added the corresponding permanent quality-golden.test.ts regression: **10/10 local Cloudflare tests passed**, covering all twenty samples. TypeScript checks passed.

## Phase 5. Final regression and handoff

Closing gates (with outcomes verified to date):

- [x] Root TypeScript build passed and **814/814 Node tests passed** with one-at-a-time execution; zero failures, cancellations or skips (342.1 seconds for test runner)
- [x] Full hosted Cloudflare Worker Vitest suite passed **699/699 tests across 31 files**, with no failure/skips, using one worker per file and no file parallelism (289.5 seconds including 31 isolated Worker startups)
- [x] Root manifest consistency and hosted TypeScript type check passed; Git patch whitespace validation passed
- [x] Public hosted MCP read-only smoke passed: **27 expected tools**, zero missing/extra, `validate_schema_markup` returned a valid offline result

**Publication and hygiene gate:** This report accompanies a test-only pull request. Merge only after independent GitHub PR checks pass, then independently confirm post-merge main CI and remove only this task's temporary scripts/logs and owned branch. The actual PR, merge and CI receipts are retained in GitHub's pull-request/Actions history and the execution journal rather than predicted in this pre-merge report. Preserve Codexify's connected MCP runtime and all unrelated worktrees.

Reproducibility from repository root (PowerShell):

    npm run build
    node --test --test-concurrency=1 test/*.test.js
    npm run check:manifests
    Push-Location chatgpt-plugin
    .\node_modules\.bin\tsc.cmd --noEmit
    .\node_modules\.bin\vitest.cmd run --no-file-parallelism --maxWorkers=1
    Pop-Location
    npm run smoke:hosted

Optional user-authorized real-site interoperability (one page, not full crawl):

    $env:MCP_AUDIT_TARGET_URL = 'https://tomiseregi.si/'
    npm run smoke:interop

## Safety and residual risks

This audit did not change OpenAI Platform, publish npm, redeploy the public Worker, restart Codexify, modify another project, attempt credential bypass, perform mass crawls or apply stress traffic to public endpoints. Hostile cases were evaluated within the local Cloudflare Worker test environment. Data for isolated local history tests lived in safely removed temporary directories.

**Unresolved limitations:** External Nu validator timeouts and partial site coverage; resource contention on Windows; no real coding-agent or human productivity study; no exhaustive live validation of all 39 local tools; small chosen ground-truth corpus; no long-term p95/p99 traffic or uptime measurement; selected public-site findings not fully adjudicated. Use the tested features for bounded/supervised workloads, and independently validate material SEO changes before deployment.
