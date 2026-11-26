<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

<script lang="ts">
  // talkweave — the live transcript. Renders `segments` in order: L text
  // left-aligned with a 25% right margin, R right-aligned with a 25% left
  // margin, unattributed (speaker: null) centered and dimmed. A dim-gray
  // 11px timestamp gutter sits at the left of every segment regardless of
  // alignment (per task-4-brief.md — not mirrored for R).
  //
  // Seek: task-4-brief.md leaves the wire format (bubbling CustomEvent vs.
  // callback prop) up to this task. Chosen: a callback prop, `onseek?: (t)
  // => void`, fired on a single click of a segment's timestamp gutter.
  // Reasons: type-safe (no `detail: any` on a DOM event), trivially wired
  // from app.svelte today, and Task 7 (the eventual consumer) just takes a
  // function reference rather than attaching a native event listener to a
  // Svelte component root. Documented here for Task 7.
  //
  // Auto-scroll: this component owns its own scroll region (`.scroll-area`,
  // bound via `scrollEl`) rather than relying on an ancestor's overflow —
  // app.svelte's `.center-column`/`.content-wrapper` were adjusted to be
  // non-scrolling flex containers so exactly one element in the tree
  // scrolls. Pinned-to-bottom state is tracked by `pinned` and recomputed
  // through the pure `should_pin` helper both on user scroll and after new
  // content changes the scroll height.
  //
  // Task 5 additions:
  //
  // Highlighting: for each segment, `highlighted_ranges` (transcript_
  // helpers.ts) computes the char ranges any `flags` targeting it cover;
  // a flagged segment gets a soft amber left border, and each word whose
  // own span overlaps a highlighted range gets amber-tinted text (no
  // background — task-5-brief.md: "keep it calm").
  //
  // Double-click claim flagging: `ondblclickflag` fires with the raw
  // geometry `{segmentId, charStart, charEnd}` only — this component does
  // not know about `by`/`t`/current-speaker/session-clock concerns (same
  // separation as `onseek`), so app.svelte fills those in (via keymap.ts's
  // `listener_for` and session_clock.ts) before calling
  // `store.add_flag`. See `handle_dblclick`'s comment for the selection-
  // vs-word resolution rule.
  //
  // Sidebar jump-to-segment contract (documented here for Task 7, the
  // audio bar's eventual consumer of the same idea): pass a fresh
  // `scrollRequest = {segmentId, nonce}` object — `nonce` must change on
  // every request (even re-clicking the same entry) since Svelte's
  // `$effect` only re-fires on a changed dependency, and `segmentId` alone
  // wouldn't change on a repeat click. The component smooth-scrolls the
  // matching `[data-segment-id]` element into view and flashes it (a
  // brief background pulse — distinct from the persistent, background-
  // free claim highlighting above) in jump-flash yellow `#ffd93d`
  // (global-constraints.md, amended Task 12 — amber stays reserved for
  // the persistent flag highlight; only this one-shot jump pulse is
  // yellow), fading over ~1.5s total.
  //
  // Highlight-to-fact-check prefill: an exported `resolve_selection()`
  // (not a prop/event — the component doesn't know when it should fire,
  // only how to answer once asked) reads `window.getSelection()` on
  // demand for app.svelte's `F` key handler, so a highlighted passage
  // wins over the latest-flag prefill when one exists at the moment `F`
  // is pressed. See `resolve_selection`'s own doc comment for the
  // "outside the transcript" containment rule and for the segment/
  // speaker resolution it now also does — the highlight-attribution fix
  // (ask-the-conversation handover, part 1) needed to know WHICH speaker
  // said the highlighted words, not just the raw text.

  import type { Flag, Pause, Segment, Speaker } from '../../../shared/model';
  import { segment_at } from './audio_helpers';
  import {
    alignment_for,
    format_ts,
    highlighted_ranges,
    selection_span,
    should_pin,
    speaker_for_segment,
    split_words,
    word_overlaps_ranges,
    word_span,
    type CharRange,
    type DblclickFlagSpan,
    type ScrollRequest
  } from './transcript_helpers';

  let {
    segments,
    flags = [],
    currentSpeaker = null,
    onseek,
    ondblclickflag,
    scrollRequest = null,
    currentPlaybackT = null,
    isLiveSession = false,
    liveStatusText = 'recording. flags, notes and audio are captured.',
    pauses = [],
    micSessionActive = false,
    micStatusText = ''
  }: {
    segments: Segment[];
    flags?: Flag[];
    currentSpeaker?: Speaker | null;
    onseek?: (t: number) => void;
    ondblclickflag?: (span: DblclickFlagSpan) => void;
    scrollRequest?: ScrollRequest | null;
    /** Task 7: current `<audio>` playback position in review mode (null
     *  in live mode / before any playback has started). The segment
     *  `segment_at` resolves for this gets a faint underline, and — only
     *  while the view is `pinned` — is scrolled into view. Deliberately a
     *  separate mechanism from `scrollRequest` above: that one is a
     *  one-shot "jump here and flash" request (sidebar click) that
     *  un-pins on purpose; this is a continuous "follow the currently
     *  playing segment while pinned" behavior that must NOT un-pin,
     *  or playback would only ever follow the first segment it lands on. */
    currentPlaybackT?: number | null;
    /** Task-1 (v0.3 train fixes, Part C): true only for a freshly-started
     *  real live/recording session (app.svelte's `isLiveSession`, mirrors
     *  `session_mode_plan`'s `startRecorder`) — false for demo/replay and
     *  review, which keep the plain "listening…" empty-state copy. */
    isLiveSession?: boolean;
    /** qwen-asr-engine handover, Task B: the empty-transcript status line
     *  shown while `isLiveSession` and no segments have arrived yet.
     *  Replaces v0.2's static, now-false "live transcription arrives in
     *  v0.2" claim. This component stays dumb about WHY the text reads
     *  whatever it reads (same separation as `onseek`/`ondblclickflag`
     *  above): app.svelte computes it from the server's ASR availability
     *  payload via `live_status_text` (whisper_status.ts), the one place
     *  that pure string-building logic is unit tested. The default here
     *  is only a defensive fallback for a caller that omits the prop
     *  entirely; app.svelte always supplies the real one. */
    liveStatusText?: string;
    /** v0.3 train-fixes Part B: rendered as a subtle centered divider
     *  interleaved among the segments by `tStart` (see `items` below) —
     *  "same visual family as summary dividers" per the plan, but
     *  positioned inline in the transcript flow rather than in the
     *  collapsed strip above it (summary_dividers.svelte), since a pause
     *  is a moment IN the transcript's own timeline, not a span
     *  summarizing several segments. */
    pauses?: Pause[];
    /** Live-transcription-visibility fix: true only while a REAL
     *  `MicEngine` is running this session (app.svelte's `plan.startMic`
     *  branch) — false for a live session with no engine at all (still
     *  `isLiveSession`, but `liveStatusText` above already explains why
     *  nothing will ever transcribe) and for demo/review. Gates which
     *  status line renders: `micStatusText` below when true, the older
     *  engine-availability `liveStatusText` when false — see the two
     *  props' own doc comments for what each actually answers. */
    micSessionActive?: boolean;
    /** app.svelte's `mic_status_text` (mic_status.ts) — the ALWAYS-
     *  honest, ALWAYS-visible (not gated behind `segments.length === 0`
     *  the way `liveStatusText` is) pipeline-activity status: waiting for
     *  audio, audio arriving with nothing transcribed yet, or
     *  transcribing (with a measured last-decode duration once known) —
     *  each only ever driven by a real signal mic_engine.ts measures, see
     *  that module's `mic_status_text` header comment for exactly which
     *  (and for why there is deliberately no separate "caught up" state).
     *  Rendered in a persistent strip (not inside the
     *  scrolling transcript, so it never scrolls out of view) for as long
     *  as `micSessionActive`. */
    micStatusText?: string;
  } = $props();

  type TranscriptItem =
    | { kind: 'segment'; t: number; seg: Segment }
    | { kind: 'pause'; t: number; pause: Pause };

  // Merged, chronological by t — segments sorted by tStart already hold
  // that invariant on their own (append-only live transcript), but a
  // pause's tStart can fall anywhere relative to them, so this re-sort is
  // what actually places the divider between the right two segments.
  const items: TranscriptItem[] = $derived(
    [
      ...segments.map((seg): TranscriptItem => ({ kind: 'segment', t: seg.tStart, seg })),
      ...pauses.map((pause): TranscriptItem => ({ kind: 'pause', t: pause.tStart, pause }))
    ].sort((a, b) => a.t - b.t)
  );

  /** "— pause 0:42 —" while open; "— pause 0:42 (0:28) —" once resumed —
   *  see shared/model.ts's `Pause` doc comment for why `tEnd - tStart` IS
   *  the real pause duration rather than another session-clock reading. */
  function pause_label(pause: Pause): string {
    const base = `pause ${format_ts(pause.tStart)}`;
    return pause.tEnd !== null ? `${base} (${format_ts(pause.tEnd - pause.tStart)})` : base;
  }

  const PIN_THRESHOLD_PX = 24;
  // Total jump-flash lifetime ~1.5s (task-12-brief.md): held at full
  // yellow for FLASH_MS, then the `.segment.flashing` background rule's
  // own transition (below, 400ms) carries the fade-out — 1100 + 400 =
  // 1500ms end to end.
  const FLASH_MS = 1100;

  let scrollEl: HTMLDivElement | undefined = $state();
  let pinned = $state(true);
  let flashingId: string | null = $state(null);
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  function handle_scroll(): void {
    if (!scrollEl) return;
    pinned = should_pin(
      { scrollTop: scrollEl.scrollTop, scrollHeight: scrollEl.scrollHeight, clientHeight: scrollEl.clientHeight },
      PIN_THRESHOLD_PX
    );
  }

  function scroll_to_bottom(): void {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    pinned = true;
  }

  // Auto-scroll when pinned and new content arrives. Depends on the last
  // segment's identity/text/tEnd/final (not just `segments.length`) so a
  // growing partial segment — same count, taller content — still keeps the
  // view pinned to its tail while it's being transcribed. Folded into a
  // single derived string (rather than reading the fields with bare `void`
  // statements inside the effect) so Svelte's dependency tracking reliably
  // registers all of them: `$derived` explicitly recomputes off exactly the
  // reads in its expression, whereas relying on an effect body to pick up
  // several individually-`void`-read fields as dependencies is easy to get
  // wrong silently.
  const tail = $derived(segments.length > 0 ? segments[segments.length - 1] : null);
  const tailKey = $derived(tail ? `${tail.id}|${tail.text}|${tail.tEnd}|${tail.final}` : '');
  $effect(() => {
    void tailKey;
    if (pinned) scroll_to_bottom();
  });

  function handle_seek(t: number): void {
    onseek?.(t);
  }

  // Task 7: playback-sync underline + follow-if-pinned. `$derived` (not a
  // plain read inside the effect below) so it only recomputes when
  // `currentPlaybackT`/`segments` actually change, and the scroll effect
  // below only re-fires when the *resolved segment* changes (crossing a
  // boundary), not on every `ontimeupdate` tick.
  const currentPlaybackSegmentId = $derived(
    currentPlaybackT === null || currentPlaybackT === undefined ? null : (segment_at(segments, currentPlaybackT)?.id ?? null)
  );

  $effect(() => {
    const segId = currentPlaybackSegmentId;
    if (!segId || !scrollEl || !pinned) return;
    const target = Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-segment-id]')).find(
      (el) => el.dataset.segmentId === segId
    );
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // Sidebar jump-to-segment — see header comment for the `scrollRequest`
  // contract. Reads `scrollRequest` directly so the effect re-runs
  // whenever app.svelte hands it a fresh object (new `nonce`).
  $effect(() => {
    const req = scrollRequest;
    if (!req || !scrollEl) return;
    const target = Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-segment-id]')).find(
      (el) => el.dataset.segmentId === req.segmentId
    );
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // A jump can land far from the tail; don't fight it by immediately
    // re-pinning and yanking the view back to the bottom on the next
    // content change. The "↓ live" chip lets the user return.
    pinned = false;
    flashingId = req.segmentId;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashingId = null;
    }, FLASH_MS);
  });

  /**
   * Resolves a dblclick on a segment's text into a claim span, per
   * task-5-brief.md ("double-click on a word (or a text selection within
   * one segment)"). Prefers a real, non-collapsed text selection (a
   * click-drag the user then double-clicked to confirm) that resolves
   * entirely within *this* segment's own word spans; falls back to the
   * single double-clicked word when there's no such selection (the
   * common case — most browsers select just the double-clicked word by
   * default, which is exactly the fallback path). Does nothing when
   * neither resolves cleanly (e.g. a selection spanning multiple
   * segments) rather than guessing.
   */
  function handle_dblclick(event: MouseEvent, seg: Segment): void {
    if (!ondblclickflag) return;

    const offset_in_segment = (node: Node, offset: number): number | null => {
      const el = node instanceof HTMLElement ? node : node.parentElement;
      const wordEl = el?.closest<HTMLElement>('[data-ci]');
      if (!wordEl) return null;
      const segEl = wordEl.closest<HTMLElement>('[data-segment-id]');
      if (!segEl || segEl.dataset.segmentId !== seg.id) return null;
      const ci = Number(wordEl.dataset.ci);
      if (!Number.isFinite(ci)) return null;
      return ci + offset;
    };

    let span: CharRange | null = null;

    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const start = offset_in_segment(range.startContainer, range.startOffset);
      const end = offset_in_segment(range.endContainer, range.endOffset);
      if (start !== null && end !== null) {
        span = selection_span(start, end, seg.text.length);
      }
    }

    if (!span) {
      const target = event.target;
      const wordEl = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-ci]') : null;
      if (wordEl) {
        const ci = Number(wordEl.dataset.ci);
        if (Number.isFinite(ci)) span = word_span(ci, wordEl.textContent ?? '');
      }
    }

    if (span) ondblclickflag({ segmentId: seg.id, ...span });
  }

  /**
   * Given a Range endpoint (`startContainer`/`endContainer`), walks up to
   * the nearest `[data-segment-id]` ancestor and returns its id, or
   * `null` when there is none (the endpoint sits outside any rendered
   * segment — e.g. the empty-transcript hint, a pause divider). Used
   * only to resolve `resolve_selection`'s selection into a segment id;
   * kept as a small DOM-walking helper here rather than in transcript_
   * helpers.ts because it genuinely needs a live `Node`, unlike that
   * module's other, DOM-free helpers.
   */
  function closest_segment_id(node: Node): string | null {
    const el = node instanceof HTMLElement ? node : node.parentElement;
    return el?.closest<HTMLElement>('[data-segment-id]')?.dataset.segmentId ?? null;
  }

  export interface ResolvedSelection {
    text: string;
    /** The single segment id the WHOLE selection resolves to, or `null`
     *  when the selection's start and end endpoints land in different
     *  segments (or in no segment at all) — see `resolve_selection`'s doc
     *  comment for why an ambiguous span is never guessed at. */
    segmentId: string | null;
    /** `speaker_for_segment(segmentId, segments)` — `null` whenever
     *  `segmentId` is null, OR when it resolves but that segment is
     *  itself unattributed (a real, legitimate transcript state per
     *  shared/model.ts's nullable `Segment.speaker`, engine_bridge.ts's
     *  in-place promotion of an open unattributed segment once a speaker
     *  is claimed). Callers must not assume a non-null `segmentId`
     *  implies a non-null `speaker`. */
    speaker: Speaker | null;
  }

  /**
   * Resolves the browser's CURRENT window selection into fact-check-
   * prefill text plus, when unambiguous, the segment/speaker it came
   * from — called on demand by app.svelte's `F` key handler, never
   * derived. A text selection isn't reactive session state the way
   * `store.session.flags` is: nothing fires when the user finishes a
   * drag-select, so `$derived` (which app.svelte's flag-based prefill
   * already uses) would never see it. Instead app.svelte calls this
   * function, via `bind:this`, at the exact instant `F` is pressed, and
   * falls back to the latest-flag prefill when it returns null.
   *
   * Returns null for: no selection at all, a collapsed selection (a
   * plain cursor, not a highlight), or a selection whose common ancestor
   * isn't inside this component's own `scrollEl` — the transcript's
   * scroll region. That last check is what keeps a highlight made in the
   * settings drawer, a fact-check card, or anywhere else on the page
   * from ever being mistaken for a transcript highlight (task brief
   * requirement: "ignore selections outside the transcript"); it's a
   * single `Node.contains` check on the Range's `commonAncestorContainer`
   * rather than separately checking both endpoints, since a Range's
   * common ancestor containing the whole range is exactly what
   * `Range.commonAncestorContainer` guarantees.
   *
   * `segmentId`/`speaker` (added for the ask-the-conversation handover's
   * attribution fix) are the CHEAP option that handover deliberately
   * chose over carrying a full segment id + char span on `FactCheck`
   * itself: resolving just the speaker at the moment of highlight needs
   * no change to `shared/model.ts`, and therefore none to either of its
   * independent markdown (de)serializers (`shared/session_md.ts` /
   * `server/lib/session_md_parse.mjs`, kept in sync only by
   * `tests/session_md_parse_contract.test.ts`'s field-by-field `toEqual`)
   * — see factcheck_helpers.ts's `attribution_for` for what actually
   * consumes this. A selection whose two endpoints resolve to two
   * DIFFERENT segments (or to no segment at all) resolves `segmentId:
   * null` rather than guessing which segment "counts" — same "don't
   * guess at an ambiguous span" discipline as `handle_dblclick` above.
   * Normalizing the raw text itself (trim, collapse whitespace, cap
   * length) stays `selection_helpers.ts`'s job, not this function's —
   * pure string math with no DOM concerns, worth its own tested module.
   */
  export function resolve_selection(): ResolvedSelection | null {
    if (!scrollEl) return null;
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    if (!scrollEl.contains(range.commonAncestorContainer)) return null;

    const startSegId = closest_segment_id(range.startContainer);
    const endSegId = closest_segment_id(range.endContainer);
    const segmentId = startSegId !== null && startSegId === endSegId ? startSegId : null;

    return { text: sel.toString(), segmentId, speaker: speaker_for_segment(segmentId, segments) };
  }
</script>

<div
  class="transcript-view"
  class:speaking-left={currentSpeaker === 'L'}
  class:speaking-right={currentSpeaker === 'R'}
>
  {#if micSessionActive}
    <!-- Live-transcription-visibility fix: persistent, always-visible
         (outside `.scroll-area`, so it never scrolls out of view) —
         see `micStatusText`'s doc comment above for why this is a
         separate line from `liveStatusText` and rendered regardless of
         `segments.length`, unlike the empty-hint below. -->
    <p class="mic-status-line">{micStatusText}</p>
  {/if}
  <div class="scroll-area" bind:this={scrollEl} onscroll={handle_scroll}>
    {#if segments.length === 0}
      {#if isLiveSession && !micSessionActive}
        <p class="empty-hint">{liveStatusText}</p>
      {:else if !isLiveSession}
        <p class="empty-hint">listening…</p>
      {/if}
    {/if}
    {#each items as item (item.kind === 'segment' ? item.seg.id : item.pause.id)}
      {#if item.kind === 'pause'}
        <div class="pause-divider">— {pause_label(item.pause)} —</div>
      {:else}
        {@const seg = item.seg}
        {@const ranges = highlighted_ranges(seg.id, flags, seg.text.length)}
        <div
          class="segment"
          class:flagged={ranges.length > 0}
          class:flashing={flashingId === seg.id}
          class:current-playback={currentPlaybackSegmentId === seg.id}
          data-segment-id={seg.id}
        >
          <button
            class="ts-gutter"
            type="button"
            aria-label={`seek to ${format_ts(seg.tStart)}`}
            onclick={() => handle_seek(seg.tStart)}
          >
            {format_ts(seg.tStart)}
          </button>
          <!-- svelte-ignore a11y_no_static_element_interactions -- dblclick
               here is a progressive-enhancement power-user gesture (claim
               flagging on the transcript body's plain text); it has no
               distinct interactive role of its own to assign (it's the
               segment's own text, not a control), and every flag it can
               create is equally reachable via the keyboard key map
               (Space/ShiftLeft/ShiftRight — keymap.ts), so there's no
               keyboard-accessibility gap being introduced. -->
          <div
            class="segment-body align-{alignment_for(seg.speaker)}"
            class:partial={!seg.final}
            ondblclick={(e) => handle_dblclick(e, seg)}
          >
            {#each split_words(seg.text) as w, i (w.ci)}
              {#if i > 0}{' '}{/if}<span
                data-ci={w.ci}
                class:flagged-word={word_overlaps_ranges(w.ci, w.ci + w.word.length, ranges)}>{w.word}</span
              >
            {/each}
          </div>
        </div>
        {#if seg.speaker === null && currentSpeaker === null}
          <!-- Live-transcription-visibility fix, "make attribution
               discoverable": a first-time user has no idea ArrowLeft/
               ArrowRight assigns the speaker (keymap.ts) — say so right
               where the unattributed (centered/dimmed) text appears, in
               that same muted visual language. Gated on
               `currentSpeaker === null` (not merely this one segment's
               own `speaker`) so the hint disappears everywhere the
               instant the user has claimed a speaker even once — it has
               done its job by then, and repeating it on every later
               unattributed segment (crosstalk, a pause before either
               side speaks again) would just be noise. -->
          <p class="attribution-hint">press &larr; or &rarr; to claim this speaker</p>
        {/if}
      {/if}
    {/each}
  </div>

  {#if !pinned}
    <button class="live-chip" type="button" onclick={scroll_to_bottom} aria-label="scroll to latest">
      &darr; live
    </button>
  {/if}
</div>

<style>
  .transcript-view {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    border-left: 2px solid transparent;
    border-right: 2px solid transparent;
    transition:
      border-left-color 160ms ease-out,
      border-right-color 160ms ease-out;
  }

  .transcript-view.speaking-left {
    border-left-color: #ffb84d;
  }

  .transcript-view.speaking-right {
    border-right-color: #ffb84d;
  }

  .scroll-area {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 4px 16px;
  }

  .empty-hint {
    margin: auto;
    color: #4a4a46;
    font-size: 13px;
  }

  /* Live-transcription-visibility fix: persistent pipeline-activity
     status — quiet by design (same dim-gray family as `.empty-hint`/
     `.pause-divider`, not an alert color), but ALWAYS present while a
     real mic session is running, unlike the top bar's chips (hidden by
     default, revealed only on hover/","). This is the one place the
     user is guaranteed to see it without doing anything extra. */
  .mic-status-line {
    flex: 0 0 auto;
    margin: 0;
    padding: 4px 16px;
    color: #6a6a66;
    font-size: 11px;
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
    border-bottom: 1px solid #232320;
  }

  /* "Make attribution discoverable": same muted, centered visual language
     as the unattributed segment it sits under (`.align-center` below),
     just smaller and quieter — a hint, not a warning. */
  .attribution-hint {
    margin: 2px 0 0;
    text-align: center;
    color: #6a6a66;
    font-size: 11px;
  }

  /* v0.3 train-fixes Part B: "same visual family as summary dividers"
     (summary_dividers.svelte's dim, small-caps-adjacent divider label) —
     here the "—" glyphs are literal text rather than CSS line elements,
     since this divider sits inline in the transcript flow rather than in
     a boxed strip of its own. */
  .pause-divider {
    text-align: center;
    color: #6a6a66;
    font-size: 11px;
    letter-spacing: 0.03em;
    font-variant-numeric: tabular-nums;
    padding: 2px 0;
  }

  .segment {
    display: flex;
    align-items: baseline;
    gap: 12px;
    border-left: 2px solid transparent;
    padding-left: 8px;
    margin-left: -10px;
    border-radius: 2px;
    transition:
      border-left-color 160ms ease-out,
      background 400ms ease-out;
  }

  /* Persistent claim highlight: soft amber left border only — the amber
     text tint lives on individual words (`.flagged-word` below), never a
     background block, per task-5-brief.md ("no background blocks; keep it
     calm"). */
  .segment.flagged {
    border-left-color: rgba(255, 184, 77, 0.55);
  }

  /* Transient "you jumped here" affordance (sidebar click) — a brief
     yellow background pulse (global-constraints.md's jump-flash color,
     #ffd93d), distinct from the persistent amber highlight above; fades
     out via the `background` transition once `.flashing` is removed
     (see `FLASH_MS` above for the full ~1.5s timing). */
  .segment.flashing {
    background: rgba(255, 217, 61, 0.16);
  }

  /* Task 7: the segment covering current playback position — faint
     off-white underline, deliberately not amber (that color is reserved
     for flag semantics per global-constraints.md; playback position is
     not a flag). */
  .segment.current-playback .segment-body {
    text-decoration: underline;
    text-decoration-color: rgba(232, 232, 228, 0.35);
    text-underline-offset: 4px;
  }

  .ts-gutter {
    flex: 0 0 auto;
    width: 36px;
    background: none;
    border: none;
    padding: 0;
    color: #5a5a56;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    text-align: left;
    cursor: pointer;
  }

  .ts-gutter:hover {
    color: #ffb84d;
  }

  .segment-body {
    flex: 1 1 auto;
    line-height: 1.7;
    font-size: 15px;
    color: #e8e8e4;
    word-wrap: break-word;
  }

  .segment-body.align-left {
    text-align: left;
    margin-right: 25%;
  }

  .segment-body.align-right {
    text-align: right;
    margin-left: 25%;
  }

  .segment-body.align-center {
    text-align: center;
    color: #8a8a86;
  }

  .segment-body.partial {
    opacity: 0.55;
  }

  .flagged-word {
    color: #ffb84d;
  }

  .live-chip {
    position: absolute;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    background: #141414;
    border: 1px solid #3a3a36;
    color: #e8e8e4;
    font-size: 11px;
    letter-spacing: 0.03em;
    padding: 6px 14px;
    border-radius: 999px;
    cursor: pointer;
  }

  .live-chip:hover {
    border-color: #ffb84d;
    color: #ffb84d;
  }
</style>
