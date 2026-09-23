import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { DirectAIProvider } from '../../src/ai/direct-ai-provider.js';
import type { AIRequest, AIStreamEvent, RetryPolicy } from '../../src/ai/ai-types.js';
import { AssistantError } from '../../src/shared/errors.js';

const request: AIRequest = {
  sessionId: 'integration-test',
  messages: [{ role: 'user', content: 'Hello' }],
};
const noRetry: RetryPolicy = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function withServer(
  handler: (response: ServerResponse) => void,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = createServer((_request, response) => handler(response));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await run('http://127.0.0.1:' + address.port + '/v1');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withRequestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await run('http://127.0.0.1:' + address.port + '/v1');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function provider(baseURL: string, overrides: Partial<ConstructorParameters<typeof DirectAIProvider>[0]> = {}): DirectAIProvider {
  return new DirectAIProvider({
    baseURL,
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 100,
    retryPolicy: noRetry,
    ...overrides,
  });
}

async function assertCode(operation: Promise<unknown>, code: AssistantError['code']): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof AssistantError && error.code === code,
  );
}

async function consumeStream(stream: AsyncIterable<AIStreamEvent>): Promise<void> {
  for await (const event of stream) { void event; }
}

test('direct provider handles a successful response', async () => {
  await withServer(
    (response) => sendJson(response, 200, {
      model: 'test-model',
      choices: [{ message: { content: 'Hello back.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    async (baseURL) => {
      const result = await provider(baseURL).complete(request);
      assert.equal(result.text, 'Hello back.');
      assert.equal(result.usage?.totalTokens, 5);
    },
  );
});

test('direct provider accepts tool calls without textual content', async () => {
  await withServer(
    (response) => sendJson(response, 200, {
      model: 'test-model',
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
    async (baseURL) => {
      const result = await provider(baseURL).complete(request);
      assert.equal(result.text, '');
      assert.equal(result.toolCalls?.[0]?.name, 'lookup');
      assert.equal(result.finishReason, 'tool_calls');
    },
  );
});

test('direct provider serializes tools and tool protocol messages for OpenAI-compatible APIs', async () => {
  let received: Record<string, unknown> | undefined;
  await withRequestServer(
    (incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        sendJson(response, 200, {
          model: 'test-model',
          choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        });
      });
    },
    async (baseURL) => {
      await provider(baseURL).complete({
        sessionId: 'tool-serialization-test',
        tools: [{
          type: 'function',
          function: {
            name: 'local_time',
            description: 'Read local time.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        }],
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'local_time', argumentsJson: '{}' }],
          },
          {
            role: 'tool',
            content: '{"status":"success"}',
            toolCallId: 'call-1',
            name: 'local_time',
          },
        ],
      });
    },
  );
  assert.deepEqual(received?.tools, [{
    type: 'function',
    function: {
      name: 'local_time',
      description: 'Read local time.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  }]);
  assert.deepEqual(received?.messages, [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'local_time', arguments: '{}' },
      }],
    },
    {
      role: 'tool',
      content: '{"status":"success"}',
      tool_call_id: 'call-1',
      name: 'local_time',
    },
  ]);
});

test('direct provider stream emits the completed response', async () => {
  await withServer(
    (response) => sendJson(response, 200, {
      model: 'test-model',
      choices: [{ message: { content: 'streamed' }, finish_reason: 'stop' }],
    }),
    async (baseURL) => {
      const events: AIStreamEvent[] = [];
      for await (const event of provider(baseURL).stream(request)) {
        events.push(event);
      }
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, 'completed');
      if (events[0]?.type === 'completed') {
        assert.equal(events[0].response.text, 'streamed');
        assert.equal(events[0].response.provider, 'direct-http');
        assert.equal(events[0].response.model, 'test-model');
        assert.equal(events[0].response.finishReason, 'stop');
      }
    },
  );
});

test('direct provider parses SSE deltas split across chunks and requests streaming', async () => {
  let received: Record<string, unknown> | undefined;
  await withRequestServer(
    (incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const body = [
          'data: {"model":"test-model","choices":[{"delta":{"content":"Ho"},"finish_reason":null}]}\r\n\r\n',
          'data: {"choices":[{"delta":{"content":"la 🌸"},"finish_reason":null}]}\r\n\r\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
          'data: [DONE]\r\n\r\n',
        ].join('');
        for (const byte of Buffer.from(body, 'utf8')) response.write(Buffer.from([byte]));
        response.end();
      });
    },
    async (baseURL) => {
      const events: AIStreamEvent[] = [];
      for await (const event of provider(baseURL).stream(request)) events.push(event);
      assert.equal(received?.stream, true);
      assert.deepEqual(events.filter((event) => event.type === 'text_delta').map((event) => event.delta), ['Ho', 'la 🌸']);
      const completed = events.at(-1);
      assert.equal(completed?.type, 'completed');
      if (completed?.type === 'completed') {
        assert.equal(completed.response.text, 'Hola 🌸');
        assert.equal(completed.response.finishReason, 'stop');
      }
    },
  );
});

test('direct provider accepts null content alongside streamed tool calls', async () => {
  await withServer(
    (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{
        delta: { content: null, tool_calls: [{ index: 0, id: 'call-null', function: { name: 'local_time', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }] })}\n\ndata: [DONE]\n\n`);
    },
    async (baseURL) => {
      const events: AIStreamEvent[] = [];
      for await (const event of provider(baseURL).stream(request)) events.push(event);
      assert.equal(events.some((event) => event.type === 'text_delta'), false);
      const completed = events.at(-1);
      assert.equal(completed?.type, 'completed');
      if (completed?.type === 'completed') {
        assert.equal(completed.response.text, '');
        assert.equal(completed.response.finishReason, 'tool_calls');
        assert.deepEqual(completed.response.toolCalls, [{ id: 'call-null', name: 'local_time', argumentsJson: '{}' }]);
      }
    },
  );
});

test('direct provider reconstructs fragmented streamed tool calls with a bounded argument', async () => {
  await withServer(
    (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"local_calculate","arguments":"{\\"ex"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"pression\\":\\"2+2\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''));
    },
    async (baseURL) => {
      const events: AIStreamEvent[] = [];
      for await (const event of provider(baseURL).stream(request)) events.push(event);
      const completed = events.at(-1);
      assert.equal(completed?.type, 'completed');
      if (completed?.type === 'completed') {
        assert.deepEqual(completed.response.toolCalls, [{ id: 'call-1', name: 'local_calculate', argumentsJson: '{"expression":"2+2"}' }]);
      }
    },
  );
});

test('direct provider rejects malformed, empty and unsupported streams safely', async () => {
  await withServer(
    (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {broken\n\n');
    },
    async (baseURL) => assertCode(consumeStream(provider(baseURL).stream(request)), 'INVALID_RESPONSE_ERROR'),
  );
  await withServer(
    (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: [DONE]\n\n');
    },
    async (baseURL) => assertCode(consumeStream(provider(baseURL).stream(request)), 'INVALID_RESPONSE_ERROR'),
  );
  await withServer(
    (response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html>not an API response</html>');
    },
    async (baseURL) => assertCode(consumeStream(provider(baseURL).stream(request)), 'INVALID_RESPONSE_ERROR'),
  );
});

test('direct provider timeout covers a stream body that never completes', async () => {
  await withServer(
    (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
    },
    async (baseURL) => assertCode(consumeStream(provider(baseURL, { timeoutMs: 20 }).stream(request)), 'TIMEOUT_ERROR'),
  );
});

test('direct provider cancellation stops a stream after partial text without retrying', async () => {
  let calls = 0;
  await withServer(
    (response) => {
      calls += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
      setTimeout(() => response.end('data: [DONE]\n\n'), 100);
    },
    async (baseURL) => {
      const controller = new AbortController();
      const events: AIStreamEvent[] = [];
      setTimeout(() => controller.abort(), 10);
      await assert.rejects(async () => {
        for await (const event of provider(baseURL, { retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } }).stream(request, { signal: controller.signal })) {
          events.push(event);
        }
      }, (error: unknown) => error instanceof AssistantError && error.code === 'CANCELLATION_ERROR');
      assert.equal(calls, 1);
      assert.deepEqual(events.map((event) => event.type), ['text_delta']);
    },
  );
});

test('direct provider retries a stream failure before the first visible delta', async () => {
  let calls = 0;
  await withRequestServer(
    (_incoming, response) => {
      calls += 1;
      if (calls === 1) {
        sendJson(response, 500, { error: 'temporary stream failure' });
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    },
    async (baseURL) => {
      const events: AIStreamEvent[] = [];
      for await (const event of provider(baseURL, { retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 } }).stream(request)) events.push(event);
      assert.equal(calls, 2);
      assert.equal(events.find((event) => event.type === 'text_delta')?.delta, 'recovered');
    },
  );
});

test('direct provider categorizes 400, 401, 429 and 500 responses', async () => {
  const cases: Array<[number, AssistantError['code']]> = [
    [400, 'PROVIDER_ERROR'],
    [401, 'AUTHENTICATION_ERROR'],
    [429, 'RATE_LIMIT_ERROR'],
    [500, 'PROVIDER_ERROR'],
  ];
  for (const [statusCode, code] of cases) {
    await withServer(
      (response) => sendJson(response, statusCode, { error: 'controlled test response' }),
      async (baseURL) => assertCode(provider(baseURL).complete(request), code),
    );
  }
});

test('direct provider retries a retryable 500 response once', async () => {
  let calls = 0;
  await withServer(
    (response) => {
      calls += 1;
      if (calls === 1) {
        sendJson(response, 500, { error: 'temporary' });
      } else {
        sendJson(response, 200, {
          model: 'test-model',
          choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }],
        });
      }
    },
    async (baseURL) => {
      const result = await provider(baseURL, {
        retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }).complete(request);
      assert.equal(result.text, 'recovered');
      assert.equal(calls, 2);
    },
  );
});

test('direct provider does not retry 400 or 401 responses', async () => {
  for (const statusCode of [400, 401]) {
    let calls = 0;
    await withServer(
      (response) => {
        calls += 1;
        sendJson(response, statusCode, { error: 'permanent' });
      },
      async (baseURL) => {
        await assertCode(
          provider(baseURL, {
            retryPolicy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
          }).complete(request),
          statusCode === 401 ? 'AUTHENTICATION_ERROR' : 'PROVIDER_ERROR',
        );
        assert.equal(calls, 1);
      },
    );
  }
});

test('direct provider caps Retry-After at maxDelayMs', async () => {
  let calls = 0;
  const controller = new AbortController();
  await withServer(
    (response) => {
      calls += 1;
      response.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '1',
      });
      response.end(JSON.stringify({ error: 'slow down' }));
    },
    async (baseURL) => {
      setTimeout(() => controller.abort(), 100);
      await assertCode(
        provider(baseURL, {
          retryPolicy: { maxAttempts: 10, baseDelayMs: 0, maxDelayMs: 20 },
        }).complete(request, { signal: controller.signal }),
        'CANCELLATION_ERROR',
      );
      assert.ok(calls >= 2);
    },
  );
});

test('direct provider rejects invalid JSON and invalid response shape', async () => {
  await withServer(
    (response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{not-json');
    },
    async (baseURL) => assertCode(provider(baseURL).complete(request), 'INVALID_RESPONSE_ERROR'),
  );
  await withServer(
    (response) => sendJson(response, 200, { model: 'test-model', choices: [] }),
    async (baseURL) => assertCode(provider(baseURL).complete(request), 'INVALID_RESPONSE_ERROR'),
  );
});

test('direct provider classifies timeout and caller cancellation separately', async () => {
  await withServer(
    () => {},
    async (baseURL) => assertCode(
      provider(baseURL, { timeoutMs: 20 }).complete(request),
      'TIMEOUT_ERROR',
    ),
  );

  await withServer(
    (response) => {
      setTimeout(() => sendJson(response, 200, {
        model: 'test-model',
        choices: [{ message: { content: 'late' }, finish_reason: 'stop' }],
      }), 100);
    },
    async (baseURL) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      await assertCode(
        provider(baseURL, { timeoutMs: 500 }).complete(request, { signal: controller.signal }),
        'CANCELLATION_ERROR',
      );
    },
  );
});

test('direct provider cancellation during retry backoff prevents the next request', async () => {
  let calls = 0;
  const controller = new AbortController();
  await withServer(
    (response) => {
      calls += 1;
      sendJson(response, 500, { error: 'temporary' });
    },
    async (baseURL) => {
      setTimeout(() => controller.abort(), 10);
      await assertCode(
        provider(baseURL, {
          retryPolicy: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 1000 },
        }).complete(request, { signal: controller.signal }),
        'CANCELLATION_ERROR',
      );
      assert.equal(calls, 1);
    },
  );
});
