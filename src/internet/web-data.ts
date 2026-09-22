import { InternetError } from './internet-errors.js';
import { evaluateUrlPolicy, normalizeUrl } from './url-policy.js';
import type { WebData, WebDataMetadata, WebDataProvenance } from './internet-types.js';

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  if (byteLength(value) <= maxBytes) {
    return { value, truncated: false };
  }
  let output = '';
  for (const character of value) {
    const candidate = output + character;
    if (byteLength(candidate) > maxBytes) break;
    output = candidate;
  }
  return { value: output, truncated: true };
}

export interface WebDataInput {
  readonly content: string;
  readonly provenance: Omit<WebDataProvenance, 'sourceUrl'> & { readonly sourceUrl: string };
  readonly metadata?: WebDataMetadata;
  readonly maxBytes: number;
}

export function createWebData(input: WebDataInput): WebData {
  if (!Number.isInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new InternetError('Web content limit is invalid.', 'INVALID_CONTENT');
  }
  if (!input.content || !input.provenance.sourceUrl || !input.provenance.provider) {
    throw new InternetError('Web content provenance is incomplete.', 'INVALID_CONTENT');
  }
  if (Number.isNaN(Date.parse(input.provenance.fetchedAt))) {
    throw new InternetError('Web content timestamp is invalid.', 'INVALID_CONTENT');
  }
  const normalizedSourceUrl = normalizeUrl(input.provenance.sourceUrl);
  const policy = evaluateUrlPolicy(normalizedSourceUrl);
  if (!policy.allowed || !policy.normalizedUrl) {
    throw new InternetError('Web content provenance URL was denied by policy.', 'BLOCKED_DESTINATION');
  }
  const normalized = truncateUtf8(input.content, input.maxBytes);
  return Object.freeze({
    kind: 'untrusted-web-data',
    trust: 'untrusted',
    content: normalized.value,
    provenance: Object.freeze({ ...input.provenance, sourceUrl: policy.normalizedUrl }),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    limits: Object.freeze({
      maxBytes: input.maxBytes,
      observedBytes: byteLength(normalized.value),
      truncated: normalized.truncated,
    }),
  });
}

export interface WebDataLogMetadata {
  readonly source: WebDataProvenance['source'];
  readonly provider: string;
  readonly sourceUrl: string;
  readonly contentType?: string;
  readonly observedBytes: number;
  readonly truncated: boolean;
}

export function summarizeWebData(data: WebData): WebDataLogMetadata {
  const source = new URL(data.provenance.sourceUrl);
  source.search = '';
  source.hash = '';
  return {
    source: data.provenance.source,
    provider: data.provenance.provider,
    // This is a telemetry-safe URL summary, not an absolute secret scrubber.
    sourceUrl: `${source.origin}${source.pathname}`,
    contentType: data.metadata.contentType,
    observedBytes: data.limits.observedBytes,
    truncated: data.limits.truncated,
  };
}
