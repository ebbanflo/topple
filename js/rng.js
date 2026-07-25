// Seeded randomness, so a whole friend group can be dealt the same run.
//
// Nothing here is cryptographic and nothing needs to be - the only requirement
// is that the same seed produces the same sequence in every browser, forever.
// mulberry32 is a 32-bit generator with no dependence on engine internals, so
// two phones on different browsers walk the same decrees step for step.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a. Turns a date string (or any label) into a 32-bit seed.
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// UTC, deliberately: a room with players either side of midnight local time
// must still be playing the same day's tower.
export function dailyKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const EPOCH = Date.UTC(2026, 0, 1);

// A human-facing run number, so people can say "how did you do on 214?"
export function dailyNumber(d = new Date()) {
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((today - EPOCH) / 86400000) + 1;
}
