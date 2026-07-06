export const ACCESS_PROFILES = Object.freeze({
  STATIC_HTML_HREF: "STATIC_HTML_HREF",
  STATIC_HTML_EVENT_URL: "STATIC_HTML_EVENT_URL",
  FORM_POST_REDIRECT: "FORM_POST_REDIRECT",
  JSON_XHR_API: "JSON_XHR_API",
  SERVER_RENDERED_WITH_PAGINATION: "SERVER_RENDERED_WITH_PAGINATION",
  CLIENT_RENDERED_OR_JS_REQUIRED: "CLIENT_RENDERED_OR_JS_REQUIRED",
  LEGACY_CHARSET: "LEGACY_CHARSET",
  TLS_OR_CERTIFICATE_EXCEPTION: "TLS_OR_CERTIFICATE_EXCEPTION",
  BOT_BLOCKED_OR_RATE_LIMITED: "BOT_BLOCKED_OR_RATE_LIMITED",
  AUTH_OR_CAPTCHA_REQUIRED: "AUTH_OR_CAPTCHA_REQUIRED",
  DETAIL_PAGE_UNREACHABLE: "DETAIL_PAGE_UNREACHABLE",
  ATTACHMENT_ACCESS_UNVERIFIED: "ATTACHMENT_ACCESS_UNVERIFIED",
  SOURCE_CONFIG_OR_SELECTOR_MISMATCH: "SOURCE_CONFIG_OR_SELECTOR_MISMATCH",
  UNKNOWN_NEEDS_MANUAL_REVIEW: "UNKNOWN_NEEDS_MANUAL_REVIEW",
});

export const OBSERVABILITY_STAGES = Object.freeze([
  "list_fetch",
  "list_decode",
  "list_parse",
  "notice_url_resolution",
  "pagination_check",
  "detail_fetch",
  "detail_content_extract",
  "candidate_filter",
  "final_result",
]);

export const FAILURE_CODES = Object.freeze({
  URL_DEAD_DNS: "URL_DEAD_DNS",
  URL_DEAD_HTTP_404_410: "URL_DEAD_HTTP_404_410",
  SERVER_ERROR_5XX: "SERVER_ERROR_5XX",
  TIMEOUT_OR_CONNECTION_ABORTED: "TIMEOUT_OR_CONNECTION_ABORTED",
  TLS_OR_CERTIFICATE_EXCEPTION: "TLS_OR_CERTIFICATE_EXCEPTION",
  BOT_BLOCKED_OR_RATE_LIMITED: "BOT_BLOCKED_OR_RATE_LIMITED",
  AUTH_OR_CAPTCHA_REQUIRED: "AUTH_OR_CAPTCHA_REQUIRED",
  LIST_SELECTOR_ZERO_MATCHES: "LIST_SELECTOR_ZERO_MATCHES",
  URL_RESOLUTION_FAILED: "URL_RESOLUTION_FAILED",
  DETAIL_FETCH_FAILED: "DETAIL_FETCH_FAILED",
  DETAIL_CONTENT_EMPTY_OR_BOILERPLATE: "DETAIL_CONTENT_EMPTY_OR_BOILERPLATE",
  DETAIL_IDENTITY_UNVERIFIED: "DETAIL_IDENTITY_UNVERIFIED",
  ZERO_RECENT_NOTICES: "ZERO_RECENT_NOTICES",
  FILTERED_OUT_BY_DATE: "FILTERED_OUT_BY_DATE",
  FILTERED_OUT_BY_KEYWORD: "FILTERED_OUT_BY_KEYWORD",
  PAGINATION_UNVERIFIED: "PAGINATION_UNVERIFIED",
  ADAPTER_REQUIRED: "ADAPTER_REQUIRED",
  CONFIG_OR_SELECTOR_MISMATCH: "CONFIG_OR_SELECTOR_MISMATCH",
  MANUAL_BROWSER_NETWORK_REQUIRED: "MANUAL_BROWSER_NETWORK_REQUIRED",
  UNKNOWN_NEEDS_MANUAL_REVIEW: "UNKNOWN_NEEDS_MANUAL_REVIEW",
});

export function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function createRunId(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15);
}

export function normalizeTitleForIdentity(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:notice|공지|공지사항|장학|scholarship)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function verifyDetailTitleIdentity(listTitle, detailTitleCandidates = []) {
  const normalizedListTitle = normalizeTitleForIdentity(listTitle);
  if (!normalizedListTitle || normalizedListTitle.length < 4) {
    return {
      verified: false,
      status: "title_unavailable",
      evidence: "List title is missing or too short for identity verification.",
    };
  }

  const candidates = detailTitleCandidates
    .map((candidate) => ({
      raw: cleanText(candidate),
      normalized: normalizeTitleForIdentity(candidate),
    }))
    .filter((candidate) => candidate.normalized.length >= 4);

  if (candidates.length === 0) {
    return {
      verified: false,
      status: "detail_title_unavailable",
      evidence: "Detail page title, heading, or body title candidate was not available.",
    };
  }

  for (const candidate of candidates) {
    if (
      candidate.normalized === normalizedListTitle ||
      candidate.normalized.includes(normalizedListTitle) ||
      normalizedListTitle.includes(candidate.normalized)
    ) {
      return {
        verified: true,
        status: "title_match",
        evidence: `List title matched detail title candidate: ${candidate.raw.slice(0, 120)}`,
      };
    }
  }

  return {
    verified: false,
    status: "title_mismatch",
    evidence: `List title did not match detail title candidates: ${candidates
      .slice(0, 3)
      .map((candidate) => candidate.raw.slice(0, 80))
      .join(" | ")}`,
  };
}

function stripHtml(value) {
  return cleanText(
    String(value ?? "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"'),
  );
}

export function extractDetailTitleCandidatesFromHtml(html) {
  const source = String(html ?? "");
  const candidates = [];
  const patterns = [
    /<title\b[^>]*>([\s\S]*?)<\/title>/gi,
    /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi,
    /<[^>]+class=["'][^"']*(?:title|subject|heading|view-title|board-title)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match) {
      const text = stripHtml(match[1]);
      if (text) candidates.push(text);
      match = pattern.exec(source);
    }
  }

  return [...new Set(candidates)].slice(0, 8);
}

export function createStageEvent({
  runId,
  source,
  stage,
  status,
  startedAt,
  endedAt = new Date().toISOString(),
  metrics = {},
  error = null,
  failureCode = "",
  evidence = "",
}) {
  const startTime = new Date(startedAt).getTime();
  const endTime = new Date(endedAt).getTime();
  return {
    runId,
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    universitySlug: source.universitySlug,
    sourceLevel: source.sourceLevel,
    stage,
    status,
    startedAt,
    endedAt,
    elapsedMs:
      Number.isFinite(startTime) && Number.isFinite(endTime)
        ? Math.max(0, endTime - startTime)
        : null,
    ...metrics,
    retryCount: metrics.retryCount ?? 0,
    lastErrorName: error?.name ?? "",
    lastErrorMessage: error ? cleanText(error.message ?? error).slice(0, 240) : "",
    lastErrorCode: error?.code ?? "",
    failureCode,
    evidence: cleanText(evidence).slice(0, 500),
  };
}

export function classifyFetchFailure(error, httpStatus = null) {
  const message = cleanText(error?.message ?? error).toLowerCase();
  const code = cleanText(error?.code).toUpperCase();
  const status = Number(httpStatus);

  if ([401, 403].includes(status) || /captcha|login|required|unauthorized|forbidden/.test(message)) {
    return FAILURE_CODES.AUTH_OR_CAPTCHA_REQUIRED;
  }
  if (status === 429 || /rate.?limit|too many requests|blocked|bot/.test(message)) {
    return FAILURE_CODES.BOT_BLOCKED_OR_RATE_LIMITED;
  }
  if ([404, 410].includes(status)) return FAILURE_CODES.URL_DEAD_HTTP_404_410;
  if (status >= 500) return FAILURE_CODES.SERVER_ERROR_5XX;
  if (/timeout|aborted|terminated|socket|econnreset|etimedout/.test(message)) {
    return FAILURE_CODES.TIMEOUT_OR_CONNECTION_ABORTED;
  }
  if (/cert|tls|ssl|self.?signed|certificate/.test(message) || code.includes("CERT")) {
    return FAILURE_CODES.TLS_OR_CERTIFICATE_EXCEPTION;
  }
  if (/enotfound|getaddrinfo|dns/.test(message)) return FAILURE_CODES.URL_DEAD_DNS;
  return FAILURE_CODES.UNKNOWN_NEEDS_MANUAL_REVIEW;
}

export function inferAccessProfiles({
  source,
  html = "",
  httpStatus = null,
  charset = "",
  selectorMatchCount = null,
  linkExtractionCount = null,
  validDetailUrlCount = null,
  detailFailureCount = 0,
  manualNetworkEvidenceRequiredCount = 0,
  formPostRedirectEvidenceCount = 0,
  detailAccessMode = "",
  browserNetworkEvidence = "",
  adapterVerifiedPostRedirect = false,
  adapterName = "",
  fetchFailureCode = "",
}) {
  void httpStatus;
  const profiles = new Set();
  const body = String(html ?? "");
  const lowered = body.toLowerCase();
  const normalizedAdapter = cleanText(adapterName || source.adapter).toLowerCase();

  if (normalizedAdapter) profiles.add(ACCESS_PROFILES.JSON_XHR_API);
  if (charset && !["utf-8", "utf8"].includes(cleanText(charset).toLowerCase())) {
    profiles.add(ACCESS_PROFILES.LEGACY_CHARSET);
  }
  if (fetchFailureCode === FAILURE_CODES.TLS_OR_CERTIFICATE_EXCEPTION) {
    profiles.add(ACCESS_PROFILES.TLS_OR_CERTIFICATE_EXCEPTION);
  }
  if (fetchFailureCode === FAILURE_CODES.BOT_BLOCKED_OR_RATE_LIMITED) {
    profiles.add(ACCESS_PROFILES.BOT_BLOCKED_OR_RATE_LIMITED);
  }
  if (fetchFailureCode === FAILURE_CODES.AUTH_OR_CAPTCHA_REQUIRED) {
    profiles.add(ACCESS_PROFILES.AUTH_OR_CAPTCHA_REQUIRED);
  }
  if (detailFailureCount > 0) profiles.add(ACCESS_PROFILES.DETAIL_PAGE_UNREACHABLE);
  if (manualNetworkEvidenceRequiredCount > 0) {
    profiles.add(ACCESS_PROFILES.STATIC_HTML_EVENT_URL);
  }

  if (/onclick\s*=|javascript:|data-href|data-url|data-link/.test(lowered)) {
    profiles.add(ACCESS_PROFILES.STATIC_HTML_EVENT_URL);
  }
  const normalizedDetailAccessMode = cleanText(
    detailAccessMode || source.detailAccessMode || source.detail_access_mode,
  ).toLowerCase();
  const normalizedBrowserEvidence = cleanText(
    browserNetworkEvidence || source.browserNetworkEvidence || source.browser_network_evidence,
  ).toLowerCase();
  const hasDirectFormPostRedirectEvidence =
    normalizedDetailAccessMode === "form_post_redirect" ||
    normalizedDetailAccessMode === "post_redirect" ||
    Number(formPostRedirectEvidenceCount) > 0 ||
    adapterVerifiedPostRedirect === true ||
    /post\s*(?:->|→|redirect)|form_post_redirect|302\s*redirect/.test(normalizedBrowserEvidence);
  if (hasDirectFormPostRedirectEvidence) {
    profiles.add(ACCESS_PROFILES.FORM_POST_REDIRECT);
  }
  if (/pagination|pageNo|pageIndex|paging|paginate|next|prev/i.test(body)) {
    profiles.add(ACCESS_PROFILES.SERVER_RENDERED_WITH_PAGINATION);
  }
  if (
    /__NEXT_DATA__|<div[^>]+id=["'](?:root|app)["']|ng-app|vue|react/i.test(body) &&
    Number(selectorMatchCount ?? 0) === 0
  ) {
    profiles.add(ACCESS_PROFILES.CLIENT_RENDERED_OR_JS_REQUIRED);
  }
  if (Number(selectorMatchCount ?? 0) === 0 && source.listItemSelector) {
    profiles.add(ACCESS_PROFILES.SOURCE_CONFIG_OR_SELECTOR_MISMATCH);
  }
  if (Number(linkExtractionCount ?? validDetailUrlCount ?? 0) > 0) {
    profiles.add(ACCESS_PROFILES.STATIC_HTML_HREF);
  }
  if (profiles.size === 0) {
    profiles.add(ACCESS_PROFILES.UNKNOWN_NEEDS_MANUAL_REVIEW);
  }

  return [...profiles];
}

export function decidePrimaryFailureCode({
  fetchFailureCode = "",
  selectorMatchCount = null,
  linkExtractionCount = null,
  validDetailUrlCount = null,
  detailFailureCount = 0,
  detailContentEmptyCount = 0,
  detailIdentityUnverifiedCount = 0,
  detailSampleCount = 0,
  manualNetworkEvidenceRequiredCount = 0,
  parsedDateCount = 0,
  keywordMatchCount = 0,
  finalCandidateCount = 0,
  crawledCount = 0,
  hasConfiguredSelector = false,
  paginationVerified = false,
}) {
  if (fetchFailureCode) return fetchFailureCode;
  if (hasConfiguredSelector && Number(selectorMatchCount ?? 0) === 0) {
    return FAILURE_CODES.LIST_SELECTOR_ZERO_MATCHES;
  }
  if (Number(manualNetworkEvidenceRequiredCount) > 0 && Number(linkExtractionCount ?? 0) === 0) {
    return FAILURE_CODES.MANUAL_BROWSER_NETWORK_REQUIRED;
  }
  if (Number(crawledCount) > 0 && Number(linkExtractionCount ?? 0) === 0) {
    return FAILURE_CODES.URL_RESOLUTION_FAILED;
  }
  if (Number(linkExtractionCount ?? 0) > 0 && Number(validDetailUrlCount ?? 0) === 0) {
    return FAILURE_CODES.URL_RESOLUTION_FAILED;
  }
  if (Number(detailFailureCount) > 0) return FAILURE_CODES.DETAIL_FETCH_FAILED;
  if (Number(detailContentEmptyCount) > 0 && Number(crawledCount) > 0) {
    return FAILURE_CODES.DETAIL_CONTENT_EMPTY_OR_BOILERPLATE;
  }
  if (Number(detailSampleCount) > 0 && Number(detailIdentityUnverifiedCount) > 0) {
    return FAILURE_CODES.DETAIL_IDENTITY_UNVERIFIED;
  }
  if (!paginationVerified && Number(crawledCount) > 0) return FAILURE_CODES.PAGINATION_UNVERIFIED;
  if (Number(crawledCount) === 0) return FAILURE_CODES.ZERO_RECENT_NOTICES;
  if (Number(keywordMatchCount) === 0) return FAILURE_CODES.FILTERED_OUT_BY_KEYWORD;
  if (Number(parsedDateCount) === 0 && Number(finalCandidateCount) === 0) {
    return FAILURE_CODES.FILTERED_OUT_BY_DATE;
  }
  return "";
}

export function makeSourceDecision({ profiles = [], failureCode = "", finalCandidateCount = 0 }) {
  if (failureCode === FAILURE_CODES.MANUAL_BROWSER_NETWORK_REQUIRED) {
    return "manual_review_required";
  }
  if (failureCode === FAILURE_CODES.ADAPTER_REQUIRED) {
    return "adapter_required";
  }
  if (failureCode === FAILURE_CODES.DETAIL_IDENTITY_UNVERIFIED) {
    return "supported_with_unverified_identity";
  }
  if (
    profiles.includes(ACCESS_PROFILES.AUTH_OR_CAPTCHA_REQUIRED) ||
    profiles.includes(ACCESS_PROFILES.BOT_BLOCKED_OR_RATE_LIMITED)
  ) {
    return "manual_review_required";
  }
  if (
    profiles.includes(ACCESS_PROFILES.JSON_XHR_API) ||
    profiles.includes(ACCESS_PROFILES.FORM_POST_REDIRECT) ||
    profiles.includes(ACCESS_PROFILES.CLIENT_RENDERED_OR_JS_REQUIRED)
  ) {
    return "adapter_required";
  }
  if (
    [
      FAILURE_CODES.LIST_SELECTOR_ZERO_MATCHES,
      FAILURE_CODES.URL_RESOLUTION_FAILED,
      FAILURE_CODES.CONFIG_OR_SELECTOR_MISMATCH,
    ].includes(failureCode)
  ) {
    return "config_or_selector_fix";
  }
  if (failureCode === FAILURE_CODES.ZERO_RECENT_NOTICES && Number(finalCandidateCount) === 0) {
    return "valid_zero_candidates";
  }
  if (!failureCode) return "supported";
  return "manual_review_required";
}
