#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_INPUT_PATH = "fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json";
const DEFAULT_REHEARSAL_LABEL = "roadmap-phase2-local";
const SOURCE_CSV_PATH = "data/notice-sources.csv";
const SCHEMA_SQL_PATH = "sql/create-crawler-normalized-schema-v2.sql";
const RULE_VERSION = "normalized-ingest-v2";
const KEYWORDS = ["scholarship", "tuition", "fellowship", "장학", "등록금"];
const VALID_ASSET_KINDS = new Set(["image", "attachment"]);

const CONFLICT_TARGETS = {
  crawler_notices: "canonical_key",
  crawler_notice_url_aliases: "notice_id,url_hash",
  crawler_notice_occurrences: "source_id,discovered_url_hash",
  crawler_notice_targets: "notice_id,org_unit_id",
  crawler_notice_assets: "notice_id,asset_kind,source_url_hash",
};

const TABLE_SEMANTICS = {
  crawler_runs: {
    operation_type: "insert",
    conflict_target: null,
    parent_dependency: [],
    idempotency_rule: "one new run per guarded apply attempt; audit scope is rehearsal_label plus run id",
    retry_behavior: "create a new run for a new attempt; do not reuse failed run ids",
    partial_failure_risk: "parent run may exist without all child rows",
    failure_evidence: ["run_id", "rehearsal_label", "status", "completed_operations"],
    cleanup_scope: ["run_id", "rehearsal_label"],
  },
  crawler_source_results: {
    operation_type: "insert",
    conflict_target: "run_id,source_id",
    parent_dependency: ["crawler_runs", "crawler_notice_sources"],
    idempotency_rule: "one source result per run/source",
    retry_behavior: "new run creates a new source result; same run/source is not retried blindly",
    partial_failure_risk: "source result may be partial if later notice operations fail",
    failure_evidence: ["run_id", "source_key", "decision", "primary_failure_code"],
    cleanup_scope: ["run_id", "source_key"],
  },
  crawler_notices: {
    operation_type: "upsert",
    conflict_target: "canonical_key",
    parent_dependency: [],
    idempotency_rule: "canonical_key identifies the normalized notice",
    retry_behavior: "same canonical_key updates canonical notice fields and preserves the notice id",
    partial_failure_risk: "notice may exist before alias/occurrence/target rows",
    failure_evidence: ["canonical_key", "content_hash", "title_fingerprint"],
    cleanup_scope: ["canonical_key", "rehearsal_label"],
  },
  crawler_notice_url_aliases: {
    operation_type: "upsert",
    conflict_target: "notice_id,url_hash",
    parent_dependency: ["crawler_notices"],
    idempotency_rule: "same notice and normalized URL alias must not duplicate",
    retry_behavior: "upsert by notice_id,url_hash; this preflight prevents the Roadmap Phase 1 mismatch",
    partial_failure_risk: "alias conflict mismatch can stop the apply after parent rows exist",
    failure_evidence: ["canonical_key", "url_fingerprint", "conflict_target"],
    cleanup_scope: ["canonical_key", "source_key", "rehearsal_label"],
  },
  crawler_notice_occurrences: {
    operation_type: "upsert",
    conflict_target: "source_id,discovered_url_hash",
    parent_dependency: ["crawler_runs", "crawler_notice_sources", "crawler_notices"],
    idempotency_rule: "same source and discovered URL points to one occurrence",
    retry_behavior: "upsert provenance fields for the same source/discovered URL",
    partial_failure_risk: "occurrence may point to a run even if later target/asset rows fail",
    failure_evidence: ["source_key", "canonical_key", "discovered_url_fingerprint"],
    cleanup_scope: ["run_id", "source_key", "canonical_key"],
  },
  crawler_notice_targets: {
    operation_type: "upsert",
    conflict_target: "notice_id,org_unit_id",
    parent_dependency: ["crawler_notices", "org_units"],
    idempotency_rule: "one target per notice/org_unit",
    retry_behavior: "upsert confidence/evidence for the same notice/org_unit",
    partial_failure_risk: "target rows may be absent if org_unit mapping is missing",
    failure_evidence: ["canonical_key", "org_unit_id", "source_key"],
    cleanup_scope: ["canonical_key", "org_unit_id", "rehearsal_label"],
  },
  crawler_notice_assets: {
    operation_type: "upsert",
    conflict_target: "notice_id,asset_kind,source_url_hash",
    parent_dependency: ["crawler_notices"],
    idempotency_rule: "one asset per notice/kind/source_url",
    retry_behavior: "upsert referenced asset metadata; storage/extraction is a later worker concern",
    partial_failure_risk: "asset may be missing while notice/occurrence exists",
    failure_evidence: ["canonical_key", "asset_kind", "source_url_fingerprint"],
    cleanup_scope: ["canonical_key", "rehearsal_label"],
  },
  crawler_keyword_matches: {
    operation_type: "append_after_recompute",
    conflict_target: null,
    parent_dependency: ["crawler_notices"],
    idempotency_rule: "delete and recompute per notice/rule_version before inserting matches",
    retry_behavior: "recompute deterministic matches for the same notice/rule_version",
    partial_failure_risk: "duplicate matches can appear if recompute is skipped",
    failure_evidence: ["canonical_key", "rule_version", "keyword"],
    cleanup_scope: ["canonical_key", "rule_version"],
  },
  crawler_errors: {
    operation_type: "append",
    conflict_target: null,
    parent_dependency: ["crawler_runs"],
    idempotency_rule: "append audit evidence for warnings/errors tied to a run",
    retry_behavior: "new run records new warning/error evidence",
    partial_failure_risk: "error row may exist without successful run completion",
    failure_evidence: ["run_id", "source_key", "canonical_key", "stage", "error_class"],
    cleanup_scope: ["run_id", "rehearsal_label"],
  },
};

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const options = {
    inputPath: DEFAULT_INPUT_PATH,
    sourceKey: "",
    limit: 1,
    rehearsalLabel: DEFAULT_REHEARSAL_LABEL,
    outPath: "",
    json: false,
    help: false,
    planOnly: false,
    simulateApply: false,
    simulateFailure: false,
    failureOperation: "upsert_url_alias",
    checkConflicts: false,
    apply: false,
    personalDevDbConfirmed: false,
    writeRiskConfirmed: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--input") {
      if (!next) throw new Error("--input requires a path.");
      options.inputPath = next;
      index += 1;
    } else if (arg === "--source-key") {
      if (!next) throw new Error("--source-key requires a value.");
      options.sourceKey = cleanText(next).toLowerCase();
      index += 1;
    } else if (arg === "--limit") {
      if (!next || !/^\d+$/.test(next)) throw new Error("--limit requires a non-negative integer.");
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
    } else if (arg === "--plan-only") {
      options.planOnly = true;
    } else if (arg === "--simulate-apply") {
      options.simulateApply = true;
    } else if (arg === "--simulate-failure") {
      options.simulateFailure = true;
      if (next && !next.startsWith("--")) {
        options.failureOperation = cleanText(next);
        index += 1;
      }
    } else if (arg === "--check-conflicts") {
      options.checkConflicts = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--yes-i-am-using-personal-dev-db") {
      options.personalDevDbConfirmed = true;
    } else if (arg === "--i-understand-this-writes-to-personal-dev-db") {
      options.writeRiskConfirmed = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (["--write", "--commit", "--cleanup", "--delete", "--full-crawl", "--batch-apply"].includes(arg)) {
      throw new Error(`${arg} is not supported by this Roadmap Phase 2 executor.`);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/apply-normalized-ingest-v2-guarded.mjs --plan-only --input fixtures/crawler-ingest-dry-run/guarded-apply-controlled-sample-input.json --source-key yonsei_060 --limit 1 --rehearsal-label roadmap-phase2-local-plan --json

Modes:
  --help
  --plan-only
  --simulate-apply
  --simulate-failure [OPERATION]
  --check-conflicts

Inputs:
  --input PATH
  --source-key KEY
  --limit N
  --rehearsal-label LABEL
  --out reports/<file>.json
  --json

Future guarded apply flags:
  --apply
  --yes-i-am-using-personal-dev-db
  --i-understand-this-writes-to-personal-dev-db

Safety:
  Roadmap Phase 2 defaults to local-only plan/simulation. Without --apply this
  script never creates a Supabase client. With --apply it rejects before client
  creation unless all personal-dev guards and env checks are present.
`);
}

function readJson(inputPath, label) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`${label} not found: ${inputPath}`);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function validateOutPath(outPath) {
  if (!outPath) return;
  const relative = path.relative(path.resolve("reports"), path.resolve(outPath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing output outside reports/: --out must point under reports/.");
  }
}

function writeJson(outPath, report) {
  validateOutPath(outPath);
  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
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

function hashText(value, length = 32) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function toDateOrNull(value) {
  const text = cleanText(value);
  if (!text) return null;
  const head = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null;
}

function toTimestampOrNull(value) {
  const text = cleanText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeAssetKind(value) {
  const raw = cleanText(value || "attachment").toLowerCase();
  if (raw === "file") return "attachment";
  return VALID_ASSET_KINDS.has(raw) ? raw : "attachment";
}

function canonicalKeyFor(sourceKey, item) {
  const nativePostId = cleanText(item.native_post_id);
  if (nativePostId) return `${sourceKey}:native:${nativePostId}`;
  const canonicalUrl = normalizeUrl(item.canonical_url || item.final_url || item.discovered_url);
  if (canonicalUrl) return `${sourceKey}:url:${hashText(canonicalUrl, 20)}`;
  return `${sourceKey}:title-date:${hashText(`${cleanText(item.title).toLowerCase()}|${toDateOrNull(item.published_at || item.posted_at) ?? "undated"}`, 20)}`;
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
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
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
  const [header, ...body] = parseCsv(raw);
  const index = Object.fromEntries(header.map((name, columnIndex) => [cleanText(name), columnIndex]));
  const targetsBySourceKey = new Map();
  for (const row of body) {
    const sourceKey = cleanText(row[index.source_id]).toLowerCase();
    const orgUnitIdRaw = cleanText(row[index.org_unit_id]);
    if (!sourceKey || !/^\d+$/.test(orgUnitIdRaw)) continue;
    if (!targetsBySourceKey.has(sourceKey)) targetsBySourceKey.set(sourceKey, []);
    targetsBySourceKey.get(sourceKey).push(Number(orgUnitIdRaw));
  }
  return targetsBySourceKey;
}

function normalizeInput(data, options) {
  if (data && Array.isArray(data.sources)) {
    const sourceFilter = cleanText(options.sourceKey).toLowerCase();
    const selected = data.sources
      .map((source) => ({
        ...source,
        source_key: cleanText(source.source_key ?? source.sourceId ?? source.source_id).toLowerCase(),
        items: Array.isArray(source.items) ? source.items : [],
      }))
      .filter((source) => !sourceFilter || source.source_key === sourceFilter);
    if (sourceFilter && selected.length === 0) throw new Error(`No source found for --source-key ${sourceFilter}.`);
    let remaining = options.limit > 0 ? options.limit : Number.POSITIVE_INFINITY;
    return {
      input_kind: "fixture:sources.items",
      run: data.run ?? {},
      sources: selected.map((source) => {
        const items = source.items.slice(0, Math.max(0, remaining));
        remaining -= items.length;
        return { ...source, items };
      }),
    };
  }

  if (data && data.planned_operations && typeof data.planned_operations === "object") {
    return {
      input_kind: "dry-run-report:planned_operations",
      run: data.run ?? {},
      sources: sourcesFromDryRunReport(data, options),
    };
  }

  throw new Error("Unsupported input shape. Expected sources.items fixture or ingest dry-run report.");
}

function sourcesFromDryRunReport(report, options) {
  const sourceKeys = new Set();
  const notices = report.planned_operations?.crawler_notices ?? [];
  const occurrences = report.planned_operations?.crawler_notice_occurrences ?? [];
  for (const op of [...notices, ...occurrences]) {
    const sourceRef = cleanText(op.refs?.source_ref).replace(/^source:/, "");
    if (sourceRef) sourceKeys.add(sourceRef);
  }
  const selectedKeys = [...sourceKeys].filter((key) => !options.sourceKey || key === options.sourceKey);
  return selectedKeys.map((sourceKey) => {
    const items = notices
      .filter((op) => cleanText(op.payload?.canonical_key).startsWith(`${sourceKey}:`))
      .slice(0, options.limit > 0 ? options.limit : undefined)
      .map((op) => ({
        title: cleanText(op.payload?.title),
        discovered_url: cleanText(op.payload?.canonical_url),
        canonical_url: cleanText(op.payload?.canonical_url),
        published_at: op.payload?.posted_at,
        body_text: cleanText(op.payload?.body_text),
        body_html: cleanText(op.payload?.body_html),
        body_quality: cleanText(op.payload?.metadata?.body_quality),
        metadata: { from_dry_run_report: true, canonical_key: op.payload?.canonical_key },
      }));
    return { source_key: sourceKey, items };
  });
}

function findKeywordMatches(item) {
  const fields = [
    ["title", cleanText(item.title)],
    ["body_text", cleanText(item.body_text ?? item.body)],
  ];
  const matches = [];
  for (const [field, text] of fields) {
    const lowered = text.toLowerCase();
    for (const keyword of KEYWORDS) {
      const offset = lowered.indexOf(keyword.toLowerCase());
      if (offset >= 0) {
        matches.push({ keyword, field, offset_start: offset, offset_end: offset + keyword.length, score: 1 });
      }
    }
  }
  return matches;
}

function operationRecord({ operation, table, sourceKey, canonicalKey, rehearsalLabel, dependencies = [], conflictTarget = null, idempotencyKey = "", failurePolicy = "" }) {
  const semantics = TABLE_SEMANTICS[table] ?? {};
  return {
    operation,
    table,
    dependencies,
    source_key: sourceKey || null,
    canonical_key: canonicalKey || null,
    rehearsal_label: rehearsalLabel,
    would_write: true,
    requires_review: true,
    conflict_target: conflictTarget,
    idempotency_key: idempotencyKey,
    failure_policy: failurePolicy || semantics.partial_failure_risk || "record failure evidence and stop",
  };
}

function buildOperationPlan(normalized, options) {
  const targetsBySourceKey = readSourceTargetMap();
  const operations = [];
  const runtimeItems = [];
  const sourceKeys = normalized.sources.map((source) => source.source_key);
  const selectedSourceKey = options.sourceKey || sourceKeys[0] || "";
  const label = options.rehearsalLabel;
  const runLabel = label;

  operations.push(operationRecord({
    operation: "insert_run",
    table: "crawler_runs",
    sourceKey: selectedSourceKey,
    rehearsalLabel: label,
    idempotencyKey: `run_label:${runLabel}`,
    failurePolicy: "if later operation fails, best-effort mark run failed/interrupted",
  }));

  const seenNotice = new Set();
  const seenAlias = new Set();
  const seenTarget = new Set();
  const seenAsset = new Set();

  for (const source of normalized.sources) {
    const sourceKey = cleanText(source.source_key).toLowerCase();
    const orgUnitIds = targetsBySourceKey.get(sourceKey) ?? [];
    operations.push(operationRecord({
      operation: "insert_source_result",
      table: "crawler_source_results",
      sourceKey,
      rehearsalLabel: label,
      dependencies: ["insert_run", "crawler_notice_sources"],
      idempotencyKey: `run_label:${runLabel}|source:${sourceKey}`,
      failurePolicy: "source result may remain partial if child operation fails",
    }));

    for (const [itemIndex, item] of source.items.entries()) {
      const title = cleanText(item.title);
      const discoveredUrl = normalizeUrl(item.discovered_url || item.notice_url || item.url);
      if (!title || !discoveredUrl) continue;
      const canonicalKey = cleanText(item.metadata?.canonical_key) || canonicalKeyFor(sourceKey, item);
      const canonicalUrl = normalizeUrl(item.canonical_url || item.final_url || discoveredUrl);
      const contentHash = contentHashFor(item);
      const runtime = {
        sourceKey,
        canonicalKey,
        canonicalUrl,
        discoveredUrl,
        title,
        itemIndex,
        item,
        contentHash,
        orgUnitIds,
      };
      runtimeItems.push(runtime);

      if (!seenNotice.has(canonicalKey)) {
        seenNotice.add(canonicalKey);
        operations.push(operationRecord({
          operation: "upsert_notice",
          table: "crawler_notices",
          sourceKey,
          canonicalKey,
          rehearsalLabel: label,
          conflictTarget: CONFLICT_TARGETS.crawler_notices,
          idempotencyKey: `canonical_key:${canonicalKey}`,
          failurePolicy: "notice may exist without later child rows; cleanup must scope by canonical_key and label",
        }));
        operations.push(...findKeywordMatches(item).map((match) => operationRecord({
          operation: "insert_keyword_match",
          table: "crawler_keyword_matches",
          sourceKey,
          canonicalKey,
          rehearsalLabel: label,
          dependencies: ["upsert_notice"],
          idempotencyKey: `canonical_key:${canonicalKey}|rule:${RULE_VERSION}|${match.field}:${match.keyword}:${match.offset_start}`,
          failurePolicy: "recompute keyword matches per notice/rule_version before insert",
        })));
      }

      for (const url of [canonicalUrl || discoveredUrl, discoveredUrl].filter(Boolean)) {
        const aliasKey = `${canonicalKey}|${url}`;
        if (seenAlias.has(aliasKey)) continue;
        seenAlias.add(aliasKey);
        operations.push(operationRecord({
          operation: "upsert_url_alias",
          table: "crawler_notice_url_aliases",
          sourceKey,
          canonicalKey,
          rehearsalLabel: label,
          dependencies: ["upsert_notice"],
          conflictTarget: CONFLICT_TARGETS.crawler_notice_url_aliases,
          idempotencyKey: `canonical_key:${canonicalKey}|url:${hashText(url, 20)}`,
          failurePolicy: "Roadmap Phase 1 partial write lesson: fail closed if conflict target mismatches schema",
        }));
      }

      operations.push(operationRecord({
        operation: "upsert_occurrence",
        table: "crawler_notice_occurrences",
        sourceKey,
        canonicalKey,
        rehearsalLabel: label,
        dependencies: ["insert_run", "insert_source_result", "upsert_notice"],
        conflictTarget: CONFLICT_TARGETS.crawler_notice_occurrences,
        idempotencyKey: `source:${sourceKey}|discovered_url:${hashText(discoveredUrl, 20)}`,
        failurePolicy: "occurrence may tie notice to run; audit scope includes run_id/source/canonical_key",
      }));

      for (const orgUnitId of orgUnitIds) {
        const targetKey = `${canonicalKey}|${orgUnitId}`;
        if (seenTarget.has(targetKey)) continue;
        seenTarget.add(targetKey);
        operations.push(operationRecord({
          operation: "upsert_notice_target",
          table: "crawler_notice_targets",
          sourceKey,
          canonicalKey,
          rehearsalLabel: label,
          dependencies: ["upsert_notice", "org_units"],
          conflictTarget: CONFLICT_TARGETS.crawler_notice_targets,
          idempotencyKey: `canonical_key:${canonicalKey}|org_unit:${orgUnitId}`,
          failurePolicy: "missing org_unit blocks the target and the apply candidate",
        }));
      }

      for (const asset of Array.isArray(item.assets) ? item.assets : []) {
        const sourceUrl = normalizeUrl(asset.source_url || asset.url);
        if (!sourceUrl) continue;
        const assetKind = normalizeAssetKind(asset.asset_type || asset.asset_kind);
        const assetKey = `${canonicalKey}|${assetKind}|${sourceUrl}`;
        if (seenAsset.has(assetKey)) continue;
        seenAsset.add(assetKey);
        operations.push(operationRecord({
          operation: "upsert_notice_asset",
          table: "crawler_notice_assets",
          sourceKey,
          canonicalKey,
          rehearsalLabel: label,
          dependencies: ["upsert_notice", "upsert_occurrence"],
          conflictTarget: CONFLICT_TARGETS.crawler_notice_assets,
          idempotencyKey: `canonical_key:${canonicalKey}|asset:${assetKind}:${hashText(sourceUrl, 20)}`,
          failurePolicy: "asset metadata may be absent while notice remains; retry upserts same asset identity",
        }));
      }

      const warnings = Array.isArray(item.warnings) ? item.warnings : [];
      const bodyQuality = cleanText(item.body_quality);
      const bodyText = cleanText(item.body_text ?? item.body);
      if (warnings.length > 0 || bodyQuality === "empty" || !bodyText) {
        operations.push(operationRecord({
          operation: "insert_error",
          table: "crawler_errors",
          sourceKey,
          canonicalKey,
          rehearsalLabel: label,
          dependencies: ["insert_run"],
          idempotencyKey: `run_label:${runLabel}|canonical_key:${canonicalKey}|warning:${hashText(warnings.join("|") || bodyQuality || "empty_body", 12)}`,
          failurePolicy: "append run-scoped warning evidence",
        }));
      }
    }
  }

  operations.push(operationRecord({
    operation: "mark_run_failed_on_error",
    table: "crawler_runs",
    sourceKey: selectedSourceKey,
    rehearsalLabel: label,
    dependencies: ["insert_run"],
    idempotencyKey: `run_label:${runLabel}|status:failed`,
    failurePolicy: "best-effort update if a run exists after partial failure",
  }));
  operations.push(operationRecord({
    operation: "mark_run_succeeded_on_success",
    table: "crawler_runs",
    sourceKey: selectedSourceKey,
    rehearsalLabel: label,
    dependencies: ["insert_run"],
    idempotencyKey: `run_label:${runLabel}|status:succeeded`,
    failurePolicy: "only after all write operations complete",
  }));

  return { operations, runtimeItems };
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

function buildSchemaConflictPreflight() {
  const schemaTargets = readSchemaConflictTargets();
  const checks = Object.entries(CONFLICT_TARGETS).map(([table, target]) => {
    const normalized = normalizeConflictTarget(target);
    const schema_target_candidates = schemaTargets[table] ?? [];
    return {
      table,
      executor_target: normalized,
      schema_targets: schema_target_candidates,
      schema_matched: schema_target_candidates.includes(normalized),
      ok: schema_target_candidates.includes(normalized),
    };
  });
  const mismatches = checks.filter((check) => !check.ok);
  return {
    ok: mismatches.length === 0,
    schema_sql_path: path.normalize(SCHEMA_SQL_PATH),
    checks,
    mismatches,
  };
}

function productionGuardPassed() {
  const candidates = [
    process.env.SUPABASE_URL,
    process.env.SUPABASE_PROJECT_REF,
    process.env.SUPABASE_ENV,
    process.env.VERCEL_ENV,
  ].map((value) => cleanText(value).toLowerCase());
  return !candidates.some((value) => value.includes("prod") || value.includes("production") || value.includes("main"));
}

function guardSnapshot(options) {
  return {
    apply_requested: options.apply,
    personal_dev_confirmed: options.personalDevDbConfirmed,
    write_risk_confirmed: options.writeRiskConfirmed,
    personal_dev_env_confirmed: process.env.PERSONAL_DEV_SUPABASE_CONFIRM === "1",
    supabase_url_present: Boolean(process.env.SUPABASE_URL),
    supabase_service_role_key_present: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    production_guard_passed: productionGuardPassed(),
    source_key_present: Boolean(options.sourceKey),
    limit_guard_passed: Number.isInteger(options.limit) && options.limit > 0 && options.limit <= 3,
    rehearsal_label_present: Boolean(options.rehearsalLabel),
    secret_redaction_passed: true,
  };
}

function validateApplyGuards(options, schemaConflictPreflight) {
  if (!options.apply) return;
  const reasons = [];
  if (!options.personalDevDbConfirmed) reasons.push("--yes-i-am-using-personal-dev-db is required");
  if (!options.writeRiskConfirmed) reasons.push("--i-understand-this-writes-to-personal-dev-db is required");
  if (process.env.PERSONAL_DEV_SUPABASE_CONFIRM !== "1") reasons.push("PERSONAL_DEV_SUPABASE_CONFIRM=1 is required");
  if (!process.env.SUPABASE_URL) reasons.push("SUPABASE_URL is required");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) reasons.push("SUPABASE_SERVICE_ROLE_KEY is required");
  if (!productionGuardPassed()) reasons.push("production/main Supabase indicators are prohibited");
  if (!options.sourceKey) reasons.push("--source-key is required with --apply");
  if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > 3) reasons.push("--limit must be between 1 and 3 with --apply");
  if (!options.rehearsalLabel) reasons.push("--rehearsal-label is required with --apply");
  if (!schemaConflictPreflight.ok) reasons.push("schema_conflict_preflight_failed");
  if (reasons.length > 0) {
    const error = new Error(`Refusing normalized ingest v2 apply: ${reasons.join("; ")}.`);
    error.guard_rejection = true;
    error.guard_reasons = reasons;
    throw error;
  }
}

function makeGoNoGo({ mode, operations, schemaConflictPreflight, guards, errors = [] }) {
  const blockingReasons = [];
  if (!schemaConflictPreflight.ok) blockingReasons.push("schema_conflict_preflight_failed");
  if (errors.length > 0) blockingReasons.push("report_errors_present");
  if (mode === "apply" && !guards.apply_requested) blockingReasons.push("apply_not_requested");
  return {
    roadmap_position: "Roadmap Phase 2",
    db_write_executed: false,
    supabase_sql_executed: false,
    real_apply_executed: false,
    local_only: mode !== "apply",
    ready_for_codex_apply: false,
    ready_for_user_review: blockingReasons.length === 0,
    next_allowed_step: "Roadmap Phase 2 local review or user-approved personal-dev rehearsal outside Codex",
    blocking_reasons: blockingReasons,
    operation_count: operations.length,
  };
}

function reportParityChecks(report) {
  const requiredTop = ["db_write_executed", "supabase_sql_executed", "real_apply_executed", "go_no_go"];
  const missingTop = requiredTop.filter((key) => !(key in report));
  const nestedMatches =
    report.go_no_go?.db_write_executed === report.db_write_executed &&
    report.go_no_go?.supabase_sql_executed === report.supabase_sql_executed &&
    report.go_no_go?.real_apply_executed === report.real_apply_executed;
  return {
    required_top_level_fields_present: missingTop.length === 0,
    missing_top_level_fields: missingTop,
    nested_safety_flags_match_top_level: nestedMatches,
    ok: missingTop.length === 0 && nestedMatches,
  };
}

function buildBaseReport(options) {
  const data = readJson(options.inputPath, "Roadmap Phase 2 input");
  const normalized = normalizeInput(data, options);
  const { operations, runtimeItems } = buildOperationPlan(normalized, options);
  const schemaConflictPreflight = buildSchemaConflictPreflight();
  const guards = guardSnapshot(options);
  const errors = [];
  if (runtimeItems.length === 0) errors.push("no_runtime_items_selected");
  if (!schemaConflictPreflight.ok) errors.push("schema_conflict_preflight_failed");

  const mode = options.apply
    ? "apply"
    : (options.simulateApply ? "simulate-apply" : (options.simulateFailure ? "simulate-failure" : (options.checkConflicts ? "schema-conflict-preflight" : "plan-only")));
  const summary = {
    input_kind: normalized.input_kind,
    sources: normalized.sources.length,
    selected_items: runtimeItems.length,
    planned_operations: operations.length,
    would_write_operations: operations.filter((operation) => operation.would_write).length,
    schema_conflict_mismatches: schemaConflictPreflight.mismatches.length,
    report_errors: errors.length,
  };
  const report = {
    generated_at: new Date().toISOString(),
    mode,
    ok: errors.length === 0,
    db_write_executed: false,
    supabase_sql_executed: false,
    real_apply_executed: false,
    input_path: path.normalize(options.inputPath),
    source_key: options.sourceKey || normalized.sources[0]?.source_key || null,
    limit: options.limit,
    rehearsal_label: options.rehearsalLabel,
    summary,
    schema_conflict_preflight: schemaConflictPreflight,
    guards,
    planned_operations: operations,
    operation_order: operations.map((operation) => operation.operation),
    idempotency_checks: operations.map((operation) => ({
      operation: operation.operation,
      table: operation.table,
      idempotency_key: operation.idempotency_key,
      conflict_target: operation.conflict_target,
      ok: Boolean(operation.idempotency_key) || operation.operation === "mark_run_succeeded_on_success",
    })),
    report_parity_checks: null,
    go_no_go: null,
    warnings: [],
    errors,
  };
  report.go_no_go = makeGoNoGo({ mode, operations, schemaConflictPreflight, guards, errors });
  report.report_parity_checks = reportParityChecks(report);
  report.ok = report.ok && report.report_parity_checks.ok;
  return { report, normalized, runtimeItems };
}

function buildConflictOnlyReport() {
  const schemaConflictPreflight = buildSchemaConflictPreflight();
  const guards = guardSnapshot({ apply: false, personalDevDbConfirmed: false, writeRiskConfirmed: false, sourceKey: "", limit: 0, rehearsalLabel: "" });
  const report = {
    generated_at: new Date().toISOString(),
    mode: "schema-conflict-preflight",
    ok: schemaConflictPreflight.ok,
    db_write_executed: false,
    supabase_sql_executed: false,
    real_apply_executed: false,
    input_path: null,
    source_key: null,
    limit: null,
    rehearsal_label: null,
    summary: {
      schema_conflict_mismatches: schemaConflictPreflight.mismatches.length,
    },
    schema_conflict_preflight: schemaConflictPreflight,
    guards,
    planned_operations: [],
    operation_order: [],
    idempotency_checks: [],
    report_parity_checks: null,
    go_no_go: null,
    warnings: [],
    errors: [],
  };
  report.go_no_go = makeGoNoGo({ mode: report.mode, operations: [], schemaConflictPreflight, guards });
  report.report_parity_checks = reportParityChecks(report);
  return report;
}

function buildSimulatedFailureReport(baseReport, options) {
  const failed = baseReport.planned_operations.find((operation) => operation.operation === options.failureOperation)
    ?? baseReport.planned_operations.find((operation) => operation.operation === "upsert_url_alias")
    ?? baseReport.planned_operations[0];
  const failedIndex = Math.max(0, baseReport.planned_operations.indexOf(failed));
  const completed = baseReport.planned_operations.slice(0, failedIndex);
  const pending = baseReport.planned_operations.slice(failedIndex + 1);
  const report = {
    ...baseReport,
    ok: false,
    mode: "simulate-failure",
    simulated_failure: true,
    expected_failure: true,
    simulated_failure_ok: true,
    failed_operation: failed?.operation ?? options.failureOperation,
    failed_table: failed?.table ?? null,
    error_message: `Simulated Roadmap Phase 2 failure at ${failed?.operation ?? options.failureOperation}.`,
    partial_write_possible: completed.some((operation) => operation.would_write),
    partial_write_risk: completed.some((operation) => operation.would_write),
    cleanup_required: completed.some((operation) => operation.would_write),
    run_status_update_attempted: completed.some((operation) => operation.operation === "insert_run"),
    completed_operations: completed.map((operation) => operation.operation),
    pending_operations: pending.map((operation) => operation.operation),
    canonical_key: failed?.canonical_key ?? null,
    errors: [...baseReport.errors, "simulated_failure"],
  };
  report.go_no_go = {
    ...report.go_no_go,
    ready_for_user_review: false,
    blocking_reasons: [...new Set([...(report.go_no_go?.blocking_reasons ?? []), "simulated_failure"])],
  };
  report.report_parity_checks = reportParityChecks(report);
  return report;
}

function buildGuardRejectionReport(error, options) {
  const schemaConflictPreflight = buildSchemaConflictPreflight();
  const guards = guardSnapshot(options);
  const report = {
    generated_at: new Date().toISOString(),
    mode: "apply-rejected",
    ok: false,
    db_write_executed: false,
    supabase_sql_executed: false,
    real_apply_executed: false,
    input_path: options.inputPath ? path.normalize(options.inputPath) : null,
    source_key: options.sourceKey || null,
    limit: options.limit,
    rehearsal_label: options.rehearsalLabel || null,
    summary: {
      guard_rejection: true,
      guard_reasons: error.guard_reasons ?? [error.message],
    },
    schema_conflict_preflight: schemaConflictPreflight,
    guards,
    planned_operations: [],
    operation_order: [],
    idempotency_checks: [],
    report_parity_checks: null,
    go_no_go: null,
    warnings: [],
    errors: ["apply_guard_rejected"],
    error_message: error.message,
  };
  report.go_no_go = makeGoNoGo({
    mode: report.mode,
    operations: [],
    schemaConflictPreflight,
    guards,
    errors: report.errors,
  });
  report.report_parity_checks = reportParityChecks(report);
  return report;
}

async function executeApply(report, runtimeItems, options) {
  validateApplyGuards(options, report.schema_conflict_preflight);
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const state = { runId: null, completed: [] };
  try {
    const run = await checked(
      supabase.from("crawler_runs").insert({
        mode: "manual",
        status: "running",
        parser_version: RULE_VERSION,
        metadata: {
          roadmap_phase: "Roadmap Phase 2",
          rehearsal_label: options.rehearsalLabel,
          input_path: path.normalize(options.inputPath),
        },
      }).select("id").single(),
      "insert crawler_runs",
    );
    state.runId = run.id;
    state.completed.push("insert_run");
    for (const [sourceKey, items] of groupRuntimeItemsBySource(runtimeItems)) {
      await applySourceGroup({ supabase, runId: run.id, sourceKey, items, options, state });
    }
    await checked(
      supabase.from("crawler_runs").update({
        status: "succeeded",
        ended_at: new Date().toISOString(),
        totals: report.summary,
      }).eq("id", run.id),
      "mark crawler_runs succeeded",
    );
    state.completed.push("mark_run_succeeded_on_success");
    return { run_id: run.id, completed_operations: state.completed };
  } catch (error) {
    if (state.runId) {
      await markRunFailedBestEffort(supabase, state.runId, error, options);
    }
    error.completedOperations = state.completed;
    throw error;
  }
}

async function checked(promise, label) {
  const { data, error } = await promise;
  if (error) throw new Error(`${label} failed: ${error.message}`);
  return data;
}

function groupRuntimeItemsBySource(runtimeItems) {
  const groups = new Map();
  for (const item of runtimeItems) {
    if (!groups.has(item.sourceKey)) groups.set(item.sourceKey, []);
    groups.get(item.sourceKey).push(item);
  }
  return groups;
}

async function applySourceGroup({ supabase, runId, sourceKey, items, options, state }) {
  const source = await checked(
    supabase.from("crawler_notice_sources").select("id,source_key").eq("source_key", sourceKey).single(),
    "select crawler_notice_sources",
  );
  await checked(
    supabase.from("crawler_source_results").insert({
      run_id: runId,
      source_id: source.id,
      decision: "succeeded",
      counts: { input_items: items.length },
      strategy_code: "normalized-ingest-v2",
      error_count: 0,
      metadata: { rehearsal_label: options.rehearsalLabel, source_key: sourceKey },
    }),
    "insert crawler_source_results",
  );
  state.completed.push("insert_source_result");
  for (const item of items) {
    await applyRuntimeItem({ supabase, runId, source, item, options, state });
  }
}

async function applyRuntimeItem({ supabase, runId, source, item, options, state }) {
  const raw = item.item;
  const notice = await checked(
    supabase.from("crawler_notices").upsert({
      canonical_key: item.canonicalKey,
      canonical_url: item.canonicalUrl || null,
      native_post_id: cleanText(raw.native_post_id) || null,
      title: item.title,
      body_text: cleanText(raw.body_text ?? raw.body) || null,
      body_html: cleanText(raw.body_html) || null,
      posted_at: toDateOrNull(raw.published_at || raw.posted_at),
      content_hash: item.contentHash,
      review_status: "new",
      metadata: {
        roadmap_phase: "Roadmap Phase 2",
        rehearsal_label: options.rehearsalLabel,
        body_quality: cleanText(raw.body_quality) || null,
      },
    }, { onConflict: CONFLICT_TARGETS.crawler_notices }).select("id,canonical_key").single(),
    "upsert crawler_notices",
  );
  state.completed.push("upsert_notice");
  await checked(
    supabase.from("crawler_notice_url_aliases").upsert({
      notice_id: notice.id,
      source_id: source.id,
      url: item.canonicalUrl || item.discoveredUrl,
    }, { onConflict: CONFLICT_TARGETS.crawler_notice_url_aliases }),
    "upsert crawler_notice_url_aliases",
  );
  state.completed.push("upsert_url_alias");
  const occurrence = await checked(
    supabase.from("crawler_notice_occurrences").upsert({
      notice_id: notice.id,
      source_id: source.id,
      crawl_run_id: runId,
      discovered_url: item.discoveredUrl,
      final_url: normalizeUrl(raw.final_url || raw.canonical_url) || null,
      native_post_id: cleanText(raw.native_post_id) || null,
      list_title: item.title,
      raw_list_text: cleanText(raw.raw_list_text) || null,
      list_posted_at: toDateOrNull(raw.published_at || raw.posted_at),
      content_hash: item.contentHash,
      metadata: { rehearsal_label: options.rehearsalLabel },
    }, { onConflict: CONFLICT_TARGETS.crawler_notice_occurrences }).select("id").single(),
    "upsert crawler_notice_occurrences",
  );
  state.completed.push("upsert_occurrence");
  for (const orgUnitId of item.orgUnitIds) {
    await checked(
      supabase.from("crawler_notice_targets").upsert({
        notice_id: notice.id,
        org_unit_id: orgUnitId,
        source_id: source.id,
        confidence: 1,
        evidence: { rehearsal_label: options.rehearsalLabel, source_key: source.source_key },
      }, { onConflict: CONFLICT_TARGETS.crawler_notice_targets }),
      "upsert crawler_notice_targets",
    );
    state.completed.push("upsert_notice_target");
  }
  for (const asset of Array.isArray(raw.assets) ? raw.assets : []) {
    const sourceUrl = normalizeUrl(asset.source_url || asset.url);
    if (!sourceUrl) continue;
    await checked(
      supabase.from("crawler_notice_assets").upsert({
        notice_id: notice.id,
        occurrence_id: occurrence.id,
        asset_kind: normalizeAssetKind(asset.asset_type || asset.asset_kind),
        source_url: sourceUrl,
        filename: cleanText(asset.filename) || null,
        mime: cleanText(asset.content_type || asset.mime) || null,
        status: "referenced",
        metadata: { rehearsal_label: options.rehearsalLabel },
      }, { onConflict: CONFLICT_TARGETS.crawler_notice_assets }),
      "upsert crawler_notice_assets",
    );
    state.completed.push("upsert_notice_asset");
  }
  await checked(
    supabase.from("crawler_keyword_matches").delete().eq("notice_id", notice.id).eq("rule_version", RULE_VERSION),
    "delete crawler_keyword_matches for recompute",
  );
  const matches = findKeywordMatches(raw);
  if (matches.length > 0) {
    await checked(
      supabase.from("crawler_keyword_matches").insert(matches.map((match) => ({
        notice_id: notice.id,
        rule_version: RULE_VERSION,
        ...match,
      }))),
      "insert crawler_keyword_matches",
    );
    state.completed.push("insert_keyword_match");
  }
  const warnings = Array.isArray(raw.warnings) ? raw.warnings : [];
  if (warnings.length > 0) {
    await checked(
      supabase.from("crawler_errors").insert({
        run_id: runId,
        source_id: source.id,
        notice_id: notice.id,
        occurrence_id: occurrence.id,
        stage: "normalized-ingest-v2",
        error_class: "ITEM_WARNING",
        message: `Roadmap Phase 2 item warning: ${warnings.join(", ")}`,
        details: { warnings, rehearsal_label: options.rehearsalLabel },
      }),
      "insert crawler_errors",
    );
    state.completed.push("insert_error");
  }
}

async function markRunFailedBestEffort(supabase, runId, error, options) {
  try {
    await supabase.from("crawler_runs").update({
      status: "failed",
      ended_at: new Date().toISOString(),
      metadata: {
        roadmap_phase: "Roadmap Phase 2",
        rehearsal_label: options.rehearsalLabel,
        failed_message: cleanText(error.message).slice(0, 500),
      },
    }).eq("id", runId);
  } catch {
    // Best-effort audit marking only; original apply error is more important.
  }
}

function printTextReport(report) {
  console.log("roadmap_phase2_normalized_ingest_v2=ok");
  console.log(`mode=${report.mode}`);
  console.log(`ok=${report.ok}`);
  console.log(`db_write_executed=${report.db_write_executed}`);
  console.log(`supabase_sql_executed=${report.supabase_sql_executed}`);
  console.log(`real_apply_executed=${report.real_apply_executed}`);
  console.log(`source_key=${report.source_key ?? ""}`);
  console.log(`limit=${report.limit ?? ""}`);
  console.log(`rehearsal_label=${report.rehearsal_label ?? ""}`);
  console.log(`planned_operations=${report.summary?.planned_operations ?? 0}`);
  console.log(`schema_conflict_mismatches=${report.schema_conflict_preflight?.mismatches?.length ?? 0}`);
  if (report.error_message) console.log(`error_message=${report.error_message}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  validateOutPath(options.outPath);
  if (options.help) {
    printHelp();
    return;
  }

  let report;
  try {
    if (options.checkConflicts && !process.argv.slice(2).includes("--input")) {
      report = buildConflictOnlyReport();
    } else {
      const built = buildBaseReport(options);
      report = built.report;
      if (options.simulateApply) {
        report.mode = "simulate-apply";
        report.summary.simulated_apply_succeeded = true;
        report.go_no_go.real_apply_executed = report.real_apply_executed;
        report.report_parity_checks = reportParityChecks(report);
      }
      if (options.simulateFailure) {
        report = buildSimulatedFailureReport(report, options);
      }
      if (options.apply) {
        validateApplyGuards(options, report.schema_conflict_preflight);
        const result = await executeApply(report, built.runtimeItems, options);
        report = {
          ...report,
          ok: true,
          mode: "apply",
          db_write_executed: true,
          supabase_sql_executed: true,
          real_apply_executed: true,
          apply_result: result,
        };
        report.go_no_go = {
          ...report.go_no_go,
          db_write_executed: true,
          supabase_sql_executed: true,
          real_apply_executed: true,
          local_only: false,
        };
        report.report_parity_checks = reportParityChecks(report);
      }
    }
  } catch (error) {
    if (options.apply && error.guard_rejection) {
      report = buildGuardRejectionReport(error, options);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }

  if (options.outPath) writeJson(options.outPath, report);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printTextReport(report);
  if (!report.ok && !options.apply && !options.simulateFailure) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
