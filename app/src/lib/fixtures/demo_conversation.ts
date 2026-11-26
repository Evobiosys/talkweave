// SPDX-License-Identifier: AGPL-3.0-or-later

// talkweave — demo fixture for replay_engine.ts (Task 8).
//
// A scripted ~36-turn conversation: Jakob (L) pitching "Unlocking Housing"
// (geo-mapping vacant buildings across Styria/Austria for conversion into
// affordable, community-owned housing) to a skeptical friend (R). Written
// to exercise the app's real features once replayed:
//   - alternating L/R speakers, so currentSpeaker visibly flips (Task 5's
//     key map + side-panel attribution).
//   - several checkable, specific factual claims (populations, a founding
//     year, a vacancy count) for the Task 9 fact-check pipeline to have
//     something real to grade. Two are DELIBERATELY WRONG, marked below,
//     so a fact-check demo has both a true and a false claim to contrast:
//       * turn 11 ("Vienna had its first pilot back in 2005") — wrong;
//         community land trust pilots in the Vienna area are a
//         considerably more recent (post-2015) phenomenon.
//       * turn 17 ("Austria ... only about twelve million people") — wrong;
//         Austria's population is roughly 9 million.
//     Correct-for-contrast claims: Styria's population (~1.24 million,
//     turn 5) and Graz's (~290,000, turn 15) are both realistic.
//   - a few short interjections ("Huh, I always pictured it bigger.") so
//     not every turn is a monologue.
//
// Deliberately just `{ speaker, duration, text }` per turn, NOT absolute
// `tStart`/`tEnd`: replay_engine.ts derives each turn's `tStart` as the
// running sum of every prior turn's `duration` (`tEnd = tStart + duration`)
// — composition alone guarantees the timeline is monotonic and
// non-overlapping without this file having to maintain redundant absolute
// timestamps by hand (see demo_conversation.test.ts's `timeline()` helper,
// which performs exactly that same running sum for the fixture-integrity
// checks).
//
// Durations are a rough words-per-second estimate for natural spoken
// pacing (~2.3 words/sec, matching this cast's conversational register),
// not a transcript-derived measurement — good enough for a demo timeline,
// not claimed to be more than that.

import type { Speaker } from '../../../../shared/engine';

export interface DemoTurn {
  speaker: Speaker;
  /** Seconds this turn takes to "speak" in the replay — see module header. */
  duration: number;
  text: string;
}

export const DEMO_CONVERSATION: DemoTurn[] = [
  {
    speaker: 'L',
    duration: 9.1,
    text: "So I've been building something the last few months, mapping empty buildings across Styria that could become affordable co-living spaces."
  },
  { speaker: 'R', duration: 3.9, text: 'Empty buildings? Like, actually empty, or empty on paper?' },
  {
    speaker: 'L',
    duration: 11.3,
    text: 'Actually empty. We pulled property registry data plus satellite imagery and cross-checked utility usage, and Styria alone has around eighteen thousand residential units sitting vacant.'
  },
  { speaker: 'R', duration: 2.6, text: 'Eighteen thousand? That sounds made up.' },
  {
    speaker: 'L',
    duration: 12.6,
    text: "It's close to the number the Statistik Austria housing survey put out. Styria's population is about 1.24 million people, and vacancy rates there run higher than in Vienna."
  },
  {
    speaker: 'R',
    duration: 7.4,
    text: "Okay, but even if that's true, who owns these buildings? You can't just move people in."
  },
  {
    speaker: 'L',
    duration: 12.6,
    text: 'Right, ownership is the whole puzzle. A lot of it is inherited property, second homes nobody visits, or small landlords who gave up on renting because of renovation costs.'
  },
  { speaker: 'R', duration: 3.9, text: 'So your plan is what, exactly? Knock on doors?' },
  {
    speaker: 'L',
    duration: 11.3,
    text: 'The first version is a map. Public, searchable, showing building type, estimated vacancy duration, and rough renovation cost. Then we connect owners with community land trusts.'
  },
  {
    speaker: 'R',
    duration: 6.5,
    text: "Community land trusts. I've heard the term but I don't actually know what it means."
  },
  {
    speaker: 'L',
    duration: 14.8,
    text: "It's a nonprofit that holds the land permanently, so the building above it stays affordable even if it changes hands. Vienna had its first pilot back in 2005, actually one of the earliest in Europe."
  },
  {
    speaker: 'R',
    duration: 7.4,
    text: "Vienna started that in 2005? I thought Vienna's whole social housing thing went back to the 1920s."
  },
  {
    speaker: 'L',
    duration: 10.9,
    text: "The Gemeindebau program does, yeah, that's from the interwar period. The land trust model is newer, more of a grassroots add-on to the existing system."
  },
  {
    speaker: 'R',
    duration: 7.4,
    text: "Fine. But Graz is where you're actually testing this, right? Graz has what, half a million people?"
  },
  {
    speaker: 'L',
    duration: 6.5,
    text: 'Not quite, Graz is around two hundred ninety thousand. Second largest city in Austria after Vienna.'
  },
  { speaker: 'R', duration: 2.6, text: 'Huh, I always pictured it bigger.' },
  {
    speaker: 'L',
    duration: 8.3,
    text: 'Everyone does. Austria overall is only about twelve million people, so even the second city is modest by European standards.'
  },
  {
    speaker: 'R',
    duration: 6.1,
    text: 'Okay. So walk me through an actual building. You said you have real examples?'
  },
  {
    speaker: 'L',
    duration: 8.7,
    text: "Yeah, there's a former textile factory in Kapfenberg, vacant since 2011, about four thousand square meters. Zoning already allows residential conversion."
  },
  { speaker: 'R', duration: 3.0, text: 'Thirteen years empty and nobody touched it?' },
  {
    speaker: 'L',
    duration: 12.2,
    text: "The original owner died without a clear heir, and it sat in a probate dispute for most of that time. That's actually a really common pattern in our dataset."
  },
  { speaker: 'R', duration: 2.2, text: "So legally it's a mess." },
  {
    speaker: 'L',
    duration: 8.7,
    text: 'For that one, yes. Plenty of others are simpler, just an owner who moved abroad and never dealt with the property.'
  },
  { speaker: 'R', duration: 4.3, text: "And your funding model? Because mapping buildings doesn't pay rent." },
  {
    speaker: 'L',
    duration: 13.9,
    text: 'Phase one is grant funded, we already have a small commitment from a regional development fund. Phase two would be a mix of crowdfunding and the land trust taking on a renovation loan.'
  },
  { speaker: 'R', duration: 1.7, text: 'How small is small?' },
  {
    speaker: 'L',
    duration: 7.0,
    text: 'Forty thousand euros, enough to finish the map and run the Kapfenberg pilot through a feasibility study.'
  },
  { speaker: 'R', duration: 4.8, text: 'That is small. What happens if the feasibility study says no?' },
  {
    speaker: 'L',
    duration: 10.9,
    text: "Then we've spent forty thousand euros to learn that and we pick a different building. That's kind of the point of doing a pilot first."
  },
  {
    speaker: 'R',
    duration: 7.0,
    text: 'Fair. I guess my real worry is that this becomes another well-meaning map that nobody acts on.'
  },
  {
    speaker: 'L',
    duration: 14.3,
    text: "That's the risk with every version of this idea, honestly. The difference I'm betting on is pairing the map directly with a legal structure and a funding path, not just publishing data and hoping."
  },
  { speaker: 'R', duration: 4.3, text: "Who's actually going to use the map, day to day?" },
  {
    speaker: 'L',
    duration: 11.7,
    text: 'Municipalities first, since they already track some of this informally. Then housing cooperatives, then eventually the public once the data quality is solid enough not to embarrass anyone.'
  },
  {
    speaker: 'R',
    duration: 6.1,
    text: 'And the deliberately wrong numbers thing you mentioned earlier, that was a joke, right?'
  },
  {
    speaker: 'L',
    duration: 11.3,
    text: "Ha, no, that's literally part of the demo data. Some figures in here are slightly off on purpose so the fact check panel has something to catch."
  },
  { speaker: 'R', duration: 5.7, text: "Of course it does. Alright, send me the map link when it's ready." }
];
