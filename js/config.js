// Central configuration. The Supabase project is shared with the sibling games
// FRIENDLE (channel prefix `friendle:`) and HMMM? (`hmmm:`); TO-WORD MUST keep
// its own `toword:` prefix or rooms from different games would collide.
export const SUPABASE_URL = 'https://lapkrvmlmwfrwqmzxukt.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_M9Xu80-XQ1Vyjg55T-Cp8g_2EnL2_Mm';
export const CHANNEL_PREFIX = 'toword:';

// localStorage / sessionStorage keys - namespaced for the same reason.
export const STORE = {
  name: 'toword-name',
  sound: 'toword-sound',
  theme: 'toword-theme',
  id: 'toword-id',
};

// Room codes: 4 chars, no lookalikes (O/0, I/1 excluded).
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 4;

export const MIN_PLAYERS = 1;   // TO-WORD is co-op: solo is a legitimate run
export const MAX_PLAYERS = 4;
export const WORD_LEN = 5;
export const MAX_ROWS = 6;      // the revive wordle's grid

// TOWER (the whole game): co-op, 1-4 players, endless. Stack valid words under
// an escalating DECREE. Misses cost lives; the hunger clock keeps the team
// moving; scores are RPG-huge on purpose.
export const TOWER = {
  lives: 3,
  maxLives: 5,             // cap for bonus hearts (milestones/easter eggs)
  reviveCost: 5000,
  reviveLives: 2,          // a revived teammate comes back with 2
  // Words needed per decree before it escalates - host-set directly (see
  // DECREE_CHOICES below), independent of the DIFFICULTY setting.
  // Counterintuitively, a LOW count plays easier: the team cycles to a
  // fresh (often gentler) constraint before their collective vocabulary for
  // any one decree runs dry; a HIGH count forces them to keep finding
  // distinct words under the SAME constraint until they're stuck.
  defaultRampWords: 5,
  hungerMs: 35000,         // silence = everyone bleeds (flat, not difficulty-tied)
  base: 500,               // per-word base, before letter values and stage
  perLetterValue: 50,      // * scrabble-ish letter value
  comboPct: 0.1,           // * combo count, multiplicative
  minWordsPerDecree: 4,    // decree floor before rampWords is factored in (see tower.js genConstraint)
  heartEveryHeight: 10,    // team-wide bonus heart every N floors climbed
  // How many of the newest floors are mounted in the 3D scene at once.
  // Load-bearing in TWO places kept in sync: tower3d.js renders the last
  // `visibleRows`, AND the engine's duplicate-word rule only rejects words
  // STILL on screen - a word that has scrolled past this window becomes
  // playable again.
  visibleRows: 10,
};

export const DECREE_CHOICES = [3, 5, 10];

export const SHOP = {
  revive: {
    price: TOWER.reviveCost, glyph: '✦', name: 'REVIVE',
    desc: 'Solve a plain wordle to bring a fallen teammate back with 2 lives',
    target: 'downed',
  },
};

export const LETTER_VALUES = {
  a: 1, e: 1, i: 1, o: 1, u: 1, l: 1, n: 1, s: 1, t: 1, r: 1,
  d: 2, g: 2, b: 3, c: 3, m: 3, p: 3, f: 4, h: 4, v: 4, w: 4, y: 4,
  k: 5, j: 8, x: 8, q: 10, z: 10,
};

// Decree difficulty. 'ramp' climbs easy -> medium -> hard as the tower grows,
// then holds at hard; the others pin every decree to that band all game.
export const DIFFICULTY_CHOICES = ['easy', 'medium', 'hard', 'ramp'];

export const DEFAULT_SETTINGS = {
  difficulty: 'ramp',
  rampWords: TOWER.defaultRampWords, // words per decree, host-set 3/5/10
  revealMs: 4000,                    // pacing beat (tests shrink it)
  countdownMs: 1200,                 // pre-run beat (tests shrink it)
};

// Signature accents by join order. Deliberately restrained: the page is ink on
// paper, and these read on BOTH the light and inverted themes. They are used
// for thin edges, initials, and point flashes - never as fills.
export const PLAYER_COLORS = ['#d92b3a', '#2f6fed', '#149b62', '#c9821a'];

// Presence timing (transport-level).
export const HEARTBEAT_MS = 800;       // LocalTransport heartbeat
export const PRESENCE_TIMEOUT_MS = 2600;
export const LEAVE_GRACE_MS = 8000;    // gone this long = treated as quit
                                       // (roomy: phone locks and radio blips
                                       //  make presence flap for seconds)

export const ERR_NAPPING =
  'The server is napping \u{1F634} — the owner can wake it in the Supabase dashboard.';
