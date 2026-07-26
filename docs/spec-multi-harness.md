# マルチハーネス対応 仕様書 v1.0

対象: Proven を Claude Code 以外の AI ハーネス（Codex / OpenCode）でも使えるようにする改修。

作成日: 2026-07-26

---

## 1. 目的

Proven の捕捉層を Claude Code 専用から**複数ハーネス対応**に拡張する。
現在 `capture` は Claude Code の hook 入力スキーマに直接結合しており、他ハーネスでは
編集イベントが1件も記録されず、全 hunk が `uncaptured` になる。

本改修で Codex と OpenCode を捕捉対象に加える。

## 2. スコープ（この改修でやること）

- Codex（`codex-cli` 0.144.3 以降）の hooks 経由での捕捉
- OpenCode（1.17.9 以降）のプラグイン経由での捕捉
- 上記2つを支えるための最小限の内部構造変更（アダプタ層・エージェント識別・1操作N ファイル）

## 3. 非スコープ（この改修ではやらないこと）

**本改修は「対応ハーネスを増やす」ことだけを行う。ツールの機能そのものは変更しない。**

以下は明示的にスコープ外とする（将来の別改修とする）:

- 新規サブコマンドの追加（`doctor` 等）
- triage の加点ルール変更（cross-agent 加点など）
- 由来判定（claims）のロジック変更
- LLM 層の実装
- Phase 2 機能（review / verify / attest / learn / docstyle / report）
- 出力フォーマットの変更（triage / ask / precheck の表示内容）

## 4. 不変条件（最重要）

REQ-201: **Claude Code 経路の観測可能な挙動を変えない。**
同一の hook 入力に対し、改修前後で `edits.jsonl` に記録される
`operation_id` / `file` / `pre_blob_hash` / `result_blob_hash` / `tool_status` が一致すること。

REQ-202: **既存の自動テスト114件が改修後も全て通ること。** テストの期待値を緩める形での通過は不可とする。

REQ-203: **capture は従来どおり、いかなる入力でも throw せず exit 0 とする**（開発をブロックしない絶対原則）。
未知のハーネス・不正な payload・アダプタの例外も同様に握りつぶし、`capture-errors.log` に記録する。

REQ-204: 下流（ingest / lineage / triage / ask / precheck / eval）に**ハーネス固有の分岐を持ち込まない**。
これらは `edit_pre` / `edit_post` イベントのみを見る現状の構造を維持する。

---

## 5. エージェント識別（検出方式）

### 5.1 三層方式

REQ-205: エージェントの識別は次の優先順位で行う。**実行時の環境変数による推測を第一手段にしてはならない。**

1. **自己申告（declared）**: `capture --agent <id>` で明示された値を最優先で採用する。
2. **推定（inferred）**: `--agent` が無い場合のみ、payload 形状と環境変数から推定する。
3. **不明（unknown）**: いずれでも決まらない場合。捕捉は行うが、エージェントは `unknown` として記録する。

根拠: ハーネスは入れ子で起動されうる（例: Claude Code のセッション内から Codex を起動）。
この場合 `CLAUDECODE=1` と `CODEX_*` が同時に立ち、環境変数による判別は誤る。
Proven は「この変更は誰の判断か」を提示するツールであり、エージェントの取り違えは出力自体を虚偽にする。
したがって**呼び出し側が名乗る**方式を正とする。

### 5.2 検出結果の記録

REQ-206: `edit_pre` イベントに検出方法を記録する。

```
agent: string                    // "claude-code" | "codex" | "opencode" | "generic" | "unknown"
agent_detection: {
  method: "declared" | "inferred" | "unknown",
  signals: string[],             // 推定根拠（例: ["env:CODEX_THREAD_ID", "payload:hook_event_name"]）
  confidence: number | null      // declared は 1.0、inferred は 0.9 以下、unknown は null
}
```

REQ-207: `method: "inferred"` の confidence は 0.9 を上限とする。
推定を確定事実として扱わないという既存方針（claim の confidence 上限規則）と同じ扱いとする。

### 5.3 登録時検出

REQ-208: `proven init` は環境をスキャンして、存在するハーネスを検出し、**検出した全てに hook を登録する**。
検出材料は以下とし、いずれも「存在すれば検出」とする（誤検出しても未使用なら発火しないため無害）。

| ハーネス | 検出材料 |
|---|---|
| claude-code | `.claude/settings.json` の存在、または `claude` が PATH 上にある |
| codex | `codex` が PATH 上にある、または `$CODEX_HOME`（既定 `~/.codex`）が存在する |
| opencode | `opencode.json` / `.opencode/` の存在、または `opencode` が PATH 上にある |

REQ-209: 登録する hook コマンドには**必ず `--agent <id>` を含める**（自己申告の担保）。
既に登録済みのコマンドがある場合は重複追加しない。

REQ-210: `proven init --agent <id>` で対象ハーネスを明示指定できる。指定時は検出を行わずそのハーネスのみ登録する。

---

## 6. アダプタ層

### 6.1 責務

REQ-211: ハーネス依存の処理は `src/agents/` のアダプタに閉じる。アダプタの責務は次の3つに限定する。

1. `match(payload, env)`: 自分のものらしいかの判定（signals とスコアを返す）
2. `normalize(payload, phase)`: ハーネス固有 payload を共通形（`NormalizedCapture`）へ変換
3. `capabilities`: 自分の捕捉能力の申告

### 6.2 capability による分岐

REQ-212: 下流およびアダプタ利用側は、**ハーネス名で分岐してはならない**。分岐は capability に対して行う。

```
capabilities: {
  preState: "hook" | "plugin" | "watch" | "none"    // 編集前状態を取得できる手段
  operationId: "native" | "synthesized"             // tool_use_id / callID 相当があるか
  filesPerOperation: "one" | "many"                 // 1操作が複数ファイルに及ぶか
  transcript: "jsonl" | "rollout" | "sdk" | "none"  // 発話履歴の取得方式
}
```

理由: ハーネス名で分岐すると3つ目・4つ目の追加でコードが破綻する。また利用者への説明も
「codex だから信頼度が低い」ではなく「編集前状態が取れないから信頼度が低い」と本質側になる。

### 6.3 共通形

REQ-213: アダプタは以下の共通形へ正規化する。

```
NormalizedCapture {
  agent: string
  operationIdNative: string | null   // tool_use_id / callID。無ければ null（synthesized へ）
  sessionRef: string                 // transcript のパス、または セッション識別子
  transcriptLine: number | null
  tool: string                       // 原文のツール名（記録用）
  files: string[]                    // 対象ファイル（raw path。解決・除外判定は共通処理）
  isTargetTool: boolean              // 編集系ツールか
  toolStatus: "success" | "failure" | null  // post 時のみ
}
```

パス解決（realpath / リポジトリ外判定 / `.proven` 除外 / exclude glob）と blob 保存は
**アダプタではなく共通処理**が行う。アダプタは raw path を返すのみとする。

---

## 7. ハーネス別要件

### 7.1 claude-code（既存・挙動不変）

REQ-214: 既存の Claude Code 処理をそのままアダプタとして切り出す。
対象ツールは `Edit` / `Write` / `MultiEdit` / `NotebookEdit`、
ファイルは `tool_input.file_path`（無ければ `tool_input.notebook_path`）、
`operation_id` は `tool_use_id`、欠落時は既存と同一の合成キー規則を用いる。

capability: `preState: hook` / `operationId: native` / `filesPerOperation: one` / `transcript: jsonl`

### 7.2 codex

REQ-215: Codex の hooks（`hooks.json`）経由で捕捉する。
イベントは `pre_tool_use` / `post_tool_use` を用いる。

REQ-216: **編集ツールは `apply_patch` であり、対象ファイルは引数直下に無くパッチ本文中にある。**
アダプタはパッチ本文を解析し、対象ファイル群を抽出する。抽出対象は以下の指示行とする。

```
*** Add File: <path>
*** Update File: <path>
*** Delete File: <path>
*** Move to: <path>        // Update File 直後の移動先
```

REQ-217: パッチ本文の所在は payload の複数箇所を許容する（`tool_input.input` / `tool_input.patch` /
`tool_input.command` 内の文字列）。`*** Begin Patch` を含む文字列を探索して解析する。
どこからも見つからない場合は「捕捉対象外」として記録せず、理由を `capture-errors.log` に残す。

REQ-218: shell 経由の `apply_patch` 実行（コマンド文字列内にパッチが埋まる形）も同じ経路で扱う。

capability: `preState: hook` / `operationId: native` / `filesPerOperation: many` / `transcript: rollout`

### 7.3 opencode

REQ-219: OpenCode はプラグイン（`tool.execute.before` / `tool.execute.after`）経由で捕捉する。
プラグインは `callID` を `operation_id`、`sessionID` を `sessionRef` として渡す。

REQ-220: プラグインは Proven 側が提供し、`opencode.json` の `plugin` に登録する形とする。
プラグインは capture を子プロセスとして起動し、**その失敗が OpenCode の動作を妨げないこと**（REQ-203 と同じ扱い）。

REQ-221: 対象ツールは編集系（`write` / `edit` / `patch` 等）とし、
ファイル引数は `filePath` / `file_path` / `path` のいずれかを許容する。
`patch` 系はパッチ本文から抽出する（REQ-216 と同じ解析器を共用する）。

capability: `preState: plugin` / `operationId: native` / `filesPerOperation: many` / `transcript: sdk`

### 7.4 generic（未知ハーネス向け）

REQ-222: 未対応ハーネスの利用者が自前で連携できるよう、明示的な入力契約を設ける。

```
proven capture --phase pre --agent generic
{ "operation_id": "...", "session_ref": "...", "tool": "...", "files": ["src/a.ts"], "status": "success" }
```

これは新機能ではなく、既存 capture の入力形式の一つとして提供する。

---

## 8. データモデル変更

REQ-223: `edit_events` の主キーを `operation_id` から **`(operation_id, file)` の複合主キー**へ変更する。
理由: `apply_patch` は1操作で複数ファイルを書き換えるため、現行の1:1前提では2件目以降が欠落する。

REQ-224: `edit_post` は**同一 `operation_id` に属する全ファイル行を更新する**。
各ファイルの `result_blob_hash` は post 時点で対象ファイルを読み直して算出する。

REQ-225: 上記変更は projections（再構築可能な派生物）に閉じる。
イベント（`edits.jsonl`）の互換性は保ち、`proven rebuild` で新スキーマへ再構築できること。
既存イベントの `agent` フィールド（`"claude-code"` 固定値）はそのまま読めること。

REQ-226: 1操作N ファイルの場合、`edit_pre` はファイルごとに1イベントを発行し、
`operation_id` は同一値を共有する。lineage の紐付け（`lineage_links`）は現行どおり
hunk のファイル単位で解決されるため、下流の変更は不要とする。

---

## 9. 設定

REQ-227: `config.yaml` の `agents[].type` を `claude-code` 固定（`z.literal`）から
enum（`claude-code` / `codex` / `opencode` / `generic`）へ変更する。
既存の設定ファイル（`agents: []`）はそのまま読めること。

---

## 10. 受入条件

REQ-228: 以下を全て満たすこと。

1. 既存テスト114件が全て通る（REQ-202）
2. Claude Code 経路の記録内容が改修前と一致する（REQ-201）— 回帰テストを追加する
3. Codex の `apply_patch`（複数ファイル）で、ファイル数ぶんの `edit_pre` が記録され、
   `ingest` 後に各ファイルの hunk が `captured/linked` になる
4. OpenCode のプラグイン経由で `edit_pre` / `edit_post` が対になって記録される
5. `--agent` 無しでの推定時、`agent_detection.method` が `inferred` として記録され、
   confidence が 0.9 以下である（REQ-207）
6. 入れ子環境（`CLAUDECODE=1` と `CODEX_*` が同時に立つ）で、`--agent` 指定が
   環境変数より優先されることをテストで確認する

---

## 11. 未実測事項（実装前に確認すること）

REQ-229: 実装前に実機で確認する。未確認のまま推測で実装しない。確認できない項目がある場合は、
その項目に依存する機能を「未対応」として明示し、推測で埋めない（既存方針: 判定不能は判定不能と出す）。

### 11.1 Codex — 実測済み（2026-07-26 / codex-cli 0.144.3）

隔離した `CODEX_HOME` で hook を仕掛け、実際に `codex exec` を走らせて採取した結果。

**探索パス**（公式ドキュメント）: `~/.codex/hooks.json` / `~/.codex/config.toml` の `[hooks]` /
`<repo>/.codex/hooks.json` / `<repo>/.codex/config.toml`
→ **プロジェクト直下 `.codex/hooks.json` に書ける**（`.claude/settings.json` と同じ扱いにできる）

**イベント名は CamelCase**（`PreToolUse` / `PostToolUse`）。snake_case では発火しない（実測で確認）。
構造は matcher + hooks 配列で Claude Code と同型。

**PreToolUse payload 実体**:

```json
{
  "session_id": "019f9e28-...",
  "turn_id": "019f9e28-...",
  "transcript_path": ".../sessions/2026/07/26/rollout-....jsonl",
  "cwd": "/path/to/work",
  "hook_event_name": "PreToolUse",
  "model": "gpt-5.6-sol",
  "permission_mode": "bypassPermissions",
  "tool_name": "apply_patch",
  "tool_input": { "command": "*** Begin Patch\n*** Add File: greet.py\n+...\n*** Add File: hello.txt\n+hi\n*** End Patch\n" },
  "tool_use_id": "call_u6NA2i5QKtXWbMI0OBuJUgUP"
}
```

確認できた事実:

1. `tool_use_id` がある → `operationId: native`（合成不要）
2. **1回の `apply_patch` が複数ファイルを含む**ことを実測で確認（`greet.py` と `hello.txt`）→ REQ-223 の1:N対応は必須
3. パッチ本文の所在は `tool_input.command`（REQ-217 の探索対象に確定）
4. PostToolUse も同一 `tool_use_id` で対になって発火する（pre/post が揃う）
5. **`tool_response` は文字列**（Claude Code はオブジェクト）。
   実測値: `"Exit code: 0\nWall time: 0.6 seconds\nOutput:\nSuccess. Updated the following files:\nA greet.py\nA hello.txt\n"`
   → 成否判定は文字列/オブジェクトの両方を扱えること
6. `Bash` ツールでも PreToolUse が発火する → 編集系以外を除外する必要がある（matcher でも絞れる）
7. `transcript_path` は rollout JSONL。ユーザー発話は
   `{"type":"event_msg","payload":{"type":"user_message","message":"..."}}` の行として取得できる

**信頼(trust)**: 非managedのcommand hookは初回にレビューが必要で、CLI の `/hooks` で trust する。
trust はフックのハッシュに対して記録されるため、コマンドを変更すると再レビューになる。
→ REQ-233: `proven init --agent codex` は `.codex/hooks.json` を書いたうえで、
**`/hooks` での信頼付与が必要なことを利用者に明示する**（勝手に信頼させる手段は使わない）。

### 11.2 OpenCode — 実測済み（2026-07-26 / opencode 1.17.9）

プローブ用プラグインを `.opencode/plugin/probe.js` に置き、実際に `opencode run` を走らせて採取した結果。

1. **プラグインは `.opencode/plugin/*.js` から自動読み込みされる**（`opencode.json` への登録は不要）
2. `tool.execute.before` の実測値:
   `input = { tool: "write", sessionID: "ses_061c...", callID: "write_0" }`
   `output = { args: { content: "hi", filePath: "/abs/path/hello.txt" } }`
   → **引数は `input` ではなく `output.args` 側にある**
3. `tool.execute.after` の実測値:
   `input = { tool, sessionID, callID, args }`（args は input 側）
   `output = { title, metadata: { filepath, exists, ... } }`
4. **`callID` はセッション内の連番**（`write_0`）。グローバルに一意ではないため、
   `operation_id` は `sessionID:callID` の組で構成する（REQ-234）
5. 編集ツール名は実測で `write` / `edit` を確認
6. プラグインを複数シンボルで export すると**同じフックが二重に発火する**。
   同梱プラグインは export を1つに限定する（REQ-235）

REQ-234: OpenCode の `operation_id` は `sessionID:callID` とする。
REQ-235: 同梱プラグインの export は1つに限定し、フックの二重登録を避ける。

### 11.3 E2E 検証結果（2026-07-26）

実際のハーネスを走らせて、記録 → `ingest` → `triage` まで通ることを確認した。

**Codex**: `proven init --yes --agent codex` → `.codex/hooks.json` 生成 → 実 `codex exec` で2ファイル変更

```
edit_pre  | app.ts | call_gGXYhe4pvg2EpXzKcaA7h8oL | codex apply_patch declared
edit_pre  | lib.ts | call_gGXYhe4pvg2EpXzKcaA7h8oL | codex apply_patch declared
edit_post | app.ts | call_gGXYhe4pvg2EpXzKcaA7h8oL
edit_post | lib.ts | call_gGXYhe4pvg2EpXzKcaA7h8oL
取り込み: 5 hunks (linked 2 / uncaptured 3 / broken 0)
triage: app.ts / lib.ts ともに captured/linked、instructed=あり、necessity=essential
```

1操作2ファイルが同一 `operation_id` で記録され、rollout からユーザー発話を読んで
`instructed=あり` まで到達した（REQ-216/223/224 の実地確認）。

**OpenCode**: `proven init --yes --agent opencode` → `.opencode/plugin/proven.js` 生成 → 実 `opencode run`

```
edit_pre  | main.ts | ses_061ca9be7ffeBdnAgwJEux0Qzp:edit_1 | opencode edit
edit_post | main.ts | ses_061ca9be7ffeBdnAgwJEux0Qzp:edit_1
取り込み: 4 hunks (linked 1 / uncaptured 3 / broken 0)
```

---

## 12. 前提バグ修正（本改修の着手前に必要）

REQ-230: **登録される hook コマンドが、エディタの cwd がリポジトリルート以外のとき capture を実行できない問題を修正する。**

現行の `hookCommand()` は次を登録する。

```
sh -c 'proven capture --phase pre 2>>.proven/logs/capture-errors.log || true'
```

`.proven/logs/...` が**相対パス**であるため、ハーネスのセッション cwd がリポジトリ外の場合
`sh: cannot create .proven/logs/capture-errors.log: Directory nonexistent` となり、
リダイレクト解決の失敗で **`proven capture` 自体が一度も起動しない**。
`|| true` により exit 0 となるため、利用者にはエラーが見えず、
**Proven が何も記録していないことに気づけない**（本仕様書の作成時に実際に発生し、発覚した）。

修正方針: hook コマンドから相対パスのリダイレクトを除去する。

```
sh -c 'proven capture --phase pre >/dev/null 2>&1 || true'
```

`capture` は起動後、対象ファイルから解決したワークスペースの `.proven/logs/capture-errors.log` へ
自前でエラーを記録する（`logCaptureError`）ため、hook 側のリダイレクトは元々冗長であった。
リポジトリ絶対パスの埋め込みは、`.claude/settings.json` が共有・コミットされる前提と衝突するため採らない。

REQ-231: 既存の登録済み hook コマンド（旧形式）を検出した場合、`proven init` は新形式へ**置換**する。
旧形式を残したまま新形式を追記すると、同一編集が二重に記録されるため、置換とする。

REQ-232: 本修正には回帰テストを追加する。
「cwd がリポジトリ外でも hook コマンド経由で捕捉されること」をテストで固定する。
