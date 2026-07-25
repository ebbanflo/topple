// Host-authoritative game engine. Runs ONLY in the host's browser: it owns the
// decrees, validates every word and purchase, keeps every life, combo and
// score, and runs the hunger clock. Guests only send intents (protocol.js IN.*)
// and mirror the host's broadcasts (EV.*).

import {
  MAX_PLAYERS, MIN_PLAYERS, WORD_LEN, DECREE_OPTIONS, MODE_CHOICES, DAILY_SETTINGS,
  SHOP, DEFAULT_SETTINGS, PLAYER_COLORS, LEAVE_GRACE_MS, TOWER, ASCENT, storeyQuota,
} from './config.js';
import { EV, IN } from './protocol.js';
import { isValidGuess } from './words.js';
import { matchesConstraint, genConstraint, describeConstraint, wordPoints, scoreWord } from './decree.js';
import { deobf, now } from './util.js';
import { mulberry32, hashSeed, dailyKey, dailyNumber } from './rng.js';
import {
  RELICS, MAX_RELICS, REROLL_COST, dealRelics, grants, hungerFor,
} from './relics.js';

const DIFFICULTIES = ['easy', 'medium', 'hard', 'ramp'];

export class Engine {
  constructor(net, code, host) {
    this.net = net;
    this.code = code;
    this.hostId = host.id;
    this.players = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.started = false;
    this.over = false;
    this.tower = null;
    this.missingSince = new Map();
    this.everSeen = new Set();   // peers confirmed via presence at least once
    this.timers = {};

    this.addPlayer(host.id, host.name);

    net.on(IN.JOIN, (d, from) => this.onJoin(d, from));
    net.on(IN.GUESS, (d, from) => this.onTowerGuess(d, from));
    net.on(IN.BUY, (d, from) => this.onBuy(d, from));
    net.on(IN.DECREE_PICK, (d, from) => this.onDecreePick(d, from));
    net.on(IN.READY, (_d, from) => this.onReady(from));
    net.on(IN.RELIC_PICK, (d, from) => this.onRelicPick(d, from));
    net.on(IN.REROLL, (_d, from) => this.onReroll(from));
    net.on(IN.QUIT, (_d, from) => this.onLeave(from, 'quit'));
    net.on(IN.RESYNC, (_d, from) => this.sendResync(from));

    net.transport.onPresence((present) => this.onPresence(present));
    // A live intent from a "disconnected" player proves they're back (their
    // socket blipped, presence lagged, phone woke up) - reinstate + resync.
    net.onAny((env) => {
      if (!env || env.t === IN.QUIT) return;
      const p = this.player(env.from);
      if (p && !p.connected && this.started && !this.over) {
        p.connected = true;
        this.missingSince.delete(p.id);
        this.broadcastLobby(); // roster refresh; guests keep their game screens
        this.sendResync(p.id);
      }
    });
    this._sweep = setInterval(() => this.sweepMissing(), 1000);
  }

  // ---------- lobby ----------
  addPlayer(id, name) {
    const p = {
      id,
      name: String(name || 'PLAYER').slice(0, 12).toUpperCase() || 'PLAYER',
      color: PLAYER_COLORS[this.players.length % PLAYER_COLORS.length],
      score: 0,
      alive: true,
      connected: true,
      spectator: false,
    };
    this.players.push(p);
    return p;
  }

  player(id) { return this.players.find((p) => p.id === id); }

  onJoin(d, from) {
    const existing = this.player(from);
    if (existing) {
      // Rejoin after a reload/drop: reinstate and resync.
      existing.connected = true;
      this.missingSince.delete(from);
      this.broadcastLobby();
      if (this.started) this.sendResync(from);
      return;
    }
    if (this.started) {
      this.net.emit(EV.JOIN_ERR, { to: from, reason: 'Game already started' });
      return;
    }
    if (this.players.length >= MAX_PLAYERS) {
      this.net.emit(EV.JOIN_ERR, { to: from, reason: 'Room is full (4 players max)' });
      return;
    }
    this.addPlayer(from, d.name);
    this.broadcastLobby();
  }

  setSettings(patch) {
    if (this.started) return;
    Object.assign(this.settings, patch);
    if (!MODE_CHOICES.includes(this.settings.mode)) this.settings.mode = 'classic';
    // A shared daily is only comparable if everyone plays the same knobs, so
    // DAILY overrides them rather than trusting each host to match.
    if (this.settings.mode === 'daily') Object.assign(this.settings, DAILY_SETTINGS);
    if (!DIFFICULTIES.includes(this.settings.difficulty)) this.settings.difficulty = 'ramp';
    this.broadcastLobby();
  }

  // Non-null only in DAILY. Guests render the run number from this; the host is
  // the only peer that actually generates decrees, so the seed itself never
  // needs to cross the wire.
  daily() {
    if (this.settings.mode !== 'daily') return null;
    return { key: dailyKey(), n: dailyNumber() };
  }

  broadcastLobby() {
    this.net.emit(EV.LOBBY, {
      hostId: this.hostId,
      started: this.started,
      settings: this.settings,
      daily: this.daily(),
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, score: p.score,
        alive: p.alive, connected: p.connected, spectator: p.spectator,
      })),
    });
  }

  minPlayers() { return MIN_PLAYERS; }

  start() {
    if (this.started || this.players.filter((p) => p.connected).length < this.minPlayers()) return;
    this.players = this.players.filter((p) => p.connected);
    this.players.forEach((p, i) => {
      p.color = PLAYER_COLORS[i % PLAYER_COLORS.length];
      p.score = 0;
      p.alive = true;
      p.spectator = false;
    });
    this.started = true;
    this.over = false;
    this.net.emit(EV.START, {
      settings: this.settings,
      daily: this.daily(),
      players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score })),
    });
    this.timers.next = setTimeout(() => this.initTower(), this.settings.countdownMs ?? 1200);
  }

  activePlayers() {
    return this.players.filter((p) => p.alive && p.connected && !p.spectator);
  }

  scoreMap() {
    const m = {};
    for (const p of this.players) m[p.id] = p.score;
    return m;
  }

  // ---------- the tower ----------
  initTower() {
    if (this.over) return;
    this.tower = {
      stage: 1,
      wordsInStage: 0,
      height: 0,
      combo: 0,
      rows: [],                 // {pid, word, points}
      used: new Set(),
      lives: Object.fromEntries(this.activePlayers().map((p) => [p.id, TOWER.lives])),
      // pid -> {cleared, words:[]} for every player currently at zero lives.
      // Kept in lockstep with `lives` by syncBuried() so the two can never drift.
      buried: {},
      // host-set 3/5/10 in the lobby (UI-clamped, not server-enforced - tests
      // intentionally pass values outside that range to freeze a stage).
      rampWords: this.settings.rampWords ?? TOWER.defaultRampWords,
      hungerMs: this.settings.hungerMs ?? TOWER.hungerMs,
      difficulty: DIFFICULTIES.includes(this.settings.difficulty) ? this.settings.difficulty : 'ramp',
      constraint: null,
      offer: null,              // a decree draft in flight, if any
      // CLASSIC deals from Math.random; DAILY deals from the date, so every
      // room in the world walks the same decrees today.
      rng: this.settings.mode === 'daily'
        ? mulberry32(hashSeed(dailyKey()))
        : Math.random,
      // ASCENT only: the run's storey structure. null in CLASSIC/DAILY, which
      // stay endless, so every branch below is a single `t.run &&` away.
      run: this.settings.mode === 'ascent'
        ? {
          storey: 1, quota: storeyQuota(1), storeyScore: 0, mortar: 0, phase: 'climb',
          relics: Object.fromEntries(this.activePlayers().map((p) => [p.id, []])),
          offers: {},
          placed: new Set(),     // who has landed a word this storey (CHORUS)
          freeMiss: {},          // who has spent their SCAFFOLD this storey
          insured: false,        // INSURANCE fires once per run
        }
        : null,
      lastWordAt: 0,
    };
    this.tower.constraint = genConstraint(
      1, this.tower.used, this.tower.difficulty, this.tower.rampWords, null, this.tower.rng);
    this.broadcastTower();
    this.armHunger();
  }

  broadcastTower(extra = {}) {
    const t = this.tower;
    this.net.emit(EV.TOWER, {
      stage: t.stage, constraint: t.constraint, height: t.height,
      hungerMs: t.hungerMs, lives: { ...t.lives }, scores: this.scoreMap(),
      combo: t.combo, digNeed: TOWER.digWords, run: this.runInfo(), ...extra,
    });
  }

  runInfo() {
    const r = this.tower && this.tower.run;
    return r ? {
      storey: r.storey, quota: r.quota, storeyScore: r.storeyScore,
      mortar: r.mortar, phase: r.phase, storeys: ASCENT.storeys,
      relics: Object.fromEntries(Object.entries(r.relics).map(([k, v]) => [k, [...v]])),
    } : null;
  }

  // ---------- ASCENT: storeys ----------
  // A storey ends when its quota is met, never on a separate timer. The hunger
  // clock is already the pressure; a second failure clock would just punish the
  // same mistake twice.
  completeStorey() {
    const t = this.tower;
    const r = t.run;
    r.phase = 'intermission';
    clearTimeout(this.timers.hunger);
    clearTimeout(this.timers.draft);
    t.offer = null;

    // clearing a storey buys everyone a breath: a heart back, and anyone
    // buried is lifted out by it
    for (const p of this.activePlayers()) {
      t.lives[p.id] = Math.min(TOWER.maxLives, (t.lives[p.id] ?? 0) + ASCENT.clearLives);
    }
    this.syncBuried();

    // overshooting the quota pays, and so does finishing with hearts in hand
    const over = Math.max(0, r.storeyScore - r.quota);
    const lives = this.activePlayers().reduce((n, p) => n + (t.lives[p.id] ?? 0), 0);
    const earned = ASCENT.mortarBase + Math.floor((over / r.quota) * 4) + lives;
    r.mortar += earned;

    // deal each player their own three; the mortar to buy them is shared, so
    // the team has to decide whose build is worth funding
    r.offers = {};
    for (const p of this.activePlayers()) {
      r.offers[p.id] = dealRelics(r.relics[p.id] || [], 3, t.rng);
    }

    const last = r.storey >= ASCENT.storeys;
    this.net.emit(EV.INTERMISSION, {
      storey: r.storey, quota: r.quota, storeyScore: r.storeyScore,
      mortar: r.mortar, earned, lives: { ...t.lives }, last,
      offers: { ...r.offers }, relics: this.runInfo().relics,
    });
    if (last) this.timers.next = setTimeout(() => this.crown(), 1200);
  }

  onReady(from) {
    const t = this.tower;
    if (!t || !t.run || t.run.phase !== 'intermission' || this.over) return;
    if (from !== this.hostId) return; // the host calls time on the intermission
    this.nextStorey();
  }

  nextStorey() {
    const t = this.tower;
    const r = t.run;
    r.storey += 1;
    r.quota = storeyQuota(r.storey);
    r.storeyScore = 0;
    r.phase = 'climb';
    r.placed = new Set();
    r.freeMiss = {};
    r.offers = {};
    t.constraint = genConstraint(
      t.stage, t.used, t.difficulty, t.rampWords, t.constraint, t.rng);
    this.broadcastTower({ storeyStart: r.storey });
    this.armHunger();
  }

  broadcastRelics(extra = {}) {
    const r = this.tower.run;
    this.net.emit(EV.RELICS, {
      relics: this.runInfo().relics, mortar: r.mortar, offers: { ...r.offers }, ...extra,
    });
  }

  onRelicPick(d, from) {
    const t = this.tower;
    const r = t && t.run;
    const fail = (reason) => this.net.emit(EV.SHOP_ERR, { to: from, reason });
    if (!r || r.phase !== 'intermission' || this.over) return;
    const offer = r.offers[from] || [];
    const id = String(d.id || '');
    if (!offer.includes(id)) return fail('Not on offer');
    const relic = RELICS[id];
    const own = r.relics[from] || (r.relics[from] = []);
    if (own.includes(id)) return fail('Already held');
    if (own.length >= MAX_RELICS) return fail(`Only ${MAX_RELICS} relics fit`);
    if (r.mortar < relic.price) return fail(`Need ${relic.price} mortar`);
    r.mortar -= relic.price;
    own.push(id);
    r.offers[from] = offer.filter((x) => x !== id);
    this.broadcastRelics({ bought: id, by: from });
  }

  onReroll(from) {
    const t = this.tower;
    const r = t && t.run;
    const fail = (reason) => this.net.emit(EV.SHOP_ERR, { to: from, reason });
    if (!r || r.phase !== 'intermission' || this.over) return;
    if (r.mortar < REROLL_COST) return fail(`Need ${REROLL_COST} mortar`);
    r.mortar -= REROLL_COST;
    r.offers[from] = dealRelics(r.relics[from] || [], 3, t.rng);
    this.broadcastRelics({ rerolled: from });
  }

  // The only win in the game.
  crown() {
    if (this.over) return;
    this.over = true;
    this.clearTimers();
    const t = this.tower;
    const standings = [...this.players].sort((a, b) => b.score - a.score);
    this.net.emit(EV.GAME_OVER, {
      reason: 'the tower stands',
      won: true,
      winner: standings[0] ? standings[0].id : null,
      height: t.height, stage: t.stage, storey: t.run.storey,
      standings: standings.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, alive: p.alive })),
    });
  }

  // ---------- the decree draft ----------
  // A stage change deals the team DECREE_OPTIONS decrees instead of imposing
  // one. The OLD decree stays live until somebody picks, so the draft costs the
  // tower no time at all - and the hunger clock keeps running, so dithering
  // costs blood.
  offerDecrees() {
    const t = this.tower;
    const options = [];
    const seen = new Set([describeConstraint(t.constraint)]);
    for (let tries = 0; tries < 30 && options.length < DECREE_OPTIONS; tries++) {
      const c = genConstraint(t.stage, t.used, t.difficulty, t.rampWords, t.constraint, t.rng);
      const desc = describeConstraint(c);
      if (seen.has(desc)) continue; // three identical choices is not a choice
      seen.add(desc);
      options.push(c);
    }
    if (options.length === 0) { // pool exhausted this deep: just move on
      t.constraint = genConstraint(t.stage, t.used, t.difficulty, t.rampWords, t.constraint, t.rng);
      this.broadcastTower();
      return;
    }
    t.offer = { options };
    const ms = this.settings.draftMs ?? DEFAULT_SETTINGS.draftMs;
    this.net.emit(EV.DECREE_OFFER, { stage: t.stage, options, ms });
    clearTimeout(this.timers.draft);
    this.timers.draft = setTimeout(() => this.resolveDraft(0, null), ms);
  }

  onDecreePick(d, from) {
    const t = this.tower;
    if (!t || !t.offer || this.over) return;
    const i = Number(d.index);
    if (!Number.isInteger(i) || i < 0 || i >= t.offer.options.length) return;
    this.resolveDraft(i, from);
  }

  // First pick received wins. A late second pick finds no offer and is ignored,
  // so two players tapping at once can never both count.
  resolveDraft(index, by) {
    const t = this.tower;
    if (!t || !t.offer) return;
    clearTimeout(this.timers.draft);
    const chosen = t.offer.options[index] || t.offer.options[0];
    t.offer = null;
    t.constraint = chosen;
    this.broadcastTower({ pickedBy: by });
  }

  armHunger() {
    clearTimeout(this.timers.hunger);
    if (!this.tower || this.over) return;
    this.timers.hunger = setTimeout(() => this.hungerStrike(), this.effectiveHungerMs());
  }

  // The hunger clock is shared, so EVERY player's relics bend it.
  effectiveHungerMs() {
    const t = this.tower;
    if (!t) return TOWER.hungerMs;
    return t.run ? hungerFor(t.hungerMs, t.run.relics) : t.hungerMs;
  }

  // `lives` is the single source of truth; burial is derived from it. Call this
  // after ANY change to lives and the two can never disagree - which is what
  // makes bonus hearts, hunger strikes and digs all compose without special
  // cases (a heart that lifts someone off zero un-buries them for free).
  syncBuried() {
    const t = this.tower;
    const out = [];
    for (const p of this.activePlayers()) {
      const alive = (t.lives[p.id] ?? 0) > 0;
      if (!alive && !t.buried[p.id]) t.buried[p.id] = { cleared: 0, words: [] };
      else if (alive && t.buried[p.id]) { delete t.buried[p.id]; out.push(p.id); }
    }
    return out;
  }

  // The tower demands words: silence bleeds every living player.
  hungerStrike() {
    const t = this.tower;
    if (!t || this.over) return;
    const downed = [];
    for (const p of this.activePlayers()) {
      if (t.lives[p.id] > 0) {
        t.lives[p.id] -= 1;
        if (t.lives[p.id] === 0) downed.push(p.id);
      }
    }
    t.combo = 0;
    this.syncBuried();
    this.net.emit(EV.TOWER_HUNGER, { lives: { ...t.lives }, downed });
    if (this.everyoneBuried()) this.endTower();
    else this.armHunger();
  }

  // The run ends only when NOBODY is left standing to dig anyone out.
  everyoneBuried() {
    return this.activePlayers().every((p) => (this.tower.lives[p.id] ?? 0) <= 0);
  }

  // A word only counts as a duplicate while it's STILL visible in the tower
  // (the newest TOWER.visibleRows floors - what tower3d.js actually mounts).
  // Once a floor scrolls past that window it's forgotten, so an early word can
  // be played again later. t.used keeps every word ever placed, but only to
  // feed genConstraint's survivability check - it is NOT the duplicate gate.
  towerOnScreen(word) {
    const t = this.tower;
    if (!t) return false;
    const start = Math.max(0, t.rows.length - TOWER.visibleRows);
    for (let i = start; i < t.rows.length; i++) {
      if (t.rows[i].word === word) return true;
    }
    return false;
  }

  // Team-wide bonus heart (milestone every N floors, or the T-O-W-E-R easter
  // egg). Lifts anyone currently buried straight out - "everyone gets a heart"
  // is literal, including whoever is at zero.
  grantHearts(reason) {
    const t = this.tower;
    for (const p of this.activePlayers()) {
      const cur = t.lives[p.id] ?? 0;
      t.lives[p.id] = Math.min(TOWER.maxLives, cur + 1);
    }
    const freed = this.syncBuried(); // a heart lifts the buried straight out
    this.net.emit(EV.TOWER_BONUS, { reason, lives: { ...t.lives }, height: t.height, freed });
  }

  // Easter egg: if the most recently placed 5 words, read down any single
  // column, spell T-O-W-E-R, the tower itself blesses the climbers.
  checkTowerSpelled() {
    const t = this.tower;
    if (t.height < 5) return false;
    const window = t.rows.slice(-5);
    if (window.length < 5) return false;
    for (let col = 0; col < WORD_LEN; col++) {
      let s = '';
      for (const row of window) s += row.word[col];
      if (s === 'tower') return true;
    }
    return false;
  }

  onTowerGuess(d, from) {
    const t = this.tower;
    if (!t || this.over) return;
    const p = this.player(from);
    if (!p || !p.connected) return;
    if (t.run && t.run.phase !== 'climb') return; // the intermission is a real stop
    const word = this.unwrapWord(d.x);

    // Buried players are still playing - their words dig, they don't build.
    if ((t.lives[from] ?? 0) <= 0) return this.onDigGuess(word, from);

    const mine = t.run ? (t.run.relics[from] || []) : [];
    if (!isValidGuess(word)) return this.towerMiss(from, word, 'not a word');
    if (this.towerOnScreen(word) && !grants(mine, 'allowDuplicate')) {
      return this.towerMiss(from, word, 'already in the tower');
    }
    // BLOOD MORTAR builds the illegal word anyway and takes the life for it -
    // a miss that becomes a floor, which is the whole trade.
    let bled = false;
    if (!matchesConstraint(word, t.constraint)) {
      if (!grants(mine, 'forcePlace')) return this.towerMiss(from, word, 'breaks the decree');
      bled = true;
    }

    // accepted: the tower grows
    t.used.add(word);
    t.height += 1;
    t.combo += 1;
    t.wordsInStage += 1;
    const points = this.scoreFor(word, from);
    p.score += points;
    t.rows.push({ pid: from, word, points });
    if (t.rows.length > 60) t.rows.shift();
    if (t.run) { t.run.storeyScore += points; t.run.placed.add(from); }
    t.lastWordAt = now();
    this.net.emit(EV.TOWER_WORD, {
      pid: from, word, points, height: t.height, combo: t.combo, stage: t.stage,
      storeyScore: t.run ? t.run.storeyScore : undefined,
    });
    this.armHunger();
    if (bled) {
      t.lives[from] = Math.max(0, (t.lives[from] ?? 0) - 1);
      this.syncBuried();
      this.net.emit(EV.TOWER_MISS, {
        pid: from, word, reason: 'forced through in blood', lives: { ...t.lives },
        combo: t.combo, buried: (t.lives[from] ?? 0) <= 0, forced: true,
      });
      if (this.everyoneBuried()) { this.endTower(); return; }
    }

    if (Math.floor(t.height / TOWER.heartEveryHeight) > Math.floor((t.height - 1) / TOWER.heartEveryHeight)) {
      this.grantHearts('milestone');
    }
    if (this.checkTowerSpelled()) {
      this.grantHearts('spelled');
    }

    // A draft already in flight holds the stage where it is - the team can keep
    // climbing under the old decree while they decide.
    // Quota first: clearing a storey supersedes any decree change it collides
    // with, and the intermission would cancel a draft anyway.
    if (t.run && t.run.storeyScore >= t.run.quota) { this.completeStorey(); return; }

    if (t.wordsInStage >= t.rampWords && !t.offer) {
      t.stage += 1;
      t.wordsInStage = 0;
      this.offerDecrees();
    }
  }

  // Every point a word is worth, relics included. CLASSIC has no run, so it
  // takes the plain formula and cannot drift when a relic is added.
  scoreFor(word, pid) {
    const t = this.tower;
    if (!t.run) return wordPoints(word, t.stage, t.combo);
    const below = t.rows.length ? t.rows[t.rows.length - 1].word : null;
    return scoreWord(word, {
      relics: t.run.relics[pid] || [],
      stage: t.stage, combo: t.combo, height: t.height, storey: t.run.storey,
      sinceLastMs: t.lastWordAt ? now() - t.lastWordAt : null,
      placedCount: t.run.placed.size, livingCount: this.activePlayers().length,
      below,
    });
  }

  towerMiss(from, word, reason) {
    const t = this.tower;
    // SCAFFOLD eats the first miss of each storey, once per player
    if (t.run && grants(t.run.relics[from] || [], 'freeMiss') && !t.run.freeMiss[from]) {
      t.run.freeMiss[from] = true;
      t.combo = 0;
      this.net.emit(EV.TOWER_MISS, {
        pid: from, word, reason: `${reason} — SCAFFOLD held`, lives: { ...t.lives },
        combo: 0, spared: true,
      });
      return;
    }
    t.lives[from] = Math.max(0, (t.lives[from] ?? 0) - 1);
    t.combo = 0;
    this.syncBuried();
    this.net.emit(EV.TOWER_MISS, {
      pid: from, word, reason, lives: { ...t.lives }, combo: 0,
      buried: (t.lives[from] ?? 0) <= 0,
    });
    if (this.everyoneBuried()) this.endTower();
  }

  // A living teammate buys away one of a buried player's dig words. It costs
  // points rather than time, so helping never stalls the tower.
  onRopeBuy(d, from, fail) {
    const t = this.tower;
    const p = this.player(from);
    if (!t) return fail('No tower to climb');
    if ((t.lives[from] ?? 0) <= 0) return fail('You are buried yourself');
    const target = this.player(d.target);
    const dig = target && t.buried[target.id];
    if (!target || !dig || !target.connected) return fail('Pick a buried teammate');
    if (p.score < SHOP.rope.price) return fail(`Need ${SHOP.rope.price} points`);
    p.score -= SHOP.rope.price;
    this.net.emit(EV.SCORES, { scores: this.scoreMap(), buyer: from, item: 'rope' });
    this.clearDig(target.id, null, from);
  }

  // One dig word cleared, by the buried player's own typing or by a rope.
  clearDig(pid, word, by = null) {
    const t = this.tower;
    const dig = t.buried[pid];
    if (!dig) return;
    dig.cleared += 1;
    if (word) dig.words.push(word);
    if (dig.cleared < TOWER.digWords) {
      this.net.emit(EV.DIG, {
        phase: 'clear', pid, cleared: dig.cleared, need: TOWER.digWords, word, by,
      });
      return;
    }
    delete t.buried[pid];
    t.lives[pid] = TOWER.digReturnLives;
    this.net.emit(EV.DIG, {
      phase: 'out', pid, cleared: dig.cleared, need: TOWER.digWords, by,
      lives: { ...t.lives },
    });
  }

  // Buried input. Same verb as the rest of the game - a real word under the
  // live decree - but it moves rubble instead of stone: no score, no height,
  // no combo, and a failed attempt costs nothing (you are already at zero).
  onDigGuess(word, from) {
    const t = this.tower;
    const dig = t.buried[from];
    if (!dig) return;
    const bad = !isValidGuess(word) ? 'not a word'
      : dig.words.includes(word) ? 'already dug with that'
        : this.towerOnScreen(word) ? 'already in the tower'
          : !matchesConstraint(word, t.constraint) ? 'breaks the decree' : null;
    if (bad) {
      this.net.emit(EV.DIG, {
        phase: 'clear', pid: from, cleared: dig.cleared, need: TOWER.digWords,
        word, rejected: bad,
      });
      return;
    }
    this.clearDig(from, word);
  }

  endTower() {
    const t = this.tower;
    if (!t || this.over) return;
    // INSURANCE: the tower comes down, and then it doesn't. Once per run.
    if (t.run && !t.run.insured
        && Object.values(t.run.relics).some((ids) => grants(ids, 'insures'))) {
      t.run.insured = true;
      for (const p of this.activePlayers()) t.lives[p.id] = 1;
      this.syncBuried();
      t.rows = t.rows.slice(-1);
      t.height = Math.max(1, 1);
      t.combo = 0;
      this.broadcastTower({ insured: true });
      this.armHunger();
      return;
    }
    this.over = true;
    this.clearTimers();
    const standings = [...this.players].sort((a, b) => b.score - a.score);
    this.net.emit(EV.GAME_OVER, {
      reason: 'the tower fell',
      won: false,
      winner: standings[0] ? standings[0].id : null,
      height: t.height,
      stage: t.stage,
      storey: t.run ? t.run.storey : null,
      standings: standings.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, alive: p.alive })),
    });
  }

  playAgain() {
    if (!this.over) return;
    this.started = false;
    this.over = false;
    this.tower = null;
    for (const p of this.players) { p.score = 0; p.alive = true; p.spectator = false; }
    this.players = this.players.filter((p) => p.connected);
    this.broadcastLobby();
  }

  // ---------- shop (the tower sells only revival) ----------
  onBuy(d, from) {
    const item = SHOP[d.item];
    const p = this.player(from);
    const fail = (reason) => this.net.emit(EV.SHOP_ERR, { to: from, reason });
    if (!item || !p) return;
    if (d.item !== 'rope') return fail('The tower sells only rope');
    return this.onRopeBuy(d, from, fail);
  }

  // Guess words travel lightly obfuscated so rival guesses aren't casual
  // network-tab reading. Not cryptography.
  unwrapWord(x) {
    try { return deobf(x, this.code).toLowerCase(); } catch { return ''; }
  }

  // ---------- presence / leaving ----------
  onPresence(present) {
    for (const id of present) this.everSeen.add(id);
    for (const p of this.players) {
      if (p.id === this.hostId) continue;
      if (present.has(p.id)) {
        this.missingSince.delete(p.id);
        if (!p.connected && !this.started) { p.connected = true; this.broadcastLobby(); }
      } else if (p.connected && this.everSeen.has(p.id) && !this.missingSince.has(p.id)) {
        // Only players once CONFIRMED present can go missing - a joiner whose
        // broadcast outran their presence registration must not be kicked.
        this.missingSince.set(p.id, now());
      }
    }
  }

  sweepMissing() {
    for (const [pid, since] of this.missingSince) {
      if (now() - since > LEAVE_GRACE_MS) {
        this.missingSince.delete(pid);
        this.onLeave(pid, 'disconnected');
      }
    }
  }

  onLeave(pid, why) {
    const p = this.player(pid);
    if (!p || !p.connected) return;
    p.connected = false;

    if (!this.started) {
      this.players = this.players.filter((q) => q.id !== pid);
      this.broadcastLobby();
      return;
    }

    this.net.emit(EV.PLAYER_LEFT, { pid, why });

    // A leaver's half-finished dig goes with them. The run ends if nobody is
    // left standing.
    if (this.tower) {
      delete this.tower.buried[pid];
      if (this.activePlayers().length === 0 || this.everyoneBuried()) { this.endTower(); return; }
    }

    const remaining = this.players.filter((q) => q.connected);
    if (this.started && !this.over && remaining.length < this.minPlayers()) this.endTower();
  }

  // ---------- resync (the one deliberately fat message) ----------
  sendResync(pid) {
    const snapshot = {
      hostId: this.hostId,
      settings: this.settings,
      started: this.started,
      over: this.over,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, score: p.score,
        alive: p.alive, connected: p.connected, spectator: p.spectator,
      })),
      tower: this.tower ? {
        stage: this.tower.stage, constraint: this.tower.constraint,
        height: this.tower.height, combo: this.tower.combo,
        hungerMs: this.tower.hungerMs, lives: { ...this.tower.lives },
        rows: this.tower.rows.slice(-40),
        digNeed: TOWER.digWords,
        offer: this.tower.offer ? { options: this.tower.offer.options } : null,
        run: this.runInfo(),
        offers: this.tower.run ? { ...this.tower.run.offers } : null,
        buried: Object.fromEntries(Object.entries(this.tower.buried)
          .map(([pid, d]) => [pid, { cleared: d.cleared }])),
      } : null,
    };
    this.net.emit(EV.RESYNC, { to: pid, snapshot });
  }

  clearTimers() {
    for (const k of ['next', 'hunger', 'draft']) {
      clearTimeout(this.timers[k]);
      this.timers[k] = null;
    }
  }

  shutdown() {
    this.clearTimers();
    clearInterval(this._sweep);
    this.net.emit(EV.ROOM_DEAD, {});
  }

  // ---------- debug hooks (?debug=1 only; used by the E2E suite) ----------
  // Jump the run forward so the eighth storey can be tested without playing
  // the first seven. ?debug=1 only.
  _debugSetStorey(n) {
    const t = this.tower;
    if (!t || !t.run) return;
    t.run.storey = Math.max(1, Math.min(ASCENT.storeys, Number(n) || 1));
    t.run.quota = storeyQuota(t.run.storey);
    t.run.storeyScore = 0;
    t.run.phase = 'climb';
    this.broadcastTower();
    this.armHunger();
  }

  _debugSetScore(pid, score) {
    const p = this.player(pid);
    if (p) p.score = score;
    this.net.emit(EV.SCORES, { scores: this.scoreMap() });
  }
}
