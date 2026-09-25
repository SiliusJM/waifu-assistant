import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MockAudioInputProvider,
  MockAudioOutputProvider,
  MockSTTProvider,
  MockTTSProvider,
  MockStreamingAudioInputProvider,
  MockStreamingSTTProvider,
  SherpaVitsTTSProvider,
  VoiceService,
  WindowsCpalStreamingAudioOutputProvider,
  resolvePiperSpanishTtsModelPaths,
} from '../dist/voice/index.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const modelDirectory = process.env.YUKI_TTS_MODEL_DIR?.trim();

if (!modelDirectory) {
  process.stderr.write('LOCAL_TTS_PLAYBACK=BLOCKED code=VOICE_CONFIGURATION_ERROR reason=YUKI_TTS_MODEL_DIR_missing\n');
  process.exitCode = 2;
} else {
  let service;
  try {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const tts = new SherpaVitsTTSProvider(resolvePiperSpanishTtsModelPaths(modelDirectory, repositoryRoot));
    const output = new WindowsCpalStreamingAudioOutputProvider();
    service = new VoiceService({
      input: new MockAudioInputProvider(),
      stt: new MockSTTProvider(),
      tts: new MockTTSProvider(),
      output: new MockAudioOutputProvider(),
      logger: silentLogger,
      streaming: {
        input: new MockStreamingAudioInputProvider(),
        stt: new MockStreamingSTTProvider(),
        tts,
        output,
        queueCapacity: 32,
        streamCapacity: 32,
        defaultTimeoutMs: 60_000,
        logger: silentLogger,
      },
    });

    const operation = service.startStreamingSynthesis({
      sessionId: 'local-tts-playback-smoke',
      text: 'Hola, soy Yuki. La prueba de voz local está funcionando.',
    });
    const eventsPromise = (async () => {
      let outputStarted = false;
      for await (const event of operation.events()) {
        if (event.type === 'audio_output_started') outputStarted = true;
      }
      return outputStarted;
    })();
    const [result, outputStarted] = await Promise.all([operation.result(), eventsPromise]);
    if (result.status !== 'completed' || !outputStarted
      || result.value.byteLength <= 0 || result.value.chunkCount <= 0 || (result.value.durationMs ?? 0) <= 0) {
      const code = result.status === 'failed' ? result.code : 'VOICE_OUTPUT_ERROR';
      process.stderr.write(`LOCAL_TTS_PLAYBACK=FAIL code=${code}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(JSON.stringify({
        status: 'PASS',
        provider: 'sherpa-onnx-vits-local',
        output: 'node-cpal-windows-default-output',
        chunkCount: result.value.chunkCount,
        byteLength: result.value.byteLength,
        durationMs: Math.round(result.value.durationMs ?? 0),
        outputStarted,
      }) + '\n');
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code)
      ? error.code
      : 'VOICE_TTS_ERROR';
    process.stderr.write(`LOCAL_TTS_PLAYBACK=FAIL code=${code}\n`);
    process.exitCode = 1;
  } finally {
    await service?.shutdownStreaming();
  }
}
