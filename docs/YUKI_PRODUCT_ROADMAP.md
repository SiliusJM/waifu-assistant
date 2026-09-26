# Yuki Product Roadmap

This file preserves product requirements and sequencing decisions that must survive chat/session changes. It is a planning source, not permission to implement everything at once.

## Current verified baseline

- Conversation core, memory, sessions, tools, clarification/repair/follow-up and local preferences are established.
- Voice foundation exists with coordinated streaming, cancellation and stale-output protection.
- Windows push-to-talk microphone capture works with local Sherpa ONNX Whisper STT.
- Local TTS and Windows playback work through the current SYSTEM/default output.
- Real microphone, STT, device reopen and audible TTS playback have been accepted on hardware.
- Phase 8 Internet work remains intentionally deferred, not abandoned.

## Near-term voice goals

### Natural duplex conversation

Move beyond explicit `/listen` and `/listen-stop` toward natural speech turns.

Status: **implemented as opt-in V1; acoustic acceptance not yet performed**. `/duplex` uses the existing local VAD/STT and voice orchestrator; `/duplex-stop` returns to the existing push-to-talk path. A bounded pause grace aggregates short pauses, finalized STT segments are awaited before capture closes, and microphone capture rotates before the local STT window limit. Confirmed speech can interrupt TTS/playback through the existing latest-input-wins path. The mode is disabled by default. There is no acoustic echo cancellation; self-voice/noise protection depends on existing VAD source classification, and false barge-in/noise robustness remain unverified on hardware.

Required behavior:
- detect start/end of user speech without requiring Enter for normal conversation;
- preserve explicit push-to-talk as a fallback;
- keep one effective interaction at a time;
- support barge-in: if the user starts speaking while Yuki is speaking, stop stale playback/TTS and listen;
- preserve the interrupted response/context so Yuki can continue when appropriate;
- support conversational repair such as:
  - user interrupts, pauses, then continues;
  - Yuki may say a short cue such as “continúa” or “te escucho” when the user yields ambiguously;
  - if the user says “continúa”, “sigue”, “¿qué decías?” or equivalent, resume the prior interrupted answer/topic instead of starting unrelated context;
- avoid talking over the user;
- avoid repeated acknowledgement/filler that makes latency feel worse;
- states remain suitable for future avatar: idle/listening/thinking/speaking.

### Latency

Target low perceived latency:
- fast end-of-speech detection;
- first acknowledgement may be local when a tool/API will take noticeable time;
- stream text into TTS in sensible phrase-sized chunks;
- do not wait for a complete long answer before starting speech;
- measure STT latency, time-to-first-text and time-to-first-audio later under gaming/OBS load.

### Noise robustness

Real environments may include dogs, TV, music, neighbors and game/stream audio.

Requirements:
- distinguish speech from background noise as reasonably as possible;
- VAD/noise gating should avoid sending obvious non-speech to STT;
- do not claim noise immunity; validate with real noisy-room tests;
- prevent Yuki's own playback from being mistaken for user speech where feasible (echo/duplex handling);
- retain manual push-to-talk fallback for difficult environments;
- consider optional local noise suppression only if resource cost and Windows stability are acceptable.

## Multilingual and code-switching input

Status: **V1 implemented and acoustically validated with known limitations** using local Whisper Tiny in `AUTO` mode. Real Spanish passed; the Spanish/romaji title utterance passed; spoken Japanese was partial; Spanish with embedded English failed to preserve “Spring Boot” reliably. This is not perfect multilingual support, and an STT model upgrade is not required now. STT audio remains local, with no raw-audio persistence. The requirements below remain product goals and constraints for future improvements.

The user may mix Spanish, English and Japanese in one utterance, including anime/music titles, programming terms, football names and product names.

Examples:
- “Abre Spotify y pon el opening de Domestic na Kanojo.”
- “Pon Ai yori tashikana mono nante nai.”
- “Pon 愛よりたしかなものなんてない.”
- mixed Spanish + English technical phrases.

Requirements:
- do not treat this as simple full-sentence translation;
- preserve titles, names, code identifiers and technical terms;
- support code-switching/multilingual STT or an equivalent robust strategy;
- Japanese may arrive as native script or romaji;
- normal Yuki reply language for this user is Spanish;
- original-language titles/names/quoted phrases may remain in their original language;
- avoid translating entity names into incorrect equivalents.

## Audio device policy

Input and output devices are independent.

Default output mode:
- SYSTEM/default: dynamically follow the current Windows default output.

Future explicit output preference:
- allow SYSTEM/default or a specific device;
- persist only the local device preference/identifier needed to restore the choice;
- never hardcode a current monitor/speaker name;
- if an explicitly selected device disappears, safely fall back to SYSTEM/default and notify briefly;
- a newly detected device must not silently replace an explicit user preference;
- future GUI/voice command may change the preferred output.

The same principles should apply to microphone selection.

## Scheduled and deferred actions

Yuki should support explicit, safe local scheduling such as:
- “apaga la PC en 16 minutos”;
- cancel a scheduled shutdown;
- reminders at a date/time;
- “cuando vuelva a hablar contigo, recuérdame X” / next-conversation reminders.

Requirements:
- use typed/allowlisted actions rather than arbitrary shell commands;
- destructive/system actions may require concise confirmation;
- scheduled actions must be cancellable and visible;
- do not let voice bypass tool authorization or confirmation rules.

## Modes and local workflows

Example:
- “entremos en modo trabajo”.

A mode may launch an allowlisted profile such as VS Code, Spotify and an authorized project.

Requirements:
- declarative profiles;
- no LLM-invented arbitrary shell commands;
- clear user control over what each mode launches;
- local configuration should not upload personal paths/settings by default.

## External integrations

Planned controlled integrations include:
- Google Calendar / Google Tasks for “¿qué actividades tengo hoy?”;
- osu! current profile/rank data via appropriate official/current data source;
- Spotify/YouTube/browser actions such as playing requested music;
- later stream/chat integrations for harmless interactions such as greetings.

Use the narrowest supported API/integration, explicit permissions and minimal data access.

## Internet / Phase 8

Phase 8 is deferred while voice/avatar/product interaction is built, but must be completed later using its dedicated security/testing work.

Do not silently reopen or redesign Phase 8 from unrelated milestones.

## Streaming / audience interaction

Example:
- “Yuki, el usuario Juan quiere que le mandes saludos.”

Basic spoken greetings require only conversation + TTS.
Future stream/chat ingestion should be separately permissioned and bounded.

## Gaming / OBS performance

Yuki is intended to run while games and OBS may be active.

Requirements:
- prefer lightweight local STT/TTS;
- avoid running a large local LLM by default while gaming;
- profile CPU, RAM, GPU (when applicable), STT latency, first-token latency and first-audio latency;
- later validate with OBS + a real game;
- avoid noticeable FPS degradation;
- disable or reduce expensive optional processing if needed.

## Avatar direction

After natural voice is stable:
- states: idle, listening, thinking, speaking;
- basic expressions;
- blink/idle behavior;
- mouth movement/lip sync;
- integrate without coupling avatar state to Session persistence.

## Durable workflow rules

- Before each large milestone, audit what already exists and implement only the missing delta.
- Small Codex NEXT_STEP recommendations are implemented only when they are genuinely useful, bounded and do not derail the roadmap.
- Do not re-run closed milestones without evidence.
- GPT-6 Luna High is the default implementation model; escalate to GPT-5.6 Terra Medium for difficult native/architectural diagnosis.
- For human-required acceptance, surface the action prominently before anything else.
- Real hardware acceptance must never be reported from mocks.
- Keep provider credentials, local personal configuration and large model files out of Git.


## Provider / model priority and automatic fallback

Yuki should support a locally configurable preferred provider/model with an ordered fallback list instead of depending permanently on one provider.

Requirements:
- preserve current provider compatibility, streaming, cancellation and latest-input-wins behavior;
- allow changing the preferred provider/model without redesigning Yuki;
- fall back only on explicitly classified recoverable failures such as availability, timeout, quota/rate-limit, lost authorization or missing configuration;
- do not hide programming errors, invalid payloads, security failures or serious configuration errors by silently changing provider;
- avoid running multiple providers concurrently for the same turn unless a future design explicitly justifies it;
- record safely which provider/model actually served a turn without exposing credentials;
- notify the user briefly when a meaningful provider switch occurs, without noisy per-turn messages;
- support cooldown/backoff and later return to the preferred provider without oscillation;
- allow a basic/free fallback when configured;
- keep API keys and personal provider configuration out of Git.

### Rate-limit-aware routing

Routing must treat provider/model quotas as dynamic health signals rather than fixed guarantees:

- Track provider/model usage locally when practical, including RPM, RPD, TPM, TPD and equivalent quotas; local counters are estimates, not authoritative remaining-quota values.
- Consume provider rate-limit metadata and `Retry-After` when exposed. Provider responses and headers (especially HTTP 429) are authoritative; never invent an exact remaining quota when it is not provided.
- Distinguish health states equivalent to `HEALTHY`, `NEAR_LIMIT`, `RATE_LIMITED` and `COOLDOWN`.
- When an authorized healthy fallback exists, avoid deliberately exhausting a known short limit. A model-level limit must not automatically disable every model from that provider.
- Permit configured model-level fallback before provider-level fallback. Treat OmniRoute as one routed provider when its internal combo manages model priority; use provider-level fallback only when the OmniRoute route itself fails or is rate-limited.
- Apply bounded cooldown/backoff, hysteresis to prevent rapid oscillation, and return to the preferred provider when it is healthy again.
- Never switch automatically to a paid option. Free-only remains the default; any future `allow-paid` behavior requires explicit configuration/authorization.

### Provider latency and quality benchmark — pending completion

The current benchmark is incomplete because Groq and Gemini encountered consecutive HTTP 429 responses despite pacing and cooldown. This is a temporary operational pause of approximately two days, **not** a verified provider quota-reset interval.

Accumulated progress must be preserved and resumed rather than restarted:

- OmniRoute: 30/30 evaluations complete; closed for this benchmark. Do not spend additional OmniRoute calls.
- Groq: 22/30 valid evaluations; up to 8 remain.
- Gemini: 16/30 valid evaluations; up to 14 remain.
- Groq and Gemini each encountered two consecutive HTTP 429 responses. The limiting quota dimension is unknown; do not infer RPM, TPM, RPD, TPD or a reset time without authoritative evidence.

Before resuming, inspect any already-captured retry headers, provider-console usage, free-tier documentation and other authoritative quota metadata available to the existing accounts. Record the applicable limit dimension (RPM, TPM, RPD, TPD, another documented limit, or `UNKNOWN`) and any explicitly stated reset interval. Do not change accounts, keys, models or tiers to evade limits. Do not enable billing, purchase access or use paid models.

When permitted by the providers' observed limits, continue only the remaining Groq/Gemini scenarios with the same benchmark scenarios, model selections and provider configuration so results remain comparable. Complete the pending multi-turn checks for those providers and Gemini cancellation only if quota allows. Consolidate the existing and new samples; do not discard prior results. Only after the accumulated evidence is sufficient should the Provider / Model Priority and Automatic Fallback capability move from design/evidence toward implementation. This benchmark does not itself authorize routing/fallback implementation.

On resumption, read this roadmap and the existing benchmark artifacts first, preserve completed work, and continue from the remaining counts above. Do not rerun closed OmniRoute evaluations or restart any provider's benchmark from zero.

## Crash recovery / pending action journal

Yuki should survive crashes, power loss, terminal closure and Windows restart without losing the state of actions that were waiting for confirmation or were in progress.

Requirements:
- keep a local, versioned and bounded action journal outside Git;
- a restart must never convert an unconfirmed action into an authorized one;
- on startup, surface recoverable pending actions briefly and allow inspect, confirm, discard or defer;
- persist only the minimum data necessary to explain and recover the action, without unnecessary secrets;
- use atomic writes and handle missing/corrupt files, schema evolution, cleanup and expiration;
- distinguish states equivalent to prepared, awaiting confirmation, confirmed, executing, completed, cancelled/discarded and failed;
- use action/operation IDs plus idempotency or reconciliation where supported to reduce duplicate remote actions after a crash;
- never claim exactly-once delivery where an external service cannot guarantee it;
- an action that may have completed remotely but not locally must be reconciled before retrying when possible;
- completed actions must not reappear as pending forever.

These two capabilities should be implemented as separate bounded milestones rather than one large redesign.
