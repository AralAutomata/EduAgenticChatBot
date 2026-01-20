import type { LogLevel } from "./types.ts";

/**
 * Minimal structured logger.
 *
 * Design goals:
 * - Keep dependencies at zero (so it works in Deno without extra libs).
 * - Produce logs that are readable by humans *and* easy to grep/parse.
 * - Allow consistent log filtering via a numeric level threshold.
 *
 * Why not console.log everywhere?
 * - Centralizing severity handling makes it easy to quiet noisy logs in demos
 *   while still retaining error visibility.
 * - The `meta` object allows context (studentId/runId/etc.) without stringly typing.
 */
const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  // Internal threshold: messages below this are ignored.
  #level: LogLevel;

  constructor(level: LogLevel) {
    // Intentionally store the string level (not the numeric) so we can keep the type narrow.
    this.#level = level;
  }

  debug(message: string, meta?: Record<string, unknown>) {
    // `debug` is meant for local development (prompt payloads, intermediate results, etc).
    this.#log("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>) {
    // `info` is the default operational signal (start/stop/status).
    this.#log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>) {
    // `warn` means “we recovered, but something is off” (invalid student rows, fallbacks, etc).
    this.#log("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>) {
    // `error` means “we failed at something we expected to work”.
    this.#log("error", message, meta);
  }

  #log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
    // Implement severity filtering via numeric thresholds.
    if (LEVELS[level] < LEVELS[this.#level]) return;
    // ISO timestamps sort well and make cross-process correlation easier.
    const timestamp = new Date().toISOString();
    // Serialize meta as a single JSON blob so logs remain one-line-per-event.
    const payload = meta ? ` ${JSON.stringify(meta)}` : "";
    // Consistent prefix: timestamp + LEVEL + message (plus optional meta JSON).
    const line = `[${timestamp}] ${level.toUpperCase()} ${message}${payload}`;

    // Use the matching console channel so platforms can route/format appropriately.
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

export function createLogger(level: LogLevel) {
  // Convenience factory; keeps call sites readable and makes swapping logger implementations easier later.
  return new Logger(level);
}
