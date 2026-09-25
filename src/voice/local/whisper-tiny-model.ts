import { isAbsolute, relative, resolve, sep } from 'node:path';
import { VoiceError } from '../voice-errors.js';

export const WHISPER_TINY_MODEL = {
  repository: 'csukuangfj/sherpa-onnx-whisper-tiny',
  revision: '65176e2deb88badc814a94058666cadccc29b61c',
  language: 'auto',
  files: [
    { name: 'tiny-encoder.int8.onnx', sha256: 'd24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434', maxBytes: 20_000_000 },
    { name: 'tiny-decoder.int8.onnx', sha256: 'd2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925', maxBytes: 100_000_000 },
    { name: 'tiny-tokens.txt', sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126', maxBytes: 1_000_000 },
  ],
} as const;

export function resolveWhisperTinyModelPaths(directory: string, repositoryRoot = process.cwd()): {
  readonly encoder: string;
  readonly decoder: string;
  readonly tokens: string;
} {
  if (!directory.trim() || !isAbsolute(directory)) {
    throw new VoiceError('YUKI_STT_MODEL_DIR must be an absolute external directory.', 'VOICE_CONFIGURATION_ERROR');
  }
  const target = resolve(directory);
  const fromRoot = relative(resolve(repositoryRoot), target);
  if (fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
    throw new VoiceError('The local STT model directory must be outside the repository.', 'VOICE_CONFIGURATION_ERROR');
  }
  return {
    encoder: resolve(target, WHISPER_TINY_MODEL.files[0].name),
    decoder: resolve(target, WHISPER_TINY_MODEL.files[1].name),
    tokens: resolve(target, WHISPER_TINY_MODEL.files[2].name),
  };
}
