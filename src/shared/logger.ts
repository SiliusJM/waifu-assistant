const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|credential|authorization|cookie|private[_-]?key)/i;
const REDACTED = '[REDACTED]';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

interface LogSink {
  info?: (line: string) => void;
  warn?: (line: string) => void;
  error?: (line: string) => void;
  log?: (line: string) => void;
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }

  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(nestedValue, seen);
  }
  return output;
}

export function createLogger(
  options: { readonly scope?: string; readonly sink?: LogSink } = {},
): Logger {
  const scope = options.scope ?? 'waifu-assistant';
  const sink = options.sink ?? console;

  function write(level: LogLevel, message: string, context: LogContext = {}): void {
    const event = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      context: sanitize(context, new WeakSet<object>()),
    };
    const output = sink[level] ?? sink.log;
    output?.call(sink, JSON.stringify(event));
  }

  return {
    info(message, context) {
      write('info', message, context);
    },
    warn(message, context) {
      write('warn', message, context);
    },
    error(message, context) {
      write('error', message, context);
    },
  };
}
