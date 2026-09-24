import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { AssistantError } from '../shared/errors.js';

export const CONVERSATION_TONES = ['default', 'concise', 'warm', 'technical', 'playful'] as const;
export type ConversationTone = (typeof CONVERSATION_TONES)[number];

function isConversationTone(value: unknown): value is ConversationTone {
  return typeof value === 'string' && CONVERSATION_TONES.some((tone) => tone === value);
}

function toneError(message: string, cause?: unknown): AssistantError {
  return new AssistantError(message, { code: 'PERSONALITY_CONFIGURATION_ERROR', retryable: false, cause });
}

export function resolveConversationTonePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.YUKI_TONE_PREFERENCES_PATH?.trim();
  return configured ? resolve(configured) : resolve(homedir(), '.waifu-assistant', 'conversation-tone.json');
}

export class ConversationToneStore {
  private tone: ConversationTone = 'default';
  private loaded = false;

  constructor(readonly filePath: string) {
    if (!filePath.trim()) throw toneError('The conversation tone preferences path is invalid.');
  }

  getCurrent(): ConversationTone {
    if (!this.loaded) throw toneError('Conversation tone preferences have not been loaded.');
    return this.tone;
  }

  async load(): Promise<ConversationTone> {
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        this.tone = 'default';
        this.loaded = true;
        return this.tone;
      }
      throw toneError('Conversation tone preferences could not be read.', error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch (error) {
      throw toneError('Conversation tone preferences are invalid.', error);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !('tone' in parsed) || !isConversationTone(parsed.tone)) {
      throw toneError('Conversation tone preferences contain an unsupported value.');
    }
    this.tone = parsed.tone;
    this.loaded = true;
    return this.tone;
  }

  async set(tone: ConversationTone): Promise<void> {
    if (!isConversationTone(tone)) throw toneError('The requested conversation tone is not supported.');
    if (!this.loaded) await this.load();
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, `${JSON.stringify({ tone })}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      this.tone = tone;
    } catch (error) {
      throw toneError('Conversation tone preferences could not be saved.', error);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
