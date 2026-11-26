// SPDX-License-Identifier: AGPL-3.0-or-later

// shared/engine.ts
//
// Isomorphic transcription-engine contract (Task 8). Two concrete engines
// implement it, both in app/src/lib/: replay_engine.ts (plays back
// fixtures/demo_conversation.ts on a scripted timeline) and mic_engine.ts
// (a v0.1 no-op placeholder for a future whisper-cpp streaming engine —
// task-8-brief.md is explicit that streaming whisper itself is v0.2 scope,
// not built here).
//
// Neither concrete engine touches Session/SessionStore directly: an engine
// only emits this module's plain event shape. app/src/lib/engine_bridge.ts
// is the one place that turns an event stream into store mutations
// (task-8-brief.md: "keep engine pure: it emits, app.svelte applies to
// store"), so shared/engine.ts itself has zero dependencies beyond the
// language, same as shared/model.ts.
//
// Speaker is redeclared here (identical to shared/model.ts's) rather than
// imported, so this module never has to know about the rest of the model —
// an engine's job is producing speech events, not sessions/flags/notes.

export type Speaker = 'L' | 'R';

/**
 * One transcription event. `tStart`/`tEnd` are seconds from *this engine's*
 * own timeline (for replay: the fixture's cumulative-duration timeline; for
 * a real streaming engine: seconds from that engine's own start) — not
 * necessarily the session's wall-clock elapsed time. See replay_engine.ts's
 * `now()` for how a caller reconciles the two.
 *
 * `speaker: Speaker | null` (widened from the original non-nullable
 * `Speaker` — live-transcription-visibility fix): mic_engine.ts's manual
 * turn tracker (mic_engine_core.ts) legitimately has no speaker to report
 * until the user's first ArrowLeft/ArrowRight, and speech spoken during
 * that window is real, transcribed text, not a not-yet-existing event —
 * `shared/model.ts`'s `Segment.speaker` was already `Speaker | null` for
 * exactly this reason (an unattributed segment is a normal, renderable
 * thing, see transcript_view.svelte's centered/dimmed treatment). Forcing
 * this event type to a non-nullable `Speaker` was the actual defect: it
 * made "there is no speaker yet" inexpressible at the one layer that knows
 * it, so mic_engine.ts had no honest choice but to silently drop every
 * event until a speaker existed — see that module's `handle_server_event`
 * (now fixed) and mic_engine_core.ts's header comment for the full story.
 * replay_engine.ts's fixture always supplies a real speaker, so this
 * change is a no-op for it in practice.
 */
export interface EngineEvent {
  speaker: Speaker | null;
  tStart: number;
  tEnd: number;
  text: string;
  final: boolean;
}

export type EngineEventName = 'partial' | 'segment';

/**
 * `'partial'` fires for interim, still-growing text (`final: false`).
 * `'segment'` fires exactly once per turn, when that turn's text is
 * complete (`final: true`). A caller only interested in finished text can
 * subscribe to `'segment'` alone; one interested in a live-growing
 * transcript subscribes to both.
 */
export interface TranscriptionEngine {
  start(): Promise<void>;
  stop(): void;
  on(ev: EngineEventName, cb: (event: EngineEvent) => void): void;
}
