/**
 * One-line JSON structured logging to stderr.
 *
 * The server used to write free text — and tool failures were swallowed into
 * tool results with nothing logged at all, so "which tool failed, and why"
 * had no answer from outside the model's transcript. Every record now carries
 * an `event` name and typed fields, so `docker logs | jq 'select(.event ==
 * "tool.call" and .outcome != "ok")'` answers it.
 *
 * stderr rather than stdout because that is where this server has always
 * written, and it keeps stdout free if a stdio transport is ever added.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  error: 40,
  info: 20,
  silent: 100,
  warn: 30,
};

export function parseLogLevel(value: string | undefined): LogLevel {
  const candidate = value?.trim().toLowerCase();
  if (candidate && candidate in SEVERITY) return candidate as LogLevel;
  return "info";
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Injectable clock, so tests can assert a stable record. */
  now?: () => Date;
  /** Injectable sink, so tests can read records without capturing stderr. */
  write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const {
    level = "info",
    now = () => new Date(),
    write = (line) => {
      console.error(line);
    },
  } = options;

  function emit(
    recordLevel: LogLevel,
    event: string,
    fields?: LogFields,
  ): void {
    if (SEVERITY[recordLevel] < SEVERITY[level]) return;
    write(
      JSON.stringify({
        level: recordLevel,
        event,
        time: now().toISOString(),
        ...fields,
      }),
    );
  }

  return {
    debug: (event, fields) => emit("debug", event, fields),
    error: (event, fields) => emit("error", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
  };
}

/**
 * The process-wide logger.
 *
 * The level resolves lazily on first use rather than at module load, so
 * `setLogLevel` from a test setup file takes effect regardless of module import
 * order.
 */
let configured: Logger | undefined;
let configuredLevel: LogLevel | undefined;

export function setLogLevel(level: LogLevel): void {
  configuredLevel = level;
  configured = undefined;
}

function active(): Logger {
  if (!configured) {
    configured = createLogger({
      level: configuredLevel ?? parseLogLevel(process.env.LOG_LEVEL),
    });
  }
  return configured;
}

export const logger: Logger = {
  debug: (event, fields) => active().debug(event, fields),
  error: (event, fields) => active().error(event, fields),
  info: (event, fields) => active().info(event, fields),
  warn: (event, fields) => active().warn(event, fields),
};
