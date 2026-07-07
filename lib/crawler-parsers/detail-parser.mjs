import { load as loadHtml } from "cheerio";

const BODY_SELECTORS = [
  "article",
  "main article",
  "#DivContents",
  ".article-text",
  "#bo_v_con",
  ".board_view .v_con",
  ".board-view-box .fr-view",
  ".board-write-wrap .fr-view",
  ".artclView",
  ".artcl-view",
  ".board-view .content",
  ".board-view .view-content",
  ".view-content",
  ".view_cont",
  ".view-con",
  ".bbs_view",
  ".board_view",
  ".article-body",
  ".article-content",
  ".entry-content",
  ".post-content",
  ".bo_v_con",
  ".text_wrap",
  ".view_text",
  ".view-body",
  ".board-view-content",
  ".board_view_con",
  ".bbs-view-content",
  ".fr-view",
  ".xe_content",
  "#bbs_content",
  "#board_content",
  "#content .content",
  ".content",
  "main",
];

const TITLE_SELECTORS = [
  ".board-view-title-wrap h4",
  ".board-view-title-wrap h3",
  "#bo_v_title",
  "#em_title1",
  ".em_a_wrap_tit",
  ".bbs_view .tit em",
  ".bbs_view .tit strong",
  ".hyu-list-body-item h4",
  "table.tbl-list_new tr:first-child td[colspan]",
  ".board-view-heading .board-view-tit",
  ".board-view-tit",
  ".board-write-wrap .board-write-box dd:first-of-type",
  ".board-write-box dd:first-of-type",
  ".b-top-box .b-title",
  ".b-title",
  ".board_view .v_tit > strong",
  ".board_view .tit",
  ".artclViewTitle",
  ".artcl-view-title",
  ".article-title",
  ".board-view-title",
  ".board_view_title",
  ".view-title",
  ".view_title",
  ".board-title",
  ".board_title",
  ".bbs-title",
  ".subject",
  ".heading",
  ".text_wrap-title",
  "td .txt",
];

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function scoreBody(root, preferred = false) {
  const text = cleanText(root.text());
  if (text.length < 20) return -1;
  const linkText = cleanText(root.find("a").text());
  const linkDensity = Math.min(1, linkText.length / Math.max(1, text.length));
  const paragraphCount = root.find("p, div, td, li").length;
  return text.length * (1 - linkDensity) + Math.min(paragraphCount, 20) * 20 + (preferred ? 500 : 0);
}

function resolveAssetUrl(value, pageUrl) {
  const input = cleanText(value);
  if (!input || /^(?:data|blob):/i.test(input)) return "";
  try {
    const resolved = new URL(input, pageUrl);
    return /^https?:$/.test(resolved.protocol) ? resolved.toString() : "";
  } catch {
    return "";
  }
}

function bestSrcsetCandidate(srcset) {
  const candidates = cleanText(srcset)
    .split(",")
    .map((piece) => piece.trim().split(/\s+/)[0])
    .filter(Boolean);
  return candidates.at(-1) ?? "";
}

function extractImages($, bodyRoot, pageUrl) {
  if (!bodyRoot?.length) return [];
  const seen = new Set();
  const images = [];
  bodyRoot.find("img").each((_, node) => {
    const image = $(node);
    const width = Number.parseInt(image.attr("width") ?? "", 10);
    const height = Number.parseInt(image.attr("height") ?? "", 10);
    if ((Number.isFinite(width) && width <= 2) || (Number.isFinite(height) && height <= 2)) return;
    const rawUrl =
      image.attr("data-original") ||
      image.attr("data-src") ||
      image.attr("data-lazy-src") ||
      bestSrcsetCandidate(image.attr("srcset")) ||
      image.attr("src") ||
      "";
    const url = resolveAssetUrl(rawUrl, pageUrl);
    if (!url || seen.has(url) || /(?:spacer|tracking|pixel|blank\.gif)/i.test(url)) return;
    seen.add(url);
    const figure = image.closest("figure");
    images.push({
      url,
      alt: cleanText(image.attr("alt")),
      caption: cleanText(figure.find("figcaption").first().text()),
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      sourceAttribute:
        image.attr("data-original")
          ? "data-original"
          : image.attr("data-src")
            ? "data-src"
            : image.attr("data-lazy-src")
              ? "data-lazy-src"
              : image.attr("srcset")
                ? "srcset"
                : "src",
    });
  });
  return images;
}

function extractDocumentTitleSegments(value) {
  const title = cleanText(value);
  if (!title) return [];
  const candidates = [];
  const boardReadMatch = title.match(/(?:게시판\s*읽기|게시판읽기|board\s*(?:view|read))\s*\(\s*(.+?)\s*\)\s*(?:\||$)/iu);
  if (boardReadMatch?.[1]) candidates.push(boardReadMatch[1]);
  const parenthesizedSegments = [...title.matchAll(/\(\s*([^()]{8,})\s*\)/gu)];
  for (const match of parenthesizedSegments) candidates.push(match[1]);
  for (const segment of title.split(/\s*(?:\||::| - | – | — )\s*/u)) {
    if (cleanText(segment).length >= 4) candidates.push(segment);
  }
  return [...new Set(candidates.map(cleanText).filter(Boolean))];
}

function extractLabeledTableTitles($) {
  const titles = [];
  $("tr").each((_, node) => {
    const row = $(node);
    const label = cleanText(row.find("th, dt").first().text());
    if (!/^(?:제목|subject|title)$/iu.test(label)) return;
    const value = cleanText(row.find("td, dd").first().text());
    if (value) titles.push(value);
  });
  $("dt").each((_, node) => {
    const label = cleanText($(node).text());
    if (!/^(?:제목|subject|title)$/iu.test(label)) return;
    const value = cleanText($(node).next("dd").first().text());
    if (value) titles.push(value);
  });
  return titles;
}

function normalizeComparableTitle(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findExpectedTitleCandidates($, expectedTitle) {
  const expected = normalizeComparableTitle(expectedTitle);
  if (expected.length < 4) return [];
  const matches = [];
  const selector = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "[class*='title' i]",
    "[class*='subject' i]",
    "[class*='tit' i]",
    "[id*='title' i]",
    "[id*='subject' i]",
    "[id*='tit' i]",
    "table td",
    "table th",
    "dt",
    "dd",
    "strong",
    "p",
  ].join(",");
  $(selector).each((index, node) => {
    if (index > 1500) return false;
    const raw = cleanText($(node).text());
    if (!raw || raw.length > Math.max(320, cleanText(expectedTitle).length * 2.5)) return undefined;
    const candidate = normalizeComparableTitle(raw);
    if (candidate.length < 4) return undefined;
    const exact = candidate === expected;
    const contains = candidate.includes(expected) || expected.includes(candidate);
    if (!exact && !contains) return undefined;
    const lengthRatio = Math.min(candidate.length, expected.length) / Math.max(candidate.length, expected.length);
    if (!exact && lengthRatio < 0.55) return undefined;
    matches.push({ raw, score: (exact ? 2000 : 1000) + lengthRatio * 100 - raw.length / 1000 });
    return undefined;
  });
  return matches
    .sort((left, right) => right.score - left.score)
    .map((match) => match.raw)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 5);
}

function collectTitleCandidates($, source, expectedTitle = "") {
  const candidates = [];
  candidates.push(...findExpectedTitleCandidates($, expectedTitle));
  candidates.push(...extractLabeledTableTitles($));
  for (const selector of TITLE_SELECTORS) candidates.push($(selector).first().text());
  if (source.detailTitleSelector) candidates.push($(source.detailTitleSelector).first().text());
  const openGraphTitle = $('meta[property="og:title"]').attr("content");
  const documentTitle = $("title").first().text();
  candidates.push(
    $("h1, h2, h3").first().text(),
    ...extractDocumentTitleSegments(openGraphTitle),
    openGraphTitle,
    ...extractDocumentTitleSegments(documentTitle),
    documentTitle,
  );
  return [...new Set(candidates.map(cleanText).filter(Boolean))].slice(0, 20);
}

function selectBodyRoot($, source) {
  if (source.detailContentSelector) {
    const configured = $(source.detailContentSelector).first();
    if (configured.length && cleanText(configured.text()).length >= 20) {
      return { root: configured, selector: source.detailContentSelector, configured: true };
    }
  }

  let best = null;
  for (const selector of BODY_SELECTORS) {
    $(selector).each((_, node) => {
      const root = $(node);
      const score = scoreBody(root, selector !== "main" && selector !== ".content");
      if (score >= 0 && (!best || score > best.score)) best = { root, selector, score };
    });
  }
  if (!best) {
    $("section, div, td").each((index, node) => {
      if (index > 500) return false;
      const root = $(node);
      const score = scoreBody(root, false);
      if (score >= 0 && (!best || score > best.score)) best = { root, selector: "heuristic-container", score };
      return undefined;
    });
  }
  if (best) return { root: best.root, selector: best.selector, configured: false };
  return { root: $("body").first(), selector: "body", configured: false };
}

export function parseNoticeDetail(source, html, pageUrl = source.listUrl, options = {}) {
  const $ = loadHtml(String(html ?? ""));
  const titleCandidates = collectTitleCandidates($, source, options.expectedTitle);
  $("script, style, nav, footer, header, aside, noscript").remove();
  const body = selectBodyRoot($, source);
  const content = cleanText(body.root.text());
  const layoutRisk = body.selector === "body" || body.selector === "main" || body.selector === ".content";
  const detailDate = source.detailDateSelector
    ? cleanText($(source.detailDateSelector).first().text())
    : "";
  return {
    title: titleCandidates[0] ?? "",
    titleCandidates,
    content,
    bodyHtml: body.root.html() ?? "",
    bodySelector: body.selector,
    bodyCharCount: content.length,
    bodyQuality: content.length < 80 ? "empty_or_boilerplate" : layoutRisk ? "layout_risk" : "clean",
    detailDate,
    images: extractImages($, body.root, pageUrl),
  };
}
