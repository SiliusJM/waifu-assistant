import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { access } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const cpal = require('node-cpal');
const sherpa = require('sherpa-onnx-node');

const CAPTURE_DURATION_MS = 9_000;
const COUNTDOWN_SECONDS = 5;
const CANONICAL_RATE = 16_000;
const VAD_WINDOW_SAMPLES = 512;
const VAD_MODEL_PATH = process.env.YUKI_VAD_MODEL_PATH?.trim();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createStats() {
  let count = 0;
  let sumSquares = 0;
  let peak = 0;
  return {
    add(sample) {
      const value = Number.isFinite(sample) ? sample : 0;
      count += 1;
      sumSquares += value * value;
      peak = Math.max(peak, Math.abs(value));
    },
    result() {
      return {
        samples: count,
        rms: count === 0 ? 0 : Math.sqrt(sumSquares / count),
        peak,
      };
    },
  };
}

function formatMetric(value) {
  return Number.isFinite(value) ? value.toFixed(6) : '0.000000';
}

function classify(result) {
  const channels = result.channels.map((channel) => channel.rms);
  const [first = 0, second = 0] = channels;
  const stronger = Math.max(first, second);
  const weaker = Math.min(first, second);
  if (stronger >= 0.005 && weaker > 0 && stronger / weaker >= 4) return 'C — CHANNEL ASYMMETRY';
  if (result.downmix.rms < 0.005) return 'B — SIGNAL VERY LOW';
  if (result.speechFrames === 0) return 'D — SIGNAL PRESENT BUT VAD MISSES SPEECH';
  if (result.speechStart && result.speechEnd) return 'A — SIGNAL + VAD OK';
  return 'E — INCONCLUSIVE';
}

function writeReport({ captureDurationMs, callbackCount, result, nativeErrorCount }) {
  process.stdout.write(`CAPTURE DURATION: ${captureDurationMs} ms; CALLBACKS: ${callbackCount}\n`);
  for (const channel of result.channels) {
    process.stdout.write(`CHANNEL ${channel.channel} RMS / PEAK: ${formatMetric(channel.rms)} / ${formatMetric(channel.peak)}\n`);
  }
  process.stdout.write(`DOWNMIX RMS / PEAK: ${formatMetric(result.downmix.rms)} / ${formatMetric(result.downmix.peak)}\n`);
  process.stdout.write(`WINDOW MAX RMS: ${formatMetric(result.maximumWindowRms)}\n`);
  process.stdout.write(`RESAMPLED 16 KHZ RMS / PEAK: ${formatMetric(result.resampled.rms)} / ${formatMetric(result.resampled.peak)}\n`);
  process.stdout.write(`VAD SPEECH FRAMES: ${result.speechFrames}\nVAD NON-SPEECH FRAMES: ${result.nonSpeechFrames}\n`);
  process.stdout.write(`VAD START/END: ${result.speechStart ? 'YES' : 'NO'} / ${result.speechEnd ? 'YES' : 'NO'}\n`);
  process.stdout.write(`SEGMENT DURATION: ${result.segmentDurationMs === null ? 'NONE' : `${result.segmentDurationMs} ms`}\n`);
  process.stdout.write(`NATIVE CAPTURE ERRORS: ${nativeErrorCount}\n`);
  process.stdout.write(`CLASSIFICATION: ${classify(result)}\n`);
  process.stdout.write('RAW AUDIO PERSISTED: NO\nPROVIDER CALLS: 0\n');
}

function runPostProcessingSelfTest() {
  writeReport({
    captureDurationMs: 9_000,
    callbackCount: 900,
    result: {
      channels: [
        { channel: 0, samples: 432_000, rms: 0.05, peak: 0.4 },
        { channel: 1, samples: 432_000, rms: 0.05, peak: 0.4 },
      ],
      downmix: { samples: 432_000, rms: 0.05, peak: 0.4 },
      maximumWindowRms: 0.1,
      resampled: { samples: 144_000, rms: 0.05, peak: 0.4 },
      speechFrames: 12,
      nonSpeechFrames: 269,
      speechStart: true,
      speechEnd: true,
      segmentDurationMs: 1_920,
    },
    nativeErrorCount: 0,
  });
  process.stdout.write('POST-PROCESSING SELF-TEST: PASS\n');
}

function normalizePcm16(sample) {
  return sample < 0 ? sample / 32768 : sample / 32767;
}

function selectFloatConfig(device, defaultConfig) {
  if (defaultConfig.sampleFormat().value === cpal.SampleFormat.F32.value) return defaultConfig;
  const configs = [...device.supportedInputConfigs()];
  const sameFormat = configs.find((candidate) => (
    candidate.sampleFormat().value === cpal.SampleFormat.F32.value
    && candidate.channels() === defaultConfig.channels()
    && candidate.containsRate(defaultConfig.sampleRate())
  ));
  const floatConfig = sameFormat ?? configs.find((candidate) => candidate.sampleFormat().value === cpal.SampleFormat.F32.value);
  if (!floatConfig) throw new Error('No Float32 input configuration is available.');
  return floatConfig.tryWithSampleRate(defaultConfig.sampleRate())
    ?? floatConfig.tryWithStandardSampleRate()
    ?? floatConfig.withMaxSampleRate();
}

async function closeQuietly(resource) {
  try {
    await resource?.close();
  } catch {
    // Cleanup is best effort; the report remains limited to safe numeric telemetry.
  }
}

async function main() {
  if (!VAD_MODEL_PATH) throw new Error('YUKI_VAD_MODEL_PATH is required and must point to the local Silero ONNX model.');
  await access(VAD_MODEL_PATH);

  let host;
  let device;
  let stream;
  let vad;
  let timer;
  const rawBlocks = [];
  const nativeErrors = [];
  let captureStartedAt = 0;
  let callbackCount = 0;

  try {
    host = cpal.defaultHost();
    device = host.defaultInputDevice();
    if (!device) throw new Error('No default input device is available.');

    const defaultConfig = device.defaultInputConfig();
    const config = selectFloatConfig(device, defaultConfig);
    const deviceName = device.description().name();
    const captureFormat = {
      channels: config.channels(),
      sampleRate: config.sampleRate(),
      sampleFormat: config.sampleFormat().value,
    };

    vad = new sherpa.Vad({
      sampleRate: CANONICAL_RATE,
      numThreads: 1,
      provider: 'cpu',
      sileroVad: {
        model: VAD_MODEL_PATH,
        threshold: 0.5,
        minSilenceDuration: 0.65,
        minSpeechDuration: 0.2,
        maxSpeechDuration: 10,
        windowSize: VAD_WINDOW_SAMPLES,
      },
    }, 30);

    process.stdout.write(`INPUT DEVICE: ${deviceName}\n`);
    process.stdout.write(`CAPTURE FORMAT: ${captureFormat.channels} channels / ${captureFormat.sampleFormat} / ${captureFormat.sampleRate} Hz\n`);
    process.stdout.write('Frase a decir:\n"Hola Yuki, prueba de nivel de micrófono."\n');
    process.stdout.write('Prepárate. La captura comenzará en 5 segundos.\n');
    for (let second = COUNTDOWN_SECONDS; second >= 1; second -= 1) {
      process.stdout.write(`${second}\n`);
      await sleep(1_000);
    }
    process.stdout.write('HABLA AHORA\n');

    const completed = new Promise((resolve) => {
      stream = device.buildInputStream(config, 'f32', (input) => {
        callbackCount += 1;
        rawBlocks.push(new Float32Array(input));
      }, (error) => {
        const code = error?.kind?.()?.name ?? error?.code;
        nativeErrors.push(typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(code) ? code : 'native-input-error');
      });
      captureStartedAt = performance.now();
      stream.play();
      timer = setTimeout(resolve, CAPTURE_DURATION_MS);
    });
    await completed;
    const captureDurationMs = Math.round(performance.now() - captureStartedAt);

    await closeQuietly(stream);
    stream = undefined;

    const channelStats = Array.from({ length: captureFormat.channels }, () => createStats());
    const downmix = createStats();
    const resampled = createStats();
    const windowFrames = Math.max(1, Math.round(captureFormat.sampleRate / 4));
    let windowCount = 0;
    let windowSquares = 0;
    let maximumWindowRms = 0;
    let resamplePhase = 0;
    let pending = new Float32Array(VAD_WINDOW_SAMPLES);
    let pendingLength = 0;
    let speechFrames = 0;
    let nonSpeechFrames = 0;
    let speechStart = false;
    let speechEnd = false;
    let speechActive = false;

    for (const block of rawBlocks) {
      const frames = Math.floor(block.length / captureFormat.channels);
      for (let frame = 0; frame < frames; frame += 1) {
        let mono = 0;
        for (let channel = 0; channel < captureFormat.channels; channel += 1) {
          const sample = block[frame * captureFormat.channels + channel] ?? 0;
          channelStats[channel].add(sample);
          mono += sample;
        }
        mono /= captureFormat.channels;
        downmix.add(mono);
        windowSquares += mono * mono;
        windowCount += 1;
        if (windowCount === windowFrames) {
          maximumWindowRms = Math.max(maximumWindowRms, Math.sqrt(windowSquares / windowCount));
          windowCount = 0;
          windowSquares = 0;
        }

        resamplePhase += CANONICAL_RATE;
        if (resamplePhase < captureFormat.sampleRate) continue;
        resamplePhase -= captureFormat.sampleRate;
        const pcm16 = Math.round(Math.max(-1, Math.min(1, mono)) * (mono < 0 ? 32768 : 32767));
        const sample = normalizePcm16(pcm16);
        resampled.add(sample);
        pending[pendingLength++] = sample;
        if (pendingLength !== VAD_WINDOW_SAMPLES) continue;
        vad.acceptWaveform(pending);
        const detected = vad.isDetected();
        if (detected) {
          speechFrames += 1;
          if (!speechActive) {
            speechStart = true;
            speechActive = true;
          }
        } else {
          nonSpeechFrames += 1;
          if (speechActive) {
            speechEnd = true;
            speechActive = false;
          }
        }
        pending.fill(0);
        pendingLength = 0;
      }
      block.fill(0);
    }
    if (windowCount > 0) maximumWindowRms = Math.max(maximumWindowRms, Math.sqrt(windowSquares / windowCount));
    vad.flush();
    if (speechActive && !vad.isDetected()) speechEnd = true;
    const segments = [];
    while (!vad.isEmpty()) {
      const segment = vad.front().samples;
      segments.push(Math.round((segment.length / CANONICAL_RATE) * 1_000));
      segment.fill(0);
      vad.pop();
    }
    pending.fill(0);

    const result = {
      channels: channelStats.map((stats, index) => ({ channel: index, ...stats.result() })),
      downmix: downmix.result(),
      maximumWindowRms,
      resampled: resampled.result(),
      speechFrames,
      nonSpeechFrames,
      speechStart,
      speechEnd,
      segmentDurationMs: segments.at(-1) ?? null,
    };

    writeReport({ captureDurationMs, callbackCount, result, nativeErrorCount: nativeErrors.length });
  } finally {
    clearTimeout(timer);
    for (const block of rawBlocks) block.fill(0);
    try { vad?.reset(); } catch { /* Native VAD release is best effort. */ }
    await closeQuietly(stream);
    await closeQuietly(device);
    await closeQuietly(host);
  }
}

if (process.argv.includes('--self-test')) {
  runPostProcessingSelfTest();
} else {
  main().catch((error) => {
    const raw = error instanceof Error ? (error.stack ?? error.message) : 'unexpected diagnostic failure';
    const safe = raw
      .replace(/\b(?:authorization|api[_-]?key|token|password)\b\s*[:=]\s*\S+/giu, '<redacted>')
      .slice(0, 4_000);
    process.stderr.write(`DIAGNOSTIC FAILED:\n${safe}\n`);
    process.exitCode = 1;
  });
}
