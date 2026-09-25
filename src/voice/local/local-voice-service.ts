import { MockAudioInputProvider, MockAudioOutputProvider, MockSTTProvider, MockTTSProvider } from '../mock-providers.js';
import {
  MockStreamingAudioOutputProvider,
  MockStreamingTTSProvider,
} from '../streaming-mock-providers.js';
import { VoiceService } from '../voice-service.js';
import { SherpaWhisperSTTProvider, type SherpaRuntime, type SherpaWhisperModelPaths } from './sherpa-whisper-stt-provider.js';
import { SherpaVitsTTSProvider } from './sherpa-vits-tts-provider.js';
import type { PiperSpanishTtsModelPaths } from './piper-spanish-tts-model.js';
import { WindowsCpalStreamingAudioOutputProvider } from './windows-cpal-audio-output-provider.js';
import { WindowsMicrophoneInputProvider, type CpalRuntime } from './windows-microphone-input-provider.js';

export function createLocalMicrophoneVoiceService(
  model: SherpaWhisperModelPaths,
  options: {
    readonly cpalRuntime?: CpalRuntime;
    readonly sherpaRuntime?: SherpaRuntime;
    readonly defaultTimeoutMs?: number;
    readonly ttsModel?: PiperSpanishTtsModelPaths;
    readonly vadModelPath?: string;
    readonly vadMinSilenceMs?: number;
  } = {},
): {
  readonly service: VoiceService;
  readonly microphone: WindowsMicrophoneInputProvider;
  readonly stt: SherpaWhisperSTTProvider;
  readonly tts: SherpaVitsTTSProvider | undefined;
} {
  const microphone = new WindowsMicrophoneInputProvider({ runtime: options.cpalRuntime });
  const stt = new SherpaWhisperSTTProvider(model, options.sherpaRuntime, options.vadModelPath ? {
    modelPath: options.vadModelPath,
    minSilenceMs: options.vadMinSilenceMs,
  } : undefined);
  const tts = options.ttsModel ? new SherpaVitsTTSProvider(options.ttsModel) : undefined;
  const service = new VoiceService({
    input: new MockAudioInputProvider(),
    stt: new MockSTTProvider(),
    tts: new MockTTSProvider(),
    output: new MockAudioOutputProvider(),
    streaming: {
      input: microphone,
      stt,
      tts: tts ?? new MockStreamingTTSProvider(),
      output: tts ? new WindowsCpalStreamingAudioOutputProvider() : new MockStreamingAudioOutputProvider(),
      defaultTimeoutMs: options.defaultTimeoutMs ?? 35_000,
      queueCapacity: 32,
      streamCapacity: 32,
    },
  });
  return { service, microphone, stt, tts };
}
