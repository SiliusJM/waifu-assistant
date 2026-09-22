import type { ToolError } from '../tools/errors.js';
import type { Tool } from '../tools/tool-types.js';
import { InternetError, isInternetError } from './internet-errors.js';
import type { WebFetchProvider, WebSearchProvider } from './internet-types.js';

export const INTERNET_TOOL_IDS = {
  search: 'internet.search',
  fetch: 'internet.fetch',
} as const;

function mapFailure(error: unknown): { readonly code: ToolError['code']; readonly message: string; readonly retryable: boolean } {
  if (isInternetError(error)) {
    switch (error.internetCode) {
      case 'CANCELLATION': return { code: 'TOOL_CANCELLATION_ERROR', message: 'Internet operation was cancelled.', retryable: false };
      case 'TIMEOUT': return { code: 'TOOL_TIMEOUT_ERROR', message: 'Internet operation timed out.', retryable: true };
      case 'PROVIDER_UNAVAILABLE': return { code: 'TOOL_UNAVAILABLE_ERROR', message: 'Internet provider is unavailable.', retryable: true };
      case 'AUTHORIZATION_DENIED':
      case 'BLOCKED_DESTINATION':
      case 'BLOCKED_REDIRECT':
      case 'INVALID_URL':
      case 'UNSUPPORTED_SCHEME':
      case 'TOO_MANY_REDIRECTS':
        return { code: 'TOOL_PERMISSION_ERROR', message: 'Internet request was denied by policy.', retryable: false };
      default: return { code: 'TOOL_EXECUTION_ERROR', message: 'Internet operation failed.', retryable: error.retryable };
    }
  }
  return { code: 'TOOL_EXECUTION_ERROR', message: 'Internet operation failed.', retryable: false };
}

function controlledFailure(error: unknown) {
  const mapped = mapFailure(error);
  return { status: 'failure' as const, error: mapped };
}

export function createInternetTools(providers: {
  readonly search: WebSearchProvider;
  readonly fetch: WebFetchProvider;
}): readonly [Tool<{ readonly query: string; readonly maxResults?: number }>, Tool<{ readonly url: string }>] {
  const searchTool: Tool<{ readonly query: string; readonly maxResults?: number }> = {
    id: INTERNET_TOOL_IDS.search,
    name: 'Internet search',
    description: 'Searches through an abstract provider and returns untrusted normalized data.',
    risk: 'low',
    argumentSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', required: true, minLength: 1, maxLength: 512 },
        maxResults: { type: 'number', minimum: 1, maximum: 20 },
      },
    },
    isAvailable: () => providers.search.isAvailable?.() ?? true,
    execute: async (argumentsValue, context) => {
      try {
        return { status: 'success', value: await providers.search.search(argumentsValue, { signal: context.signal }) };
      } catch (error) {
        return controlledFailure(error);
      }
    },
  };

  const fetchTool: Tool<{ readonly url: string }> = {
    id: INTERNET_TOOL_IDS.fetch,
    name: 'Internet fetch',
    description: 'Fetches a policy-approved URL and returns an untrusted normalized snapshot.',
    risk: 'low',
    argumentSchema: {
      type: 'object',
      properties: { url: { type: 'string', required: true, minLength: 1, maxLength: 2048 } },
    },
    isAvailable: () => providers.fetch.isAvailable?.() ?? true,
    execute: async (argumentsValue, context) => {
      try {
        return { status: 'success', value: await providers.fetch.fetch(argumentsValue, { signal: context.signal }) };
      } catch (error) {
        return controlledFailure(error);
      }
    },
  };

  return [searchTool, fetchTool];
}

export function toInternetError(error: unknown): InternetError {
  return isInternetError(error)
    ? error
    : new InternetError('Internet operation failed.', 'PROVIDER_UNAVAILABLE', false, error);
}
