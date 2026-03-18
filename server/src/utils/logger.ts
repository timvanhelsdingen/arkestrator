type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function format(level: LogLevel, context: string, message: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase()}] [${context}] ${message}`;
}

export const logger = {
  debug(context: string, message: string) {
    if (shouldLog("debug")) console.log(format("debug", context, message));
  },
  info(context: string, message: string) {
    if (shouldLog("info")) console.log(format("info", context, message));
  },
  warn(context: string, message: string) {
    if (shouldLog("warn")) console.warn(format("warn", context, message));
  },
  error(context: string, message: string) {
    if (shouldLog("error")) console.error(format("error", context, message));
  },
};
