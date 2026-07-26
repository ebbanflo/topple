// Bootstrap: wires transport + engine/mirror + UI, handles ?join=CODE links,
// ?t=local transport selection, and the ?debug=1 test handle.

import { LEAVE_GRACE_MS, ERR_NAPPING, STORE } from './config.js';
import { qs, makeCode, normCode, tabId, shareLink, now } from './util.js';
import { makeTransport, Net } from './transport.js';
import { Engine } from './engine.js';
import { Mirror } from './client.js';
import { UI } from './ui.js';

const S = {
  code: null,
  selfId: tabId(),
  transport: null,
  net: null,
  engine: null,
  mirror: null,
  hostMissingSince: 0,
  watchdog: null,
};

const transportKind = qs.get('t') === 'local' ? 'local' : 'supabase';
const DEBUG = qs.get('debug') === '1';

const ui = new UI({
  host: (name) => hostGame(name),
  join: (code, name) => joinGame(code, name),
  start: () => S.engine && S.engine.start(),
  setSettings: (patch) => S.engine && S.engine.setSettings(patch),
  playAgain: () => S.engine && S.engine.playAgain(),
  quitToMenu: () => quitToMenu(),
  shareLink: () => shareLink(S.code),
  roomCode: () => S.code || '????',
});

async function connect(code) {
  S.code = code;
  S.transport = makeTransport(code, { id: S.selfId, name: '' }, transportKind);
  S.net = new Net(S.transport, S.selfId);
  S.mirror = new Mirror(S.net, code, S.selfId);
  ui.attach(S.mirror);
  installDebug();
  await S.transport.connect();
}

async function hostGame(name) {
  ui.showConnect('opening a room…');
  try {
    await connect(makeCode());
    S.engine = new Engine(S.net, S.code, { id: S.selfId, name });
    if (DEBUG) window.__topple.engine = S.engine;
    S.engine.broadcastLobby();
  } catch (e) {
    ui.showDead(e.message || ERR_NAPPING);
  }
}

async function joinGame(codeRaw, name) {
  const code = normCode(codeRaw);
  if (code.length < 4) { ui.showToast('Room codes are 4 characters'); return; }
  ui.showConnect(`joining ${code}…`);
  try {
    await connect(code);
  } catch (e) {
    ui.showDead(e.message || ERR_NAPPING);
    return;
  }
  // Ask to join until the host's lobby lists us (broadcast rooms have no
  // membership - a dead code simply never answers).
  let joined = false;
  S.mirror.onChange((type) => {
    if (type === 'lobby' || type === 'resync') {
      if (S.mirror.players.some((p) => p.id === S.selfId)) joined = true;
    }
    if (type === 'joinerr') joined = 'rejected';
  });
  const deadline = now() + 9000;
  while (!joined && now() < deadline) {
    S.mirror.join(name);
    await new Promise((r) => setTimeout(r, 700));
  }
  if (!joined) {
    await S.transport.leave();
    ui.showDead(`No room "${code}" answered. Check the code — or ${ERR_NAPPING.toLowerCase()}`);
    return;
  }
  if (joined !== 'rejected') startHostWatchdog();
}

// Guests: if the host's presence vanishes and stays gone, the room is dead.
// The missing-clock may only start AFTER the host has been seen present at
// least once - starting from an empty pre-sync roster used to kick perfectly
// healthy guests a few seconds after joining.
function startHostWatchdog() {
  let present = new Set();
  let seenHost = false;
  S.transport.onPresence((p) => { present = p; });
  S.watchdog = setInterval(() => {
    const m = S.mirror;
    if (!m || m.roomDead || !m.hostId || m.isHost()) return;
    if (present.has(m.hostId)) {
      seenHost = true;
      S.hostMissingSince = 0;
    } else if (seenHost) {
      if (!S.hostMissingSince) S.hostMissingSince = now();
      else if (now() - S.hostMissingSince > LEAVE_GRACE_MS) {
        clearInterval(S.watchdog);
        m.roomDead = true;
        m.fire('roomdead', {});
      }
    }
  }, 1000);
}

async function quitToMenu() {
  try {
    if (S.engine) { S.engine.shutdown(); S.engine = null; }
    else if (S.mirror && S.mirror.players.some((p) => p.id === S.selfId)) S.mirror.quit();
    if (S.transport) await S.transport.leave();
  } catch { /* leaving anyway */ }
  const url = new URL(location.href);
  url.search = transportKind === 'local' ? '?t=local' : '';
  if (DEBUG) url.search += (url.search ? '&' : '?') + 'debug=1';
  sessionStorage.removeItem(STORE.id); // fresh identity next time
  location.href = url.toString();
}

// Leaving the tab entirely: tell the room (best effort).
window.addEventListener('pagehide', () => {
  try {
    if (S.engine) S.engine.shutdown();
    else if (S.mirror && S.mirror.started) S.mirror.quit();
  } catch { /* closing */ }
});

// ---------- debug handle for the E2E suite (?debug=1) ----------
function installDebug() {
  if (!DEBUG) return;
  // record every envelope crossing this page
  window.__wireLog = [];
  S.net.onAny((env) => window.__wireLog.push(JSON.stringify(env)));
  window.__topple = {
    code: S.code,
    selfId: S.selfId,
    net: S.net,
    mirror: S.mirror,
    engine: S.engine,
    ui,
    // engine-side helpers (host page only)
    setScore: (pid, n) => S.engine && S.engine._debugSetScore(pid, n),
    setLevel: (n) => S.engine && S.engine._debugSetLevel(n),
    setSettings: (patch) => S.engine && S.engine.setSettings(patch),
    engineState: () => S.engine && {
      started: S.engine.started,
      over: S.engine.over,
      tower: S.engine.tower && {
        stage: S.engine.tower.stage, height: S.engine.tower.height,
        combo: S.engine.tower.combo, constraint: S.engine.tower.constraint,
        lives: { ...S.engine.tower.lives }, used: S.engine.tower.used.size,
        rampWords: S.engine.tower.rampWords, hungerMs: S.engine.tower.hungerMs,
        difficulty: S.engine.tower.difficulty,
        buried: Object.fromEntries(Object.entries(S.engine.tower.buried)
          .map(([pid, d]) => [pid, { cleared: d.cleared, words: [...d.words] }])),
        offer: S.engine.tower.offer ? { options: S.engine.tower.offer.options } : null,
        rows: S.engine.tower.rows.map((r) => ({ ...r })),
      },
      players: S.engine.players.map((p) => ({ ...p })),
    },
    // client-side helpers (any page)
    state: () => ({
      selfId: S.selfId,
      hostId: S.mirror.hostId,
      started: S.mirror.started,
      over: S.mirror.over,
      settings: S.mirror.settings && { ...S.mirror.settings },
      players: S.mirror.players.map((p) => ({ ...p })),
      tower: S.mirror.tower && {
        stage: S.mirror.tower.stage, height: S.mirror.tower.height,
        combo: S.mirror.tower.combo, constraint: S.mirror.tower.constraint,
        lives: { ...S.mirror.tower.lives },
        paused: S.mirror.isPaused(),
        pausedBy: S.mirror.pausedBy(),
        digNeed: S.mirror.digNeed(),
        offer: S.mirror.tower.offer
          ? { options: S.mirror.tower.offer.options.map((c) => ({ ...c })) } : null,
        run: S.mirror.tower.run ? { ...S.mirror.tower.run } : null,
        rows: S.mirror.tower.rows.map((r) => ({ ...r })),
        buried: Object.fromEntries(Object.entries(S.mirror.tower.buried)
          .map(([k, v]) => [k, { cleared: v.cleared }])),
      },
      gameover: S.mirror.gameover && { ...S.mirror.gameover },
      intermission: S.mirror.intermission && { ...S.mirror.intermission },
      input: S.mirror.input,
      inputLocked: S.mirror.inputLocked(),
      roomDead: S.mirror.roomDead,
      joinError: S.mirror.joinError,
    }),
    // drive the game like a player (bypasses Playwright's pointer, not the engine)
    guess: (word) => {
      const m = S.mirror;
      m.input = word.toLowerCase();
      return m.enter();
    },
    type: (ch) => S.mirror.type(ch),
    enter: () => S.mirror.enter(),
    backspace: () => S.mirror.backspace(),
    buy: (item, target) => S.mirror.buy(item, target),
    pickDecree: (i) => S.mirror.pickDecree(i),
    ready: () => S.mirror.ready(),
    quit: () => quitToMenu(),
  };
}

// ---------- entry ----------
const joinCode = qs.get('join');
if (joinCode) {
  const name = localStorage.getItem(STORE.name) || ui.playerName();
  joinGame(joinCode, name);
}
