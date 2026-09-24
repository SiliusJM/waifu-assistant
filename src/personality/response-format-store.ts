import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { AssistantError } from '../shared/errors.js';

export const RESPONSE_FORMATS = ['default', 'prose', 'bullets', 'steps'] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

function isResponseFormat(value: unknown): value is ResponseFormat {
  return typeof value === 'string' && RESPONSE_FORMATS.some((format) => format === value);
}

function formatError(message: string, cause?: unknown): AssistantError {
  return new AssistantError(message, { code: 'PERSONALITY_CONFIGURATION_ERROR', retryable: false, cause });
}

export function resolveResponseFormatPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YUKI_RESPONSE_FORMAT_PATH?.trim();
  return configured ? resolve(configured) : resolve(homedir(), '.waifu-assistant', 'response-format.json');
}

export class ResponseFormatStore {
  private format: ResponseFormat = 'default';
  private loaded = false;

  constructor(readonly filePath: string) {
    if (!filePath.trim()) throw formatError('The response format preferences path is invalid.');
  }

  getCurrent(): ResponseFormat {
    if (!this.loaded) throw formatError('Response format preferences have not been loaded.');
    return this.format;
  }

  async load(): Promise<ResponseFormat> {
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        this.format = 'default';
        this.loaded = true;
        return this.format;
      }
      throw formatError('Response format preferences could not be read.', error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch (error) {
      throw formatError('Response format preferences are invalid.', error);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !('format' in parsed) || !isResponseFormat(parsed.format)) {
      throw formatError('Response format preferences contain an unsupported value.');
    }
    this.format = parsed.format;
    this.loaded = true;
    return this.format;
  }

  async set(format: ResponseFormat): Promise<void> {
    if (!isResponseFormat(format)) throw formatError('The requested response format is not supported.');
    if (!this.loaded) await this.load();
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify({ format })}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      this.format = format;
    } catch (error) {
      throw formatError('Response format preferences could not be saved.', error);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
