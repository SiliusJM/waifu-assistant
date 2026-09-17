import type { AssistantCore } from '../core/assistant-core.js';
import type {
  InteractionSource,
  InteractionSourceContext,
  RealtimeInteractionRequest,
} from './realtime-types.js';

export class AssistantCoreAdapter implements InteractionSource {
  constructor(private readonly core: AssistantCore) {}

  async *run(
    request: RealtimeInteractionRequest,
    context: InteractionSourceContext,
  ) {
    const response = await this.core.respond(request.session, request.input, {
      signal: context.signal,
    });
    if (response.text) {
      yield { type: 'text_delta' as const, delta: response.text };
    }
    yield { type: 'completed' as const, response };
  }
}
