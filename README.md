# TOPPLE

A co-op word tower for 1–4 players. Stack real 5-letter words into a shared
structure; every word must obey the current **decree**. Misses cost lives, the
hunger clock never stops, and eventually the tower comes down.

Room-code multiplayer. No accounts, no downloads, no build step — a static site
served straight off GitHub Pages, with Supabase Realtime carrying the room.

---

## Modes

**CLASSIC** — the endless game. Climb until everyone is buried.

**ASCENT** — the structured run. Eight **levels**, each demanding a score
**quota**. Meet it and the tower holds while the team catches its breath —
everyone gets a heart back, anyone buried is lifted out, and you bank **coins**.
Then the next level asks for more. There is deliberately no second clock: the
hunger bar is the pressure, and you fail a level by getting buried, not by
running out of turns. Clear the eighth and the tower is **crowned** — the only
way to actually win.

Levels **3, 6 and 8** bring a **boss decree** — a rule that warps the whole
level on top of whatever the team drafted. **THE CENSOR** forbids the letter E.
**THE GLUTTON** halves the clock. **THE TWIN** demands every word share exactly
two letters with the floor below. **THE TAX** builds cheap words anyway and takes
a life for them. **THE SILENCE** hands the tower one voice at a time.

At each intermission every player is dealt **three relics of their own**, bought
from the team's shared **coins** — so the room has to decide whose build is
worth funding. Five each, for the whole run. Some are plain numbers; the
interesting ones are trades: **GREED** multiplies your score and starves the
tower ten seconds sooner, **PATIENCE** does the reverse, **KEYSTONE** lets you
reuse words still standing, **BLOOD PACT** builds a decree-breaking word
anyway and takes a life for it, **INSURANCE** catches the first collapse.

**DAILY** — the same tower for everybody, everywhere, all day. Decrees are dealt
from a seed derived from the UTC date rather than from chance, and the settings
are locked so the runs are actually comparable. Rolls over at UTC midnight, so a
room split across timezones still plays the same tower.

## Playing

The host opens a room and reads out the 4-character code (or shares the invite
link). Up to three others join. Solo is a legitimate run.

- **The draft** — every stage change deals the team three decrees instead of
  imposing one. Any player may pick and the first tap wins; the old decree stays
  live while you decide and the hunger bar keeps draining, so dithering costs
  blood. Nobody picks in time and the tower picks for you.
- **Decree** — the rule every word must satisfy. Use a letter, a letter pinned
  to a slot, banned letters, vowel counts, and stranger twists at HARD: a rare
  letter, matching first/last letters, a double letter, "no E", "ends in K", no
  vowels at all. It rotates every 3 / 5 / 10 words (host's choice).
- **Level** — `EASY` / `MED` / `HARD` hold one difficulty band all game;
  `RAMP` climbs easy → hard and then stays there. Every generated decree is
  vetted to be clearable with words people actually recognise, and never
  repeats back-to-back.
- **Lives** — three each, capped at five. A word that isn't real, breaks the
  decree, or is still visible in the tower costs one. Floors that scroll past
  the visible ten become playable again.
- **Buried** — hitting zero does *not* put you out. You keep typing, but your
  words dig instead of build: three real words obeying the live decree and you
  climb out with one life. Dig words score nothing, add no floors and don't
  touch the combo, and a wrong one costs nothing (you're already at zero). The
  tower falls only when *everyone* is buried at once.
- **Hunger** — a shared clock. Let it empty and *everyone* loses a life and the
  combo resets. All players down = the tower falls.
- **Score** — base × letter values × stage, inflated by the team-wide combo.
  Deliberately absurd numbers.
- **Rope ✦ (2,000)** — anyone still standing can buy away one of a buried
  teammate's three dig words. Helping costs points, never time: nothing in
  TOPPLE pauses the clock.
- **Blessings** — a bonus heart for the whole team every 10th floor, and
  another if the last five floors happen to spell `T-O-W-E-R` down a column.

---

## How it fits together

Host-authoritative, with a thin mirror on every client.

| file | role |
| --- | --- |
| `js/engine.js` | Runs **only in the host's browser**. Owns every life, score, combo and the hunger clock, and judges every word — as base if you're standing, as rubble if you're buried. |
| `js/client.js` | `Mirror` — the state every peer (host included) renders from. Asserts at startup that it handles every host broadcast in the registry. |
| `js/protocol.js` | The single registry of wire events. Adding a host event without a mirror handler throws immediately. |
| `js/transport.js` | Swappable transport: Supabase Realtime broadcast + presence, or `BroadcastChannel` for tests (`?t=local`). |
| `js/decree.js` | Decree generation, matching and scoring. Pure functions over the dictionary — used by both the engine and the test suite. Takes its randomness as an argument, so it holds no RNG state. |
| `js/rng.js` | mulberry32 plus a string hash. Same seed, same tower, on every device. |
| `js/relics.js` | The relic catalogue: a declarative registry of pure functions over a context object, plus the rule-flag and dealing helpers. No engine imports, no state. |
| `js/bosses.js` | Boss decrees. Same shape as relics — a registry plus constraint merging. |
| `js/tower3d.js` | The tower renderer. Pure CSS 3D; deliberately swappable (`sync / push / miss / stress / bless / collapse / reset`). |
| `js/ui.js` | Everything else on screen. Renders exclusively from the mirror. |
| `js/words.js` | The dictionary gate, and nothing else. `data/solutions.js` is used only by `decree.js`, for the recognizability floor that keeps generated decrees humane. |

Words travel lightly obfuscated so other players' typing isn't casual
network-tab reading. That is obfuscation, not cryptography — the channel is
public.

Burial is **derived from lives, never stored twice**: `Engine.syncBuried()` and
`Mirror.syncBuried()` reconcile the two after any change, which is why bonus
hearts, hunger strikes and digs all compose without special cases — a heart that
lifts someone off zero un-buries them for free.

### The tower

Every floor is a real slab — front, top and two side faces in a `preserve-3d`
scene — so the stack has genuine depth, parallax and occlusion, and the letters
stay selectable text rather than a texture. The world translates down as the
stack grows, which *is* the camera climbing. When the run ends the floors
buckle from the base and tumble out of frame.

Ten floors stay mounted at once. That number is load-bearing in two places kept
in sync: the renderer's window, and the engine's duplicate-word rule.

### Layout contract

The game screen never scrolls and never reflows. Every band on it has an
explicit height — including the text ones, because `♥♥♥` and `—` produce
different line boxes — and the tower is the single elastic element that
absorbs whatever space is left. The keyboard therefore cannot move, whatever
the tower, the HUD or a rescue is doing. Two E2E tests assert exactly that.

### Seeded runs

`decree.js` takes its generator as a parameter rather than reaching for
`Math.random`, so it stays a module of pure functions with no RNG state to reset
between tests — and an entire run's decree sequence can be generated and
compared straight from node. CLASSIC passes nothing and gets `Math.random`;
DAILY passes a mulberry32 seeded from the UTC date. Only the host generates
decrees, so the seed itself never crosses the wire.

### Scoring

One implementation, in `decree.js`. A word is worth `BASE x MULT`: base is the
word (base + letter values, then relic `base` / `baseMul`), mult is the run
around it (stage x combo, then relic `mult` and `xmult`). `wordPoints()` — the
CLASSIC path — is a call into the same breakdown with an empty relic list.

That merge was not tidiness. An earlier draft had a separate relic-aware copy of
the formula, and the two disagreed by ten points at stage 3 combo 9, purely
because floating-point multiplication is not associative. A test asserts parity
across ~1,250 word/stage/combo combinations so that class of drift stays
impossible rather than merely unlikely.

### Why bosses aren't just decrees

Two of them can't be. `matchesConstraint()` is a stateless predicate over a
word, and it has to stay that way: `countRecognizable()` runs it across the
entire answer bank to vet every generated decree, and the draft calls that on
every deal. THE TWIN needs the floor below and THE SILENCE needs to know whose
turn it is — both engine state, not word state. Teaching `matchesConstraint` a
context argument to serve them would have quietly broken the thing that keeps
generated decrees humane, so bosses got their own shape instead
(`constraint` / `check` / `toll` / `solo` / `hungerMul`) and the engine ANDs
them in. A boss's stateless half still merges into the drafted decree rather
than replacing it.

### Tuning ASCENT

The quota curve in `js/config.js` (`levelQuota`, driven by `ASCENT.quotaBase`
and `ASCENT.quotaGrowth`) is a starting point and expected to move. A word is
worth roughly 900–1,700 early on and several times that once stage and combo
climb, so the honest way to tune it is to play it. `?debug=1` exposes
`setLevel(n)` so the eighth level can be tested without grinding the first
seven. For reference, level 1 currently falls in about seven words.

Coins earn rate (`ASCENT.coinsBase` plus overshoot and hearts in hand) and
relic prices in `relics.js` want the same treatment.

### Infrastructure

Shares one Supabase project with its sibling games. Channels are namespaced by
prefix (`topple:`, `friendle:`, `hmmm:`), so rooms from different games can
never collide even on the same code. Storage keys are namespaced the same way.
No tables, no auth, no rows — just Realtime broadcast and presence.

---

## Running it

Static files; no build.

```sh
npm run serve     # http://127.0.0.1:4173
```

Query flags: `?t=local` swaps Supabase for `BroadcastChannel` (multi-tab, zero
network), `?debug=1` installs the `window.__topple` test handle, `?join=CODE`
jumps straight into a room.

## Tests

```sh
npm install
npm test
```

Playwright drives the real site over `LocalTransport` — real engine, real
mirror, real DOM, no network. The suite covers the decree generator's
survivability and recognizability floors, the no-repeat rule, solo and co-op
runs, misses, hunger, burial and digging out, rope purchases, both blessings,
the scroll-off duplicate rule, the decree draft (first-pick-wins and the
timeout), and the layout contract above. `rng.spec.js` runs entirely in node:
seeded determinism, UTC day rollover, and proof that seeding doesn't smuggle a
decree past the survivability gates.

## Deploying

GitHub Pages, served from the repository root. `.nojekyll` is present so
directories are served verbatim.
