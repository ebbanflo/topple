// Decree (constraint) generation + matching + RPG scoring - the rules engine
// of TOPPLE.
// Pure functions over the guess dictionary - the engine (host) generates and
// judges; clients only render what they're told.

import { GUESSES } from '../data/guesses.js';
import { SOLUTIONS } from '../data/solutions.js';
import { TOWER, LETTER_VALUES, WORD_LEN } from './config.js';
import { heldRelics } from './relics.js';

const VOWELS = ['a', 'e', 'i', 'o', 'u'];
const COMMON = 'etaoinshrdlcumwfgypb'; // top ~20 by in-dictionary frequency
const CONS = 'tnshrdlcmwfgpb';         // common consonants (COMMON minus vowels)
const RARE = 'jqxzvk';                 // reserved for HARD - never in COMMON
// Every source of randomness in this file takes its generator as an argument.
// decree.js stays a module of pure functions - no module-level RNG state, no
// global to reset between tests - which is what lets the same seed deal the
// same run on every device, and lets the test suite call any of this directly
// from node with no setup at all.
const rand = (n, r) => Math.floor(r() * n);
const pickFrom = (s, r) => s[rand(s.length, r)];
const uniqArr = (arr) => [...new Set(arr)];

// A decree: { req, reqAt, ban, rep, uniq, vmin, vmax, bookend, dvowel }.
// req: must contain these letters. reqAt: letter pinned to a slot.
// ban: must not contain these letters. rep: needs a repeated letter.
// uniq: all letters distinct. vmin/vmax: vowel-count bounds. bookend:
// first letter === last letter. dvowel: two vowels back to back somewhere.
export function matchesConstraint(word, c) {
  if (!c) return true;
  for (const ch of c.req || []) if (!word.includes(ch)) return false;
  for (const { i, ch } of c.reqAt || []) if (word[i] !== ch) return false;
  for (const ch of c.ban || []) if (word.includes(ch)) return false;
  const distinct = new Set(word).size === word.length;
  if (c.rep && distinct) return false;
  if (c.uniq && !distinct) return false;
  if (c.vmin != null || c.vmax != null) {
    const vc = [...word].filter((ch) => VOWELS.includes(ch)).length;
    if (c.vmin != null && vc < c.vmin) return false;
    if (c.vmax != null && vc > c.vmax) return false;
  }
  if (c.bookend && word[0] !== word[word.length - 1]) return false;
  if (c.dvowel) {
    let has = false;
    for (let i = 0; i < word.length - 1; i++) {
      if (VOWELS.includes(word[i]) && VOWELS.includes(word[i + 1])) { has = true; break; }
    }
    if (!has) return false;
  }
  return true;
}

export function countPossible(c, used) {
  let n = 0;
  for (const w of GUESSES) {
    if (!used.has(w) && matchesConstraint(w, c)) n++;
  }
  return n;
}

// Recognizability floor: a decree must be satisfiable by at least `floor` words
// from the curated SOLUTIONS bank ("answers people actually know"), not merely
// the full 14.8k guess dictionary. A decree only clearable via lymph / pshaw /
// tsars is technically survivable but feels broken to a human - this rejects
// those shapes at generation time. Early-exits the moment the floor is met, so
// it's cheap for the common (word-rich) case. Static by design: it judges the
// decree's SHAPE, independent of which words a game has already used.
export function countRecognizable(c, floor = Infinity) {
  let n = 0;
  for (const w of SOLUTIONS) {
    if (matchesConstraint(w, c) && ++n >= floor) return n;
  }
  return n;
}

// Three hand-vetted difficulty pools (see tools/vet-decrees.mjs-style checks
// run against the real 14.8k-word GUESSES bank before these were tuned -
// every generator here reliably clears its pool's minWords floor below).
// EASY: always four-figure possible-word counts - never punishing.
const EASY = [
  (r) => ({ req: [pickFrom(COMMON, r)] }),
  (r) => ({ reqAt: [{ i: rand(5, r), ch: pickFrom(COMMON.slice(0, 12), r) }] }),
  () => ({ vmin: 2 }),                              // at least 2 vowels
  () => ({ uniq: true }),                           // no repeated letters
  (r) => ({ ban: [pickFrom('jqxz', r)] }),          // one rare letter forbidden
];

// MEDIUM: real friction (dozens to low-thousands), never a coin-flip.
const MEDIUM = [
  (r) => ({ req: uniqArr([pickFrom(COMMON.slice(0, 14), r), pickFrom(COMMON.slice(0, 14), r)]) }),
  (r) => {
    const i = rand(4, r);
    return { reqAt: [{ i, ch: pickFrom(COMMON.slice(0, 14), r) }, { i: i + 1 + rand(4 - i, r), ch: pickFrom(COMMON.slice(0, 14), r) }] };
  },
  () => ({ vmin: 1, vmax: 1 }),                     // exactly one vowel
  () => ({ rep: true }),                            // needs a double letter
  () => ({ dvowel: true }),                         // two vowels in a row
  (r) => ({ reqAt: [{ i: rand(5, r), ch: pickFrom(COMMON.slice(0, 14), r) }], ban: [pickFrom(VOWELS, r)] }),
  () => ({ vmin: 3 }),                              // 3+ vowels
];

// HARD: brutal but never JUST "no vowels, minus more letters" - a big, varied
// rotation of structural, letter-count, and rare-letter twists. Each generator
// was vetted against the recognizable SOLUTIONS bank (not just the full GUESSES
// dictionary): the ones that only survived on obscure words nobody knows
// (no-vowels+no-repeats -> lymph/glyph/sylph; bookend+slot -> raser/losel)
// were cut. NO VOWELS stays but as just ONE of eleven options (~9%), not the
// place hard converges - the pool is deliberately wide so hard keeps cycling
// through fresh ideas. countPossible + countRecognizable keep every one honest
// at runtime (see genConstraint).
const HARD = [
  () => ({ bookend: true }),                                        // first letter == last letter
  (r) => ({ reqAt: [{ i: 0, ch: pickFrom('bcdfgp', r) }] }),        // STARTS WITH B/C/D/F/G/P
  (r) => ({ reqAt: [{ i: 4, ch: pickFrom('tdkyh', r) }] }),         // ENDS IN T/D/K/Y/H
  (r) => ({ req: [pickFrom(RARE, r)] }),                            // a genuinely rare letter (J/Q/X/Z/V/K)
  () => ({ ban: [...VOWELS] }),                                     // NO VOWELS - the occasional spicy "crypt/nymph" test
  (r) => ({ ban: [pickFrom('eao', r)] }),                           // ban a common vowel: NO E / NO A / NO O (Gadsby-style)
  (r) => ({ vmin: 1, vmax: 1, reqAt: [{ i: 1 + rand(3, r), ch: pickFrom(CONS, r) }] }), // exactly 1 vowel + an interior consonant pinned
  () => ({ rep: true, vmin: 1, vmax: 1 }),                          // a double letter AND exactly one vowel
  (r) => ({ rep: true, req: [pickFrom(COMMON.slice(0, 10), r)] }),  // a double letter AND a required common letter
  () => ({ bookend: true, vmin: 2 }),                               // first == last AND two-plus vowels
  (r) => ({ req: uniqArr([pickFrom(VOWELS, r), pickFrom(CONS, r), pickFrom(CONS, r)]) }), // 3 required letters, but at least one vowel keeps it human
];

function poolFor(difficulty, stage) {
  if (difficulty === 'easy') return EASY;
  if (difficulty === 'medium') return MEDIUM;
  if (difficulty === 'hard') return HARD;
  // 'ramp' (default): climbs easy -> medium -> hard as the tower grows, then
  // STAYS in hard - rotating through its varied generators for flavor -
  // instead of piling on ever more bans until only unrecognizable scraps
  // of the dictionary are left standing.
  if (stage <= 2) return EASY;
  if (stage <= 5) return MEDIUM;
  return HARD;
}

export function genConstraint(stage, used, difficulty = 'ramp', rampWords = 1, prev = null, rng = Math.random) {
  const pool = poolFor(difficulty, stage);
  // A decree must be survivable: enough unused dictionary words must satisfy
  // it. Floor scales with the pool (hard is SUPPOSED to be cruel, easy never
  // should be) but never drops below rampWords itself - the team needs that
  // many DISTINCT legal words to ever clear the decree, so generating one
  // that can't mathematically supply that many would strand them for good.
  const poolFloor = pool === HARD ? TOWER.minWordsPerDecree
    : pool === MEDIUM ? TOWER.minWordsPerDecree * 10
      : TOWER.minWordsPerDecree * 40;
  const minWords = Math.max(poolFloor, rampWords);
  // Three gates: `minWords` (over the fresh, unused guess pool - can the team
  // still clear it), `recogFloor` (over the static SOLUTIONS bank - is it
  // satisfiable by real, recognizable words), AND it must not be the SAME
  // decree as the one it's replacing - a decree never repeats back-to-back, so
  // the tower never feels stuck sending "NO VOWELS" (or any rule) twice running.
  // HARD keeps the recog floor modest so its spice survives; easy/medium high.
  const recogFloor = pool === HARD ? 25 : pool === MEDIUM ? 40 : 100;
  const prevDesc = prev ? describeConstraint(prev) : null;
  for (let tries = 0; tries < 40; tries++) {
    const c = pool[rand(pool.length, rng)](rng);
    if (describeConstraint(c) === prevDesc) continue; // no immediate repeat
    if (countPossible(c, used) >= minWords && countRecognizable(c, recogFloor) >= recogFloor) return c;
  }
  // this pool is exhausted this deep into a long game (rare) - drop a notch
  // rather than serve something the team can no longer possibly satisfy
  if (pool === HARD) return genConstraint(stage, used, 'medium', rampWords, prev, rng);
  if (pool === MEDIUM) return genConstraint(stage, used, 'easy', rampWords, prev, rng);
  return { req: [pickFrom('east', rng)] };
}

export function describeConstraint(c) {
  const parts = [];
  if (c.reqAt?.length) {
    parts.push(c.reqAt.map(({ i, ch }) => {
      const L = ch.toUpperCase();
      if (i === 0) return `STARTS WITH ${L}`;
      if (i === WORD_LEN - 1) return `ENDS IN ${L}`;
      return `${L} IN SLOT ${i + 1}`;
    }).join(' + '));
  }
  if (c.req?.length) parts.push(`MUST USE ${c.req.map((x) => x.toUpperCase()).join(' + ')}`);
  if (c.ban?.length) {
    const isNoVowels = VOWELS.every((v) => c.ban.includes(v));
    const extras = c.ban.filter((ch) => !VOWELS.includes(ch));
    if (isNoVowels) parts.push('NO VOWELS' + (extras.length ? ` · NO ${extras.map((x) => x.toUpperCase()).join(' ')}` : ''));
    else parts.push(`FORBIDDEN: ${c.ban.map((x) => x.toUpperCase()).join(' ')}`);
  }
  if (c.bookend) parts.push('FIRST + LAST LETTER MATCH');
  if (c.rep) parts.push('NEEDS A DOUBLE LETTER');
  if (c.uniq) parts.push('NO REPEATED LETTERS');
  if (c.dvowel) parts.push('TWO VOWELS IN A ROW');
  if (c.vmin != null && c.vmin === c.vmax) parts.push(`EXACTLY ${c.vmin} VOWEL${c.vmin === 1 ? '' : 'S'}`);
  else if (c.vmin != null) parts.push(`${c.vmin}+ VOWELS`);
  else if (c.vmax != null) parts.push(`AT MOST ${c.vmax} VOWEL${c.vmax === 1 ? '' : 'S'}`);
  return parts.join(' · ') || 'ANY WORD';
}

// RPG numbers: big, stage-multiplied, combo-inflated - and, in ASCENT, bent by
// whatever relics the placing player holds.
//
// Two halves, which is what the HUD shows and what relics attach to:
//   STONE  the word     base + letter values, then relic stone / stoneMul
//   MULT   the run      stage x combo, then relic mult (+) and xmult (x)
//
// ONE implementation, deliberately: an earlier draft had a separate relic-aware
// copy of this formula, and the two disagreed by ten points at stage 3 combo 9
// purely because floating-point multiplication is not associative. wordPoints()
// is now a call into this with an empty relic list, so that class of drift is
// impossible rather than merely unlikely.
export function scoreBreakdown(word, ctx = {}) {
  const held = heldRelics(ctx.relics);
  const stage = ctx.stage ?? 1;
  const combo = ctx.combo ?? 0;

  const letters = [...word].reduce((s, ch) => s + (LETTER_VALUES[ch] || 1), 0);
  let stone = TOWER.base + letters * TOWER.perLetterValue;
  for (const r of held) if (r.stone) stone += r.stone(word, ctx) || 0;
  for (const r of held) if (r.stoneMul) stone *= r.stoneMul(word, ctx) ?? 1;

  let mult = 1 + TOWER.comboPct * combo;
  for (const r of held) if (r.mult) mult += (r.mult(word, ctx) || 0) / stage;
  for (const r of held) if (r.xmult) mult *= r.xmult(word, ctx) ?? 1;

  // grouped exactly as the original formula was, so the no-relic case is
  // bit-for-bit what CLASSIC has always paid
  const raw = stone * stage * mult;
  return {
    stone: Math.round(stone),
    mult: Math.round(stage * mult * 100) / 100,
    points: Math.round(raw / 10) * 10,
  };
}

export function scoreWord(word, ctx = {}) { return scoreBreakdown(word, ctx).points; }

export function wordPoints(word, stage, combo) {
  return scoreBreakdown(word, { stage, combo }).points;
}
