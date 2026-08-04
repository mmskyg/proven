// 対象: author判定が連言を見ていない問題 (REQ-835) と、author不明時の探索窓の上限 (REQ-836)
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIngest } from "../src/ingest/ingest.js";
import { openDb } from "../src/store/projections.js";
import { capturedEdit, cleanup, initProven, makeRepo, writeTranscript, type Fixture } from "./helpers.js";

const fixtures: Fixture[] = [];
function repo(files: Record<string, string> = {}): Fixture {
  const fx = makeRepo(files);
  fixtures.push(fx);
  return fx;
}
afterEach(() => {
  for (const fx of fixtures.splice(0)) cleanup(fx);
});

function supports(fx: Fixture, file: string): string[] {
  const db = openDb(fx.ws);
  try {
    return (
      db
        .prepare(
          `SELECT l.support AS s FROM lineage_links l JOIN hunks h ON h.hunk_instance_id=l.hunk_instance_id
            WHERE h.file=?`,
        )
        .all(file) as { s: string }[]
    ).map((r) => r.s);
  } finally {
    db.close();
  }
}

describe("REQ-835 単独では弱い行でも、並び・全被覆なら author とみなす", () => {
  it("弱い行が連続2行そろえば author(小さな修正の典型形)", () => {
    const fx = repo({ "svc.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "雑談" }]);
    // count++; total++; はどちらも isInformativeLine を通らないが、
    // 「並んで一致する」ことは偶然の形ではない
    capturedEdit(fx, "svc.ts", "l1\ncount++;\ntotal++;\n", { transcript: tr });
    runIngest(fx.ws);
    expect(supports(fx, "svc.ts")).toContain("author");
  });

  it("弱い行が1本だけなら touched のまま(定型行1本で著者を断定しない)", () => {
    const fx = repo({ "svc.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "雑談" }]);
    capturedEdit(fx, "svc.ts", "l1\ncount++;\nl3\n", { transcript: tr });
    runIngest(fx.ws);
    expect(supports(fx, "svc.ts")).not.toContain("author");
  });
});

describe("REQ-835 (c) 空行で被覆を水増ししない", () => {
  it("空行の一致で被覆を満たしたことにしない", () => {
    // 純粋な追加だけにして (b)連続run と (a)informative を発火させず、
    // (c)全被覆の判定だけを見る
    const fx = repo({ "svc.ts": "l1\nl4\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "雑談" }]);
    // イベント: x++; と空行だけを追加(y++; は書いていない)
    capturedEdit(fx, "svc.ts", "l1\nx++;\n\nl4\n", { transcript: tr });
    // hook外で y++; を足す。hunkの追加行は x++; / 空行 / y++; の3行になる
    fs.writeFileSync(path.join(fx.dir, "svc.ts"), "l1\nx++;\n\ny++;\nl4\n");
    runIngest(fx.ws);

    // matched を合計で数えると、空行の一致が水増しになって被覆したことになる。
    // 実際にはイベントは y++; を書いていない
    expect(supports(fx, "svc.ts")).not.toContain("author");
  });
});
