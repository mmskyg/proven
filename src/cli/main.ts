import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { ProvenError } from "../shared/errors.js";
import { SCHEMA_VERSION } from "../shared/types.js";
import { loadConfig, saveConfig } from "../shared/config.js";
import { requireInitialized, workspace, git } from "../store/paths.js";
import { runInit } from "./init.js";
import { runCapture, type HookInput } from "../capture/capture.js";
import { resolveAgent } from "../agents/index.js";
import { runIngest } from "../ingest/ingest.js";
import { renderTriageText, runTriage, writeTriageMd } from "../triage/triage.js";
import { confirmOrigin, recordFinding, renderAsk, runAsk } from "../ask/ask.js";
import { applyGuard, generateGuardPrompt, loadPolicy, policyInitTemplate, policyPath } from "../policy/policy.js";
import { runPrecheck } from "../policy/precheck.js";
import { rebuild } from "../store/projections.js";
import { rotate, verifyDecisionsChain, eventFileSize } from "../store/events.js";
import {
  evalCaptureState,
  evalTriageLog,
  exportProvenance,
  runMigrate,
  runPurge,
} from "../store/maintenance.js";
import { buildSpecIndex } from "../spec/index.js";
import { buildCasePack } from "../eval/cases.js";
import { runLlmJudge } from "../llm/run.js";
import { reportEval, submitJudgments } from "../eval/judgments.js";
import { ROTATE_SUGGEST_BYTES } from "../shared/types.js";

interface OutputCtx {
  json: boolean;
  warnings: string[];
}

function emitResult(ctx: OutputCtx, command: string, status: "ok" | "partial" | "error", data: unknown, humanLines: string[]): void {
  if (ctx.json) {
    process.stdout.write(JSON.stringify({ schema_version: SCHEMA_VERSION, command, status, data, warnings: ctx.warnings }) + "\n");
  } else {
    for (const l of humanLines) process.stdout.write(l + "\n");
    for (const w of ctx.warnings) process.stdout.write(`⚠ ${w}\n`);
  }
}

function fail(ctx: OutputCtx, command: string, e: unknown): never {
  const err = e instanceof ProvenError ? e : new ProvenError("input", String(e instanceof Error ? e.message : e));
  if (ctx.json) {
    process.stdout.write(
      JSON.stringify({ schema_version: SCHEMA_VERSION, command, status: "error", data: { message: err.message }, warnings: ctx.warnings }) + "\n",
    );
  } else {
    process.stderr.write(`error: ${err.message}\n`);
  }
  process.exit(err.exitCode);
}

function actorId(wsProvenDir: string, repoRoot: string): string {
  const cfg = loadConfig(wsProvenDir);
  if (cfg.reviewer_id) return cfg.reviewer_id;
  try {
    const email = git(repoRoot, ["config", "user.email"]).toString().trim();
    if (email) return email;
  } catch {
    /* fallthrough */
  }
  return "unknown";
}

const program = new Command();
program.name("proven").description("AIエージェントネイティブのレビュー用CLI").version("0.1.0");
program.configureOutput({ writeErr: (s) => process.stderr.write(s) });
program.exitOverride();

program
  .command("init")
  .description("プロジェクト初期化(F-01)")
  .option("--yes", "非対話で既定値を使用", false)
  .option("--agent <ids>", "登録するハーネスをカンマ区切りで明示(既定: 検出した全て)")
  .action((opts: { yes: boolean; agent?: string }) => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      const agents = opts.agent
        ? opts.agent
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      const r = runInit(ws, { yes: opts.yes, isTTY: process.stdout.isTTY ?? false, agents });
      emitResult(ctx, "init", "ok", r, [
        r.created ? ".proven/ を作成しました" : ".proven/ は既に存在します(再初期化)",
        ...r.messages,
      ]);
    } catch (e) {
      fail(ctx, "init", e);
    }
  });

program
  .command("capture")
  .description("hookからの編集イベント捕捉(F-02a)。常にexit 0")
  .requiredOption("--phase <phase>", "pre|post")
  .option("--agent <id>", "呼び出し元ハーネスの自己申告: claude-code|codex|opencode|generic")
  .action((opts: { phase: string; agent?: string }) => {
    // 絶対原則: 開発を止めない。どんな失敗でもexit 0
    try {
      const stdin = fs.readFileSync(0, "utf8");
      const input = JSON.parse(stdin) as HookInput;
      const phase = opts.phase === "post" ? "post" : "pre";
      // リポジトリ解決は編集ファイル基準(ネストしたgitリポジトリでcwd基準だと
      // 外側リポジトリへ誤帰属するため)。解決不能時のみcwdへフォールバック。
      // ファイルの在処はハーネスごとに異なる(codexはパッチ本文中)のでアダプタに解決させる
      const cwd = input.cwd ?? process.cwd();
      let rawFile: string | undefined;
      try {
        const resolved = resolveAgent({ declared: opts.agent ?? null, raw: input as Record<string, unknown> });
        rawFile = resolved.adapter.normalize(input as Record<string, unknown>, phase)?.files[0];
      } catch {
        /* 解決不能はcwdへフォールバック */
      }
      let ws;
      try {
        const abs = rawFile ? (path.isAbsolute(rawFile) ? rawFile : path.join(cwd, rawFile)) : cwd;
        ws = workspace(fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs));
      } catch {
        ws = workspace(cwd);
      }
      requireInitialized(ws);
      runCapture(ws, phase, input, { declaredAgent: opts.agent ?? null });
    } catch {
      /* logged inside; never block */
    }
    process.exit(0);
  });

program
  .command("ingest")
  .description("diff+編集イベントの取り込み(F-02b)")
  .option("--range <range>", "A..B形式のcommit範囲")
  .option("--json", "機械可読出力", false)
  .action((opts: { range?: string; json: boolean }) => {
    const ctx: OutputCtx = { json: opts.json, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const r = runIngest(ws, { range: opts.range });
      ctx.warnings = r.warnings;
      if (r.orphanPosts > 0) ctx.warnings.push(`孤児post ${r.orphanPosts}件`);
      const size = eventFileSize(ws, "edits") + eventFileSize(ws, "analysis") + eventFileSize(ws, "decisions");
      if (size > ROTATE_SUGGEST_BYTES) ctx.warnings.push("イベントが50MBを超えています。`proven rotate` を検討してください");
      exportProvenance(ws);
      const human = r.noop
        ? [`同一入力のため変更なし(no-op): job ${r.jobId}`]
        : [
            `取り込み: ${r.hunks} hunks (linked ${r.linked} / candidate ${r.candidate} / uncaptured ${r.uncaptured} / broken ${r.broken})`,
            ...(r.skippedFiles.length ? [`レビュー対象外: ${r.skippedFiles.join(", ")}`] : []),
          ];
      emitResult(ctx, "ingest", "ok", r, human);
    } catch (e) {
      fail(ctx, "ingest", e);
    }
  });

program
  .command("triage")
  .description("精読順の提示(F-03)")
  .option("--json", "機械可読出力", false)
  .option("--md <path>", "markdownレポート出力先")
  .action((opts: { json: boolean; md?: string }) => {
    const ctx: OutputCtx = { json: opts.json, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const r = runTriage(ws);
      ctx.warnings = r.warnings;
      if (opts.md) writeTriageMd(ws, opts.md, r);
      emitResult(ctx, "triage", "ok", r, [renderTriageText(r), ...(opts.md ? [`mdレポート: ${opts.md}`] : [])]);
    } catch (e) {
      fail(ctx, "triage", e);
    }
  });

program
  .command("ask")
  .description("変更への質疑(F-04)")
  .argument("<target>", "hunk_id または file:line")
  .argument("[question]", "質問")
  .option("--json", "機械可読出力", false)
  .action((target: string, question: string | undefined, opts: { json: boolean }) => {
    const ctx: OutputCtx = { json: opts.json, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const a = runAsk(ws, target, question ?? "");
      emitResult(ctx, "ask", "ok", a, [renderAsk(a)]);
    } catch (e) {
      fail(ctx, "ask", e);
    }
  });

program
  .command("confirm")
  .description("由来の人間確定([c]相当。origin_confirmedイベント)")
  .argument("<hunk>", "hunk_instance_id")
  .argument("<assignment>", "属性=値 (instructed=yes|no|unknown / spec_support=... / necessity=...)")
  .action((hunk: string, assignment: string) => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const m = assignment.match(/^(instructed|spec_support|necessity)=(.+)$/);
      if (!m) throw new ProvenError("input", "属性=値 の形式で指定してください");
      const actor = actorId(ws.provenDir, ws.repoRoot);
      confirmOrigin(ws, hunk, m[1] as "instructed" | "spec_support" | "necessity", m[2], actor);
      emitResult(ctx, "confirm", "ok", { hunk, assignment, actor }, [`origin_confirmed: ${assignment} (by ${actor})`]);
    } catch (e) {
      fail(ctx, "confirm", e);
    }
  });

program
  .command("finding")
  .description("指摘として記録([f]相当)")
  .argument("<hunk>", "hunk_instance_id")
  .argument("<note>", "指摘内容")
  .action((hunk: string, note: string) => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const id = recordFinding(ws, hunk, note, "manual");
      emitResult(ctx, "finding", "ok", { finding_id: id }, [`finding記録: ${id}`]);
    } catch (e) {
      fail(ctx, "finding", e);
    }
  });

const policyCmd = program.command("policy").description("レビュー観点の事前定義(F-12a)");
policyCmd
  .command("init")
  .description("policy.yaml雛形を作成")
  .action(() => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const p = policyPath(ws);
      if (!fs.existsSync(p)) fs.writeFileSync(p, policyInitTemplate());
      emitResult(ctx, "policy init", "ok", { path: p }, [`policy: ${p}`]);
    } catch (e) {
      fail(ctx, "policy init", e);
    }
  });
policyCmd
  .command("lint")
  .description("policy.yamlの検証(全違反列挙)")
  .action(() => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const r = loadPolicy(ws);
      if (!r) throw new ProvenError("empty", "policy.yamlがありません(proven policy init)");
      const errors = r.lintErrors.filter((e) => !e.startsWith("警告:"));
      ctx.warnings = r.lintErrors.filter((e) => e.startsWith("警告:"));
      if (errors.length) {
        for (const e of errors) process.stderr.write(`lint: ${e}\n`);
        throw new ProvenError("input", `policy.yamlに${errors.length}件の違反があります`);
      }
      emitResult(ctx, "policy lint", "ok", { rules: r.rules.length }, [`OK: ルール${r.rules.length}件`]);
    } catch (e) {
      fail(ctx, "policy lint", e);
    }
  });
policyCmd
  .command("guard")
  .description("ガードプロンプト生成(--applyでCLAUDE.mdマーカー区間を置換)")
  .option("--apply", "CLAUDE.mdへ適用", false)
  .action((opts: { apply: boolean }) => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const r = loadPolicy(ws);
      if (!r) throw new ProvenError("empty", "policy.yamlがありません");
      const guard = generateGuardPrompt(r.policy);
      if (opts.apply) {
        const a = applyGuard(ws, guard);
        emitResult(ctx, "policy guard", "ok", a, [`適用しました: ${a.target}`]);
      } else {
        emitResult(ctx, "policy guard", "ok", { guard }, [guard]);
      }
    } catch (e) {
      fail(ctx, "policy guard", e);
    }
  });

program
  .command("precheck")
  .description("提出前セルフチェック(F-12b)")
  .option("--json", "機械可読出力(AIエージェント連携形式)", false)
  .option("--quiet", "要約のみ", false)
  .action((opts: { json: boolean; quiet: boolean }) => {
    const ctx: OutputCtx = { json: opts.json, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const r = runPrecheck(ws);
      ctx.warnings = r.warnings;
      const human: string[] = [];
      const blocks = r.findings.filter((f) => f.lens === "anti_pattern" && f.severity === "block" && f.outcome === "fail");
      const warns = r.findings.filter((f) => f.lens === "anti_pattern" && f.severity === "warn");
      for (const f of blocks) human.push(`✖ ${f.rule_ref} ${f.location?.file}:${f.location?.line} ${f.reason} (block)`);
      if (!opts.quiet) {
        for (const f of warns) human.push(`△ ${f.rule_ref ?? f.lens} ${f.location ? `${f.location.file}:${f.location.line} ` : ""}${f.reason}`);
        for (const u of r.unsolicited)
          human.push(`⚠ 頼んでいない変更: ${u.file}:${u.line} ${u.noted ? "(注記あり)" : "(注記なし)"} — ${u.reason}`);
        for (const e of r.expectations) {
          const mark = e.satisfied === null ? "·" : e.satisfied ? "✓" : "✗";
          human.push(`[${mark}] ${e.type}: ${e.detail}`);
        }
      }
      human.push(`PR説明下書き: ${r.prDraftPath}`);
      emitResult(ctx, "precheck", "ok", r, human);
      if (r.gate) process.exit(10);
    } catch (e) {
      fail(ctx, "precheck", e);
    }
  });

program
  .command("llm-judge")
  .description("LLM第二段判定(既定OFF・判定不能のclaimのみ対象)")
  .option("--limit <n>", "判定する最大件数")
  .option("--json", "機械可読出力", false)
  .action(async (opts: { limit?: string; json: boolean }) => {
    const ctx: OutputCtx = { json: opts.json, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const r = await runLlmJudge(ws, { limit: opts.limit ? Number(opts.limit) : undefined });
      ctx.warnings = r.warnings;
      emitResult(ctx, "llm-judge", "ok", r, [
        r.enabled
          ? `LLM判定: 対象${r.targets}件 / 判定${r.judged}件 (断定${r.determinate} / 破棄${r.discarded}) ` +
            `呼び出し${r.calls}回 / トークン in ${r.inputTokens} + out ${r.outputTokens} / ` +
            (r.spentUsd > 0 ? `概算$${r.spentUsd}` : "費用は金額換算なし")
          : "LLM層は無効です",
      ]);
    } catch (e) {
      fail(ctx, "llm-judge", e);
    }
  });

program
  .command("rebuild")
  .description("イベントストアからprojection全再構築(F-11)")
  .option("--verify", "decisionsチェーン検証", false)
  .action((opts: { verify: boolean }) => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const r = rebuild(ws);
      if (r.corruptLines > 0) ctx.warnings.push(`破損行${r.corruptLines}件をskipしました`);
      if (r.orphanPosts > 0) ctx.warnings.push(`孤児post ${r.orphanPosts}件`);
      buildSpecIndex(ws); // spec_indexは仕様ファイルから決定的に再構築
      exportProvenance(ws);
      const lines = [`rebuild完了: ${r.applied}イベント適用`];
      if (opts.verify) {
        const v = verifyDecisionsChain(ws);
        lines.push(v.ok ? `チェーン検証OK (${v.checkedRows}行)` : `チェーン検証NG: ${v.brokenAt}`);
        lines.push(`※${v.note}`);
        if (!v.ok) {
          for (const l of lines) process.stdout.write(l + "\n");
          throw new ProvenError("corrupt", `decisionsチェーンが破損しています: ${v.brokenAt}`);
        }
      }
      emitResult(ctx, "rebuild", "ok", r, lines);
    } catch (e) {
      fail(ctx, "rebuild", e);
    }
  });

program
  .command("rotate")
  .description("イベントファイルの世代切替(F-11)")
  .option("--file <file>", "edits|analysis|decisions", "edits")
  .action((opts: { file: string }) => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      if (!["edits", "analysis", "decisions"].includes(opts.file)) throw new ProvenError("input", "--file はedits|analysis|decisions");
      const r = rotate(ws, opts.file as "edits" | "analysis" | "decisions");
      emitResult(ctx, "rotate", "ok", r, [`世代切替: ${r.archived} (gen ${r.generation})`]);
    } catch (e) {
      fail(ctx, "rotate", e);
    }
  });

program
  .command("purge")
  .description("スナップショット・派生キャッシュの削除(イベントは削除しない)")
  .requiredOption("--before <date>", "この日付より古い参照のスナップショットを削除")
  .action((opts: { before: string }) => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const d = new Date(opts.before);
      const r = runPurge(ws, d);
      emitResult(ctx, "purge", "ok", r, [`purge: 削除${r.deleted} / 保持${r.kept}`]);
    } catch (e) {
      fail(ctx, "purge", e);
    }
  });

program
  .command("migrate")
  .description("schema移行(機構の骨格)")
  .option("--def <path>", "migration定義JSON")
  .action((opts: { def?: string }) => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      if (!opts.def) throw new ProvenError("input", "--def <migration定義JSON> を指定してください(現行schemaはv1のみ)");
      const def = JSON.parse(fs.readFileSync(opts.def, "utf8"));
      const r = runMigrate(ws, def);
      emitResult(ctx, "migrate", "ok", r, [r.noop ? "no-op(移行不要)" : `migrate: ${r.migrated}イベント変換`]);
    } catch (e) {
      fail(ctx, "migrate", e);
    }
  });

program
  .command("config")
  .description("設定の取得・変更")
  .argument("<key>")
  .argument("[value]")
  .action((key: string, value?: string) => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const cfg = loadConfig(ws.provenDir);
      if (value === undefined) {
        const v = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], cfg);
        emitResult(ctx, "config", "ok", { key, value: v }, [`${key} = ${JSON.stringify(v)}`]);
        return;
      }
      if (key === "llm.enabled" && value === "true") {
        // 送信対象プレビュー(9.1)
        process.stdout.write("LLM送信を有効化します。送信対象:\n");
        process.stdout.write("  - diff抜粋 / user・AI発話の引用(前後200文字切詰・シークレットマスク済み)\n");
        process.stdout.write("  - 仕様書該当節の抜粋\n");
        process.stdout.write(`  除外: llm.exclude=${JSON.stringify(cfg.llm.exclude)}\n`);
        cfg.llm.enabled = true;
      } else {
        setDeep(cfg as unknown as Record<string, unknown>, key, value);
      }
      saveConfig(ws.provenDir, cfg);
      emitResult(ctx, "config", "ok", { key, value }, [`${key} = ${value}`]);
    } catch (e) {
      fail(ctx, "config", e);
    }
  });

function setDeep(obj: Record<string, unknown>, key: string, raw: string): void {
  const parts = key.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  let v: unknown = raw;
  if (raw === "true") v = true;
  else if (raw === "false") v = false;
  else if (/^\d+(\.\d+)?$/.test(raw)) v = Number(raw);
  cur[last] = v;
}

const evalCmd = program.command("eval").description("受入計測(基本設計11章)");
evalCmd
  .command("capture-state")
  .description("uncaptured/broken率の状態別集計")
  .action(() => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const r = evalCaptureState(ws);
      emitResult(ctx, "eval capture-state", "ok", r, r.lines);
    } catch (e) {
      fail(ctx, "eval capture-state", e);
    }
  });
for (const kind of ["lineage", "claims"] as const) {
  evalCmd
    .command(kind)
    .description(
      kind === "lineage"
        ? "lineage帰属の受入計測(--emit-casesで判定用ケースを出力→AIまたは人が判定→--submitで取込)"
        : "claim根拠の受入計測(同上)",
    )
    .option("--emit-cases", "判定用ケースをJSONで出力(AIエージェントに渡す)", false)
    .option("--sample <n>", "サンプル数", "50")
    .option("--latest-only", "最新ingestで付与されたclaimのみ対象(判定ロジック変更後の実測用)", false)
    .option("--submit <path>", "判定JSONを取り込む")
    .option("--judge <who>", "判定者: ai(未検証扱い) | human(確認済み扱い)", "human")
    .option("--model <name>", "judge=ai のとき判定に使ったモデル名")
    .option("--report", "集計(AI判定と人間確認を分離表示)", false)
    .option("--json", "機械可読出力", false)
    .action((opts: { emitCases: boolean; sample: string; latestOnly?: boolean; submit?: string; judge: string; model?: string; report: boolean; json: boolean }) => {
      const ctx: OutputCtx = { json: opts.json, warnings: [] };
      const cmdName = `eval ${kind}`;
      try {
        const ws = workspace(process.cwd());
        requireInitialized(ws);
        if (opts.emitCases) {
          // AIエージェントがそのまま読める形式。--json有無に関わらずstdoutはJSONのみ
          const pack = buildCasePack(ws, kind, Number(opts.sample), Boolean(opts.latestOnly));
          process.stdout.write(JSON.stringify(pack, null, 2) + "\n");
          return;
        }
        if (opts.submit) {
          if (opts.judge !== "ai" && opts.judge !== "human") throw new ProvenError("input", "--judge は ai | human");
          const r = submitJudgments(ws, kind, opts.submit, {
            judge: opts.judge,
            actorId: actorId(ws.provenDir, ws.repoRoot),
            model: opts.model,
          });
          if (r.unknownCases.length) ctx.warnings.push(`未知のcase_id ${r.unknownCases.length}件を無視しました`);
          emitResult(ctx, cmdName, "ok", r, [
            `判定を${r.accepted}件記録しました(${r.verificationLevel})`,
            ...(opts.judge === "ai" ? ["※AI判定は未検証です。受入合否には人間確認が必要です"] : []),
          ]);
          return;
        }
        const rep = reportEval(ws, kind);
        emitResult(ctx, cmdName, "ok", rep, rep.lines);
      } catch (e) {
        fail(ctx, cmdName, e);
      }
    });
}
evalCmd
  .command("triage-log")
  .option("--reached <bool>", "今日のレビューで重要変更に先に到達できたか(true/false)")
  .option("--note <note>")
  .action((opts: { reached?: string; note?: string }) => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const entry = opts.reached !== undefined ? { reached: opts.reached === "true", note: opts.note } : undefined;
      const r = evalTriageLog(ws, entry);
      emitResult(ctx, "eval triage-log", "ok", r, [`記録${r.entries}件 / 到達率 ${r.reachedRate}`]);
    } catch (e) {
      fail(ctx, "eval triage-log", e);
    }
  });

program
  .command("spec-index")
  .description("仕様書インデックス再構築")
  .action(() => {
    const ctx: OutputCtx = { json: false, warnings: [] };
    try {
      const ws = workspace(process.cwd());
      requireInitialized(ws);
      const r = buildSpecIndex(ws);
      emitResult(ctx, "spec-index", "ok", r, [`spec: ${r.files}ファイル/${r.paragraphs}段落/REQ ${r.reqIds}件`]);
    } catch (e) {
      fail(ctx, "spec-index", e);
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (e) {
  const err = e as { code?: string; exitCode?: number };
  if (err.code === "commander.helpDisplayed" || err.code === "commander.version") process.exit(0);
  if (typeof err.code === "string" && err.code.startsWith("commander.")) process.exit(2); // 未知コマンド/不正フラグ(E-07)
  process.stderr.write(`error: ${String(e)}\n`);
  process.exit(2);
}
