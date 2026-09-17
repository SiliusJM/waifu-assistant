import { randomUUID } from 'node:crypto';
import { EventBus } from '../realtime/event-bus.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { VoiceError, type VoiceErrorCode } from './voice-errors.js';
import { RuntimeVoiceOperation } from './voice-operation.js';
import { VoiceSession } from './voice-session.js';
import { CANONICAL_AUDIO_FORMAT } from './voice-types.js';
import type {
  AudioArtifact,
  AudioChunk,
  AudioFormat,
  AudioInputProvider,
  AudioOutputProvider,
  VoiceEventMap,
  VoiceOperationHandle,
  VoiceOperationOptions,
  VoiceProviderOptions,
  VoiceServiceOptions,
  VoiceStage,
  VoiceTranscriptionRequest,
  TranscriptionResult,
  SynthesisRequest,
  STTProvider,
  TTSProvider,
} from './voice-types.js';

type CanonicalAudioFormat = typeof CANONICAL_AUDIO_FORMAT;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function sameFormat(left: AudioFormat, right: AudioFormat): boolean {
  return left.encoding === right.encoding
    && left.sampleRateHz === right.sampleRateHz
    && left.channels === right.channels;
}

function safeError(stage: VoiceStage, error: unknown): VoiceError {
  if (error instanceof VoiceError) return error;
  if (isAbortError(error)) {
    return new VoiceError('The voice operation was cancelled.', 'VOICE_CANCELLATION_ERROR');
  }
  const codeByStage: Record<VoiceStage, VoiceErrorCode> = {
    capture: 'VOICE_CAPTURE_ERROR',
    transcription: 'VOICE_STT_ERROR',
    synthesis: 'VOICE_TTS_ERROR',
    playback: 'VOICE_OUTPUT_ERROR',
  };
  return new VoiceError('The voice operation failed during ' + stage + '.', codeByStage[stage]);
}

function timeoutError(stage: VoiceStage): VoiceError {
  return new VoiceError('The voice operation timed out during ' + stage + '.', 'VOICE_TIMEOUT_ERROR');
}

function validatePositiveTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new VoiceError('Voice timeouts must be positive integers.', 'VOICE_CONFIGURATION_ERROR');
  }
}

function validateAudioFormat(format: AudioFormat): void {
  if (!Number.isInteger(format.sampleRateHz) || format.sampleRateHz <= 0
    || !Number.isInteger(format.channels) || format.channels <= 0
    || !['pcm_s16le', 'wav', 'mp3', 'opus'].includes(format.encoding)) {
    throw new VoiceError('The audio format is invalid.', 'VOICE_AUDIO_FORMAT_ERROR');
  }
}

function validateCanonicalChunk(chunk: AudioChunk, canonical: CanonicalAudioFormat): void {
  if (!(chunk.data instanceof Uint8Array) || !Number.isInteger(chunk.sequence) || chunk.sequence < 0) {
    throw new VoiceError('The audio chunk is invalid.', 'VOICE_AUDIO_FORMAT_ERROR');
  }
  validateAudioFormat(chunk.format);
  if (!sameFormat(chunk.format, canonical)) {
    throw new VoiceError('Audio input must use the canonical PCM format.', 'VOICE_AUDIO_FORMAT_ERROR');
  }
}

function validateArtifact(audio: AudioArtifact): void {
  if (!(audio.data instanceof Uint8Array)) {
    throw new VoiceError('The synthesized audio artifact is invalid.', 'VOICE_AUDIO_FORMAT_ERROR');
  }
  validateAudioFormat(audio.format);
  if (audio.durationMs !== undefined && (!Number.isFinite(audio.durationMs) || audio.durationMs < 0)) {
    throw new VoiceError('The synthesized audio duration is invalid.', 'VOICE_AUDIO_FORMAT_ERROR');
  }
}

async function collectAudio(
  input: AsyncIterable<AudioChunk>,
  signal: AbortSignal,
  canonical: CanonicalAudioFormat,
): Promise<readonly AudioChunk[]> {
  const chunks: AudioChunk[] = [];
  for await (const chunk of input) {
    if (signal.aborted) throw new VoiceError('The voice operation was cancelled.', 'VOICE_CANCELLATION_ERROR');
    validateCanonicalChunk(chunk, canonical);
    chunks.push({
      ...chunk,
      data: new Uint8Array(chunk.data),
    });
  }
  return chunks;
}

async function* asAudioIterable(chunks: readonly AudioChunk[]): AsyncIterable<AudioChunk> {
  for (const chunk of chunks) yield chunk;
}

export class VoiceService {
  readonly events: EventBus<VoiceEventMap>;
  private readonly input: AudioInputProvider;
  private readonly stt: STTProvider;
  private readonly tts: TTSProvider;
  private readonly output: AudioOutputProvider;
  private readonly streamCapacity: number;
  private readonly defaultTimeoutMs?: number;
  private readonly timeouts: VoiceServiceOptions;
  private readonly logger: Logger;

  constructor(options: VoiceServiceOptions) {
    this.input = options.input;
    this.stt = options.stt;
    this.tts = options.tts;
    this.output = options.output;
    this.streamCapacity = options.streamCapacity ?? 64;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.timeouts = options;
    this.logger = options.logger ?? createLogger();
    this.events = new EventBus<VoiceEventMap>();
    if (!Number.isInteger(this.streamCapacity) || this.streamCapacity < 1) {
      throw new VoiceError('Voice stream capacity must be a positive integer.', 'VOICE_CONFIGURATION_ERROR');
    }
    validatePositiveTimeout(this.defaultTimeoutMs);
    validatePositiveTimeout(options.captureTimeoutMs);
    validatePositiveTimeout(options.transcriptionTimeoutMs);
    validatePositiveTimeout(options.synthesisTimeoutMs);
    validatePositiveTimeout(options.playbackTimeoutMs);
  }

  startTranscription(
    request: VoiceTranscriptionRequest,
    options: VoiceOperationOptions = {},
  ): VoiceOperationHandle<TranscriptionResult> {
    this.validateSessionId(request.sessionId);
    const operation = this.createOperation<TranscriptionResult>(request.sessionId, options);
    void this.runTranscription(operation, options);
    return operation;
  }

  startSynthesis(
    request: SynthesisRequest,
    options: VoiceOperationOptions = {},
  ): VoiceOperationHandle<AudioArtifact> {
    this.validateSessionId(request.sessionId);
    if (!request.text.trim()) {
      throw new VoiceError('Synthesis text cannot be empty.', 'VOICE_CONFIGURATION_ERROR');
    }
    const operation = this.createOperation<AudioArtifact>(request.sessionId, options);
    void this.runSynthesis(operation, request, options);
    return operation;
  }

  private validateSessionId(sessionId: string): void {
    if (!sessionId.trim()) {
      throw new VoiceError('A session ID is required for transcription.', 'VOICE_CONFIGURATION_ERROR');
    }
  }

  private createOperation<T>(sessionId: string, options: VoiceOperationOptions): RuntimeVoiceOperation<T> {
    validatePositiveTimeout(options.timeoutMs);
    validatePositiveTimeout(options.captureTimeoutMs);
    validatePositiveTimeout(options.transcriptionTimeoutMs);
    validatePositiveTimeout(options.synthesisTimeoutMs);
    validatePositiveTimeout(options.playbackTimeoutMs);
    const correlationId = options.correlationId ?? randomUUID();
    const session = new VoiceSession({
      sessionId,
      voiceSessionId: options.voiceSessionId,
      correlationId,
    });
    const operation = new RuntimeVoiceOperation<T>(
      randomUUID(),
      session.voiceSessionId,
      correlationId,
      session,
      this.streamCapacity,
      this.events,
    );
    this.logger.info('Voice operation created', {
      voiceSessionId: session.voiceSessionId,
      correlationId,
      sessionId,
      inputProvider: this.input.name,
      sttProvider: this.stt.name,
      ttsProvider: this.tts.name,
      outputProvider: this.output.name,
    });
    if (options.signal?.aborted) operation.abortCaller();
    else options.signal?.addEventListener('abort', operation.abortCaller, { once: true });
    return operation;
  }

  private async runTranscription(
    operation: RuntimeVoiceOperation<TranscriptionResult>,
    options: VoiceOperationOptions,
  ): Promise<void> {
    const session = operation.voiceSession;
    let chunks: readonly AudioChunk[] | undefined;
    let finalText: string | undefined;
    try {
      await operation.emit('voice_session_started', { state: 'created' }, true);
      if (operation.isCancelling()) {
        await this.finishCancelled(operation);
        return;
      }
      await this.transition(operation, 'capturing');
      session.setCaptureState('capturing');
      await operation.emit('audio_input_started', { format: CANONICAL_AUDIO_FORMAT });
      try {
        const input = this.input.capture(this.providerOptions(operation));
        chunks = await this.runStage(operation, 'capture', this.timeoutFor('capture', options), () => (
          collectAudio(input, operation.signal, CANONICAL_AUDIO_FORMAT)
        ));
        session.setCaptureState('stopped');
      } finally {
        await this.input.stop();
      }
      await operation.emit('audio_input_stopped', {
        chunkCount: chunks.length,
        byteLength: chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0),
      });

      await this.transition(operation, 'transcribing');
      session.setTranscriptionState('running');
      await operation.emit('transcription_started', { provider: this.stt.name });
      const transcriptionEvents = this.stt.transcribe(
        asAudioIterable(chunks),
        this.providerOptions(operation),
      );
      finalText = await this.runStage(
        operation,
        'transcription',
        this.timeoutFor('transcription', options),
        () => this.consumeTranscription(operation, transcriptionEvents),
      );
      session.setTranscriptionState('completed');
      await operation.emit('transcription_completed', { text: finalText });
      await this.finishCompleted(operation, { text: finalText });
    } catch (error) {
      this.markStageFailure(operation, session, this.stageForOperation(operation, session));
      await this.finishError(operation, error);
    } finally {
      options.signal?.removeEventListener('abort', operation.abortCaller);
      operation.close();
    }
  }

  private async runSynthesis(
    operation: RuntimeVoiceOperation<AudioArtifact>,
    request: SynthesisRequest,
    options: VoiceOperationOptions,
  ): Promise<void> {
    const session = operation.voiceSession;
    try {
      await operation.emit('voice_session_started', { state: 'created' }, true);
      if (operation.isCancelling()) {
        await this.finishCancelled(operation);
        return;
      }
      await this.transition(operation, 'synthesizing');
      session.setSynthesisState('running');
      await operation.emit('synthesis_started', {
        provider: this.tts.name,
        textLength: request.text.length,
      });
      const audio = await this.runStage(
        operation,
        'synthesis',
        this.timeoutFor('synthesis', options),
        () => this.tts.synthesize(request, this.providerOptions(operation)),
      );
      validateArtifact(audio);
      session.setSynthesisState('completed');
      await operation.emit('synthesis_completed', {
        provider: this.tts.name,
        format: audio.format,
        byteLength: audio.data.byteLength,
        durationMs: audio.durationMs,
      });
      await this.transition(operation, 'playing');
      session.setPlaybackState('playing');
      await operation.emit('audio_output_started', {
        format: audio.format,
        byteLength: audio.data.byteLength,
      });
      await this.runStage(
        operation,
        'playback',
        this.timeoutFor('playback', options),
        () => this.output.play(audio, this.providerOptions(operation)),
      );
      session.setPlaybackState('completed');
      await operation.emit('audio_output_stopped', { reason: 'completed' });
      await this.finishCompleted(operation, audio);
    } catch (error) {
      this.markStageFailure(operation, session, this.stageForOperation(operation, session));
      await this.finishError(operation, error);
    } finally {
      try {
        await this.output.stop();
      } catch (error) {
        this.logger.warn('Voice output cleanup failed', {
          voiceSessionId: operation.voiceSessionId,
          correlationId: operation.correlationId,
          provider: this.output.name,
          errorCode: safeError('playback', error).code,
        });
      }
      options.signal?.removeEventListener('abort', operation.abortCaller);
      operation.close();
    }
  }

  private async consumeTranscription(
    operation: RuntimeVoiceOperation<TranscriptionResult>,
    events: AsyncIterable<{ readonly type: 'partial' | 'final'; readonly text: string }>,
  ): Promise<string> {
    let finalText: string | undefined;
    for await (const event of events) {
      if (operation.signal.aborted) throw new VoiceError('The voice operation was cancelled.', 'VOICE_CANCELLATION_ERROR');
      if (event.type !== 'partial' && event.type !== 'final') {
        throw new VoiceError('The STT provider returned an invalid event.', 'VOICE_STT_ERROR');
      }
      if (typeof event.text !== 'string') {
        throw new VoiceError('The STT provider returned invalid text.', 'VOICE_STT_ERROR');
      }
      if (event.type === 'partial') await operation.emit('transcription_partial', { text: event.text });
      else {
        finalText = event.text;
        break;
      }
    }
    if (finalText === undefined) {
      throw new VoiceError('The STT provider did not return a final transcription.', 'VOICE_STT_ERROR');
    }
    return finalText;
  }

  private async runStage<OperationResult, StageResult>(
    operation: RuntimeVoiceOperation<OperationResult>,
    stage: VoiceStage,
    timeoutMs: number | undefined,
    task: () => Promise<StageResult>,
  ): Promise<StageResult> {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => operation.timeout(stage), timeoutMs);
    try {
      const result = await task();
      if (operation.timedOut) throw timeoutError(stage);
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private timeoutFor(stage: VoiceStage, options: VoiceOperationOptions): number | undefined {
    const specific = {
      capture: options.captureTimeoutMs,
      transcription: options.transcriptionTimeoutMs,
      synthesis: options.synthesisTimeoutMs,
      playback: options.playbackTimeoutMs,
    }[stage];
    const configured = {
      capture: this.timeouts.captureTimeoutMs,
      transcription: this.timeouts.transcriptionTimeoutMs,
      synthesis: this.timeouts.synthesisTimeoutMs,
      playback: this.timeouts.playbackTimeoutMs,
    }[stage];
    return specific ?? options.timeoutMs ?? configured ?? this.defaultTimeoutMs;
  }

  private providerOptions<T>(operation: RuntimeVoiceOperation<T>): VoiceProviderOptions {
    return { signal: operation.signal, correlationId: operation.correlationId };
  }

  private async transition<T>(operation: RuntimeVoiceOperation<T>, to: 'capturing' | 'transcribing' | 'synthesizing' | 'playing'): Promise<void> {
    const from = operation.state;
    operation.transition(to);
    await operation.emit('voice_state_changed', { from, to });
  }

  private markStageFailure<T>(
    operation: RuntimeVoiceOperation<T>,
    session: VoiceSession,
    stage: VoiceStage,
  ): void {
    if (operation.isCancelling() && !operation.timedOut) {
      if (stage === 'capture') session.setCaptureState('cancelled');
      if (stage === 'transcription') session.setTranscriptionState('cancelled');
      if (stage === 'synthesis') session.setSynthesisState('cancelled');
      if (stage === 'playback') session.setPlaybackState('cancelled');
      return;
    }
    if (stage === 'capture') session.setCaptureState('failed');
    if (stage === 'transcription') session.setTranscriptionState('failed');
    if (stage === 'synthesis') session.setSynthesisState('failed');
    if (stage === 'playback') session.setPlaybackState('failed');
  }

  private stageForOperation<T>(operation: RuntimeVoiceOperation<T>, session = operation.voiceSession): VoiceStage {
    if (operation.timedOutStage !== undefined) return operation.timedOutStage;
    if (session.captureState === 'capturing') return 'capture';
    if (session.transcriptionState === 'running') return 'transcription';
    if (session.synthesisState === 'running') return 'synthesis';
    if (session.playbackState === 'playing') return 'playback';
    return operation.state === 'capturing'
      ? 'capture'
      : operation.state === 'transcribing'
        ? 'transcription'
        : operation.state === 'synthesizing'
          ? 'synthesis'
          : 'playback';
  }

  private async finishError<T>(operation: RuntimeVoiceOperation<T>, error: unknown): Promise<void> {
    if (operation.isTerminal()) return;
    if (operation.timedOut) {
      await this.finishFailed(operation, timeoutError(operation.timedOutStage ?? 'capture'));
      return;
    }
    if (operation.isCancelling() || isAbortError(error)) {
      await this.finishCancelled(operation);
      return;
    }
      await this.finishFailed(operation, safeError(this.stageForOperation(operation), error));
  }

  private async finishCompleted<T>(
    operation: RuntimeVoiceOperation<T>,
    value: T,
  ): Promise<void> {
    if (!operation.reserveTerminal({ status: 'completed', value })) {
      if (operation.timedOut) await this.finishFailed(operation, timeoutError(operation.timedOutStage ?? 'capture'));
      else if (operation.isCancelling()) await this.finishCancelled(operation);
      return;
    }
    try {
      await operation.emit('voice_completed', { state: 'completed' }, true);
    } finally {
      operation.finalizeTerminal();
    }
  }

  private async finishCancelled<T>(operation: RuntimeVoiceOperation<T>): Promise<void> {
    if (operation.isTerminal()) return;
    if (!operation.reserveTerminal({ status: 'cancelled', reason: operation.reason })) return;
    try {
      await operation.emit('voice_cancelled', { state: 'cancelled', reason: operation.reason }, true);
    } finally {
      operation.finalizeTerminal();
    }
  }

  private async finishFailed<T>(operation: RuntimeVoiceOperation<T>, error: VoiceError): Promise<void> {
    if (!operation.reserveTerminal({ status: 'failed', code: error.code, message: error.message })) return;
    try {
      await operation.emit('voice_failed', {
        state: 'failed',
        code: error.code,
        message: error.message,
      }, true);
    } finally {
      operation.finalizeTerminal();
    }
  }
}
