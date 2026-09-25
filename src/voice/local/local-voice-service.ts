import { MockAudioInputProvider, MockAudioOutputProvider, MockSTTProvider, MockTTSProvider } from '../mock-providers.js';
import {
  MockStreamingAudioOutputProvider,
  MockStreamingTTSProvider,
} from '../streaming-mock-providers.js';
import { VoiceService } from '../voice-service.js';
import { SherpaWhisperSTTProvider, type SherpaRuntime, type SherpaWhisperModelPaths } from './sherpa-whisper-stt-provider.js';
import { WindowsMicrophoneInputProvider, type CpalRuntime } from './windows-microphone-input-provider.js';

export function createLocalMicrophoneVoiceService(
  model: SherpaWhisperModelPaths,
  options: { readonly cpalRuntime?: CpalRuntime; readonly sherpaRuntime?: SherpaRuntime; readonly defaultTimeoutMs?: number } = {},
): {
  readonly service: VoiceService;
  readonly microphone: WindowsMicrophoneInputProvider;
  readonly stt: SherpaWhisperSTTProvider;
} {
  const microphone = new WindowsMicrophoneInputProvider({ runtime: options.cpalRuntime });
  const stt = new SherpaWhisperSTTProvider(model, options.sherpaRuntime);
  const service = new VoiceService({
    input: new MockAudioInputProvider(),
    stt: new MockSTTProvider(),
    tts: new MockTTSProvider(),
    output: new MockAudioOutputProvider(),
    streaming: {
      input: microphone,
      stt,
      // Voice V1 adds input only; the existing orchestrator's synthesis contract remains safely mocked.
      tts: new MockStreamingTTSProvider(),
      output: new MockStreamingAudioOutputProvider(),
      defaultTimeoutMs: options.defaultTimeoutMs ?? 35_000,
      queueCapacity: 32,
      streamCapacity: 32,
    },
  });
  return { service, microphone, stt };
}
