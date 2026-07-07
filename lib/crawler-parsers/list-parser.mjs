import { load as loadHtml } from "cheerio";
import { extractNoticeUrlFromLinkNode } from "../crawler-adapters/index.mjs";

export const LIST_PARSER_STRATEGIES = Object.freeze({
  CONFIGURED_SELECTOR: "A_CONFIGURED_SELECTOR",
  COMMON_BOARD: "B_COMMON_BOARD",
  HEURISTIC_ANCHOR: "C_HEURISTIC_ANCHOR",
});

const DEFAULT_KEYWORDS = [
  "장학",
  "장학금",
  "학자금",
  "등록금",
  "scholarship",
  "tuition",
  "financial aid",
  "fellowship",
  "grant",
];

const COMMON_BOARD_SELECTORS = [
  "table tbody tr",
  ".board-list li, .board_list li, .bbs-list li, .bbs_list li",
  ".notice-list li, .notice_list li, .noti-list li",
  ".board-item, .board_item, .notice-item, .notice_item",
  ".hyu-list-body-item[role='listitem']",
  ".tb-body > ul.clearfix",
  ".divbox div[style*='height:85px']",
  "article.post, article.notice, article.board-item",
];

const MENU_CONTAINER_SELECTOR = [
  "header",
  "nav",
  "footer",
  "aside",
  ".gnb",
  ".lnb",
  ".snb",
  ".navbar",
  ".navigation",
  ".menu",
  ".breadcrumb",
  ".quick-menu",
  ".footer",
  ".header",
].join(",");

const PAGINATION_SELECTOR = [
  ".pagination",
  ".paging",
  ".paginate",
  ".page-navigation",
  "nav[aria-label*='page' i]",
  "a[href*='page=']",
  "a[href*='pageNo=']",
  "a[href*='pageIndex=']",
].join(",");

const TITLE_CONTAMINATION_PATTERN =
  /\b(?:views?|hits?|writer|author|created|updated|period|department)\b|조회\s*\d+|작성일|등록일|담당부서/iu;
const TITLE_DATE_RANGE_PATTERN = /\d{4}[./-]\d{1,2}[./-]\d{1,2}\s*[~～-]/u;
const MENU_TEXT_PATTERN =
  /^(?:home|login|logout|sitemap|english|view\s*more|more|메인|메인으로\s*이동|홈|로그인|로그아웃|사이트맵|전체|전체메뉴|바로가기|장학안내|이전|다음|목록)$/iu;
const DETAIL_URL_HINT_PATTERN =
  /(?:view|article|board|bbs|notice|post|read|detail|(?:mode|act|action)=view|articleNo=|boardNo=|nttNo=|idx=|no=\d+|wr_id=|b_idx=|seq=|uid=)/i;
const BOARD_META_PATTERN =
  /(?:board|bbs|notice|noti|article|post|subject|title|list|view|wr_|bo_)/i;
const HEURISTIC_CONTEXT_SELECTOR = [
  "tr",
  "li",
  "article",
  ".board-item",
  ".board_item",
  ".notice-item",
  ".notice_item",
  ".post-item",
  ".post_item",
  ".list-item",
  ".list_item",
  ".hyu-list-body-item[role='listitem']",
].join(",");

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function cleanListTitle(value) {
  return cleanText(value)
    .replace(/^(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}\s+)?(?:undergraduate|graduate)\s+/iu, "")
    .replace(/^(?:행사|공지|학사|장학)?\s*새\s*글\s+/u, "")
    .replace(/\s+(?:attach[_ ]?file)$/iu, "")
    .replace(/\s+(?:hits?|views?)\s*\d+\s*(?:updated)?$/iu, "")
    .replace(/\s+new\s+\d{4}[./-]\d{1,2}[./-]\d{1,2}$/iu, "")
    .trim();
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
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      !Number.isNaN(parsed.getTime()) &&
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    ) {
      return parsed;
    }
  }
  return null;
}

function extractDateLikeText($, itemRoot, dateSelector) {
  if (dateSelector) {
    const selected = cleanText(itemRoot.find(dateSelector).first().text());
    if (selected) return selected;
  }
  const candidates = [
    ".date",
    ".board-date",
    ".regdate",
    ".write-date",
    ".created",
    ".time",
    "time",
    "td:last-child",
  ];
  for (const selector of candidates) {
    const value = cleanText(itemRoot.find(selector).first().text());
    if (parseNoticeDate(value)) return value;
  }
  const rootText = cleanText(itemRoot.text());
  const match = rootText.match(/\d{2,4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}/);
  return match?.[0] ?? "";
}

function isPlaceholderHref(value) {
  const href = cleanText(value);
  return !href || /^#(?:\d+)?$/.test(href) || /^javascript:/i.test(href);
}

function requiresManualNetworkEvidence(linkNode) {
  if (!linkNode?.length) return false;
  const href = cleanText(linkNode.attr("href"));
  const onclick = cleanText(linkNode.attr("onclick"));
  return isPlaceholderHref(href) && /\b(?:jf_view|view|goView|open|detail)\s*\(/i.test(onclick);
}

function resolveFormViewUrl($, source, linkNode) {
  if (!linkNode?.length) return "";
  const href = cleanText(linkNode.attr("href"));
  const onclick = cleanText(linkNode.attr("onclick"));
  const script = onclick || (/^javascript:/i.test(href) ? href.replace(/^javascript:/i, "") : "");
  if (!script || /\bjf_view\s*\(/i.test(script)) return "";
  const call = script.match(/\b(view|goView|detail|read)\s*\(\s*['"]?(\d+)['"]?/i);
  if (!call?.[2]) return "";

  const samePageViewForm = $("form")
    .filter((_, node) => {
      const form = $(node);
      return (
        /(?:^|\/)view\.do(?:[?#]|$)/i.test(cleanText(form.attr("action"))) &&
        form.find("input[name='boardId'], input[id='boardId']").length > 0
      );
    })
    .first();
  if (samePageViewForm.length && /(?:^|\/)list\.do(?:[?#]|$)/i.test(source.listUrl)) {
    try {
      const target = new URL(cleanText(samePageViewForm.attr("action")) || "view.do", source.listUrl);
      const list = new URL(source.listUrl);
      for (const [key, value] of list.searchParams.entries()) {
        if (!target.searchParams.has(key)) target.searchParams.set(key, value);
      }
      target.searchParams.set("boardId", call[2]);
      return target.toString();
    } catch {
      // Fall through to the generic form inference path.
    }
  }

  const idFields = [
    "boardId",
    "board_id",
    "articleId",
    "article_id",
    "postId",
    "post_id",
    "p_idx",
    "idx",
    "articleNo",
    "boardNo",
    "nttNo",
    "wr_id",
    "b_idx",
    "seq",
    "uid",
    "no",
  ];
  const handlerPattern = new RegExp(
    `function\\s+${call[1]}\\s*\\(\\s*([A-Za-z_$][\\w$]*)[^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`,
    "i",
  );
  const handler = $("script").text().match(handlerPattern);
  const handlerParameter = handler?.[1] ?? "";
  const handlerBody = handler?.[2] ?? "";
  const explicitFormName = handlerBody.match(/document\.([A-Za-z_$][\w$]*)/)?.[1] ?? "";
  const explicitIdField = handlerParameter
    ? handlerBody.match(
        new RegExp(`\\.([A-Za-z_$][\\w$]*)\\.value\\s*=\\s*${handlerParameter}\\b`, "i"),
      )?.[1] ??
      handlerBody.match(
        new RegExp(
          `\\$\\(\\s*['"]#([A-Za-z_$][\\w$-]*)['"]\\s*\\)\\.val\\(\\s*${handlerParameter}\\b`,
          "i",
        ),
      )?.[1] ??
      ""
    : "";
  const explicitAction = handlerBody.match(/\.action\s*=\s*['"]([^'"]+)['"]/i)?.[1] ?? "";

  let form = explicitFormName ? $(`form[name='${explicitFormName}']`).first() : linkNode.closest("form");
  if (!form.length) {
    form = $("form")
      .filter((_, node) => idFields.some((name) => $(node).find(`input[name='${name}']`).length > 0))
      .first();
  }
  if (!form.length) return "";
  const idField =
    (explicitIdField &&
    (form.find(`input[name='${explicitIdField}']`).length ||
      form.find(`input[id='${explicitIdField}']`).length)
      ? explicitIdField
      : "") || idFields.find((name) => form.find(`input[name='${name}'], input[id='${name}']`).length > 0);
  if (!idField) return "";

  try {
    const action = cleanText(explicitAction || form.attr("action"));
    const target = new URL(action || source.listUrl, source.listUrl);
    form.find("input[type='hidden'][name]").each((_, node) => {
      const input = $(node);
      const name = cleanText(input.attr("name"));
      const value = cleanText(input.attr("value"));
      if (name && value && !/csrf|token|session/i.test(name)) target.searchParams.set(name, value);
    });
    target.searchParams.set(idField, call[2]);
    if (form.find("input[name='p_mode']").length) target.searchParams.set("p_mode", "view");
    else if (form.find("input[name='mode']").length) target.searchParams.set("mode", "view");
    return target.toString();
  } catch {
    return "";
  }
}

function isMenuLikeTitle(title) {
  const normalized = cleanText(title);
  return normalized.length <= 1 || MENU_TEXT_PATTERN.test(normalized);
}

function classifyListTitleQuality({ listTitle, rawListText, titleNode, linkNode }) {
  const title = cleanText(listTitle);
  if (!title) return "missing";
  const raw = cleanText(rawListText);
  const titleFromAnchor = linkNode?.length && cleanListTitle(linkNode.text()) === title;
  const titleFromDedicatedNode = titleNode?.length && cleanListTitle(titleNode.text()) === title;
  const rawLongerThanTitle = raw.length > title.length + 60;
  if (TITLE_CONTAMINATION_PATTERN.test(title)) return "contaminated";
  if (TITLE_DATE_RANGE_PATTERN.test(title) && !titleFromAnchor && !titleFromDedicatedNode) {
    return "contaminated";
  }
  if (!titleFromAnchor && !titleFromDedicatedNode && rawLongerThanTitle) return "contaminated";
  if (title.length > 160 && rawLongerThanTitle) return "contaminated";
  return "clean";
}

function hasBoardEvidence($, root, linkNode, title, dateText, strategyId) {
  if (strategyId === LIST_PARSER_STRATEGIES.CONFIGURED_SELECTOR) return true;
  const rootName = root.get(0)?.tagName?.toLowerCase() ?? "";
  const rootText = cleanText(root.text());
  const meta = cleanText(
    [
      root.attr("class"),
      root.attr("id"),
      root.parent().attr("class"),
      root.parent().attr("id"),
      linkNode?.attr("class"),
      linkNode?.attr("id"),
      linkNode?.attr("href"),
      linkNode?.attr("onclick"),
    ].join(" "),
  );
  if (parseNoticeDate(dateText) || parseNoticeDate(rootText) || parseNoticeDate(title)) return true;
  if (BOARD_META_PATTERN.test(meta)) return true;
  if (["tr", "li"].includes(rootName) && root.find("td, th").length >= 2) return true;
  return DETAIL_URL_HINT_PATTERN.test(cleanText(linkNode?.attr("href")));
}

function isLikelyDetailUrl(value) {
  const input = cleanText(value);
  if (!input) return false;
  if (/(?:[?&](?:article_?no|article_?id|board_?no|board_?id|ntt_?no|idx|no|wr_id|b_idx|seq|uid|p_idx|post_id|id)=\d+|[?&](?:mode|p_mode|mod|act|action)=(?:view|read|detail|document))/i.test(input)) {
    return true;
  }
  if (/\/main\/view\.do(?:[?#]|$)/i.test(input)) return false;
  if (/(?:\/|_)(?:view|read|detail)(?:\.|\/|_|[?#]|$)/i.test(input)) return true;
  try {
    const url = new URL(input);
    const keys = [...url.searchParams.keys()].map((key) => key.toLowerCase());
    const hasIdentityParameter = keys.some((key) =>
      /(?:^|_)(?:article_?no|article_?id|board_?no|board_?id|ntt_?no|message_?id|idx|no|wr_id|b_idx|seq|uid|p_idx|post_id|id)$/i.test(key),
    );
    const viewMode = ["mode", "p_mode", "mod", "act", "action"].some((key) =>
      /^(?:view|read|detail|document)$/i.test(url.searchParams.get(key) ?? ""),
    );
    if (hasIdentityParameter || viewMode) return true;
    if (/\/main\/view\.do$/i.test(url.pathname)) return false;
    return /(?:\/|_)(?:view|read|detail)(?:\.|\/|_|$)/i.test(url.pathname) ||
      /\/\d{4}\/\d{1,2}\/\d{1,2}\//.test(url.pathname);
  } catch {
    return false;
  }
}

function hasStrongHeuristicEvidence(root, linkNode, title, dateText, noticeUrl) {
  if (!isLikelyDetailUrl(noticeUrl)) return false;
  const rootName = root.get(0)?.tagName?.toLowerCase() ?? "";
  const rootText = cleanText(root.text());
  if (parseNoticeDate(dateText) || parseNoticeDate(rootText) || parseNoticeDate(title)) return true;
  if (rootName === "tr" && root.find("td, th").length >= 2) return true;
  const meta = cleanText(
    [
      root.attr("class"),
      root.attr("id"),
      root.parent().attr("class"),
      linkNode?.attr("class"),
      linkNode?.attr("id"),
    ].join(" "),
  );
  return BOARD_META_PATTERN.test(meta) && cleanText(title).length >= 4;
}

function isSamePageCategoryUrl(noticeUrl, listUrl) {
  try {
    const target = new URL(noticeUrl);
    const list = new URL(listUrl);
    if (target.origin !== list.origin || target.pathname !== list.pathname) return false;
    if (isLikelyDetailUrl(noticeUrl)) return false;
    return [...target.searchParams.keys()].some((key) =>
      /(?:category|cate|gubun|filter|search(?:type|kind|gubun)?)/i.test(key),
    );
  } catch {
    return false;
  }
}

function getTitleNode(root, source) {
  if (!root?.length || !source.titleSelector) return null;
  const direct = root.is(source.titleSelector) ? root : root.find(source.titleSelector).first();
  return direct.length ? direct : null;
}

function getLinkNode(root, source) {
  if (!root?.length) return null;
  if (root.is("a[href], a[onclick], a[data-href], a[data-url], a[data-link]")) return root;
  if (source.linkSelector) {
    const configured = root.find(source.linkSelector);
    if (configured.length === 1) return configured.first();
  }
  const links = root.find("a[href], a[onclick], a[data-href], a[data-url], a[data-link]");
  if (!links.length) return null;
  let best = null;
  links.each((index) => {
    const link = links.eq(index);
    const href = cleanText(link.attr("href"));
    const dataUrl = cleanText(link.attr("data-href") || link.attr("data-url") || link.attr("data-link"));
    const onclick = cleanText(link.attr("onclick"));
    const textLength = cleanText(link.text()).length;
    let score = Math.min(textLength, 40);
    if (isLikelyDetailUrl(href) || isLikelyDetailUrl(dataUrl)) score += 80;
    if (/\b(?:view|goView|jf_view|detail|read)\s*\(/i.test(`${onclick} ${href}`)) score += 80;
    if (isMenuLikeTitle(link.text())) score -= 100;
    if (!best || score > best.score) best = { link, score };
  });
  return best?.link ?? links.first();
}

function createAttempt(strategyId, selector, nodeCount) {
  return {
    strategyId,
    selector,
    nodeCount,
    items: [],
    linkExtractionCount: 0,
    validDetailUrlCount: 0,
    boardEvidenceCount: 0,
    rawNavigationEvidenceCount: 0,
    resolvedDetailUrlCount: 0,
    manualNetworkEvidenceRequiredCount: 0,
    eventUrlEvidenceCount: 0,
    contaminatedCandidateCount: 0,
    contaminatedCandidateLeakCount: 0,
    menuTextCount: 0,
    menuContainerCount: 0,
    patternRejectedCount: 0,
    parsedDateCount: 0,
    keywordMatchCount: 0,
  };
}

function parseNodes($, source, nodes, strategyId, selector, { allowPatternBypass = false } = {}) {
  const attempt = createAttempt(strategyId, selector, nodes.length);
  const seen = new Set();
  const keywords = source.keywords?.length ? source.keywords : DEFAULT_KEYWORDS;
  const pattern = source.noticeUrlPattern ? new RegExp(source.noticeUrlPattern) : null;

  nodes.each((_, node) => {
    const originalRoot = $(node);
    const contextualRoot =
      strategyId === LIST_PARSER_STRATEGIES.HEURISTIC_ANCHOR
        ? originalRoot.closest(HEURISTIC_CONTEXT_SELECTOR).first()
        : null;
    const root = contextualRoot?.length ? contextualRoot : originalRoot;
    const linkNode =
      strategyId === LIST_PARSER_STRATEGIES.HEURISTIC_ANCHOR && originalRoot.is("a")
        ? originalRoot
        : getLinkNode(root, source);
    const configuredTitleNode = getTitleNode(root, source);
    const commonTitleNode = linkNode
      ?.find(
        ".b-title, .board-title, .board_title, .bo_tit, .wr_subject, .list-title, .list_subject, .subject, .article-title, .post-title, .txtTitle, .txt_bx p, .tit_g .tit, .title.notice strong, .tit, h2, h3, h4",
      )
      .first();
    const titleNode = commonTitleNode?.length ? commonTitleNode : configuredTitleNode;
    const rawListText = cleanText(root.text());
    const listTitle = cleanListTitle(titleNode?.text() || linkNode?.text() || "");

    if (root.closest(MENU_CONTAINER_SELECTOR).length || linkNode?.closest(MENU_CONTAINER_SELECTOR).length) {
      attempt.menuContainerCount += 1;
      return;
    }
    if (isMenuLikeTitle(listTitle || rawListText)) {
      attempt.menuTextCount += 1;
      return;
    }

    const dateText = extractDateLikeText($, root, source.dateSelector);
    if (!hasBoardEvidence($, root, linkNode, listTitle, dateText, strategyId)) return;
    attempt.boardEvidenceCount += 1;

    const href = cleanText(linkNode?.attr("href"));
    const onclick = cleanText(linkNode?.attr("onclick"));
    const dataUrl = cleanText(
      linkNode?.attr("data-href") || linkNode?.attr("data-url") || linkNode?.attr("data-link"),
    );
    if (href || onclick || dataUrl) attempt.rawNavigationEvidenceCount += 1;
    if (onclick || dataUrl || /^javascript:/i.test(href)) attempt.eventUrlEvidenceCount += 1;

    const directNoticeUrl = extractNoticeUrlFromLinkNode(source, linkNode);
    const formViewUrl = directNoticeUrl ? "" : resolveFormViewUrl($, source, linkNode);
    const noticeUrl = directNoticeUrl || formViewUrl;
    if (!noticeUrl && requiresManualNetworkEvidence(linkNode)) {
      attempt.manualNetworkEvidenceRequiredCount += 1;
    }
    if (!noticeUrl) return;
    attempt.linkExtractionCount += 1;
    attempt.resolvedDetailUrlCount += 1;
    if (seen.has(noticeUrl) || noticeUrl === source.listUrl) return;
    if (isSamePageCategoryUrl(noticeUrl, source.listUrl)) return;
    if (
      strategyId === LIST_PARSER_STRATEGIES.HEURISTIC_ANCHOR &&
      !hasStrongHeuristicEvidence(root, linkNode, listTitle, dateText, noticeUrl)
    ) {
      return;
    }

    const patternMatched = !pattern || pattern.test(noticeUrl);
    const strongEvidence = hasBoardEvidence($, root, linkNode, listTitle, dateText, strategyId);
    const formViewPatternBypassAllowed = Boolean(formViewUrl) && strongEvidence;
    if (!patternMatched && !((allowPatternBypass || formViewPatternBypassAllowed) && strongEvidence)) {
      attempt.patternRejectedCount += 1;
      return;
    }
    attempt.validDetailUrlCount += 1;

    const listTitleQuality = classifyListTitleQuality({
      listTitle,
      rawListText,
      titleNode,
      linkNode,
    });
    if (listTitleQuality !== "clean") attempt.contaminatedCandidateCount += 1;
    if (!listTitle) return;
    if (listTitleQuality !== "clean") return;

    const parsedDate = parseNoticeDate(dateText) ?? parseNoticeDate(listTitle);
    if (parsedDate) attempt.parsedDateCount += 1;
    const searchableText = cleanText([listTitle, rawListText, dateText].filter(Boolean).join(" ")).toLowerCase();
    const keywordMatched = keywords.some((keyword) => searchableText.includes(cleanText(keyword).toLowerCase()));
    if (keywordMatched) attempt.keywordMatchCount += 1;

    seen.add(noticeUrl);
    attempt.items.push({
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
      title: listTitle,
      listTitle,
      rawListText,
      listTitleQuality,
      titleExtractionEvidence: source.titleSelector
        ? `title_selector:${source.titleSelector}`
        : "anchor_text:first_link",
      dateText,
      parsedDate: parsedDate ? parsedDate.toISOString().slice(0, 10) : "",
      keywordMatched,
      boardEvidence: true,
      contaminatedCandidate: listTitleQuality !== "clean",
      parserStrategy: strategyId,
      noticeUrlPatternMatched: patternMatched,
      urlResolutionMode: directNoticeUrl ? "direct" : "form_view_inferred",
    });
  });

  return attempt;
}

function runConfiguredStrategy($, source) {
  if (!source.listItemSelector) return null;
  const nodes = $(source.listItemSelector);
  return parseNodes(
    $,
    source,
    nodes,
    LIST_PARSER_STRATEGIES.CONFIGURED_SELECTOR,
    source.listItemSelector,
  );
}

function runCommonBoardStrategy($, source) {
  let best = createAttempt(LIST_PARSER_STRATEGIES.COMMON_BOARD, COMMON_BOARD_SELECTORS.join(" | "), 0);
  for (const selector of COMMON_BOARD_SELECTORS) {
    const nodes = $(selector);
    if (!nodes.length) continue;
    const attempt = parseNodes(
      $,
      source,
      nodes,
      LIST_PARSER_STRATEGIES.COMMON_BOARD,
      selector,
      { allowPatternBypass: true },
    );
    if (
      attempt.items.length > best.items.length ||
      (attempt.items.length === best.items.length && attempt.boardEvidenceCount > best.boardEvidenceCount)
    ) {
      best = attempt;
    }
  }
  return best;
}

function runHeuristicAnchorStrategy($, source) {
  const anchors = $("a[href], a[onclick], a[data-href], a[data-url], a[data-link]").filter((_, node) => {
    const link = $(node);
    return !link.closest(MENU_CONTAINER_SELECTOR).length;
  });
  return parseNodes(
    $,
    { ...source, linkSelector: "" },
    anchors,
    LIST_PARSER_STRATEGIES.HEURISTIC_ANCHOR,
    "a[href],a[onclick],a[data-*]",
    { allowPatternBypass: true },
  );
}

export function parseNoticeList(source, html) {
  const $ = loadHtml(String(html ?? ""));
  const explicitEmptyStateText = cleanText(
    $(
      ".no-data_bbs, .no-data, .nodata, .no_data, .empty-list, .empty_list, " +
        "table tbody td[colspan], [class*='no-result' i]",
    )
      .map((_, node) => $(node).text())
      .get()
      .join(" "),
  );
  const explicitEmptyStateDetected =
    /(?:데이터|게시물|공지|검색\s*결과|등록된\s*글).{0,15}(?:없습니다|없음)|no\s+(?:data|posts?|notices?|results?)/iu.test(
      explicitEmptyStateText,
    );
  const attempts = [];
  const configured = runConfiguredStrategy($, source);
  if (configured) attempts.push(configured);
  if (!configured?.items.length) attempts.push(runCommonBoardStrategy($, source));
  if (!attempts.some((attempt) => attempt.items.length > 0)) {
    attempts.push(runHeuristicAnchorStrategy($, source));
  }

  const selected =
    attempts.find((attempt) => attempt.items.length > 0) ??
    configured ??
    attempts.reduce((best, attempt) =>
      attempt.linkExtractionCount + attempt.boardEvidenceCount >
      best.linkExtractionCount + best.boardEvidenceCount
        ? attempt
        : best,
    attempts[0]);
  const configuredSelectorMatchCount = configured?.nodeCount ?? null;
  const menuContaminationCount = selected.menuTextCount + selected.menuContainerCount;
  const menuContaminationRate =
    selected.nodeCount > 0 ? Number((menuContaminationCount / selected.nodeCount).toFixed(4)) : 0;
  const menuContaminationDetected =
    selected.nodeCount > 0 &&
    menuContaminationCount >= 3 &&
    (selected.items.length === 0 || selected.contaminatedCandidateLeakCount > 0) &&
    menuContaminationRate >= 0.2;

  return {
    items: selected.items,
    attempts: attempts.map((attempt) => ({
      strategyId: attempt.strategyId,
      selector: attempt.selector,
      nodeCount: attempt.nodeCount,
      itemCount: attempt.items.length,
      linkExtractionCount: attempt.linkExtractionCount,
      validDetailUrlCount: attempt.validDetailUrlCount,
      patternRejectedCount: attempt.patternRejectedCount,
    })),
    metrics: {
      parserStrategy: selected.strategyId,
      parserRecovered:
        selected.items.length > 0 &&
        selected.strategyId !== LIST_PARSER_STRATEGIES.CONFIGURED_SELECTOR,
      configuredSelectorMatchCount,
      listDomItemCount: selected.nodeCount,
      selectorMatches: Object.fromEntries(
        attempts.map((attempt) => [attempt.selector, attempt.nodeCount]),
      ),
      fallbackScanUsed:
        !source.listItemSelector ||
        selected.strategyId !== LIST_PARSER_STRATEGIES.CONFIGURED_SELECTOR,
      fallbackAnchorCount: $("a[href]").length,
      boardEvidenceCount: selected.boardEvidenceCount,
      menuTextCount: selected.menuTextCount,
      menuContainerCount: selected.menuContainerCount,
      menuContaminationCount,
      menuContaminationRate,
      menuContaminationDetected,
      menuContaminationObserved: $(MENU_CONTAINER_SELECTOR).find("a[href]").length > 0,
      pageMenuContaminationCount: $(MENU_CONTAINER_SELECTOR).find("a[href]").length,
      rawNavigationEvidenceCount: selected.rawNavigationEvidenceCount,
      resolvedDetailUrlCount: selected.resolvedDetailUrlCount,
      linkExtractionCount: selected.linkExtractionCount,
      validDetailUrlCount: selected.validDetailUrlCount,
      manualNetworkEvidenceRequiredCount: selected.manualNetworkEvidenceRequiredCount,
      eventUrlEvidenceCount: selected.eventUrlEvidenceCount,
      contaminatedCandidateCount: selected.contaminatedCandidateCount,
      contaminatedCandidateLeakCount: selected.contaminatedCandidateLeakCount,
      paginationEvidenceCount: $(PAGINATION_SELECTOR).length > 0 ? 1 : 0,
      titleExtractCount: selected.items.length,
      parsedDateCount: selected.parsedDateCount,
      keywordMatchCount: selected.keywordMatchCount,
      patternRejectedCount: selected.patternRejectedCount,
      explicitEmptyStateDetected,
      explicitEmptyStateText: explicitEmptyStateText.slice(0, 240),
    },
  };
}
