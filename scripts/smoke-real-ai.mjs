import { DirectAIProvider } from '../dist/ai/direct-ai-provider.js';

const required = ['AI_PROVIDER', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error('Real AI smoke test requires: ' + missing.join(', '));
  process.exitCode = 1;
} else if (process.env.AI_PROVIDER !== 'direct') {
  console.error('Real AI smoke test requires AI_PROVIDER=direct.');
  process.exitCode = 1;
} else {
  const provider = new DirectAIProvider({
    baseURL: process.env.AI_BASE_URL.trim(),
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL.trim(),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 10000),
    retryPolicy: {
      maxAttempts: Number(process.env.AI_MAX_ATTEMPTS ?? 2),
      baseDelayMs: Number(process.env.AI_RETRY_BASE_DELAY_MS ?? 100),
      maxDelayMs: Number(process.env.AI_RETRY_MAX_DELAY_MS ?? 1000),
    },
  });
  try {
    const response = await provider.complete({
      sessionId: 'real-ai-smoke',
      messages: [{ role: 'user', content: 'Reply with a brief greeting.' }],
      model: process.env.AI_MODEL.trim(),
    });
    console.log(JSON.stringify({
      status: 'success',
      provider: response.provider,
      model: response.model,
      finishReason: response.finishReason,
      textLength: response.text.length,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown provider error.';
    console.error(JSON.stringify({ status: 'failure', message }));
    process.exitCode = 1;
  }
}
