import { InternetError } from './internet-errors.js';
import { transitionInternetLifecycle } from './lifecycle.js';
import { evaluateContentPolicy, evaluateRedirect, evaluateUrlPolicy, normalizeUrl } from './url-policy.js';
import { createWebData } from './web-data.js';
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserPage,
  BrowserProvider,
  BrowserSession,
  InternetOperationOptions,
  WebContentSnapshot,
  WebFetchProvider,
  WebFetchRequest,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
} from './internet-types.js';

const MOCK_TIMESTAMP = '2026-01-01T00:00:00.000Z';

export interface MockProviderOptions {
  readonly available?: boolean;
  readonly latencyMs?: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new InternetError('Internet operation was cancelled.', 'CANCELLATION');
}

async function waitForOperation(options: InternetOperationOptions, latencyMs: number): Promise<void> {
  throwIfAborted(options.signal);
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new InternetError('Internet operation timeout is invalid.', 'TIMEOUT');
  }
  const delay = Math.max(0, latencyMs);
  if (delay === 0 && options.timeoutMs === undefined) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let cleanup = (): void => {};
    const finish = (error?: InternetError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = (): void => {
      finish(new InternetError('Internet operation was cancelled.', 'CANCELLATION'));
    };
    const delayHandle = setTimeout(() => finish(), delay);
    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        finish(new InternetError('Internet operation timed out.', 'TIMEOUT', true));
      }, options.timeoutMs);
    }
    cleanup = (): void => {
      clearTimeout(delayHandle);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      options.signal?.removeEventListener('abort', onAbort);
    };
    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function ensureAvailable(available: boolean): void {
  if (!available) throw new InternetError('Internet provider is unavailable.', 'PROVIDER_UNAVAILABLE', true);
}

function throwFetchPolicyError(reason: string): never {
  switch (reason) {
    case 'CONTENT_TOO_LARGE': throw new InternetError('Mock fetch content exceeded its limit.', 'CONTENT_TOO_LARGE');
    case 'TOO_MANY_REDIRECTS': throw new InternetError('Mock fetch exceeded its redirect limit.', 'TOO_MANY_REDIRECTS');
    case 'BLOCKED_REDIRECT': throw new InternetError('Mock fetch redirect was denied by policy.', 'BLOCKED_REDIRECT');
    case 'BLOCKED_DESTINATION': throw new InternetError('Mock fetch destination was denied by policy.', 'BLOCKED_DESTINATION');
    default: throw new InternetError('Mock fetch result was invalid.', 'INVALID_CONTENT');
  }
}

function validateSnapshot(value: unknown): WebContentSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw new InternetError('Mock fetch result was invalid.', 'INVALID_CONTENT');
  }
  const snapshot = value as WebContentSnapshot;
  const data = snapshot.data;
  if (snapshot.kind !== 'content-snapshot' || typeof snapshot.url !== 'string'
    || typeof snapshot.finalUrl !== 'string' || !Number.isInteger(snapshot.statusCode)
    || typeof snapshot.contentType !== 'string'
    || !Array.isArray(snapshot.redirects) || typeof data !== 'object' || data === null
    || data.kind !== 'untrusted-web-data' || data.trust !== 'untrusted'
    || typeof data.content !== 'string' || typeof data.provenance?.sourceUrl !== 'string'
    || typeof data.limits !== 'object' || data.limits === null
    || !Number.isFinite(data.limits.observedBytes)) {
    throw new InternetError('Mock fetch result was invalid.', 'INVALID_CONTENT');
  }
  try {
    if (normalizeUrl(snapshot.url) !== snapshot.url || normalizeUrl(snapshot.finalUrl) !== snapshot.finalUrl
      || snapshot.redirects.some((url) => normalizeUrl(url) !== url)
      || normalizeUrl(snapshot.data.provenance.sourceUrl) !== snapshot.data.provenance.sourceUrl) {
      throw new InternetError('Mock fetch result was not normalized.', 'INVALID_CONTENT');
    }
  } catch (error) {
    if (error instanceof InternetError) throw error;
    throw new InternetError('Mock fetch result was invalid.', 'INVALID_CONTENT', false, error);
  }
  return snapshot;
}

function validateSearchResult(value: unknown): WebSearchResult {
  if (typeof value !== 'object' || value === null) {
    throw new InternetError('Mock search result was invalid.', 'INVALID_CONTENT');
  }
  const result = value as WebSearchResult;
  const snippet = result.snippet;
  if (typeof result.title !== 'string' || !result.title
    || typeof result.url !== 'string' || normalizeUrl(result.url) !== result.url
    || typeof snippet !== 'object' || snippet === null
    || snippet.kind !== 'untrusted-web-data'
    || snippet.trust !== 'untrusted'
    || typeof snippet.provenance?.sourceUrl !== 'string'
    || normalizeUrl(snippet.provenance.sourceUrl) !== snippet.provenance.sourceUrl) {
    throw new InternetError('Mock search result was invalid.', 'INVALID_CONTENT');
  }
  return result;
}

function defaultSearchResults(provider: string, query: string): readonly WebSearchResult[] {
  const url = normalizeUrl(`https://example.invalid/search?q=${encodeURIComponent(query)}`);
  return [{
    title: `Mock result for ${query}`,
    url,
    snippet: createWebData({
      content: `Deterministic mock result for ${query}.`,
      provenance: { source: 'search', provider, sourceUrl: url, fetchedAt: MOCK_TIMESTAMP },
      metadata: { contentType: 'text/plain' },
      maxBytes: 4096,
    }),
  }];
}

export class MockSearchProvider implements WebSearchProvider {
  readonly id: string;
  private readonly available: boolean;
  private readonly latencyMs: number;
  private readonly results?: readonly WebSearchResult[];

  constructor(id = 'mock-search', options: MockProviderOptions & { readonly results?: readonly WebSearchResult[] } = {}) {
    this.id = id;
    this.available = options.available ?? true;
    this.latencyMs = options.latencyMs ?? 0;
    this.results = options.results;
  }

  isAvailable(): boolean { return this.available; }

  async search(request: WebSearchRequest, options: InternetOperationOptions = {}): Promise<WebSearchResponse> {
    ensureAvailable(this.available);
    if (!request.query.trim()) throw new InternetError('Search query is invalid.', 'INVALID_CONTENT');
    const maxResults = request.maxResults ?? 5;
    if (!Number.isInteger(maxResults) || maxResults <= 0) {
      throw new InternetError('Search result limit is invalid.', 'INVALID_CONTENT');
    }
    await waitForOperation(options, this.latencyMs);
    const results = this.results ?? defaultSearchResults(this.id, request.query);
    for (const result of results) validateSearchResult(result);
    return { kind: 'search-response', items: results.slice(0, maxResults), provider: this.id, completedAt: MOCK_TIMESTAMP };
  }
}

export class MockFetchProvider implements WebFetchProvider {
  readonly id: string;
  private readonly available: boolean;
  private readonly latencyMs: number;
  private readonly snapshots: ReadonlyMap<string, WebContentSnapshot>;

  constructor(id = 'mock-fetch', options: MockProviderOptions & { readonly snapshots?: readonly WebContentSnapshot[] } = {}) {
    this.id = id;
    this.available = options.available ?? true;
    this.latencyMs = options.latencyMs ?? 0;
    this.snapshots = new Map((options.snapshots ?? []).map((snapshot) => [snapshot.url, snapshot]));
  }

  isAvailable(): boolean { return this.available; }

  async fetch(request: WebFetchRequest, options: InternetOperationOptions = {}): Promise<WebContentSnapshot> {
    ensureAvailable(this.available);
    const policy = evaluateUrlPolicy(request.url, {
      resolvedAddresses: request.resolvedAddresses,
      requireResolvedAddress: false,
    });
    if (!policy.allowed || !policy.normalizedUrl) {
      throw new InternetError('Fetch destination was denied by policy.', 'BLOCKED_DESTINATION');
    }
    await waitForOperation(options, this.latencyMs);
    const snapshot = this.snapshots.get(policy.normalizedUrl);
    if (!snapshot) throw new InternetError('Mock fetch result is unavailable.', 'PROVIDER_UNAVAILABLE');
    const validated = validateSnapshot(snapshot);
    let previousUrl = policy.normalizedUrl;
    for (const [index, redirectUrl] of validated.redirects.entries()) {
      const redirect = evaluateRedirect(previousUrl, redirectUrl, index, {
        maxRedirectHops: request.maxRedirectHops,
        resolvedAddresses: request.resolvedAddresses,
      });
      if (!redirect.allowed) throwFetchPolicyError(redirect.reason ?? 'BLOCKED_REDIRECT');
      previousUrl = redirectUrl;
    }
    const finalPolicy = evaluateUrlPolicy(validated.finalUrl, {
      resolvedAddresses: request.resolvedAddresses,
      requireResolvedAddress: false,
    });
    if (!finalPolicy.allowed) throwFetchPolicyError('BLOCKED_DESTINATION');
    const content = evaluateContentPolicy(validated.contentType, validated.data.limits.observedBytes, {
      maxBytes: request.maxBytes,
      allowedMimeTypes: request.allowedMimeTypes,
    });
    if (!content.allowed) throwFetchPolicyError(content.reason ?? 'INVALID_CONTENT');
    return validated;
  }
}

class MockBrowserPage implements BrowserPage {
  private currentState: 'ready' | 'navigating' | 'loading' | 'stopping' | 'stopped' | 'failed' = 'ready';

  constructor(
    readonly id: string,
    private readonly providerId: string,
    private readonly latencyMs: number,
    private readonly snapshot: WebContentSnapshot,
  ) {}

  get state() { return this.currentState; }

  async navigate(url: string, options: InternetOperationOptions = {}): Promise<WebContentSnapshot> {
    const policy = evaluateUrlPolicy(url);
    if (!policy.allowed || !policy.normalizedUrl) {
      this.currentState = 'failed';
      throw new InternetError('Browser navigation was denied by policy.', 'BLOCKED_DESTINATION');
    }
    this.currentState = transitionInternetLifecycle(this.currentState, 'navigating') as typeof this.currentState;
    try {
      await waitForOperation(options, this.latencyMs);
      this.currentState = transitionInternetLifecycle(this.currentState, 'loading') as typeof this.currentState;
      await waitForOperation(options, 0);
      this.currentState = transitionInternetLifecycle(this.currentState, 'ready') as typeof this.currentState;
      return { ...this.snapshot, url: policy.normalizedUrl, finalUrl: policy.normalizedUrl, data: {
        ...this.snapshot.data,
        provenance: { ...this.snapshot.data.provenance, source: 'browser', provider: this.providerId, sourceUrl: policy.normalizedUrl },
      } };
    } catch (error) {
      this.currentState = 'failed';
      throw error;
    }
  }

  async perform(action: BrowserAction, options: InternetOperationOptions = {}): Promise<BrowserActionResult> {
    if (action.type === 'navigate') {
      await this.navigate(action.url, options);
      return { action: action.type, status: 'accepted' };
    }
    await waitForOperation(options, 0);
    if (action.type === 'type') return { action: action.type, status: 'rejected', reason: 'Writing actions require a separate authorization policy.' };
    return { action: action.type, status: 'accepted' };
  }

  async close(options: InternetOperationOptions = {}): Promise<void> {
    if (this.currentState === 'stopped') return;
    await waitForOperation(options, 0);
    this.currentState = transitionInternetLifecycle(this.currentState, 'stopping') as typeof this.currentState;
    this.currentState = transitionInternetLifecycle(this.currentState, 'stopped') as typeof this.currentState;
  }
}

class MockBrowserSession implements BrowserSession {
  private currentState: 'starting' | 'ready' | 'stopping' | 'stopped' = 'starting';
  private pageCounter = 0;
  private readonly pages = new Set<MockBrowserPage>();

  constructor(
    readonly id: string,
    private readonly providerId: string,
    private readonly latencyMs: number,
    private readonly snapshot: WebContentSnapshot,
  ) {
    this.currentState = transitionInternetLifecycle(this.currentState, 'ready') as typeof this.currentState;
  }

  get state() { return this.currentState; }

  async createPage(options: InternetOperationOptions = {}): Promise<BrowserPage> {
    if (this.currentState !== 'ready') throw new InternetError('Browser session is not ready.', 'LIFECYCLE_FAILURE');
    await waitForOperation(options, 0);
    const page = new MockBrowserPage(`${this.id}-page-${++this.pageCounter}`, this.providerId, this.latencyMs, this.snapshot);
    this.pages.add(page);
    return page;
  }

  async close(options: InternetOperationOptions = {}): Promise<void> {
    if (this.currentState === 'stopped') return;
    await Promise.all([...this.pages].map((page) => page.close(options)));
    this.currentState = transitionInternetLifecycle(this.currentState, 'stopping') as typeof this.currentState;
    this.currentState = transitionInternetLifecycle(this.currentState, 'stopped') as typeof this.currentState;
  }
}

function defaultSnapshot(provider: string): WebContentSnapshot {
  const url = normalizeUrl('https://example.invalid/mock');
  return {
    kind: 'content-snapshot',
    url,
    finalUrl: url,
    statusCode: 200,
    contentType: 'text/plain',
    data: createWebData({
      content: 'Deterministic browser content.',
      provenance: { source: 'browser', provider, sourceUrl: url, fetchedAt: MOCK_TIMESTAMP },
      metadata: { contentType: 'text/plain', statusCode: 200 },
      maxBytes: 4096,
    }),
    redirects: [],
  };
}

export class MockBrowserProvider implements BrowserProvider {
  readonly id: string;
  private readonly available: boolean;
  private readonly latencyMs: number;
  private sessionCounter = 0;
  private readonly sessions = new Set<BrowserSession>();

  constructor(id = 'mock-browser', options: MockProviderOptions = {}) {
    this.id = id;
    this.available = options.available ?? true;
    this.latencyMs = options.latencyMs ?? 0;
  }

  isAvailable(): boolean { return this.available; }

  async createSession(options: InternetOperationOptions = {}): Promise<BrowserSession> {
    ensureAvailable(this.available);
    await waitForOperation(options, this.latencyMs);
    const session = new MockBrowserSession(`mock-session-${++this.sessionCounter}`, this.id, this.latencyMs, defaultSnapshot(this.id));
    this.sessions.add(session);
    return session;
  }

  async shutdown(options: InternetOperationOptions = {}): Promise<void> {
    await Promise.all([...this.sessions].map((session) => session.close(options)));
    this.sessions.clear();
  }
}
