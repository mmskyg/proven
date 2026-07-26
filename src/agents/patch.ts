// apply_patch形式のパッチ本文から対象ファイルを抽出する(REQ-216/217)。
// codexのapply_patchとopencodeのpatch系ツールで共用する。

const BEGIN = "*** Begin Patch";

/**
 * パッチ本文から対象ファイルを抽出する。
 * 対象指示行:
 *   *** Add File: <path>
 *   *** Update File: <path>
 *   *** Delete File: <path>
 *   *** Move to: <path>      (Update File 直後の移動先)
 * renameは追跡せず削除+追加として扱う既存方針に合わせ、移動元と移動先の両方を返す。
 */
export function filesFromPatch(patch: string): string[] {
  const files: string[] = [];
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.trimEnd();
    const m = /^\*\*\* (Add File|Update File|Delete File|Move to):\s*(.+)$/.exec(line);
    if (!m) continue;
    const file = m[2].trim();
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

/**
 * payloadの任意の値からパッチ本文を探索する(REQ-217)。
 * `*** Begin Patch` を含む文字列を深さ優先で探す。配列(コマンド配列)も対象。
 */
export function findPatchText(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === "string") return value.includes(BEGIN) ? value : null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findPatchText(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const found = findPatchText(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** payloadからパッチ対象ファイルを抽出。パッチが見つからなければ空配列 */
export function filesFromPayload(value: unknown): string[] {
  const patch = findPatchText(value);
  return patch ? filesFromPatch(patch) : [];
}
