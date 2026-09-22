import { InternetError } from './internet-errors.js';
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
  readonly provenance: WebDataProvenance;
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
  const normalized = truncateUtf8(input.content, input.maxBytes);
  return Object.freeze({
    kind: 'untrusted-web-data',
    trust: 'untrusted',
    content: normalized.value,
    provenance: Object.freeze({ ...input.provenance }),
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
  return {
    source: data.provenance.source,
    provider: data.provenance.provider,
    sourceUrl: data.provenance.sourceUrl,
    contentType: data.metadata.contentType,
    observedBytes: data.limits.observedBytes,
    truncated: data.limits.truncated,
  };
}
