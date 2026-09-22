import { AssistantError } from '../shared/errors.js';

export interface ServerSentEvent {
  readonly data: string;
}

function invalidStream(message: string): AssistantError {
  return new AssistantError(message, { code: 'INVALID_RESPONSE_ERROR', retryable: false });
}

/** Parses SSE framing independently from the provider payload format. */
export async function* parseSSEChunks(
  chunks: AsyncIterable<Uint8Array | string>,
): AsyncIterable<ServerSentEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let firstText = true;

  const dispatch = function* (): Generator<ServerSentEvent> {
    if (dataLines.length > 0) {
      yield { data: dataLines.join('\n') };
      dataLines = [];
    }
  };

  const processLine = function* (line: string): Generator<ServerSentEvent> {
    if (firstText) {
      firstText = false;
      line = line.replace(/^\uFEFF/, '');
    }
    if (line === '') {
      yield* dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('data:')) {
      dataLines.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
      return;
    }
    // SSE fields other than data are deliberately ignored for this JSON API.
  };

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    while (true) {
      const match = /\r\n|\n|\r/.exec(buffer);
      if (!match || match.index === undefined) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      yield* processLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield* processLine(buffer);
  yield* dispatch();
}

export function parseSSEData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw invalidStream('The provider returned invalid streaming JSON.');
  }
}
