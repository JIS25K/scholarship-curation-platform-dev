import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getListAdapter,
  normalizePublicAccessUrl,
} from "../lib/crawler-adapters/index.mjs";
import { parseNoticeList } from "../lib/crawler-parsers/list-parser.mjs";
import { parseNoticeDetail } from "../lib/crawler-parsers/detail-parser.mjs";
import { applyOfficialSourceFallbacks } from "../lib/crawler-source-fallbacks.mjs";
import {
  cleanText,
  classifyFetchFailure,
  countBy,
  createRunId,
  createStageEvent,
  decidePrimaryFailureCode,
  FAILURE_CODES,
  inferAccessProfileDetails,
  makeSourceDecision,
  verifyDetailTitleIdentity,
} from "../lib/crawler-observability.mjs";

const INPUT_CSV_PATH = process.argv[2] ?? "data/notice-sources.csv";
const OUTPUT_DIR = process.argv[3] ?? "exports/notices/diagnostics";
const REQUEST_TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS ?? 12_000);
const REQUEST_RETRY_COUNT = Math.max(0, Number(process.env.AUDIT_RETRY_COUNT ?? 1));
const REQUEST_RETRY_BACKOFF_MS = Math.max(200, Number(process.env.AUDIT_RETRY_BACKOFF_MS ?? 750));
const DEFAULT_AUDIT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const AUDIT_USER_AGENT = cleanText(process.env.AUDIT_USER_AGENT ?? DEFAULT_AUDIT_USER_AGENT);
const CONCURRENCY = Math.max(1, Number(process.env.AUDIT_CONCURRENCY ?? 1));
const LIMIT = Math.max(0, Number(process.env.AUDIT_LIMIT ?? 0));
const DETAIL_SAMPLE_SIZE = Math.min(1, Math.max(0, Number(process.env.AUDIT_DETAIL_SAMPLE_SIZE ?? 1)));
const DETAIL_CONTENT_MIN_CHARS = Math.max(1, Number(process.env.AUDIT_DETAIL_CONTENT_MIN_CHARS ?? 80));
const SOURCE_ID_PREFIX = cleanText(process.env.AUDIT_SOURCE_ID_PREFIX ?? "").toLowerCase();
const SOURCE_ID_ALLOWLIST = new Set(
  String(process.env.AUDIT_SOURCE_ID_ALLOWLIST ?? "")
    .split(/[,\s|]+/)
    .map((value) => cleanText(value).toLowerCase())
    .filter(Boolean),
);
const FALLBACK_CHARSET = process.env.AUDIT_FALLBACK_CHARSET ?? "utf-8";
const RUN_AT = new Date().toISOString();
const RUN_ID = createRunId(new Date(RUN_AT));
const DEFAULT_AUDIT_KEYWORDS = [
  "장학",
  "장학금",
  "학자금",
  "등록금",
  "scholarship",
  "tuition",
  "financial aid",
  "fellowship",
];

function matchesSourceKeywords(source, item) {
  const keywords = source.keywords.length > 0 ? source.keywords : DEFAULT_AUDIT_KEYWORDS;
  const searchable = cleanText(
    [item.title, item.dateText, item.detailDate, item.content].filter(Boolean).join(" "),
  ).toLowerCase();
  return keywords.some((keyword) => searchable.includes(cleanText(keyword).toLowerCase()));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split("|")
    .map((piece) => cleanText(piece))
    .filter(Boolean);
}

function toBoolean(value, defaultValue = true) {
  if (!value) return defaultValue;
  const lowered = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(lowered)) return true;
  if (["false", "0", "no", "n"].includes(lowered)) return false;
  return defaultValue;
}

function deriveUniversitySlug(sourceId, fallback = "") {
  const normalizedSourceId = cleanText(sourceId).toLowerCase();
  if (normalizedSourceId.includes("_")) return normalizedSourceId.split("_")[0];
  return cleanText(fallback).toLowerCase();
}

function readSourceConfig(csvPath) {
  const raw = fs.readFileSync(path.resolve(csvPath), "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(raw);
  if (table.length === 0) throw new Error("Source CSV is empty.");

  const [header, ...body] = table;
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const required = ["source_id", "source_name", "list_url"];
  for (const column of required) {
    if (!(column in index)) throw new Error(`Missing required CSV column: ${column}`);
  }

  const sources = body
    .filter((row) => row.some((cell) => cleanText(cell)))
    .map((row) => ({
      sourceConfigFile: path.resolve(csvPath),
      sourceId: cleanText(row[index.source_id]),
      universitySlug: deriveUniversitySlug(row[index.source_id], row[index.university_slug]),
      universityId: cleanText(row[index.university_id]),
      collegeId: cleanText(row[index.college_id]),
      departmentId: cleanText(row[index.department_id]),
      collegeName: cleanText(row[index.college_name]),
      departmentName: cleanText(row[index.department_name]),
      sourceLevel: cleanText(row[index.source_level]) || "department",
      sourceName: cleanText(row[index.source_name]),
      listUrl: cleanText(row[index.list_url]),
      baseUrl: cleanText(row[index.base_url]),
      listItemSelector: cleanText(row[index.list_item_selector]),
      linkSelector: cleanText(row[index.link_selector]),
      titleSelector: cleanText(row[index.title_selector]),
      dateSelector: cleanText(row[index.date_selector]),
      detailContentSelector: cleanText(row[index.detail_content_selector]),
      detailDateSelector: cleanText(row[index.detail_date_selector]),
      noticeUrlPattern: cleanText(row[index.notice_url_pattern]),
      keywords: parseList(row[index.keywords]),
      adapter: cleanText(row[index.adapter]),
      detailAccessMode: cleanText(row[index.detail_access_mode]),
      browserNetworkEvidence: cleanText(row[index.browser_network_evidence] ?? row[index.evidence_metadata]),
      enabled: toBoolean(row[index.enabled], true),
    }))
    .filter((source) => source.sourceId && source.sourceName && source.listUrl && source.enabled);
  return applyOfficialSourceFallbacks(sources);
}

function normalizeCharset(value) {
  const normalized = cleanText(value).toLowerCase().replace(/^['"]|['"]$/g, "");
  if (!normalized) return "";
  if (normalized === "utf8") return "utf-8";
  if (["euc_kr", "cp949", "ms949", "ks_c_5601-1987"].includes(normalized)) return "euc-kr";
  return normalized;
}

function detectCharsetFromHeaders(contentType) {
  const match = cleanText(contentType).match(/charset\s*=\s*([^;]+)/i);
  return match ? normalizeCharset(match[1]) : "";
}

function detectCharsetFromHtmlProbe(htmlProbe) {
  const metaCharset = String(htmlProbe ?? "").match(
    /<meta[^>]*charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i,
  );
  if (metaCharset?.[1]) return normalizeCharset(metaCharset[1]);
  const metaContent = String(htmlProbe ?? "").match(
    /<meta[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9._-]+)/i,
  );
  return metaContent?.[1] ? normalizeCharset(metaContent[1]) : "";
}

function decodeHtmlBuffer(buffer, headerCharset) {
  const probe = new TextDecoder("latin1").decode(buffer.subarray(0, 4096));
  const metaCharset = detectCharsetFromHtmlProbe(probe);
  const candidates = [headerCharset, metaCharset, FALLBACK_CHARSET, "utf-8", "euc-kr"]
    .map((value) => normalizeCharset(value))
    .filter(Boolean);

  for (const charset of [...new Set(candidates)]) {
    try {
      return {
        html: new TextDecoder(charset, { fatal: true }).decode(buffer),
        charset,
      };
    } catch {
      // Try the next candidate.
    }
  }

  const lossyCandidates = [...new Set(candidates)].flatMap((charset) => {
    try {
      const html = new TextDecoder(charset).decode(buffer);
      return [{ html, charset, replacementCount: (html.match(/�/g) ?? []).length }];
    } catch {
      return [];
    }
  });
  const best = lossyCandidates.sort(
    (left, right) => left.replacementCount - right.replacementCount,
  )[0];
  return best ?? { html: new TextDecoder("utf-8").decode(buffer), charset: "utf-8" };
}

function resolvePublicAccessUrl(value) {
  try {
    const url = new URL(normalizePublicAccessUrl(value));
    if (/\.uos\.ac\.kr$/i.test(url.hostname) && /\/korNotice\//i.test(url.pathname)) {
      url.searchParams.set("identified", "anonymous");
    }
    return url.toString();
  } catch {
    return value;
  }
}

async function fetchHtmlWithTrace(url) {
  const requestUrl = resolvePublicAccessUrl(url);
  let lastError = null;
  let lastStatus = null;
  let finalUrl = url;
  let redirected = false;

  for (let attempt = 0; attempt <= REQUEST_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(requestUrl, {
        signal: controller.signal,
        headers: {
          "user-agent": AUDIT_USER_AGENT,
          accept: "text/html,application/xhtml+xml",
        },
      });
      lastStatus = response.status;
      finalUrl = response.url || url;
      redirected = finalUrl !== url;
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      const headerCharset = detectCharsetFromHeaders(contentType);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const decoded = decodeHtmlBuffer(bytes, headerCharset);
      return {
        html: decoded.html,
        httpStatus: response.status,
        finalUrl,
        redirected,
        contentType,
        charset: decoded.charset,
        byteLength: bytes.length,
        retryCount: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRY_COUNT) {
        await new Promise((resolve) => setTimeout(resolve, REQUEST_RETRY_BACKOFF_MS * (attempt + 1)));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  lastError ??= new Error("fetch failed");
  lastError.httpStatus = lastStatus;
  lastError.finalUrl = finalUrl;
  lastError.redirected = redirected;
  throw lastError;
}

function parseNoticeDate(rawText) {
  const text = cleanText(rawText);
  if (!text) return null;
  const patterns = [
    /(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/,
    /(\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    let year = Number(match[1]);
    if (year < 100) year += 2000;
    const parsed = new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[3])));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

export function extractFromListWithMetrics(source, html) {
  return parseNoticeList(source, html);
}

export async function auditDetails(source, items, stageEvents) {
  const samples = items.slice(0, DETAIL_SAMPLE_SIZE);
  const detailResults = [];

  for (const item of samples) {
    const startedAt = new Date().toISOString();
    if (!/^https?:\/\//i.test(cleanText(item.noticeUrl))) {
      detailResults.push({
        title: item.listTitle ?? item.title,
        rawListText: item.rawListText ?? "",
        listTitle: item.listTitle ?? item.title,
        listTitleQuality: item.listTitleQuality ?? "missing",
        titleExtractionEvidence: item.titleExtractionEvidence ?? "missing",
        noticeUrl: item.noticeUrl,
        finalUrl: item.noticeUrl,
        httpStatus: null,
        fetchStatus: "skipped",
        ok: false,
        identityVerified: false,
        identityComparisonMode: "detail_url_unverified",
        contentCharCount: 0,
        contentStatus: "skipped",
        detailTitle: "",
        detailBodySelector: "skipped",
        detailBodyCharCount: 0,
        detailBodyQuality: "skipped",
        failureCode: FAILURE_CODES.DETAIL_URL_UNVERIFIED,
      });
      continue;
    }
    const adapterContent = cleanText(item.content);
    const adapterImages = Array.isArray(item.images) ? item.images : [];
    if (
      source.adapter &&
      (adapterContent.length >= DETAIL_CONTENT_MIN_CHARS || adapterImages.length > 0)
    ) {
      stageEvents.push(
        createStageEvent({
          runId: RUN_ID,
          source,
          stage: "detail_fetch",
          status: "success",
          startedAt,
          metrics: {
            adapterName: source.adapter,
            finalUrl: item.noticeUrl,
            responseContentType: "adapter/json",
            responseByteLength: Buffer.byteLength(String(item.bodyHtml ?? item.content ?? "")),
          },
          evidence: "detail title and body supplied by registered source adapter",
        }),
      );
      detailResults.push({
        title: item.title,
        rawListText: item.rawListText ?? item.title,
        listTitle: item.listTitle ?? item.title,
        listTitleQuality: item.listTitleQuality ?? "clean",
        titleExtractionEvidence: item.titleExtractionEvidence ?? "adapter_payload",
        noticeUrl: item.noticeUrl,
        finalUrl: item.noticeUrl,
        httpStatus: 200,
        fetchStatus: "success",
        ok: true,
        detailTitle: item.title,
        identityComparisonMode: "adapter_payload_title",
        contentLength: adapterContent.length,
        contentCharCount: adapterContent.length,
        contentStatus: "success",
        empty: false,
        detailBodySelector: "adapter_payload",
        detailBodyCharCount: adapterContent.length,
        detailBodyQuality: "clean",
        images: adapterImages,
        identityVerified: true,
        identityStatus: "verified",
        identityEvidence: "The registered adapter supplied the list title and corresponding detail payload together.",
        failureCode: "",
      });
      continue;
    }
    try {
      const page = await fetchHtmlWithTrace(item.noticeUrl);
      stageEvents.push(
        createStageEvent({
          runId: RUN_ID,
          source,
          stage: "detail_fetch",
          status: "success",
          startedAt,
          metrics: {
            httpStatus: page.httpStatus,
            finalUrl: page.finalUrl,
            redirected: page.redirected,
            retryCount: page.retryCount,
            responseContentType: page.contentType,
            detectedCharset: page.charset,
            responseByteLength: page.byteLength,
          },
          evidence: item.noticeUrl,
        }),
      );

      const parsedDetail = parseNoticeDetail(source, page.html, page.finalUrl || item.noticeUrl, {
        expectedTitle: item.listTitle ?? item.title,
      });
      const detailTitleCandidates = parsedDetail.titleCandidates;
      const detailTitle = parsedDetail.title;
      const detailBody = {
        content: parsedDetail.content,
        selector: parsedDetail.bodySelector,
        quality: parsedDetail.bodyQuality,
      };
      const identity = verifyDetailTitleIdentity(
        item.listTitle ?? item.title,
        detailTitleCandidates,
        {
          rawListText: item.rawListText,
          listTitleQuality: item.listTitleQuality,
        },
      );
      const hasSpecificBodySelector = !["body", "main", ".content", "heuristic-container"].includes(
        detailBody.selector,
      );
      const hasSubstantiveText =
        detailBody.content.length >= DETAIL_CONTENT_MIN_CHARS ||
        (hasSpecificBodySelector && detailBody.content.length >= 20);
      const hasSubstantiveMedia = parsedDetail.images.length > 0;
      const contentStatus = hasSubstantiveText || hasSubstantiveMedia ? "success" : "failed";
      detailResults.push({
        title: item.listTitle ?? item.title,
        rawListText: item.rawListText ?? "",
        listTitle: item.listTitle ?? item.title,
        listTitleQuality: item.listTitleQuality ?? "missing",
        titleExtractionEvidence: item.titleExtractionEvidence ?? "missing",
        noticeUrl: item.noticeUrl,
        finalUrl: page.finalUrl,
        httpStatus: page.httpStatus,
        fetchStatus: "success",
        ok: true,
        detailTitle: identity.matchedTitle || detailTitle,
        identityComparisonMode: identity.comparisonMode,
        contentLength: detailBody.content.length,
        contentCharCount: detailBody.content.length,
        contentStatus,
        empty: contentStatus === "failed",
        detailBodySelector: detailBody.selector,
        detailBodyCharCount: detailBody.content.length,
        detailBodyQuality: detailBody.quality,
        images: parsedDetail.images,
        identityVerified: identity.verified,
        identityStatus: identity.status,
        identityEvidence: identity.evidence,
        failureCode:
          contentStatus === "failed"
            ? FAILURE_CODES.DETAIL_CONTENT_EMPTY_OR_BOILERPLATE
            : identity.verified
              ? ""
              : FAILURE_CODES.DETAIL_IDENTITY_UNVERIFIED,
      });
    } catch (error) {
      const failureCode = classifyFetchFailure(error, error.httpStatus);
      stageEvents.push(
        createStageEvent({
          runId: RUN_ID,
          source,
          stage: "detail_fetch",
          status: "failed",
          startedAt,
          metrics: {
            httpStatus: error.httpStatus ?? null,
            finalUrl: error.finalUrl ?? item.noticeUrl,
            redirected: error.redirected ?? false,
            timeoutMs: REQUEST_TIMEOUT_MS,
          },
          error,
          failureCode,
          evidence: item.noticeUrl,
        }),
      );
      detailResults.push({
        title: item.listTitle ?? item.title,
        rawListText: item.rawListText ?? "",
        listTitle: item.listTitle ?? item.title,
        listTitleQuality: item.listTitleQuality ?? "missing",
        titleExtractionEvidence: item.titleExtractionEvidence ?? "missing",
        noticeUrl: item.noticeUrl,
        finalUrl: error.finalUrl ?? item.noticeUrl,
        httpStatus: error.httpStatus ?? null,
        fetchStatus: "failed",
        ok: false,
        identityVerified: false,
        identityComparisonMode: "detail_fetch_failed",
        detailTitle: "",
        contentCharCount: 0,
        contentStatus: "failed",
        detailBodySelector: "failed",
        detailBodyCharCount: 0,
        detailBodyQuality: "failed",
        failureCode,
        error: cleanText(error.message ?? error).slice(0, 240),
      });
    }
  }

  return detailResults;
}

function recommendedActionFor(decision, failureCode) {
  if (decision === "adapter_required") return "Implement or repair a source adapter.";
  if (decision === "list_supported_detail_unverified") {
    return "Review detail identity evidence before trusting this source as fully verified.";
  }
  if (decision === "list_supported_detail_failed") return "Fix detail URL resolution or source access before trusting this source.";
  if (decision === "manual_review_required") {
    if (failureCode === FAILURE_CODES.MANUAL_BROWSER_NETWORK_REQUIRED) {
      return "Collect browser Network evidence before implementing an adapter.";
    }
    return "Review access and network behavior manually.";
  }
  if (decision === "config_or_selector_fix") return "Fix source selectors or URL pattern.";
  if (decision === "posts_found_no_scholarship") {
    return "Crawler parsed posts, but no scholarship keyword candidate was found.";
  }
  if (decision === "no_posts_detected") {
    return "Crawler found no posts on the configured board; verify whether the board is empty or the URL is wrong.";
  }
  if (decision === "valid_zero_candidates") return "No crawler change needed unless source content changed.";
  return "Supported by current crawler path.";
}

function manualReviewQuestionFor(failureCode) {
  if (failureCode === FAILURE_CODES.MANUAL_BROWSER_NETWORK_REQUIRED) {
    return "What exact request method, URL, payload, and redirect chain does the browser use for the detail view?";
  }
  if (failureCode === FAILURE_CODES.AUTH_OR_CAPTCHA_REQUIRED) {
    return "Is the notice publicly accessible without login or CAPTCHA?";
  }
  if (failureCode === FAILURE_CODES.BOT_BLOCKED_OR_RATE_LIMITED) {
    return "Is the source intentionally blocking automated access or rate-limiting public requests?";
  }
  if (failureCode === FAILURE_CODES.DETAIL_IDENTITY_UNVERIFIED) {
    return "Does the fetched detail page represent the same notice as the list row title?";
  }
  if (failureCode === FAILURE_CODES.DETAIL_URL_UNVERIFIED) {
    return "Can one real public detail notice URL be verified in the browser?";
  }
  if (failureCode === FAILURE_CODES.LIST_SELECTOR_MENU_CONTAMINATION) {
    return "Which selector isolates real notice board rows without header, nav, or footer links?";
  }
  return "";
}

async function auditSource(source) {
  const stageEvents = [];
  const sourceStartedAt = new Date().toISOString();
  const listAdapter = getListAdapter(source.adapter);
  let listHtml = "";
  let listPage = null;
  let fetchFailureCode = "";
  let extracted = { items: [], metrics: {} };
  let adapterItems = [];

  if (listAdapter) {
    const startedAt = new Date().toISOString();
    try {
      adapterItems = await listAdapter(source, {
        lookbackDays: 31,
        allowUndated: true,
        maxItems: 25,
      });
      adapterItems = adapterItems.map((item) => ({
        ...item,
        keywordMatched: matchesSourceKeywords(source, item),
      }));
      stageEvents.push(
        createStageEvent({
          runId: RUN_ID,
          source,
          stage: "list_fetch",
          status: "success",
          startedAt,
          metrics: {
            adapterName: source.adapter,
            listDomItemCount: adapterItems.length,
          },
          evidence: "source uses registered list adapter",
        }),
      );
      extracted = {
        items: adapterItems,
        metrics: {
          listDomItemCount: adapterItems.length,
          selectorMatches: {},
          linkExtractionCount: adapterItems.filter((item) => item.noticeUrl).length,
          validDetailUrlCount: adapterItems.filter((item) => item.noticeUrl).length,
          manualNetworkEvidenceRequiredCount: 0,
          eventUrlEvidenceCount: 0,
          paginationEvidenceCount: adapterItems.length > 0 ? 1 : 0,
          fallbackScanUsed: false,
          fallbackAnchorCount: 0,
          boardEvidenceCount: adapterItems.length,
          rawNavigationEvidenceCount: adapterItems.filter((item) => item.noticeUrl).length,
          resolvedDetailUrlCount: adapterItems.filter((item) => item.noticeUrl).length,
          contaminatedCandidateCount: 0,
          contaminatedCandidateLeakCount: 0,
          menuTextCount: 0,
          menuContainerCount: 0,
          menuContaminationCount: 0,
          menuContaminationRate: 0,
          menuContaminationDetected: false,
          menuContaminationObserved: false,
          pageMenuContaminationCount: 0,
          titleExtractCount: adapterItems.filter((item) => cleanText(item.title)).length,
          parsedDateCount: adapterItems.filter((item) => parseNoticeDate(item.dateText)).length,
          keywordMatchCount: adapterItems.filter((item) => item.keywordMatched).length,
        },
      };
    } catch (error) {
      fetchFailureCode = classifyFetchFailure(error, error.httpStatus);
      stageEvents.push(
        createStageEvent({
          runId: RUN_ID,
          source,
          stage: "list_fetch",
          status: "failed",
          startedAt,
          metrics: { adapterName: source.adapter, timeoutMs: REQUEST_TIMEOUT_MS },
          error,
          failureCode: fetchFailureCode,
        }),
      );
    }
  } else {
    const fetchStartedAt = new Date().toISOString();
    try {
      listPage = await fetchHtmlWithTrace(source.listUrl);
      listHtml = listPage.html;
      if (
        /postRedirectForm[\s\S]{0,800}(?:sso|Auth\.eps)|failureCause['"]?\s+value=['"]unauthorized/iu.test(
          listHtml,
        )
      ) {
        fetchFailureCode = FAILURE_CODES.AUTH_OR_CAPTCHA_REQUIRED;
      }
      stageEvents.push(
        createStageEvent({
          runId: RUN_ID,
          source,
          stage: "list_fetch",
          status: "success",
          startedAt: fetchStartedAt,
          metrics: {
            httpStatus: listPage.httpStatus,
            finalUrl: listPage.finalUrl,
            redirected: listPage.redirected,
            retryCount: listPage.retryCount,
            timeoutMs: REQUEST_TIMEOUT_MS,
            responseContentType: listPage.contentType,
            detectedCharset: listPage.charset,
            responseByteLength: listPage.byteLength,
          },
          evidence: source.listUrl,
        }),
      );

      const decodeStartedAt = new Date().toISOString();
      stageEvents.push(
        createStageEvent({
          runId: RUN_ID,
          source,
          stage: "list_decode",
          status: "success",
          startedAt: decodeStartedAt,
          metrics: {
            detectedCharset: listPage.charset,
            responseByteLength: listPage.byteLength,
          },
        }),
      );
    } catch (error) {
      fetchFailureCode = classifyFetchFailure(error, error.httpStatus);
      stageEvents.push(
        createStageEvent({
          runId: RUN_ID,
          source,
          stage: "list_fetch",
          status: "failed",
          startedAt: fetchStartedAt,
          metrics: {
            httpStatus: error.httpStatus ?? null,
            finalUrl: error.finalUrl ?? source.listUrl,
            redirected: error.redirected ?? false,
            timeoutMs: REQUEST_TIMEOUT_MS,
          },
          error,
          failureCode: fetchFailureCode,
          evidence: source.listUrl,
        }),
      );
    }

    if (listHtml) {
      const parseStartedAt = new Date().toISOString();
      extracted = extractFromListWithMetrics(source, listHtml);
      stageEvents.push(
        createStageEvent({
          runId: RUN_ID,
          source,
          stage: "list_parse",
          status:
            extracted.metrics.menuContaminationDetected
              ? "warning"
              : source.listItemSelector && extracted.metrics.listDomItemCount === 0
              ? "warning"
              : "success",
          startedAt: parseStartedAt,
          metrics: {
            listDomItemCount: extracted.metrics.listDomItemCount,
            selectorMatches: extracted.metrics.selectorMatches,
            boardEvidenceCount: extracted.metrics.boardEvidenceCount,
            menuContaminationCount: extracted.metrics.menuContaminationCount,
            menuContaminationRate: extracted.metrics.menuContaminationRate,
            menuContaminationObserved: extracted.metrics.menuContaminationObserved,
            pageMenuContaminationCount: extracted.metrics.pageMenuContaminationCount,
            contaminatedCandidateCount: extracted.metrics.contaminatedCandidateCount,
            contaminatedCandidateLeakCount: extracted.metrics.contaminatedCandidateLeakCount,
            fallbackScanUsed: extracted.metrics.fallbackScanUsed,
            fallbackAnchorCount: extracted.metrics.fallbackAnchorCount,
          },
          failureCode:
            extracted.metrics.menuContaminationDetected
              ? FAILURE_CODES.LIST_SELECTOR_MENU_CONTAMINATION
              : source.listItemSelector && extracted.metrics.listDomItemCount === 0
              ? "LIST_SELECTOR_ZERO_MATCHES"
              : "",
        }),
      );

      const urlStartedAt = new Date().toISOString();
      stageEvents.push(
        createStageEvent({
          runId: RUN_ID,
          source,
          stage: "notice_url_resolution",
          status: extracted.metrics.validDetailUrlCount > 0 ? "success" : "warning",
          startedAt: urlStartedAt,
          metrics: {
            linkExtractionCount: extracted.metrics.linkExtractionCount,
            validDetailUrlCount: extracted.metrics.validDetailUrlCount,
            resolvedDetailUrlCount: extracted.metrics.resolvedDetailUrlCount ?? 0,
            detailUrlResolvedCount: extracted.metrics.validDetailUrlCount,
            rawNavigationEvidenceCount: extracted.metrics.rawNavigationEvidenceCount ?? 0,
            manualNetworkEvidenceRequiredCount:
              extracted.metrics.manualNetworkEvidenceRequiredCount ?? 0,
            eventUrlEvidenceCount: extracted.metrics.eventUrlEvidenceCount ?? 0,
          },
          failureCode:
            (extracted.metrics.manualNetworkEvidenceRequiredCount ?? 0) > 0 &&
            extracted.metrics.linkExtractionCount === 0
              ? FAILURE_CODES.MANUAL_BROWSER_NETWORK_REQUIRED
              : extracted.metrics.linkExtractionCount === 0
                ? FAILURE_CODES.URL_RESOLUTION_FAILED
                : "",
          evidence:
            (extracted.metrics.manualNetworkEvidenceRequiredCount ?? 0) > 0
              ? "List contains placeholder href/javascript onclick navigation that requires browser Network evidence or a source adapter."
              : "",
        }),
      );
    }
  }

  const paginationStartedAt = new Date().toISOString();
  const paginationVerified =
    Boolean(source.adapter) ||
    Number(extracted.metrics.paginationEvidenceCount ?? 0) > 0 ||
    extracted.items.length <= 25;
  stageEvents.push(
    createStageEvent({
      runId: RUN_ID,
      source,
      stage: "pagination_check",
      status: paginationVerified ? "success" : "warning",
      startedAt: paginationStartedAt,
      metrics: { paginationVerified },
      failureCode: paginationVerified ? "" : "PAGINATION_UNVERIFIED",
      evidence: paginationVerified ? "" : "Pagination controls were not detected in the fetched list HTML.",
    }),
  );

  const finalCandidates = extracted.items.filter((item) => item.keywordMatched !== false);
  const finalCandidateCount = finalCandidates.length;
  const finalContaminatedCandidateCount = finalCandidates.filter(
    (item) => item.listTitleQuality === "contaminated",
  ).length;

  const detailResults =
    DETAIL_SAMPLE_SIZE > 0 && extracted.items.length > 0
      ? await auditDetails(source, extracted.items, stageEvents)
      : [];
  const detailFailureCount = detailResults.filter((item) => !item.ok).length;
  const detailFetchSuccessCount = detailResults.filter((item) => item.ok).length;
  const detailVerifiedCount = detailResults.filter((item) => item.ok && item.identityVerified).length;
  const detailIdentityUnverifiedCount = detailResults.filter(
    (item) => item.ok && !item.identityVerified,
  ).length;
  const detailContentEmptyCount = detailResults.filter((item) => item.ok && item.empty).length;
  const cleanDetailSampleCount = detailResults.filter(
    (item) => item.ok && item.listTitleQuality === "clean",
  ).length;
  const detailContentCharCount = detailResults.reduce(
    (sum, item) => sum + Number(item.contentCharCount ?? item.contentLength ?? 0),
    0,
  );

  const contentStartedAt = new Date().toISOString();
  stageEvents.push(
    createStageEvent({
      runId: RUN_ID,
      source,
      stage: "detail_content_extract",
      status:
        detailResults.length === 0
          ? "skipped"
          : detailIdentityUnverifiedCount > 0
            ? "warning"
          : detailContentEmptyCount > 0
            ? "warning"
            : "success",
      startedAt: contentStartedAt,
      metrics: {
        detailSampleCount: detailResults.length,
        detailFetchSuccessCount,
        detailUrlVerifiedCount: detailVerifiedCount,
        cleanDetailSampleCount,
        detailIdentityUnverifiedCount,
        detailContentEmptyCount,
      },
      failureCode:
        detailContentEmptyCount > 0
          ? FAILURE_CODES.DETAIL_CONTENT_EMPTY_OR_BOILERPLATE
          : detailIdentityUnverifiedCount > 0
            ? FAILURE_CODES.DETAIL_IDENTITY_UNVERIFIED
            : "",
      evidence:
        detailIdentityUnverifiedCount > 0
          ? detailResults
              .filter((item) => item.ok && !item.identityVerified)
              .map((item) => item.identityEvidence)
              .slice(0, 2)
              .join(" ")
          : "",
    }),
  );

  const filterStartedAt = new Date().toISOString();
  stageEvents.push(
    createStageEvent({
      runId: RUN_ID,
      source,
      stage: "candidate_filter",
      status:
        extracted.items.length === 0
          ? "skipped"
          : finalCandidateCount === 0
            ? "warning"
            : "success",
      startedAt: filterStartedAt,
      metrics: {
        parsedDateCount: extracted.metrics.parsedDateCount ?? 0,
        keywordMatchCount: extracted.metrics.keywordMatchCount ?? 0,
        finalCandidateCount,
        contaminatedCandidateLeakCount: finalContaminatedCandidateCount,
      },
      failureCode:
        extracted.items.length > 0 && finalCandidateCount === 0 ? "FILTERED_OUT_BY_KEYWORD" : "",
    }),
  );

  const failureCode = decidePrimaryFailureCode({
    fetchFailureCode,
    selectorMatchCount: extracted.metrics.listDomItemCount,
    linkExtractionCount: extracted.metrics.linkExtractionCount,
    validDetailUrlCount: extracted.metrics.validDetailUrlCount,
    listMenuContaminationDetected: Boolean(extracted.metrics.menuContaminationDetected),
    fallbackScanUsed: Boolean(extracted.metrics.fallbackScanUsed),
    manualNetworkEvidenceRequiredCount:
      extracted.metrics.manualNetworkEvidenceRequiredCount ?? 0,
    detailFailureCount,
    detailContentEmptyCount,
    detailIdentityUnverifiedCount,
    detailFetchSuccessCount,
    detailUrlVerifiedCount: detailVerifiedCount,
    detailSampleCount: detailResults.length,
    contaminatedCandidateLeakCount: finalContaminatedCandidateCount,
    parsedDateCount: extracted.metrics.parsedDateCount ?? 0,
    keywordMatchCount: extracted.metrics.keywordMatchCount ?? 0,
    finalCandidateCount,
    crawledCount: extracted.items.length,
    hasConfiguredSelector: Boolean(source.listItemSelector),
    explicitEmptyStateDetected: Boolean(extracted.metrics.explicitEmptyStateDetected),
    paginationVerified,
  });
  const profileDetails = inferAccessProfileDetails({
    source,
    html: listHtml,
    httpStatus: listPage?.httpStatus ?? null,
    charset: listPage?.charset ?? "",
    selectorMatchCount: extracted.metrics.listDomItemCount,
    linkExtractionCount: extracted.metrics.validDetailUrlCount,
    validDetailUrlCount: extracted.metrics.validDetailUrlCount,
    eventUrlEvidenceCount: extracted.metrics.eventUrlEvidenceCount ?? 0,
    paginationEvidenceCount: extracted.metrics.paginationEvidenceCount ?? 0,
    manualNetworkEvidenceRequiredCount:
      extracted.metrics.manualNetworkEvidenceRequiredCount ?? 0,
    detailFailureCount,
    adapterName: source.adapter,
    fetchFailureCode,
    detailAccessMode: source.detailAccessMode,
    browserNetworkEvidence: source.browserNetworkEvidence,
  });
  const profiles = profileDetails.profiles;
  const profileEvidence = profileDetails.profileEvidence;
  const decision = makeSourceDecision({
    profiles,
    failureCode,
    finalCandidateCount,
    detailSampleCount: detailResults.length,
    detailFetchSuccessCount,
    detailUrlVerifiedCount: detailVerifiedCount,
    detailContentCharCount,
    cleanDetailSampleCount,
    contaminatedCandidateLeakCount: finalContaminatedCandidateCount,
    minDetailContentCharCount: DETAIL_CONTENT_MIN_CHARS,
  });
  const recommendedAction = recommendedActionFor(decision, failureCode);
  const manualReviewQuestion = manualReviewQuestionFor(failureCode);

  const finalStartedAt = new Date().toISOString();
  stageEvents.push(
    createStageEvent({
      runId: RUN_ID,
      source,
      stage: "final_result",
      status: failureCode || decision !== "supported" ? "warning" : "success",
      startedAt: finalStartedAt,
      metrics: {
        accessProfiles: profiles,
        profileEvidence,
        failureCode,
        decision,
        recommendedAction,
        manualReviewQuestion,
        finalCandidateCount,
        detailUrlResolved: (extracted.metrics.validDetailUrlCount ?? 0) > 0,
        detailUrlVerified: detailVerifiedCount > 0,
        detailIdentityUnverifiedCount,
        detailContentVerified: detailContentCharCount >= DETAIL_CONTENT_MIN_CHARS,
        detailContentCharCount,
        cleanDetailSampleCount,
        contaminatedCandidateLeakCount: finalContaminatedCandidateCount,
      },
      failureCode,
      evidence: summarizeEvidence({ source, profiles, failureCode, decision, extracted, detailResults }),
    }),
  );

  return {
    runId: RUN_ID,
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    sourceConfigFile: source.sourceConfigFile,
    universitySlug: source.universitySlug,
    sourceLevel: source.sourceLevel,
    listUrl: source.listUrl,
    configuredListUrl: source.configuredListUrl || source.listUrl,
    fallbackSourceId: source.fallbackSourceId || "",
    adapter: source.adapter,
    startedAt: sourceStartedAt,
    endedAt: new Date().toISOString(),
    accessProfiles: profiles,
    profileEvidence,
    failureCode,
    decision,
    capabilityStatus: decision,
    recommendedAction,
    manualReviewQuestion,
    metrics: {
      ...extracted.metrics,
      crawledCount: extracted.items.length,
      detailSampleCount: detailResults.length,
      detailFetchSuccessCount,
      detailUrlResolvedCount: extracted.metrics.validDetailUrlCount ?? 0,
      detailUrlVerifiedCount: detailVerifiedCount,
      cleanDetailSampleCount,
      detailIdentityUnverifiedCount,
      detailFailureCount,
      detailContentEmptyCount,
      detailContentCharCount,
      minDetailContentCharCount: DETAIL_CONTENT_MIN_CHARS,
      finalCandidateCount,
      contaminatedCandidateLeakCount: finalContaminatedCandidateCount,
    },
    samples: {
      notices: extracted.items.slice(0, 5).map((item) => ({
        title: item.listTitle ?? item.title,
        rawListText: item.rawListText ?? "",
        listTitle: item.listTitle ?? item.title,
        listTitleQuality: item.listTitleQuality ?? "missing",
        titleExtractionEvidence: item.titleExtractionEvidence ?? "missing",
        noticeUrl: item.noticeUrl,
        dateText: item.dateText ?? "",
        parsedDate: item.parsedDate ?? "",
      })),
      detailResults,
    },
    stageEvents,
  };
}

function summarizeEvidence({ profiles, failureCode, decision, extracted, detailResults }) {
  const identityEvidence = detailResults
    .filter((item) => item.ok && !item.identityVerified)
    .map((item) => item.identityEvidence)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  const parts = [
    `decision=${decision}`,
    profiles.length ? `profiles=${profiles.join("|")}` : "",
    failureCode ? `failure=${failureCode}` : "",
    `items=${extracted.items.length}`,
    `boardEvidence=${extracted.metrics.boardEvidenceCount ?? 0}`,
    `menuContamination=${extracted.metrics.menuContaminationCount ?? 0}`,
    `contaminatedCandidates=${extracted.metrics.contaminatedCandidateCount ?? 0}`,
    `contaminatedLeaks=${extracted.metrics.contaminatedCandidateLeakCount ?? 0}`,
    `rawNavigation=${extracted.metrics.rawNavigationEvidenceCount ?? 0}`,
    `links=${extracted.metrics.linkExtractionCount ?? 0}`,
    `validUrls=${extracted.metrics.validDetailUrlCount ?? 0}`,
    `resolvedUrls=${extracted.metrics.resolvedDetailUrlCount ?? 0}`,
    `manualNetworkEvidence=${extracted.metrics.manualNetworkEvidenceRequiredCount ?? 0}`,
    `detailFailures=${detailResults.filter((item) => !item.ok).length}`,
    `detailVerified=${detailResults.filter((item) => item.ok && item.identityVerified).length}`,
    `identityUnverified=${detailResults.filter((item) => item.ok && !item.identityVerified).length}`,
    detailResults[0]?.identityComparisonMode ? `identityMode=${detailResults[0].identityComparisonMode}` : "",
    identityEvidence,
  ];
  return parts.filter(Boolean).join(" ");
}

function escapeCsvCell(value) {
  const text = cleanText(value ?? "");
  const escaped = text.replace(/"/g, '""');
  return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
}

function formatRate(numerator, denominator) {
  const total = Number(denominator ?? 0);
  if (total <= 0) return "skipped";
  const count = Number(numerator ?? 0);
  return `${((count / total) * 100).toFixed(1)}%`;
}

function statusFromCount(count, denominator, failureStatus = "failed") {
  const total = Number(denominator ?? 0);
  if (total <= 0) return "skipped";
  return Number(count ?? 0) > 0 ? "success" : failureStatus;
}

function getStageEvents(source, stage) {
  return source.stageEvents.filter((event) => event.stage === stage);
}

function getAggregateStageStatus(source, stage) {
  const events = getStageEvents(source, stage);
  if (events.length === 0) return "skipped";
  if (events.some((event) => event.status === "failed")) return "failed";
  if (events.some((event) => event.status === "warning")) return "warning";
  if (events.some((event) => event.status === "manual_review_required")) {
    return "manual_review_required";
  }
  if (events.some((event) => event.status === "success")) return "success";
  return events[0]?.status || "skipped";
}

function getEvidenceSummary(source) {
  const finalEvent = getStageEvents(source, "final_result").at(-1);
  return cleanText(finalEvent?.evidence) || "none";
}

function getFailureCodes(source) {
  const codes = new Set(
    source.stageEvents
      .map((event) => cleanText(event.failureCode))
      .filter(Boolean),
  );
  if (source.failureCode) codes.add(source.failureCode);
  return codes.size > 0 ? [...codes].join("|") : "none";
}

function getDetailContentCharCount(source) {
  return source.samples.detailResults.reduce((sum, result) => {
    if (!result.ok) return sum;
    return sum + Number(result.contentCharCount ?? result.contentLength ?? 0);
  }, 0);
}

function getDetailUrlResolvedStatus(source) {
  const resolvedCount = Number(source.metrics.detailUrlResolvedCount ?? 0);
  const itemCount = Number(source.metrics.listDomItemCount ?? 0);
  if (resolvedCount > 0) return "success";
  if (Number(source.metrics.manualNetworkEvidenceRequiredCount ?? 0) > 0) {
    return "manual_review_required";
  }
  return statusFromCount(resolvedCount, itemCount);
}

function getDetailUrlVerifiedStatus(source) {
  const verifiedCount = Number(source.metrics.detailUrlVerifiedCount ?? 0);
  const sampleCount = Number(source.metrics.detailSampleCount ?? 0);
  if (verifiedCount > 0) return "success";
  if (Number(source.metrics.detailIdentityUnverifiedCount ?? 0) > 0) return "warning";
  return statusFromCount(verifiedCount, sampleCount);
}

function buildSourceCsvRows(perSource) {
  const csvHeader = [
    "source_id",
    "source_name",
    "source_config_file",
    "university_slug",
    "source_level",
    "adapter",
    "fallback_source_id",
    "configured_list_url",
    "list_url",
    "list_fetch_status",
    "list_parse_status",
    "item_match_count",
    "title_extract_rate",
    "date_extract_rate",
    "detail_url_resolution_rate",
    "detail_url_resolved",
    "detail_url_verified",
    "detail_fetch_status",
    "detail_content_status",
    "detail_content_char_count",
    "pagination_status",
    "access_profiles",
    "parser_strategy",
    "parser_recovered",
    "capability_status",
    "recommended_action",
    "manual_review_question",
    "failure_codes",
    "evidence_summary",
    "raw_navigation_count",
    "valid_detail_url_count",
    "resolved_detail_url_count",
    "contaminated_candidate_count",
    "contaminated_candidate_leak_count",
    "sampled_raw_list_text",
    "sampled_list_title",
    "list_title_quality",
    "sampled_detail_title",
    "identity_comparison_mode",
    "detail_body_selector",
    "detail_body_char_count",
    "detail_image_count",
  ];
  const csvRows = perSource.map((source) => {
    const itemMatchCount = Number(source.metrics.listDomItemCount ?? 0);
    const titleExtractCount = Number(source.metrics.titleExtractCount ?? 0);
    const dateExtractCount = Number(source.metrics.parsedDateCount ?? 0);
    const detailUrlResolvedCount = Number(source.metrics.detailUrlResolvedCount ?? 0);
    const notice = getSampleNotice(source);
    const detail = getSampleDetail(source);
    const row = [
      source.sourceId,
      source.sourceName,
      source.sourceConfigFile,
      source.universitySlug || "unknown",
      source.sourceLevel || "unknown",
      source.adapter || "none",
      source.fallbackSourceId || "none",
      source.configuredListUrl || source.listUrl,
      source.listUrl,
      getAggregateStageStatus(source, "list_fetch"),
      getAggregateStageStatus(source, "list_parse"),
      itemMatchCount,
      formatRate(titleExtractCount, itemMatchCount),
      formatRate(dateExtractCount, itemMatchCount),
      formatRate(detailUrlResolvedCount, itemMatchCount),
      getDetailUrlResolvedStatus(source),
      getDetailUrlVerifiedStatus(source),
      getAggregateStageStatus(source, "detail_fetch"),
      getAggregateStageStatus(source, "detail_content_extract"),
      getDetailContentCharCount(source),
      getAggregateStageStatus(source, "pagination_check"),
      source.accessProfiles.length > 0 ? source.accessProfiles.join("|") : "none",
      source.metrics.parserStrategy || "none",
      source.metrics.parserRecovered ? "true" : "false",
      source.capabilityStatus || "unknown",
      source.recommendedAction || "none",
      source.manualReviewQuestion || "none",
      getFailureCodes(source),
      getEvidenceSummary(source),
      source.metrics.rawNavigationEvidenceCount ?? 0,
      source.metrics.validDetailUrlCount ?? 0,
      source.metrics.detailUrlResolvedCount ?? 0,
      source.metrics.contaminatedCandidateCount ?? 0,
      source.metrics.contaminatedCandidateLeakCount ?? 0,
      notice.rawListText || detail.rawListText || "none",
      notice.listTitle || detail.listTitle || notice.title || detail.title || "none",
      notice.listTitleQuality || detail.listTitleQuality || "missing",
      detail.detailTitle || "none",
      detail.identityComparisonMode || "none",
      detail.detailBodySelector || "none",
      detail.detailBodyCharCount ?? detail.contentCharCount ?? 0,
      detail.images?.length ?? 0,
    ];
    return row.map((cell) => escapeCsvCell(cell)).join(",");
  });
  return [csvHeader.join(","), ...csvRows];
}

function buildUniversitySummaryCsvRows(perSource) {
  const csvHeader = [
    "run_id",
    "university_slug",
    "source_count",
    "supported_count",
    "list_supported_detail_unverified_count",
    "list_supported_detail_failed_count",
    "manual_review_required_count",
    "adapter_required_count",
    "config_or_selector_fix_count",
    "posts_found_no_scholarship_count",
    "no_posts_detected_count",
    "valid_zero_candidates_count",
    "failed_source_count",
    "failure_codes",
    "access_profiles",
  ];
  const groups = new Map();
  for (const source of perSource) {
    const slug = source.universitySlug || "unknown";
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug).push(source);
  }
  const rows = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([slug, sources]) => {
      const failures = new Set();
      const profiles = new Set();
      for (const source of sources) {
        for (const code of getFailureCodes(source).split("|")) {
          if (code && code !== "none") failures.add(code);
        }
        for (const profile of source.accessProfiles) profiles.add(profile);
      }
      return [
        RUN_ID,
        slug,
        sources.length,
        sources.filter((source) => source.decision === "supported").length,
        sources.filter((source) => source.decision === "list_supported_detail_unverified").length,
        sources.filter((source) => source.decision === "list_supported_detail_failed").length,
        sources.filter((source) => source.decision === "manual_review_required").length,
        sources.filter((source) => source.decision === "adapter_required").length,
        sources.filter((source) => source.decision === "config_or_selector_fix").length,
        sources.filter((source) => source.decision === "posts_found_no_scholarship").length,
        sources.filter((source) => source.decision === "no_posts_detected").length,
        sources.filter((source) => source.decision === "valid_zero_candidates").length,
        sources.filter((source) => source.failureCode).length,
        failures.size > 0 ? [...failures].sort().join("|") : "none",
        profiles.size > 0 ? [...profiles].sort().join("|") : "none",
      ]
        .map((cell) => escapeCsvCell(cell))
        .join(",");
    });
  return [csvHeader.join(","), ...rows];
}

function escapeMarkdownCell(value) {
  return cleanText(value ?? "none").replace(/\|/g, "\\|") || "none";
}

function buildProfileSummaryMarkdown(perSource) {
  const groups = new Map();
  for (const source of perSource) {
    const profiles = source.accessProfiles.length > 0 ? source.accessProfiles : ["none"];
    for (const profile of profiles) {
      if (!groups.has(profile)) groups.set(profile, []);
      groups.get(profile).push(source);
    }
  }
  const lines = [
    "# Crawler Capability Profile Summary",
    "",
    `Run ID: ${RUN_ID}`,
    "",
    "| profile | source_count | supported_count | list_supported_detail_unverified_count | list_supported_detail_failed_count | manual_review_required_count | adapter_required_count | failure_codes | recommended_action |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  ];
  for (const [profile, sources] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const failures = new Set();
    for (const source of sources) {
      for (const code of getFailureCodes(source).split("|")) {
        if (code && code !== "none") failures.add(code);
      }
    }
    const commonAction =
      sources.find((source) => source.decision !== "supported")?.recommendedAction ??
      "Supported by current crawler path.";
    const row = [
        escapeMarkdownCell(profile),
        sources.length,
        sources.filter((source) => source.decision === "supported").length,
        sources.filter((source) => source.decision === "list_supported_detail_unverified").length,
        sources.filter((source) => source.decision === "list_supported_detail_failed").length,
        sources.filter((source) => source.decision === "manual_review_required").length,
        sources.filter((source) => source.decision === "adapter_required").length,
        escapeMarkdownCell(failures.size > 0 ? [...failures].sort().join("|") : "none"),
        escapeMarkdownCell(commonAction),
      ];
    lines.push(`| ${row.join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

function getFormPostRedirectEvidence(source) {
  return source.profileEvidence?.FORM_POST_REDIRECT ?? null;
}

function buildFormPostRedirectEvidenceCsvRows(perSource) {
  const csvHeader = [
    "run_id",
    "source_id",
    "source_name",
    "university_slug",
    "source_level",
    "decision",
    "failure_code",
    "evidence_type",
    "reason",
    "evidence_value",
  ];
  const rows = perSource
    .filter((source) => source.accessProfiles.includes("FORM_POST_REDIRECT"))
    .map((source) => {
      const evidence = getFormPostRedirectEvidence(source);
      return [
        RUN_ID,
        source.sourceId,
        source.sourceName,
        source.universitySlug,
        source.sourceLevel,
        source.decision,
        source.failureCode || "none",
        evidence?.evidence_type || "missing",
        evidence?.reason || "missing",
        evidence?.evidence_value || "missing",
      ]
        .map((cell) => escapeCsvCell(cell))
        .join(",");
    });
  return [csvHeader.join(","), ...rows];
}

function buildFormPostRedirectEvidenceMarkdown(perSource) {
  const sources = perSource.filter((source) => source.accessProfiles.includes("FORM_POST_REDIRECT"));
  const byEvidenceType = countBy(sources, (source) => getFormPostRedirectEvidence(source)?.evidence_type || "missing");
  const lines = [
    "# FORM_POST_REDIRECT Evidence Summary",
    "",
    `Run ID: ${RUN_ID}`,
    "",
    "| evidence_type | source_count |",
    "| --- | ---: |",
  ];
  for (const [evidenceType, count] of Object.entries(byEvidenceType).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(`| ${escapeMarkdownCell(evidenceType)} | ${count} |`);
  }
  lines.push("", "| source_id | decision | evidence_type | reason | evidence_value |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const source of sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId))) {
    const evidence = getFormPostRedirectEvidence(source);
    lines.push(
      `| ${escapeMarkdownCell(source.sourceId)} | ${escapeMarkdownCell(source.decision)} | ${escapeMarkdownCell(
        evidence?.evidence_type || "missing",
      )} | ${escapeMarkdownCell(evidence?.reason || "missing")} | ${escapeMarkdownCell(
        evidence?.evidence_value || "missing",
      )} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function getSampleNotice(source) {
  return source.samples.notices[0] ?? {};
}

function getSampleDetail(source) {
  return source.samples.detailResults[0] ?? {};
}

function buildDecisionExampleRows(perSource) {
  const header = [
    "source_id",
    "source_name",
    "access_profiles",
    "capability_status",
    "raw_navigation_count",
    "valid_detail_url_count",
    "resolved_detail_url_count",
    "contaminated_candidate_count",
    "contaminated_candidate_leak_count",
    "sampled_raw_list_text",
    "sampled_list_title",
    "list_title_quality",
    "sampled_detail_title",
    "identity_comparison_mode",
    "detail_body_selector",
    "detail_body_char_count",
    "failure_codes",
    "evidence_summary",
  ];
  const groups = new Map();
  for (const source of perSource) {
    const key = source.capabilityStatus || source.decision || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(source);
  }
  const rows = [];
  for (const [status, sources] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    for (const source of sources.slice(0, 3)) {
      const notice = getSampleNotice(source);
      const detail = getSampleDetail(source);
      rows.push([
        source.sourceId,
        source.sourceName,
        source.accessProfiles.length > 0 ? source.accessProfiles.join("|") : "none",
        status,
        source.metrics.rawNavigationEvidenceCount ?? 0,
        source.metrics.validDetailUrlCount ?? 0,
        source.metrics.detailUrlResolvedCount ?? source.metrics.resolvedDetailUrlCount ?? 0,
        source.metrics.contaminatedCandidateCount ?? 0,
        source.metrics.contaminatedCandidateLeakCount ?? 0,
        notice.rawListText || detail.rawListText || "none",
        notice.listTitle || detail.listTitle || notice.title || detail.title || "none",
        notice.listTitleQuality || detail.listTitleQuality || "missing",
        detail.detailTitle || "none",
        detail.identityComparisonMode || "none",
        detail.detailBodySelector || "none",
        detail.detailBodyCharCount ?? detail.contentCharCount ?? 0,
        getFailureCodes(source),
        getEvidenceSummary(source),
      ]);
    }
  }
  return [header, ...rows];
}

function buildDecisionExamplesCsvRows(perSource) {
  return buildDecisionExampleRows(perSource).map((row) =>
    row.map((cell) => escapeCsvCell(cell)).join(","),
  );
}

function buildDecisionExamplesMarkdown(perSource) {
  const rows = buildDecisionExampleRows(perSource);
  const header = rows[0];
  const lines = [
    "# Capability Audit Status Examples",
    "",
    `Run ID: ${RUN_ID}`,
    "",
    `| ${header.map((cell) => escapeMarkdownCell(cell)).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows.slice(1)) {
    lines.push(`| ${row.map((cell) => escapeMarkdownCell(cell)).join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

function withoutStageEvents(source) {
  const copy = { ...source };
  delete copy.stageEvents;
  return copy;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function formatKstDate(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replace(/-/g, "");
}

async function run() {
  const allSources = readSourceConfig(INPUT_CSV_PATH);
  let sources = allSources.filter((source) => {
    const sourceId = source.sourceId.toLowerCase();
    if (SOURCE_ID_PREFIX && !sourceId.startsWith(SOURCE_ID_PREFIX)) return false;
    if (SOURCE_ID_ALLOWLIST.size > 0 && !SOURCE_ID_ALLOWLIST.has(sourceId)) return false;
    return true;
  });
  if (LIMIT > 0) sources = sources.slice(0, LIMIT);
  if (sources.length === 0) throw new Error("No enabled sources matched the audit filters.");

  console.log(
    `auditing runId=${RUN_ID} sources=${sources.length} concurrency=${CONCURRENCY} detailSample=${DETAIL_SAMPLE_SIZE}`,
  );

  const perSource = await mapLimit(sources, CONCURRENCY, async (source) => {
    const result = await auditSource(source);
    console.log(
      `source=${source.sourceId} decision=${result.decision} failure=${result.failureCode || "none"} candidates=${result.metrics.finalCandidateCount}`,
    );
    return result;
  });

  const stageEvents = perSource.flatMap((source) => source.stageEvents);
  const failedSources = perSource.filter((source) => source.failureCode);
  const manualReviewRequired = perSource.filter((source) => source.decision === "manual_review_required");
  const needsAdapter = perSource.filter((source) => source.decision === "adapter_required");
  const payload = {
    runId: RUN_ID,
    runAt: RUN_AT,
    input: path.resolve(INPUT_CSV_PATH),
    filters: {
      auditScope: "all_enabled_sources",
      auditSourceLevels: "all_currently_enabled_source_levels",
      futureSourceDiscoveryScope: "university_headquarters_and_college_only",
      departmentSourceDiscovery: "excluded_from_new_registration",
      sourceIdPrefix: SOURCE_ID_PREFIX || "all",
      sourceIdAllowlistCount: SOURCE_ID_ALLOWLIST.size || "all",
      limit: LIMIT || "none",
      detailSampleSize: DETAIL_SAMPLE_SIZE,
      concurrency: CONCURRENCY,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retryCount: REQUEST_RETRY_COUNT,
      userAgent: AUDIT_USER_AGENT,
    },
    totals: {
      sourceCount: perSource.length,
      byDecision: countBy(perSource, (source) => source.decision),
      byFailureCode: countBy(perSource, (source) => source.failureCode || "none"),
      byAccessProfile: countBy(
        perSource.flatMap((source) => source.accessProfiles),
        (profile) => profile,
      ),
      byStageStatus: countBy(stageEvents, (event) => `${event.stage}:${event.status}`),
    },
    perSource: perSource.map((source) => withoutStageEvents(source)),
    stageEvents,
  };

  const resolvedOutputDir = path.resolve(OUTPUT_DIR);
  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  const kstDate = formatKstDate();
  const datedPath = path.join(resolvedOutputDir, `capability-audit-${kstDate}-${RUN_ID}.json`);
  const datedCsvPath = path.join(resolvedOutputDir, `capability-audit-${kstDate}-${RUN_ID}.csv`);
  const datedUniversityCsvPath = path.join(
    resolvedOutputDir,
    `capability-audit-university-summary-${kstDate}-${RUN_ID}.csv`,
  );
  const datedProfileMarkdownPath = path.join(
    resolvedOutputDir,
    `capability-audit-profile-summary-${kstDate}-${RUN_ID}.md`,
  );
  const datedFormPostRedirectCsvPath = path.join(
    resolvedOutputDir,
    `capability-audit-form-post-redirect-evidence-${kstDate}-${RUN_ID}.csv`,
  );
  const datedFormPostRedirectMarkdownPath = path.join(
    resolvedOutputDir,
    `capability-audit-form-post-redirect-evidence-${kstDate}-${RUN_ID}.md`,
  );
  const datedDecisionExamplesCsvPath = path.join(
    resolvedOutputDir,
    `capability-audit-status-examples-${kstDate}-${RUN_ID}.csv`,
  );
  const datedDecisionExamplesMarkdownPath = path.join(
    resolvedOutputDir,
    `capability-audit-status-examples-${kstDate}-${RUN_ID}.md`,
  );
  const latestPath = path.join(resolvedOutputDir, "capability-audit-latest.json");
  const latestCsvPath = path.join(resolvedOutputDir, "capability-audit-latest.csv");
  const latestUniversityCsvPath = path.join(
    resolvedOutputDir,
    "capability-audit-university-summary-latest.csv",
  );
  const latestProfileMarkdownPath = path.join(
    resolvedOutputDir,
    "capability-audit-profile-summary-latest.md",
  );
  const latestFormPostRedirectCsvPath = path.join(
    resolvedOutputDir,
    "capability-audit-form-post-redirect-evidence-latest.csv",
  );
  const latestFormPostRedirectMarkdownPath = path.join(
    resolvedOutputDir,
    "capability-audit-form-post-redirect-evidence-latest.md",
  );
  const latestDecisionExamplesCsvPath = path.join(
    resolvedOutputDir,
    "capability-audit-status-examples-latest.csv",
  );
  const latestDecisionExamplesMarkdownPath = path.join(
    resolvedOutputDir,
    "capability-audit-status-examples-latest.md",
  );
  const failedPath = path.join(resolvedOutputDir, "failed-sources-latest.json");
  const needsAdapterPath = path.join(resolvedOutputDir, "needs-adapter-latest.json");
  const manualReviewPath = path.join(resolvedOutputDir, "manual-review-required-latest.json");

  const sourceCsv = `\uFEFF${buildSourceCsvRows(perSource).join("\r\n")}`;
  const universityCsv = `\uFEFF${buildUniversitySummaryCsvRows(perSource).join("\r\n")}`;
  const profileMarkdown = buildProfileSummaryMarkdown(perSource);
  const formPostRedirectCsv = `\uFEFF${buildFormPostRedirectEvidenceCsvRows(perSource).join("\r\n")}`;
  const formPostRedirectMarkdown = buildFormPostRedirectEvidenceMarkdown(perSource);
  const decisionExamplesCsv = `\uFEFF${buildDecisionExamplesCsvRows(perSource).join("\r\n")}`;
  const decisionExamplesMarkdown = buildDecisionExamplesMarkdown(perSource);

  fs.writeFileSync(datedPath, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(failedPath, JSON.stringify({ runId: RUN_ID, failedSources }, null, 2), "utf8");
  fs.writeFileSync(needsAdapterPath, JSON.stringify({ runId: RUN_ID, needsAdapter }, null, 2), "utf8");
  fs.writeFileSync(
    manualReviewPath,
    JSON.stringify({ runId: RUN_ID, manualReviewRequired }, null, 2),
    "utf8",
  );
  fs.writeFileSync(datedCsvPath, sourceCsv, "utf8");
  fs.writeFileSync(latestCsvPath, sourceCsv, "utf8");
  fs.writeFileSync(datedUniversityCsvPath, universityCsv, "utf8");
  fs.writeFileSync(latestUniversityCsvPath, universityCsv, "utf8");
  fs.writeFileSync(datedProfileMarkdownPath, profileMarkdown, "utf8");
  fs.writeFileSync(latestProfileMarkdownPath, profileMarkdown, "utf8");
  fs.writeFileSync(datedFormPostRedirectCsvPath, formPostRedirectCsv, "utf8");
  fs.writeFileSync(latestFormPostRedirectCsvPath, formPostRedirectCsv, "utf8");
  fs.writeFileSync(datedFormPostRedirectMarkdownPath, formPostRedirectMarkdown, "utf8");
  fs.writeFileSync(latestFormPostRedirectMarkdownPath, formPostRedirectMarkdown, "utf8");
  fs.writeFileSync(datedDecisionExamplesCsvPath, decisionExamplesCsv, "utf8");
  fs.writeFileSync(latestDecisionExamplesCsvPath, decisionExamplesCsv, "utf8");
  fs.writeFileSync(datedDecisionExamplesMarkdownPath, decisionExamplesMarkdown, "utf8");
  fs.writeFileSync(latestDecisionExamplesMarkdownPath, decisionExamplesMarkdown, "utf8");

  console.log(`audit_json=${datedPath}`);
  console.log(`audit_csv=${datedCsvPath}`);
  console.log(`audit_csv_latest=${latestCsvPath}`);
  console.log(`university_summary_csv=${datedUniversityCsvPath}`);
  console.log(`university_summary_latest=${latestUniversityCsvPath}`);
  console.log(`profile_summary_md=${datedProfileMarkdownPath}`);
  console.log(`profile_summary_latest=${latestProfileMarkdownPath}`);
  console.log(`form_post_redirect_evidence_csv=${datedFormPostRedirectCsvPath}`);
  console.log(`form_post_redirect_evidence_latest_csv=${latestFormPostRedirectCsvPath}`);
  console.log(`form_post_redirect_evidence_md=${datedFormPostRedirectMarkdownPath}`);
  console.log(`form_post_redirect_evidence_latest_md=${latestFormPostRedirectMarkdownPath}`);
  console.log(`status_examples_csv=${datedDecisionExamplesCsvPath}`);
  console.log(`status_examples_latest_csv=${latestDecisionExamplesCsvPath}`);
  console.log(`status_examples_md=${datedDecisionExamplesMarkdownPath}`);
  console.log(`status_examples_latest_md=${latestDecisionExamplesMarkdownPath}`);
  console.log(`audit_latest=${latestPath}`);
  console.log(`failed_sources=${failedPath}`);
  console.log(`needs_adapter=${needsAdapterPath}`);
  console.log(`manual_review_required=${manualReviewPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
