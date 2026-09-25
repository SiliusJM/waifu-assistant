import { randomUUID } from 'node:crypto';
import { EventBus } from '../realtime/event-bus.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { VoiceError } from './voice-errors.js';
import { VoiceSession } from './voice-session.js';
import { VoiceConcurrencyCoordinator, type VoiceResourceLease } from './voice-concurrency-coordinator.js';
import { StreamingVoiceOperation, type StageSignal } from './streaming-voice-operation.js';
import { CANONICAL_AUDIO_FORMAT } from './voice-types.js';
import type {
  AudioChunk,
  AudioFormat,
  TranscriptionResult,
  VoiceEventMap,
  VoiceProviderOptions,
  VoiceTerminationReason,
} from './voice-types.js';
import type {
  AudioInputStream,
  AudioPlaybackHandle,
  AudioStreamChunk,
  AudioStreamResult,
  StreamingAudioInputProvider,
  StreamingAudioOutputProvider,
  StreamingSTTProvider,
  StreamingSTTSession,
  StreamingSynthesisRequest,
  StreamingTTSOperation,
  StreamingTTSProvider,
  StreamingTranscriptionRequest,
  StreamingVoiceOperationHandle,
  StreamingVoiceOperationOptions,
  StreamingVoiceProviders,
  StreamingVoiceSynthesisHandle,
} from './streaming-types.js';

type StreamingOutcome<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly error: VoiceError };

function sameFormat(left: AudioFormat, right: AudioFormat): boolean {
  return left.encoding === right.encoding
    && left.sampleRateHz === right.sampleRateHz
    && left.channels === right.channels;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function providerError(stage: 'capture' | 'transcription' | 'synthesis' | 'playback', error: unknown): VoiceError {
  if (error instanceof VoiceError) return error;
  if (isAbortError(error)) return new VoiceError('The voice operation was cancelled.', 'VOICE_CANCELLATION_ERROR');
  const code = {
    capture: 'VOICE_CAPTURE_ERROR',
    transcription: 'VOICE_STT_ERROR',
    synthesis: 'VOICE_TTS_ERROR',
    playback: 'VOICE_OUTPUT_ERROR',
  }[stage] as 'VOICE_CAPTURE_ERROR' | 'VOICE_STT_ERROR' | 'VOICE_TTS_ERROR' | 'VOICE_OUTPUT_ERROR';
  return new VoiceError('The streaming voice provider failed during ' + stage + '.', code);
}

function validateTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new VoiceError('Streaming voice timeouts must be positive integers.', 'VOICE_CONFIGURATION_ERROR');
  }
}

function validateBufferParameter(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new VoiceError('Streaming buffer parameter ' + name + ' must be a positive number of milliseconds.', 'VOICE_CONFIGURATION_ERROR');
  }
}

function validateAudioChunk(chunk: AudioChunk): void {
  if (!(chunk.data instanceof Uint8Array)
    || !Number.isInteger(chunk.sequence)
    || chunk.sequence < 0
    || !sameFormat(chunk.format, CANONICAL_AUDIO_FORMAT)) {
    throw new VoiceError('Streaming input must use the canonical PCM format.', 'VOICE_AUDIO_FORMAT_ERROR');
  }
}

function validateStreamChunk(chunk: AudioStreamChunk, previousSequence: number): void {
  if (!(chunk.data instanceof Uint8Array)
    || !Number.isInteger(chunk.sequence)
    || chunk.sequence < 0
    || chunk.sequence <= previousSequence
    || !Number.isFinite(chunk.timestampMs)
    || chunk.timestampMs < 0
    || !Number.isFinite(chunk.durationMs)
    || chunk.durationMs <= 0) {
    throw new VoiceError('The streaming audio chunk is invalid.', 'VOICE_STREAMING_ERROR');
  }
}

function isCancellationReason(reason: VoiceTerminationReason | undefined): boolean {
  return reason !== undefined && reason !== 'completed' && reason !== 'failed' && reason !== 'timeout';
}

export class StreamingVoiceService {
  readonly events: EventBus<VoiceEventMap>;
  private readonly input: StreamingAudioInputProvider;
  private readonly stt: StreamingSTTProvider;
  private readonly tts: StreamingTTSProvider;
  private readonly output: StreamingAudioOutputProvider;
  private readonly coordinator: VoiceConcurrencyCoordinator;
  private readonly logger: Logger;
  private readonly streamCapacity: number;
  private readonly queueCapacity: number;
  private readonly deviceId: string;
  private readonly defaultTimeoutMs?: number;
  private readonly activeOperations = new Set<StreamingVoiceOperation<unknown>>();

  constructor(options: StreamingVoiceProviders & { readonly events?: EventBus<VoiceEventMap> }) {
    this.input = options.input;
    this.stt = options.stt;
    this.tts = options.tts;
    this.output = options.output;
    this.coordinator = options.coordinator ?? new VoiceConcurrencyCoordinator();
    this.logger = options.logger ?? createLogger();
    this.events = options.events ?? new EventBus<VoiceEventMap>();
    this.streamCapacity = options.streamCapacity ?? 64;
    this.queueCapacity = options.queueCapacity ?? 32;
    this.deviceId = 'default';
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    if (!Number.isInteger(this.streamCapacity) || this.streamCapacity < 1) {
      throw new VoiceError('Streaming event capacity must be positive.', 'VOICE_CONFIGURATION_ERROR');
    }
    if (!Number.isInteger(this.queueCapacity) || this.queueCapacity < 1) {
      throw new VoiceError('Streaming queue capacity must be positive.', 'VOICE_CONFIGURATION_ERROR');
    }
    validateBufferParameter('captureChunkDurationMs', options.captureChunkDurationMs);
    validateBufferParameter('playbackBufferMs', options.playbackBufferMs);
    validateBufferParameter('maxPendingMs', options.maxPendingMs);
    validateTimeout(options.defaultTimeoutMs);
  }

  startTranscription(
    request: StreamingTranscriptionRequest,
    options: StreamingVoiceOperationOptions = {},
  ): StreamingVoiceOperationHandle<TranscriptionResult> {
    this.validateSessionId(request.sessionId);
    const operation = this.createOperation<TranscriptionResult>(request.sessionId, options);
    void this.runTranscription(operation, request, options);
    return operation;
  }

  startSynthesis(
    request: StreamingSynthesisRequest,
    options: StreamingVoiceOperationOptions = {},
  ): StreamingVoiceSynthesisHandle {
    this.validateSessionId(request.sessionId);
    const operation = this.createOperation<AudioStreamResult>(request.sessionId, options);
    void this.runSynthesis(operation, request, options);
    if (request.text) void operation.pushText(request.text);
    if (options.autoEndInput ?? request.text !== undefined) operation.endInput();
    return operation as StreamingVoiceSynthesisHandle;
  }

  async shutdown(reason = 'The streaming voice service is shutting down.'): Promise<void> {
    this.logger.info('Streaming voice service shutdown requested', { reason });
    for (const operation of [...this.activeOperations]) operation.shutdown(reason);
  }

  private createOperation<T>(sessionId: string, options: StreamingVoiceOperationOptions): StreamingVoiceOperation<T> {
    const streamCapacity = options.streamCapacity ?? this.streamCapacity;
    const queueCapacity = options.queueCapacity ?? this.queueCapacity;
    if (!Number.isInteger(streamCapacity) || streamCapacity < 1 || !Number.isInteger(queueCapacity) || queueCapacity < 1) {
      throw new VoiceError('Streaming capacities must be positive integers.', 'VOICE_CONFIGURATION_ERROR');
    }
    const correlationId = options.correlationId ?? randomUUID();
    const session = new VoiceSession({
      sessionId,
      voiceSessionId: options.voiceSessionId,
      correlationId,
      mode: 'streaming',
    });
    const operation = new StreamingVoiceOperation<T>(
      randomUUID(),
      session.voiceSessionId,
      correlationId,
      session,
      streamCapacity,
      queueCapacity,
      this.events,
    );
    for (const timeoutMs of [
      options.timeoutMs,
      options.captureTimeoutMs,
      options.transcriptionTimeoutMs,
      options.synthesisTimeoutMs,
      options.playbackTimeoutMs,
    ]) validateTimeout(timeoutMs);
    validateBufferParameter('captureChunkDurationMs', options.captureChunkDurationMs);
    validateBufferParameter('playbackBufferMs', options.playbackBufferMs);
    validateBufferParameter('maxPendingMs', options.maxPendingMs);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const timeout = timeoutMs === undefined
      ? undefined
      : setTimeout(() => operation.timeout('operation'), timeoutMs);
    operation.addExternalCleanup(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    this.activeOperations.add(operation as unknown as StreamingVoiceOperation<unknown>);
    this.logger.info('Streaming voice operation created', {
      voiceSessionId: session.voiceSessionId,
      correlationId,
      sessionId,
      inputProvider: this.input.name,
      sttProvider: this.stt.name,
      ttsProvider: this.tts.name,
      outputProvider: this.output.name,
    });
    if (options.signal?.aborted) operation.abortCaller();
    else if (options.signal) {
      options.signal.addEventListener('abort', operation.abortCaller, { once: true });
      operation.addExternalCleanup(() => options.signal?.removeEventListener('abort', operation.abortCaller));
    }
    const onShutdown = (): void => { operation.shutdown(); };
    if (options.shutdownSignal?.aborted) operation.shutdown();
    else if (options.shutdownSignal) {
      options.shutdownSignal.addEventListener('abort', onShutdown, { once: true });
      operation.addExternalCleanup(() => options.shutdownSignal?.removeEventListener('abort', onShutdown));
    }
    return operation;
  }

  private async runTranscription(
    operation: StreamingVoiceOperation<TranscriptionResult>,
    request: StreamingTranscriptionRequest,
    options: StreamingVoiceOperationOptions,
  ): Promise<void> {
    let input: AudioInputStream | undefined;
    let stt: StreamingSTTSession | undefined;
    let captureStage: StageSignal | undefined;
    let sttStage: StageSignal | undefined;
    let sessionLease: VoiceResourceLease | undefined;
    let outcome!: StreamingOutcome<TranscriptionResult>;
    try {
      await operation.emit('voice_session_started', { state: 'created' }, true);
      sessionLease = await this.coordinator.acquireSession({
        operation,
        sessionId: request.sessionId,
        supersede: options.supersede,
        signal: operation.signal,
      });
      if (operation.isCancelling()) {
        outcome = { kind: 'cancelled' };
      } else {
        operation.transition('capturing');
        operation.voiceSession.setCaptureState('capturing');
        operation.mark('capture_start');
        captureStage = operation.createStageSignal();
        input = await this.input.startCapture(this.providerOptions(operation, captureStage.signal));
        if (!sameFormat(input.format, CANONICAL_AUDIO_FORMAT)) {
          throw new VoiceError('Streaming input must use the canonical PCM format.', 'VOICE_AUDIO_FORMAT_ERROR');
        }
        await operation.emit('audio_input_started', { format: input.format });
        sttStage = operation.createStageSignal();
        stt = await this.stt.start(request, this.providerOptions(operation, sttStage.signal));
        operation.transition('transcribing');
        operation.voiceSession.setTranscriptionState('running');
        await operation.emit('transcription_started', { provider: this.stt.name });
        const capture = this.runStage(operation, 'capture', options.captureTimeoutMs, () => this.pumpCapture(operation, input as AudioInputStream, stt as StreamingSTTSession));
        const transcript = this.runStage(operation, 'transcription', options.transcriptionTimeoutMs, () => this.consumeTranscription(operation, stt as StreamingSTTSession));
        const [, finalText] = await Promise.all([capture, transcript]);
        operation.voiceSession.setCaptureState('stopped');
        operation.voiceSession.setTranscriptionState('completed');
        await operation.emit('transcription_completed', { text: finalText });
        outcome = { kind: 'completed', value: { text: finalText } };
      }
    } catch (error) {
      outcome = this.outcomeForError(operation, 'transcription', error);
    } finally {
      await this.stopInput(operation, input);
      await this.stopStt(operation, stt);
      captureStage?.close();
      sttStage?.close();
      sessionLease?.release();
      operation.mark('resource_release');
      this.removeCallerListeners(operation);
    }
    await this.finish(operation, outcome);
  }

  private async runSynthesis(
    operation: StreamingVoiceOperation<AudioStreamResult>,
    request: StreamingSynthesisRequest,
    options: StreamingVoiceOperationOptions,
  ): Promise<void> {
    let tts: StreamingTTSOperation | undefined;
    let playback: AudioPlaybackHandle | undefined;
    let sessionLease: VoiceResourceLease | undefined;
    let playbackLease: VoiceResourceLease | undefined;
    let ttsStage: StageSignal | undefined;
    let playbackStage: StageSignal | undefined;
    let outcome: StreamingOutcome<AudioStreamResult> = { kind: 'cancelled' };
    try {
      await operation.emit('voice_session_started', { state: 'created' }, true);
      sessionLease = await this.coordinator.acquireSession({
        operation,
        sessionId: request.sessionId,
        supersede: options.supersede,
        signal: operation.signal,
      });
      if (operation.isCancelling()) {
        outcome = { kind: 'cancelled' };
      } else {
        operation.transition('synthesizing');
        operation.voiceSession.setSynthesisState('running');
        operation.mark('TTS_start');
        await operation.emit('synthesis_started', {
          provider: this.tts.name,
          textLength: request.text?.length ?? 0,
        });
        ttsStage = operation.createStageSignal();
        const ttsOperation = await this.tts.startSynthesis(request, this.providerOptions(operation, ttsStage.signal));
        tts = ttsOperation;
        const textPump = this.pumpText(operation, ttsOperation);
        const streamResult = this.runStage(operation, 'synthesis', options.synthesisTimeoutMs, () => this.consumeTts(
          operation,
          request,
          options,
          ttsOperation,
          async (chunk) => {
              try {
                await this.runStage(operation, 'playback', options.playbackTimeoutMs, async () => {
              if (!playbackLease) {
                playbackLease = await this.coordinator.acquirePlayback({
                  operation,
                  sessionId: request.sessionId,
                  deviceId: options.deviceId ?? this.deviceId,
                  supersede: options.supersede,
                  signal: operation.signal,
                });
                playbackStage = operation.createStageSignal();
                playback = await this.output.startPlayback({
                  ...this.providerOptions(operation, playbackStage.signal),
                  deviceId: options.deviceId ?? this.deviceId,
                });
                operation.transition('playing');
                operation.voiceSession.setPlaybackState('playing');
                operation.mark('playback_start');
                await operation.emit('playback_started', {
                  deviceId: options.deviceId ?? this.deviceId,
                  format: chunk.format,
                });
                await operation.emit('audio_output_started', {
                  format: chunk.format,
                  byteLength: chunk.data.byteLength,
                });
              }
              await playback?.enqueue(chunk);
                  await operation.emit('playback_progress', {
                    deviceId: options.deviceId ?? this.deviceId,
                    sequence: chunk.sequence,
                    playedBytes: chunk.data.byteLength,
                    bufferedBytes: 0,
                  });
                });
              } catch (error) {
                throw providerError('playback', error);
              }
          },
        ));
        const [, result] = await Promise.all([textPump, streamResult]);
        operation.voiceSession.setSynthesisState('completed');
        if (playback) {
          await playback.flush();
          await playback.completed();
          operation.voiceSession.setPlaybackState('completed');
          operation.mark('playback_end');
          await operation.emit('audio_output_stopped', { reason: 'completed' });
        }
        outcome = { kind: 'completed', value: result };
      }
    } catch (error) {
      outcome = this.outcomeForError(operation, 'synthesis', error);
    } finally {
      if (playback && outcome?.kind !== 'completed') {
        try {
          await playback.stop('immediate', operation.reasonCode ?? 'cancelled');
          if (operation.reasonCode === 'interrupted' || operation.reasonCode === 'superseded') {
            operation.mark('interruption_effective_playback_stop');
          }
        } catch (error) {
          this.logger.warn('Streaming playback cleanup failed', {
            voiceSessionId: operation.voiceSessionId,
            correlationId: operation.correlationId,
            errorCode: providerError('playback', error).code,
          });
        }
      }
      await this.closeTts(operation, tts);
      ttsStage?.close();
      playbackStage?.close();
      playbackLease?.release();
      sessionLease?.release();
      operation.mark('resource_release');
      this.removeCallerListeners(operation);
    }
    await this.finish(operation, outcome);
  }

  private async pumpCapture(
    operation: StreamingVoiceOperation<TranscriptionResult>,
    input: AudioInputStream,
    stt: StreamingSTTSession,
  ): Promise<void> {
    let previousSequence = -1;
    try {
      for await (const chunk of input.chunks()) {
        if (operation.signal.aborted) throw new VoiceError('The voice operation was cancelled.', 'VOICE_CANCELLATION_ERROR');
        validateAudioChunk(chunk);
        if (chunk.sequence <= previousSequence) throw new VoiceError('Audio chunk sequence is not monotonic.', 'VOICE_STREAMING_ERROR');
        previousSequence = chunk.sequence;
        if (previousSequence === 0) operation.mark('first_capture_chunk');
        await operation.emit('audio_chunk_received', {
          source: 'capture',
          sequence: chunk.sequence,
          byteLength: chunk.data.byteLength,
          format: chunk.format,
          timestampMs: performance.now(),
        });
        await stt.pushAudio({ ...chunk, data: new Uint8Array(chunk.data) });
      }
    } catch (error) {
      const lateNativeCaptureError = error instanceof VoiceError
        && error.code === 'VOICE_CAPTURE_ERROR'
        && !operation.signal.aborted
        && stt.canCompleteAfterCaptureError?.() === true;
      if (!lateNativeCaptureError) throw error;
      operation.mark('late_capture_error_after_finalized_segment');
    }
    await stt.endInput();
  }

  private async runStage<T, O>(
    operation: StreamingVoiceOperation<O>,
    stage: string,
    timeoutMs: number | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => operation.timeout(stage), timeoutMs);
    try {
      const result = await task();
      if (operation.timedOut && operation.timedOutStage === stage) {
        throw new VoiceError('The voice operation timed out during ' + stage + '.', 'VOICE_TIMEOUT_ERROR');
      }
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async consumeTranscription(
    operation: StreamingVoiceOperation<TranscriptionResult>,
    stt: StreamingSTTSession,
  ): Promise<string> {
    let finalText: string | undefined;
    for await (const event of stt.events()) {
      if (operation.signal.aborted) throw new VoiceError('The voice operation was cancelled.', 'VOICE_CANCELLATION_ERROR');
      if (event.type === 'speech_start') {
        await operation.emit('speech_activity_started', { source: 'confirmed-user-speech', segmentId: event.segmentId });
        continue;
      }
      if (event.type === 'possible_noise') {
        await operation.emit('speech_activity_started', { source: 'possible-noise' });
        continue;
      }
      if (event.type === 'speech_end') {
        await operation.emit('speech_activity_ended', { segmentId: event.segmentId });
        continue;
      }
      if (event.type === 'no_speech') {
        finalText ??= '';
        continue;
      }
      if (event.type !== 'partial' && event.type !== 'final') {
        throw new VoiceError('The STT provider returned an invalid event.', 'VOICE_STT_ERROR');
      }
      if (event.type === 'partial') {
        operation.mark('first_STT_partial');
        await operation.emit('transcription_partial', { text: event.text });
      } else {
        finalText = finalText ? `${finalText} ${event.text}` : event.text;
        operation.mark('STT_final');
        await operation.emit('transcription_final', {
          text: event.text,
          ...('segmentId' in event && event.segmentId ? { segmentId: event.segmentId } : {}),
        });
      }
    }
    if (finalText === undefined) throw new VoiceError('The STT provider did not return a final result.', 'VOICE_STT_ERROR');
    return finalText;
  }

  private async pumpText(operation: StreamingVoiceOperation<AudioStreamResult>, tts: StreamingTTSOperation): Promise<void> {
    for await (const text of operation.textInput) {
      if (operation.signal.aborted) throw new VoiceError('The voice operation was cancelled.', 'VOICE_CANCELLATION_ERROR');
      await tts.pushText(text);
    }
    await tts.endInput();
  }

  private async consumeTts(
    operation: StreamingVoiceOperation<AudioStreamResult>,
    _request: StreamingSynthesisRequest,
    _options: StreamingVoiceOperationOptions,
    tts: StreamingTTSOperation,
    enqueue: (chunk: AudioStreamChunk) => Promise<void>,
  ): Promise<AudioStreamResult> {
    let previousSequence = -1;
    let format: AudioFormat | undefined;
    let byteLength = 0;
    let chunkCount = 0;
    let durationMs = 0;
    for await (const chunk of tts.chunks()) {
      if (operation.signal.aborted) throw new VoiceError('The voice operation was cancelled.', 'VOICE_CANCELLATION_ERROR');
      validateStreamChunk(chunk, previousSequence);
      previousSequence = chunk.sequence;
      format ??= chunk.format;
      if (!sameFormat(format, chunk.format)) throw new VoiceError('TTS stream format changed unexpectedly.', 'VOICE_STREAMING_ERROR');
      if (chunkCount === 0) operation.mark('first_TTS_chunk');
      chunkCount += 1;
      byteLength += chunk.data.byteLength;
      durationMs += chunk.durationMs;
      await operation.emit('tts_chunk_ready', {
        sequence: chunk.sequence,
        byteLength: chunk.data.byteLength,
        format: chunk.format,
        timestampMs: chunk.timestampMs,
      });
      await enqueue(chunk);
    }
    const result = await tts.completed();
    if (!format || chunkCount === 0) throw new VoiceError('TTS produced no audio chunks.', 'VOICE_TTS_ERROR');
    return { ...result, format, chunkCount, byteLength, durationMs };
  }

  private outcomeForError<T>(
    operation: StreamingVoiceOperation<T>,
    stage: 'capture' | 'transcription' | 'synthesis' | 'playback',
    error: unknown,
  ): StreamingOutcome<T> {
    if (operation.reasonCode !== undefined && isCancellationReason(operation.reasonCode)) return { kind: 'cancelled' };
    if (operation.reasonCode === 'timeout') return {
      kind: 'failed',
      error: new VoiceError(operation.reason ?? 'The voice operation timed out.', 'VOICE_TIMEOUT_ERROR'),
    };
    return { kind: 'failed', error: providerError(stage, error) };
  }

  private async finish<T>(operation: StreamingVoiceOperation<T>, outcome: StreamingOutcome<T>): Promise<void> {
    if (outcome.kind === 'completed') await operation.finishCompleted(outcome.value);
    else if (outcome.kind === 'cancelled') await operation.finishCancelled();
    else await operation.finishFailed(outcome.error.code, outcome.error.message);
    operation.close();
  }

  private providerOptions<T>(operation: StreamingVoiceOperation<T>, signal = operation.signal): VoiceProviderOptions {
    return { signal, correlationId: operation.correlationId };
  }

  private async stopInput<T>(operation: StreamingVoiceOperation<T>, input: AudioInputStream | undefined): Promise<void> {
    if (!input) return;
    try {
      await input.stop(operation.reasonCode ?? 'completed');
      if (operation.reasonCode === 'interrupted' || operation.reasonCode === 'superseded') {
        operation.mark('interruption_effective_capture_stop');
      }
    } catch (error) {
      this.logger.warn('Streaming input cleanup failed', {
        voiceSessionId: operation.voiceSessionId,
        correlationId: operation.correlationId,
        errorCode: providerError('capture', error).code,
      });
    }
  }

  private async stopStt<T>(operation: StreamingVoiceOperation<T>, stt: StreamingSTTSession | undefined): Promise<void> {
    if (!stt) return;
    try {
      if (operation.reasonCode) await stt.cancel(operation.reasonCode);
      await stt.close();
    } catch (error) {
      this.logger.warn('Streaming STT cleanup failed', {
        voiceSessionId: operation.voiceSessionId,
        correlationId: operation.correlationId,
        errorCode: providerError('transcription', error).code,
      });
    }
  }

  private async closeTts<T>(operation: StreamingVoiceOperation<T>, tts: StreamingTTSOperation | undefined): Promise<void> {
    if (!tts) return;
    try {
      if (operation.reasonCode) await tts.cancel(operation.reasonCode);
      await tts.close();
    } catch (error) {
      this.logger.warn('Streaming TTS cleanup failed', {
        voiceSessionId: operation.voiceSessionId,
        correlationId: operation.correlationId,
        errorCode: providerError('synthesis', error).code,
      });
    }
  }

  private removeCallerListeners<T>(operation: StreamingVoiceOperation<T>): void {
    operation.cleanupExternal();
    this.activeOperations.delete(operation as unknown as StreamingVoiceOperation<unknown>);
  }

  private validateSessionId(sessionId: string): void {
    if (!sessionId.trim()) throw new VoiceError('A session ID is required for streaming voice.', 'VOICE_CONFIGURATION_ERROR');
  }
}
