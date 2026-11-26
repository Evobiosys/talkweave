// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — Task 8's session-start-mode contract, shared between
// start_screen.svelte (which chooses the mode: which button was clicked)
// and app.svelte (which reads it in `handle_session_ready` to decide
// whether/which engine to start — see start_screen.svelte's header
// comment for the full gating rationale). A plain `.ts` module rather than
// declared inside either `.svelte` file so both can import the same type
// without one depending on the other's script block.

/**
 * `'demo'` — the "demo conversation" button: a forced ReplayEngine over
 * the fixture, no audio recording (a scripted demo has no real audio).
 * `'live'` — the "live session" button: Task 7's audio recording, plus
 * whichever engine Task 6's settings currently select.
 * `'resume'` — reopening any past session from the list: never starts a
 * fresh engine (see start_screen.svelte for why a stale demo session
 * makes this necessary), but does resume Task 7's recorder for a
 * genuinely interrupted live/mic session.
 */
export type SessionStartMode = 'demo' | 'live' | 'resume';
