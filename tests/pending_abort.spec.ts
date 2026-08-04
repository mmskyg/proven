// 対象: pending中断が同一操作の完了行を巻き添えにしない / 孤児postの二重計上 (REQ-833)
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { derivePendingStatuses, openDb } from "../src/store/projections.js";
import { runCapture } from "../src/capture/capture.js";
import { runIngest } from "../src/ingest/ingest.js";
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

const DAY2 = 1000 * 60 * 60 * 48;

function statuses(fx: Fixture, operationId: string): Record<string, string> {
  const db = openDb(fx.ws);
  try {
    const rows = db
      .prepare("SELECT file, status FROM edit_events WHERE operation_id=?")
      .all(operationId) as { file: string; status: string }[];
    return Object.fromEntries(rows.map((r) => [r.file, r.status]));
  } finally {
    db.close();
  }
}

describe("REQ-833 pending中断は同一操作の完了行を巻き添えにしない", () => {
  it("1操作で2ファイル。片方だけpendingのまま古くなっても、完了済みの方はcompletedのまま", () => {
    const fx = repo({ "a.ts": "a\n", "b.ts": "b\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "両方直して" }]);
    const op = "op_multi";
    // 同一 operation_id で2ファイル。a.ts は post まで完了、b.ts は post が来ない
    capturedEdit(fx, "a.ts", "a2\n", { transcript: tr, toolUseId: op });
    capturedEdit(fx, "b.ts", "b2\n", { transcript: tr, toolUseId: op, skipPost: true });

    // イベントをprojectionへ反映する(ingestは現在時刻で呼ぶので、ここではまだ中断されない)
    runIngest(fx.ws);
    expect(statuses(fx, op)).toEqual({ "a.ts": "completed", "b.ts": "pending" });

    // 24h以上経過させて中断を導出する
    const db = openDb(fx.ws);
    try {
      derivePendingStatuses(db, new Date(Date.now() + DAY2), () => false);
    } finally {
      db.close();
    }

    // b.ts だけ aborted。a.ts は completed のまま(ここが壊れると来歴が黙って消える)
    expect(statuses(fx, op)).toEqual({ "a.ts": "completed", "b.ts": "aborted" });
  });
});

describe("REQ-833 孤児postを実行のたびに二重計上しない", () => {
  it("同じ孤児postがある状態でingestを2回まわしてもorphanPostsが増えない", () => {
    const fx = repo({ "a.ts": "a\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "直して" }]);
    capturedEdit(fx, "a.ts", "a2\n", { transcript: tr });
    // pre の無い post = 孤児。capturedEdit は pre/post を対で打つのでここは直接呼ぶ
    runCapture(fx.ws, "post", {
      session_id: "s1",
      transcript_path: tr,
      cwd: fx.dir,
      tool_name: "Edit",
      tool_input: { file_path: path.join(fx.dir, "a.ts") },
      tool_use_id: "op_orphan",
      hook_event_name: "PostToolUse",
      tool_response: { success: true },
    });

    const first = runIngest(fx.ws).orphanPosts;
    // 2回目: 差分を作って再度ingest(edits.jsonl は毎回全再適用される)
    capturedEdit(fx, "a.ts", "a4\n", { transcript: tr });
    const second = runIngest(fx.ws).orphanPosts;

    expect(second).toBe(first);
  });
});
