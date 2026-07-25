// Relics: the run modifiers drafted at each intermission. ASCENT only.
//
// Shaped deliberately like decree.js - a declarative registry of pure functions
// over a context object, with no engine imports and no state of its own. That
// is what lets every number below be unit-tested straight from node, which
// matters more here than anywhere else in the codebase: a relic that silently
// scores wrong is invisible in play and obvious in a test.
//
// Scoring is two halves, and every relic attaches to exactly one of them:
//
//   STONE  the word itself      base + letter values + relic `stone` / `stoneMul`
//   MULT   the run around it    stage x combo, + relic `mult`, x relic `xmult`
//
// The arithmetic itself lives in decree.js, which owns scoring for the whole
// game. There is exactly one implementation: CLASSIC's wordPoints() is a thin
// call into the same breakdown with no relics held, so the two can never drift
// apart by a rounding step - a bug this file's first draft actually had.

import { LETTER_VALUES, TOWER } from './config.js';

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const RARE = new Set(['j', 'q', 'x', 'z', 'k']);

const vowelCount = (w) => [...w].filter((c) => VOWELS.has(c)).length;
const hasDouble = (w) => new Set(w).size !== w.length;

// ctx: { stage, combo, height, sinceLastMs, placedThisStorey:Set, livingCount, storey }
export const RELICS = {
  vowel_tithe: {
    name: 'VOWEL TITHE', rarity: 'common', price: 4,
    desc: '+40 stone for every vowel in the word',
    stone: (w) => 40 * vowelCount(w),
  },
  consonant_forge: {
    name: 'CONSONANT FORGE', rarity: 'common', price: 4,
    desc: '+25 stone for every consonant',
    stone: (w) => 25 * (w.length - vowelCount(w)),
  },
  rare_earth: {
    name: 'RARE EARTH', rarity: 'uncommon', price: 7,
    desc: 'J Q X Z K are worth triple',
    stone: (w) => [...w].reduce((s, c) => s + (RARE.has(c) ? (LETTER_VALUES[c] || 1) * 2 * TOWER.perLetterValue : 0), 0),
  },
  long_shadow: {
    name: 'LONG SHADOW', rarity: 'uncommon', price: 7,
    desc: '+150 stone if the word shares no letter with the floor below',
    stone: (w, ctx) => {
      if (!ctx.below) return 0;
      const below = new Set(ctx.below);
      return [...w].some((c) => below.has(c)) ? 0 : 150;
    },
  },
  metronome: {
    name: 'METRONOME', rarity: 'common', price: 5,
    desc: '+1 mult if you land within 3 seconds of the last word',
    mult: (w, ctx) => (ctx.sinceLastMs != null && ctx.sinceLastMs <= 3000 ? 1 : 0),
  },
  architect: {
    name: 'ARCHITECT', rarity: 'uncommon', price: 7,
    desc: '+0.5 mult for every 10 floors standing',
    mult: (w, ctx) => Math.floor((ctx.height || 0) / 10) * 0.5,
  },
  double_helix: {
    name: 'DOUBLE HELIX', rarity: 'uncommon', price: 8,
    desc: 'x1.5 mult on any word with a repeated letter',
    xmult: (w) => (hasDouble(w) ? 1.5 : 1),
  },
  chorus: {
    name: 'CHORUS', rarity: 'rare', price: 11,
    desc: 'x2 mult once every living player has placed a word this storey',
    xmult: (w, ctx) => ((ctx.livingCount > 1 && ctx.placedCount >= ctx.livingCount) ? 2 : 1),
  },
  dead_language: {
    name: 'DEAD LANGUAGE', rarity: 'rare', price: 10,
    desc: '+0.4 mult for each storey already cleared',
    mult: (w, ctx) => 0.4 * Math.max(0, (ctx.storey || 1) - 1),
  },

  // ---- the tradeoffs: these change rules, not just numbers ----
  scaffold: {
    name: 'SCAFFOLD', rarity: 'uncommon', price: 8,
    desc: 'your first miss each storey costs no life',
    freeMiss: true,
  },
  keystone: {
    name: 'KEYSTONE', rarity: 'rare', price: 11,
    desc: 'you may reuse words still standing in the tower',
    allowDuplicate: true,
  },
  greed: {
    name: 'GREED', rarity: 'uncommon', price: 7,
    desc: 'x1.5 mult, but the tower hungers 10s sooner',
    xmult: () => 1.5,
    hungerDelta: -10000,
  },
  patience: {
    name: 'PATIENCE', rarity: 'common', price: 5,
    desc: '+12s before the tower hungers, but 20% less stone',
    stoneMul: () => 0.8,
    hungerDelta: 12000,
  },
  blood_mortar: {
    name: 'BLOOD MORTAR', rarity: 'rare', price: 12,
    desc: 'a word that breaks the decree is built anyway — and costs a life',
    forcePlace: true,
  },
  insurance: {
    name: 'INSURANCE', rarity: 'rare', price: 12,
    desc: 'the first collapse leaves the tower standing at one floor',
    insures: true,
  },
};

export const RELIC_IDS = Object.keys(RELICS);
export const MAX_RELICS = 5;       // per player, for a whole run
export const REROLL_COST = 2;

export function relicById(id) { return RELICS[id] || null; }

// Held relics for one player, as objects. Unknown ids are dropped rather than
// throwing - a stale id from an old client must never take the room down.
export function heldRelics(ids) {
  return (ids || []).map((id) => RELICS[id]).filter(Boolean);
}

// Does ANY relic in this list grant the given rule override?
export function grants(ids, flag) {
  return heldRelics(ids).some((r) => r[flag]);
}

// Team-wide hunger adjustment: every player's relics count, because the clock
// is shared. Floored so a stack of GREED can never reach zero.
export function hungerFor(baseMs, relicsByPid) {
  let ms = baseMs;
  for (const ids of Object.values(relicsByPid || {})) {
    for (const r of heldRelics(ids)) ms += r.hungerDelta || 0;
  }
  return Math.max(6000, ms);
}

// Deal `n` relics a player does not already hold. Takes its randomness as an
// argument for the same reason decree.js does: a DAILY ascent must offer the
// same shop to everyone.
export function dealRelics(ownedIds, n = 3, rng = Math.random) {
  const owned = new Set(ownedIds || []);
  const pool = RELIC_IDS.filter((id) => !owned.has(id));
  const out = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return out;
}
