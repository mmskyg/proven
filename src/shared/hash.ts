import { createHash } from "node:crypto";

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256OfParts(parts: (string | number)[]): string {
  return sha256(parts.map(String).join("\x00"));
}
