// 対象: non-ASCIIファイル名が黙ってmanifestから消える問題 (REQ-829)
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCommitRevision, buildWorktreeRevision } from "../src/ingest/revision.js";
import { runIngest } from "../src/ingest/ingest.js";
import { capturedEdit, cleanup, initProven, makeRepo, sh, writeTranscript, type Fixture } from "./helpers.js";

const fixtures: Fixture[] = [];
function repo(files: Record<string, string> = {}): Fixture {
  const fx = makeRepo(files);
  fixtures.push(fx);
  return fx;
}
afterEach(() => {
  for (const fx of fixtures.splice(0)) cleanup(fx);
});

const JA = "設計メモ.md";

describe("REQ-829 non-ASCIIファイル名がmanifestから落ちない", () => {
  it("worktree revision に日本語名のファイルが入る", () => {
    // git は既定(core.quotepath=true)で non-ASCII を octal-quote して出力する。
    // 引用符付き文字列をパスとして扱うと fs.existsSync が false になり、黙って捨てられていた
    const fx = repo({ [JA]: "# 日本語\n本文\n", "ascii.ts": "export const a = 1;\n" });
    initProven(fx);
    const paths = buildWorktreeRevision(fx.ws).rev.manifest.files.map((f) => f.path);
    expect(paths).toContain(JA);
    expect(paths).toContain("ascii.ts");
  });

  it("commit revision にも日本語名のファイルが入る", () => {
    const fx = repo({ [JA]: "# 日本語\n本文\n" });
    initProven(fx);
    const paths = buildCommitRevision(fx.ws, "HEAD").manifest.files.map((f) => f.path);
    expect(paths).toContain(JA);
  });

  it("日本語名ファイルの編集がhunkになる(capture→ingest 通し)", () => {
    const fx = repo({ [JA]: "1行目\n2行目\n3行目\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "設計メモを直して" }]);
    capturedEdit(fx, JA, "1行目\n書き換えた\n3行目\n", { transcript: tr });
    const r = runIngest(fx.ws);
    expect(r.hunks).toBeGreaterThan(0);
  });

  it("コミット前の削除は警告しない(削除hunkとして正しくレビューされるため)", () => {
    const fx = repo({ "ascii.ts": "a\n" });
    initProven(fx);
    // index には在るが worktree から消えている = 通常の削除。
    // head manifest から消えることで削除hunkになりレビューされるので、
    // ここで「読めなかった」と警告すると、rm からコミットまでの間ずっと嘘が出続ける
    fs.writeFileSync(path.join(fx.dir, "消えたファイル.md"), "x\n");
    sh(fx.dir, "git", ["add", "-A"]);
    fs.unlinkSync(path.join(fx.dir, "消えたファイル.md"));

    expect(buildWorktreeRevision(fx.ws).unreadable).toEqual([]);
  });

  it("削除以外の理由で読めないパスはファイル名つきで報告する(黙って捨てない)", () => {
    const fx = repo({ "ascii.ts": "a\n" });
    initProven(fx);
    const target = path.join(fx.dir, "読めないファイル.md");
    fs.writeFileSync(target, "x\n");
    sh(fx.dir, "git", ["add", "-A"]);
    fs.chmodSync(target, 0o000);
    try {
      // rootだと権限を無視して読めてしまうので、その場合はこのケースを検証できない
      let denied = false;
      try {
        fs.readFileSync(target);
      } catch {
        denied = true;
      }
      if (!denied) return;
      expect(buildWorktreeRevision(fx.ws).unreadable).toContain("読めないファイル.md");
    } finally {
      fs.chmodSync(target, 0o644);
    }
  });
});
