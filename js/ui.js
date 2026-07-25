// Rendering + input. Renders exclusively from the Mirror; sends intents back
// through it. The tower itself is delegated to tower3d.js.

import { WORD_LEN, MAX_ROWS, SHOP, DEFAULT_SETTINGS, STORE } from './config.js';
import { describeConstraint } from './decree.js';
import { el, now } from './util.js';
import { sfx, soundEnabled, setSound } from './audio.js';
import { Tower3D } from './tower3d.js';

const $ = (id) => document.getElementById(id);
const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', '⏎zxcvbnm⌫'];
const COLLAPSE_MS = 2100; // let the tower actually fall before the podium

export class UI {
  // actions: {host(), join(code), start(), setSettings(patch), playAgain(),
  //           quitToMenu(), shareLink(), roomCode()}
  constructor(actions) {
    this.a = actions;
    this.mirror = null;
    this.paused = false;
    this.toastTimer = null;
    this.applyTheme(localStorage.getItem(STORE.theme) || 'light');
    this.buildStaticDom();
    this.wireMenu();
    this.wireGameChrome();
    this.tower3d = new Tower3D($('tower-scene'));
    setInterval(() => this.tick(), 80);
  }

  attach(mirror) {
    this.mirror = mirror;
    mirror.onChange((type, d) => this.onEvent(type, d));
  }

  // ---------- theme ----------
  applyTheme(mode) {
    this.theme = mode === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = this.theme;
    localStorage.setItem(STORE.theme, this.theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', this.theme === 'dark' ? '#080808' : '#ffffff');
    const btn = $('btn-theme');
    if (btn) btn.textContent = this.theme === 'dark' ? '◑ INVERT' : '◐ INVERT';
  }

  // ---------- static DOM ----------
  buildStaticDom() {
    const title = $('scr-menu').querySelector('.big-title');
    for (const [i, ch] of [...'TO-WORD'].entries()) {
      title.append(el('span', {
        class: 'title-glyph' + (ch === '-' ? ' title-dash' : ''),
        text: ch,
        style: { animationDelay: `${i * 0.055}s` },
      }));
    }
    // the tower input row
    this.towerTiles = [];
    for (let c = 0; c < WORD_LEN; c++) {
      const t = el('div', { class: 'tile tower-tile', 'data-testid': `twr-in-${c}` });
      $('tower-input').append(t);
      this.towerTiles.push(t);
    }
    // the rescue wordle grid
    this.reviveTiles = [];
    const rb = $('revive-board');
    for (let r = 0; r < MAX_ROWS; r++) {
      const rowEl = el('div', { class: 'brow' });
      const row = [];
      for (let c = 0; c < WORD_LEN; c++) {
        const t = el('div', { class: 'tile mini', 'data-testid': `rev-${r}-${c}` });
        rowEl.append(t);
        row.push(t);
      }
      rb.append(rowEl);
      this.reviveTiles.push(row);
    }
    // keyboard
    this.keys = {};
    for (const rowStr of KEY_ROWS) {
      const rowEl = el('div', { class: 'krow' });
      for (const ch of rowStr) {
        const wide = ch === '⏎' || ch === '⌫';
        const label = ch === '⏎' ? 'ENTER' : ch === '⌫' ? '⌫' : ch;
        const k = el('button', {
          class: 'key' + (wide ? ' key-wide' : ''),
          'data-key': ch, 'data-testid': `key-${ch === '⏎' ? 'enter' : ch === '⌫' ? 'back' : ch}`,
          text: label,
          onclick: () => this.pressKey(ch),
        });
        rowEl.append(k);
        this.keys[ch] = k;
      }
      $('keyboard').append(rowEl);
    }
    // shop (revival only)
    for (const [id, item] of Object.entries(SHOP)) {
      $('shop').append(el('button', {
        class: 'shop-btn', 'data-item': id, 'data-testid': `shop-${id}`,
        html: `<span class="shop-glyph">${item.glyph}</span><span class="shop-name">${item.name}</span><span class="shop-price">${item.price.toLocaleString('en-US')}</span>`,
        title: item.desc,
        onclick: () => this.shopClick(id),
      }));
    }
  }

  // ---------- menu & chrome wiring ----------
  wireMenu() {
    const nameInput = $('inp-name');
    nameInput.value = localStorage.getItem(STORE.name) || '';
    const saveName = () => localStorage.setItem(STORE.name, nameInput.value.trim());
    nameInput.addEventListener('change', saveName);

    const soundBtn = $('btn-sound');
    const paintSound = () => { soundBtn.textContent = soundEnabled() ? 'SOUND ON' : 'SOUND OFF'; };
    paintSound();
    soundBtn.onclick = () => { setSound(!soundEnabled()); paintSound(); if (soundEnabled()) sfx.key(); };

    $('btn-theme').onclick = () => {
      this.applyTheme(this.theme === 'dark' ? 'light' : 'dark');
      sfx.key();
    };

    $('btn-host').onclick = () => { saveName(); this.a.host(this.playerName()); };
    const join = () => {
      saveName();
      const code = $('inp-code').value;
      if (code.trim().length >= 4) this.a.join(code, this.playerName());
      else this.showToast('Enter the 4-character room code');
    };
    $('btn-join').onclick = join;
    $('inp-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
    $('inp-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

    $('btn-help-menu').onclick = () => this.showHelp(true);
    $('btn-help-close').onclick = () => this.showHelp(false);
    $('btn-connect-back').onclick = () => this.a.quitToMenu();
    $('btn-dead-menu').onclick = () => this.a.quitToMenu();
    $('btn-over-menu').onclick = () => this.confirmQuit();
    $('btn-again').onclick = () => this.a.playAgain();
  }

  wireGameChrome() {
    $('btn-share').onclick = async () => {
      try {
        await navigator.clipboard.writeText(this.a.shareLink());
        this.showToast('Invite link copied');
      } catch {
        this.showToast(this.a.shareLink());
      }
    };
    for (const seg of document.querySelectorAll('.seg')) {
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('.seg-btn');
        if (!btn || !this.mirror || !this.mirror.isHost()) return;
        const key = seg.dataset.setting;
        const val = key === 'difficulty' ? btn.dataset.val : Number(btn.dataset.val);
        this.a.setSettings({ [key]: val });
        sfx.key();
      });
    }
    $('btn-start').onclick = () => this.a.start();
    $('btn-lobby-help').onclick = () => this.showHelp(true);
    $('btn-help').onclick = () => this.showHelp(true);
    $('btn-lobby-quit').onclick = () => this.confirmQuit();
    $('btn-quit').onclick = () => this.confirmQuit();
    $('btn-pause').onclick = () => this.setPaused(true);
    $('btn-resume').onclick = () => this.setPaused(false);
    $('btn-picker-cancel').onclick = () => this.closePicker();

    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (['inp-name', 'inp-code'].includes(document.activeElement?.id)) return;
      if (this.paused || !$('ovl-help').classList.contains('hidden')) return;
      if (!$('ovl-picker').classList.contains('hidden')) return;
      if (/^[a-zA-Z]$/.test(e.key)) this.pressKey(e.key.toLowerCase());
      else if (e.key === 'Enter') this.pressKey('⏎');
      else if (e.key === 'Backspace') this.pressKey('⌫');
    });
  }

  playerName() {
    const v = $('inp-name').value.trim();
    if (v) return v;
    const names = ['MASON', 'SCRIBE', 'GARGOYLE', 'RIGGER', 'CRANE', 'BRICK', 'SPIRE', 'JOIST'];
    const n = names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 90 + 10);
    $('inp-name').value = n;
    return n;
  }

  confirmQuit() {
    const m = this.mirror;
    if (m && m.started && !m.over) {
      if (!confirm(m.isHost() ? 'Quit? You are the host — the room dies with you.' : 'Quit to menu?')) return;
    }
    this.a.quitToMenu();
  }

  // ---------- screens ----------
  show(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
    $(id).classList.remove('hidden');
  }

  showConnect(msg) { this.show('scr-connect'); $('connect-msg').textContent = msg; }
  showDead(msg) { this.show('scr-dead'); $('dead-msg').textContent = msg; }
  showHelp(on) { $('ovl-help').classList.toggle('hidden', !on); }

  setPaused(on) {
    this.paused = on;
    $('ovl-pause').classList.toggle('hidden', !on);
  }

  showToast(msg, ms = 2600) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden', 'pop');
    // mid-run the bottom of the screen is all keyboard — speak over the tower
    t.classList.toggle('over-tower', !$('scr-game').classList.contains('hidden'));
    void t.offsetWidth;
    t.classList.add('pop');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // ---------- event routing ----------
  onEvent(type, d) {
    const m = this.mirror;
    switch (type) {
      case 'lobby':
        if (!m.started) { this.show('scr-lobby'); this.renderLobby(); }
        else this.renderStrip();
        break;
      case 'start':
        this.show('scr-game');
        this.tower3d.reset();
        $('revive-box').classList.add('hidden');
        $('decree').textContent = 'THE TOWER AWAITS A DECREE…';
        this.renderStrip();
        this.renderTowerHud();
        this.renderTowerInput();
        this.renderKeyboard();
        this.renderShop();
        sfx.join();
        break;
      case 'tower': this.onDecree(d); break;
      case 'towerword': this.onTowerWord(d); break;
      case 'towermiss': this.onTowerMiss(d); break;
      case 'towerhunger':
        this.renderTowerHud(); this.renderStrip(); this.renderShop();
        this.tower3d.miss(); sfx.hunger();
        break;
      case 'towerrev': this.onTowerRevive(d); break;
      case 'towerbonus': this.onTowerBonus(d); break;
      case 'type':
        (m.myRevive() ? this.renderRevive() : this.renderTowerInput());
        (d.back ? sfx.back : sfx.key)();
        break;
      case 'submit':
        this.renderTowerInput();
        sfx.ret();
        break;
      case 'shake': this.shakeInput(); sfx.invalid(); break;
      case 'badguess': this.renderRevive(); this.shakeInput(); break;
      case 'toast': this.showToast(d.msg); break;
      case 'scores': this.renderStrip(); this.renderShop(); if (d.buyer === m.selfId) sfx.buy(); break;
      case 'left': this.onLeft(d); break;
      case 'gameover': this.onGameOver(d); break;
      case 'roomdead': this.showDead('The host closed the room. The tower is gone.'); break;
      case 'joinerr': this.showDead(d.reason); break;
      case 'resync': this.onResync(); break;
      default: break;
    }
  }

  // ---------- lobby ----------
  renderLobby() {
    const m = this.mirror;
    $('room-code').textContent = this.a.roomCode();
    const ul = $('lobby-players');
    ul.replaceChildren();
    for (const p of m.players) {
      ul.append(el('li', {
        class: 'lobby-player' + (p.connected ? '' : ' gone'),
        'data-testid': `lobby-player-${p.id}`,
        style: { '--sig': p.color },
      },
      el('span', { class: 'sig-dot' }),
      el('span', { text: p.name + (p.id === m.hostId ? ' ★' : '') + (p.id === m.selfId ? ' (you)' : '') })));
    }
    for (let i = m.players.length; i < 4; i++) {
      ul.append(el('li', { class: 'lobby-player empty', text: 'waiting…' }));
    }
    const s = m.settings || DEFAULT_SETTINGS;
    for (const seg of document.querySelectorAll('.seg')) {
      const key = seg.dataset.setting;
      for (const btn of seg.querySelectorAll('.seg-btn')) {
        btn.classList.toggle('on', String(s[key]) === btn.dataset.val);
        btn.disabled = !m.isHost();
      }
    }
    $('mode-blurb').textContent =
      `stack real 5-letter words under the decree. it changes every ${s.rampWords} words. misses cost lives. solo is fine.`;
    const enough = m.players.filter((p) => p.connected).length >= 1;
    $('btn-start').classList.toggle('hidden', !m.isHost());
    $('btn-start').disabled = !enough;
    $('lobby-wait').classList.toggle('hidden', m.isHost());
  }

  // ---------- roster strip ----------
  renderStrip() {
    const m = this.mirror;
    const strip = $('players-strip');
    strip.replaceChildren();
    const lives = m.tower ? m.tower.lives : null;
    for (const p of m.players) {
      const n = lives ? (lives[p.id] ?? 0) : null;
      const downed = lives && n <= 0;
      strip.append(el('div', {
        class: 'strip-p' + (downed ? ' down' : '') + (p.connected ? '' : ' gone'),
        'data-testid': `strip-${p.id}`,
        style: { '--sig': p.color },
      },
      el('span', { class: 'strip-name', text: (p.id === m.selfId ? '▸ ' : '') + p.name }),
      el('span', { class: 'strip-score', 'data-testid': `score-${p.id}`, text: p.score.toLocaleString('en-US') }),
      lives ? el('span', {
        class: 'strip-hearts', 'data-testid': `lives-${p.id}`,
        text: n > 0 ? '♥'.repeat(n) : '—',
      }) : null));
    }
  }

  // ---------- the tower ----------
  onDecree(d) {
    const m = this.mirror;
    if (!m.tower) return;
    this.show('scr-game');
    $('decree').textContent = describeConstraint(m.tower.constraint);
    $('decree').classList.remove('swap');
    void $('decree').offsetWidth;
    $('decree').classList.add('swap');
    $('hdr-slug').textContent = `INT. THE TOWER — STAGE ${m.tower.stage}`;
    this.renderTowerHud();
    this.renderTowerInput();
    this.renderRevive();
    this.renderStrip();
    this.renderShop();
    if (m.tower.stage > 1) {
      this.showToast(`STAGE ${m.tower.stage} — NEW DECREE`);
      sfx.stage();
    }
  }

  renderTowerHud() {
    const m = this.mirror;
    const t = m.tower;
    if (!t) return;
    const team = m.players.reduce((s, p) => s + (p.score || 0), 0);
    const scoreEl = $('team-score');
    scoreEl.textContent = team.toLocaleString('en-US');
    scoreEl.classList.remove('bump');
    void scoreEl.offsetWidth;
    scoreEl.classList.add('bump');
    $('tower-height').textContent = `HEIGHT ${t.height}`;
    $('tower-stage').textContent = `STAGE ${t.stage}`;
    $('tower-combo').textContent = t.combo > 1 ? `×${t.combo} COMBO` : '';
  }

  renderTowerInput() {
    const m = this.mirror;
    // Blank (not hidden) while I'm the active reviver: my typing already
    // renders live inside the rescue grid, and this row stays in the layout so
    // the keyboard below it never shifts.
    const blank = m.myRevive();
    for (let c = 0; c < WORD_LEN; c++) {
      const t = this.towerTiles[c];
      const ch = !blank && m.input[c];
      t.textContent = ch ? ch.toUpperCase() : '';
      t.classList.toggle('filled', !!ch);
    }
    $('tower-input').classList.toggle('downed', m.myTowerLives() <= 0 && !m.myRevive());
  }

  shakeInput() {
    const row = $('tower-input');
    row.classList.remove('shake');
    void row.offsetWidth;
    row.classList.add('shake');
  }

  colorFor(pid) {
    const p = this.mirror.player(pid);
    return p ? p.color : null;
  }

  onTowerWord(d) {
    const m = this.mirror;
    this.tower3d.push({ pid: d.pid, word: d.word, points: d.points }, (pid) => this.colorFor(pid));
    this.renderTowerHud();
    this.renderTowerInput();
    this.renderStrip();
    this.renderShop();
    this.spawnFloat(`+${d.points.toLocaleString('en-US')}`, d.pid);
    sfx.land(d.height);
    sfx.points();
    if (d.combo > 1 && d.combo % 5 === 0) {
      this.spawnFloat(`×${d.combo}`, d.pid);
      sfx.combo(d.combo);
    }
  }

  onTowerMiss(d) {
    this.renderTowerHud();
    this.renderStrip();
    this.renderShop();
    this.tower3d.miss();
    if (d.pid === this.mirror.selfId) this.shakeInput();
    sfx.crack();
  }

  spawnFloat(text, pid) {
    const layer = $('float-layer');
    const p = this.mirror.player(pid);
    const f = el('span', {
      class: 'float-num',
      text,
      style: {
        left: `${16 + Math.random() * 58}%`,
        top: `${22 + Math.random() * 42}%`,
        '--sig': p ? p.color : 'currentColor',
      },
    });
    layer.append(f);
    setTimeout(() => f.remove(), 1500);
  }

  onTowerRevive(d) {
    const m = this.mirror;
    if (d.phase === 'end') {
      const target = m.player(d.target), reviver = m.player(d.reviver);
      if (d.reason === 'left') {
        this.showToast(`${reviver?.name} left mid-rescue — ${target?.name} stays down`);
      } else {
        this.showToast(d.ok
          ? `${reviver?.name} revived ${target?.name}`
          : `rescue failed — the word was "${(d.secret || '').toUpperCase()}"`);
      }
      (d.ok ? sfx.solve : sfx.fail)();
    } else if (d.phase === 'start') {
      sfx.buy();
    } else {
      sfx.flip(1);
    }
    this.renderRevive();
    this.renderTowerHud();
    this.renderTowerInput();
    this.renderKeyboard();
    this.renderStrip();
    this.renderShop();
  }

  onTowerBonus(d) {
    this.renderStrip();
    this.renderTowerHud();
    if (d.reason === 'spelled') {
      this.showToast('T-O-W-E-R — the tower blesses you. bonus hearts.');
      sfx.bless();
    } else {
      this.showToast(`+1 heart for the team (floor ${d.height})`);
      sfx.heart();
    }
    this.tower3d.bless();
  }

  renderRevive() {
    const m = this.mirror;
    const t = m.tower;
    const box = $('revive-box');
    if (!t) { box.classList.add('hidden'); return; }
    // The rescue grid takes the tower's PLACE while ANY rescue runs - one less
    // thing competing for space on a phone, and the keyboard never shifts.
    const anyRevive = Object.keys(t.revives).length > 0;
    $('tower-area').classList.toggle('hidden', anyRevive);
    if (!anyRevive) { box.classList.add('hidden'); return; }
    const mine = m.myRevive();
    const entry = mine ? [m.selfId, mine] : Object.entries(t.revives)[0] || null;
    if (!entry) { box.classList.add('hidden'); return; }
    const [reviverId, rev] = entry;
    const reviver = m.player(reviverId), target = m.player(rev.target);
    $('revive-title').textContent = reviverId === m.selfId
      ? `SOLVE TO REVIVE ${target?.name || '???'}`
      : `${reviver?.name || '???'} IS REVIVING ${target?.name || '???'}…`;
    for (let r = 0; r < MAX_ROWS; r++) {
      const row = rev.rows[r];
      for (let c = 0; c < WORD_LEN; c++) {
        const tile = this.reviveTiles[r][c];
        tile.className = 'tile mini';
        if (row) {
          tile.textContent = row.word[c].toUpperCase();
          tile.classList.add(row.colors[c]);
        } else if (r === rev.rows.length && reviverId === m.selfId) {
          tile.textContent = (m.input[c] || '').toUpperCase();
          tile.classList.add('active-row');
        } else {
          tile.textContent = '';
        }
      }
    }
    box.classList.remove('hidden');
  }

  // ---------- keyboard ----------
  renderKeyboard() {
    const m = this.mirror;
    const state = m ? m.keyboardState() : {};
    for (const [ch, btn] of Object.entries(this.keys)) {
      btn.classList.remove('g', 'y', 'x');
      if (state[ch]) btn.classList.add(state[ch]);
    }
  }

  pressKey(ch) {
    const m = this.mirror;
    if (!m) return;
    const btn = this.keys[ch];
    if (btn) {
      btn.classList.remove('ripple');
      void btn.offsetWidth;
      btn.classList.add('ripple');
    }
    if (ch === '⏎') m.enter();
    else if (ch === '⌫') m.backspace();
    else m.type(ch);
  }

  // ---------- shop (revival only) ----------
  renderShop() {
    const m = this.mirror;
    const shop = $('shop');
    const visible = m.started && !m.over && !!m.tower;
    shop.classList.toggle('hidden', !visible);
    if (!visible) return;
    const me = m.me();
    const btn = shop.querySelector('[data-item="revive"]');
    const someoneDowned = m.players.some(
      (p) => p.connected && (m.tower.lives[p.id] ?? 0) <= 0 && p.id !== m.selfId);
    btn.disabled = !someoneDowned || m.myTowerLives() <= 0 || !!m.myRevive()
      || !me || me.score < SHOP.revive.price;
  }

  shopClick(id) { this.openPicker(id); }

  openPicker(item) {
    const m = this.mirror;
    this.pickerItem = item;
    this.pickerTarget = null;
    $('picker-title').textContent = `${SHOP[item].glyph} ${SHOP[item].name} — PICK A FALLEN TEAMMATE`;
    const box = $('picker-targets');
    box.replaceChildren();
    for (const p of m.players) {
      if (p.id === m.selfId || !p.connected) continue;
      if (!m.tower || (m.tower.lives[p.id] ?? 0) > 0) continue; // the fallen only
      box.append(el('button', {
        class: 'picker-target', 'data-testid': `pick-${p.id}`, style: { '--sig': p.color },
        text: p.name,
        onclick: (e) => {
          this.pickerTarget = p.id;
          for (const b of box.children) b.classList.remove('on');
          e.target.classList.add('on');
          $('btn-picker-go').disabled = false;
        },
      }));
    }
    $('btn-picker-go').disabled = true;
    $('btn-picker-go').onclick = () => {
      m.buy(item, this.pickerTarget);
      this.closePicker();
    };
    $('ovl-picker').classList.remove('hidden');
  }

  closePicker() { $('ovl-picker').classList.add('hidden'); }

  // ---------- endgame ----------
  onLeft(d) {
    const m = this.mirror;
    const p = m.player(d.pid);
    this.showToast(`${p ? p.name : 'someone'} left the build`);
    this.renderStrip();
    if (!m.started) this.renderLobby();
  }

  onGameOver(d) {
    // The fall is the payoff: play it in place, then cut to the rubble.
    this.setPaused(false);
    this.closePicker();
    this.tower3d.collapse();
    sfx.collapse();
    $('decree').textContent = 'THE TOWER FALLS';
    clearTimeout(this._overTimer);
    this._overTimer = setTimeout(() => this.renderGameOver(d), COLLAPSE_MS);
  }

  renderGameOver(d) {
    const m = this.mirror;
    this.show('scr-over');
    $('over-title').textContent = `HEIGHT ${d.height ?? 0}`;
    $('over-sub').textContent = `the tower fell at stage ${d.stage ?? 1} — ${(d.standings || [])
      .reduce((s, p) => s + p.score, 0).toLocaleString('en-US')} points banked`;
    const ol = $('standings');
    ol.replaceChildren();
    for (const p of d.standings || []) {
      ol.append(el('li', {
        class: 'standing' + (p.id === d.winner ? ' winner' : ''),
        'data-testid': `standing-${p.id}`,
        style: { '--sig': p.color },
      },
      el('span', { text: p.name + (p.id === m.selfId ? ' (you)' : '') }),
      el('span', { class: 'standing-score', text: p.score.toLocaleString('en-US') })));
    }
    $('btn-again').classList.toggle('hidden', !m.isHost());
    $('over-wait').classList.toggle('hidden', m.isHost());
    sfx.win();
  }

  onResync() {
    const m = this.mirror;
    if (m.over && m.gameover) { this.renderGameOver(m.gameover); return; }
    if (!m.started) { this.show('scr-lobby'); this.renderLobby(); return; }
    this.show('scr-game');
    this.renderStrip();
    if (m.tower) {
      this.tower3d.sync(m.tower.rows, (pid) => this.colorFor(pid));
      $('decree').textContent = describeConstraint(m.tower.constraint);
      $('hdr-slug').textContent = `INT. THE TOWER — STAGE ${m.tower.stage}`;
      this.renderTowerHud();
      this.renderTowerInput();
      this.renderRevive();
      this.renderKeyboard();
      this.renderShop();
    }
  }

  // ---------- ticker ----------
  tick() {
    const m = this.mirror;
    // idle camera drift keeps the structure reading as a solid object
    this.tower3d.setYaw(Math.sin(now() / 4600) * 8);
    if (!m || m.over || !m.tower) return;
    const t = m.tower;
    const fill = $('hunger-fill');
    if (t.hungerPaused) {
      fill.style.width = '100%';
      fill.classList.remove('starving');
      fill.classList.add('paused');
      this.tower3d.stress(0);
    } else {
      fill.classList.remove('paused');
      const left = Math.max(0, (t.hungerAt || 0) - now());
      const pct = Math.min(100, (left / t.hungerMs) * 100);
      fill.style.width = `${pct}%`;
      fill.classList.toggle('starving', pct < 30);
      this.tower3d.stress(1 - pct / 100);
    }
    $('hunger-label').classList.toggle('inactive', !t.hungerPaused);
  }
}
