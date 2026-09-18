import type { VoiceLatencyMetrics } from './streaming-types.js';

export class VoiceLatencyTracker {
  private readonly values = new Map<string, number>();

  mark(name: string): void {
    this.values.set(name, performance.now());
  }

  snapshot(): VoiceLatencyMetrics {
    const marks = Object.fromEntries(this.values.entries());
    const durationsMs: Record<string, number> = {};
    const pairs: readonly [string, string, string][] = [
      ['capture_start', 'first_capture_chunk', 'capture_to_first_chunk'],
      ['capture_start', 'first_STT_partial', 'capture_to_first_partial'],
      ['capture_start', 'STT_final', 'capture_to_final'],
      ['TTS_start', 'first_TTS_chunk', 'tts_to_first_chunk'],
      ['TTS_start', 'playback_start', 'tts_to_playback'],
      ['playback_start', 'playback_end', 'playback_duration'],
      ['interruption_requested', 'interruption_effective_playback_stop', 'interruption_latency'],
      ['cancellation', 'resource_release', 'cancellation_latency'],
    ];
    for (const [from, to, name] of pairs) {
      const start = this.values.get(from);
      const end = this.values.get(to);
      if (start !== undefined && end !== undefined) durationsMs[name] = Math.max(0, end - start);
    }
    return { marks, durationsMs };
  }
}
