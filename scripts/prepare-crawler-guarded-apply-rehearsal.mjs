import fs from "node:fs";
import path from "node:path";

const WRITE_LIKE_OPTIONS = new Set(["--apply", "--write", "--commit"]);
const DELETION_OR_MISSING_OPERATIONS = new Set([
  "delete_notice",
  "delete_occurrence",
  "mark_notice_inactive",
  "mark_occurrence_inactive",
  "deprecate_notice",
  "skip_missing_detection_due_to_source_health",
  "skip_missing_detection_due_to_pagination",
]);
const QUALITY_BLOCKED_OPERATIONS = new Set(["insert_notice", "update_notice_body"]);
const DEPENDENCY_PARENT_OPERATIONS = {
  add_url_alias: ["insert_notice"],
  insert_asset: ["insert_notice"],
  insert_error: ["insert_run", "insert_source_result"],
  insert_keyword_match: ["insert_notice"],
  insert_notice_target: ["insert_notice"],
  insert_occurrence: ["insert_run", "insert_source_result", "insert_notice"],
  update_notice_body: ["insert_notice"],
  update_notice_metadata: ["insert_notice"],
};
const MINIMAL_DEPENDENCY_COMPLETE_OPERATION_SET = [
  "insert_run",
  "insert_source_result",
  "insert_notice",
  "insert_occurrence",
  "insert_notice_target",
  "insert_error",
];

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const options = {
    preApplyReportPath: "",
    outPath: "",
    json: false,
    maxItems: null,
    sourceKey: "",
    allowOperations: new Set(),
    strict: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (WRITE_LIKE_OPTIONS.has(arg)) {
      throw new Error(`${arg} is not supported. This rehearsal planner never writes to DB.`);
    }
    if (arg === "--pre-apply-report") {
      if (!next) throw new Error("--pre-apply-report requires a path.");
      options.preApplyReportPath = next;
      index += 1;
    } else if (arg === "--out") {
      if (!next) throw new Error("--out requires a path.");
      options.outPath = next;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--max-items") {
      if (!next || !/^\d+$/.test(next) || Number(next) < 1) {
        throw new Error("--max-items requires a positive integer.");
      }
      options.maxItems = Number(next);
      index += 1;
    } else if (arg === "--source-key") {
      if (!next) throw new Error("--source-key requires a value.");
      options.sourceKey = cleanText(next).toLowerCase();
      index += 1;
    } else if (arg === "--allow-operation") {
      if (!next) throw new Error("--allow-operation requires a value.");
      options.allowOperations.add(cleanText(next));
      index += 1;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/prepare-crawler-guarded-apply-rehearsal.mjs --pre-apply-report reports/pre-apply.json --max-items 1 [--source-key yonsei_060] [--allow-operation insert_error] [--out reports/rehearsal.json] [--json]

Options:
  --pre-apply-report PATH     Required pre-apply safety report JSON.
  --out PATH                  Save rehearsal plan JSON.
  --json                      Print full JSON report.
  --max-items N               Required maximum selected item count.
  --source-key KEY            Optional source_key filter.
  --allow-operation NAME      Optional allowlist. Repeatable.
  --strict                    Keep conservative review-required exclusions explicit.

Safety:
  No DB connection, no DB write, no SQL execution, no .env loading, no crawler
  execution, and no apply/write/commit mode.
`);
}

function requireOptions(options) {
  if (!options.preApplyReportPath) throw new Error("--pre-apply-report is required.");
  if (!options.maxItems) throw new Error("--max-items is required.");
}

function readReport(reportPath) {
  const resolved = path.resolve(reportPath);
  if (!fs.existsSync(resolved)) throw new Error(`Pre-apply report not found: ${reportPath}`);
  const report = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!report || typeof report !== "object") throw new Error("Pre-apply report must be a JSON object.");
  return report;
}

function operationKey(operation) {
  return cleanText(operation.operation);
}

function makeItemKey(sourceKey, canonicalKey) {
  return `${sourceKey}\n${canonicalKey}`;
}

function buildItemDetailMap(report) {
  const map = new Map();
  for (const item of report.items ?? []) {
    const sourceKey = cleanText(item.source_key).toLowerCase();
    const canonicalKey = cleanText(item.canonical_key);
    if (!sourceKey || !canonicalKey) continue;
    map.set(makeItemKey(sourceKey, canonicalKey), item);
  }
  return map;
}

function buildSourceHealthMap(report) {
  const map = new Map();
  for (const source of report.source_health ?? []) {
    const sourceKey = cleanText(source.source_key).toLowerCase();
    if (sourceKey) map.set(sourceKey, source);
  }
  return map;
}

function isReadOnlyDbReport(report) {
  return report.mode === "read_only_db_check" && report.db_check?.executed === true;
}

function exclusionReasonsForItem(item, sourceHealth, readOnlyDbReady) {
  const reasons = [];
  if (!readOnlyDbReady) reasons.push("read_only_db_check_required");
  if (sourceHealth && (!sourceHealth.safe_for_change_detection || !sourceHealth.safe_for_missing_detection)) {
    reasons.push("source_health_unsafe");
  }
  if (item?.change_flags?.includes("source_health_unsafe")) reasons.push("source_health_unsafe");
  if (item?.classification === "blocked_by_missing_required_field") reasons.push("missing_required_field");
  return [...new Set(reasons)];
}

function exclusionReasonsForOperation(operation, item, options, readOnlyDbReady) {
  const reasons = [];
  const name = operationKey(operation);
  if (!readOnlyDbReady) reasons.push("read_only_db_check_required");
  if (operation.blocked) reasons.push(operation.blocking_reason || "operation_blocked");
  if (operation.requires_review) reasons.push("requires_review");
  if (DELETION_OR_MISSING_OPERATIONS.has(name) || /delete|inactive|deprecat|missing/i.test(name)) {
    reasons.push("deletion_or_missing_apply_prohibited");
  }
  if (options.allowOperations.size > 0 && !options.allowOperations.has(name)) reasons.push("not_in_allowed_operations");
  if (item?.classification === "needs_quality_review" && QUALITY_BLOCKED_OPERATIONS.has(name)) {
    reasons.push("quality_review_blocks_notice_write");
  }
  if (item?.quality_flags?.length > 0 && QUALITY_BLOCKED_OPERATIONS.has(name)) {
    reasons.push("quality_flags_block_notice_write");
  }
  if (item?.classification === "blocked_by_missing_required_field") reasons.push("missing_required_field");
  if (item?.change_flags?.includes("body_quality_degraded") && name === "update_notice_body") {
    reasons.push("body_quality_degraded_blocks_body_update");
  }
  if (options.strict && operation.requires_review) reasons.push("strict_mode_review_required");
  return [...new Set(reasons)];
}

function opWithReason(operation, reasons, item) {
  return {
    ...operation,
    source_key: cleanText(operation.source_key || item?.source_key),
    canonical_key: cleanText(operation.canonical_key || item?.canonical_key),
    exclusion_reasons: reasons,
  };
}

function itemOperationKey(operation) {
  return makeItemKey(
    cleanText(operation.source_key).toLowerCase(),
    cleanText(operation.canonical_key),
  );
}

function buildOperationNameMap(operations) {
  const map = new Map();
  for (const operation of operations) {
    const itemKey = itemOperationKey(operation);
    if (!map.has(itemKey)) map.set(itemKey, new Map());
    const name = operationKey(operation);
    if (!map.get(itemKey).has(name)) map.get(itemKey).set(name, []);
    map.get(itemKey).get(name).push(operation);
  }
  return map;
}

function analyzeOperationDependencies(selectedOperations, excludedOperations) {
  const selectedByItem = buildOperationNameMap(selectedOperations);
  const excludedByItem = buildOperationNameMap(excludedOperations);
  const warnings = [];

  for (const operation of selectedOperations) {
    const name = operationKey(operation);
    const requiredParents = DEPENDENCY_PARENT_OPERATIONS[name] ?? [];
    if (requiredParents.length === 0) continue;

    const itemKey = itemOperationKey(operation);
    const selectedNames = selectedByItem.get(itemKey) ?? new Map();
    const excludedNames = excludedByItem.get(itemKey) ?? new Map();
    const missingParents = requiredParents.filter((parent) => !selectedNames.has(parent));
    if (missingParents.length === 0) continue;

    warnings.push({
      source_key: operation.source_key,
      canonical_key: operation.canonical_key,
      operation: name,
      missing_parent_operations: missingParents,
      excluded_parent_operations: missingParents.filter((parent) => excludedNames.has(parent)),
      risk: "selected_child_operation_without_dependency_complete_parent_set",
      recommendation: "review schema FK requirements and use a dependency-complete minimal operation set before any real apply",
    });
  }

  return {
    dependency_complete_for_real_apply: warnings.length === 0 && selectedOperations.length > 0,
    warning_count: warnings.length,
    warnings,
    recommended_minimal_dependency_complete_operation_set: MINIMAL_DEPENDENCY_COMPLETE_OPERATION_SET,
  };
}

function planRehearsal(report, options) {
  const itemDetailMap = buildItemDetailMap(report);
  const sourceHealthMap = buildSourceHealthMap(report);
  const readOnlyDbReady = isReadOnlyDbReport(report);
  const warnings = [];
  const selectedOperations = [];
  const excludedOperations = [];
  const selectedItemKeys = new Set();
  const excludedItemKeys = new Set();
  let candidateOperations = 0;
  let blockedOperationsSeen = 0;
  let reviewRequiredSeen = 0;
  let unsafeSourceItemsExcluded = 0;
  let qualityReviewItemsExcluded = 0;
  let missingRequiredItemsExcluded = 0;

  if (!readOnlyDbReady) {
    warnings.push("pre_apply_report_is_not_read_only_db_checked");
  }
  if (report.db_write_executed === true) warnings.push("input_report_db_write_executed_true");
  if (report.supabase_sql_executed === true) warnings.push("input_report_supabase_sql_executed_true");

  for (const writePlanItem of report.write_plan?.items ?? []) {
    const sourceKey = cleanText(writePlanItem.source_key).toLowerCase();
    const canonicalKey = cleanText(writePlanItem.canonical_key);
    if (options.sourceKey && sourceKey !== options.sourceKey) continue;
    const itemKey = makeItemKey(sourceKey, canonicalKey);
    const itemDetail = itemDetailMap.get(itemKey) ?? writePlanItem;
    const sourceHealth = sourceHealthMap.get(sourceKey);
    const itemReasons = exclusionReasonsForItem(itemDetail, sourceHealth, readOnlyDbReady);

    if (itemReasons.includes("source_health_unsafe")) unsafeSourceItemsExcluded += 1;
    if (itemDetail?.classification === "needs_quality_review") qualityReviewItemsExcluded += 1;
    if (itemDetail?.classification === "blocked_by_missing_required_field") missingRequiredItemsExcluded += 1;

    for (const operation of writePlanItem.operations ?? []) {
      candidateOperations += 1;
      if (operation.blocked) blockedOperationsSeen += 1;
      if (operation.requires_review) reviewRequiredSeen += 1;
      const operationReasons = exclusionReasonsForOperation(operation, itemDetail, options, readOnlyDbReady);
      const reasons = [...new Set([...itemReasons, ...operationReasons])];
      if (reasons.length > 0) {
        excludedOperations.push(opWithReason(operation, reasons, itemDetail));
        excludedItemKeys.add(itemKey);
        continue;
      }
      if (selectedItemKeys.size >= options.maxItems && !selectedItemKeys.has(itemKey)) {
        excludedOperations.push(opWithReason(operation, ["max_items_limit_reached"], itemDetail));
        continue;
      }
      selectedOperations.push({
        ...operation,
        would_write: false,
        source_key: sourceKey,
        canonical_key: canonicalKey,
      });
      selectedItemKeys.add(itemKey);
    }
  }

  if (selectedItemKeys.size >= options.maxItems && excludedOperations.some((op) => op.exclusion_reasons?.includes("max_items_limit_reached"))) {
    warnings.push(`max_items_limit_applied:${options.maxItems}`);
  }

  const reason = selectedOperations.length === 0
    ? (readOnlyDbReady ? "no_safe_operations_after_filters" : "read_only_db_check_required")
    : "safe_rehearsal_candidates_selected_for_user_review";
  const operationDependency = analyzeOperationDependencies(selectedOperations, excludedOperations);
  if (operationDependency.warning_count > 0) {
    warnings.push("selected_operations_require_dependency_review_before_real_apply");
  }

  return {
    generated_at: new Date().toISOString(),
    input_report_path: path.normalize(options.preApplyReportPath),
    db_write_executed: false,
    supabase_sql_executed: false,
    real_apply_executed: false,
    ok: true,
    options: {
      source_key: options.sourceKey || null,
      max_items: options.maxItems,
      allow_operations: [...options.allowOperations],
      strict: options.strict,
    },
    input_report: {
      mode: report.mode ?? null,
      db_check_executed: report.db_check?.executed ?? false,
      db_write_executed: report.db_write_executed ?? false,
      supabase_sql_executed: report.supabase_sql_executed ?? false,
      summary: report.summary ?? {},
    },
    summary: {
      input_items: (report.items ?? []).length,
      candidate_items: (report.write_plan?.items ?? []).length,
      selected_items: selectedItemKeys.size,
      candidate_operations: candidateOperations,
      selected_operations: selectedOperations.length,
      excluded_operations: excludedOperations.length,
      blocked_operations_seen: blockedOperationsSeen,
      review_required_seen: reviewRequiredSeen,
      unsafe_source_items_excluded: unsafeSourceItemsExcluded,
      quality_review_items_excluded: qualityReviewItemsExcluded,
      missing_required_items_excluded: missingRequiredItemsExcluded,
    },
    selected_operations: selectedOperations,
    excluded_operations: excludedOperations,
    operation_dependency: operationDependency,
    warnings,
    go_no_go: {
      sample_apply_rehearsal_ready: readOnlyDbReady && selectedOperations.length > 0,
      real_apply_ready: false,
      reason,
      real_apply_ready_reason: "selected operations are dry-run rehearsal candidates only; actual DB write requires separate user approval, controlled fixture or quality gate review, and dependency-complete operation review",
      requires_user_approval_before_real_apply: true,
      requires_controlled_fixture_or_quality_gate_pass: true,
      dependency_complete_for_real_apply: operationDependency.dependency_complete_for_real_apply,
      dependency_warning_count: operationDependency.warning_count,
      recommended_minimal_dependency_complete_operation_set: MINIMAL_DEPENDENCY_COMPLETE_OPERATION_SET,
    },
  };
}

function printTextReport(report) {
  console.log("guarded_apply_rehearsal_plan=ok");
  console.log(`db_write_executed=${report.db_write_executed}`);
  console.log(`supabase_sql_executed=${report.supabase_sql_executed}`);
  console.log(`real_apply_executed=${report.real_apply_executed}`);
  console.log(`input_items=${report.summary.input_items}`);
  console.log(`candidate_items=${report.summary.candidate_items}`);
  console.log(`selected_items=${report.summary.selected_items}`);
  console.log(`candidate_operations=${report.summary.candidate_operations}`);
  console.log(`selected_operations=${report.summary.selected_operations}`);
  console.log(`excluded_operations=${report.summary.excluded_operations}`);
  console.log(`sample_apply_rehearsal_ready=${report.go_no_go.sample_apply_rehearsal_ready}`);
  console.log(`real_apply_ready=${report.go_no_go.real_apply_ready}`);
  console.log(`dependency_warning_count=${report.go_no_go.dependency_warning_count}`);
  console.log(`reason=${report.go_no_go.reason}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  requireOptions(options);
  const preApplyReport = readReport(options.preApplyReportPath);
  const report = planRehearsal(preApplyReport, options);
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
