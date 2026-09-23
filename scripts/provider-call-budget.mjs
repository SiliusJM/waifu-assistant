export const DEFAULT_PROVIDER_REQUEST_BUDGET = 36;

function budgetError() {
  const error = new Error('Provider request budget exhausted.');
  error.code = 'BUDGET_EXHAUSTED';
  return error;
}

function requestKind(body) {
  if (!body || !Array.isArray(body.messages)) return 'normal';
  const isToolRound = body.messages.some((message) => message?.role === 'tool'
    || Array.isArray(message?.tool_calls));
  return isToolRound ? 'tool-second-round' : 'normal';
}

export class ProviderRequestBudget {
  constructor(maxProviderRequests = DEFAULT_PROVIDER_REQUEST_BUDGET) {
    if (!Number.isInteger(maxProviderRequests) || maxProviderRequests < 0) {
      throw new TypeError('maxProviderRequests must be a non-negative integer.');
    }
    this.maxProviderRequests = maxProviderRequests;
    this.providerRequests = 0;
    this.metadataRequests = 0;
    this.blockedByBudget = 0;
    this.logicalInteractions = 0;
    this.toolSecondRoundRequests = 0;
    this.retryRequests = 0;
    this.abortedIssuedRequests = 0;
  }

  countMetadataRequest() {
    this.metadataRequests += 1;
  }

  noteLogicalInteraction() {
    this.logicalInteractions += 1;
  }

  canReserve(count = 1) {
    return Number.isInteger(count) && count >= 0
      && this.providerRequests + count <= this.maxProviderRequests;
  }

  countProviderRequest({ kind = 'normal', retry = false } = {}) {
    if (this.providerRequests >= this.maxProviderRequests) {
      this.blockedByBudget += 1;
      throw budgetError();
    }
    this.providerRequests += 1;
    if (kind === 'tool-second-round') this.toolSecondRoundRequests += 1;
    if (retry) this.retryRequests += 1;
    return this.providerRequests;
  }

  noteIssuedRequestAborted() {
    this.abortedIssuedRequests += 1;
  }

  snapshot() {
    return {
      metadataRequests: this.metadataRequests,
      providerRequests: this.providerRequests,
      blockedByBudget: this.blockedByBudget,
      logicalInteractions: this.logicalInteractions,
      toolSecondRoundRequests: this.toolSecondRoundRequests,
      retryRequests: this.retryRequests,
      abortedIssuedRequests: this.abortedIssuedRequests,
      maxProviderRequests: this.maxProviderRequests,
    };
  }
}

export function createCountingFetch({ budget, fetchImpl = fetch } = {}) {
  if (!(budget instanceof ProviderRequestBudget)) {
    throw new TypeError('budget must be a ProviderRequestBudget.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');

  return async (input, init = {}) => {
    let body;
    try {
      body = JSON.parse(String(init.body ?? '{}'));
    } catch {
      body = undefined;
    }
    budget.countProviderRequest({ kind: requestKind(body) });
    let settled = false;
    const cleanup = () => init.signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      budget.noteIssuedRequestAborted();
      cleanup();
    };
    init.signal?.addEventListener('abort', onAbort, { once: true });
    let response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      if (init.signal?.aborted) onAbort();
      settled = true;
      cleanup();
      throw error;
    }
    if (!response?.body || typeof response.body.getReader !== 'function') {
      settled = true;
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    const bodyStream = new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            settled = true;
            cleanup();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          settled = true;
          cleanup();
          controller.error(error);
        }
      },
      async cancel(reason) {
        settled = true;
        cleanup();
        await reader.cancel(reason);
      },
    });
    return new Response(bodyStream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
