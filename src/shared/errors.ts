// F-00 exit code contract
export type ErrorCategory = "empty" | "input" | "external" | "corrupt" | "gate";

const EXIT_CODES: Record<ErrorCategory, number> = {
  empty: 1, // 対象なし等の正常系空振り
  input: 2, // 入力・設定エラー
  external: 3, // 外部依存エラー
  corrupt: 4, // データ破損
  gate: 10, // 検証ゲート該当
};

export class AirevError extends Error {
  category: ErrorCategory;
  constructor(category: ErrorCategory, message: string) {
    super(message);
    this.category = category;
  }
  get exitCode(): number {
    return EXIT_CODES[this.category];
  }
}
