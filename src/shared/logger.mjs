const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|credential|authorization|cookie|private[_-]?key)/i;
const REDACTED = '[REDACTED]';

function sanitize(value, seen) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[CIRCULAR]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen));
  }

  const output = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(nestedValue, seen);
  }
  return output;
}

export function createLogger({ scope = 'waifu-assistant', sink = console } = {}) {
  function write(level, message, context = {}) {
    const event = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      context: sanitize(context, new WeakSet()),
    };
    const line = JSON.stringify(event);
    const output = sink[level] ?? sink.log;
    output.call(sink, line);
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
