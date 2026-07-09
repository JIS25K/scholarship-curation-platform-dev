import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_INPUT_PATH = "fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json";
const SOURCE_CSV_PATH = "data/notice-sources.csv";
const SHORT_BODY_THRESHOLD = 80;
const CLASSIFICATION_SUMMARY_KEYS = {
  new_candidate: "new_candidates",
  unchanged_candidate: "unchanged_candidates",
  changed_candidate: "changed_candidates",
  url_alias_candidate: "url_alias_candidates",
  duplicate_within_input: "duplicates_within_input",
  needs_quality_review: "needs_quality_review",
  blocked_by_missing_required_field: "blocked_by_missing_required_field",
  blocked_by_schema: "blocked_by_schema",
};

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const options = {
    inputPath: DEFAULT_INPUT_PATH,
    outPath: "",
    json: false,
    checkDb: false,
    personalDevDbConfirmed: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--input") {
      if (!next) throw new Error("--input requires a path.");
      options.inputPath = next;
      index += 1;
    } else if (arg === "--out") {
      if (!next) throw new Error("--out requires a path.");
      options.outPath = next;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check-db") {
      options.checkDb = true;
    } else if (arg === "--yes-i-am-using-personal-dev-db") {
      options.personalDevDbConfirmed = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (["--apply", "--write", "--commit"].includes(arg)) {
      throw new Error(`${arg} is not supported. This lifecycle dry-run never writes to DB.`);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/diagnose-crawler-notice-lifecycle-dry-run.mjs --input fixtures/crawler-ingest-dry-run/adapted-collector-output-sample-sources.json [--out reports/lifecycle-dry-run.json] [--json]

Options:
  --input PATH          Adapted ingest fixture path.
  --out PATH            Save full lifecycle report JSON.
  --json                Print full JSON report.
  --check-db            Personal-dev read-only DB comparison.
  --yes-i-am-using-personal-dev-db
                        Required with --check-db.

Safety:
  No DB write, no SQL execution, no .env loading, no crawler execution, and no
  apply/write/commit mode. --check-db only runs select queries after explicit
  personal-dev guards.
`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        index += 1;
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

function readSourceTargetMap(csvPath = SOURCE_CSV_PATH) {
  const raw = fs.readFileSync(path.resolve(csvPath), "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(raw);
  const [header, ...body] = table;
  const index = Object.fromEntries(header.map((name, columnIndex) => [cleanText(name), columnIndex]));
  for (const column of ["source_id", "org_unit_id"]) {
    if (!(column in index)) throw new Error(`Missing required CSV column: ${column}`);
  }

  const targetsBySourceKey = new Map();
  for (const row of body) {
    if (row.every((cell) => cleanText(cell) === "")) continue;
    const sourceKey = cleanText(row[index.source_id]).toLowerCase();
    const orgUnitIdRaw = cleanText(row[index.org_unit_id]);
    if (!sourceKey || !/^\d+$/.test(orgUnitIdRaw)) continue;
    if (!targetsBySourceKey.has(sourceKey)) targetsBySourceKey.set(sourceKey, []);
    targetsBySourceKey.get(sourceKey).push(Number(orgUnitIdRaw));
  }
  return targetsBySourceKey;
}

function readFixture(inputPath) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`Input not found: ${inputPath}`);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!parsed || !Array.isArray(parsed.sources)) {
    throw new Error("Input fixture must contain a sources array.");
  }
  return parsed;
}

function normalizeUrl(value) {
  const text = cleanText(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    url.hash = "";
    return url.toString();
  } catch {
    return text;
  }
}

function hashText(value, length = 16) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function toDateOrNull(value) {
  const text = cleanText(value);
  if (!text) return null;
  const head = text.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(head)) return head;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function canonicalKeyFor(sourceKey, item) {
  const nativePostId = cleanText(item.native_post_id);
  if (nativePostId) return `${sourceKey}:native:${nativePostId}`;

  const canonicalUrl = normalizeUrl(item.canonical_url || item.final_url || item.discovered_url);
  if (canonicalUrl) return `${sourceKey}:url:${hashText(canonicalUrl, 20)}`;

  const title = cleanText(item.title).toLowerCase();
  const postedAt = toDateOrNull(item.published_at || item.posted_at) ?? "undated";
  return `${sourceKey}:title-date:${hashText(`${title}|${postedAt}`, 20)}`;
}

function contentHashFor(item) {
  return hashText(
    JSON.stringify({
      title: cleanText(item.title),
      posted_at: toDateOrNull(item.published_at || item.posted_at),
      body_text: cleanText(item.body_text ?? item.body),
    }),
    32,
  );
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function makeSummary() {
  return {
    sources: 0,
    input_items: 0,
    new_candidates: 0,
    unchanged_candidates: 0,
    changed_candidates: 0,
    url_alias_candidates: 0,
    duplicates_within_input: 0,
    needs_quality_review: 0,
    blocked_by_missing_required_field: 0,
    blocked_by_schema: 0,
    unknown_without_db_check: 0,
    missing_sources: 0,
    missing_source_targets: 0,
    empty_body: 0,
    short_body: 0,
    no_assets: 0,
    item_warnings: 0,
    item_errors: 0,
  };
}

function increment(summary, key, amount = 1) {
  summary[key] = (summary[key] ?? 0) + amount;
}

function incrementClassification(summary, classification) {
  const key = CLASSIFICATION_SUMMARY_KEYS[classification];
  if (key) increment(summary, key);
}

function sourceDiagnosticsFromAdapter(fixture, sourceKey) {
  const diagnostics = fixture.adapter?.source_diagnostics;
  if (!Array.isArray(diagnostics)) return null;
  return diagnostics.find((source) => cleanText(source.source_key).toLowerCase() === sourceKey) ?? null;
}

function qualityFlagsFor(item) {
  const flags = [];
  const bodyText = cleanText(item.body_text ?? item.body);
  const bodyQuality = cleanText(item.body_quality).toLowerCase();
  const assets = Array.isArray(item.assets) ? item.assets : [];

  if (!bodyText || bodyQuality === "empty") flags.push("empty_body");
  else if (bodyText.length < SHORT_BODY_THRESHOLD || bodyQuality === "short") flags.push("short_body");
  if (assets.length === 0) flags.push("no_assets");

  return flags;
}

function missingRequiredFields(item) {
  const missing = [];
  if (!cleanText(item.title)) missing.push("missing_title");
  if (!normalizeUrl(item.discovered_url || item.notice_url || item.url)) missing.push("missing_discovered_url");
  return missing;
}

function optionalMissingFields(item) {
  const missing = [];
  if (!normalizeUrl(item.canonical_url || item.final_url)) missing.push("missing_canonical_url");
  if (!toDateOrNull(item.published_at || item.posted_at)) missing.push("missing_published_at");
  return missing;
}

function classifyLocalItem({ requiredMissing, duplicateCanonical, duplicateDiscovered, qualityFlags }) {
  if (requiredMissing.length > 0) return "blocked_by_missing_required_field";
  if (duplicateCanonical || duplicateDiscovered) return "duplicate_within_input";
  if (qualityFlags.length > 0) return "needs_quality_review";
  return "new_candidate";
}

function sourceSummaryFromItems(source, itemReports, sourceDiagnostic, targetsBySourceKey) {
  const sourceKey = cleanText(source.source_key).toLowerCase();
  const sourceSummary = makeSummary();
  sourceSummary.sources = 1;
  sourceSummary.input_items = itemReports.length;
  for (const item of itemReports) incrementClassification(sourceSummary, item.classification);
  sourceSummary.unknown_without_db_check = itemReports.filter((item) =>
    item.change_flags.includes("unknown_without_db_check"),
  ).length;
  sourceSummary.empty_body = itemReports.filter((item) => item.quality_flags.includes("empty_body")).length;
  sourceSummary.short_body = itemReports.filter((item) => item.quality_flags.includes("short_body")).length;
  sourceSummary.no_assets = itemReports.filter((item) => item.quality_flags.includes("no_assets")).length;
  sourceSummary.item_warnings = itemReports.reduce((sum, item) => sum + item.warnings.length, 0);
  sourceSummary.item_errors = itemReports.reduce((sum, item) => sum + item.errors.length, 0);
  if ((targetsBySourceKey.get(sourceKey) ?? []).length === 0) sourceSummary.blocked_by_schema = 1;

  const diagnostics = [];
  if ((targetsBySourceKey.get(sourceKey) ?? []).length === 0) {
    diagnostics.push("missing_local_source_target_mapping");
  }
  for (const warning of sourceDiagnostic?.warnings ?? []) diagnostics.push(`source_warning:${warning}`);
  for (const error of sourceDiagnostic?.errors ?? []) diagnostics.push(`source_error:${error}`);

  return {
    source_key: sourceKey,
    input_items: itemReports.length,
    diagnostics,
    source_warnings: sourceDiagnostic?.warnings ?? [],
    source_errors: sourceDiagnostic?.errors ?? [],
    source_diagnostic: sourceDiagnostic ?? null,
    summary: sourceSummary,
  };
}

function buildLocalReport(fixture, options) {
  const targetsBySourceKey = readSourceTargetMap();
  const allItems = [];
  const sourceEntries = [];

  for (const source of fixture.sources) {
    const sourceKey = cleanText(source.source_key).toLowerCase();
    const items = Array.isArray(source.items) ? source.items : [];
    for (const [itemIndex, item] of items.entries()) {
      const canonicalUrl = normalizeUrl(item.canonical_url || item.final_url || item.discovered_url);
      const discoveredUrl = normalizeUrl(item.discovered_url || item.notice_url || item.url);
      const canonicalKey = canonicalKeyFor(sourceKey, item);
      allItems.push({
        sourceKey,
        itemIndex,
        item,
        canonicalUrl,
        discoveredUrl,
        canonicalKey,
      });
    }
    sourceEntries.push({ source, sourceKey });
  }

  const canonicalCounts = countBy(allItems.map((entry) => entry.canonicalKey));
  const discoveredCounts = countBy(allItems.map((entry) => entry.discoveredUrl).filter(Boolean));
  const sourceItems = new Map();
  const items = [];

  for (const entry of allItems) {
    const requiredMissing = missingRequiredFields(entry.item);
    const optionalMissing = optionalMissingFields(entry.item);
    const duplicateCanonical = (canonicalCounts.get(entry.canonicalKey) ?? 0) > 1;
    const duplicateDiscovered = entry.discoveredUrl && (discoveredCounts.get(entry.discoveredUrl) ?? 0) > 1;
    const qualityFlags = qualityFlagsFor(entry.item);
    const warnings = Array.isArray(entry.item.warnings) ? entry.item.warnings.map(cleanText).filter(Boolean) : [];
    const errors = Array.isArray(entry.item.errors) ? entry.item.errors.map(cleanText).filter(Boolean) : [];
    const changeFlags = ["unknown_without_db_check"];
    if (optionalMissing.length > 0) changeFlags.push(...optionalMissing);
    if (duplicateCanonical) changeFlags.push("duplicate_canonical_key_within_input");
    if (duplicateDiscovered) changeFlags.push("duplicate_discovered_url_within_input");

    const itemReport = {
      source_key: entry.sourceKey,
      item_index: entry.itemIndex,
      title: cleanText(entry.item.title),
      canonical_url: entry.canonicalUrl,
      discovered_url: entry.discoveredUrl,
      published_at: toDateOrNull(entry.item.published_at || entry.item.posted_at),
      canonical_key: entry.canonicalKey,
      content_hash: contentHashFor(entry.item),
      classification: classifyLocalItem({
        requiredMissing,
        duplicateCanonical,
        duplicateDiscovered,
        qualityFlags,
      }),
      quality_flags: qualityFlags,
      change_flags: changeFlags,
      warnings,
      errors,
      missing_required_fields: requiredMissing,
      missing_optional_fields: optionalMissing,
      asset_count: Array.isArray(entry.item.assets) ? entry.item.assets.length : 0,
      body_length: cleanText(entry.item.body_text ?? entry.item.body).length,
      db_match: null,
    };

    items.push(itemReport);
    if (!sourceItems.has(entry.sourceKey)) sourceItems.set(entry.sourceKey, []);
    sourceItems.get(entry.sourceKey).push(itemReport);
  }

  const sources = sourceEntries.map(({ source, sourceKey }) =>
    sourceSummaryFromItems(
      source,
      sourceItems.get(sourceKey) ?? [],
      sourceDiagnosticsFromAdapter(fixture, sourceKey),
      targetsBySourceKey,
    ),
  );

  const summary = makeSummary();
  summary.sources = fixture.sources.length;
  summary.input_items = items.length;
  for (const item of items) incrementClassification(summary, item.classification);
  summary.unknown_without_db_check = items.filter((item) => item.change_flags.includes("unknown_without_db_check")).length;
  summary.empty_body = items.filter((item) => item.quality_flags.includes("empty_body")).length;
  summary.short_body = items.filter((item) => item.quality_flags.includes("short_body")).length;
  summary.no_assets = items.filter((item) => item.quality_flags.includes("no_assets")).length;
  summary.item_warnings = items.reduce((sum, item) => sum + item.warnings.length, 0);
  summary.item_errors = items.reduce((sum, item) => sum + item.errors.length, 0);
  summary.blocked_by_schema = sources.filter((source) => source.diagnostics.includes("missing_local_source_target_mapping")).length;

  return {
    generated_at: new Date().toISOString(),
    mode: options.checkDb ? "read_only_db_check" : "local_only",
    input_path: path.normalize(options.inputPath),
    db_write_executed: false,
    supabase_sql_executed: false,
    crawler_executed: false,
    ok: true,
    summary,
    sources,
    items,
    db_check: {
      executed: false,
      db_write_executed: false,
      missing_sources: null,
      missing_source_targets: null,
      notices_checked: null,
      url_aliases_checked: null,
    },
  };
}

function validateDbCheckOptions(options) {
  if (!options.checkDb) return;

  if (!options.personalDevDbConfirmed) {
    throw new Error("Refusing DB check: --yes-i-am-using-personal-dev-db is required.");
  }

  if (process.env.PERSONAL_DEV_SUPABASE_CONFIRM !== "1") {
    throw new Error("Refusing DB check: PERSONAL_DEV_SUPABASE_CONFIRM=1 is required.");
  }

  if (!process.env.SUPABASE_URL) {
    throw new Error("Refusing DB check: SUPABASE_URL is required.");
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Refusing DB check: SUPABASE_SERVICE_ROLE_KEY is required.");
  }
}

async function loadRowsByIn(supabase, table, columns, columnName, values) {
  const uniqueValues = unique(values);
  const rows = [];
  const pageSize = 100;
  for (let index = 0; index < uniqueValues.length; index += pageSize) {
    const chunk = uniqueValues.slice(index, index + pageSize);
    const { data, error } = await supabase.from(table).select(columns).in(columnName, chunk);
    if (error) throw new Error(`DB read failed for ${table}: ${error.message}`);
    rows.push(...(data ?? []));
  }
  return rows;
}

function compareExistingNotice(item, notice, aliases, assetRows) {
  const changeFlags = [];
  const title = cleanText(item.title);
  const bodyText = cleanText(item.body_text ?? item.body);
  const canonicalUrl = normalizeUrl(item.canonical_url || item.final_url || item.discovered_url);
  const discoveredUrl = normalizeUrl(item.discovered_url || item.notice_url || item.url);
  const existingCanonicalUrl = normalizeUrl(notice.canonical_url);
  const existingAliasUrls = new Set(aliases.map((row) => normalizeUrl(row.url)));

  if (title && title !== cleanText(notice.title)) changeFlags.push("title_changed");
  if (item.content_hash && notice.content_hash && item.content_hash !== cleanText(notice.content_hash)) {
    changeFlags.push("body_changed");
  } else if (bodyText && bodyText !== cleanText(notice.body_text)) {
    changeFlags.push("body_changed");
  }
  if (canonicalUrl && existingCanonicalUrl && canonicalUrl !== existingCanonicalUrl) changeFlags.push("canonical_url_changed");
  if (discoveredUrl && !existingAliasUrls.has(discoveredUrl) && discoveredUrl !== existingCanonicalUrl) {
    changeFlags.push("url_alias_candidate");
  }
  const inputAssetCount = Array.isArray(item.assets) ? item.assets.length : 0;
  if (inputAssetCount !== assetRows.length) changeFlags.push("asset_count_changed");

  if (changeFlags.length === 0) return { classification: "unchanged_candidate", changeFlags };
  if (changeFlags.length === 1 && changeFlags[0] === "url_alias_candidate") {
    return { classification: "url_alias_candidate", changeFlags };
  }
  return { classification: "changed_candidate", changeFlags };
}

function resetDbSensitiveSummary(summary) {
  summary.new_candidates = 0;
  summary.unchanged_candidates = 0;
  summary.changed_candidates = 0;
  summary.url_alias_candidates = 0;
  summary.needs_quality_review = 0;
  summary.blocked_by_missing_required_field = 0;
  summary.blocked_by_schema = 0;
  summary.unknown_without_db_check = 0;
}

function recalculateSummaries(report) {
  resetDbSensitiveSummary(report.summary);
  report.summary.missing_sources = 0;
  report.summary.missing_source_targets = 0;

  for (const item of report.items) incrementClassification(report.summary, item.classification);
  report.summary.unknown_without_db_check = report.items.filter((item) =>
    item.change_flags.includes("unknown_without_db_check"),
  ).length;

  for (const source of report.sources) {
    const items = report.items.filter((item) => item.source_key === source.source_key);
    resetDbSensitiveSummary(source.summary);
    source.summary.input_items = items.length;
    for (const item of items) incrementClassification(source.summary, item.classification);
    source.summary.unknown_without_db_check = items.filter((item) =>
      item.change_flags.includes("unknown_without_db_check"),
    ).length;
    if (source.diagnostics.includes("missing_db_source")) {
      source.summary.blocked_by_schema = 1;
      report.summary.missing_sources += 1;
    }
    if (source.diagnostics.includes("missing_db_source_target")) {
      source.summary.blocked_by_schema = 1;
      report.summary.missing_source_targets += 1;
    }
    report.summary.blocked_by_schema += source.summary.blocked_by_schema;
  }
}

async function addDbCheck(report, options) {
  validateDbCheckOptions(options);
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const sourceKeys = unique(report.sources.map((source) => source.source_key));
  const canonicalKeys = unique(report.items.map((item) => item.canonical_key));
  const urls = unique(report.items.flatMap((item) => [item.canonical_url, item.discovered_url]).filter(Boolean));

  const sourceRows = await loadRowsByIn(
    supabase,
    "crawler_notice_sources",
    "source_key,id",
    "source_key",
    sourceKeys,
  );
  const sourceIdByKey = new Map(sourceRows.map((row) => [row.source_key, row.id]));
  const sourceIds = unique([...sourceIdByKey.values()]);
  const targetRows =
    sourceIds.length > 0
      ? await loadRowsByIn(supabase, "crawler_source_targets", "source_id,org_unit_id", "source_id", sourceIds)
      : [];
  const targetSourceIdSet = new Set(targetRows.map((row) => row.source_id));
  const noticeRows =
    canonicalKeys.length > 0
      ? await loadRowsByIn(
          supabase,
          "crawler_notices",
          "id,canonical_key,canonical_url,title,body_text,content_hash",
          "canonical_key",
          canonicalKeys,
        )
      : [];
  const noticeByCanonicalKey = new Map(noticeRows.map((row) => [row.canonical_key, row]));
  const aliasRows =
    urls.length > 0
      ? await loadRowsByIn(supabase, "crawler_notice_url_aliases", "notice_id,source_id,url", "url", urls)
      : [];
  const noticeIds = unique([
    ...noticeRows.map((row) => row.id),
    ...aliasRows.map((row) => row.notice_id),
  ]);
  const assetRows =
    noticeIds.length > 0
      ? await loadRowsByIn(supabase, "crawler_notice_assets", "notice_id,asset_kind,source_url", "notice_id", noticeIds)
      : [];

  for (const source of report.sources) {
    const sourceId = sourceIdByKey.get(source.source_key);
    if (!sourceId) source.diagnostics.push("missing_db_source");
    else if (!targetSourceIdSet.has(sourceId)) source.diagnostics.push("missing_db_source_target");
  }

  const aliasRowsByNoticeId = new Map();
  for (const row of aliasRows) {
    if (!aliasRowsByNoticeId.has(row.notice_id)) aliasRowsByNoticeId.set(row.notice_id, []);
    aliasRowsByNoticeId.get(row.notice_id).push(row);
  }
  const assetRowsByNoticeId = new Map();
  for (const row of assetRows) {
    if (!assetRowsByNoticeId.has(row.notice_id)) assetRowsByNoticeId.set(row.notice_id, []);
    assetRowsByNoticeId.get(row.notice_id).push(row);
  }

  for (const itemReport of report.items) {
    itemReport.change_flags = itemReport.change_flags.filter((flag) => flag !== "unknown_without_db_check");
    const source = report.sources.find((entry) => entry.source_key === itemReport.source_key);
    const sourceBlocked = source?.diagnostics.includes("missing_db_source") || source?.diagnostics.includes("missing_db_source_target");
    if (sourceBlocked) {
      itemReport.classification = "blocked_by_schema";
      itemReport.change_flags.push("db_source_or_target_missing");
      continue;
    }
    if (itemReport.missing_required_fields.length > 0) {
      itemReport.classification = "blocked_by_missing_required_field";
      continue;
    }
    if (itemReport.classification === "duplicate_within_input") continue;
    if (itemReport.quality_flags.length > 0) {
      itemReport.classification = "needs_quality_review";
      itemReport.change_flags.push("db_comparison_deferred_for_quality");
      continue;
    }

    const notice = noticeByCanonicalKey.get(itemReport.canonical_key);
    if (!notice) {
      itemReport.classification = "new_candidate";
      itemReport.db_match = { matched: false };
      continue;
    }

    const compare = compareExistingNotice(
      {
        title: itemReport.title,
        canonical_url: itemReport.canonical_url,
        discovered_url: itemReport.discovered_url,
        content_hash: itemReport.content_hash,
        body_text: "",
        assets: Array.from({ length: itemReport.asset_count }, () => ({})),
      },
      notice,
      aliasRowsByNoticeId.get(notice.id) ?? [],
      assetRowsByNoticeId.get(notice.id) ?? [],
    );
    itemReport.classification = compare.classification;
    itemReport.change_flags.push(...compare.changeFlags);
    itemReport.db_match = {
      matched: true,
      notice_id_present: true,
      alias_count: (aliasRowsByNoticeId.get(notice.id) ?? []).length,
      asset_count: (assetRowsByNoticeId.get(notice.id) ?? []).length,
    };
  }

  report.mode = "read_only_db_check";
  report.db_check = {
    executed: true,
    sources_checked: sourceKeys.length,
    source_targets_checked: targetRows.length,
    notices_checked: noticeRows.length,
    url_aliases_checked: aliasRows.length,
    assets_checked: assetRows.length,
    missing_sources: sourceKeys.filter((sourceKey) => !sourceIdByKey.has(sourceKey)).length,
    missing_source_targets: sourceKeys.filter((sourceKey) => {
      const sourceId = sourceIdByKey.get(sourceKey);
      return sourceId && !targetSourceIdSet.has(sourceId);
    }).length,
    db_write_executed: false,
  };
  recalculateSummaries(report);
}

function printTextReport(report) {
  console.log("notice_lifecycle_dry_run=ok");
  console.log(`mode=${report.mode}`);
  console.log(`db_write_executed=${report.db_write_executed}`);
  console.log(`supabase_sql_executed=${report.supabase_sql_executed}`);
  console.log(`sources=${report.summary.sources}`);
  console.log(`input_items=${report.summary.input_items}`);
  console.log(`new_candidates=${report.summary.new_candidates}`);
  console.log(`unchanged_candidates=${report.summary.unchanged_candidates}`);
  console.log(`changed_candidates=${report.summary.changed_candidates}`);
  console.log(`url_alias_candidates=${report.summary.url_alias_candidates}`);
  console.log(`duplicates_within_input=${report.summary.duplicates_within_input}`);
  console.log(`needs_quality_review=${report.summary.needs_quality_review}`);
  console.log(`blocked_by_missing_required_field=${report.summary.blocked_by_missing_required_field}`);
  console.log(`blocked_by_schema=${report.summary.blocked_by_schema}`);
  console.log(`unknown_without_db_check=${report.summary.unknown_without_db_check}`);
  console.log(`missing_sources=${report.summary.missing_sources}`);
  console.log(`missing_source_targets=${report.summary.missing_source_targets}`);
  console.log(`empty_body=${report.summary.empty_body}`);
  console.log(`short_body=${report.summary.short_body}`);
  console.log(`no_assets=${report.summary.no_assets}`);
  console.log(`item_warnings=${report.summary.item_warnings}`);
  console.log(`item_errors=${report.summary.item_errors}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  validateDbCheckOptions(options);
  const fixture = readFixture(options.inputPath);
  const report = buildLocalReport(fixture, options);
  if (options.checkDb) await addDbCheck(report, options);

  if (options.outPath) {
    const outPath = path.resolve(options.outPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printTextReport(report);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
