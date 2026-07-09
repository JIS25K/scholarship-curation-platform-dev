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
const SEVERITY_RANK = { low: 1, medium: 2, high: 3, unsafe: 4 };
const QUALITY_RANK = { empty: 0, short: 1, synthetic: 2, mixed: 2, full: 3, good: 3 };
const WRITE_TABLES = {
  insert_run: "crawler_runs",
  insert_source_result: "crawler_source_results",
  insert_notice: "crawler_notices",
  update_notice_metadata: "crawler_notices",
  update_notice_body: "crawler_notices",
  skip_update_due_to_low_quality: "crawler_notices",
  skip_update_due_to_source_health: "crawler_notices",
  add_url_alias: "crawler_notice_url_aliases",
  insert_occurrence: "crawler_notice_occurrences",
  insert_notice_target: "crawler_notice_targets",
  insert_asset: "crawler_notice_assets",
  insert_error: "crawler_errors",
  insert_keyword_match: "crawler_keyword_matches",
  skip_missing_detection_due_to_source_health: "crawler_notice_occurrences",
  skip_missing_detection_due_to_pagination: "crawler_notice_occurrences",
  no_op_unchanged: "crawler_notices",
};

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const options = {
    inputPath: DEFAULT_INPUT_PATH,
    previousRunInputPath: "",
    sourceHealthInputPath: "",
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
    } else if (arg === "--previous-run-input") {
      if (!next) throw new Error("--previous-run-input requires a path.");
      options.previousRunInputPath = next;
      index += 1;
    } else if (arg === "--source-health-input") {
      if (!next) throw new Error("--source-health-input requires a path.");
      options.sourceHealthInputPath = next;
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
      throw new Error(`${arg} is not supported. This pre-apply dry-run never writes to DB.`);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/plan-crawler-pre-apply-safety-dry-run.mjs --input <path> [--previous-run-input <path>] [--source-health-input <path>] [--out reports/pre-apply.json] [--json]

Options:
  --input PATH                  Adapted ingest fixture path.
  --previous-run-input PATH     Previous adapted fixture/report for missing visibility dry-run.
  --source-health-input PATH    Optional source health fixture/report.
  --out PATH                    Save full pre-apply report JSON.
  --json                        Print full JSON report.
  --check-db                    Personal-dev read-only DB comparison.
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

function readJson(inputPath, label) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`${label} not found: ${inputPath}`);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function readFixture(inputPath, label = "Input") {
  const parsed = readJson(inputPath, label);
  if (!parsed || !Array.isArray(parsed.sources)) {
    throw new Error(`${label} must contain a sources array.`);
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

function groupBy(values, keyFn) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function increment(object, key, amount = 1) {
  object[key] = (object[key] ?? 0) + amount;
}

function incrementClassification(summary, classification) {
  const key = CLASSIFICATION_SUMMARY_KEYS[classification];
  if (key) increment(summary, key);
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
    source_health_unsafe: 0,
    potentially_missing: 0,
    needs_recheck: 0,
    do_not_mark_deleted: 0,
    write_plan_operations: 0,
    blocked_write_plan_operations: 0,
    review_required_operations: 0,
    item_warnings: 0,
    item_errors: 0,
  };
}

function sourceDiagnosticsFromAdapter(fixture, sourceKey) {
  const diagnostics = fixture.adapter?.source_diagnostics;
  if (!Array.isArray(diagnostics)) return null;
  return diagnostics.find((source) => cleanText(source.source_key).toLowerCase() === sourceKey) ?? null;
}

function bodyQualityRank(value) {
  const quality = cleanText(value).toLowerCase();
  if (quality.includes("empty")) return QUALITY_RANK.empty;
  if (quality.includes("short")) return QUALITY_RANK.short;
  if (quality.includes("full") || quality.includes("detail") || quality.includes("good")) return QUALITY_RANK.good;
  if (quality.includes("synthetic") || quality.includes("mixed")) return QUALITY_RANK.synthetic;
  return QUALITY_RANK.synthetic;
}

function qualityFlagsFor(item) {
  const flags = [];
  const bodyText = cleanText(item.body_text ?? item.body);
  const bodyQuality = cleanText(item.body_quality).toLowerCase();
  const assets = Array.isArray(item.assets) ? item.assets : [];

  if (!bodyText || bodyQuality === "empty") flags.push("empty_body");
  else if (bodyText.length < SHORT_BODY_THRESHOLD || bodyQuality.includes("short")) flags.push("short_body");
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

function severityFor(changeFlags, sourceHealth) {
  let severity = "low";
  const unsafeFlags = ["body_quality_degraded", "source_health_unsafe", "blocked_by_schema"];
  const highFlags = ["body_changed", "content_hash_changed", "asset_url_changed"];
  const mediumFlags = ["title_changed", "published_at_changed", "canonical_url_changed", "asset_count_changed"];

  for (const flag of changeFlags) {
    if (unsafeFlags.includes(flag)) severity = "unsafe";
    else if (highFlags.includes(flag) && SEVERITY_RANK[severity] < SEVERITY_RANK.high) severity = "high";
    else if (mediumFlags.includes(flag) && SEVERITY_RANK[severity] < SEVERITY_RANK.medium) severity = "medium";
  }
  if (sourceHealth && !sourceHealth.safe_for_change_detection) severity = "unsafe";
  return severity;
}

function classifyLocalItem({ requiredMissing, duplicateCanonical, duplicateDiscovered, qualityFlags, sourceHealth }) {
  if (requiredMissing.length > 0) return "blocked_by_missing_required_field";
  if (sourceHealth && sourceHealth.run_quality === "unsafe_for_lifecycle_judgment") return "needs_quality_review";
  if (duplicateCanonical || duplicateDiscovered) return "duplicate_within_input";
  if (qualityFlags.length > 0) return "needs_quality_review";
  return "new_candidate";
}

function sourceItemsFromFixture(fixture) {
  const entries = [];
  for (const source of fixture.sources) {
    const sourceKey = cleanText(source.source_key).toLowerCase();
    const items = Array.isArray(source.items) ? source.items : [];
    for (const [itemIndex, item] of items.entries()) {
      const canonicalUrl = normalizeUrl(item.canonical_url || item.final_url || item.discovered_url);
      const discoveredUrl = normalizeUrl(item.discovered_url || item.notice_url || item.url);
      entries.push({
        sourceKey,
        itemIndex,
        item,
        title: cleanText(item.title),
        canonicalUrl,
        discoveredUrl,
        publishedAt: toDateOrNull(item.published_at || item.posted_at),
        canonicalKey: canonicalKeyFor(sourceKey, item),
        contentHash: contentHashFor(item),
      });
    }
  }
  return entries;
}

function deriveSourceHealth(fixture, options) {
  const explicit = options.sourceHealthInputPath ? readJson(options.sourceHealthInputPath, "Source health input") : null;
  const explicitRows = Array.isArray(explicit?.source_health)
    ? explicit.source_health
    : Array.isArray(explicit?.sources)
      ? explicit.sources
      : [];
  const explicitBySource = new Map(
    explicitRows.map((row) => [cleanText(row.source_key).toLowerCase(), row]),
  );
  const health = [];

  for (const source of fixture.sources) {
    const sourceKey = cleanText(source.source_key).toLowerCase();
    const explicitRow = explicitBySource.get(sourceKey);
    const sourceDiagnostic = sourceDiagnosticsFromAdapter(fixture, sourceKey);
    const items = Array.isArray(source.items) ? source.items : [];
    const warnings = [
      ...(sourceDiagnostic?.warnings ?? []),
      ...(explicitRow?.warnings ?? []),
    ].map(cleanText).filter(Boolean);
    const errors = [
      ...(sourceDiagnostic?.errors ?? []),
      ...(explicitRow?.errors ?? []),
    ].map(cleanText).filter(Boolean);
    const bodyFlags = items.flatMap((item) => qualityFlagsFor(item));
    const counts = {
      fetched_item_count: Number(explicitRow?.counts?.fetched_item_count ?? explicitRow?.fetched_item_count ?? sourceDiagnostic?.crawled_count ?? items.length),
      matched_scholarship_notice_count: Number(explicitRow?.counts?.matched_scholarship_notice_count ?? explicitRow?.matched_scholarship_notice_count ?? sourceDiagnostic?.matched_count ?? items.length),
      output_item_count: Number(explicitRow?.counts?.output_item_count ?? explicitRow?.output_item_count ?? sourceDiagnostic?.output_items ?? items.length),
      detail_fetch_success_count: Number(explicitRow?.counts?.detail_fetch_success_count ?? explicitRow?.detail_fetch_success_count ?? items.filter((item) => cleanText(item.body_text ?? item.body).length >= SHORT_BODY_THRESHOLD).length),
      detail_fetch_failure_count: Number(explicitRow?.counts?.detail_fetch_failure_count ?? explicitRow?.detail_fetch_failure_count ?? 0),
      empty_body_count: Number(explicitRow?.counts?.empty_body_count ?? explicitRow?.empty_body_count ?? bodyFlags.filter((flag) => flag === "empty_body").length),
      short_body_count: Number(explicitRow?.counts?.short_body_count ?? explicitRow?.short_body_count ?? bodyFlags.filter((flag) => flag === "short_body").length),
      no_assets_count: Number(explicitRow?.counts?.no_assets_count ?? explicitRow?.no_assets_count ?? bodyFlags.filter((flag) => flag === "no_assets").length),
      asset_extraction_count: Number(explicitRow?.counts?.asset_extraction_count ?? explicitRow?.asset_extraction_count ?? items.reduce((sum, item) => sum + (Array.isArray(item.assets) ? item.assets.length : 0), 0)),
      timeout_count: Number(explicitRow?.counts?.timeout_count ?? explicitRow?.timeout_count ?? 0),
      http_error_count: Number(explicitRow?.counts?.http_error_count ?? explicitRow?.http_error_count ?? 0),
      selector_mismatch_count: Number(explicitRow?.counts?.selector_mismatch_count ?? explicitRow?.selector_mismatch_count ?? 0),
      warnings_count: warnings.length,
      errors_count: errors.length,
    };
    const paginationIncomplete = Boolean(explicitRow?.pagination_incomplete ?? explicitRow?.counts?.pagination_incomplete);
    const blockedOrCaptcha = Boolean(explicitRow?.blocked_or_captcha ?? explicitRow?.blocked ?? explicitRow?.captcha) ||
      warnings.some((warning) => /captcha|403|blocked/i.test(warning)) ||
      errors.some((error) => /captcha|403|blocked/i.test(error));

    let runQuality = cleanText(explicitRow?.run_quality).toLowerCase();
    if (!runQuality) {
      if (blockedOrCaptcha) runQuality = "blocked";
      else if (counts.timeout_count > 0 || counts.http_error_count > 0) runQuality = "network_failed";
      else if (counts.selector_mismatch_count > 0) runQuality = "selector_mismatch";
      else if (paginationIncomplete) runQuality = "pagination_incomplete";
      else if (counts.fetched_item_count > 0 && counts.output_item_count === 0) runQuality = "degraded";
      else if (counts.empty_body_count > 0 || counts.short_body_count > 0 || counts.no_assets_count > 0) runQuality = "partial";
      else runQuality = "healthy";
    }
    if (explicitRow?.unsafe_for_lifecycle_judgment) runQuality = "unsafe_for_lifecycle_judgment";

    const unsafeQualities = new Set([
      "degraded",
      "blocked",
      "selector_mismatch",
      "network_failed",
      "pagination_incomplete",
      "unsafe_for_lifecycle_judgment",
    ]);
    const safeForChangeDetection = !unsafeQualities.has(runQuality);
    const safeForMissingDetection = runQuality === "healthy" || runQuality === "partial";
    health.push({
      source_key: sourceKey,
      run_quality: runQuality,
      safe_for_change_detection: safeForChangeDetection,
      safe_for_missing_detection: safeForMissingDetection && !paginationIncomplete && !blockedOrCaptcha,
      counts,
      pagination_incomplete: paginationIncomplete,
      blocked_or_captcha: blockedOrCaptcha,
      warnings,
      errors,
    });
  }

  return health;
}

function buildSourceHealthMap(sourceHealth) {
  return new Map(sourceHealth.map((row) => [row.source_key, row]));
}

function makeProvenanceDiagnostics(entries, targetsBySourceKey) {
  const groupsToRecords = (groups) =>
    [...groups.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([key, rows]) => ({
        key,
        count: rows.length,
        source_keys: unique(rows.map((row) => row.sourceKey)),
        canonical_keys: unique(rows.map((row) => row.canonicalKey)),
        titles: unique(rows.map((row) => row.title)).slice(0, 5),
        discovered_urls: unique(rows.map((row) => row.discoveredUrl)).slice(0, 5),
      }));

  const duplicateCanonicalKeys = groupsToRecords(groupBy(entries, (entry) => entry.canonicalKey));
  const duplicateDiscoveredUrls = groupsToRecords(groupBy(entries, (entry) => entry.discoveredUrl));
  const duplicateCanonicalUrls = groupsToRecords(groupBy(entries, (entry) => entry.canonicalUrl));
  const duplicateTitleDateGroups = groupsToRecords(groupBy(entries, (entry) =>
    entry.title && entry.publishedAt ? `${entry.title.toLowerCase()}|${entry.publishedAt}` : "",
  ));
  const crossSourceCandidates = [
    ...duplicateDiscoveredUrls,
    ...duplicateCanonicalUrls,
    ...duplicateTitleDateGroups,
  ].filter((group) => group.source_keys.length > 1);
  const urlAliasCandidates = duplicateCanonicalKeys.filter((group) => group.discovered_urls.length > 1);
  const multiTargetCandidates = entries
    .map((entry) => ({
      source_key: entry.sourceKey,
      canonical_key: entry.canonicalKey,
      target_org_unit_ids: unique(targetsBySourceKey.get(entry.sourceKey) ?? []),
    }))
    .filter((row) => row.target_org_unit_ids.length > 1);
  const occurrenceCandidates = duplicateCanonicalKeys
    .filter((group) => group.count > 1 || group.source_keys.length > 1)
    .map((group) => ({
      canonical_key: group.key,
      occurrence_count: group.count,
      source_keys: group.source_keys,
      discovered_urls: group.discovered_urls,
    }));

  return {
    duplicate_canonical_keys: duplicateCanonicalKeys,
    duplicate_discovered_urls: duplicateDiscoveredUrls,
    duplicate_canonical_urls: duplicateCanonicalUrls,
    duplicate_title_date_groups: duplicateTitleDateGroups,
    cross_source_candidates: crossSourceCandidates,
    url_alias_candidates: urlAliasCandidates,
    multi_target_candidates: multiTargetCandidates,
    occurrence_candidates: occurrenceCandidates,
  };
}

function provenanceFlagsFor(entry, provenanceDiagnostics) {
  const flags = [];
  if (provenanceDiagnostics.duplicate_canonical_keys.some((group) => group.key === entry.canonicalKey)) {
    flags.push("duplicate_canonical_key_within_input");
  }
  if (provenanceDiagnostics.duplicate_discovered_urls.some((group) => group.key === entry.discoveredUrl)) {
    flags.push("duplicate_discovered_url_within_input");
  }
  if (provenanceDiagnostics.duplicate_canonical_urls.some((group) => group.key === entry.canonicalUrl)) {
    flags.push("duplicate_canonical_url_within_input");
  }
  const titleDateKey = entry.title && entry.publishedAt ? `${entry.title.toLowerCase()}|${entry.publishedAt}` : "";
  if (provenanceDiagnostics.duplicate_title_date_groups.some((group) => group.key === titleDateKey)) {
    flags.push("duplicate_title_published_at_group");
  }
  if (provenanceDiagnostics.cross_source_candidates.some((group) => group.canonical_keys.includes(entry.canonicalKey))) {
    flags.push("cross_source_candidate");
  }
  return flags;
}

function operationFor(type, item, reason, options = {}) {
  const blocked = Boolean(options.blocked);
  const requiresReview = Boolean(options.requiresReview);
  return {
    operation: type,
    table: WRITE_TABLES[type] ?? "unknown",
    reason,
    safety_level: options.safetyLevel ?? (blocked ? "blocked" : "dry_run_only"),
    would_write: false,
    blocked,
    blocking_reason: options.blockingReason ?? null,
    source_key: item?.source_key ?? options.sourceKey ?? null,
    canonical_key: item?.canonical_key ?? options.canonicalKey ?? null,
    requires_review: requiresReview,
  };
}

function recommendedActionFor(item) {
  if (item.classification === "blocked_by_missing_required_field") return "fix_required_fields_before_any_apply_design";
  if (item.classification === "blocked_by_schema") return "resolve_source_or_target_before_apply_design";
  if (item.change_flags.includes("unknown_without_db_check")) return "run_personal_dev_read_only_db_check_before_apply_design";
  if (item.change_severity === "unsafe") return "manual_recheck_required";
  if (item.classification === "needs_quality_review") return "review_body_assets_and_source_health";
  if (item.classification === "duplicate_within_input") return "review_provenance_and_occurrence_policy";
  if (item.classification === "unchanged_candidate") return "no_op_unchanged";
  return "review_write_plan_before_guarded_apply_design";
}

function buildWritePlanForItem(item, sourceHealth) {
  const operations = [];
  const unknown = item.change_flags.includes("unknown_without_db_check");
  const unsafeSource = sourceHealth && !sourceHealth.safe_for_change_detection;
  const missingRequired = item.classification === "blocked_by_missing_required_field";
  const lowQuality = item.quality_flags.length > 0 || item.classification === "needs_quality_review";
  const blockingReason = missingRequired
    ? "missing_required_field"
    : unsafeSource
      ? "unsafe_source_health"
      : unknown
        ? "unknown_without_db_check"
        : null;

  operations.push(operationFor("insert_run", item, "run record would be created by a guarded apply path", {
    blocked: unknown,
    blockingReason: unknown ? "unknown_without_db_check" : null,
    requiresReview: true,
  }));
  operations.push(operationFor("insert_source_result", item, "source run result would preserve per-source provenance", {
    blocked: unknown,
    blockingReason: unknown ? "unknown_without_db_check" : null,
    requiresReview: true,
  }));

  if (item.classification === "unchanged_candidate") {
    operations.push(operationFor("no_op_unchanged", item, "existing notice content appears unchanged in read-only comparison"));
  } else if (item.classification === "url_alias_candidate") {
    operations.push(operationFor("add_url_alias", item, "read-only comparison found an existing notice with a new discovered URL alias", {
      requiresReview: true,
    }));
    operations.push(operationFor("insert_occurrence", item, "new source occurrence would preserve discovery provenance", {
      requiresReview: true,
    }));
  } else if (item.classification === "changed_candidate") {
    operations.push(operationFor("update_notice_metadata", item, "metadata changed in read-only comparison", {
      blocked: unsafeSource,
      blockingReason: unsafeSource ? "unsafe_source_health" : null,
      requiresReview: true,
      safetyLevel: unsafeSource ? "blocked" : "requires_guarded_apply_review",
    }));
    operations.push(operationFor("update_notice_body", item, "body or content hash changed in read-only comparison", {
      blocked: unsafeSource || item.change_flags.includes("body_quality_degraded"),
      blockingReason: unsafeSource ? "unsafe_source_health" : item.change_flags.includes("body_quality_degraded") ? "body_quality_degraded" : null,
      requiresReview: true,
      safetyLevel: unsafeSource || item.change_flags.includes("body_quality_degraded") ? "blocked" : "requires_guarded_apply_review",
    }));
  } else {
    operations.push(operationFor("insert_notice", item, "candidate notice could not be applied without further review", {
      blocked: Boolean(blockingReason) || lowQuality,
      blockingReason: blockingReason ?? (lowQuality ? "needs_quality_review" : null),
      requiresReview: true,
      safetyLevel: blockingReason || lowQuality ? "blocked" : "requires_guarded_apply_review",
    }));
  }

  if (lowQuality) {
    operations.push(operationFor("skip_update_due_to_low_quality", item, "body/assets quality is insufficient for automatic update planning", {
      blocked: true,
      blockingReason: "needs_quality_review",
      requiresReview: true,
    }));
  }
  if (unsafeSource) {
    operations.push(operationFor("skip_update_due_to_source_health", item, "source health is unsafe for lifecycle judgment", {
      blocked: true,
      blockingReason: "unsafe_source_health",
      requiresReview: true,
    }));
  }
  operations.push(operationFor("insert_occurrence", item, "occurrence would preserve source/discovered URL provenance", {
    blocked: Boolean(blockingReason),
    blockingReason,
    requiresReview: Boolean(blockingReason),
  }));
  for (const orgUnitId of item.target_org_unit_ids) {
    operations.push(operationFor("insert_notice_target", item, `target org_unit_id=${orgUnitId} would be linked through source target policy`, {
      blocked: Boolean(blockingReason),
      blockingReason,
      requiresReview: Boolean(blockingReason),
    }));
  }
  for (let index = 0; index < item.asset_count; index += 1) {
    operations.push(operationFor("insert_asset", item, "asset reference would be preserved after guarded review", {
      blocked: Boolean(blockingReason),
      blockingReason,
      requiresReview: Boolean(blockingReason),
    }));
  }
  if (item.warnings.length > 0 || item.errors.length > 0) {
    operations.push(operationFor("insert_error", item, "warnings/errors would be recorded for auditability", {
      requiresReview: false,
    }));
  }
  operations.push(operationFor("insert_keyword_match", item, "keyword evidence would be recomputed by a guarded apply path", {
    blocked: Boolean(blockingReason),
    blockingReason,
    requiresReview: Boolean(blockingReason),
  }));
  return operations;
}

function summarizeWritePlan(items, missingDiagnostics) {
  const allOperations = [
    ...items.flatMap((item) => item.write_plan_operations),
    ...missingDiagnostics.do_not_mark_deleted.map((row) =>
      operationFor(
        row.reason === "missing_but_pagination_incomplete"
          ? "skip_missing_detection_due_to_pagination"
          : "skip_missing_detection_due_to_source_health",
        null,
        row.reason,
        {
          blocked: true,
          blockingReason: row.reason,
          requiresReview: true,
          sourceKey: row.source_key,
          canonicalKey: row.canonical_key,
        },
      ),
    ),
  ];
  const operationsByType = {};
  for (const operation of allOperations) increment(operationsByType, operation.operation);
  return {
    db_write_executed: false,
    operations_total: allOperations.length,
    operations_by_type: operationsByType,
    blocked_operations: allOperations.filter((operation) => operation.blocked),
    review_required_operations: allOperations.filter((operation) => operation.requires_review),
    items: items.map((item) => ({
      source_key: item.source_key,
      canonical_key: item.canonical_key,
      classification: item.classification,
      recommended_action: item.recommended_action,
      operations: item.write_plan_operations,
    })),
  };
}

function compareSyntheticPrevious(item, previousItem) {
  const flags = [];
  if (!previousItem) return flags;
  if (item.title && previousItem.title && item.title !== previousItem.title) flags.push("title_changed");
  if (item.published_at && previousItem.published_at && item.published_at !== previousItem.published_at) {
    flags.push("published_at_changed");
  }
  if (item.canonical_url && previousItem.canonical_url && item.canonical_url !== previousItem.canonical_url) {
    flags.push("canonical_url_changed");
  }
  if (item.content_hash && previousItem.content_hash && item.content_hash !== previousItem.content_hash) {
    flags.push("content_hash_changed", "body_changed");
  }
  if (bodyQualityRank(item.body_quality) > bodyQualityRank(previousItem.body_quality)) flags.push("body_quality_improved");
  if (bodyQualityRank(item.body_quality) < bodyQualityRank(previousItem.body_quality)) flags.push("body_quality_degraded");
  if (item.asset_count !== previousItem.asset_count) flags.push("asset_count_changed");
  if (item.asset_url_fingerprint !== previousItem.asset_url_fingerprint) flags.push("asset_url_changed");
  if (item.warning_count !== previousItem.warning_count) flags.push("warning_count_changed");
  if (item.error_count !== previousItem.error_count) flags.push("error_count_changed");
  if (flags.length === 0) flags.push("unchanged_content");
  return flags;
}

function previousSummaryForEntry(entry) {
  const item = entry.item;
  const warnings = Array.isArray(item.warnings) ? item.warnings.map(cleanText).filter(Boolean) : [];
  const errors = Array.isArray(item.errors) ? item.errors.map(cleanText).filter(Boolean) : [];
  return {
    source_key: entry.sourceKey,
    canonical_key: entry.canonicalKey,
    title: entry.title,
    canonical_url: entry.canonicalUrl,
    discovered_url: entry.discoveredUrl,
    published_at: entry.publishedAt,
    body_quality: cleanText(item.body_quality),
    content_hash: entry.contentHash,
    asset_count: Array.isArray(item.assets) ? item.assets.length : 0,
    asset_url_fingerprint: hashText(JSON.stringify((item.assets ?? []).map((asset) => normalizeUrl(asset.source_url))), 20),
    warning_count: warnings.length,
    error_count: errors.length,
  };
}

function makeItemReport(entry, context) {
  const item = entry.item;
  const requiredMissing = missingRequiredFields(item);
  const optionalMissing = optionalMissingFields(item);
  const qualityFlags = qualityFlagsFor(item);
  const warnings = Array.isArray(item.warnings) ? item.warnings.map(cleanText).filter(Boolean) : [];
  const errors = Array.isArray(item.errors) ? item.errors.map(cleanText).filter(Boolean) : [];
  const sourceHealth = context.sourceHealthByKey.get(entry.sourceKey);
  const targetOrgUnitIds = unique(context.targetsBySourceKey.get(entry.sourceKey) ?? []);
  const provenanceFlags = provenanceFlagsFor(entry, context.provenanceDiagnostics);
  const duplicateCanonical = provenanceFlags.includes("duplicate_canonical_key_within_input");
  const duplicateDiscovered = provenanceFlags.includes("duplicate_discovered_url_within_input");
  const changeFlags = ["unknown_without_db_check", ...optionalMissing];

  if (duplicateCanonical) changeFlags.push("duplicate_canonical_key_within_input");
  if (duplicateDiscovered) changeFlags.push("duplicate_discovered_url_within_input");
  if (sourceHealth && !sourceHealth.safe_for_change_detection) changeFlags.push("source_health_unsafe");

  const report = {
    source_key: entry.sourceKey,
    item_index: entry.itemIndex,
    title: entry.title,
    canonical_url: entry.canonicalUrl,
    discovered_url: entry.discoveredUrl,
    published_at: entry.publishedAt,
    body_quality: cleanText(item.body_quality),
    canonical_key: entry.canonicalKey,
    content_hash: entry.contentHash,
    classification: classifyLocalItem({
      requiredMissing,
      duplicateCanonical,
      duplicateDiscovered,
      qualityFlags,
      sourceHealth,
    }),
    change_flags: changeFlags,
    change_severity: "low",
    quality_flags: qualityFlags,
    provenance_flags: provenanceFlags,
    possible_existing_notice_keys: unique([entry.canonicalKey]),
    target_org_unit_ids: targetOrgUnitIds,
    occurrence_policy: provenanceFlags.length > 0 ? "preserve_all_occurrences_review_duplicates" : "insert_or_update_single_source_occurrence",
    recommended_action: "",
    write_plan_operations: [],
    warnings,
    errors,
    missing_required_fields: requiredMissing,
    missing_optional_fields: optionalMissing,
    asset_count: Array.isArray(item.assets) ? item.assets.length : 0,
    asset_url_fingerprint: hashText(JSON.stringify((item.assets ?? []).map((asset) => normalizeUrl(asset.source_url))), 20),
    body_length: cleanText(item.body_text ?? item.body).length,
    warning_count: warnings.length,
    error_count: errors.length,
    db_match: null,
  };
  report.change_severity = severityFor(report.change_flags, sourceHealth);
  return report;
}

function buildMissingVisibilityDiagnostics(options, currentItems, sourceHealthByKey) {
  const diagnostics = {
    enabled: Boolean(options.previousRunInputPath),
    previous_input_path: options.previousRunInputPath ? path.normalize(options.previousRunInputPath) : null,
    still_visible: [],
    potentially_missing: [],
    missing_but_source_fetch_failed: [],
    missing_but_pagination_incomplete: [],
    missing_but_source_blocked: [],
    missing_but_source_degraded: [],
    needs_recheck: [],
    do_not_mark_deleted: [],
    unsafe_to_judge_sources: [],
  };
  if (!options.previousRunInputPath) return diagnostics;

  const previousFixture = readFixture(options.previousRunInputPath, "Previous run input");
  const previousEntries = sourceItemsFromFixture(previousFixture);
  const currentKeys = new Set(currentItems.map((item) => item.canonical_key));
  for (const previous of previousEntries) {
    const currentVisible = currentKeys.has(previous.canonicalKey);
    const sourceHealth = sourceHealthByKey.get(previous.sourceKey);
    const base = {
      source_key: previous.sourceKey,
      canonical_key: previous.canonicalKey,
      title: previous.title,
      discovered_url: previous.discoveredUrl,
      classification: currentVisible ? "still_visible" : "potentially_missing",
      reason: currentVisible ? "seen_in_current_input" : "not_seen_in_current_input",
    };
    if (currentVisible) {
      diagnostics.still_visible.push(base);
      continue;
    }
    if (!sourceHealth) {
      const row = { ...base, classification: "needs_recheck", reason: "missing_current_source_health" };
      diagnostics.needs_recheck.push(row);
      diagnostics.do_not_mark_deleted.push({ ...row, classification: "do_not_mark_deleted" });
      continue;
    }
    if (sourceHealth.run_quality === "network_failed") {
      const row = { ...base, classification: "missing_but_source_fetch_failed", reason: "source_fetch_failed" };
      diagnostics.missing_but_source_fetch_failed.push(row);
      diagnostics.do_not_mark_deleted.push({ ...row, classification: "do_not_mark_deleted" });
    } else if (sourceHealth.run_quality === "pagination_incomplete" || sourceHealth.pagination_incomplete) {
      const row = { ...base, classification: "missing_but_pagination_incomplete", reason: "missing_but_pagination_incomplete" };
      diagnostics.missing_but_pagination_incomplete.push(row);
      diagnostics.do_not_mark_deleted.push({ ...row, classification: "do_not_mark_deleted" });
    } else if (sourceHealth.run_quality === "blocked" || sourceHealth.blocked_or_captcha) {
      const row = { ...base, classification: "missing_but_source_blocked", reason: "missing_but_source_blocked" };
      diagnostics.missing_but_source_blocked.push(row);
      diagnostics.do_not_mark_deleted.push({ ...row, classification: "do_not_mark_deleted" });
    } else if (!sourceHealth.safe_for_missing_detection || sourceHealth.run_quality === "degraded") {
      const row = { ...base, classification: "missing_but_source_degraded", reason: "missing_but_source_degraded" };
      diagnostics.missing_but_source_degraded.push(row);
      diagnostics.needs_recheck.push(row);
      diagnostics.do_not_mark_deleted.push({ ...row, classification: "do_not_mark_deleted" });
    } else {
      diagnostics.potentially_missing.push(base);
      diagnostics.needs_recheck.push({ ...base, classification: "needs_recheck", reason: "requires_consecutive_missing_runs_before_action" });
    }
  }
  diagnostics.unsafe_to_judge_sources = unique(
    diagnostics.do_not_mark_deleted.map((row) => row.source_key),
  ).map((sourceKey) => ({
    source_key: sourceKey,
    run_quality: sourceHealthByKey.get(sourceKey)?.run_quality ?? "unknown",
  }));
  return diagnostics;
}

function buildSourceSummaries(fixture, items, sourceHealth) {
  return fixture.sources.map((source) => {
    const sourceKey = cleanText(source.source_key).toLowerCase();
    const sourceItems = items.filter((item) => item.source_key === sourceKey);
    const health = sourceHealth.find((row) => row.source_key === sourceKey);
    const summary = makeSummary();
    summary.sources = 1;
    summary.input_items = sourceItems.length;
    for (const item of sourceItems) incrementClassification(summary, item.classification);
    summary.unknown_without_db_check = sourceItems.filter((item) => item.change_flags.includes("unknown_without_db_check")).length;
    summary.empty_body = sourceItems.filter((item) => item.quality_flags.includes("empty_body")).length;
    summary.short_body = sourceItems.filter((item) => item.quality_flags.includes("short_body")).length;
    summary.no_assets = sourceItems.filter((item) => item.quality_flags.includes("no_assets")).length;
    summary.source_health_unsafe = health && (!health.safe_for_change_detection || !health.safe_for_missing_detection) ? 1 : 0;
    summary.item_warnings = sourceItems.reduce((sum, item) => sum + item.warnings.length, 0);
    summary.item_errors = sourceItems.reduce((sum, item) => sum + item.errors.length, 0);
    return {
      source_key: sourceKey,
      input_items: sourceItems.length,
      run_quality: health?.run_quality ?? "unknown",
      safe_for_change_detection: Boolean(health?.safe_for_change_detection),
      safe_for_missing_detection: Boolean(health?.safe_for_missing_detection),
      diagnostics: [
        ...((health?.warnings ?? []).map((warning) => `source_warning:${warning}`)),
        ...((health?.errors ?? []).map((error) => `source_error:${error}`)),
      ],
      summary,
    };
  });
}

function buildReport(fixture, options) {
  const targetsBySourceKey = readSourceTargetMap();
  const entries = sourceItemsFromFixture(fixture);
  const sourceHealth = deriveSourceHealth(fixture, options);
  const sourceHealthByKey = buildSourceHealthMap(sourceHealth);
  const provenanceDiagnostics = makeProvenanceDiagnostics(entries, targetsBySourceKey);
  const context = { targetsBySourceKey, sourceHealthByKey, provenanceDiagnostics };
  const items = entries.map((entry) => makeItemReport(entry, context));
  const previousByCanonicalKey = new Map();
  if (options.previousRunInputPath) {
    const previousFixture = readFixture(options.previousRunInputPath, "Previous run input");
    for (const previousEntry of sourceItemsFromFixture(previousFixture)) {
      previousByCanonicalKey.set(previousEntry.canonicalKey, previousSummaryForEntry(previousEntry));
    }
  }
  for (const item of items) {
    const previous = previousByCanonicalKey.get(item.canonical_key);
    if (previous) {
      item.change_flags.push(...compareSyntheticPrevious(item, previous).filter((flag) => flag !== "unchanged_content"));
      if (compareSyntheticPrevious(item, previous).includes("unchanged_content")) item.change_flags.push("unchanged_content");
    }
    item.change_severity = severityFor(item.change_flags, sourceHealthByKey.get(item.source_key));
    item.recommended_action = recommendedActionFor(item);
  }

  const missingVisibilityDiagnostics = buildMissingVisibilityDiagnostics(options, items, sourceHealthByKey);
  for (const item of items) {
    item.write_plan_operations = buildWritePlanForItem(item, sourceHealthByKey.get(item.source_key));
  }
  const writePlan = summarizeWritePlan(items, missingVisibilityDiagnostics);
  const sources = buildSourceSummaries(fixture, items, sourceHealth);
  const summary = makeSummary();
  summary.sources = fixture.sources.length;
  summary.input_items = items.length;
  for (const item of items) incrementClassification(summary, item.classification);
  summary.unknown_without_db_check = items.filter((item) => item.change_flags.includes("unknown_without_db_check")).length;
  summary.empty_body = items.filter((item) => item.quality_flags.includes("empty_body")).length;
  summary.short_body = items.filter((item) => item.quality_flags.includes("short_body")).length;
  summary.no_assets = items.filter((item) => item.quality_flags.includes("no_assets")).length;
  summary.source_health_unsafe = sourceHealth.filter((source) => !source.safe_for_change_detection || !source.safe_for_missing_detection).length;
  summary.potentially_missing = missingVisibilityDiagnostics.potentially_missing.length;
  summary.needs_recheck = missingVisibilityDiagnostics.needs_recheck.length;
  summary.do_not_mark_deleted = missingVisibilityDiagnostics.do_not_mark_deleted.length;
  summary.write_plan_operations = writePlan.operations_total;
  summary.blocked_write_plan_operations = writePlan.blocked_operations.length;
  summary.review_required_operations = writePlan.review_required_operations.length;
  summary.item_warnings = items.reduce((sum, item) => sum + item.warnings.length, 0);
  summary.item_errors = items.reduce((sum, item) => sum + item.errors.length, 0);

  return {
    generated_at: new Date().toISOString(),
    mode: options.checkDb ? "read_only_db_check" : "local_only",
    input_path: path.normalize(options.inputPath),
    previous_run_input_path: options.previousRunInputPath ? path.normalize(options.previousRunInputPath) : null,
    source_health_input_path: options.sourceHealthInputPath ? path.normalize(options.sourceHealthInputPath) : null,
    db_write_executed: false,
    supabase_sql_executed: false,
    crawler_executed: false,
    ok: true,
    summary,
    source_health: sourceHealth,
    sources,
    items,
    provenance_diagnostics: provenanceDiagnostics,
    missing_visibility_diagnostics: missingVisibilityDiagnostics,
    write_plan: writePlan,
    db_check: {
      executed: false,
      db_write_executed: false,
      missing_sources: null,
      missing_source_targets: null,
      notices_checked: null,
      url_aliases_checked: null,
      occurrences_checked: null,
      assets_checked: null,
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

function compareExistingNotice(item, notice, aliases, occurrences, assetRows) {
  const flags = [];
  const title = cleanText(item.title);
  const canonicalUrl = normalizeUrl(item.canonical_url);
  const discoveredUrl = normalizeUrl(item.discovered_url);
  const existingCanonicalUrl = normalizeUrl(notice.canonical_url);
  const existingAliasUrls = new Set(aliases.map((row) => normalizeUrl(row.url)));
  const existingOccurrenceUrls = new Set(occurrences.map((row) => normalizeUrl(row.discovered_url)));

  if (title && title !== cleanText(notice.title)) flags.push("title_changed");
  if (item.published_at && notice.posted_at && item.published_at !== cleanText(notice.posted_at).slice(0, 10)) {
    flags.push("published_at_changed");
  }
  if (item.content_hash && notice.content_hash && item.content_hash !== cleanText(notice.content_hash)) {
    flags.push("content_hash_changed", "body_changed");
  }
  if (canonicalUrl && existingCanonicalUrl && canonicalUrl !== existingCanonicalUrl) flags.push("canonical_url_changed");
  if (discoveredUrl && !existingAliasUrls.has(discoveredUrl) && discoveredUrl !== existingCanonicalUrl) {
    flags.push("discovered_url_alias_added");
  }
  if (discoveredUrl && !existingOccurrenceUrls.has(discoveredUrl)) flags.push("new_occurrence_candidate");
  if (item.asset_count !== assetRows.length) flags.push("asset_count_changed");
  if (flags.length === 0) flags.push("unchanged_content");

  if (flags.includes("discovered_url_alias_added") && flags.length <= 2) {
    return { classification: "url_alias_candidate", change_flags: flags };
  }
  if (flags.length === 1 && flags[0] === "unchanged_content") {
    return { classification: "unchanged_candidate", change_flags: flags };
  }
  return { classification: "changed_candidate", change_flags: flags };
}

function resetComparisonSummary(summary) {
  for (const key of Object.values(CLASSIFICATION_SUMMARY_KEYS)) summary[key] = 0;
  summary.unknown_without_db_check = 0;
  summary.missing_sources = 0;
  summary.missing_source_targets = 0;
}

function refreshReportAfterDbCheck(report) {
  resetComparisonSummary(report.summary);
  for (const item of report.items) {
    incrementClassification(report.summary, item.classification);
    if (item.change_flags.includes("unknown_without_db_check")) increment(report.summary, "unknown_without_db_check");
    item.change_severity = severityFor(item.change_flags, report.source_health.find((source) => source.source_key === item.source_key));
    item.recommended_action = recommendedActionFor(item);
    item.write_plan_operations = buildWritePlanForItem(
      item,
      report.source_health.find((source) => source.source_key === item.source_key),
    );
  }
  report.write_plan = summarizeWritePlan(report.items, report.missing_visibility_diagnostics);
  report.summary.write_plan_operations = report.write_plan.operations_total;
  report.summary.blocked_write_plan_operations = report.write_plan.blocked_operations.length;
  report.summary.review_required_operations = report.write_plan.review_required_operations.length;
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
  const sourceRows = await loadRowsByIn(supabase, "crawler_notice_sources", "source_key,id", "source_key", sourceKeys);
  const sourceIdByKey = new Map(sourceRows.map((row) => [row.source_key, row.id]));
  const sourceIds = unique([...sourceIdByKey.values()]);
  const targetRows = sourceIds.length > 0
    ? await loadRowsByIn(supabase, "crawler_source_targets", "source_id,org_unit_id", "source_id", sourceIds)
    : [];
  const noticeRows = canonicalKeys.length > 0
    ? await loadRowsByIn(
        supabase,
        "crawler_notices",
        "id,canonical_key,canonical_url,title,posted_at,content_hash",
        "canonical_key",
        canonicalKeys,
      )
    : [];
  const noticeByCanonicalKey = new Map(noticeRows.map((row) => [row.canonical_key, row]));
  const aliasRows = urls.length > 0
    ? await loadRowsByIn(supabase, "crawler_notice_url_aliases", "notice_id,source_id,url", "url", urls)
    : [];
  const occurrenceRows = urls.length > 0
    ? await loadRowsByIn(
        supabase,
        "crawler_notice_occurrences",
        "notice_id,source_id,discovered_url,content_hash",
        "discovered_url",
        urls,
      )
    : [];
  const noticeIds = unique([
    ...noticeRows.map((row) => row.id),
    ...aliasRows.map((row) => row.notice_id),
    ...occurrenceRows.map((row) => row.notice_id),
  ]);
  const assetRows = noticeIds.length > 0
    ? await loadRowsByIn(supabase, "crawler_notice_assets", "notice_id,asset_kind,source_url", "notice_id", noticeIds)
    : [];

  const targetSourceIdSet = new Set(targetRows.map((row) => row.source_id));
  const aliasesByNoticeId = groupBy(aliasRows, (row) => row.notice_id);
  const occurrencesByNoticeId = groupBy(occurrenceRows, (row) => row.notice_id);
  const assetsByNoticeId = groupBy(assetRows, (row) => row.notice_id);

  for (const source of report.sources) {
    const sourceId = sourceIdByKey.get(source.source_key);
    if (!sourceId) {
      source.diagnostics.push("missing_db_source");
      report.summary.missing_sources += 1;
    } else if (!targetSourceIdSet.has(sourceId)) {
      source.diagnostics.push("missing_db_source_target");
      report.summary.missing_source_targets += 1;
    }
  }

  for (const item of report.items) {
    item.change_flags = item.change_flags.filter((flag) => flag !== "unknown_without_db_check");
    const source = report.sources.find((row) => row.source_key === item.source_key);
    if (source?.diagnostics.includes("missing_db_source") || source?.diagnostics.includes("missing_db_source_target")) {
      item.classification = "blocked_by_schema";
      item.change_flags.push("blocked_by_schema");
      continue;
    }
    if (item.missing_required_fields.length > 0) {
      item.classification = "blocked_by_missing_required_field";
      continue;
    }
    if (item.classification === "duplicate_within_input" || item.quality_flags.length > 0) continue;

    const notice = noticeByCanonicalKey.get(item.canonical_key);
    if (!notice) {
      item.classification = "new_candidate";
      item.db_match = { matched: false };
      continue;
    }
    const comparison = compareExistingNotice(
      item,
      notice,
      aliasesByNoticeId.get(notice.id) ?? [],
      occurrencesByNoticeId.get(notice.id) ?? [],
      assetsByNoticeId.get(notice.id) ?? [],
    );
    item.classification = comparison.classification;
    item.change_flags.push(...comparison.change_flags);
    item.db_match = {
      matched: true,
      notice_id_present: true,
      alias_count: (aliasesByNoticeId.get(notice.id) ?? []).length,
      occurrence_count: (occurrencesByNoticeId.get(notice.id) ?? []).length,
      asset_count: (assetsByNoticeId.get(notice.id) ?? []).length,
    };
  }

  report.mode = "read_only_db_check";
  report.db_check = {
    executed: true,
    sources_checked: sourceKeys.length,
    source_targets_checked: targetRows.length,
    notices_checked: noticeRows.length,
    url_aliases_checked: aliasRows.length,
    occurrences_checked: occurrenceRows.length,
    assets_checked: assetRows.length,
    missing_sources: sourceKeys.filter((sourceKey) => !sourceIdByKey.has(sourceKey)).length,
    missing_source_targets: sourceKeys.filter((sourceKey) => {
      const sourceId = sourceIdByKey.get(sourceKey);
      return sourceId && !targetSourceIdSet.has(sourceId);
    }).length,
    db_write_executed: false,
  };
  refreshReportAfterDbCheck(report);
}

function printTextReport(report) {
  console.log("pre_apply_safety_dry_run=ok");
  console.log(`mode=${report.mode}`);
  console.log(`db_write_executed=${report.db_write_executed}`);
  console.log(`supabase_sql_executed=${report.supabase_sql_executed}`);
  console.log(`crawler_executed=${report.crawler_executed}`);
  for (const key of [
    "sources",
    "input_items",
    "new_candidates",
    "unchanged_candidates",
    "changed_candidates",
    "url_alias_candidates",
    "duplicates_within_input",
    "needs_quality_review",
    "blocked_by_missing_required_field",
    "blocked_by_schema",
    "unknown_without_db_check",
    "source_health_unsafe",
    "potentially_missing",
    "needs_recheck",
    "do_not_mark_deleted",
    "write_plan_operations",
    "blocked_write_plan_operations",
    "review_required_operations",
  ]) {
    console.log(`${key}=${report.summary[key]}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  validateDbCheckOptions(options);
  const fixture = readFixture(options.inputPath);
  const report = buildReport(fixture, options);
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
