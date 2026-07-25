// Mirror: the client-side state EVERY peer renders from (host included - the
// host's own UI listens to its engine's broadcasts through the same path).
// Handles every host broadcast in protocol.js EV.* - asserted at startup so a
// new host event can never be silently ignored by guests (the classic bug).

import { WORD_LEN } from './config.js';
import { EV, IN, HOST_BROADCASTS } from './protocol.js';
import { isValidGuess } from './words.js';
import { obf, now } from './util.js';

export class Mirror {
  constructor(net, code, selfId) {
    this.net = net;
    this.code = code;
    this.selfId = selfId;
    this.listeners = [];

    // lobby/global
    this.hostId = null;
    this.players = [];
    this.settings = null;
    this.started = false;
    this.over = false;
    this.joinError = null;
    this.roomDead = false;

    // run state
    this.tower = null;      // see onTower()
    this.input = '';        // letters typed in the active row
    this.pendingTower = 0;  // timestamp of an unanswered submit
    this.gameover = null;
    this.toast = null;

    const H = {
      [EV.LOBBY]: (d) => this.onLobby(d),
      [EV.JOIN_ERR]: (d) => { if (d.to === selfId) { this.joinError = d.reason; this.fire('joinerr', d); } },
      [EV.START]: (d) => this.onStart(d),
      [EV.BAD_GUESS]: (d) => this.onBadGuess(d),
      [EV.SCORES]: (d) => this.onScores(d),
      [EV.SHOP_ERR]: (d) => { if (d.to === selfId) { this.showToast(d.reason); this.fire('shoperr', d); } },
      [EV.TOWER]: (d) => this.onTower(d),
      [EV.TOWER_WORD]: (d) => this.onTowerWord(d),
      [EV.TOWER_MISS]: (d) => this.onTowerMiss(d),
      [EV.TOWER_HUNGER]: (d) => this.onTowerHunger(d),
      [EV.TOWER_REVIVE]: (d) => this.onTowerRevive(d),
      [EV.TOWER_BONUS]: (d) => this.onTowerBonus(d),
      [EV.PLAYER_LEFT]: (d) => this.onPlayerLeft(d),
      [EV.GAME_OVER]: (d) => this.onGameOver(d),
      [EV.ROOM_DEAD]: () => { this.roomDead = true; this.fire('roomdead', {}); },
      [EV.RESYNC]: (d) => { if (d.to === selfId) this.applySnapshot(d.snapshot); },
    };

    // TRAP GUARD: every host broadcast type must be wired here.
    for (const t of HOST_BROADCASTS) {
      if (!H[t]) throw new Error(`Mirror is missing a handler for host event '${t}'`);
      net.on(t, H[t]);
    }
  }

  // ---------- pub/sub ----------
  onChange(fn) { this.listeners.push(fn); }
  fire(type, d = {}) { for (const fn of this.listeners) fn(type, d); }
  showToast(msg) { this.toast = msg; this.fire('toast', { msg }); }

  me() { return this.players.find((p) => p.id === this.selfId); }
  player(id) { return this.players.find((p) => p.id === id); }
  isHost() { return this.hostId === this.selfId; }

  // ---------- handlers ----------
  onLobby(d) {
    this.hostId = d.hostId;
    this.players = d.players;
    this.settings = d.settings;
    this.started = d.started;
    if (!d.started) {
      this.over = false; this.gameover = null; this.tower = null;
    }
    this.fire('lobby', d);
  }

  onStart(d) {
    this.settings = d.settings;
    for (const sp of d.players) {
      const p = this.player(sp.id);
      if (p) Object.assign(p, sp);
    }
    this.started = true;
    this.over = false;
    this.gameover = null;
    this.tower = null;
    this.pendingTower = 0;
    this.input = '';
    this.fire('start', d);
  }

  onBadGuess(d) {
    if (d.to !== this.selfId) return;
    this.pendingTower = 0;
    this.showToast('Not in the dictionary');
    this.fire('badguess', d);
  }

  onScores(d) { this.applyScores(d.scores); this.fire('scores', d); }

  applyScores(scores) {
    for (const [pid, s] of Object.entries(scores || {})) {
      const p = this.player(pid);
      if (p) p.score = s;
    }
  }

  onTower(d) {
    const t = this.tower || (this.tower = { rows: [], revives: {} });
    const hadStage = t.stage;
    t.stage = d.stage;
    t.constraint = d.constraint;
    t.height = d.height;
    t.combo = d.combo;
    t.hungerMs = d.hungerMs;
    t.lives = d.lives;
    // a stage-change broadcast can land mid-revive (another player kept
    // climbing while paused) - don't resurrect a countdown that should stay frozen
    if (!t.hungerPaused) t.hungerAt = now() + d.hungerMs;
    this.applyScores(d.scores);
    this.fire('tower', { ...d, fresh: hadStage == null });
  }

  onTowerWord(d) {
    const t = this.tower;
    if (!t) return;
    t.rows.push({ pid: d.pid, word: d.word, points: d.points });
    if (t.rows.length > 60) t.rows.shift();
    t.height = d.height;
    t.combo = d.combo;
    t.stage = d.stage;
    if (!t.hungerPaused) t.hungerAt = now() + t.hungerMs;
    const p = this.player(d.pid);
    if (p) p.score += d.points; // lean protocol: deltas, not snapshots
    if (d.pid === this.selfId) this.pendingTower = 0;
    this.fire('towerword', d);
  }

  onTowerMiss(d) {
    const t = this.tower;
    if (!t) return;
    t.lives = d.lives;
    t.combo = 0;
    if (d.pid === this.selfId) {
      this.pendingTower = 0;
      this.showToast(`"${d.word.toUpperCase()}" — ${d.reason}`);
    }
    this.fire('towermiss', d);
  }

  onTowerHunger(d) {
    const t = this.tower;
    if (!t) return;
    t.lives = d.lives;
    t.combo = 0;
    t.hungerAt = now() + t.hungerMs;
    this.showToast('THE TOWER HUNGERS — everyone bleeds');
    this.fire('towerhunger', d);
  }

  onTowerRevive(d) {
    const t = this.tower;
    if (!t) return;
    if (d.phase === 'start') {
      t.revives[d.reviver] = { target: d.target, rows: [] };
      if (d.paused) { t.hungerPaused = true; t.hungerAt = null; }
      if (d.reviver === this.selfId) { this.input = ''; this.pendingTower = 0; }
    } else if (d.phase === 'row') {
      const rev = t.revives[d.reviver];
      if (rev) rev.rows[d.row] = { word: d.word, colors: d.colors };
      if (d.reviver === this.selfId) { this.input = ''; this.pendingTower = 0; }
    } else if (d.phase === 'end') {
      delete t.revives[d.reviver];
      if (d.lives) t.lives = d.lives;
      if (d.resumed) { t.hungerPaused = false; t.hungerAt = now() + t.hungerMs; }
      if (d.reviver === this.selfId) this.pendingTower = 0;
    }
    this.fire('towerrev', d);
  }

  onTowerBonus(d) {
    const t = this.tower;
    if (t) t.lives = d.lives;
    this.fire('towerbonus', d);
  }

  myRevive() {
    return (this.tower && this.tower.revives[this.selfId]) || null;
  }

  myTowerLives() {
    return this.tower ? (this.tower.lives[this.selfId] ?? 0) : 0;
  }

  submitTower() {
    const word = this.input;
    if (word.length !== WORD_LEN) { this.fire('shake', {}); return false; }
    if (this.myRevive()) {
      // the rescue wordle is classic rules - typos are free here
      if (!isValidGuess(word)) { this.showToast('Not in dictionary'); this.fire('shake', {}); return false; }
    }
    // tower words are NOT pre-checked: the host judges, misses cost a life
    this.pendingTower = now();
    this.input = '';
    this.net.emit(IN.GUESS, { x: obf(word, this.code) });
    this.fire('submit', { tower: true, word });
    return true;
  }

  onPlayerLeft(d) {
    const p = this.player(d.pid);
    if (p) p.connected = false;
    this.fire('left', d);
  }

  onGameOver(d) {
    this.over = true;
    this.gameover = d;
    this.fire('gameover', d);
  }

  applySnapshot(s) {
    this.hostId = s.hostId;
    this.settings = s.settings;
    this.started = s.started;
    this.over = s.over;
    this.players = s.players;
    this.input = '';
    this.pendingTower = 0;
    if (s.tower) {
      const hungerPaused = !!s.tower.hungerPaused;
      this.tower = {
        stage: s.tower.stage, constraint: s.tower.constraint,
        height: s.tower.height, combo: s.tower.combo,
        hungerMs: s.tower.hungerMs, lives: { ...s.tower.lives },
        hungerPaused,
        hungerAt: hungerPaused ? null : now() + s.tower.hungerMs,
        rows: s.tower.rows.map((r) => ({ ...r })),
        revives: Object.fromEntries((s.tower.reviving || []).map((r) => [
          r.reviver, { target: r.target, rows: r.rows.map((x) => ({ ...x })) },
        ])),
      };
    } else {
      this.tower = null;
    }
    this.fire('resync', s);
  }

  // ---------- keyboard state (the rescue wordle only) ----------
  keyboardState() {
    const rank = { g: 3, y: 2, x: 1 };
    const best = {};
    const rev = this.myRevive();
    if (!rev) return best;
    for (const row of rev.rows) {
      if (!row || !row.word) continue;
      for (let j = 0; j < row.word.length; j++) {
        const L = row.word[j];
        const c = row.colors[j];
        if ((rank[c] || 0) > (rank[best[L]] || 0)) best[L] = c;
      }
    }
    return best;
  }

  inputLocked() {
    if (!this.started || this.over || !this.tower) return true;
    if (this.myRevive()) return false;          // typing the rescue wordle
    if (this.myTowerLives() <= 0) return true;  // downed players watch
    return this.pendingTower > 0 && now() - this.pendingTower < 1500;
  }

  // ---------- intents ----------
  type(letter) {
    if (this.inputLocked() || this.input.length >= WORD_LEN) return false;
    this.input += letter.toLowerCase();
    this.fire('type', { letter });
    return true;
  }

  backspace() {
    if (this.inputLocked() || this.input.length === 0) return false;
    this.input = this.input.slice(0, -1);
    this.fire('type', { back: true });
    return true;
  }

  enter() {
    if (this.inputLocked()) return false;
    return this.submitTower();
  }

  buy(item, target) {
    this.net.emit(IN.BUY, { item, target });
  }

  join(name) {
    this.net.emit(IN.JOIN, { name });
  }

  quit() {
    this.net.emit(IN.QUIT, {});
  }
}
