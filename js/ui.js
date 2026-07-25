// Rendering + input. Renders exclusively from the Mirror; sends intents back
// through it. The tower itself is delegated to tower3d.js.

import { WORD_LEN, SHOP, DEFAULT_SETTINGS, STORE } from './config.js';
import { describeConstraint, countRecognizable } from './decree.js';
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
    for (const [i, ch] of [...'TOPPLE'].entries()) {
      title.append(el('span', {
        class: 'title-glyph',
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
    // shop (the tower sells only rope)
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
      if (!$('ovl-draft').classList.contains('hidden')) return;
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
        $('decree').textContent = 'THE TOWER AWAITS A DECREE…';
        this.renderStrip();
        this.renderTowerHud();
        this.renderTowerInput();
            this.renderShop();
        sfx.join();
        break;
      case 'offer': this.showDraft(); break;
      case 'tower': this.onDecree(d); break;
      case 'towerword': this.onTowerWord(d); break;
      case 'towermiss': this.onTowerMiss(d); break;
      case 'towerhunger':
        this.renderTowerHud(); this.renderStrip(); this.renderShop();
        this.renderStatusLine();
        this.tower3d.miss(); sfx.hunger();
        break;
      case 'dig': this.onDig(d); break;
      case 'towerbonus': this.onTowerBonus(d); break;
      case 'type':
        this.renderTowerInput();
        (d.back ? sfx.back : sfx.key)();
        break;
      case 'submit':
        this.renderTowerInput();
        sfx.ret();
        break;
      case 'shake': this.shakeInput(); sfx.invalid(); break;
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
    const daily = s.mode === 'daily';
    for (const seg of document.querySelectorAll('.seg')) {
      const key = seg.dataset.setting;
      for (const btn of seg.querySelectorAll('.seg-btn')) {
        btn.classList.toggle('on', String(s[key]) === btn.dataset.val);
        // DAILY owns its own knobs - a shared run everyone tuned differently
        // would not be a shared run
        btn.disabled = !m.isHost() || (daily && key !== 'mode');
      }
    }
    $('lobby-settings').classList.toggle('locked', daily);
    $('mode-blurb').textContent = daily
      ? `TOWER #${m.daily?.n ?? '—'} — the same decrees for everyone today, settings locked. compare heights.`
      : `stack real 5-letter words under the decree. it changes every ${s.rampWords} words. misses cost lives. solo is fine.`;
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
        class: 'strip-hearts' + (n > 0 ? '' : ' digging'), 'data-testid': `lives-${p.id}`,
        text: n > 0 ? '♥'.repeat(n)
          : `${(m.tower.buried[p.id]?.cleared ?? 0)}/${m.digNeed()}`,
      }) : null));
    }
  }

  // ---------- the tower ----------
  onDecree(d) {
    const m = this.mirror;
    if (!m.tower) return;
    this.closeDraft();
    this.show('scr-game');
    $('decree').textContent = describeConstraint(m.tower.constraint);
    $('decree').classList.remove('swap');
    void $('decree').offsetWidth;
    $('decree').classList.add('swap');
    $('hdr-slug').textContent = m.daily
      ? `INT. THE TOWER #${m.daily.n} — STAGE ${m.tower.stage}`
      : `INT. THE TOWER — STAGE ${m.tower.stage}`;
    this.renderTowerHud();
    this.renderTowerInput();
    this.renderStrip();
    this.renderShop();
    if (m.tower.stage > 1) {
      const who = d && d.pickedBy ? m.player(d.pickedBy) : null;
      this.showToast(who
        ? `${who.name} CHOSE — STAGE ${m.tower.stage}`
        : `STAGE ${m.tower.stage} — NEW DECREE`);
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
    for (let c = 0; c < WORD_LEN; c++) {
      const t = this.towerTiles[c];
      const ch = m.input[c];
      t.textContent = ch ? ch.toUpperCase() : '';
      t.classList.toggle('filled', !!ch);
    }
    const dig = m.myDig();
    $('tower-input').classList.toggle('buried', !!dig);
    this.renderStatusLine();
  }

  // One fixed-height line under the hunger bar. It never changes height, only
  // visibility, so burying or freeing a player cannot shift the tower.
  renderStatusLine() {
    const m = this.mirror;
    const el$ = $('status-line');
    const t = m.tower;
    if (!t) { el$.classList.add('inactive'); return; }
    const need = m.digNeed();
    const mine = m.myDig();
    if (mine) {
      el$.textContent = `BURIED — DIG OUT: ${need - mine.cleared} MORE`;
      el$.classList.remove('inactive');
      el$.classList.add('buried');
      return;
    }
    const other = Object.keys(t.buried || {})[0];
    if (other) {
      const p = m.player(other);
      el$.textContent = `${p ? p.name : '???'} IS BURIED — ${need - t.buried[other].cleared} TO DIG`;
      el$.classList.remove('inactive', 'buried');
      return;
    }
    el$.classList.add('inactive');
    el$.classList.remove('buried');
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
    // anyone's miss can bury anyone, so the shared status line refreshes for
    // every player, not just the one who missed
    this.renderStatusLine();
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

  onDig(d) {
    const m = this.mirror;
    const who = m.player(d.pid);
    if (d.phase === 'out') {
      this.showToast(d.by
        ? `${m.player(d.by)?.name || '???'} pulled ${who?.name || '???'} out`
        : `${who?.name || '???'} dug out`);
      sfx.solve();
      this.tower3d.bless();
    } else if (!d.rejected) {
      if (d.by) sfx.buy(); else sfx.land(0);
      if (d.pid !== m.selfId) {
        this.showToast(`${who?.name || '???'} — ${d.need - d.cleared} to dig`);
      }
    } else {
      sfx.invalid();
      if (d.pid === m.selfId) this.shakeInput();
    }
    this.renderTowerInput();
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
    this.renderTowerInput();
    this.renderStatusLine();
    this.renderShop();
  }

  // ---------- decree draft ----------
  showDraft() {
    const m = this.mirror;
    const offer = m.myOffer();
    if (!offer) return;
    const box = $('draft-options');
    box.replaceChildren();
    offer.options.forEach((c, i) => {
      // How much room the decree leaves, counted over the curated answer bank
      // rather than the full dictionary - "words you'd actually think of", not
      // "words that exist". countRecognizable early-exits at the cap, so the
      // number is exact below it and honestly reported as "300+" above.
      const n = countRecognizable(c, 300);
      const gauge = n >= 300 ? '300+ COMMON WORDS'
        : `~${n} COMMON WORD${n === 1 ? '' : 'S'}`;
      box.append(el('button', {
        class: 'draft-opt', 'data-testid': `draft-${i}`,
        style: { animationDelay: `${i * 0.06}s` },
        onclick: () => { m.pickDecree(i); sfx.ret(); },
      },
      el('span', { class: 'draft-rule', text: describeConstraint(c) }),
      el('span', { class: 'draft-gauge', text: gauge })));
    });
    $('ovl-draft').classList.remove('hidden');
    sfx.bell();
  }

  closeDraft() { $('ovl-draft').classList.add('hidden'); }

  // ---------- keyboard ----------
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
    const btn = shop.querySelector('[data-item="rope"]');
    const someoneBuried = m.players.some(
      (p) => p.connected && m.tower.buried[p.id] && p.id !== m.selfId);
    btn.disabled = !someoneBuried || m.myTowerLives() <= 0
      || !me || me.score < SHOP.rope.price;
  }

  shopClick(id) { this.openPicker(id); }

  openPicker(item) {
    const m = this.mirror;
    this.pickerItem = item;
    this.pickerTarget = null;
    $('picker-title').textContent = `${SHOP[item].glyph} ${SHOP[item].name} — PICK A BURIED TEAMMATE`;
    const box = $('picker-targets');
    box.replaceChildren();
    for (const p of m.players) {
      if (p.id === m.selfId || !p.connected) continue;
      if (!m.tower || !m.tower.buried[p.id]) continue; // the buried only
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
    this.closeDraft();
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
      this.renderShop();
      if (m.myOffer()) this.showDraft(); else this.closeDraft();
    }
  }

  // ---------- ticker ----------
  tick() {
    const m = this.mirror;
    // idle camera drift keeps the structure reading as a solid object
    this.tower3d.setYaw(Math.sin(now() / 4600) * 8);
    if (!m || m.over || !m.tower) return;
    const t = m.tower;
    const offer = m.myOffer();
    if (offer) {
      const secs = Math.max(0, Math.ceil((offer.until - now()) / 1000));
      $('draft-timer').textContent = `THE TOWER DECIDES IN ${secs}`;
    } else if (!$('ovl-draft').classList.contains('hidden')) {
      this.closeDraft();
    }
    const fill = $('hunger-fill');
    const left = Math.max(0, (t.hungerAt || 0) - now());
    const pct = Math.min(100, (left / t.hungerMs) * 100);
    fill.style.width = `${pct}%`;
    fill.classList.toggle('starving', pct < 30);
    this.tower3d.stress(1 - pct / 100);
  }
}
