# Crawler Observability Design

## Goal

The crawler should explain what each source can support before new source-specific adapters are added. A run must separate public-access failures, selector/config drift, adapter requirements, true zero-result cases, and manual browser-network review.

This design is intentionally read-only. It does not load data into Supabase, does not change admin data, and does not bypass login, CAPTCHA, robots.txt, rate limits, or access controls.

## Source Scope

The default capability audit scope is all currently enabled sources in `data/notice-sources.csv`, across every existing `sourceLevel`. Existing department sources are still audited.

Future Source Discovery expansion is limited to university headquarters and college-level sources. Department websites are temporarily excluded from new discovery/registration, but this scope limit must not be implemented as an audit filter for already enabled sources.

## Structured Stage Schema

Every audit event is a JSON object emitted for one source and one stage.

Required fields:

- `runId`
- `sourceId`, `sourceName`, `universitySlug`, `sourceLevel`
- `stage`
- `status`: `success`, `warning`, `failed`, or `skipped`
- `startedAt`, `endedAt`, `elapsedMs`
- `retryCount`
- `failureCode`
- `evidence`

Fetch/decode fields when available:

- `httpStatus`
- `finalUrl`
- `redirected`
- `timeoutMs`
- `responseContentType`
- `detectedCharset`
- `responseByteLength`
- `lastErrorName`, `lastErrorMessage`, `lastErrorCode`

Parsing/filter fields when available:

- `listDomItemCount`
- `selectorMatches`
- `linkExtractionCount`
- `validDetailUrlCount`
- `detailSampleCount`
- `detailContentEmptyCount`
- `parsedDateCount`
- `keywordMatchCount`
- `finalCandidateCount`
- `accessProfiles`
- `decision`

Sensitive data rules:

- Do not store full raw HTML by default.
- Do not store cookies, authorization headers, sessions, or credentials.
- Keep evidence short and human-readable.
- Store official source URLs and final redirect URLs only when they are public.

## Stages

The audit uses these stages:

- `list_fetch`: request the configured list URL or source adapter.
- `list_decode`: detect content type, charset, and response byte length.
- `list_parse`: apply configured selectors or fallback anchor parsing.
- `notice_url_resolution`: extract public detail URLs from `href`, `data-*`, or event attributes.
- `pagination_check`: detect whether pagination is supported or needs review.
- `detail_fetch`: sample a small number of detail URLs.
- `detail_content_extract`: verify that detail pages contain meaningful body text.
- `candidate_filter`: count date and keyword pass-through.
- `final_result`: assign access profiles, failure code, and next-step decision.

## Failure Codes

- `URL_DEAD_DNS`
- `URL_DEAD_HTTP_404_410`
- `SERVER_ERROR_5XX`
- `TIMEOUT_OR_CONNECTION_ABORTED`
- `TLS_OR_CERTIFICATE_EXCEPTION`
- `BOT_BLOCKED_OR_RATE_LIMITED`
- `AUTH_OR_CAPTCHA_REQUIRED`
- `LIST_SELECTOR_ZERO_MATCHES`
- `URL_RESOLUTION_FAILED`
- `DETAIL_FETCH_FAILED`
- `DETAIL_CONTENT_EMPTY_OR_BOILERPLATE`
- `DETAIL_IDENTITY_UNVERIFIED`
- `ZERO_RECENT_NOTICES`
- `FILTERED_OUT_BY_DATE`
- `FILTERED_OUT_BY_KEYWORD`
- `PAGINATION_UNVERIFIED`
- `CONFIG_OR_SELECTOR_MISMATCH`
- `MANUAL_BROWSER_NETWORK_REQUIRED`
- `UNKNOWN_NEEDS_MANUAL_REVIEW`

`0 candidates` is not automatically a failure. The audit distinguishes:

- no list items found
- list items found but no valid URL
- URL and details found but no scholarship keyword
- dates found but outside lookback
- public list exists and has no recent scholarship notices

## Access Profiles

A source may have multiple profiles:

- `STATIC_HTML_HREF`
- `STATIC_HTML_EVENT_URL`
- `FORM_POST_REDIRECT`
- `JSON_XHR_API`
- `SERVER_RENDERED_WITH_PAGINATION`
- `CLIENT_RENDERED_OR_JS_REQUIRED`
- `LEGACY_CHARSET`
- `TLS_OR_CERTIFICATE_EXCEPTION`
- `BOT_BLOCKED_OR_RATE_LIMITED`
- `AUTH_OR_CAPTCHA_REQUIRED`
- `DETAIL_PAGE_UNREACHABLE`
- `ATTACHMENT_ACCESS_UNVERIFIED`
- `SOURCE_CONFIG_OR_SELECTOR_MISMATCH`
- `UNKNOWN_NEEDS_MANUAL_REVIEW`

## Artifact Structure

Default command:

```bash
npm run audit:crawler-capabilities
```

Safer scoped command:

```bash
AUDIT_SOURCE_ID_PREFIX=yonsei_ AUDIT_LIMIT=5 AUDIT_DETAIL_SAMPLE_SIZE=1 npm run audit:crawler-capabilities
```

User-Agent controls:

- `CRAWL_USER_AGENT`: overrides the main crawler request User-Agent.
- `AUDIT_USER_AGENT`: overrides the capability audit request User-Agent.

Both default to a browser-compatible User-Agent because some public university hosts respond slowly or terminate requests for obvious bot-style User-Agent strings. Use this only for public pages that are already accessible in a normal browser; do not use it to bypass authentication, CAPTCHA, robots.txt, or access controls.

Default output directory:

```text
exports/notices/diagnostics/
```

Generated files:

- `capability-audit-YYYYMMDD-RUNID.json`: dated full report.
- `capability-audit-YYYYMMDD-RUNID.csv`: dated source summary, one row per enabled source.
- `capability-audit-latest.json`: latest full report.
- `capability-audit-latest.csv`: latest source summary.
- `capability-audit-university-summary-YYYYMMDD-RUNID.csv`: dated university summary.
- `capability-audit-university-summary-latest.csv`: latest university summary.
- `capability-audit-profile-summary-YYYYMMDD-RUNID.md`: dated access profile Markdown summary.
- `capability-audit-profile-summary-latest.md`: latest access profile Markdown summary.
- `capability-audit-form-post-redirect-evidence-YYYYMMDD-RUNID.csv`: dated FORM_POST_REDIRECT evidence rows.
- `capability-audit-form-post-redirect-evidence-latest.csv`: latest FORM_POST_REDIRECT evidence rows.
- `capability-audit-form-post-redirect-evidence-YYYYMMDD-RUNID.md`: dated FORM_POST_REDIRECT evidence summary.
- `capability-audit-form-post-redirect-evidence-latest.md`: latest FORM_POST_REDIRECT evidence summary.
- `failed-sources-latest.json`: sources with a primary failure code.
- `needs-adapter-latest.json`: sources that need source-specific adapters.
- `manual-review-required-latest.json`: sources requiring human browser/network review.

The full report contains:

- `runId`, `runAt`, input path, filters
- totals by decision, failure code, access profile, and stage status
- per-source summary without raw HTML
- full `stageEvents`

The source CSV must include these filterable columns: `source_id`, `source_name`, `source_config_file`, `university_slug`, `source_level`, `adapter`, `list_url`, `list_fetch_status`, `list_parse_status`, `item_match_count`, `title_extract_rate`, `date_extract_rate`, `detail_url_resolution_rate`, `detail_url_resolved`, `detail_url_verified`, `detail_fetch_status`, `detail_content_status`, `detail_content_char_count`, `pagination_status`, `access_profiles`, `capability_status`, `recommended_action`, `manual_review_question`, `failure_codes`, and `evidence_summary`.

Status-like columns should never be blank. Use explicit values such as `success`, `warning`, `failed`, `skipped`, or `manual_review_required`, and use `none` for optional text fields with no applicable value.

URL verification terms:

- `detail_url_resolved`: the list DOM or adapter produced a detail URL string.
- `detail_url_verified`: the audit fetched a sample detail page and the list title matched the detail page title, heading, or title-like body text after normalization.
- `detail_content_verified`: the fetched detail page contained enough meaningful text for extraction.

HTTP 200 alone does not verify a detail URL. If title comparison is unavailable or uncertain, keep `detail_url_verified` false/warning and use `list_supported_detail_unverified` unless stronger evidence requires `manual_review_required`.

Do not treat `href="#1"`, `javascript:void(0)`, or unresolved `onclick` handlers as verified detail URLs. For example, Korea University portal links that call `jf_view(article_id, board_id, site_id)` require browser Network evidence because the browser performs POST, receives a redirect, and lands on an encoded final URL.

Do not infer `FORM_POST_REDIRECT` from any `method="post"` form in the list HTML. Assign it only when source metadata, adapter metadata/execution, browser Network evidence, or a concrete placeholder-link plus article-id plus POST-action structure proves that detail access itself requires POST and redirect.

Each access profile includes `profileEvidence` in JSON output. For `FORM_POST_REDIRECT`, the evidence summary CSV/Markdown must make the cause auditable by source and by `evidence_type`.

## Adapter Decision Criteria

Use config/selector repair when:

- list HTML is public and stable
- selectors produce zero matches but page body has server-rendered content
- links are present but `linkSelector` or `noticeUrlPattern` is wrong

Add a source adapter when:

- the source uses JSON/XHR APIs
- list/detail navigation has direct evidence of requiring form POST, redirect, or event handlers
- pagination cannot be represented by static selectors
- a public endpoint must be called with structured parameters

Require manual review when:

- login, CAPTCHA, or protected sessions are required
- bot/rate-limit blocking appears
- TLS/certificate behavior is source-specific and needs policy approval
- the browser Network panel is needed to identify a public endpoint

Use `list_supported_detail_unverified` when:

- detail fetch succeeds through the current crawler path
- there is no evidence that an adapter is needed
- the sampled detail page identity could not be confirmed by normalized title matching

## Manual Test Checklist

- Run `npm run test:crawler-observability` and confirm it prints `crawler_observability_tests=passed`.
- Run `npm run test:crawler-adapters` and confirm it prints `crawler_adapter_tests=passed`.
- Run a scoped audit with `AUDIT_LIMIT=1 AUDIT_DETAIL_SAMPLE_SIZE=0 npm run audit:crawler-capabilities`.
- Confirm the audit creates `capability-audit-latest.json`.
- Confirm the audit creates `needs-adapter-latest.json` and `manual-review-required-latest.json`.
- Confirm the audit creates source CSV, university summary CSV, and profile summary Markdown artifacts.
- Confirm generated JSON does not contain cookies, auth headers, credentials, or full raw HTML.
- Confirm a source with zero candidates is classified separately from fetch, selector, and URL failures.
