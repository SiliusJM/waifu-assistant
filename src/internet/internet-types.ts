export const INTERNET_PERMISSION_MODES = ['auto', 'confirm', 'block'] as const;
export type InternetPermissionMode = (typeof INTERNET_PERMISSION_MODES)[number];

export const INTERNET_LIFECYCLE_STATES = [
  'created',
  'starting',
  'ready',
  'navigating',
  'loading',
  'stopping',
  'stopped',
  'failed',
  'crashed',
] as const;
export type InternetLifecycleState = (typeof INTERNET_LIFECYCLE_STATES)[number];

export interface WebDataProvenance {
  readonly source: 'search' | 'fetch' | 'browser';
  readonly provider: string;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
}

export interface WebDataLimits {
  readonly maxBytes: number;
  readonly observedBytes: number;
  readonly truncated: boolean;
}

export interface WebDataMetadata {
  readonly contentType?: string;
  readonly language?: string;
  readonly statusCode?: number;
  readonly title?: string;
}

/** Data from the web is untrusted content, never an instruction or authorization. */
export interface WebData {
  readonly kind: 'untrusted-web-data';
  readonly trust: 'untrusted';
  readonly content: string;
  readonly provenance: WebDataProvenance;
  readonly metadata: WebDataMetadata;
  readonly limits: WebDataLimits;
}

export interface WebSearchRequest {
  readonly query: string;
  readonly maxResults?: number;
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: WebData;
}

export interface WebSearchResponse {
  readonly kind: 'search-response';
  readonly items: readonly WebSearchResult[];
  readonly provider: string;
  readonly completedAt: string;
}

export interface WebFetchRequest {
  readonly url: string;
  readonly maxBytes?: number;
  readonly maxRedirectHops?: number;
  readonly allowedMimeTypes?: readonly string[];
  readonly resolvedAddresses?: readonly string[];
}

export interface WebContentSnapshot {
  readonly kind: 'content-snapshot';
  readonly url: string;
  readonly finalUrl: string;
  readonly statusCode: number;
  readonly contentType: string;
  readonly data: WebData;
  readonly redirects: readonly string[];
}

export interface InternetOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface WebSearchProvider {
  readonly id: string;
  readonly isAvailable?: () => boolean | Promise<boolean>;
  search(
    request: WebSearchRequest,
    options?: InternetOperationOptions,
  ): Promise<WebSearchResponse>;
}

export interface WebFetchProvider {
  readonly id: string;
  readonly isAvailable?: () => boolean | Promise<boolean>;
  fetch(
    request: WebFetchRequest,
    options?: InternetOperationOptions,
  ): Promise<WebContentSnapshot>;
}

export type BrowserAction =
  | { readonly type: 'navigate'; readonly url: string }
  | { readonly type: 'back' }
  | { readonly type: 'forward' }
  | { readonly type: 'reload' }
  | { readonly type: 'wait-for-ready' }
  | { readonly type: 'click'; readonly target: string }
  | { readonly type: 'type'; readonly target: string; readonly value: string }
  | { readonly type: 'select'; readonly target: string; readonly value: string }
  | { readonly type: 'scroll'; readonly direction: 'up' | 'down' };

export interface BrowserActionResult {
  readonly action: BrowserAction['type'];
  readonly status: 'accepted' | 'rejected';
  readonly reason?: string;
}

export interface BrowserPage {
  readonly id: string;
  readonly state: InternetLifecycleState;
  navigate(url: string, options?: InternetOperationOptions): Promise<WebContentSnapshot>;
  perform(action: BrowserAction, options?: InternetOperationOptions): Promise<BrowserActionResult>;
  close(options?: InternetOperationOptions): Promise<void>;
}

export interface BrowserSession {
  readonly id: string;
  readonly state: InternetLifecycleState;
  createPage(options?: InternetOperationOptions): Promise<BrowserPage>;
  close(options?: InternetOperationOptions): Promise<void>;
}

/** Abstract browser lifecycle; it deliberately contains no renderer or browser implementation. */
export interface BrowserProvider {
  readonly id: string;
  readonly isAvailable?: () => boolean | Promise<boolean>;
  createSession(options?: InternetOperationOptions): Promise<BrowserSession>;
  shutdown(options?: InternetOperationOptions): Promise<void>;
}
