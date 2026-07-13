import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PHASE4_OUTPUT =
  "exports/notices/roadmap-phase4-full-crawl-dry-run/scholarship-notices-20260710.json";
const FUNNEL_JSON = "fixtures/crawler-ingest-dry-run/roadmap-phase4-5-funnel-accountability.json";
const GATE1_JSON =
  "fixtures/crawler-ingest-dry-run/roadmap-phase7-gate1-production-readiness-inventory.json";
const OUT_JSON =
  "fixtures/crawler-ingest-dry-run/roadmap-phase7-gate2-coverage-observation-risk.json";
const OUT_REPORT = "docs/crawler-roadmap-phase7-gate2-coverage-observation-risk.md";
const OUT_HEALTH = "reports/roadmap-phase7-gate2-zero-match-source-health.json";

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

function sample(items, count = 10) {
  return items.slice(0, count).map((source) => ({
    source_key: source.sourceId,
    source_name: source.sourceName,
    parser_strategy: source.parserStrategy ?? "none",
    parser_recovered: Boolean(source.parserRecovered),
    crawled_count: source.crawledCount ?? 0,
    matched_count: source.matchedCount ?? 0,
    error: source.error ?? "",
  }));
}

function uniqueBySource(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.sourceId;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function table(rows) {
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

const phase4 = readJson(PHASE4_OUTPUT);
const funnel = readJson(FUNNEL_JSON);
const gate1 = readJson(GATE1_JSON);

const perSource = phase4.perSource ?? [];
const matchedSources = perSource.filter((source) => Number(source.matchedCount ?? 0) > 0);
const zeroMatchSources = perSource.filter((source) => Number(source.matchedCount ?? 0) === 0);
const explicitFailures = zeroMatchSources.filter((source) => source.error);
const zeroCrawled = zeroMatchSources.filter((source) => Number(source.crawledCount ?? 0) === 0);
const zeroCrawledWithoutError = zeroCrawled.filter((source) => !source.error);
const crawledButNoMatch = zeroMatchSources.filter(
  (source) => !source.error && Number(source.crawledCount ?? 0) > 0,
);

const heuristicZeroMatch = zeroMatchSources.filter(
  (source) => source.parserStrategy === "C_HEURISTIC_ANCHOR",
);
const adapterZeroMatch = zeroMatchSources.filter((source) =>
  String(source.parserStrategy ?? "").startsWith("ADAPTER:"),
);
const parserMissingZeroMatch = zeroMatchSources.filter(
  (source) => !source.parserStrategy || source.parserStrategy === "none",
);
const highPriorityInspectionQueue = uniqueBySource([
  ...explicitFailures,
  ...zeroCrawledWithoutError,
  ...heuristicZeroMatch,
  ...adapterZeroMatch,
  ...parserMissingZeroMatch,
]);

const representativeSample = [];
for (const strategy of Object.keys(countBy(zeroMatchSources, (source) => source.parserStrategy ?? "none"))) {
  representativeSample.push(...sample(zeroMatchSources.filter((source) => (source.parserStrategy ?? "none") === strategy), 4));
}

const sourceLevelFunnel = {
  canonical_sources: funnel.source_level_funnel.canonical_source_count,
  covered_sources: funnel.source_level_funnel.sources_covered_by_phase4,
  crawled_at_least_one_item: funnel.source_level_funnel.sources_crawled_at_least_one_item,
  explicit_failures: funnel.source_level_funnel.sources_with_explicit_failures,
  zero_crawled_without_explicit_error: funnel.source_level_funnel.zero_crawled_without_explicit_error,
  matched_source_count: funnel.source_level_funnel.sources_with_at_least_one_matched_item,
  zero_match_source_count: funnel.source_level_funnel.sources_with_zero_matched_items,
  phase6_candidate_source_count: funnel.source_level_funnel.sources_contributing_phase6_candidates,
};

const zeroMatchClassification = {
  total_zero_match_sources: zeroMatchSources.length,
  confirmed_explicit_failure: explicitFailures.length,
  zero_crawled_without_explicit_error: zeroCrawledWithoutError.length,
  crawled_but_no_scholarship_match_observed: crawledButNoMatch.length,
  confirmed_no_recent_scholarship_notice: 0,
  likely_no_recent_scholarship_notice: null,
  likely_selector_or_config_mismatch: {
    count: zeroCrawledWithoutError.length,
    confidence: "possible_not_proven",
    note: "Only zero-crawled/no-error sources can be queued as possible selector/config/source-health issues from existing artifacts.",
  },
  likely_matching_false_negative: {
    confirmed_count: 0,
    potential_risk_count: zeroMatchSources.length,
    note: "Existing artifacts cannot prove title/body keyword false negatives source-by-source.",
  },
  unsupported_or_weakly_supported_structure: {
    explicit_count: 0,
    weak_inspection_queue_count: highPriorityInspectionQueue.length,
    note: "No explicit unsupported-source label exists; heuristic, adapter, failure, and zero-crawled sources form a high-priority inspection queue.",
  },
  needs_deeper_inspection: zeroMatchSources.length,
  by_parser_strategy: countBy(zeroMatchSources, (source) => source.parserStrategy ?? "none"),
  crawled_but_no_match_by_parser_strategy: countBy(crawledButNoMatch, (source) => source.parserStrategy ?? "none"),
  explicit_failure_examples: sample(explicitFailures),
  zero_crawled_without_error_examples: sample(zeroCrawledWithoutError),
  representative_zero_match_examples: representativeSample.slice(0, 36),
  high_priority_inspection_queue_count: highPriorityInspectionQueue.length,
  high_priority_inspection_queue_examples: sample(highPriorityInspectionQueue, 30),
};

const deeperDryRunRecommendation = {
  recommended_before_gate3: false,
  recommended_before_final_production_readiness: true,
  recommended_after_phase7_as_post_phase_coverage_improvement: true,
  reason:
    "Gate 2 found no DB/ingest structural blocker, but max=1 cannot prove absence of scholarship notices deeper in source lists.",
  safe_scopes: [
    {
      name: "failure-and-zero-crawled-probe",
      source_count: explicitFailures.length + zeroCrawledWithoutError.length,
      source_keys: [...explicitFailures, ...zeroCrawledWithoutError].map((source) => source.sourceId),
      suggested_max_items_per_source: 3,
      purpose: "Separate transient failures, dead URLs, selector/config issues, and empty-list behavior.",
    },
    {
      name: "high-priority-zero-match-sample",
      source_count: Math.min(highPriorityInspectionQueue.length, 52),
      source_keys: highPriorityInspectionQueue.slice(0, 52).map((source) => source.sourceId),
      suggested_max_items_per_source: 5,
      purpose: "Inspect weak/heuristic/adapter and zero-crawled groups without crawling all 613 sources.",
    },
    {
      name: "representative-parser-strategy-sample",
      source_count: Math.min(representativeSample.length, 36),
      source_keys: representativeSample.slice(0, 36).map((source) => source.source_key),
      suggested_max_items_per_source: 5,
      purpose: "Compare match lift across parser strategies before a broader crawl.",
    },
  ],
  command_template_powershell:
    "$env:CRAWL_MAX_ITEMS_PER_SOURCE='5'; $env:CRAWL_SOURCE_CONCURRENCY='2'; $env:CRAWL_IGNORE_SEEN='true'; $env:CRAWL_LOOKBACK_DAYS='3650'; $env:CRAWL_SOURCE_ID_ALLOWLIST='<comma-separated-source-keys>'; node scripts/crawl-scholarship-notices.mjs data/notice-sources.csv exports/notices/roadmap-phase7-gate2-bounded-dry-run .crawler/roadmap-phase7-gate2-bounded-dry-run-state.json",
};

const analysis = {
  roadmap_phase: "Roadmap Phase 7 - Gate 2",
  result: "CONDITIONAL PASS",
  generated_at: new Date().toISOString(),
  latest_confirmed_pushed_commit_before_gate2: "24e76b7209c2ebe68da1585e209eefe4fe183a3f",
  inputs: {
    phase4_output: PHASE4_OUTPUT,
    funnel_json: FUNNEL_JSON,
    gate1_json: GATE1_JSON,
  },
  safety: {
    db_write_executed: false,
    raw_or_arbitrary_supabase_sql_executed: false,
    cleanup_sql_executed: false,
    production_main_supabase_accessed: false,
    bounded_dry_run_executed: false,
    phase6_rerun_executed: false,
  },
  source_level_funnel: sourceLevelFunnel,
  zero_match_classification: zeroMatchClassification,
  observation_depth_analysis: {
    crawl_max_items_per_source: 1,
    max_1_proved: [
      "The crawler could cover the 613-row source inventory locally.",
      "606 sources yielded at least one crawled list/detail item.",
      "The keyword/date matching and local report output path worked on shallow observed data.",
      "179 sources produced at least one scholarship-matched item.",
    ],
    max_1_did_not_prove: [
      "Absence of scholarship notices deeper in pagination.",
      "False-negative rate across zero-match sources.",
      "Lifecycle or deletion safety for failure and zero-crawled sources.",
      "National coverage completeness.",
    ],
    expected_effect_of_max_3_or_5:
      "Increasing max items can reveal scholarship notices when the first observed list item is non-scholarship, increase duplicate/provenance groups, and expose parser/detail extraction weaknesses without requiring schema changes.",
    current_pipeline_supports_deeper_output_without_schema_changes: true,
    canonical_key_stability_risk: "low_to_moderate",
    duplicate_handling_risk: "moderate",
    source_result_reporting_risk: "low",
    ingest_executor_assumption_risk: "low_for_dry_run_and_planning",
  },
  false_negative_risk_assessment: {
    overall_severity: "medium_high_for_coverage_claims",
    title_body_keyword_matching: "Existing artifacts cannot prove misses where the first crawled item used non-scholarship wording or where body extraction was weak.",
    shallow_observation: "High: max=1 is the largest known limitation for zero-match interpretation.",
    selector_content_extraction: "Medium: five zero-crawled/no-error sources are possible selector/config/source-health issues.",
    pagination: "High until max=3 or max=5 bounded dry-runs compare match lift.",
    source_structure_diversity: "Medium: zero-match sources span configured selector, common board, heuristic, and adapter paths.",
    no_assets_body_quality: "Operational/review risk, not a Gate 2 ingest-structure blocker.",
  },
  pipeline_structure_risk_assessment: {
    db_ingest_structure_blocker_found: false,
    remaining_risk_is_primarily_coverage_observation_quality: true,
    data_pipeline_structurally_validated_while_coverage_continues: "conditional_yes",
    rationale:
      "Phase 6 applied clean84 through the normalized personal-dev ingest path. Phase 4's conditional risk is explained by shallow observation and source-health uncertainty, not by schema/executor incompatibility.",
  },
  mitigation_performed: [
    "Added a reproducible local-only Gate 2 analysis script.",
    "Generated a machine-readable coverage/observation risk JSON fixture.",
    "Generated a Gate 2 Markdown report that distinguishes no match observed from no scholarship exists.",
    "Generated an ignored local source-health queue report for bounded deeper dry-run planning.",
    "Documented bounded max=3/max=5 dry-run scopes instead of running an uncontrolled full deep crawl.",
  ],
  deeper_dry_run_recommendation: deeperDryRunRecommendation,
  carry_forward_risks: {
    gate3: [
      "duplicate/review 82",
      "quality-review 13",
      "no_assets 48 applied candidates",
      "cleanup/rollback procedure",
      "aggregate batch observability",
      "final production readiness decision",
    ],
    post_phase: [
      "Run bounded deeper dry-runs for failure/zero-crawled and high-priority zero-match samples.",
      "Compare max=1 vs max=3/max=5 match lift before any national coverage claim.",
      "Investigate 434 zero-match sources as no-match-observed, not no-scholarship-exists.",
      "Improve source-health queues for repeated failures and selector/config drift.",
    ],
    hold: [],
  },
  decision: {
    gate2_can_close: true,
    phase7_gate3_can_begin_next: true,
    result_reason:
      "No DB/ingest structural blocker was found, but zero-match classification remains partial and deeper observation is required before final production readiness.",
  },
};

const healthQueue = {
  generated_at: analysis.generated_at,
  source: "Roadmap Phase 7 Gate 2 local-only analysis",
  safety: analysis.safety,
  high_priority_inspection_queue_count: highPriorityInspectionQueue.length,
  high_priority_inspection_queue: sample(highPriorityInspectionQueue, highPriorityInspectionQueue.length),
  failure_and_zero_crawled_probe: sample([...explicitFailures, ...zeroCrawledWithoutError], 20),
  bounded_dry_run_recommendation: deeperDryRunRecommendation,
};

const markdown = `# Crawler Roadmap Phase 7 Gate 2 Coverage Observation Risk

Roadmap Phase 7 - Gate 2 result: **${analysis.result}**.

Gate 2 analyzed the coverage and observation-quality risks left by Phase 4. It did not rerun Phase 6, did not write to DB, did not apply new crawl output, did not execute raw/arbitrary Supabase SQL, did not run cleanup SQL, did not access production/main Supabase, and did not run an uncontrolled deep crawl.

## Executive Summary

| Question | Answer |
| --- | --- |
| Gate 2 result | ${analysis.result} |
| Gate 3 can begin next | yes |
| Does Phase 4 conditional risk block data pipeline confirmation? | no |
| Is national coverage completeness proven? | no |
| Is the remaining risk primarily coverage/observation quality? | yes |
| Was a bounded dry-run executed in Gate 2? | false |

Phase 4's \`CRAWL_MAX_ITEMS_PER_SOURCE=1\` made the observed output intentionally shallow. It proved that the crawler could cover the source inventory and collect/match at least one observed item for many sources, but it did not prove that zero-match sources lack scholarship notices deeper in pagination.

The 434 zero-match sources should be interpreted as **no scholarship match observed in the shallow run**, not as **no scholarship notice exists**.

Phase 6 already validated the guarded normalized personal-dev ingest mechanics for 84 clean candidates from 84 distinct source keys. Gate 2 found no evidence that the Phase 4 conditional risk is a DB/schema/ingest executor structure blocker.

## Source-Level Funnel Recap

${table([
  ["Metric", "Value"],
  ["---", "---"],
  ["canonical sources", String(sourceLevelFunnel.canonical_sources)],
  ["covered sources", String(sourceLevelFunnel.covered_sources)],
  ["crawled at least one item", String(sourceLevelFunnel.crawled_at_least_one_item)],
  ["explicit failures", String(sourceLevelFunnel.explicit_failures)],
  ["zero-crawled without explicit error", String(sourceLevelFunnel.zero_crawled_without_explicit_error)],
  ["matched source count", String(sourceLevelFunnel.matched_source_count)],
  ["zero-match source count", String(sourceLevelFunnel.zero_match_source_count)],
  ["Phase 6 candidate source count", String(sourceLevelFunnel.phase6_candidate_source_count)],
])}

## Zero-Match Source Classification

### Counts

${table([
  ["Classification", "Count", "Confidence"],
  ["---", "---", "---"],
  ["explicit crawler failure", String(zeroMatchClassification.confirmed_explicit_failure), "confirmed"],
  ["zero-crawled without explicit error", String(zeroMatchClassification.zero_crawled_without_explicit_error), "confirmed observation; root cause not proven"],
  ["crawled but no scholarship match observed", String(zeroMatchClassification.crawled_but_no_scholarship_match_observed), "confirmed observation; root cause not proven"],
  ["confirmed no recent scholarship notice", "0", "not provable from existing artifacts"],
  ["likely selector/config mismatch", String(zeroMatchClassification.likely_selector_or_config_mismatch.count), "possible, not proven"],
  ["confirmed matching false negative", "0", "not provable from existing artifacts"],
  ["potential false-negative risk", String(zeroMatchClassification.likely_matching_false_negative.potential_risk_count), "risk category"],
  ["explicit unsupported source structure", "0", "no explicit label in artifacts"],
  ["needs deeper inspection", String(zeroMatchClassification.needs_deeper_inspection), "required before coverage claim"],
])}

### Parser Strategy Distribution

${table([
  ["Parser strategy", "Zero-match sources"],
  ["---", "---"],
  ...Object.entries(zeroMatchClassification.by_parser_strategy).map(([key, value]) => [key, String(value)]),
])}

### Representative Examples

Explicit failure examples:

${zeroMatchClassification.explicit_failure_examples.map((source) => `- \`${source.source_key}\`: ${source.error}`).join("\n")}

Zero-crawled/no-error examples:

${zeroMatchClassification.zero_crawled_without_error_examples
  .map((source) => `- \`${source.source_key}\`: parser=${source.parser_strategy}`)
  .join("\n")}

High-priority inspection queue count: **${zeroMatchClassification.high_priority_inspection_queue_count}**.

This queue combines explicit failures, zero-crawled/no-error sources, heuristic-parser zero-match sources, adapter zero-match sources, and parser-missing zero-match sources. It is a prioritization queue, not proof that every listed source is broken.

## Observation Depth Analysis

### Impact Of CRAWL_MAX_ITEMS_PER_SOURCE=1

Max=1 proved:

${analysis.observation_depth_analysis.max_1_proved.map((item) => `- ${item}`).join("\n")}

Max=1 did not prove:

${analysis.observation_depth_analysis.max_1_did_not_prove.map((item) => `- ${item}`).join("\n")}

Increasing max items per source to 3 or 5 may reveal scholarship notices where the first observed item was unrelated, increase duplicate/provenance groups, and expose parser/detail extraction weaknesses. The current crawler already supports \`CRAWL_MAX_ITEMS_PER_SOURCE\`, and the normalized ingest path can receive deeper observed output through the existing dry-run and planning layers without a schema change.

## False-Negative Risk Assessment

${table([
  ["Risk", "Conclusion"],
  ["---", "---"],
  ["overall severity", analysis.false_negative_risk_assessment.overall_severity],
  ["title/body keyword matching", analysis.false_negative_risk_assessment.title_body_keyword_matching],
  ["shallow observation", analysis.false_negative_risk_assessment.shallow_observation],
  ["selector/content extraction", analysis.false_negative_risk_assessment.selector_content_extraction],
  ["pagination", analysis.false_negative_risk_assessment.pagination],
  ["source structure diversity", analysis.false_negative_risk_assessment.source_structure_diversity],
  ["no_assets/body quality", analysis.false_negative_risk_assessment.no_assets_body_quality],
])}

## Pipeline Structure Risk Assessment

${table([
  ["Question", "Answer"],
  ["---", "---"],
  ["Does current evidence suggest a DB/ingest structure blocker?", "no"],
  ["Does current evidence suggest the remaining risk is primarily coverage/observation quality?", "yes"],
  ["Can the data pipeline be considered structurally validated while coverage improvement continues?", "conditional yes"],
])}

Rationale: ${analysis.pipeline_structure_risk_assessment.rationale}

## Mitigation Performed

${analysis.mitigation_performed.map((item) => `- ${item}`).join("\n")}

No bounded crawler dry-run was executed in Gate 2 because the existing Phase 4 artifacts are sufficient to classify the risk type, and an uncontrolled full deep crawl is explicitly out of scope. The safe next mitigation is a bounded max=3/max=5 dry-run against the queues below.

## Deeper Dry-Run Recommendation

Recommended before Gate 3: **no**.

Recommended before final production readiness: **yes**.

Recommended after Phase 7 as post-phase coverage improvement: **yes**.

Safe scopes:

${analysis.deeper_dry_run_recommendation.safe_scopes
  .map(
    (scope) =>
      `- ${scope.name}: ${scope.source_count} sources, max=${scope.suggested_max_items_per_source}. ${scope.purpose}`,
  )
  .join("\n")}

Command template:

\`\`\`powershell
${analysis.deeper_dry_run_recommendation.command_template_powershell}
\`\`\`

## Carry-Forward Risks

### Gate 3

${analysis.carry_forward_risks.gate3.map((item) => `- ${item}`).join("\n")}

### Post-Phase

${analysis.carry_forward_risks.post_phase.map((item) => `- ${item}`).join("\n")}

## Gate 2 Decision

Roadmap Phase 7 - Gate 2 result: **${analysis.result}**.

Decision reason: ${analysis.decision.result_reason}

Roadmap Phase 7 - Gate 3 can begin next: **yes**.
`;

for (const filePath of [OUT_JSON, OUT_REPORT, OUT_HEALTH]) {
  fs.mkdirSync(path.dirname(path.resolve(ROOT, filePath)), { recursive: true });
}

fs.writeFileSync(path.resolve(ROOT, OUT_JSON), `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
fs.writeFileSync(path.resolve(ROOT, OUT_HEALTH), `${JSON.stringify(healthQueue, null, 2)}\n`, "utf8");
fs.writeFileSync(path.resolve(ROOT, OUT_REPORT), markdown, "utf8");

console.log(`gate2_result=${analysis.result}`);
console.log(`zero_match_sources=${zeroMatchClassification.total_zero_match_sources}`);
console.log(`high_priority_inspection_queue=${zeroMatchClassification.high_priority_inspection_queue_count}`);
console.log(`wrote=${OUT_JSON}`);
console.log(`wrote=${OUT_REPORT}`);
console.log(`wrote=${OUT_HEALTH}`);
