# airev (仮称) — AIエージェントネイティブのレビュー用CLI

AI駆動開発のレビューボトルネックを解消するCLI。編集イベントをhookで発生時捕捉し、
変更の来歴(誰が・どの指示/仕様/AI判断で)を提示、レビュー前に開発者へフィードバックを返す。

- 設計書: Notion「AIレビューCLI」プロジェクト(基本v0.6 / 機能v0.7 / 詳細v0.3 / テストv0.3)
- Phase 1 (MVP) 実装済み: capture / ingest(lineage+claims) / triage / ask / policy / precheck / rebuild / rotate / purge / migrate / eval
- LLMは既定OFF(ヒューリスティックのみで動作)。LLMプロバイダ層はオプトイン実装予定

## 使い方(最小)

```bash
airev init --yes          # .airev/作成 + Claude Code hooks登録
# …Claude Codeで開発(編集が自動捕捉される)…
airev ingest              # diff+来歴構築
airev triage              # 精読順の提示
airev ask src/x.ts:42     # 「なぜこの変更?」を記録に聞く
airev precheck            # 提出前セルフチェック(policy.yaml基準)
```

## テスト

```bash
npm test   # vitest: 98 tests
```

<!-- dogfood: manual edit without hook -->
