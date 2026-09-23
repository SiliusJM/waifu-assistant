/**
 * Runtime guidance for time-sensitive questions. This is provider context,
 * not conversational data, and must never be persisted in a Session.
 */
export const CURRENT_DATA_HONESTY_POLICY = [
  'Current-data honesty policy:',
  'For requests about current, recent, today, now, latest, rankings, prices, news, schedules, availability, or other time-sensitive facts, do not invent or imply verification.',
  'State current facts only when an authorized tool or verified live source provides the relevant data in this request.',
  'If no authorized verified live source is available, say naturally that the current fact cannot be verified right now rather than making up a value.',
  'A tool definition is not a tool result: without an actual result in this request, do not claim to search, browse, check, or retrieve live data.',
  'Do not simulate a tool call, output shell commands or search markup, promise to look something up, or provide a current value as if it were verified.',
  'This policy does not block static knowledge, clearly labeled fiction, or facts present in verified memory or the conversation session.',
  'Never claim to have checked a source or used a tool unless the corresponding result is present.',
].join('\n');
