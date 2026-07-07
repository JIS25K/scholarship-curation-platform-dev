import fs from "node:fs";
import path from "node:path";
import { load as loadHtml } from "cheerio";
import { normalizePublicAccessUrl } from "../lib/crawler-adapters/index.mjs";
import { parseNoticeList } from "../lib/crawler-parsers/list-parser.mjs";
import { applyOfficialSourceFallbacks } from "../lib/crawler-source-fallbacks.mjs";

const DEFAULT_AUDIT_JSON_PATH =
  "exports/notices/diagnostics/capability-audit-latest.json";
const DEFAULT_SOURCE_CSV_PATH = "data/notice-sources.csv";
const DEFAULT_OUTPUT_DIR = "exports/notices/diagnostics";
const REQUEST_TIMEOUT_MS = Number(process.env.VERIFY_ZERO_TIMEOUT_MS ?? 12_000);
const CONCURRENCY = Math.max(1, Number(process.env.VERIFY_ZERO_CONCURRENCY ?? 6));
const MAX_CANDIDATE_LINKS = Math.max(1, Number(process.env.VERIFY_ZERO_MAX_LINKS ?? 6));
const SOURCE_ID_PREFIX = cleanText(process.env.VERIFY_ZERO_SOURCE_ID_PREFIX).toLowerCase();
const SOURCE_ID_ALLOWLIST = new Set(
  cleanText(process.env.VERIFY_ZERO_SOURCE_ID_ALLOWLIST)
    .split(/[,\s|]+/u)
    .map((value) => cleanText(value).toLowerCase())
    .filter(Boolean),
);
const USER_AGENT =
  process.env.VERIFY_ZERO_USER_AGENT ??
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const SCHOLARSHIP_PATTERN =
  /(장학|장학생|학자금|등록금|scholarship|tuition|financial\s*aid|fellowship|grant)/iu;
const NOTICE_BOARD_PATTERN =
  /(공지|notice|board|bbs|article|list|news|소식|안내|게시판)/iu;
const STATIC_INFO_PATTERN =
  /(소개|제도|규정|방법|faq|qna|자료|양식|서식|calendar|schedule|guideline|policy)/iu;

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"") inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseList(value) {
  return cleanText(value)
    .split("|")
    .map((piece) => cleanText(piece))
    .filter(Boolean);
}

function toBoolean(value, defaultValue = true) {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized) return defaultValue;
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return defaultValue;
}

function deriveUniversitySlug(sourceId, fallback = "") {
  const normalized = cleanText(sourceId).toLowerCase();
  return normalized.includes("_") ? normalized.split("_")[0] : cleanText(fallback).toLowerCase();
}

function readSourceConfig(csvPath) {
  const raw = fs.readFileSync(path.resolve(csvPath), "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(raw);
  const [header, ...body] = table;
  const index = Object.fromEntries(header.map((name, columnIndex) => [name, columnIndex]));
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
  return normalizeCharset(match?.[1]);
}

function detectCharsetFromHtmlProbe(htmlProbe) {
  const metaCharset = String(htmlProbe ?? "").match(
    /<meta[^>]*charset\s*=\s*["']?\s*([a-zA-Z0-9._-]+)/i,
  );
  if (metaCharset?.[1]) return normalizeCharset(metaCharset[1]);
  const metaContent = String(htmlProbe ?? "").match(
    /<meta[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9._-]+)/i,
  );
  return normalizeCharset(metaContent?.[1]);
}

function decodeHtmlBuffer(buffer, headerCharset) {
  const probe = new TextDecoder("latin1").decode(buffer.subarray(0, 4096));
  const metaCharset = detectCharsetFromHtmlProbe(probe);
  const candidates = [headerCharset, metaCharset, "utf-8", "euc-kr"]
    .map((value) => normalizeCharset(value))
    .filter(Boolean);
  for (const charset of [...new Set(candidates)]) {
    try {
      return { html: new TextDecoder(charset, { fatal: true }).decode(buffer), charset };
    } catch {
      // Try the next candidate.
    }
  }
  const charset = candidates[0] ?? "utf-8";
  return { html: new TextDecoder(charset).decode(buffer), charset };
}

function canonicalUrl(value) {
  try {
    const target = new URL(value);
    target.hash = "";
    if (target.pathname.endsWith("/") && target.pathname !== "/") {
      target.pathname = target.pathname.replace(/\/+$/u, "");
    }
    return target.toString();
  } catch {
    return cleanText(value);
  }
}

function resolveUrl(value, baseUrl) {
  const input = cleanText(value);
  if (!input || input.startsWith("#") || /^javascript:/iu.test(input)) return "";
  try {
    return normalizePublicAccessUrl(new URL(input, baseUrl).toString());
  } catch {
    return "";
  }
}

function sameOfficialSite(candidateUrl, sourceUrl) {
  try {
    const candidate = new URL(candidateUrl);
    const source = new URL(sourceUrl);
    return (
      candidate.hostname === source.hostname ||
      candidate.hostname.endsWith(`.${source.hostname}`) ||
      source.hostname.endsWith(`.${candidate.hostname}`)
    );
  } catch {
    return false;
  }
}

async function fetchHtml(url) {
  const requestUrl = normalizePublicAccessUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(requestUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const decoded = decodeHtmlBuffer(bytes, detectCharsetFromHeaders(response.headers.get("content-type")));
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url,
      html: decoded.html,
      charset: decoded.charset,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function rankScholarshipLink(link) {
  let score = 0;
  if (/(장학공지|장학\s*공지|scholarship\s*notice)/iu.test(link.text)) score += 40;
  if (/(장학|scholarship)/iu.test(link.text)) score += 20;
  if (NOTICE_BOARD_PATTERN.test(link.text) || NOTICE_BOARD_PATTERN.test(link.url)) score += 15;
  if (STATIC_INFO_PATTERN.test(link.text) && !NOTICE_BOARD_PATTERN.test(link.text)) score -= 20;
  if (/\/(?:notice|board|bbs|article|news|list)\b/iu.test(link.url)) score += 10;
  if (/[?&](?:board|bbs|menu|mid|category|cate|tab|code|id)=/iu.test(link.url)) score += 8;
  return score;
}

function collectScholarshipLinks(source, html, fetchedUrl) {
  const $ = loadHtml(String(html ?? ""));
  const current = canonicalUrl(fetchedUrl || source.listUrl);
  const byUrl = new Map();
  $("a[href]").each((_, node) => {
    const anchor = $(node);
    const text = cleanText(
      [anchor.text(), anchor.attr("title"), anchor.attr("aria-label"), anchor.attr("href")]
        .filter(Boolean)
        .join(" "),
    );
    if (!SCHOLARSHIP_PATTERN.test(text)) return;
    const url = resolveUrl(anchor.attr("href"), fetchedUrl || source.listUrl);
    if (!url || canonicalUrl(url) === current) return;
    if (!sameOfficialSite(url, fetchedUrl || source.listUrl)) return;
    const existing = byUrl.get(canonicalUrl(url));
    const value = {
      text: cleanText(anchor.text() || anchor.attr("title") || anchor.attr("aria-label")),
      url,
    };
    if (!existing || rankScholarshipLink(value) > rankScholarshipLink(existing)) {
      byUrl.set(canonicalUrl(url), value);
    }
  });
  return [...byUrl.values()]
    .sort((left, right) => rankScholarshipLink(right) - rankScholarshipLink(left))
    .slice(0, MAX_CANDIDATE_LINKS);
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function evaluateScholarshipLink(source, link) {
  try {
    const page = await fetchHtml(link.url);
    if (!page.ok) {
      return {
        ...link,
        status: "fetch_failed",
        httpStatus: page.status,
        itemCount: 0,
        keywordMatchCount: 0,
      };
    }
    const candidateSource = {
      ...source,
      listUrl: page.finalUrl || link.url,
      baseUrl: source.baseUrl || new URL(page.finalUrl || link.url).origin,
      noticeUrlPattern: "",
    };
    const parsed = parseNoticeList(candidateSource, page.html);
    return {
      ...link,
      status: parsed.items.length > 0 || parsed.metrics.explicitEmptyStateDetected
        ? "parseable_board"
        : "non_board_or_unparseable",
      httpStatus: page.status,
      finalUrl: page.finalUrl,
      itemCount: parsed.items.length,
      keywordMatchCount: parsed.metrics.keywordMatchCount ?? 0,
      explicitEmptyStateDetected: Boolean(parsed.metrics.explicitEmptyStateDetected),
      parserStrategy: parsed.metrics.parserStrategy,
      sampleTitles: parsed.items.slice(0, 3).map((item) => item.title).join(" | "),
    };
  } catch (error) {
    return {
      ...link,
      status: "fetch_error",
      error: cleanText(error.message || error.name),
      itemCount: 0,
      keywordMatchCount: 0,
    };
  }
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}

function makeDecision(source, page, links, evaluatedLinks) {
  const parseableScholarshipBoards = evaluatedLinks.filter(isActionableScholarshipNoticeBoard);
  const parseableEmptyScholarshipBoards = evaluatedLinks.filter(
    (link) =>
      link.status === "parseable_board" &&
      link.explicitEmptyStateDetected &&
      isNoticeBoardUrlOrLabel(link),
  );
  if (!page.ok) return "needs_recheck_current_url_fetch_failed";
  if (parseableScholarshipBoards.length > 0) return "better_scholarship_board_found";
  if (parseableEmptyScholarshipBoards.length > 0) return "empty_scholarship_board_found";
  if (links.length > 0) return "scholarship_link_seen_but_not_parseable_board";
  if (SCHOLARSHIP_PATTERN.test(source.listUrl)) return "current_url_already_scholarship_scoped";
  return "current_notice_url_has_no_scholarship_candidates";
}

function isNoticeBoardUrlOrLabel(link) {
  const searchable = cleanText([link.text, link.url, link.finalUrl].filter(Boolean).join(" "));
  return (
    NOTICE_BOARD_PATTERN.test(searchable) ||
    /(?:board|bbs|notice|article|list|bo_table|boardId|BbsPortlet|BMSR|menuNo|type=.*%EC%9E%A5%ED%95%99|scholarship_(?:under|notice)|board03\.do)/iu.test(
      searchable,
    )
  );
}

function isActionableScholarshipNoticeBoard(link) {
  if (link.status !== "parseable_board") return false;
  const itemCount = Number(link.itemCount ?? 0);
  const keywordMatchCount = Number(link.keywordMatchCount ?? 0);
  if (itemCount <= 0) return false;
  if (!isNoticeBoardUrlOrLabel(link)) return false;
  const label = cleanText(link.text);
  const staticInfoOnly =
    /(장학\s*제도|재학생\s*장학제도|진리장학금|scholarships?\.do)/iu.test(
      cleanText([label, link.url].join(" ")),
    ) &&
    !/(장학\s*공지|장학금\s*정보|장학안내|공지사항|notice|board|bbs|list|BbsPortlet|bo_table|boardId|BMSR)/iu.test(
      cleanText([label, link.url].join(" ")),
    );
  if (staticInfoOnly) return false;
  return itemCount >= 3 || keywordMatchCount >= 1 || isNoticeBoardUrlOrLabel(link);
}

async function verifySource(source, auditSource) {
  try {
    const page = await fetchHtml(auditSource.listUrl || source.listUrl);
    if (!page.ok) {
      return {
        source,
        auditSource,
        page,
        links: [],
        evaluatedLinks: [],
        decision: makeDecision(source, page, [], []),
      };
    }
    const links = collectScholarshipLinks(source, page.html, page.finalUrl || source.listUrl);
    const evaluatedLinks = await mapLimit(links, Math.min(3, links.length || 1), (link) =>
      evaluateScholarshipLink(source, link),
    );
    return {
      source,
      auditSource,
      page,
      links,
      evaluatedLinks,
      decision: makeDecision(source, page, links, evaluatedLinks),
    };
  } catch (error) {
    return {
      source,
      auditSource,
      page: { ok: false, status: "", finalUrl: auditSource.listUrl || source.listUrl },
      links: [],
      evaluatedLinks: [],
      decision: "needs_recheck_current_url_fetch_error",
      error: cleanText(error.message || error.name),
    };
  }
}

function buildCsvRows(results) {
  const header = [
    "source_id",
    "university_slug",
    "college_name",
    "department_name",
    "source_name",
    "decision",
    "zero_reason",
    "configured_list_url",
    "effective_list_url",
    "current_http_status",
    "current_final_url",
    "fallback_source_id",
    "recommended_scholarship_url",
    "recommended_link_text",
    "recommended_item_count",
    "recommended_keyword_match_count",
    "recommended_parser_strategy",
    "scholarship_links_seen",
    "sample_titles",
    "verification_error",
  ];
  const rows = results.map((result) => {
    const best =
      result.evaluatedLinks.find(isActionableScholarshipNoticeBoard) ||
      result.evaluatedLinks.find(
        (link) =>
          link.status === "parseable_board" &&
          link.explicitEmptyStateDetected &&
          isNoticeBoardUrlOrLabel(link),
      );
    return [
      result.source.sourceId,
      result.source.universitySlug,
      result.source.collegeName,
      result.source.departmentName,
      result.source.sourceName,
      result.decision,
      result.auditSource.failureCode,
      result.auditSource.configuredListUrl || result.source.configuredListUrl || result.source.listUrl,
      result.auditSource.listUrl || result.source.listUrl,
      result.page.status,
      result.page.finalUrl,
      result.auditSource.fallbackSourceId || result.source.fallbackSourceId || "",
      best?.finalUrl || best?.url || "",
      best?.text || "",
      best?.itemCount ?? "",
      best?.keywordMatchCount ?? "",
      best?.parserStrategy ?? "",
      result.links.map((link) => `${link.text} => ${link.url}`).join(" | "),
      best?.sampleTitles || "",
      result.error || "",
    ].map(escapeCsvCell).join(",");
  });
  return [`\uFEFF${header.join(",")}`, ...rows].join("\r\n");
}

function buildMarkdown(results, outputCsvPath) {
  const counts = results.reduce((acc, result) => {
    acc[result.decision] = (acc[result.decision] ?? 0) + 1;
    return acc;
  }, {});
  const lines = [
    "# 정상 무후보 URL 재검증",
    "",
    `검증 대상: ${results.length}`,
    `CSV: ${outputCsvPath}`,
    "",
    "## 판정별 건수",
    "",
    "| 판정 | 건수 |",
    "|---|---:|",
    ...Object.entries(counts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([decision, count]) => `| ${decision} | ${count} |`),
    "",
    "## 장학 전용 게시판 후보",
    "",
  ];
  const actionable = results.filter((result) =>
    ["better_scholarship_board_found", "empty_scholarship_board_found"].includes(result.decision),
  );
  if (actionable.length === 0) {
    lines.push("장학 전용으로 보이는 parseable board 후보는 발견되지 않았습니다.");
  } else {
    lines.push("| source_id | source_name | 현재 URL | 후보 URL | 후보 링크 | 게시글 | 키워드 |");
    lines.push("|---|---|---|---|---|---:|---:|");
    for (const result of actionable) {
      const best =
        result.evaluatedLinks.find(isActionableScholarshipNoticeBoard) ||
        result.evaluatedLinks.find(
          (link) =>
            link.status === "parseable_board" &&
            link.explicitEmptyStateDetected &&
            isNoticeBoardUrlOrLabel(link),
        );
      lines.push(
        [
          result.source.sourceId,
          result.source.sourceName,
          result.auditSource.listUrl || result.source.listUrl,
          best?.finalUrl || best?.url || "",
          best?.text || "",
          best?.itemCount ?? "",
          best?.keywordMatchCount ?? "",
        ].join(" | ").replace(/^/, "| ").replace(/$/u, " |"),
      );
    }
  }
  return lines.join("\n");
}

async function main() {
  const auditJsonPath = process.argv[2] ?? DEFAULT_AUDIT_JSON_PATH;
  const sourceCsvPath = process.argv[3] ?? DEFAULT_SOURCE_CSV_PATH;
  const outputDir = process.argv[4] ?? DEFAULT_OUTPUT_DIR;
  const audit = JSON.parse(fs.readFileSync(path.resolve(auditJsonPath), "utf8"));
  const sources = readSourceConfig(sourceCsvPath);
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  const validZeroSources = audit.perSource.filter(
    (source) =>
      source.decision === "valid_zero_candidates" &&
      (!SOURCE_ID_PREFIX || cleanText(source.sourceId).toLowerCase().startsWith(SOURCE_ID_PREFIX)) &&
      (SOURCE_ID_ALLOWLIST.size === 0 ||
        SOURCE_ID_ALLOWLIST.has(cleanText(source.sourceId).toLowerCase())),
  );
  const targets = validZeroSources
    .map((auditSource) => ({
      auditSource,
      source: byId.get(auditSource.sourceId),
    }))
    .filter((entry) => entry.source);

  const results = await mapLimit(targets, CONCURRENCY, async ({ source, auditSource }) => {
    const result = await verifySource(source, auditSource);
    console.log(
      `source=${source.sourceId} decision=${result.decision} links=${result.links.length}`,
    );
    return result;
  });

  fs.mkdirSync(path.resolve(outputDir), { recursive: true });
  const runId = audit.runId ?? new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  const suffix = SOURCE_ID_PREFIX ? `-${SOURCE_ID_PREFIX.replace(/[^a-z0-9_-]/giu, "_")}` : "";
  const csvPath = path.join(outputDir, `valid-zero-url-verification-${runId}${suffix}.csv`);
  const latestCsvPath = path.join(outputDir, `valid-zero-url-verification-latest${suffix}.csv`);
  const mdPath = path.join(outputDir, `valid-zero-url-verification-${runId}${suffix}.md`);
  const latestMdPath = path.join(outputDir, `valid-zero-url-verification-latest${suffix}.md`);
  const csv = buildCsvRows(results);
  const markdown = buildMarkdown(results, csvPath);
  fs.writeFileSync(csvPath, csv, "utf8");
  fs.writeFileSync(latestCsvPath, csv, "utf8");
  fs.writeFileSync(mdPath, markdown, "utf8");
  fs.writeFileSync(latestMdPath, markdown, "utf8");

  const counts = results.reduce((acc, result) => {
    acc[result.decision] = (acc[result.decision] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`verification_csv=${csvPath}`);
  console.log(`verification_md=${mdPath}`);
  console.log(JSON.stringify(counts, null, 2));
}

await main();
