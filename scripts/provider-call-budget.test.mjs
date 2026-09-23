import assert from 'node:assert/strict';
import test from 'node:test';
import { createCountingFetch, ProviderRequestBudget } from './provider-call-budget.mjs';

const response = (status = 200) => new Response('{}', { status });
const request = (messages = [{ role: 'user', content: 'PONG' }]) => ({
  body: JSON.stringify({ messages }),
});

test('counts one successful provider request at the fetch boundary', async () => {
  const budget = new ProviderRequestBudget();
  const countingFetch = createCountingFetch({ budget, fetchImpl: async () => response() });
  await countingFetch('http://test/chat/completions', request());
  assert.equal(budget.providerRequests, 1);
});

test('counts HTTP errors because the request was issued', async () => {
  const budget = new ProviderRequestBudget();
  const countingFetch = createCountingFetch({ budget, fetchImpl: async () => response(500) });
  const result = await countingFetch('http://test/chat/completions', request());
  assert.equal(result.status, 500);
  assert.equal(budget.providerRequests, 1);
});

test('counts explicit retries separately', () => {
  const budget = new ProviderRequestBudget();
  budget.countProviderRequest();
  budget.countProviderRequest({ retry: true });
  assert.equal(budget.providerRequests, 2);
  assert.equal(budget.retryRequests, 1);
});

test('counts a tool second round as a provider request', async () => {
  const budget = new ProviderRequestBudget();
  const countingFetch = createCountingFetch({ budget, fetchImpl: async () => response() });
  await countingFetch('http://test/chat/completions', request());
  await countingFetch('http://test/chat/completions', request([
    { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function' }] },
    { role: 'tool', content: '{}' },
  ]));
  assert.equal(budget.providerRequests, 2);
  assert.equal(budget.toolSecondRoundRequests, 1);
});

test('counts an issued request that is later aborted', async () => {
  const budget = new ProviderRequestBudget();
  const controller = new AbortController();
  const countingFetch = createCountingFetch({
    budget,
    fetchImpl: async (_input, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  const pending = countingFetch('http://test/chat/completions', { ...request(), signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(budget.providerRequests, 1);
  assert.equal(budget.abortedIssuedRequests, 1);
});

test('does not count caller cleanup after a response body completed', async () => {
  const budget = new ProviderRequestBudget();
  const controller = new AbortController();
  const countingFetch = createCountingFetch({ budget, fetchImpl: async () => response() });
  const result = await countingFetch('http://test/chat/completions', { ...request(), signal: controller.signal });
  await result.text();
  controller.abort();
  assert.equal(budget.providerRequests, 1);
  assert.equal(budget.abortedIssuedRequests, 0);
});

test('hard budget blocks request 37 before the underlying fetch', async () => {
  const budget = new ProviderRequestBudget(2);
  let networkCalls = 0;
  const countingFetch = createCountingFetch({ budget, fetchImpl: async () => { networkCalls += 1; return response(); } });
  await countingFetch('http://test/chat/completions', request());
  await countingFetch('http://test/chat/completions', request());
  await assert.rejects(countingFetch('http://test/chat/completions', request()), { code: 'BUDGET_EXHAUSTED' });
  assert.equal(networkCalls, 2);
  assert.equal(budget.providerRequests, 2);
  assert.equal(budget.blockedByBudget, 1);
});

test('two providers share one exact global counter', async () => {
  const budget = new ProviderRequestBudget();
  const first = createCountingFetch({ budget, fetchImpl: async () => response() });
  const second = createCountingFetch({ budget, fetchImpl: async () => response() });
  await first('http://test/chat/completions', request());
  await second('http://test/chat/completions', request());
  assert.equal(budget.providerRequests, 2);
});

test('500-interaction offline model keeps normal, error, retry, tool and abort counts exact', () => {
  const budget = new ProviderRequestBudget(1000);
  let expectedRequests = 0;
  for (let index = 0; index < 500; index += 1) {
    budget.noteLogicalInteraction();
    const mode = index % 5;
    budget.countProviderRequest();
    expectedRequests += 1;
    if (mode === 2) {
      budget.countProviderRequest({ retry: true });
      expectedRequests += 1;
    }
    if (mode === 3) {
      budget.countProviderRequest({ kind: 'tool-second-round' });
      expectedRequests += 1;
    }
    if (mode === 4) budget.noteIssuedRequestAborted();
  }
  assert.equal(budget.providerRequests, expectedRequests);
  assert.equal(budget.logicalInteractions, 500);
  assert.equal(budget.retryRequests, 100);
  assert.equal(budget.toolSecondRoundRequests, 100);
  assert.equal(budget.abortedIssuedRequests, 100);
});

test('budget 36 blocks 64 of 100 requested provider calls', () => {
  const budget = new ProviderRequestBudget(36);
  for (let index = 0; index < 100; index += 1) {
    try { budget.countProviderRequest(); } catch (error) { assert.equal(error.code, 'BUDGET_EXHAUSTED'); }
  }
  assert.equal(budget.providerRequests, 36);
  assert.equal(budget.blockedByBudget, 64);
});

test('100 offline tool rounds count exactly 200 provider requests', () => {
  const budget = new ProviderRequestBudget(200);
  for (let index = 0; index < 100; index += 1) {
    budget.countProviderRequest();
    budget.countProviderRequest({ kind: 'tool-second-round' });
  }
  assert.equal(budget.providerRequests, 200);
  assert.equal(budget.toolSecondRoundRequests, 100);
});

test('100 issued-and-aborted requests are all counted', () => {
  const budget = new ProviderRequestBudget(100);
  for (let index = 0; index < 100; index += 1) {
    budget.countProviderRequest();
    budget.noteIssuedRequestAborted();
  }
  assert.equal(budget.providerRequests, 100);
  assert.equal(budget.abortedIssuedRequests, 100);
});

test('bounded concurrent requests share one exact counter', async () => {
  const budget = new ProviderRequestBudget(100);
  await Promise.all(Array.from({ length: 100 }, async () => budget.countProviderRequest()));
  assert.equal(budget.providerRequests, 100);
});
