import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REQUIRED_MINIMAL_OPERATIONS = [
  "insert_run",
  "insert_source_result",
  "insert_notice",
  "insert_occurrence",
  "insert_notice_target",
  "insert_error",
];

const OPERATION_TABLES = {
  insert_run: "crawler_runs",
  insert_source_result: "crawler_source_results",
  insert_notice: "crawler_notices",
  add_url_alias: "crawler_notice_url_aliases",
  insert_occurrence: "crawler_notice_occurrences",
  insert_notice_target: "crawler_notice_targets",
  insert_notice_asset: "crawler_notice_assets",
  insert_error: "crawler_errors",
  insert_keyword_match: "crawler_keyword_matches",
};

const DEPENDENCIES = {
  insert_source_result: ["insert_run"],
  insert_notice: ["insert_run", "insert_source_result"],
  add_url_alias: ["insert_notice"],
  insert_occurrence: ["insert_run", "insert_source_result", "insert_notice"],
  insert_notice_target: ["insert_notice"],
  insert_notice_asset: ["insert_notice", "insert_occurrence"],
  insert_error: ["insert_run", "insert_source_result"],
  insert_keyword_match: ["insert_notice"],
};

const SCHEMA_SQL_PATH = "sql/create-crawler-normalized-schema-v2.sql";
const EXECUTOR_UPSERT_CONFLICT_TARGETS = {
  crawler_notices: "canonical_key",
  crawler_notice_url_aliases: "notice_id,url_hash",
  crawler_notice_occurrences: "source_id,discovered_url_hash",
  crawler_notice_targets: "notice_id,org_unit_id",
  crawler_notice_assets: "notice_id,asset_kind,source_url_hash",
};
const EXPECTED_UPSERT_CONFLICT_TARGETS = {
  crawler_notices: "canonical_key",
  crawler_notice_url_aliases: "notice_id,url_hash",
  crawler_notice_occurrences: "source_id,discovered_url_hash",
  crawler_notice_targets: "notice_id,org_unit_id",
  crawler_notice_assets: "notice_id,asset_kind,source_url_hash",
};
const APPLY_WRITE_SEQUENCE = [
  { operation: "insert_run", table: "crawler_runs" },
  { operation: "insert_source_result", table: "crawler_source_results" },
  { operation: "insert_notice", table: "crawler_notices" },
  { operation: "add_url_alias", table: "crawler_notice_url_aliases" },
  { operation: "insert_occurrence", table: "crawler_notice_occurrences" },
  { operation: "insert_notice_target", table: "crawler_notice_targets" },
  { operation: "insert_notice_asset", table: "crawler_notice_assets" },
  { operation: "insert_error", table: "crawler_errors" },
  { operation: "insert_keyword_match", table: "crawler_keyword_matches" },
];

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const options = {
    inputPath: "",
    preApplyReportPath: "",
    sourceKey: "",
    limit: null,
    rehearsalLabel: "",
    outPath: "",
    json: false,
    apply: false,
    personalDevDbConfirmed: false,
    controlledApplyConfirmed: false,
    writeRiskConfirmed: false,
    checkConflicts: false,
    simulateApplyFailureAt: "",
    simulateApplySuccessReport: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--input") {
      if (!next) throw new Error("--input requires a path.");
      options.inputPath = next;
      index += 1;
    } else if (arg === "--pre-apply-report") {
      if (!next) throw new Error("--pre-apply-report requires a path.");
      options.preApplyReportPath = next;
      index += 1;
    } else if (arg === "--source-key") {
      if (!next) throw new Error("--source-key requires a value.");
      options.sourceKey = cleanText(next).toLowerCase();
      index += 1;
    } else if (arg === "--limit") {
      if (!next || !/^\d+$/.test(next)) throw new Error("--limit requires a positive integer.");
      options.limit = Number(next);
      index += 1;
    } else if (arg === "--rehearsal-label") {
      if (!next) throw new Error("--rehearsal-label requires a value.");
      options.rehearsalLabel = cleanText(next);
      index += 1;
    } else if (arg === "--out") {
      if (!next) throw new Error("--out requires a path.");
      options.outPath = next;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--yes-i-am-using-personal-dev-db") {
      options.personalDevDbConfirmed = true;
    } else if (arg === "--yes-run-controlled-sample-apply") {
      options.controlledApplyConfirmed = true;
    } else if (arg === "--i-understand-this-writes-to-personal-dev-db") {
      options.writeRiskConfirmed = true;
    } else if (arg === "--check-conflicts") {
      options.checkConflicts = true;
    } else if (arg === "--simulate-apply-failure-at") {
      if (!next) throw new Error("--simulate-apply-failure-at requires an operation name.");
      options.simulateApplyFailureAt = cleanText(next);
      index += 1;
    } else if (arg === "--simulate-apply-success-report") {
      options.simulateApplySuccessReport = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (["--write", "--commit", "--delete", "--cleanup"].includes(arg)) {
      throw new Error(`${arg} is not supported by this controlled sample apply executor.`);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/apply-crawler-controlled-sample-guarded.mjs --input fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json --pre-apply-report reports/pre-apply.json --source-key yonsei_060 --limit 1 --rehearsal-label controlled-sample-phase1-local --out reports/controlled-sample-apply-plan.json --json

Options:
  --input PATH                              Controlled fixture input.
  --pre-apply-report PATH                   Pre-apply safety report for the same fixture.
  --source-key KEY                          Required source key; phase 1 expects yonsei_060.
  --limit N                                 Required item limit; phase 1 requires exactly 1.
  --rehearsal-label LABEL                   Required deterministic label for audit/cleanup scope.
  --out PATH                                Save JSON report.
  --json                                    Print full JSON report.
  --apply                                   Future-only real write mode.
  --yes-i-am-using-personal-dev-db          Required with --apply.
  --yes-run-controlled-sample-apply         Required with --apply.
  --i-understand-this-writes-to-personal-dev-db
                                            Required with --apply.
  --check-conflicts                         Run local-only schema/upsert conflict preflight.
  --simulate-apply-failure-at OPERATION      Local-only failure report simulation.
  --simulate-apply-success-report            Local-only success report simulation.

Safety:
  Plan-only is the default and never creates a Supabase client. --apply is
  fail-closed behind personal-dev env guards and is not exercised by this phase.
`);
}

function validateApplyGuards(options) {
  if (!options.apply) return;
  if (!options.personalDevDbConfirmed) {
    throw new Error("Refusing controlled sample apply: --yes-i-am-using-personal-dev-db is required.");
  }
  if (!options.controlledApplyConfirmed) {
    throw new Error("Refusing controlled sample apply: --yes-run-controlled-sample-apply is required.");
  }
  if (!options.writeRiskConfirmed) {
    throw new Error("Refusing controlled sample apply: --i-understand-this-writes-to-personal-dev-db is required.");
  }
  if (process.env.PERSONAL_DEV_SUPABASE_CONFIRM !== "1") {
    throw new Error("Refusing controlled sample apply: PERSONAL_DEV_SUPABASE_CONFIRM=1 is required.");
  }
  if (!process.env.SUPABASE_URL) {
    throw new Error("Refusing controlled sample apply: SUPABASE_URL is required.");
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Refusing controlled sample apply: SUPABASE_SERVICE_ROLE_KEY is required.");
  }
  if (!productionGuardPassed()) {
    throw new Error("Refusing controlled sample apply: production/main Supabase indicators are prohibited.");
  }
}

function validateRequiredOptions(options) {
  if (options.simulateApplySuccessReport && !options.inputPath && !options.preApplyReportPath) return;
  if (options.checkConflicts && !options.inputPath && !options.preApplyReportPath) return;
  if (!options.inputPath) throw new Error("--input is required.");
  if (!options.preApplyReportPath) throw new Error("--pre-apply-report is required.");
  if (!options.sourceKey) throw new Error("--source-key is required.");
  if (options.limit === null) throw new Error("--limit is required.");
  if (options.limit !== 1) throw new Error("Refusing controlled sample apply: --limit must be exactly 1 for Roadmap Phase 1 - Gate 1.");
  if (!options.rehearsalLabel) throw new Error("--rehearsal-label is required.");
}

function readJson(inputPath, label) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`${label} not found: ${inputPath}`);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function writeJson(outPath, report) {
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function normalizeConflictTarget(value) {
  return cleanText(value)
    .split(",")
    .map((part) => cleanText(part).replace(/^"|"$/g, ""))
    .filter(Boolean)
    .join(",");
}

function readSchemaConflictTargets(sqlPath = SCHEMA_SQL_PATH) {
  const resolved = path.resolve(sqlPath);
  if (!fs.existsSync(resolved)) throw new Error(`Schema SQL not found: ${sqlPath}`);
  const sql = fs.readFileSync(resolved, "utf8");
  const targets = {};
  const tablePattern = /create table if not exists public\.([a-z0-9_]+)\s*\(([\s\S]*?)\n\);/gi;
  let match;
  while ((match = tablePattern.exec(sql)) !== null) {
    const table = match[1];
    const body = match[2];
    const uniqueMatches = [...body.matchAll(/(?:constraint\s+[a-z0-9_]+\s+)?unique\s*\(([^)]+)\)/gi)];
    const primaryMatches = [...body.matchAll(/primary key\s*\(([^)]+)\)/gi)];
    const candidates = [...uniqueMatches, ...primaryMatches].map((row) => normalizeConflictTarget(row[1]));
    if (candidates.length > 0) targets[table] = candidates;
  }
  return targets;
}

function validateUpsertConflictTargets() {
  const schemaTargets = readSchemaConflictTargets();
  const mismatches = [];
  const checks = Object.entries(EXECUTOR_UPSERT_CONFLICT_TARGETS).map(([table, executorTarget]) => {
    const normalizedExecutorTarget = normalizeConflictTarget(executorTarget);
    const expectedTarget = normalizeConflictTarget(EXPECTED_UPSERT_CONFLICT_TARGETS[table]);
    const schemaTargetCandidates = schemaTargets[table] ?? [];
    const expectedMatched = normalizedExecutorTarget === expectedTarget;
    const schemaMatched = schemaTargetCandidates.includes(normalizedExecutorTarget);
    const check = {
      table,
      executor_target: normalizedExecutorTarget,
      expected_target: expectedTarget,
      schema_targets: schemaTargetCandidates,
      expected_matched: expectedMatched,
      schema_matched: schemaMatched,
      ok: expectedMatched && schemaMatched,
    };
    if (!check.ok) mismatches.push(check);
    return check;
  });

  return {
    mode: "schema_conflict_preflight",
    db_write_executed: false,
    supabase_sql_executed: false,
    real_apply_executed: false,
    ok: mismatches.length === 0,
    schema_sql_path: path.normalize(SCHEMA_SQL_PATH),
    checks,
    mismatches,
  };
}

function buildConflictPreflightReport() {
  return {
    generated_at: new Date().toISOString(),
    ...validateUpsertConflictTargets(),
  };
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

function toDateOrNull(value) {
  const text = cleanText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toDateOnlyOrNull(value) {
  const iso = toDateOrNull(value);
  return iso ? iso.slice(0, 10) : null;
}

function hashText(value, length = 32) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function canonicalKeyFor(sourceKey, item) {
  const nativePostId = cleanText(item.native_post_id);
  if (nativePostId) return `${sourceKey}:native:${nativePostId}`;
  const canonicalUrl = normalizeUrl(item.canonical_url || item.final_url || item.discovered_url);
  if (canonicalUrl) return `${sourceKey}:url:${hashText(canonicalUrl, 20)}`;
  return `${sourceKey}:title-date:${hashText(`${cleanText(item.title).toLowerCase()}|${toDateOnlyOrNull(item.published_at || item.posted_at) ?? "undated"}`, 20)}`;
}

function contentHashFor(item) {
  return hashText(
    JSON.stringify({
      title: cleanText(item.title),
      posted_at: toDateOnlyOrNull(item.published_at || item.posted_at),
      body_text: cleanText(item.body_text ?? item.body),
    }),
    32,
  );
}

function productionGuardPassed() {
  const candidates = [
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PROJECT_REF,
    process.env.SUPABASE_ENV,
    process.env.VERCEL_ENV,
  ].map((value) => cleanText(value).toLowerCase());
  return !candidates.some((value) => /\b(prod|production|main)\b/.test(value));
}

function fixtureSources(fixture) {
  if (!fixture || !Array.isArray(fixture.sources)) {
    throw new Error("Input fixture must contain a sources array.");
  }
  return fixture.sources;
}

function selectedControlledItem(fixture, options) {
  const source = fixtureSources(fixture).find((row) => cleanText(row.source_key).toLowerCase() === options.sourceKey);
  if (!source) throw new Error(`source_key not found in fixture: ${options.sourceKey}`);
  const items = Array.isArray(source.items) ? source.items : [];
  if (items.length !== 1) {
    throw new Error(`Controlled Roadmap Phase 1 - Gate 1 fixture must contain exactly 1 item for ${options.sourceKey}; found ${items.length}.`);
  }
  return { source, item: items[0] };
}

function controlledFixturePassed(item, fixture) {
  const warnings = [
    ...(Array.isArray(item.warnings) ? item.warnings : []),
    ...(Array.isArray(fixture.adapter?.source_diagnostics)
      ? fixture.adapter.source_diagnostics.flatMap((row) => row.warnings ?? [])
      : []),
  ].map(cleanText);
  return warnings.includes("controlled_apply_rehearsal_fixture") ||
    item.metadata?.fixture_kind === "guarded_apply_controlled_sample" ||
    cleanText(item.title).includes("CONTROLLED REHEARSAL FIXTURE");
}

function preApplyItemFor(report, sourceKey, canonicalKey) {
  return (report.items ?? []).find((item) =>
    cleanText(item.source_key).toLowerCase() === sourceKey &&
    cleanText(item.canonical_key) === canonicalKey
  ) ?? null;
}

function preApplySourceHealthFor(report, sourceKey) {
  return (report.source_health ?? []).find((source) => cleanText(source.source_key).toLowerCase() === sourceKey) ?? null;
}

function preApplyDbReadiness(report) {
  const summary = report.summary ?? {};
  const dbCheck = report.db_check ?? {};
  const reasons = [];

  if (report.mode !== "read_only_db_check") reasons.push("read_only_db_check_required");
  if (dbCheck.executed !== true) reasons.push("db_check_not_executed");
  if (report.db_write_executed === true || dbCheck.db_write_executed === true) reasons.push("input_report_db_write_executed_true");
  if (report.supabase_sql_executed === true) reasons.push("input_report_supabase_sql_executed_true");
  if ((summary.missing_sources ?? dbCheck.missing_sources ?? 0) > 0) reasons.push("missing_sources");
  if ((summary.missing_source_targets ?? dbCheck.missing_source_targets ?? 0) > 0) reasons.push("missing_source_targets");
  if ((summary.blocked_by_missing_required_field ?? 0) > 0) reasons.push("blocked_by_missing_required_field");
  if ((summary.blocked_by_schema ?? 0) > 0) reasons.push("blocked_by_schema");
  if ((summary.unknown_without_db_check ?? 0) > 0) reasons.push("unknown_without_db_check");

  return {
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)],
  };
}

function bodyQuality(item, preApplyItem) {
  const quality = cleanText(preApplyItem?.body_quality ?? item.body_quality).toLowerCase();
  const body = cleanText(item.body_text ?? item.body);
  if (!body) return "empty";
  if (quality.includes("short") || body.length < 80) return "short";
  if (quality.includes("full") || quality.includes("good") || body.length >= 80) return "full";
  return quality || "unknown";
}

function itemReadiness(item, preApplyItem, sourceHealth, fixture, dbReadiness) {
  const reasons = [];
  if (!controlledFixturePassed(item, fixture)) reasons.push("controlled_fixture_marker_missing");
  if (!cleanText(item.title)) reasons.push("missing_title");
  if (!normalizeUrl(item.discovered_url || item.notice_url || item.url)) reasons.push("missing_discovered_url");
  if (bodyQuality(item, preApplyItem) !== "full") reasons.push("body_quality_not_full");
  if (!Array.isArray(item.assets) || item.assets.length === 0) reasons.push("asset_required_for_controlled_phase1");
  if (preApplyItem?.classification === "needs_quality_review") reasons.push("needs_quality_review");
  if (preApplyItem?.classification === "blocked_by_missing_required_field") reasons.push("blocked_by_missing_required_field");
  if (preApplyItem?.classification === "blocked_by_schema") reasons.push("blocked_by_schema");
  if (Array.isArray(preApplyItem?.quality_flags) && preApplyItem.quality_flags.length > 0) {
    reasons.push("quality_flags_present");
  }
  if (sourceHealth && (!sourceHealth.safe_for_change_detection || !sourceHealth.safe_for_missing_detection)) {
    reasons.push("source_health_unsafe");
  }
  if (!dbReadiness.ready) reasons.push(...dbReadiness.reasons);
  return {
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)],
  };
}

function planOperations({ options, item, canonicalKey, contentHash, targetOrgUnitIds }) {
  const base = {
    source_key: options.sourceKey,
    canonical_key: canonicalKey,
    rehearsal_label: options.rehearsalLabel,
    would_write: false,
  };
  const operations = [
    {
      operation: "insert_run",
      table: OPERATION_TABLES.insert_run,
      dependencies: [],
      reason: "create run-level audit scope for the controlled rehearsal",
      ...base,
    },
    {
      operation: "insert_source_result",
      table: OPERATION_TABLES.insert_source_result,
      dependencies: DEPENDENCIES.insert_source_result,
      reason: "preserve source-level result linked to the run",
      ...base,
    },
    {
      operation: "insert_notice",
      table: OPERATION_TABLES.insert_notice,
      dependencies: DEPENDENCIES.insert_notice,
      reason: "create or upsert the controlled notice parent",
      title: cleanText(item.title),
      canonical_url: normalizeUrl(item.canonical_url || item.final_url || item.discovered_url),
      content_hash: contentHash,
      ...base,
    },
    {
      operation: "add_url_alias",
      table: OPERATION_TABLES.add_url_alias,
      dependencies: DEPENDENCIES.add_url_alias,
      reason: "preserve canonical/discovered URL alias provenance",
      url: normalizeUrl(item.discovered_url || item.notice_url || item.url),
      ...base,
    },
    {
      operation: "insert_occurrence",
      table: OPERATION_TABLES.insert_occurrence,
      dependencies: DEPENDENCIES.insert_occurrence,
      reason: "record source/run occurrence and discovered URL provenance",
      discovered_url: normalizeUrl(item.discovered_url || item.notice_url || item.url),
      ...base,
    },
    {
      operation: "insert_notice_target",
      table: OPERATION_TABLES.insert_notice_target,
      dependencies: DEPENDENCIES.insert_notice_target,
      reason: "link controlled notice to the source target org unit",
      target_org_unit_ids: targetOrgUnitIds,
      ...base,
    },
    ...((item.assets ?? []).map((asset, index) => ({
      operation: "insert_notice_asset",
      table: OPERATION_TABLES.insert_notice_asset,
      dependencies: DEPENDENCIES.insert_notice_asset,
      reason: "preserve controlled fixture asset reference",
      asset_index: index,
      source_url: normalizeUrl(asset.source_url),
      filename: cleanText(asset.filename),
      ...base,
    }))),
    {
      operation: "insert_error",
      table: OPERATION_TABLES.insert_error,
      dependencies: DEPENDENCIES.insert_error,
      reason: "persist controlled fixture warning evidence for auditability",
      warning_count: Array.isArray(item.warnings) ? item.warnings.length : 0,
      ...base,
    },
    {
      operation: "insert_keyword_match",
      table: OPERATION_TABLES.insert_keyword_match,
      dependencies: DEPENDENCIES.insert_keyword_match,
      reason: "persist deterministic scholarship keyword evidence",
      keyword: "scholarship",
      field: "title",
      ...base,
    },
  ];

  const operationNames = new Set(operations.map((operation) => operation.operation));
  return {
    operations,
    dependencyComplete: REQUIRED_MINIMAL_OPERATIONS.every((operation) => operationNames.has(operation)) &&
      operations.every((operation) => (operation.dependencies ?? []).every((dependency) => operationNames.has(dependency))),
  };
}

function buildReport(fixture, preApplyReport, options) {
  const { item } = selectedControlledItem(fixture, options);
  const canonicalKey = canonicalKeyFor(options.sourceKey, item);
  const contentHash = contentHashFor(item);
  const preApplyItem = preApplyItemFor(preApplyReport, options.sourceKey, canonicalKey);
  const sourceHealth = preApplySourceHealthFor(preApplyReport, options.sourceKey);
  const dbReadiness = preApplyDbReadiness(preApplyReport);
  const targetOrgUnitIds = preApplyItem?.target_org_unit_ids ?? [];
  const itemStatus = itemReadiness(item, preApplyItem, sourceHealth, fixture, dbReadiness);
  const planned = planOperations({ options, item, canonicalKey, contentHash, targetOrgUnitIds });
  const schemaConflictPreflight = validateUpsertConflictTargets();
  const warnings = [];

  if (!dbReadiness.ready) warnings.push("read_only_db_check_required_before_real_apply");
  if (!preApplyItem) warnings.push("pre_apply_item_not_found_for_canonical_key");
  if (targetOrgUnitIds.length === 0) warnings.push("target_org_unit_id_not_available_from_pre_apply_report");
  if (!schemaConflictPreflight.ok) warnings.push("schema_conflict_preflight_failed");

  const planReady = !options.apply && planned.dependencyComplete && controlledFixturePassed(item, fixture);
  const realApplyReady = options.apply && dbReadiness.ready && itemStatus.ready && planned.dependencyComplete && schemaConflictPreflight.ok;
  return {
    generated_at: new Date().toISOString(),
    mode: options.apply ? "apply" : "plan_only",
    db_write_executed: false,
    supabase_sql_executed: false,
    real_apply_executed: false,
    input_path: path.normalize(options.inputPath),
    pre_apply_report_path: path.normalize(options.preApplyReportPath),
    source_key: options.sourceKey,
    limit: options.limit,
    rehearsal_label: options.rehearsalLabel,
    ok: true,
    summary: {
      input_items: 1,
      selected_items: 1,
      planned_operations: planned.operations.length,
      dependency_complete: planned.dependencyComplete,
      blocked_operations: itemStatus.ready ? 0 : planned.operations.length,
      requires_review_operations: options.apply ? 0 : planned.operations.length,
    },
    controlled_fixture: {
      marker_present: controlledFixturePassed(item, fixture),
      canonical_key: canonicalKey,
      body_quality: bodyQuality(item, preApplyItem),
      asset_count: Array.isArray(item.assets) ? item.assets.length : 0,
      missing_required_fields: [
        ...(!cleanText(item.title) ? ["missing_title"] : []),
        ...(!normalizeUrl(item.discovered_url || item.notice_url || item.url) ? ["missing_discovered_url"] : []),
      ],
    },
    pre_apply_report: {
      mode: preApplyReport.mode ?? null,
      db_check_executed: preApplyReport.db_check?.executed ?? false,
      db_write_executed: preApplyReport.db_write_executed ?? false,
      supabase_sql_executed: preApplyReport.supabase_sql_executed ?? false,
      missing_sources: preApplyReport.summary?.missing_sources ?? preApplyReport.db_check?.missing_sources ?? null,
      missing_source_targets: preApplyReport.summary?.missing_source_targets ?? preApplyReport.db_check?.missing_source_targets ?? null,
      unknown_without_db_check: preApplyReport.summary?.unknown_without_db_check ?? null,
    },
    planned_operations: planned.operations,
    schema_conflict_preflight: schemaConflictPreflight,
    guards: {
      apply_requested: options.apply,
      personal_dev_confirmed: options.personalDevDbConfirmed,
      controlled_apply_confirmed: options.controlledApplyConfirmed,
      write_risk_confirmed: options.writeRiskConfirmed,
      personal_dev_env_confirmed: process.env.PERSONAL_DEV_SUPABASE_CONFIRM === "1",
      supabase_url_present: Boolean(process.env.SUPABASE_URL),
      supabase_service_role_key_present: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      production_guard_passed: productionGuardPassed(),
      secret_redaction_passed: true,
      limit_guard_passed: options.limit === 1,
      source_key_guard_passed: Boolean(options.sourceKey),
      rehearsal_label_present: Boolean(options.rehearsalLabel),
    },
    go_no_go: {
      controlled_sample_apply_plan_ready: planReady,
      real_apply_ready: realApplyReady,
      real_apply_executed: false,
      requires_user_approval_before_apply: true,
      reason: realApplyReady
        ? "all guards passed for controlled personal-dev apply"
        : (!schemaConflictPreflight.ok
            ? "schema_conflict_preflight_failed"
            : (dbReadiness.ready ? "plan_only_requires_separate_user_apply_approval" : "read_only_db_check_required")),
      blocking_reasons: [
        ...itemStatus.reasons,
        ...(!schemaConflictPreflight.ok ? ["schema_conflict_preflight_failed"] : []),
      ],
    },
    warnings,
  };
}

function pendingOperationsAfter(completedOperations) {
  const completed = new Set(completedOperations.map((operation) => operation.operation));
  return APPLY_WRITE_SEQUENCE.filter((operation) => !completed.has(operation.operation));
}

async function checked(supabasePromise, label) {
  const { data, error } = await supabasePromise;
  if (error) throw new Error(`${label} failed: ${error.message}`);
  return data;
}

async function checkedStep(supabasePromise, label, step, state) {
  try {
    const data = await checked(supabasePromise, label);
    state.completedOperations.push(step);
    if (step.operation === "insert_run") state.runId = data?.id ?? null;
    if (step.operation === "insert_notice") state.noticeId = data?.id ?? null;
    if (step.operation === "insert_occurrence") state.occurrenceId = data?.id ?? null;
    return data;
  } catch (error) {
    error.failedOperation = step.operation;
    error.failedTable = step.table;
    error.completedOperations = [...state.completedOperations];
    error.pendingOperations = pendingOperationsAfter(state.completedOperations);
    error.runId = state.runId;
    error.noticeId = state.noticeId;
    error.occurrenceId = state.occurrenceId;
    throw error;
  }
}

async function markRunFailed(supabase, state, error, options) {
  if (!state.runId) return false;
  const failureMetadata = {
    rehearsal_label: options.rehearsalLabel,
    controlled_sample: true,
    failed_operation: error.failedOperation ?? "unknown",
    failed_table: error.failedTable ?? "unknown",
    error_message: cleanText(error.message),
    partial_write_possible: true,
  };
  const { error: updateError } = await supabase
    .from("crawler_runs")
    .update({
      ended_at: new Date().toISOString(),
      status: "failed",
      metadata: failureMetadata,
    })
    .eq("id", state.runId);
  if (updateError) {
    error.runStatusUpdateError = updateError.message;
    return false;
  }
  state.runStatusMarkedFailed = true;
  return true;
}

function buildFailureReport({ baseReport, error, options, completedOperations = [], pendingOperations = [] }) {
  const simulated = Boolean(options.simulateApplyFailureAt);
  const completed = completedOperations.length > 0 ? completedOperations : (error.completedOperations ?? []);
  const pending = pendingOperations.length > 0 ? pendingOperations : (error.pendingOperations ?? pendingOperationsAfter(completed));
  return {
    ...baseReport,
    generated_at: new Date().toISOString(),
    ok: false,
    mode: options.simulateApplyFailureAt ? "failure_simulation" : (baseReport?.mode ?? (options.apply ? "apply" : "plan_only")),
    db_write_executed: !simulated && completed.length > 0,
    supabase_sql_executed: !simulated && completed.length > 0,
    real_apply_executed: false,
    failed_operation: error.failedOperation ?? options.simulateApplyFailureAt ?? null,
    failed_table: error.failedTable ?? null,
    error_message: cleanText(error.message),
    partial_write_possible: simulated ? true : (options.apply || completed.length > 0),
    cleanup_required: !simulated && options.apply && completed.length > 0,
    rehearsal_label: options.rehearsalLabel || baseReport?.rehearsal_label || null,
    source_key: options.sourceKey || baseReport?.source_key || null,
    canonical_key: baseReport?.controlled_fixture?.canonical_key ?? null,
    completed_operations: completed,
    pending_operations: pending,
    run_status_marked_failed: Boolean(error.runStatusMarkedFailed),
    run_status_update_error: error.runStatusUpdateError ?? null,
    guards: baseReport?.guards ?? {},
    go_no_go: {
      ...(baseReport?.go_no_go ?? {}),
      real_apply_ready: false,
      real_apply_executed: false,
      reason: options.simulateApplyFailureAt ? "simulated_failure_report" : "apply_failed",
      blocking_reasons: [cleanText(error.message)].filter(Boolean),
    },
  };
}

function simulateApplyFailure(report, options) {
  const step = APPLY_WRITE_SEQUENCE.find((operation) => operation.operation === options.simulateApplyFailureAt);
  if (!step) throw new Error(`Unknown simulated failure operation: ${options.simulateApplyFailureAt}`);
  const completedOperations = [];
  for (const operation of APPLY_WRITE_SEQUENCE) {
    if (operation.operation === step.operation) break;
    completedOperations.push(operation);
  }
  const error = new Error(`Simulated controlled sample apply failure at ${step.operation}.`);
  error.failedOperation = step.operation;
  error.failedTable = step.table;
  return buildFailureReport({
    baseReport: report,
    error,
    options,
    completedOperations,
    pendingOperations: pendingOperationsAfter(completedOperations),
  });
}

function markApplySucceeded(report, result) {
  return {
    ...report,
    ok: true,
    mode: "apply",
    db_write_executed: true,
    supabase_sql_executed: true,
    real_apply_executed: true,
    apply_result: result,
    go_no_go: {
      ...(report.go_no_go ?? {}),
      controlled_sample_apply_plan_ready: true,
      real_apply_ready: true,
      real_apply_executed: true,
      requires_user_approval_before_apply: false,
      reason: "controlled_personal_dev_apply_executed",
      blocking_reasons: [],
    },
  };
}

function buildSimulatedSuccessReport() {
  const report = {
    generated_at: new Date().toISOString(),
    mode: "apply",
    db_write_executed: false,
    supabase_sql_executed: false,
    real_apply_executed: false,
    source_key: "yonsei_060",
    rehearsal_label: "controlled-sample-success-simulation",
    ok: true,
    controlled_fixture: {
      canonical_key: "yonsei_060:url:e74c29f4562cf52025d9",
    },
    guards: {
      apply_requested: false,
      personal_dev_confirmed: false,
      controlled_apply_confirmed: false,
      write_risk_confirmed: false,
      personal_dev_env_confirmed: false,
      supabase_url_present: false,
      supabase_service_role_key_present: false,
      production_guard_passed: true,
      secret_redaction_passed: true,
    },
    go_no_go: {
      controlled_sample_apply_plan_ready: true,
      real_apply_ready: true,
      real_apply_executed: false,
      requires_user_approval_before_apply: false,
      reason: "simulated_success_report_before_marking",
      blocking_reasons: [],
    },
  };
  const marked = markApplySucceeded(report, {
    run_id: "00000000-0000-4000-8000-000000000000",
    notice_id: 0,
    occurrence_id: 0,
    simulated: true,
  });
  return {
    ...marked,
    mode: "success_simulation",
    db_write_executed: false,
    supabase_sql_executed: false,
    real_apply_executed: true,
    simulation: {
      local_only: true,
      db_client_created: false,
      real_db_write_executed: false,
      validates_nested_real_apply_executed: marked.go_no_go.real_apply_executed === true,
    },
  };
}

async function executeApply(report, fixture, options) {
  if (!report.go_no_go.real_apply_ready) {
    throw new Error(`Refusing controlled sample apply: ${report.go_no_go.blocking_reasons.join(", ") || report.go_no_go.reason}`);
  }

  const state = {
    completedOperations: [],
    runId: null,
    noticeId: null,
    occurrenceId: null,
    runStatusMarkedFailed: false,
  };
  let supabase = null;
  try {
  const { createClient } = await import("@supabase/supabase-js");
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { item } = selectedControlledItem(fixture, options);
  const canonicalKey = report.controlled_fixture.canonical_key;
  const discoveredUrl = normalizeUrl(item.discovered_url || item.notice_url || item.url);
  const canonicalUrl = normalizeUrl(item.canonical_url || item.final_url || discoveredUrl);
  const now = new Date().toISOString();

  const source = await checked(
    supabase
      .from("crawler_notice_sources")
      .select("id,source_key")
      .eq("source_key", options.sourceKey)
      .single(),
    "source lookup",
  );
  const run = await checkedStep(
    supabase
      .from("crawler_runs")
      .insert({
        started_at: now,
        ended_at: now,
        mode: "manual",
        status: "succeeded",
        totals: { controlled_sample_items: 1 },
        metadata: {
          rehearsal_label: options.rehearsalLabel,
          controlled_sample: true,
          source_key: options.sourceKey,
        },
      })
      .select("id")
      .single(),
    "crawler_runs insert",
    { operation: "insert_run", table: "crawler_runs" },
    state,
  );

  await checkedStep(
    supabase.from("crawler_source_results").insert({
      run_id: run.id,
      source_id: source.id,
      decision: "controlled_sample_inserted",
      counts: { input_items: 1, selected_items: 1 },
      strategy_code: "controlled_sample_phase1",
      adapter_code: fixture.run?.parser_version ?? "controlled-sample",
      error_count: Array.isArray(item.warnings) ? item.warnings.length : 0,
      metadata: { rehearsal_label: options.rehearsalLabel },
    }),
    "crawler_source_results insert",
    { operation: "insert_source_result", table: "crawler_source_results" },
    state,
  );

  const notice = await checkedStep(
    supabase
      .from("crawler_notices")
      .upsert({
        canonical_key: canonicalKey,
        canonical_url: canonicalUrl,
        native_post_id: cleanText(item.native_post_id) || null,
        title: cleanText(item.title),
        body_text: cleanText(item.body_text ?? item.body),
        body_html: cleanText(item.body_html) || null,
        posted_at: toDateOnlyOrNull(item.published_at || item.posted_at),
        content_hash: contentHashFor(item),
        review_status: "new",
        first_seen_at: now,
        last_seen_at: now,
        metadata: {
          ...(item.metadata ?? {}),
          rehearsal_label: options.rehearsalLabel,
          controlled_sample: true,
        },
      }, { onConflict: EXECUTOR_UPSERT_CONFLICT_TARGETS.crawler_notices })
      .select("id")
      .single(),
    "crawler_notices upsert",
    { operation: "insert_notice", table: "crawler_notices" },
    state,
  );

  await checkedStep(
    supabase.from("crawler_notice_url_aliases").upsert({
      notice_id: notice.id,
      source_id: source.id,
      url: discoveredUrl,
      first_seen_at: now,
      last_seen_at: now,
    }, { onConflict: EXECUTOR_UPSERT_CONFLICT_TARGETS.crawler_notice_url_aliases }),
    "crawler_notice_url_aliases upsert",
    { operation: "add_url_alias", table: "crawler_notice_url_aliases" },
    state,
  );

  const occurrence = await checkedStep(
    supabase
      .from("crawler_notice_occurrences")
      .upsert({
        notice_id: notice.id,
        source_id: source.id,
        crawl_run_id: run.id,
        discovered_url: discoveredUrl,
        final_url: canonicalUrl,
        native_post_id: cleanText(item.native_post_id) || null,
        list_title: cleanText(item.title),
        raw_list_text: cleanText(item.raw_list_text) || null,
        list_posted_at: toDateOnlyOrNull(item.published_at || item.posted_at),
        detail_fetched_at: now,
        content_hash: contentHashFor(item),
        first_seen_at: now,
        last_seen_at: now,
        metadata: { rehearsal_label: options.rehearsalLabel, controlled_sample: true },
      }, { onConflict: EXECUTOR_UPSERT_CONFLICT_TARGETS.crawler_notice_occurrences })
      .select("id")
      .single(),
    "crawler_notice_occurrences upsert",
    { operation: "insert_occurrence", table: "crawler_notice_occurrences" },
    state,
  );

  for (const orgUnitId of report.planned_operations.find((op) => op.operation === "insert_notice_target")?.target_org_unit_ids ?? []) {
    await checkedStep(
      supabase.from("crawler_notice_targets").upsert({
        notice_id: notice.id,
        org_unit_id: orgUnitId,
        source_id: source.id,
        confidence: 1,
        evidence: { rehearsal_label: options.rehearsalLabel, controlled_sample: true },
      }, { onConflict: EXECUTOR_UPSERT_CONFLICT_TARGETS.crawler_notice_targets }),
      "crawler_notice_targets upsert",
      { operation: "insert_notice_target", table: "crawler_notice_targets" },
      state,
    );
  }

  for (const [index, asset] of (item.assets ?? []).entries()) {
    await checkedStep(
      supabase.from("crawler_notice_assets").upsert({
        notice_id: notice.id,
        occurrence_id: occurrence.id,
        asset_kind: cleanText(asset.asset_kind ?? asset.asset_type) || "attachment",
        source_url: normalizeUrl(asset.source_url),
        filename: cleanText(asset.filename) || null,
        position: index,
        status: "referenced",
        metadata: { rehearsal_label: options.rehearsalLabel, controlled_sample: true },
      }, { onConflict: EXECUTOR_UPSERT_CONFLICT_TARGETS.crawler_notice_assets }),
      "crawler_notice_assets upsert",
      { operation: "insert_notice_asset", table: "crawler_notice_assets" },
      state,
    );
  }

  for (const warning of item.warnings ?? []) {
    await checkedStep(
      supabase.from("crawler_errors").insert({
        run_id: run.id,
        source_id: source.id,
        notice_id: notice.id,
        occurrence_id: occurrence.id,
        stage: "controlled_sample_rehearsal",
        error_class: "fixture_warning",
        message: cleanText(warning),
        details: { rehearsal_label: options.rehearsalLabel, controlled_sample: true },
      }),
      "crawler_errors insert",
      { operation: "insert_error", table: "crawler_errors" },
      state,
    );
  }

  await checkedStep(
    supabase.from("crawler_keyword_matches").insert({
      notice_id: notice.id,
      rule_version: "controlled-sample-phase1",
      keyword: "scholarship",
      field: "title",
      offset_start: Math.max(0, cleanText(item.title).toLowerCase().indexOf("scholarship")),
      offset_end: Math.max(0, cleanText(item.title).toLowerCase().indexOf("scholarship")) + "scholarship".length,
      score: 1,
    }),
    "crawler_keyword_matches insert",
    { operation: "insert_keyword_match", table: "crawler_keyword_matches" },
    state,
  );

  return {
    run_id: run.id,
    notice_id: notice.id,
    occurrence_id: occurrence.id,
  };
  } catch (error) {
    if (supabase && state.runId) {
      await markRunFailed(supabase, state, error, options);
      error.runStatusMarkedFailed = state.runStatusMarkedFailed;
    }
    error.completedOperations = error.completedOperations ?? [...state.completedOperations];
    error.pendingOperations = error.pendingOperations ?? pendingOperationsAfter(state.completedOperations);
    throw error;
  }
}

function printTextReport(report) {
  console.log("controlled_sample_apply_plan=ok");
  console.log(`mode=${report.mode}`);
  console.log(`db_write_executed=${report.db_write_executed}`);
  console.log(`supabase_sql_executed=${report.supabase_sql_executed}`);
  console.log(`real_apply_executed=${report.real_apply_executed}`);
  console.log(`source_key=${report.source_key}`);
  console.log(`limit=${report.limit}`);
  console.log(`planned_operations=${report.summary?.planned_operations ?? 0}`);
  console.log(`dependency_complete=${report.summary?.dependency_complete ?? false}`);
  console.log(`controlled_sample_apply_plan_ready=${report.go_no_go?.controlled_sample_apply_plan_ready ?? false}`);
  console.log(`real_apply_ready=${report.go_no_go?.real_apply_ready ?? false}`);
  console.log(`reason=${report.go_no_go?.reason ?? "unknown"}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  validateApplyGuards(options);
  if (options.checkConflicts && !options.inputPath && !options.preApplyReportPath) {
    const report = buildConflictPreflightReport();
    if (options.outPath) writeJson(options.outPath, report);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log("schema_conflict_preflight=ok");
      console.log(`ok=${report.ok}`);
      console.log(`mismatches=${report.mismatches.length}`);
      console.log(`db_write_executed=${report.db_write_executed}`);
      console.log(`supabase_sql_executed=${report.supabase_sql_executed}`);
      console.log(`real_apply_executed=${report.real_apply_executed}`);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (options.simulateApplySuccessReport && !options.inputPath && !options.preApplyReportPath) {
    const report = buildSimulatedSuccessReport();
    if (options.outPath) writeJson(options.outPath, report);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printTextReport(report);
    return;
  }
  validateRequiredOptions(options);
  const fixture = readJson(options.inputPath, "Controlled fixture");
  const preApplyReport = readJson(options.preApplyReportPath, "Pre-apply report");
  let report = buildReport(fixture, preApplyReport, options);

  if (options.checkConflicts && !report.schema_conflict_preflight.ok) {
    if (options.outPath) writeJson(options.outPath, report);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printTextReport(report);
    process.exitCode = 1;
    return;
  }

  if (options.simulateApplyFailureAt) {
    report = simulateApplyFailure(report, options);
    if (options.outPath) writeJson(options.outPath, report);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printTextReport(report);
    process.exitCode = 1;
    return;
  }
  if (options.simulateApplySuccessReport) {
    report = markApplySucceeded(report, {
      run_id: "00000000-0000-4000-8000-000000000000",
      notice_id: 0,
      occurrence_id: 0,
      simulated: true,
    });
    report.mode = "success_simulation";
    report.db_write_executed = false;
    report.supabase_sql_executed = false;
    report.simulation = {
      local_only: true,
      db_client_created: false,
      real_db_write_executed: false,
      validates_nested_real_apply_executed: report.go_no_go.real_apply_executed === true,
    };
    if (options.outPath) writeJson(options.outPath, report);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else printTextReport(report);
    return;
  }

  if (options.apply) {
    try {
      const result = await executeApply(report, fixture, options);
      report = markApplySucceeded(report, result);
    } catch (error) {
      const failureReport = buildFailureReport({ baseReport: report, error, options });
      if (options.outPath) writeJson(options.outPath, failureReport);
      if (options.json) console.log(JSON.stringify(failureReport, null, 2));
      throw error;
    }
  }

  if (options.outPath) writeJson(options.outPath, report);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printTextReport(report);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
