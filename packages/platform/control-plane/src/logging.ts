// Structured request logging. One line per request with method, path, status,
// duration, actor, and a request id — JSON when LOG_LEVEL isn't `dev`, a compact
// human line otherwise. Deliberately tiny (no dependency); the repo already proves
// a hand-rolled server needs no logging framework.
import { randomUUID } from "node:crypto";
import type { ControlPlaneConfig } from "./config.ts";
import type { LogFields, Logger } from "./types.ts";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type LogLevel = keyof typeof LEVELS;

export function makeLogger(config: ControlPlaneConfig): Logger {
  const pretty = config.logLevel === "dev";
  const threshold = LEVELS[config.logLevel === "dev" ? "debug" : config.logLevel as LogLevel] ?? LEVELS.info;

  const emit = (level: LogLevel, fields: LogFields) => {
    if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
    if (pretty) {
      const { msg, method, path: p, status, ms, ...rest } = fields;
      const extra = Object.keys(rest).length ? " " + JSON.stringify(rest) : "";
      const line = method
        ? `${method} ${p} → ${status ?? "-"} ${ms != null ? `${ms}ms` : ""}${extra}`
        : `${msg ?? ""}${extra}`;
      process.stdout.write(`[${level}] ${line.trim()}\n`);
    } else {
      process.stdout.write(JSON.stringify({ level, ts: new Date().toISOString(), ...fields }) + "\n");
    }
  };

  return {
    debug: (fields) => emit("debug", fields),
    info: (fields) => emit("info", fields),
    warn: (fields) => emit("warn", fields),
    error: (fields) => emit("error", fields),
    newRequestId: () => randomUUID().slice(0, 8),
  };
}
