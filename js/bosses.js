// Boss decrees: a rule that warps a whole storey, on top of whatever decree the
// team drafted. ASCENT only.
//
// The plan called for teaching matchesConstraint() a context argument so these
// could ride on the existing DSL. They don't, deliberately: THE TWIN needs the
// floor below and THE SILENCE needs to know whose turn it is, and both are
// engine state, not word state. matchesConstraint has to stay a stateless
// predicate over a word - countRecognizable() runs it across the entire answer
// bank to vet decrees, and the decree draft calls that on every deal. Making it
// stateful to serve two bosses would have quietly broken the thing that keeps
// every generated decree humane.
//
// So bosses get their own shape, and the engine ANDs them in:
//
//   constraint  a plain decree, merged into the drafted one (stateless)
//   check       (word, ctx) -> rejection reason or null (stateful)
//   toll        (word) -> true if the word places but costs a life
//   solo        one player at a time, rotating
//   hungerMul   scales the shared clock

import { LETTER_VALUES } from './config.js';

const letterValue = (w) => [...w].reduce((s, c) => s + (LETTER_VALUES[c] || 1), 0);
const sharedLetters = (a, b) => {
  const bs = new Set(b);
  return new Set([...a].filter((c) => bs.has(c))).size;
};

export const BOSSES = {
  censor: {
    name: 'THE CENSOR',
    short: 'NO E',
    desc: 'the letter E is forbidden for the whole storey',
    constraint: { ban: ['e'] },
  },
  glutton: {
    name: 'THE GLUTTON',
    short: 'HALF CLOCK',
    desc: 'the tower hungers twice as fast',
    hungerMul: 0.5,
  },
  twin: {
    name: 'THE TWIN',
    short: 'SHARE 2',
    desc: 'every word shares exactly two letters with the floor below it',
    check: (word, ctx) => {
      if (!ctx.below) return null; // the first floor of a storey has nothing to echo
      const n = sharedLetters(word, ctx.below);
      return n === 2 ? null : `shares ${n} letters with ${ctx.below.toUpperCase()}, needs 2`;
    },
  },
  tax: {
    name: 'THE TAX',
    short: 'CHEAP WORDS BLEED',
    desc: 'a word worth less than 6 in letters is built, and costs a life',
    toll: (word) => letterValue(word) < 6,
  },
  silence: {
    name: 'THE SILENCE',
    short: 'ONE VOICE',
    desc: 'one mason at a time — the tower listens to one voice, then the next',
    solo: true,
  },
};

export const BOSS_IDS = Object.keys(BOSSES);

// Storeys 3, 6 and the finale. Everything else is an ordinary climb.
export function isBossStorey(storey, storeys) {
  return storey % 3 === 0 || storey === storeys;
}

export function pickBoss(seen = [], rng = Math.random) {
  const fresh = BOSS_IDS.filter((id) => !seen.includes(id));
  const pool = fresh.length ? fresh : BOSS_IDS;
  return pool[Math.floor(rng() * pool.length)];
}

export function bossById(id) { return BOSSES[id] || null; }

// Union two decrees so a boss's rule genuinely ANDs with the drafted one rather
// than replacing it. Array fields concatenate; the rest is last-wins, and
// vowel bounds take the tighter of the two.
export function mergeConstraints(a, b) {
  if (!a) return { ...b };
  if (!b) return { ...a };
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(v)) out[k] = [...new Set([...(a[k] || []), ...v])];
    else if (k === 'vmin') out[k] = Math.max(a.vmin ?? 0, v);
    else if (k === 'vmax') out[k] = Math.min(a.vmax ?? Infinity, v);
    else out[k] = v;
  }
  return out;
}
