import { InternetError } from './internet-errors.js';

export const ALLOWED_INTERNET_SCHEMES = ['http:', 'https:'] as const;
export const DEFAULT_ALLOWED_MIME_TYPES = [
  'application/json',
  'application/xhtml+xml',
  'text/html',
  'text/plain',
] as const;

export type DestinationKind =
  | 'public'
  | 'hostname'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'multicast'
  | 'reserved';

export interface UrlPolicyOptions {
  readonly resolvedAddresses?: readonly string[];
  readonly requireResolvedAddress?: boolean;
}

declare const normalizedUrlBrand: unique symbol;
export type NormalizedUrl = string & { readonly [normalizedUrlBrand]: true };

export interface UrlPolicyDecision {
  readonly allowed: boolean;
  readonly normalizedUrl?: NormalizedUrl;
  readonly scheme?: string;
  readonly destination?: DestinationKind;
  readonly reason?: string;
}

export interface RedirectPolicyOptions extends UrlPolicyOptions {
  readonly maxRedirectHops?: number;
}

export interface ContentPolicyOptions {
  readonly maxBytes?: number;
  readonly allowedMimeTypes?: readonly string[];
}

export interface ContentPolicyDecision {
  readonly allowed: boolean;
  readonly normalizedMimeType?: string;
  readonly reason?: string;
}

function parseIpv4(value: string): readonly number[] | undefined {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : undefined;
}

function ipv4Kind(parts: readonly number[]): DestinationKind {
  const [first = 0, second = 0, third = 0, fourth = 0] = parts;
  if (first === 127) return 'loopback';
  if (first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)) return 'private';
  if (first === 169 && second === 254) return 'link-local';
  if (first >= 224 && first <= 239) return 'multicast';
  if (first === 0 || (first === 100 && second >= 64 && second <= 127)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 198 && second === 18)
    || (first === 198 && second === 19)
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 240 || (first === 255 && second === 255 && third === 255 && fourth === 255)) {
    return 'reserved';
  }
  return 'public';
}

function parseIpv6Groups(value: string): readonly number[] | undefined {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes(':')) return undefined;
  const halves = host.split('::');
  if (halves.length > 2) return undefined;
  const expand = (half: string): number[] | undefined => {
    if (!half) return [];
    const parts = half.split(':');
    const output: number[] = [];
    for (const part of parts) {
      if (part.includes('.')) {
        const ipv4 = parseIpv4(part);
        if (!ipv4 || part !== parts[parts.length - 1]) return undefined;
        output.push((ipv4[0] ?? 0) * 256 + (ipv4[1] ?? 0));
        output.push((ipv4[2] ?? 0) * 256 + (ipv4[3] ?? 0));
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        output.push(Number.parseInt(part, 16));
      } else {
        return undefined;
      }
    }
    return output;
  };
  const left = expand(halves[0] ?? '');
  const right = expand(halves[1] ?? '');
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function mappedIpv4Kind(value: string): DestinationKind | undefined {
  const groups = parseIpv6Groups(value);
  if (!groups || groups.length !== 8 || groups.slice(0, 5).some((group) => group !== 0) || groups[5] !== 0xffff) {
    return undefined;
  }
  const first = groups[6] ?? 0;
  const second = groups[7] ?? 0;
  return ipv4Kind([first >> 8, first & 0xff, second >> 8, second & 0xff]);
}

function ipv6Kind(value: string): DestinationKind | undefined {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes(':')) return undefined;
  const mappedKind = mappedIpv4Kind(host);
  if (mappedKind) return mappedKind;
  if (host === '::1') return 'loopback';
  if (host.startsWith('ff')) return 'multicast';
  if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
    return 'link-local';
  }
  if (host.startsWith('fc') || host.startsWith('fd')) return 'private';
  if (host === '::' || host.startsWith('2001:db8:')) return 'reserved';
  return 'public';
}

export function classifyDestination(hostname: string): DestinationKind {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = parseIpv4(normalized);
  if (ipv4) return ipv4Kind(ipv4);
  const ipv6 = ipv6Kind(normalized);
  if (ipv6) return ipv6;
  if (normalized === 'localhost' || normalized.endsWith('.localhost')
    || normalized.endsWith('.internal') || normalized.endsWith('.local')) {
    return 'reserved';
  }
  return 'hostname';
}

function isRestricted(kind: DestinationKind): boolean {
  return kind !== 'public' && kind !== 'hostname';
}

export function normalizeUrl(input: string): NormalizedUrl {
  if (typeof input !== 'string' || !input.trim()) {
    throw new InternetError('URL is invalid.', 'INVALID_URL');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new InternetError('URL is invalid.', 'INVALID_URL', false, error);
  }
  if (!ALLOWED_INTERNET_SCHEMES.includes(url.protocol as (typeof ALLOWED_INTERNET_SCHEMES)[number])) {
    throw new InternetError('URL scheme is not allowed.', 'UNSUPPORTED_SCHEME');
  }
  if (url.username || url.password) {
    throw new InternetError('URL credentials are not allowed.', 'INVALID_URL');
  }
  url.hash = '';
  return url.toString() as NormalizedUrl;
}

export function evaluateUrlPolicy(input: string, options: UrlPolicyOptions = {}): UrlPolicyDecision {
  try {
    const normalizedUrl = normalizeUrl(input);
    const url = new URL(normalizedUrl);
    const resolved = options.resolvedAddresses ?? [];
    const addressKinds = resolved.map(classifyDestination);
    const destination = addressKinds.find(isRestricted) ?? classifyDestination(url.hostname);
    if (isRestricted(destination)) {
      return { allowed: false, normalizedUrl, scheme: url.protocol, destination, reason: 'Destination is restricted.' };
    }
    if (options.requireResolvedAddress && resolved.length === 0) {
      return {
        allowed: false,
        normalizedUrl,
        scheme: url.protocol,
        destination: 'hostname',
        reason: 'Resolved destination evidence is required.',
      };
    }
    return { allowed: true, normalizedUrl, scheme: url.protocol, destination };
  } catch (error) {
    if (error instanceof InternetError) {
      return { allowed: false, reason: error.internetCode };
    }
    return { allowed: false, reason: 'INVALID_URL' };
  }
}

export function evaluateRedirect(
  fromUrl: string,
  targetUrl: string,
  hops: number,
  options: RedirectPolicyOptions = {},
): UrlPolicyDecision {
  const maxHops = options.maxRedirectHops ?? 5;
  if (!Number.isInteger(hops) || hops < 0 || hops >= maxHops) {
    return { allowed: false, reason: 'TOO_MANY_REDIRECTS' };
  }
  const from = evaluateUrlPolicy(fromUrl, options);
  if (!from.allowed) return { allowed: false, reason: 'BLOCKED_REDIRECT' };
  const target = evaluateUrlPolicy(targetUrl, options);
  return target.allowed ? target : { ...target, reason: target.reason ?? 'BLOCKED_REDIRECT' };
}

export function evaluateContentPolicy(
  contentType: string,
  sizeBytes: number,
  options: ContentPolicyOptions = {},
): ContentPolicyDecision {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return { allowed: false, reason: 'INVALID_CONTENT' };
  }
  const maxBytes = options.maxBytes ?? 1_048_576;
  if (sizeBytes > maxBytes) return { allowed: false, reason: 'CONTENT_TOO_LARGE' };
  const normalizedMimeType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (!normalizedMimeType) return { allowed: false, reason: 'INVALID_CONTENT' };
  const allowed = (options.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES)
    .map((value) => value.toLowerCase())
    .includes(normalizedMimeType);
  return allowed
    ? { allowed: true, normalizedMimeType }
    : { allowed: false, normalizedMimeType, reason: 'INVALID_CONTENT' };
}
