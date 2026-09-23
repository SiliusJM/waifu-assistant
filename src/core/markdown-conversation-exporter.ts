import { randomUUID } from 'node:crypto';
import { access, link, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Message } from './message.js';
import { AssistantError } from '../shared/errors.js';

export interface ConversationExportFileSystem {
  readonly mkdir: (path: string) => Promise<void>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly link: (existingPath: string, newPath: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
}

const defaultFileSystem: ConversationExportFileSystem = {
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  writeFile: async (path, content) => { await writeFile(path, content, { encoding: 'utf8', flag: 'wx' }); },
  link,
  rm: async (path) => { await rm(path, { force: true }); },
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  },
};

export type ConversationExportResult =
  | { readonly status: 'empty' }
  | { readonly status: 'exported'; readonly fileName: string; readonly filePath: string; readonly messageCount: number };

function exportError(message: string, code: 'EXPORT_CONFIGURATION_ERROR' | 'EXPORT_IO_ERROR', cause?: unknown): AssistantError {
  return new AssistantError(message, { code, retryable: false, cause });
}

function sanitizeCustomName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || /^[A-Za-z]:/u.test(trimmed) || /[\\/]/u.test(trimmed)) {
    throw exportError('Usa un nombre de archivo, no una ruta. No se permiten carpetas en /export.', 'EXPORT_CONFIGURATION_ERROR');
  }

  const withoutExtension = trimmed.replace(/\.md$/iu, '');
  let name = [...withoutExtension.normalize('NFC')]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return '<>:"|?*'.includes(character) || codePoint <= 0x1f || codePoint === 0x7f ? '-' : character;
    })
    .join('')
    .replace(/\s+/gu, '-')
    .replace(/^\.+/u, '')
    .replace(/[. ]+$/u, '');
  if (!name) throw exportError('El nombre de exportación no es válido.', 'EXPORT_CONFIGURATION_ERROR');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(name)) name = `_${name}`;
  if (name.length > 120) throw exportError('El nombre de exportación no puede superar 120 caracteres.', 'EXPORT_CONFIGURATION_ERROR');
  return name;
}

function defaultName(date: Date): string {
  const iso = date.toISOString();
  return `yuki-conversation-${iso.slice(0, 10)}-${iso.slice(11, 19).replaceAll(':', '')}`;
}

function formatMarkdown(messages: readonly Message[], exportedAt: string): string {
  const sections = messages.map(({ role, content }) => {
    const label = role === 'user' ? 'Usuario' : 'Yuki';
    return `## ${label}\n\n${content.replace(/\r\n?/gu, '\n')}`;
  });
  return [
    '# Conversación con Yuki',
    `- Exportada: ${exportedAt}`,
    `- Mensajes: ${messages.length}`,
    '',
    '---',
    '',
    sections.join('\n\n---\n\n'),
    '',
  ].join('\n');
}

export function resolveConversationExportDirectory(): string {
  return join(homedir(), '.waifu-assistant', 'exports');
}

export class MarkdownConversationExporter {
  constructor(
    readonly directory: string = resolveConversationExportDirectory(),
    private readonly fileSystem: ConversationExportFileSystem = defaultFileSystem,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async exportConversation(messages: readonly Message[], requestedName?: string): Promise<ConversationExportResult> {
    const visibleMessages = messages.filter(({ role, content }) =>
      (role === 'user' || role === 'assistant') && typeof content === 'string' && content.length > 0);
    if (visibleMessages.length === 0) return { status: 'empty' };

    const now = this.clock();
    if (Number.isNaN(now.getTime())) {
      throw exportError('No se pudo determinar la fecha de exportación.', 'EXPORT_CONFIGURATION_ERROR');
    }
    const baseName = requestedName === undefined ? defaultName(now) : sanitizeCustomName(requestedName);
    const exportedAt = now.toISOString();
    const document = formatMarkdown(visibleMessages, exportedAt);
    let temporaryPath: string | undefined;
    let linkedPath: string | undefined;

    try {
      await this.fileSystem.mkdir(this.directory);
      temporaryPath = join(this.directory, `.yuki-export-${randomUUID()}.tmp`);
      await this.fileSystem.writeFile(temporaryPath, document);

      for (let suffix = 1; ; suffix += 1) {
        const fileName = `${baseName}${suffix === 1 ? '' : `-${suffix}`}.md`;
        const filePath = join(this.directory, fileName);
        if (await this.fileSystem.exists(filePath)) continue;
        try {
          await this.fileSystem.link(temporaryPath, filePath);
          linkedPath = filePath;
          break;
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') continue;
          throw error;
        }
      }
      const fileName = linkedPath.slice(this.directory.length + 1);
      return { status: 'exported', fileName, filePath: linkedPath, messageCount: visibleMessages.length };
    } catch (error) {
      throw exportError('No se pudo escribir la exportación. Verifica que el directorio de datos de Yuki permita escritura.', 'EXPORT_IO_ERROR', error);
    } finally {
      if (temporaryPath) {
        try { await this.fileSystem.rm(temporaryPath); } catch { /* The complete export, if linked, remains valid. */ }
      }
    }
  }
}
