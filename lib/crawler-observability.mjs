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
  LIST_SELECTOR_MENU_CONTAMINATION: "LIST_SELECTOR_MENU_CONTAMINATION",
  URL_RESOLUTION_FAILED: "URL_RESOLUTION_FAILED",
  DETAIL_URL_UNVERIFIED: "DETAIL_URL_UNVERIFIED",
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

function normalizeBracketedTitleSegment(match, innerText) {
  const inner = cleanText(innerText);
  if (!inner) return " ";
  if (
    inner.length <= 12 &&
    /^(?:notice|new|공지|공고|안내|알림|필독|중요|학부|대학원|일반|장학|행사|세미나|행사\/세미나|채용|홍보|모집|수업|학사|입학|졸업)$/iu.test(
      inner,
    )
  ) {
    return " ";
  }
  return ` ${inner} `;
}

export function normalizeTitleForIdentity(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\[([^\]]*)]/g, normalizeBracketedTitleSegment)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:notice|공지|공지사항|장학|scholarship)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripNoticePrefix(value) {
  return cleanText(value)
    .replace(/^\d+[.)]\s*/u, "")
    .replace(/^(?:new|n|신규)\s+/iu, "")
    .replace(/^(?:제목|subject|title)\s*[:：]\s*/iu, "")
    .replace(/^\[[^\]]*(?:notice|공지|일반공지|장학|학사)[^\]]*\]\s*/iu, "")
    .replace(/^(?:notice|공지|일반공지|장학공지|학사공지)\s+/iu, "")
    .trim();
}

function firstTitleSegment(value) {
  return cleanText(value).split(/\s*(?:\||>|::| - | – | — )\s*/u)[0] ?? "";
}

export function verifyDetailTitleIdentity(listTitle, detailTitleCandidates = [], options = {}) {
  const rawListText = cleanText(options.rawListText);
  const listTitleQuality = cleanText(options.listTitleQuality || "clean");
  const normalizedListTitle = normalizeTitleForIdentity(listTitle);
  const normalizedPrefixStrippedListTitle = normalizeTitleForIdentity(stripNoticePrefix(listTitle));
  if (!normalizedListTitle || normalizedListTitle.length < 4) {
    return {
      verified: false,
      status: "title_unavailable",
      comparisonMode: "title_unavailable",
      evidence: "List title is missing or too short for identity verification.",
    };
  }
  const candidates = detailTitleCandidates
    .map((candidate) => ({
      raw: cleanText(candidate),
      normalized: normalizeTitleForIdentity(candidate),
      normalizedFirstSegment: normalizeTitleForIdentity(firstTitleSegment(candidate)),
      normalizedPrefixStripped: normalizeTitleForIdentity(stripNoticePrefix(firstTitleSegment(candidate))),
      normalizedSegments: cleanText(candidate)
        .split(/\s*(?:\||>|::| - | – | — )\s*/u)
        .map((segment) => normalizeTitleForIdentity(stripNoticePrefix(segment)))
        .filter(Boolean),
    }))
    .filter((candidate) => candidate.normalized.length >= 4);

  if (candidates.length === 0) {
    return {
      verified: false,
      status: "detail_title_unavailable",
      comparisonMode: "detail_title_unavailable",
      evidence: "Detail page title, heading, or body title candidate was not available.",
    };
  }

  for (const candidate of candidates) {
    if (candidate.normalized === normalizedListTitle) {
      return {
        verified: true,
        status: "title_match",
        comparisonMode: "normalized_exact",
        matchedTitle: candidate.raw,
        evidence: `List title matched detail title candidate: ${candidate.raw.slice(0, 120)}`,
      };
    }
    if (
      normalizedPrefixStrippedListTitle &&
      candidate.normalizedPrefixStripped &&
      candidate.normalizedPrefixStripped === normalizedPrefixStrippedListTitle
    ) {
      return {
        verified: true,
        status: "title_match",
        comparisonMode: "notice_prefix_stripped_exact",
        matchedTitle: candidate.raw,
        evidence: `List title matched detail title candidate after notice prefix stripping: ${candidate.raw.slice(0, 120)}`,
      };
    }
    if (
      candidate.normalizedFirstSegment &&
      (candidate.normalizedFirstSegment === normalizedListTitle ||
        candidate.normalizedFirstSegment === normalizedPrefixStrippedListTitle)
    ) {
      return {
        verified: true,
        status: "title_match",
        comparisonMode: "detail_title_site_suffix_stripped",
        matchedTitle: candidate.raw,
        evidence: `List title matched first detail title segment: ${candidate.raw.slice(0, 120)}`,
      };
    }
    if (
      candidate.normalizedSegments.some(
        (segment) =>
          segment === normalizedListTitle || segment === normalizedPrefixStrippedListTitle,
      )
    ) {
      return {
        verified: true,
        status: "title_match",
        comparisonMode: "detail_title_segment_match",
        matchedTitle: candidate.raw,
        evidence: `List title matched a delimited detail title segment: ${candidate.raw.slice(0, 120)}`,
      };
    }
    const normalizedSuffix = candidate.normalized.startsWith(normalizedListTitle)
      ? candidate.normalized.slice(normalizedListTitle.length).trim()
      : "";
    if (
      normalizedSuffix &&
      normalizedSuffix.length <= 20 &&
      /^(?:(?:대학원|학부|일반|공지|새 글|new|hit|views?|조회수?)\s*\d*\s*)+$/iu.test(normalizedSuffix)
    ) {
      return {
        verified: true,
        status: "title_match",
        comparisonMode: "detail_title_metadata_suffix_stripped",
        matchedTitle: candidate.raw,
        evidence: `List title matched detail title after stripping a bounded metadata suffix: ${candidate.raw.slice(0, 120)}`,
      };
    }
    if (
      /(?:\.{2,}|…)$/.test(cleanText(listTitle)) &&
      candidate.normalized.startsWith(normalizedListTitle) &&
      candidate.normalized.length - normalizedListTitle.length <= 40
    ) {
      return {
        verified: true,
        status: "title_match",
        comparisonMode: "truncated_list_title_prefix",
        matchedTitle: candidate.raw,
        evidence: `Truncated list title matched the beginning of the detail title: ${candidate.raw.slice(0, 120)}`,
      };
    }
    const candidateOffset = normalizedListTitle.indexOf(candidate.normalized);
    if (candidateOffset >= 0) {
      const metadataPrefix = normalizedListTitle.slice(0, candidateOffset).trim();
      const metadataSuffix = normalizedListTitle
        .slice(candidateOffset + candidate.normalized.length)
        .trim();
      const allowedPrefix =
        !metadataPrefix ||
        /^(?:(?:\d{2,4}\s+){1,3}|undergraduate|graduate|대학원|학부|학사|행사|새 글|공지|일반공지|치과대학|대학\s*)+$/iu.test(
          metadataPrefix,
        );
      const allowedSuffix =
        !metadataSuffix ||
        /^(?:안내|attach file|new|updated|hit|views?|조회수?|작성일|\d{1,4}\s*)+$/iu.test(
          metadataSuffix,
        );
      if (allowedPrefix && allowedSuffix) {
        return {
          verified: true,
          status: "title_match",
          comparisonMode: "list_metadata_stripped",
          matchedTitle: candidate.raw,
          evidence: `Detail title matched after stripping bounded list badges and metadata: ${candidate.raw.slice(0, 120)}`,
        };
      }
    }
    const listOffset = candidate.normalized.indexOf(normalizedListTitle);
    if (listOffset >= 0) {
      const detailPrefix = candidate.normalized.slice(0, listOffset).trim();
      const detailSuffix = candidate.normalized.slice(listOffset + normalizedListTitle.length).trim();
      if (
        (!detailPrefix || /^(?:공지|일반공지|학사|학부|대학원)$/u.test(detailPrefix)) &&
        (!detailSuffix || /^(?:updated|new|hit\s*\d*|views?\s*\d*)$/iu.test(detailSuffix))
      ) {
        return {
          verified: true,
          status: "title_match",
          comparisonMode: "detail_metadata_stripped",
          matchedTitle: candidate.raw,
          evidence: `List title matched after stripping bounded detail badges and metadata: ${candidate.raw.slice(0, 120)}`,
        };
      }
    }
    if (listTitleQuality === "contaminated") {
      continue;
    }
    if (
      rawListText &&
      normalizeTitleForIdentity(rawListText).includes(candidate.normalized) &&
      normalizedListTitle.includes(candidate.normalized)
    ) {
      return {
        verified: false,
        status: "weak_raw_list_contains_detail_title",
        comparisonMode: "raw_list_contains_detail_title_only",
        evidence: "Detail title appeared inside raw list/card text, but the extracted list title was broader than the detail title.",
      };
    }
  }

  if (listTitleQuality === "contaminated") {
    return {
      verified: false,
      status: "list_title_not_clean",
      comparisonMode: "list_title_quality_failed",
      evidence: `List title quality is ${listTitleQuality}.`,
    };
  }

  return {
    verified: false,
    status: "title_mismatch",
    comparisonMode: "title_mismatch",
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
  const chain = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    chain.push(current);
    current = current.cause;
  }
  const message = chain
    .map((item) => cleanText(item?.message ?? item))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const code = chain
    .map((item) => cleanText(item?.code))
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
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
  if (
    /cert|tls|ssl|self.?signed|certificate|unable to verify/.test(message) ||
    /CERT|TLS|SSL|UNABLE_TO_VERIFY/.test(code)
  ) {
    return FAILURE_CODES.TLS_OR_CERTIFICATE_EXCEPTION;
  }
  if (/enotfound|getaddrinfo|dns/.test(message)) return FAILURE_CODES.URL_DEAD_DNS;
  return FAILURE_CODES.UNKNOWN_NEEDS_MANUAL_REVIEW;
}

function makeProfileEvidence(reason, evidenceType, evidenceValue = "") {
  return {
    reason,
    evidence_type: evidenceType,
    evidence_value: cleanText(evidenceValue).slice(0, 240),
  };
}

export function inferAccessProfileDetails({
  source,
  html = "",
  httpStatus = null,
  charset = "",
  selectorMatchCount = null,
  linkExtractionCount = null,
  validDetailUrlCount = null,
  eventUrlEvidenceCount = 0,
  paginationEvidenceCount = 0,
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
  const profileEvidence = {};
  const body = String(html ?? "");
  const normalizedAdapter = cleanText(adapterName || source.adapter).toLowerCase();

  function addProfile(profile, evidence) {
    profiles.add(profile);
    if (!profileEvidence[profile]) profileEvidence[profile] = evidence;
  }

  if (normalizedAdapter) {
    addProfile(
      ACCESS_PROFILES.JSON_XHR_API,
      makeProfileEvidence(
        `registered adapter=${normalizedAdapter}`,
        "adapter_config",
        normalizedAdapter,
      ),
    );
  }
  if (charset && !["utf-8", "utf8"].includes(cleanText(charset).toLowerCase())) {
    addProfile(
      ACCESS_PROFILES.LEGACY_CHARSET,
      makeProfileEvidence("response charset is not utf-8", "response_header", charset),
    );
  }
  if (fetchFailureCode === FAILURE_CODES.TLS_OR_CERTIFICATE_EXCEPTION) {
    addProfile(
      ACCESS_PROFILES.TLS_OR_CERTIFICATE_EXCEPTION,
      makeProfileEvidence("fetch failure indicates TLS/certificate issue", "fetch_failure", fetchFailureCode),
    );
  }
  if (fetchFailureCode === FAILURE_CODES.BOT_BLOCKED_OR_RATE_LIMITED) {
    addProfile(
      ACCESS_PROFILES.BOT_BLOCKED_OR_RATE_LIMITED,
      makeProfileEvidence("fetch failure indicates bot blocking or rate limiting", "fetch_failure", fetchFailureCode),
    );
  }
  if (fetchFailureCode === FAILURE_CODES.AUTH_OR_CAPTCHA_REQUIRED) {
    addProfile(
      ACCESS_PROFILES.AUTH_OR_CAPTCHA_REQUIRED,
      makeProfileEvidence("fetch failure indicates auth or CAPTCHA requirement", "fetch_failure", fetchFailureCode),
    );
  }
  if (detailFailureCount > 0) {
    addProfile(
      ACCESS_PROFILES.DETAIL_PAGE_UNREACHABLE,
      makeProfileEvidence("sample detail fetch failed", "detail_fetch", `${detailFailureCount}`),
    );
  }
  if (manualNetworkEvidenceRequiredCount > 0) {
    addProfile(
      ACCESS_PROFILES.STATIC_HTML_EVENT_URL,
      makeProfileEvidence(
        "placeholder href or event navigation requires manual Network evidence",
        "parser_evidence",
        `${manualNetworkEvidenceRequiredCount}`,
      ),
    );
  }

  if (Number(eventUrlEvidenceCount) > 0) {
    addProfile(
      ACCESS_PROFILES.STATIC_HTML_EVENT_URL,
      makeProfileEvidence(
        "notice candidates contain event/data-url navigation evidence",
        "parser_evidence",
        `${eventUrlEvidenceCount}`,
      ),
    );
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
    /post\s*(?:->|redirect)|form_post_redirect|302\s*redirect/.test(normalizedBrowserEvidence);
  if (hasDirectFormPostRedirectEvidence) {
    let evidence = makeProfileEvidence(
      "parser confirmed placeholder detail link maps to POST payload",
      "parser_evidence",
      `${formPostRedirectEvidenceCount}`,
    );
    if (normalizedDetailAccessMode === "form_post_redirect" || normalizedDetailAccessMode === "post_redirect") {
      evidence = makeProfileEvidence(
        `source_config.detail_access_mode=${normalizedDetailAccessMode}`,
        "source_config",
        normalizedDetailAccessMode,
      );
    } else if (normalizedBrowserEvidence) {
      evidence = makeProfileEvidence(
        "source_config.browser_network_evidence indicates POST redirect",
        "browser_network_evidence",
        normalizedBrowserEvidence,
      );
    } else if (adapterVerifiedPostRedirect === true) {
      evidence = makeProfileEvidence(
        "registered adapter verified POST redirect detail access",
        "adapter_capability",
        normalizedAdapter,
      );
    }
    addProfile(ACCESS_PROFILES.FORM_POST_REDIRECT, evidence);
  }
  if (Number(paginationEvidenceCount) > 0) {
    addProfile(
      ACCESS_PROFILES.SERVER_RENDERED_WITH_PAGINATION,
      makeProfileEvidence(
        "list area contains pagination markers",
        "parser_evidence",
        `${paginationEvidenceCount}`,
      ),
    );
  }
  if (
    /__NEXT_DATA__|<div[^>]+id=["'](?:root|app)["']|ng-app|vue|react/i.test(body) &&
    Number(selectorMatchCount ?? 0) === 0
  ) {
    addProfile(
      ACCESS_PROFILES.CLIENT_RENDERED_OR_JS_REQUIRED,
      makeProfileEvidence("client app markers present and selector matched zero items", "html_hint", "root/app framework marker"),
    );
  }
  if (Number(selectorMatchCount ?? 0) === 0 && source.listItemSelector) {
    addProfile(
      ACCESS_PROFILES.SOURCE_CONFIG_OR_SELECTOR_MISMATCH,
      makeProfileEvidence("configured list selector matched zero items", "selector", source.listItemSelector),
    );
  }
  if (Number(linkExtractionCount ?? validDetailUrlCount ?? 0) > 0) {
    addProfile(
      ACCESS_PROFILES.STATIC_HTML_HREF,
      makeProfileEvidence("crawler resolved static GET detail URLs", "parser_evidence", `${linkExtractionCount ?? validDetailUrlCount}`),
    );
  }
  if (profiles.size === 0) {
    addProfile(
      ACCESS_PROFILES.UNKNOWN_NEEDS_MANUAL_REVIEW,
      makeProfileEvidence("no known access profile evidence matched", "fallback", ""),
    );
  }

  return { profiles: [...profiles], profileEvidence };
}

export function inferAccessProfiles(options) {
  return inferAccessProfileDetails(options).profiles;
}

export function decidePrimaryFailureCode({
  fetchFailureCode = "",
  selectorMatchCount = null,
  linkExtractionCount = null,
  validDetailUrlCount = null,
  listMenuContaminationDetected = false,
  fallbackScanUsed = false,
  detailFailureCount = 0,
  detailContentEmptyCount = 0,
  detailIdentityUnverifiedCount = 0,
  detailFetchSuccessCount = 0,
  detailUrlVerifiedCount = 0,
  detailSampleCount = 0,
  contaminatedCandidateLeakCount = 0,
  manualNetworkEvidenceRequiredCount = 0,
  parsedDateCount = 0,
  keywordMatchCount = 0,
  finalCandidateCount = 0,
  crawledCount = 0,
  hasConfiguredSelector = false,
  explicitEmptyStateDetected = false,
}) {
  if (fetchFailureCode) return fetchFailureCode;
  if (explicitEmptyStateDetected && Number(crawledCount) === 0) {
    return FAILURE_CODES.ZERO_RECENT_NOTICES;
  }
  if (listMenuContaminationDetected) return FAILURE_CODES.LIST_SELECTOR_MENU_CONTAMINATION;
  if (hasConfiguredSelector && Number(selectorMatchCount ?? 0) === 0) {
    return FAILURE_CODES.LIST_SELECTOR_ZERO_MATCHES;
  }
  if (fallbackScanUsed && Number(crawledCount) === 0) {
    return FAILURE_CODES.CONFIG_OR_SELECTOR_MISMATCH;
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
  if (Number(crawledCount) === 0) return FAILURE_CODES.ZERO_RECENT_NOTICES;
  if (Number(keywordMatchCount) === 0 || Number(finalCandidateCount) === 0) {
    return FAILURE_CODES.FILTERED_OUT_BY_KEYWORD;
  }
  if (Number(contaminatedCandidateLeakCount) > 0) {
    return FAILURE_CODES.DETAIL_IDENTITY_UNVERIFIED;
  }
  if (Number(detailFailureCount) > 0) return FAILURE_CODES.DETAIL_FETCH_FAILED;
  if (Number(crawledCount) > 0 && Number(detailSampleCount) === 0) {
    return FAILURE_CODES.DETAIL_URL_UNVERIFIED;
  }
  if (Number(detailSampleCount) > 0 && Number(detailFetchSuccessCount) === 0) {
    return FAILURE_CODES.DETAIL_FETCH_FAILED;
  }
  if (Number(detailContentEmptyCount) > 0 && Number(crawledCount) > 0) {
    return FAILURE_CODES.DETAIL_CONTENT_EMPTY_OR_BOILERPLATE;
  }
  if (Number(detailSampleCount) > 0 && Number(detailUrlVerifiedCount) === 0) {
    return FAILURE_CODES.DETAIL_IDENTITY_UNVERIFIED;
  }
  if (Number(detailSampleCount) > 0 && Number(detailIdentityUnverifiedCount) > 0) {
    return FAILURE_CODES.DETAIL_IDENTITY_UNVERIFIED;
  }
  if (Number(parsedDateCount) === 0 && Number(finalCandidateCount) === 0) {
    return FAILURE_CODES.FILTERED_OUT_BY_DATE;
  }
  return "";
}

export function makeSourceDecision({
  profiles = [],
  failureCode = "",
  finalCandidateCount = 0,
  detailSampleCount = 0,
  detailFetchSuccessCount = 0,
  detailUrlVerifiedCount = 0,
  contaminatedCandidateLeakCount = 0,
}) {
  if (failureCode === FAILURE_CODES.MANUAL_BROWSER_NETWORK_REQUIRED) {
    return "manual_review_required";
  }
  if (failureCode === FAILURE_CODES.ADAPTER_REQUIRED) {
    return "adapter_required";
  }
  if (failureCode === FAILURE_CODES.DETAIL_FETCH_FAILED) {
    return "list_supported_detail_failed";
  }
  if (
    [
      FAILURE_CODES.DETAIL_URL_UNVERIFIED,
      FAILURE_CODES.DETAIL_IDENTITY_UNVERIFIED,
      FAILURE_CODES.DETAIL_CONTENT_EMPTY_OR_BOILERPLATE,
    ].includes(failureCode)
  ) {
    return "list_supported_detail_unverified";
  }
  if (
    !failureCode &&
    Number(detailSampleCount) >= 1 &&
    Number(detailFetchSuccessCount) >= 1 &&
    Number(detailUrlVerifiedCount) >= 1 &&
    Number(contaminatedCandidateLeakCount) === 0
  ) {
    return "supported";
  }
  if (
    profiles.includes(ACCESS_PROFILES.AUTH_OR_CAPTCHA_REQUIRED) ||
    profiles.includes(ACCESS_PROFILES.BOT_BLOCKED_OR_RATE_LIMITED)
  ) {
    return "manual_review_required";
  }
  if (Number(finalCandidateCount) === 0) {
    if (failureCode === FAILURE_CODES.FILTERED_OUT_BY_KEYWORD) {
      return "posts_found_no_scholarship";
    }
    if (failureCode === FAILURE_CODES.ZERO_RECENT_NOTICES) {
      return "no_posts_detected";
    }
    if (failureCode === FAILURE_CODES.FILTERED_OUT_BY_DATE) {
      return "valid_zero_candidates";
    }
  }
  if (
    profiles.includes(ACCESS_PROFILES.JSON_XHR_API) ||
    profiles.includes(ACCESS_PROFILES.CLIENT_RENDERED_OR_JS_REQUIRED)
  ) {
    return "adapter_required";
  }
  if (
    [
      FAILURE_CODES.LIST_SELECTOR_ZERO_MATCHES,
      FAILURE_CODES.LIST_SELECTOR_MENU_CONTAMINATION,
      FAILURE_CODES.URL_RESOLUTION_FAILED,
      FAILURE_CODES.CONFIG_OR_SELECTOR_MISMATCH,
    ].includes(failureCode)
  ) {
    return "config_or_selector_fix";
  }
  if (!failureCode) return "list_supported_detail_unverified";
  return "manual_review_required";
}
