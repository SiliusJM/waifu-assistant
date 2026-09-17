import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { DirectAIProvider } from '../../src/ai/direct-ai-provider.js';
import type { AIRequest, RetryPolicy } from '../../src/ai/ai-types.js';
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
