import fs from "node:fs";
import path from "node:path";
import { load as loadHtml } from "cheerio";
import { Agent as UndiciAgent } from "undici";
import {
  extractNoticeUrlFromLinkNode,
  getListAdapter,
} from "../lib/crawler-adapters/index.mjs";

const DEFAULT_KEYWORDS = [
  "장학",
  "장학금",
  "학자금",
  "등록금",
  "scholarship",
  "tuition",
  "financial aid",
];

const INPUT_CSV_PATH = process.argv[2] ?? "data/notice-sources.csv";
const OUTPUT_DIR = process.argv[3] ?? "exports/notices";
const STATE_FILE_PATH =
  process.argv[4] ?? ".crawler/scholarship-notice-state.json";
const REQUEST_TIMEOUT_MS = Number(process.env.CRAWL_TIMEOUT_MS ?? 15_000);
const REQUEST_RETRY_COUNT = Math.max(0, Number(process.env.CRAWL_RETRY_COUNT ?? 2));
const REQUEST_RETRY_BACKOFF_MS = Math.max(
  200,
  Number(process.env.CRAWL_RETRY_BACKOFF_MS ?? 1_000),
);
const DEFAULT_CRAWL_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const CRAWL_USER_AGENT = cleanText(process.env.CRAWL_USER_AGENT ?? DEFAULT_CRAWL_USER_AGENT);
const DETAIL_FETCH_ENABLED = process.env.CRAWL_DETAIL_FETCH !== "false";
const LOOKBACK_DAYS = Number(process.env.CRAWL_LOOKBACK_DAYS ?? 31);
const ALLOW_UNDATED = process.env.CRAWL_ALLOW_UNDATED === "true";
const MAX_ITEMS_PER_SOURCE = Number(process.env.CRAWL_MAX_ITEMS_PER_SOURCE ?? 150);
const SOURCE_CONCURRENCY = Math.max(1, Number(process.env.CRAWL_SOURCE_CONCURRENCY ?? 1));
const IGNORE_SEEN = process.env.CRAWL_IGNORE_SEEN === "true";
const FALLBACK_CHARSET = process.env.CRAWL_FALLBACK_CHARSET ?? "utf-8";
const SOURCE_ID_PREFIX = cleanText(process.env.CRAWL_SOURCE_ID_PREFIX ?? "").toLowerCase();
const SOURCE_ID_ALLOWLIST = new Set(
  String(process.env.CRAWL_SOURCE_ID_ALLOWLIST ?? "")
    .split(/[,\s|]+/)
    .map((item) => cleanText(item).toLowerCase())
    .filter(Boolean),
);
const SOURCE_LEVEL_ALLOWLIST = new Set(
  String(process.env.CRAWL_SOURCE_LEVEL ?? "")
    .split(/[,\s|]+/)
    .map((item) => cleanText(item).toLowerCase())
    .filter(Boolean),
);
const COLLEGE_NAME_ALLOWLIST = new Set(
  String(process.env.CRAWL_COLLEGE_NAME ?? "")
    .split(/[,\s|]+/)
    .map((item) => cleanText(item).toLowerCase())
    .filter(Boolean),
);
const INSECURE_TLS_HOSTS = new Set(
  String(process.env.CRAWL_ALLOW_INSECURE_TLS_HOSTS ?? "")
    .split(/[,\s|]+/)
    .map((item) => cleanText(item).toLowerCase())
    .filter(Boolean),
);
const INSECURE_TLS_DISPATCHER =
  INSECURE_TLS_HOSTS.size > 0
    ? new UndiciAgent({
        connect: {
          rejectUnauthorized: false,
        },
      })
    : null;
const RUN_AT = new Date().toISOString();

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

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
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
    .map((piece) => piece.trim())
    .filter(Boolean);
}

function toBoolean(value, defaultValue = true) {
  if (!value) return defaultValue;
  const lowered = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(lowered)) return true;
  if (["false", "0", "no", "n"].includes(lowered)) return false;
  return defaultValue;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function serializeCrawlerError(error, depth = 0) {
  if (!error || depth > 4) return null;
  const cause = error.cause ? serializeCrawlerError(error.cause, depth + 1) : null;
  return {
    name: cleanText(error.name),
    message: cleanText(error.message ?? error),
    code: cleanText(error.code),
    cause,
  };
}

function flattenErrorChain(errorDetails) {
  const chain = [];
  let current = errorDetails;
  while (current) {
    chain.push(
      [current.name, current.code, current.message]
        .filter(Boolean)
        .join(": ")
        .slice(0, 240),
    );
    current = current.cause;
  }
  return chain.filter(Boolean);
}

function deriveUniversitySlug(sourceId, fallback = "") {
  const normalizedSourceId = cleanText(sourceId).toLowerCase();
  if (normalizedSourceId.includes("_")) return normalizedSourceId.split("_")[0];
  return cleanText(fallback).toLowerCase();
}

function deriveDepartmentName(sourceName, sourceLevel = "department", fallback = "") {
  if (cleanText(sourceLevel).toLowerCase() !== "department") {
    return cleanText(fallback);
  }
  const normalizedFallback = cleanText(fallback);
  if (normalizedFallback) return normalizedFallback;

  const normalizedSourceName = cleanText(sourceName);
  if (!normalizedSourceName) return "";
  const pieces = normalizedSourceName.split(/\s+/);
  if (pieces.length <= 1) return normalizedSourceName;
  return pieces.slice(1).join(" ").trim();
}

function extractDateLikeText(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return "";

  const patterns = [
    /(\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2})/,
    /(\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일)/,
    /(\d{2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2})/,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match) return cleanText(match[1]);
  }

  return "";
}

function extractListDateText(itemRoot, dateSelector) {
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (value) => {
    const text = cleanText(value);
    if (!text || seen.has(text)) return;
    seen.add(text);
    candidates.push(text);
  };

  if (dateSelector) {
    itemRoot.find(dateSelector).each((_, node) => {
      pushCandidate(itemRoot.find(node).text());
    });
  }

  itemRoot.find("time, td, span, div").each((index, node) => {
    if (index > 40) return false;
    pushCandidate(itemRoot.find(node).text());
    return undefined;
  });

  for (const candidate of candidates) {
    const dateLike = extractDateLikeText(candidate);
    if (dateLike) return dateLike;
  }

  return "";
}

function readSourceConfig(csvPath) {
  const raw = fs.readFileSync(path.resolve(csvPath), "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(raw);
  if (table.length === 0) {
    throw new Error("Source CSV is empty.");
  }

  const [header, ...body] = table;
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const required = ["source_id", "source_name", "list_url"];
  for (const column of required) {
    if (!(column in index)) {
      throw new Error(`Missing required CSV column: ${column}`);
    }
  }

  return body
    .filter((row) => row.some((cell) => cleanText(cell)))
    .map((row) => {
      const sourceLevel = cleanText(row[index.source_level]) || "department";
      const sourceName = cleanText(row[index.source_name]);
      return {
      sourceId: cleanText(row[index.source_id]),
      universitySlug: deriveUniversitySlug(row[index.source_id], row[index.university_slug]),
      universityId: cleanText(row[index.university_id]),
      collegeId: cleanText(row[index.college_id]),
      departmentId: cleanText(row[index.department_id]),
      collegeName: cleanText(row[index.college_name]),
      departmentName: deriveDepartmentName(sourceName, sourceLevel, row[index.department_name]),
      sourceLevel,
      sourceName,
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
      enabled: toBoolean(row[index.enabled], true),
    };
    })
    .filter((source) => source.sourceId && source.sourceName && source.listUrl && source.enabled);
}

function normalizeCharset(value) {
  const normalized = cleanText(value).toLowerCase().replace(/^['"]|['"]$/g, "");
  if (!normalized) return "";
  if (normalized === "utf8") return "utf-8";
  if (["cp949", "ms949", "ks_c_5601-1987"].includes(normalized)) return "euc-kr";
  return normalized;
}

function detectCharsetFromHeaders(contentType) {
  const raw = cleanText(contentType);
  if (!raw) return "";
  const match = raw.match(/charset\s*=\s*([^;]+)/i);
  if (!match) return "";
  return normalizeCharset(match[1]);
}

function detectCharsetFromHtmlProbe(htmlProbe) {
  const probe = cleanText(htmlProbe);
  if (!probe) return "";
  const metaCharset = probe.match(/<meta[^>]*charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i);
  if (metaCharset?.[1]) return normalizeCharset(metaCharset[1]);
  const metaContent = probe.match(
    /<meta[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9._-]+)/i,
  );
  if (metaContent?.[1]) return normalizeCharset(metaContent[1]);
  return "";
}

function decodeHtmlBuffer(buffer, headerCharset) {
  const probe = new TextDecoder("latin1").decode(buffer.subarray(0, 4096));
  const metaCharset = detectCharsetFromHtmlProbe(probe);

  const candidates = [headerCharset, metaCharset, FALLBACK_CHARSET, "utf-8", "euc-kr"]
    .map((value) => normalizeCharset(value))
    .filter(Boolean);
  const uniqueCandidates = [...new Set(candidates)];

  for (const charset of uniqueCandidates) {
    try {
      return new TextDecoder(charset, { fatal: true }).decode(buffer);
    } catch {
      // Try the next candidate charset.
    }
  }

  return new TextDecoder("utf-8").decode(buffer);
}

async function fetchHtml(url) {
  let parsedUrl = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    parsedUrl = null;
  }
  const shouldAllowInsecureTls =
    parsedUrl &&
    INSECURE_TLS_HOSTS.has(parsedUrl.hostname.toLowerCase());

  let lastError = null;
  for (let attempt = 0; attempt <= REQUEST_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        dispatcher: shouldAllowInsecureTls ? INSECURE_TLS_DISPATCHER : undefined,
        headers: {
          "user-agent": CRAWL_USER_AGENT,
          accept: "text/html,application/xhtml+xml",
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const headerCharset = detectCharsetFromHeaders(response.headers.get("content-type") ?? "");
      const bytes = new Uint8Array(await response.arrayBuffer());
      return decodeHtmlBuffer(bytes, headerCharset);
    } catch (error) {
      lastError = error;
      if (attempt < REQUEST_RETRY_COUNT) {
        const waitMs = REQUEST_RETRY_BACKOFF_MS * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error("fetch failed");
}

function extractFromList(source, html) {
  const $ = loadHtml(html);
  const results = [];
  const seen = new Set();

  const pushResult = (node, index) => {
    const itemRoot = node ? $(node) : null;
    const linkNode = itemRoot
      ? source.linkSelector
        ? itemRoot.find(source.linkSelector).first()
        : itemRoot.find("a[href]").first()
      : null;
    const fallbackLinkNode = !itemRoot ? $("a[href]").eq(index) : null;
    const activeLinkNode = linkNode && linkNode.length ? linkNode : fallbackLinkNode;

    const noticeUrl = extractNoticeUrlFromLinkNode(source, activeLinkNode);
    if (!noticeUrl || seen.has(noticeUrl)) return;

    const titleRaw = itemRoot
      ? source.titleSelector
        ? itemRoot.find(source.titleSelector).first().text()
        : activeLinkNode?.text() ?? itemRoot.text()
      : activeLinkNode?.text() ?? "";
    const title = cleanText(titleRaw);
    if (!title) return;

    const dateText = itemRoot ? extractListDateText(itemRoot, source.dateSelector) : "";

    seen.add(noticeUrl);
    results.push({
      sourceId: source.sourceId,
      universitySlug: source.universitySlug,
      universityId: source.universityId,
      collegeId: source.collegeId,
      departmentId: source.departmentId,
      collegeName: source.collegeName,
      departmentName: source.departmentName,
      sourceLevel: source.sourceLevel,
      sourceName: source.sourceName,
      listUrl: source.listUrl,
      noticeUrl,
      title,
      dateText,
    });
  };

  if (source.listItemSelector) {
    $(source.listItemSelector).each((index, node) => pushResult(node, index));
  } else {
    $("a[href]").each((index) => pushResult(null, index));
  }

  if (source.noticeUrlPattern) {
    const pattern = new RegExp(source.noticeUrlPattern);
    return results.filter((item) => pattern.test(item.noticeUrl));
  }
  return results;
}

function containsScholarshipKeyword(text, keywords) {
  const normalized = cleanText(text).toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
}

function trimItems(items, maxItems) {
  if (!Number.isFinite(maxItems) || maxItems <= 0) return items;
  return items.slice(0, maxItems);
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

function parseNoticeDate(rawText) {
  const text = cleanText(rawText);
  if (!text) return null;

  const patterns = [
    /(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/,
    /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/,
    /(\d{2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    let year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 100) year += 2000;
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      continue;
    }

    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(parsed.getTime())) continue;
    return parsed;
  }

  return null;
}

function isWithinLookback(parsedDate, days) {
  if (!parsedDate) return false;
  const now = new Date();
  const minDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return parsedDate >= minDate && parsedDate <= now;
}

async function enrichDetail(source, item) {
  if (!DETAIL_FETCH_ENABLED) return item;

  try {
    const detailHtml = await fetchHtml(item.noticeUrl);
    const $detail = loadHtml(detailHtml);
    const content = source.detailContentSelector
      ? cleanText($detail(source.detailContentSelector).first().text())
      : "";
    const detailDate = source.detailDateSelector
      ? cleanText($detail(source.detailDateSelector).first().text())
      : "";
    return {
      ...item,
      content,
      detailDate,
    };
  } catch (error) {
    const errorDetails = serializeCrawlerError(error);
    return {
      ...item,
      detailFetchError: errorDetails?.message ?? String(error?.message ?? error),
      detailFetchErrorDetails: errorDetails,
      detailFetchErrorChain: flattenErrorChain(errorDetails),
    };
  }
}

function loadState(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return { seen: {} };
  const raw = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || typeof parsed.seen !== "object") {
    return { seen: {} };
  }
  return parsed;
}

function escapeCsvCell(value) {
  const text = cleanText(value ?? "");
  const escaped = text.replace(/"/g, "\"\"");
  if (/[",\n\r]/.test(escaped)) return `"${escaped}"`;
  return escaped;
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
  const configuredSources = readSourceConfig(INPUT_CSV_PATH);
  const configuredPrefixes = [...new Set(configuredSources.map((source) => source.sourceId.split("_")[0]))];
  if (!SOURCE_ID_PREFIX && configuredPrefixes.length > 1) {
    console.warn(
      `warning=mixed_source_prefixes count=${configuredPrefixes.length} prefixes=${configuredPrefixes.join("|")}`,
    );
  }
  const sources = configuredSources.filter((source) => {
    const sourceId = source.sourceId.toLowerCase();
    const sourceLevel = cleanText(source.sourceLevel).toLowerCase();
    const collegeName = cleanText(source.collegeName).toLowerCase();
    if (SOURCE_ID_PREFIX && !sourceId.startsWith(SOURCE_ID_PREFIX)) {
      return false;
    }
    if (SOURCE_ID_ALLOWLIST.size > 0 && !SOURCE_ID_ALLOWLIST.has(sourceId)) {
      return false;
    }
    if (SOURCE_LEVEL_ALLOWLIST.size > 0 && !SOURCE_LEVEL_ALLOWLIST.has(sourceLevel)) {
      return false;
    }
    if (COLLEGE_NAME_ALLOWLIST.size > 0 && !COLLEGE_NAME_ALLOWLIST.has(collegeName)) {
      return false;
    }
    return true;
  });
  if (sources.length === 0) {
    throw new Error(
      SOURCE_ID_PREFIX
        ? `No enabled sources matched source prefix: ${SOURCE_ID_PREFIX}`
        : "No enabled sources found (check source level/college filters).",
    );
  }
  const state = loadState(STATE_FILE_PATH);
  const seen = { ...state.seen };
  const crawled = [];
  const allMatched = [];
  const allNew = [];
  const stats = [];

  const processed = await mapLimit(sources, SOURCE_CONCURRENCY, async (source) => {
    try {
      const listAdapter = getListAdapter(source.adapter);
      let listItems;
      let detailItems = [];
      if (listAdapter) {
        // 어댑터 소스: 목록 API가 제목/날짜/본문 요약을 모두 제공하므로
        // 기본 HTML 파싱과 개별 상세 요청을 건너뜁니다.
        listItems = trimItems(
          await listAdapter(source, {
            lookbackDays: LOOKBACK_DAYS,
            allowUndated: ALLOW_UNDATED,
            maxItems: MAX_ITEMS_PER_SOURCE,
          }),
          MAX_ITEMS_PER_SOURCE,
        );
        detailItems = listItems;
      } else {
        const listHtml = await fetchHtml(source.listUrl);
        listItems = trimItems(extractFromList(source, listHtml), MAX_ITEMS_PER_SOURCE);
        if (DETAIL_FETCH_ENABLED) {
          for (const item of listItems) {
            // Small pacing to reduce load on university websites.
            await new Promise((resolve) => setTimeout(resolve, 250));
            detailItems.push(await enrichDetail(source, item));
          }
        } else {
          detailItems.push(...listItems);
        }
      }
      detailItems = detailItems.map((item) => ({
        ...item,
        sourceId: item.sourceId ?? source.sourceId,
        sourceName: item.sourceName ?? source.sourceName,
        universitySlug: item.universitySlug ?? source.universitySlug,
        universityId: item.universityId ?? source.universityId,
        collegeId: item.collegeId ?? source.collegeId,
        departmentId: item.departmentId ?? source.departmentId,
        collegeName: item.collegeName ?? source.collegeName,
        departmentName: item.departmentName ?? source.departmentName,
        sourceLevel: item.sourceLevel ?? source.sourceLevel,
      }));

      const keywords = source.keywords.length > 0 ? source.keywords : DEFAULT_KEYWORDS;
      const matched = detailItems
        .map((item) => {
          const parsedDate =
            parseNoticeDate(item.detailDate) ??
            parseNoticeDate(item.dateText) ??
            parseNoticeDate(item.title);
          return {
            ...item,
            parsedDate: parsedDate ? parsedDate.toISOString().slice(0, 10) : "",
          };
        })
        .filter((item) =>
          containsScholarshipKeyword(
            [item.title, item.dateText, item.detailDate, item.content].filter(Boolean).join(" "),
            keywords,
          ),
        )
        .filter((item) => {
          const parsed = item.parsedDate ? new Date(`${item.parsedDate}T00:00:00.000Z`) : null;
          if (!parsed && ALLOW_UNDATED) return true;
          return isWithinLookback(parsed, LOOKBACK_DAYS);
        });
      return {
        sourceId: source.sourceId,
        universitySlug: source.universitySlug,
        universityId: source.universityId,
        collegeId: source.collegeId,
        departmentId: source.departmentId,
        sourceLevel: source.sourceLevel,
        collegeName: source.collegeName,
        sourceName: source.sourceName,
        detailItems,
        matched,
        error: "",
      };
    } catch (error) {
      const errorDetails = serializeCrawlerError(error);
      return {
        sourceId: source.sourceId,
        universitySlug: source.universitySlug,
        universityId: source.universityId,
        collegeId: source.collegeId,
        departmentId: source.departmentId,
        sourceLevel: source.sourceLevel,
        collegeName: source.collegeName,
        sourceName: source.sourceName,
        error: errorDetails?.message ?? String(error?.message ?? error),
        errorDetails,
        errorChain: flattenErrorChain(errorDetails),
        detailItems: [],
        matched: [],
      };
    }
  });

  for (const result of processed) {
    if (result.error) {
      stats.push({
        sourceId: result.sourceId,
        universitySlug: result.universitySlug,
        universityId: result.universityId,
        collegeId: result.collegeId,
        departmentId: result.departmentId,
        sourceLevel: result.sourceLevel,
        collegeName: result.collegeName,
        sourceName: result.sourceName,
        crawledCount: 0,
        matchedCount: 0,
        newCount: 0,
        error: result.error,
        errorDetails: result.errorDetails,
        errorChain: result.errorChain,
      });
      console.log(`source=${result.sourceId} error=${result.error}`);
      continue;
    }

    const newlyDiscovered = IGNORE_SEEN
      ? result.matched
      : result.matched.filter((item) => !seen[item.noticeUrl]);
    if (!IGNORE_SEEN) {
      for (const notice of newlyDiscovered) {
        seen[notice.noticeUrl] = RUN_AT;
      }
    }

    crawled.push(...result.detailItems);
    allMatched.push(...result.matched);
    allNew.push(...newlyDiscovered);
    stats.push({
      sourceId: result.sourceId,
      universitySlug: result.universitySlug,
      universityId: result.universityId,
      collegeId: result.collegeId,
      departmentId: result.departmentId,
      sourceLevel: result.sourceLevel,
      collegeName: result.collegeName,
      sourceName: result.sourceName,
      crawledCount: result.detailItems.length,
      matchedCount: result.matched.length,
      newCount: newlyDiscovered.length,
    });
    console.log(
      `source=${result.sourceId} crawled=${result.detailItems.length} matched=${result.matched.length} new=${newlyDiscovered.length}`,
    );
  }

  const kstDate = formatKstDate();
  const resolvedOutputDir = path.resolve(OUTPUT_DIR);
  const resolvedStatePath = path.resolve(STATE_FILE_PATH);
  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  fs.mkdirSync(path.dirname(resolvedStatePath), { recursive: true });

  const report = {
    runAt: RUN_AT,
    input: path.resolve(INPUT_CSV_PATH),
    totals: {
      sourceCount: sources.length,
      crawledCount: crawled.length,
      matchedCount: allMatched.length,
      newCount: allNew.length,
      knownCount: Object.keys(seen).length,
      lookbackDays: LOOKBACK_DAYS,
      allowUndated: ALLOW_UNDATED,
      sourceConcurrency: SOURCE_CONCURRENCY,
      ignoreSeen: IGNORE_SEEN,
      userAgent: CRAWL_USER_AGENT,
      sourceLevelFilterCount:
        SOURCE_LEVEL_ALLOWLIST.size > 0 ? SOURCE_LEVEL_ALLOWLIST.size : "all",
      collegeFilterCount:
        COLLEGE_NAME_ALLOWLIST.size > 0 ? COLLEGE_NAME_ALLOWLIST.size : "all",
    },
    perSource: stats,
    newNotices: allNew,
  };

  const jsonPath = path.join(resolvedOutputDir, `scholarship-notices-${kstDate}.json`);
  const latestJsonPath = path.join(resolvedOutputDir, "scholarship-notices-latest.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(latestJsonPath, JSON.stringify(report, null, 2), "utf8");

  const csvHeader = [
    "run_at",
    "source_id",
    "university_slug",
    "university_id",
    "college_id",
    "department_id",
    "college_name",
    "department_name",
    "source_level",
    "source_name",
    "title",
    "notice_url",
    "date_text",
    "detail_date",
    "parsed_date",
    "content",
  ];
  const csvLines = [
    csvHeader.join(","),
    ...allNew.map((row) =>
      [
        RUN_AT,
        row.sourceId,
        row.universitySlug ?? "",
        row.universityId ?? "",
        row.collegeId ?? "",
        row.departmentId ?? "",
        row.collegeName ?? "",
        row.departmentName ?? "",
        row.sourceLevel ?? "",
        row.sourceName,
        row.title,
        row.noticeUrl,
        row.dateText ?? "",
        row.detailDate ?? "",
        row.parsedDate ?? "",
        row.content ?? "",
      ]
        .map((cell) => escapeCsvCell(cell))
        .join(","),
    ),
  ];
  const csvPath = path.join(resolvedOutputDir, `scholarship-notices-new-${kstDate}.csv`);
  fs.writeFileSync(csvPath, `\uFEFF${csvLines.join("\r\n")}`, "utf8");

  fs.writeFileSync(
    resolvedStatePath,
    JSON.stringify(
      {
        updatedAt: RUN_AT,
        seen,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`sources=${sources.length}`);
  console.log(`crawled=${crawled.length}`);
  console.log(`matched=${allMatched.length}`);
  console.log(`new=${allNew.length}`);
  console.log(`source_prefix=${SOURCE_ID_PREFIX || "all"}`);
  console.log(
    `source_allowlist_count=${SOURCE_ID_ALLOWLIST.size > 0 ? SOURCE_ID_ALLOWLIST.size : "all"}`,
  );
  console.log(
    `source_level_filter=${SOURCE_LEVEL_ALLOWLIST.size > 0 ? [...SOURCE_LEVEL_ALLOWLIST].join("|") : "all"}`,
  );
  console.log(
    `college_name_filter=${COLLEGE_NAME_ALLOWLIST.size > 0 ? [...COLLEGE_NAME_ALLOWLIST].join("|") : "all"}`,
  );
  console.log(
    `insecure_tls_hosts=${INSECURE_TLS_HOSTS.size > 0 ? [...INSECURE_TLS_HOSTS].join("|") : "none"}`,
  );
  console.log(`json=${jsonPath}`);
  console.log(`csv=${csvPath}`);
  console.log(`state=${resolvedStatePath}`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
