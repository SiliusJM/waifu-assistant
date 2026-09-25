import { isAbsolute, relative, resolve, sep } from 'node:path';
import { VoiceError } from '../voice-errors.js';

export const PIPER_SPANISH_TTS_MODEL = {
  name: 'vits-piper-es_AR-daniela-high-int8',
  language: 'es-AR',
  source: 'k2-fsa/sherpa-onnx release tts-models',
  archive: 'vits-piper-es_AR-daniela-high-int8.tar.bz2',
  archiveSha256: '7218f0a119e4c16533ac187f71ab3019f2092f1594e43fef8392ae1f5b64abab',
  modelSha256: 'ddc4fd3cf096a5a7f7f1759cf045eee73ea4cd365fe3e7576801de6b3765d0fb',
  sampleRateHz: 22050,
} as const;

export interface PiperSpanishTtsModelPaths {
  readonly model: string;
  readonly tokens: string;
  readonly dataDir: string;
}

export function resolvePiperSpanishTtsModelPaths(directory: string, repositoryRoot = process.cwd()): PiperSpanishTtsModelPaths {
  if (!directory.trim() || !isAbsolute(directory)) {
    throw new VoiceError('YUKI_TTS_MODEL_DIR must be an absolute external directory.', 'VOICE_CONFIGURATION_ERROR');
  }
  const target = resolve(directory);
  const fromRoot = relative(resolve(repositoryRoot), target);
  if (fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
    throw new VoiceError('The local TTS model directory must be outside the repository.', 'VOICE_CONFIGURATION_ERROR');
  }
  return {
    model: resolve(target, 'es_AR-daniela-high.onnx'),
    tokens: resolve(target, 'tokens.txt'),
    dataDir: resolve(target, 'espeak-ng-data'),
  };
}
