// Host-authoritative game engine. Runs ONLY in the host's browser: it owns the
// decrees, validates every word and purchase, keeps every life, combo and
// score, and runs the hunger clock. Guests only send intents (protocol.js IN.*)
// and mirror the host's broadcasts (EV.*).
//
// The revive rescue word never appears in any broadcast until that rescue ends
// - only color strings go over the wire.

import {
  MAX_PLAYERS, MIN_PLAYERS, MAX_ROWS, WORD_LEN,
  SHOP, DEFAULT_SETTINGS, PLAYER_COLORS, LEAVE_GRACE_MS, TOWER,
} from './config.js';
import { EV, IN } from './protocol.js';
import { pickWord, scoreGuess, isValidGuess } from './words.js';
import { matchesConstraint, genConstraint, wordPoints } from './decree.js';
import { deobf, now } from './util.js';

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
    this.usedWords = new Set();  // revive secrets, so a session never repeats one
    this.tower = null;
    this.missingSince = new Map();
    this.everSeen = new Set();   // peers confirmed via presence at least once
    this.timers = {};

    this.addPlayer(host.id, host.name);

    net.on(IN.JOIN, (d, from) => this.onJoin(d, from));
    net.on(IN.GUESS, (d, from) => this.onTowerGuess(d, from));
    net.on(IN.BUY, (d, from) => this.onBuy(d, from));
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
    if (!DIFFICULTIES.includes(this.settings.difficulty)) this.settings.difficulty = 'ramp';
    this.broadcastLobby();
  }

  broadcastLobby() {
    this.net.emit(EV.LOBBY, {
      hostId: this.hostId,
      started: this.started,
      settings: this.settings,
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
      revives: {},              // reviverPid -> {target, word, rows:[{word,colors}]}
      // host-set 3/5/10 in the lobby (UI-clamped, not server-enforced - tests
      // intentionally pass values outside that range to freeze a stage).
      rampWords: this.settings.rampWords ?? TOWER.defaultRampWords,
      hungerMs: this.settings.hungerMs ?? TOWER.hungerMs,
      difficulty: DIFFICULTIES.includes(this.settings.difficulty) ? this.settings.difficulty : 'ramp',
      constraint: null,
    };
    this.tower.constraint = genConstraint(1, this.tower.used, this.tower.difficulty, this.tower.rampWords);
    this.broadcastTower();
    this.armHunger();
  }

  broadcastTower() {
    const t = this.tower;
    this.net.emit(EV.TOWER, {
      stage: t.stage, constraint: t.constraint, height: t.height,
      hungerMs: t.hungerMs, lives: { ...t.lives }, scores: this.scoreMap(),
      combo: t.combo,
    });
  }

  armHunger() {
    clearTimeout(this.timers.hunger);
    if (!this.tower || this.over) return;
    this.timers.hunger = setTimeout(() => this.hungerStrike(), this.tower.hungerMs);
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
    this.net.emit(EV.TOWER_HUNGER, { lives: { ...t.lives }, downed });
    if (this.everyoneDowned()) this.endTower();
    else this.armHunger();
  }

  everyoneDowned() {
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
  // egg). Revives anyone currently downed - "everyone gets a heart" is
  // literal, including whoever's at zero.
  grantHearts(reason) {
    const t = this.tower;
    for (const p of this.activePlayers()) {
      const cur = t.lives[p.id] ?? 0;
      t.lives[p.id] = Math.min(TOWER.maxLives, cur + 1);
    }
    this.net.emit(EV.TOWER_BONUS, { reason, lives: { ...t.lives }, height: t.height });
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

  // A revive is meant to be an untimed puzzle: the shared hunger clock pauses
  // while ANY revive is in flight, and only resumes (with a fresh full window)
  // once none remain. Other players may keep climbing while paused - only the
  // clock itself stops.
  pauseHungerForRevive() {
    const t = this.tower;
    if (t.hungerPaused) return;
    t.hungerPaused = true;
    clearTimeout(this.timers.hunger);
  }

  resumeHungerIfIdle() {
    const t = this.tower;
    if (!t.hungerPaused || Object.keys(t.revives).length > 0) return false;
    t.hungerPaused = false;
    this.armHunger();
    return true;
  }

  onTowerGuess(d, from) {
    const t = this.tower;
    if (!t || this.over) return;
    const p = this.player(from);
    if (!p || !p.connected) return;
    const word = this.unwrapWord(d.x);

    // A player mid-revive is playing their rescue wordle, not the tower.
    if (t.revives[from]) return this.onReviveGuess(word, from);

    if ((t.lives[from] ?? 0) <= 0) return; // downed players watch

    if (!isValidGuess(word)) return this.towerMiss(from, word, 'not a word');
    if (this.towerOnScreen(word)) return this.towerMiss(from, word, 'already in the tower');
    if (!matchesConstraint(word, t.constraint)) return this.towerMiss(from, word, 'breaks the decree');

    // accepted: the tower grows
    t.used.add(word);
    t.height += 1;
    t.combo += 1;
    t.wordsInStage += 1;
    const points = wordPoints(word, t.stage, t.combo);
    p.score += points;
    t.rows.push({ pid: from, word, points });
    if (t.rows.length > 60) t.rows.shift();
    this.net.emit(EV.TOWER_WORD, {
      pid: from, word, points, height: t.height, combo: t.combo, stage: t.stage,
    });
    // While a revive is in flight the clock stays paused regardless of what
    // OTHER (non-reviving) players do - only the last revive ending re-arms it.
    if (!t.hungerPaused) this.armHunger();

    if (Math.floor(t.height / TOWER.heartEveryHeight) > Math.floor((t.height - 1) / TOWER.heartEveryHeight)) {
      this.grantHearts('milestone');
    }
    if (this.checkTowerSpelled()) {
      this.grantHearts('spelled');
    }

    if (t.wordsInStage >= t.rampWords) {
      t.stage += 1;
      t.wordsInStage = 0;
      // pass the outgoing decree so the new one is never an identical repeat
      t.constraint = genConstraint(t.stage, t.used, t.difficulty, t.rampWords, t.constraint);
      this.broadcastTower();
    }
  }

  towerMiss(from, word, reason) {
    const t = this.tower;
    t.lives[from] = Math.max(0, (t.lives[from] ?? 0) - 1);
    t.combo = 0;
    this.net.emit(EV.TOWER_MISS, {
      pid: from, word, reason, lives: { ...t.lives }, combo: 0,
    });
    if (this.everyoneDowned()) this.endTower();
  }

  onReviveBuy(d, from, fail) {
    const t = this.tower;
    const p = this.player(from);
    if (!t) return fail('No tower to climb');
    if ((t.lives[from] ?? 0) <= 0) return fail('You are down yourself');
    if (t.revives[from]) return fail('Already reviving');
    const target = this.player(d.target);
    if (!target || (t.lives[target.id] ?? 0) > 0 || !target.connected) return fail('Pick a fallen teammate');
    if (p.score < SHOP.revive.price) return fail(`Need ${SHOP.revive.price} points`);
    p.score -= SHOP.revive.price;
    const word = pickWord(this.usedWords, 'easy'); // rescues are merciful
    this.usedWords.add(word);
    t.revives[from] = { target: target.id, word, rows: [] };
    this.pauseHungerForRevive();
    this.net.emit(EV.SCORES, { scores: this.scoreMap(), buyer: from, item: 'revive' });
    this.net.emit(EV.TOWER_REVIVE, { phase: 'start', reviver: from, target: target.id, paused: true });
  }

  onReviveGuess(word, from) {
    const t = this.tower;
    const rev = t.revives[from];
    if (!rev) return;
    if (!isValidGuess(word)) {
      this.net.emit(EV.BAD_GUESS, { to: from, reason: 'invalid' });
      return;
    }
    const colors = scoreGuess(word, rev.word);
    const solved = word === rev.word;
    rev.rows.push({ word, colors });
    // co-op spectacle: everyone watches the rescue, letters included
    this.net.emit(EV.TOWER_REVIVE, {
      phase: 'row', reviver: from, target: rev.target,
      row: rev.rows.length - 1, word, colors,
    });
    if (solved || rev.rows.length >= MAX_ROWS) {
      delete t.revives[from];
      if (solved) t.lives[rev.target] = TOWER.reviveLives;
      const resumed = this.resumeHungerIfIdle();
      this.net.emit(EV.TOWER_REVIVE, {
        phase: 'end', reviver: from, target: rev.target, ok: solved,
        lives: { ...t.lives }, secret: rev.word, resumed, hungerMs: t.hungerMs,
      });
    }
  }

  endTower() {
    const t = this.tower;
    if (!t || this.over) return;
    this.over = true;
    this.clearTimers();
    const standings = [...this.players].sort((a, b) => b.score - a.score);
    this.net.emit(EV.GAME_OVER, {
      reason: 'the tower fell',
      winner: standings[0] ? standings[0].id : null,
      height: t.height,
      stage: t.stage,
      standings: standings.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, alive: p.alive })),
    });
  }

  playAgain() {
    if (!this.over) return;
    this.started = false;
    this.over = false;
    this.tower = null;
    this.usedWords = new Set(this.usedWords); // used words persist across a session
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
    if (d.item !== 'revive') return fail('The tower sells only revival');
    return this.onReviveBuy(d, from, fail);
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

    // A leaver's revive fizzles (points stay spent, teammate stays down) - the
    // hunger clock resumes if that was the last active revive. The run ends if
    // only downed players remain.
    if (this.tower) {
      const rev = this.tower.revives[pid];
      if (rev) {
        delete this.tower.revives[pid];
        const resumed = this.resumeHungerIfIdle();
        this.net.emit(EV.TOWER_REVIVE, {
          phase: 'end', reviver: pid, target: rev.target, ok: false, secret: rev.word,
          lives: { ...this.tower.lives }, resumed, hungerMs: this.tower.hungerMs, reason: 'left',
        });
      }
      if (this.activePlayers().length === 0 || this.everyoneDowned()) { this.endTower(); return; }
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
        hungerPaused: !!this.tower.hungerPaused,
        rows: this.tower.rows.slice(-40),
        reviving: Object.entries(this.tower.revives).map(([rev, s]) => ({
          reviver: rev, target: s.target,
          rows: s.rows.map((x) => ({ word: x.word, colors: x.colors })),
        })),
      } : null,
    };
    this.net.emit(EV.RESYNC, { to: pid, snapshot });
  }

  clearTimers() {
    for (const k of ['next', 'hunger']) {
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
  _debugSetScore(pid, score) {
    const p = this.player(pid);
    if (p) p.score = score;
    this.net.emit(EV.SCORES, { scores: this.scoreMap() });
  }
}
