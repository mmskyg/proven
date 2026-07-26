#!/usr/bin/env node
// Production entry: runs the TS CLI via tsx loader (MVP; tsc build is a later optimization)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(here, "..", "src", "cli", "main.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");
const r = spawnSync(tsx, [main, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
