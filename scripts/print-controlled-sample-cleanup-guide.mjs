#!/usr/bin/env node

import path from "node:path";

const fixture = {
  source_key: "yonsei_060",
  canonical_key: "yonsei_060:url:e74c29f4562cf52025d9",
  rehearsal_label: "controlled-sample-phase2-retry-20260709",
  run_id: "f14548e7-7bc2-4244-94b5-69b431aa67f7",
  notice_id: 3,
  occurrence_id: 2,
  expected_org_unit_id: 46,
};

const expectedCounts = {
  crawler_runs: 1,
  crawler_source_results: 1,
  crawler_notices: 1,
  crawler_notice_url_aliases: 1,
  crawler_notice_occurrences: 1,
  crawler_notice_targets: 1,
  crawler_notice_assets: 1,
  crawler_errors: 1,
  crawler_keyword_matches: 1,
};

const files = {
  phase4_doc: "docs/crawler-controlled-sample-apply-phase4-cleanup-readiness.md",
  audit_sql: "sql/drafts/crawler-guarded-sample-apply-audit-checks.review.sql",
  cleanup_sql: "sql/drafts/crawler-guarded-sample-apply-cleanup.review.sql",
};

const report = {
  local_only: true,
  db_write_executed: false,
  supabase_sql_executed: false,
  real_apply_executed: false,
  cleanup_executed: false,
  fixture,
  expected_counts: expectedCounts,
  files: Object.fromEntries(
    Object.entries(files).map(([key, value]) => [key, path.resolve(value)])
  ),
  sequence: [
    "Review the Phase 4 cleanup readiness doc.",
    "Run the audit SQL manually only in personal dev, if approved by the user.",
    "Review cleanup SQL counts with the default ROLLBACK.",
    "Change ROLLBACK to COMMIT only after explicit manual approval.",
    "Rerun the post-cleanup count query and confirm all scoped counts are zero.",
  ],
  no_go: [
    "full crawl",
    "real crawler-output ingest",
    "production/main Supabase",
    "cleanup execution by Codex",
    "live DB action by Codex",
  ],
};

function printTextGuide() {
  console.log("controlled_sample_cleanup_guide=local_only");
  console.log(`db_write_executed=${report.db_write_executed}`);
  console.log(`supabase_sql_executed=${report.supabase_sql_executed}`);
  console.log(`real_apply_executed=${report.real_apply_executed}`);
  console.log(`cleanup_executed=${report.cleanup_executed}`);
  console.log("");
  console.log("fixture:");
  for (const [key, value] of Object.entries(fixture)) {
    console.log(`  ${key}=${value}`);
  }
  console.log("");
  console.log("expected_counts:");
  for (const [table, count] of Object.entries(expectedCounts)) {
    console.log(`  ${table}=${count}`);
  }
  console.log("");
  console.log("files:");
  for (const [key, value] of Object.entries(report.files)) {
    console.log(`  ${key}=${value}`);
  }
  console.log("");
  console.log("sequence:");
  for (const step of report.sequence) {
    console.log(`  - ${step}`);
  }
  console.log("");
  console.log("no_go:");
  for (const item of report.no_go) {
    console.log(`  - ${item}`);
  }
}

const args = new Set(process.argv.slice(2));
if (args.has("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printTextGuide();
}
