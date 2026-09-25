import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SILERO_VAD_MODEL } from '../../src/voice/local/silero-vad-model.js';
import { resolveSileroVadModelPath } from '../../src/voice/local/sherpa-silero-vad.js';

test('Silero VAD model setup pins the official Sherpa asset bytes and external runtime contract', () => {
  assert.equal(SILERO_VAD_MODEL.repository, 'k2-fsa/sherpa-onnx');
  assert.equal(SILERO_VAD_MODEL.release, 'asr-models');
  assert.equal(SILERO_VAD_MODEL.assetId, 271935959);
  assert.equal(SILERO_VAD_MODEL.name, 'silero_vad.onnx');
  assert.equal(SILERO_VAD_MODEL.bytes, 643_854);
  assert.match(SILERO_VAD_MODEL.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(SILERO_VAD_MODEL.bytes < SILERO_VAD_MODEL.maxBytes);
  assert.equal(
    resolveSileroVadModelPath(join(tmpdir(), SILERO_VAD_MODEL.name), join(tmpdir(), 'waifu-repo')),
    join(tmpdir(), SILERO_VAD_MODEL.name),
  );
});

test('Silero VAD official model metadata rejects unpinned asset substitutions', () => {
  assert.equal(SILERO_VAD_MODEL.url, 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx');
  assert.throws(
    () => resolveSileroVadModelPath('silero_vad.onnx', join(tmpdir(), 'waifu-repo')),
    /absolute external/u,
  );
  assert.throws(
    () => resolveSileroVadModelPath(join(tmpdir(), 'waifu-repo', SILERO_VAD_MODEL.name), join(tmpdir(), 'waifu-repo')),
    /outside the repository/u,
  );
});
