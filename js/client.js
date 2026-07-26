// Mirror: the client-side state EVERY peer renders from (host included - the
// host's own UI listens to its engine's broadcasts through the same path).
// Handles every host broadcast in protocol.js EV.* - asserted at startup so a
// new host event can never be silently ignored by guests (the classic bug).

import { WORD_LEN } from './config.js';
import { EV, IN, HOST_BROADCASTS } from './protocol.js';
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
      [EV.SCORES]: (d) => this.onScores(d),
      [EV.SHOP_ERR]: (d) => {
        if (d.to !== selfId) return;
        // a refusal IS an answer: without this the sender stays input-locked
        // for the full pending window after, say, speaking out of turn
        this.pendingTower = 0;
        this.showToast(d.reason);
        this.fire('shoperr', d);
      },
      [EV.DECREE_OFFER]: (d) => this.onDecreeOffer(d),
      [EV.INTERMISSION]: (d) => this.onIntermission(d),
      [EV.RELICS]: (d) => this.onRelics(d),
      [EV.BOSS]: (d) => this.onBoss(d),
      [EV.TOWER]: (d) => this.onTower(d),
      [EV.TOWER_WORD]: (d) => this.onTowerWord(d),
      [EV.TOWER_MISS]: (d) => this.onTowerMiss(d),
      [EV.TOWER_HUNGER]: (d) => this.onTowerHunger(d),
      [EV.DIG]: (d) => this.onDig(d),
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
  showToast(msg, kind = null) { this.toast = msg; this.fire('toast', { msg, kind }); }

  me() { return this.players.find((p) => p.id === this.selfId); }
  player(id) { return this.players.find((p) => p.id === id); }
  isHost() { return this.hostId === this.selfId; }

  // ---------- handlers ----------
  onLobby(d) {
    this.hostId = d.hostId;
    this.players = d.players;
    this.settings = d.settings;
    this.daily = d.daily || null;
    this.started = d.started;
    if (!d.started) {
      this.over = false; this.gameover = null; this.tower = null;
    }
    this.fire('lobby', d);
  }

  onStart(d) {
    this.settings = d.settings;
    this.daily = d.daily || null;
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

  onScores(d) { this.applyScores(d.scores); this.fire('scores', d); }

  applyScores(scores) {
    for (const [pid, s] of Object.entries(scores || {})) {
      const p = this.player(pid);
      if (p) p.score = s;
    }
  }

  onTower(d) {
    const t = this.tower || (this.tower = { rows: [], buried: {} });
    const hadStage = t.stage;
    t.offer = null;              // any decree in hand is spent the moment one lands
    t.stage = d.stage;
    t.constraint = d.constraint;
    t.height = d.height;
    t.combo = d.combo;
    t.hungerMs = d.hungerMs;
    t.lives = d.lives;
    t.hungerAt = now() + d.hungerMs;
    t.digNeed = d.digNeed ?? t.digNeed ?? 3;
    t.run = d.run ?? t.run ?? null;
    this.applyScores(d.scores);
    this.fire('tower', { ...d, fresh: hadStage == null });
  }

  onDecreeOffer(d) {
    const t = this.tower;
    if (!t) return;
    t.offer = { options: d.options, until: now() + d.ms };
    this.fire('offer', d);
  }

  myOffer() { return (this.tower && this.tower.offer) || null; }

  pickDecree(i) {
    if (!this.myOffer()) return false;
    this.net.emit(IN.DECREE_PICK, { index: i });
    return true;
  }

  onTowerWord(d) {
    const t = this.tower;
    if (!t) return;
    t.rows.push({ pid: d.pid, word: d.word, points: d.points });
    if (t.rows.length > 60) t.rows.shift();
    t.height = d.height;
    t.combo = d.combo;
    t.stage = d.stage;
    if (t.run && d.levelScore != null) t.run.levelScore = d.levelScore;
    if (t.run && d.voice !== undefined) t.run.voice = d.voice;
    t.hungerAt = now() + t.hungerMs;
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
    this.syncBuried();
    if (d.pid === this.selfId) {
      this.pendingTower = 0;
      this.showToast(d.buried
        ? `"${d.word.toUpperCase()}" — ${d.reason}. BURIED — dig yourself out.`
        : `"${d.word.toUpperCase()}" — ${d.reason}`, 'loss');
    }
    this.fire('towermiss', d);
  }

  onTowerHunger(d) {
    const t = this.tower;
    if (!t) return;
    t.lives = d.lives;
    t.combo = 0;
    t.hungerAt = now() + t.hungerMs;
    this.syncBuried();
    this.showToast('OUT OF TIME — everyone loses a mark', 'loss');
    this.fire('towerhunger', d);
  }

  onDig(d) {
    const t = this.tower;
    if (!t) return;
    if (d.phase === 'out') {
      delete t.buried[d.pid];
      if (d.lives) t.lives = d.lives;
    } else {
      const dig = t.buried[d.pid] || (t.buried[d.pid] = { cleared: 0 });
      dig.cleared = d.cleared;
    }
    if (d.pid === this.selfId) {
      this.pendingTower = 0;
      if (d.rejected) this.showToast(`"${d.word.toUpperCase()}" — ${d.rejected}`);
    }
    this.fire('dig', d);
  }

  onIntermission(d) {
    const t = this.tower;
    if (!t) return;
    if (t.run) {
      t.run.phase = 'intermission';
      t.run.coins = d.coins;
      t.run.levelScore = d.levelScore;
    }
    if (d.lives) { t.lives = d.lives; this.syncBuried(); }
    t.offer = null;
    if (t.run) { t.run.relics = d.relics || t.run.relics; t.run.offers = d.offers || {}; }
    this.intermission = d;
    this.fire('intermission', d);
  }

  onRelics(d) {
    const t = this.tower;
    if (!t || !t.run) return;
    t.run.relics = d.relics || t.run.relics;
    t.run.coins = d.coins;
    t.run.offers = d.offers || {};
    this.fire('relics', d);
  }

  onBoss(d) {
    const t = this.tower;
    if (t && t.run) { t.run.boss = d.id; }
    this.boss = d;
    this.fire('boss', d);
  }

  myVoice() {
    const r = this.myRun();
    return !r || !r.voice ? null : r.voice;
  }

  myRelics() { return (this.myRun()?.relics?.[this.selfId]) || []; }
  myShop() { return (this.myRun()?.offers?.[this.selfId]) || []; }

  ready() { this.net.emit(IN.READY, {}); }
  pickRelic(id) { this.net.emit(IN.RELIC_PICK, { id }); }
  reroll() { this.net.emit(IN.REROLL, {}); }

  myRun() { return (this.tower && this.tower.run) || null; }

  onTowerBonus(d) {
    const t = this.tower;
    if (t) { t.lives = d.lives; this.syncBuried(); }
    this.fire('towerbonus', d);
  }

  // Burial is derived from lives on the host (Engine.syncBuried); mirror the
  // same derivation here so a lives-only broadcast can never leave a client
  // showing someone as buried when they are not.
  syncBuried() {
    const t = this.tower;
    if (!t) return;
    for (const p of this.players) {
      const alive = (t.lives[p.id] ?? 0) > 0;
      if (!alive && !t.buried[p.id]) t.buried[p.id] = { cleared: 0 };
      else if (alive && t.buried[p.id]) delete t.buried[p.id];
    }
  }

  myTowerLives() {
    return this.tower ? (this.tower.lives[this.selfId] ?? 0) : 0;
  }

  myDig() {
    return (this.tower && this.tower.buried[this.selfId]) || null;
  }

  digNeed() { return (this.tower && this.tower.digNeed) || 3; }

  submitTower() {
    const word = this.input;
    if (word.length !== WORD_LEN) { this.fire('shake', {}); return false; }
    // Words are NOT pre-checked: the host judges. A miss costs a life while
    // you are standing, and costs nothing at all while you are buried.
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
      this.tower = {
        stage: s.tower.stage, constraint: s.tower.constraint,
        height: s.tower.height, combo: s.tower.combo,
        hungerMs: s.tower.hungerMs, lives: { ...s.tower.lives },
        hungerAt: now() + s.tower.hungerMs,
        digNeed: s.tower.digNeed ?? 3,
        run: s.tower.run
          ? { ...s.tower.run, offers: s.offers || s.tower.run.offers || {} } : null,
        offer: s.tower.offer
          ? { options: s.tower.offer.options, until: now() + (this.settings?.draftMs ?? 9000) }
          : null,
        rows: s.tower.rows.map((r) => ({ ...r })),
        buried: Object.fromEntries(Object.entries(s.tower.buried || {})
          .map(([pid, d]) => [pid, { cleared: d.cleared }])),
      };
    } else {
      this.tower = null;
    }
    this.fire('resync', s);
  }

  // Buried players are NOT locked out - digging is the whole point.
  inputLocked() {
    if (!this.started || this.over || !this.tower) return true;
    const r = this.myRun();
    if (r && r.phase !== 'climb') return true; // the intermission is a real stop
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
