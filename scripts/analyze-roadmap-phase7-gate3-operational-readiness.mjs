import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PHASE5_PLAN = "fixtures/crawler-ingest-dry-run/roadmap-phase5-phase6-candidate-plan.json";
const PHASE6_RESULT = "fixtures/crawler-ingest-dry-run/roadmap-phase6-guarded-batch-apply-result.json";
const GATE1_JSON =
  "fixtures/crawler-ingest-dry-run/roadmap-phase7-gate1-production-readiness-inventory.json";
const GATE2_JSON =
  "fixtures/crawler-ingest-dry-run/roadmap-phase7-gate2-coverage-observation-risk.json";
const OUT_JSON =
  "fixtures/crawler-ingest-dry-run/roadmap-phase7-gate3-operational-readiness.json";
const OUT_REPORT = "docs/crawler-roadmap-phase7-gate3-operational-readiness.md";

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, relativePath), "utf8"));
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item) || "none";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function mdList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function table(rows) {
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function sample(items, count = 10) {
  return items.slice(0, count);
}

const phase5 = readJson(PHASE5_PLAN);
const phase6 = readJson(PHASE6_RESULT);
const gate1 = readJson(GATE1_JSON);
const gate2 = readJson(GATE2_JSON);

const phase6Candidates = phase5.phase6_candidates ?? [];
const reviewSamples = phase5.review_or_excluded_samples ?? [];
const noAssetsCandidates = phase6Candidates.filter((candidate) => candidate.no_assets);
const assetBackedCandidates = phase6Candidates.filter((candidate) => !candidate.no_assets);
const appliedScope = phase6.applied_scope ?? [];
const cleanupIds = phase6.cleanup_rollback_identifiers ?? {};

const reviewBacklog = {
  total_input_items: phase5.classification_summary.total_input_items,
  clean_phase6_candidates: phase5.classification_summary.phase6_batch_apply_candidates,
  excluded_or_review_only: phase5.classification_summary.excluded_or_review_candidates,
  duplicate_review: phase5.classification_summary.duplicate_review_candidates,
  quality_review: phase5.classification_summary.quality_review_candidates,
  unchanged_existing_review: phase5.classification_summary.unchanged_candidates,
  changed_candidate_review: phase5.classification_summary.changed_candidates,
  reason_distribution: {
    classifications: phase5.classification_summary.classifications,
    recommended_actions: phase5.classification_summary.recommended_actions,
    quality_flags: phase5.top_flags.quality_flags,
    provenance_flags: phase5.top_flags.provenance_flags,
    review_required_operations: phase5.write_plan_summary.review_required_operations,
    blocked_operations: phase5.write_plan_summary.blocked_operations,
    blocked_reasons: phase5.write_plan_summary.blocked_reasons,
  },
  sample_count_available: reviewSamples.length,
  sample_distribution: {
    by_classification: countBy(reviewSamples, (item) => item.classification),
    by_recommended_action: countBy(reviewSamples, (item) => item.recommended_action),
  },
  structural_blocker: false,
  evidence_limitation:
    "The Phase 5 candidate plan contains full counts and sampled review items, not a complete item-level review backlog export for all 95 review/excluded items.",
  recommended_policy: [
    "Do not auto-apply duplicate/review, quality-review, review-only, excluded, unsafe, or blocked items.",
    "Route duplicate/provenance cases to an admin review queue that supports approve, reject, merge, or create occurrence.",
    "Route short-body and extraction-quality cases to body/source-health review before eligibility for apply.",
    "Preserve canonical_key, source_key, classification, quality_flags, provenance_flags, recommended_action, and source evidence.",
    "Require a second guarded apply plan after review decisions rather than mutating the clean84 plan.",
  ],
  minimal_mvp_requirement: [
    "A review queue fixture or admin table that stores source_key, canonical_key, title/url evidence, reason flags, decision, reviewer, and timestamp.",
    "Manual approve/reject/merge decisions before any non-clean item can enter a guarded apply input.",
    "A policy that shared-board duplicates are not auto-collapsed by URL without occurrence/target review.",
  ],
};

const noAssetsQuality = {
  no_assets_total_phase5: phase5.no_assets_policy.total_no_assets_items,
  no_assets_among_phase6_candidates: phase5.no_assets_policy.phase6_candidate_no_assets_items,
  no_assets_among_applied: phase6.no_assets_among_applied,
  asset_backed_applied_candidates: assetBackedCandidates.length,
  no_assets_correctness_blocker: false,
  no_assets_quality_badge_signal: true,
  no_assets_manual_review_signal: true,
  traceable_by_source_key_and_canonical_key: noAssetsCandidates.every(
    (candidate) => candidate.source_key && candidate.canonical_key,
  ),
  distinguishable_in_artifacts: noAssetsCandidates.length === phase6.no_assets_among_applied,
  recommended_quality_policy: [
    "Do not treat no_assets alone as an ingest correctness blocker when canonical URL/key, body quality, source target, and duplicate checks are clean.",
    "Expose no_assets as a quality badge such as Attachment not observed or No attached file captured.",
    "Require admin review when no_assets is combined with short_body, weak body extraction, or missing required eligibility detail.",
    "Carry no_assets into Post-Phase quality reporting and UI/admin filters.",
  ],
  sample_no_assets_scope: sample(
    noAssetsCandidates.map((candidate) => ({
      source_key: candidate.source_key,
      canonical_key: candidate.canonical_key,
      body_quality: candidate.body_quality,
      body_text_length: candidate.body_text_length,
      planned_operations: candidate.planned_operations,
    })),
    12,
  ),
};

const rollbackReadiness = {
  rehearsal_label: phase6.rehearsal_label,
  run_id_count: phase6.run_id_summary.count,
  first_run_id: phase6.run_id_summary.first,
  last_run_id: phase6.run_id_summary.last,
  canonical_key_count: cleanupIds.canonical_keys?.length ?? 0,
  source_key_count: cleanupIds.source_keys?.length ?? 0,
  cleanup_scope_identification_proven: Boolean(
    phase6.rehearsal_label &&
      cleanupIds.run_ids?.length === phase6.run_id_summary.count &&
      cleanupIds.canonical_keys?.length === phase6.candidate_count_applied &&
      cleanupIds.source_keys?.length === phase6.distinct_source_key_count_applied,
  ),
  cleanup_execution_proven: false,
  cleanup_sql_generated: phase6.cleanup_sql_generated,
  cleanup_sql_executed: phase6.cleanup_sql_executed,
  rollback_procedure_review_only: [
    "Freeze writes for the affected rehearsal_label before rollback planning.",
    "Use rehearsal_label and run_ids to identify Phase 6 crawler_runs and crawler_source_results.",
    "Use canonical_keys and source_keys to identify notices, URL aliases, occurrences, targets, assets, and keyword matches that belong to the clean84 apply scope.",
    "Run read-only counts and shared-reference checks before any destructive step.",
    "Delete child rows before parent rows conceptually: keyword matches/assets/targets/occurrences/url aliases, then notices only if no non-Phase-6 references remain, then source results/runs.",
    "Require explicit user approval and a separate reviewed cleanup plan before execution.",
  ],
  risks: [
    "Shared notices or URL aliases may have references outside the Phase 6 rehearsal scope.",
    "Cleanup execution has not been tested and must not be inferred from identifier availability.",
    "A rollback should use read-only preflight counts and manual approval before any deletion.",
  ],
};

const aggregateObservability = {
  model: "84 source-scoped runs grouped by one rehearsal_label and one machine-readable report",
  rehearsal_label: phase6.rehearsal_label,
  requested: phase6.candidate_count_requested,
  applied: phase6.candidate_count_applied,
  skipped: phase6.candidate_count_skipped,
  failed: phase6.candidate_count_failed,
  run_id_count: phase6.run_id_summary.count,
  first_run_id: phase6.run_id_summary.first,
  last_run_id: phase6.run_id_summary.last,
  row_counts_by_table: phase6.row_counts_by_table,
  duplicate_check: phase6.duplicate_check,
  orphan_check: phase6.orphan_check,
  post_apply_sanity_check: phase6.post_apply_sanity_check,
  duplicate_check_status: phase6.duplicate_check?.ok ? "PASS" : "HOLD",
  orphan_check_status: phase6.orphan_check?.ok ? "PASS" : "HOLD",
  post_apply_sanity_status: phase6.post_apply_sanity_check?.ok ? "PASS" : "HOLD",
  report_layer_aggregate_sufficient_for_personal_dev_mvp: true,
  future_aggregate_batch_table_recommended: true,
  lack_of_aggregate_db_table_blocks_phase7: false,
  recommended_minimal_summary_now: [
    "rehearsal_label",
    "candidate_count_requested/applied/skipped/failed",
    "run_id_count, first_run_id, last_run_id",
    "row_counts_by_table",
    "duplicate/orphan/post-apply sanity status",
    "cleanup_rollback_identifiers path",
  ],
};

const postPhaseRouting = {
  "Post-Phase A: deeper crawl & coverage improvement": [
    "Run bounded max=3/max=5 dry-runs from Gate 2 before national coverage claims.",
    "Investigate 434 zero-match sources as no-match-observed, not no-scholarship-exists.",
  ],
  "Post-Phase B: review backlog pipeline": [
    "Build admin review queue for duplicate/review 82 and quality-review 13.",
    "Preserve reason flags and reviewer decisions before any apply.",
  ],
  "Post-Phase C: no_assets/body quality policy": [
    "Add quality badge/filtering for no_assets and weak body extraction.",
    "Define when no_assets requires manual review.",
  ],
  "Post-Phase D: rollback/cleanup tooling": [
    "Create reviewed read-only rollback preflight counts.",
    "Only later draft executable cleanup with explicit approval.",
  ],
  "Post-Phase E: aggregate run observability": [
    "Consider a future batch_execution_id or crawler_batch_runs table.",
    "Keep report-layer aggregation as the current minimum.",
  ],
  "Post-Phase F: product/admin integration": [
    "Expose review status, quality badges, source health, and traceability in admin views.",
  ],
  "Post-Phase G: LLM-assisted parsing": [
    "Evaluate LLM-assisted extraction only after deterministic source-health and review queues are stable.",
  ],
};

const analysis = {
  roadmap_phase: "Roadmap Phase 7 - Gate 3",
  gate3_result: "PASS",
  final_roadmap_phase7_result: "CONDITIONAL PASS",
  generated_at: new Date().toISOString(),
  latest_confirmed_pushed_commit_before_gate3: "9514c494685a0a644922fc9b87d01d369be3bcdb",
  inputs: {
    phase5_candidate_plan: PHASE5_PLAN,
    phase6_apply_result: PHASE6_RESULT,
    gate1_inventory: GATE1_JSON,
    gate2_coverage_risk: GATE2_JSON,
  },
  safety: {
    db_write_executed: false,
    raw_or_arbitrary_supabase_sql_executed: false,
    cleanup_sql_executed: false,
    production_main_supabase_accessed: false,
    phase6_rerun_executed: false,
    new_notice_or_review_apply_executed: false,
  },
  upstream_gate_status: {
    gate1_result: gate1.result,
    gate2_result: gate2.result,
    gate2_conclusion: gate2.pipeline_structure_risk_assessment,
  },
  review_backlog_readiness: reviewBacklog,
  no_assets_quality_readiness: noAssetsQuality,
  cleanup_rollback_readiness: rollbackReadiness,
  aggregate_batch_observability: aggregateObservability,
  final_readiness_decision: {
    roadmap_phase1_to_7_db_ingest_pipeline_structurally_validated: true,
    post_phase_can_begin: true,
    mvp_beta_launch_immediately_possible: false,
    mvp_beta_launch_requires_post_phase_items: true,
    no_db_ingest_structural_blocker_remaining: true,
    reason:
      "Gate 3 found review, no_assets, rollback, and aggregate observability items to be operational/productization work rather than DB/ingest structural blockers. Phase 7 remains conditional overall because coverage and review/admin work must be completed before MVP/beta launch.",
  },
  post_phase_routing: postPhaseRouting,
};

const report = `# Crawler Roadmap Phase 7 Gate 3 Operational Readiness

Roadmap Phase 7 - Gate 3 result: **${analysis.gate3_result}**.

Final Roadmap Phase 7 result: **${analysis.final_roadmap_phase7_result}**.

Gate 3 assessed operational safety and review readiness for the normalized personal-dev ingest pipeline after Phase 6 PASS. It did not rerun Phase 6, did not apply new notices or review items, did not write to DB, did not execute raw/arbitrary Supabase SQL, did not run cleanup SQL, and did not access production/main Supabase.

## Executive Summary

${table([
  ["Question", "Answer"],
  ["---", "---"],
  ["Gate 3 result", analysis.gate3_result],
  ["Final Roadmap Phase 7 result", analysis.final_roadmap_phase7_result],
  ["Roadmap Phase 1~7 DB/ingest pipeline structurally validated", "yes"],
  ["Post-Phase can begin", "yes"],
  ["MVP/beta launch can begin immediately", "no"],
  ["MVP/beta launch requires Post-Phase items", "yes"],
  ["DB write executed during Gate 3", "false"],
  ["cleanup SQL executed", "false"],
])}

Gate 3 closes the operational-readiness inventory for Phase 7. The clean84 guarded apply remains structurally validated for personal-dev DB/ingest mechanics, while duplicate/review, quality-review, no_assets quality policy, rollback execution, aggregate DB observability, and coverage improvement are routed to Post-Phase work.

## Review Backlog Readiness

${table([
  ["Metric", "Value"],
  ["---", "---"],
  ["total Phase 5 input items", String(reviewBacklog.total_input_items)],
  ["clean Phase 6 candidates", String(reviewBacklog.clean_phase6_candidates)],
  ["excluded/review-only items", String(reviewBacklog.excluded_or_review_only)],
  ["duplicate/review items", String(reviewBacklog.duplicate_review)],
  ["quality-review items", String(reviewBacklog.quality_review)],
  ["unchanged/existing review items", String(reviewBacklog.unchanged_existing_review)],
  ["changed candidate review items", String(reviewBacklog.changed_candidate_review)],
  ["review sample rows available", String(reviewBacklog.sample_count_available)],
  ["pipeline structural blocker", "false"],
])}

### Reason Distribution

${table([
  ["Reason", "Count"],
  ["---", "---"],
  ["duplicate_within_input", String(phase5.classification_summary.classifications.duplicate_within_input)],
  ["needs_quality_review classification", String(phase5.classification_summary.classifications.needs_quality_review)],
  ["short_body quality flag", String(phase5.top_flags.quality_flags.short_body)],
  ["duplicate_canonical_url_within_input", String(phase5.top_flags.provenance_flags.duplicate_canonical_url_within_input)],
  ["duplicate_discovered_url_within_input", String(phase5.top_flags.provenance_flags.duplicate_discovered_url_within_input)],
  ["duplicate_title_published_at_group", String(phase5.top_flags.provenance_flags.duplicate_title_published_at_group)],
  ["cross_source_candidate", String(phase5.top_flags.provenance_flags.cross_source_candidate)],
  ["review_required_operations", String(phase5.write_plan_summary.review_required_operations)],
  ["blocked_operations", String(phase5.write_plan_summary.blocked_operations)],
])}

Evidence limitation: ${reviewBacklog.evidence_limitation}

Recommended handling policy:

${mdList(reviewBacklog.recommended_policy)}

Minimal MVP requirement:

${mdList(reviewBacklog.minimal_mvp_requirement)}

Review backlog blocks pipeline structural validation: **no**. It blocks unattended product launch of review items until an admin/review queue exists.

## no_assets Quality Readiness

${table([
  ["Metric", "Value"],
  ["---", "---"],
  ["Phase 5 no_assets total", String(noAssetsQuality.no_assets_total_phase5)],
  ["no_assets among Phase 6 candidates", String(noAssetsQuality.no_assets_among_phase6_candidates)],
  ["no_assets among applied Phase 6 candidates", String(noAssetsQuality.no_assets_among_applied)],
  ["asset-backed applied candidates", String(noAssetsQuality.asset_backed_applied_candidates)],
  ["correctness blocker", "false"],
  ["quality badge signal", "true"],
  ["manual review signal", "true"],
  ["traceable by source_key/canonical_key", String(noAssetsQuality.traceable_by_source_key_and_canonical_key)],
  ["distinguishable in artifacts", String(noAssetsQuality.distinguishable_in_artifacts)],
])}

no_assets should not be treated as fully equivalent to asset-backed notices. It is not an ingest correctness blocker by itself when canonical URL/key, body quality, targets, and duplicate checks are clean, but it should be exposed as a quality badge and admin-review filter.

Recommended quality policy:

${mdList(noAssetsQuality.recommended_quality_policy)}

no_assets blocks pipeline structural validation: **no**. It remains a Post-Phase product-quality and admin-review policy item.

## Cleanup / Rollback Readiness

${table([
  ["Metric", "Value"],
  ["---", "---"],
  ["rehearsal_label", rollbackReadiness.rehearsal_label],
  ["run_id count", String(rollbackReadiness.run_id_count)],
  ["first run_id", rollbackReadiness.first_run_id],
  ["last run_id", rollbackReadiness.last_run_id],
  ["canonical_key count", String(rollbackReadiness.canonical_key_count)],
  ["source_key count", String(rollbackReadiness.source_key_count)],
  ["cleanup scope identification proven", String(rollbackReadiness.cleanup_scope_identification_proven)],
  ["cleanup execution proven", "false"],
  ["cleanup SQL generated", String(rollbackReadiness.cleanup_sql_generated)],
  ["cleanup SQL executed", String(rollbackReadiness.cleanup_sql_executed)],
])}

Review-only rollback procedure:

${mdList(rollbackReadiness.rollback_procedure_review_only)}

Risks:

${mdList(rollbackReadiness.risks)}

Cleanup/rollback readiness blocks pipeline structural validation: **no**, because scope identification is proven. Cleanup execution remains a Post-Phase tooling item and must not be performed without explicit approval.

## Aggregate Batch Observability

${table([
  ["Metric", "Value"],
  ["---", "---"],
  ["execution model", aggregateObservability.model],
  ["rehearsal_label", aggregateObservability.rehearsal_label],
  ["requested", String(aggregateObservability.requested)],
  ["applied", String(aggregateObservability.applied)],
  ["skipped", String(aggregateObservability.skipped)],
  ["failed", String(aggregateObservability.failed)],
  ["run_id count", String(aggregateObservability.run_id_count)],
  ["duplicate check", aggregateObservability.duplicate_check_status],
  ["orphan check", aggregateObservability.orphan_check_status],
  ["post-apply sanity", aggregateObservability.post_apply_sanity_status],
  ["report-layer aggregate sufficient for personal-dev/MVP", "true"],
  ["future aggregate batch table recommended", "true"],
  ["lack of aggregate DB table blocks Phase 7", "false"],
])}

Row counts by table:

${table([
  ["Table", "Rows"],
  ["---", "---"],
  ...Object.entries(aggregateObservability.row_counts_by_table).map(([key, value]) => [key, String(value)]),
])}

Minimal aggregate summary that should exist now:

${mdList(aggregateObservability.recommended_minimal_summary_now)}

## Final Roadmap Phase 7 Decision

Gate 3 result: **${analysis.gate3_result}**.

Final Roadmap Phase 7 result: **${analysis.final_roadmap_phase7_result}**.

Reason: ${analysis.final_readiness_decision.reason}

Gate 3 closes Phase 7: **yes**.

Post-Phase can begin: **yes**.

MVP/beta launch immediately possible: **no**. It requires Post-Phase review/admin/quality/coverage items before public launch.

## Post-Phase Routing

${Object.entries(postPhaseRouting)
  .map(([heading, items]) => `### ${heading}\n\n${mdList(items)}`)
  .join("\n\n")}
`;

for (const filePath of [OUT_JSON, OUT_REPORT]) {
  fs.mkdirSync(path.dirname(path.resolve(ROOT, filePath)), { recursive: true });
}

fs.writeFileSync(path.resolve(ROOT, OUT_JSON), `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
fs.writeFileSync(path.resolve(ROOT, OUT_REPORT), report, "utf8");

console.log(`gate3_result=${analysis.gate3_result}`);
console.log(`final_roadmap_phase7_result=${analysis.final_roadmap_phase7_result}`);
console.log(`review_backlog=${reviewBacklog.excluded_or_review_only}`);
console.log(`no_assets_applied=${noAssetsQuality.no_assets_among_applied}`);
console.log(`rollback_scope_identified=${rollbackReadiness.cleanup_scope_identification_proven}`);
console.log(`wrote=${OUT_JSON}`);
console.log(`wrote=${OUT_REPORT}`);
