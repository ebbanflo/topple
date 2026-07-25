// THE single registry of broadcast event types. Every message on the wire is
// the envelope {t, from, d} sent under the one broadcast event name 'game'.
//
// TRAP GUARD: `HOST_BROADCASTS` lists every event type the host can emit.
// client.js asserts at startup that it has a handler for each one - adding a
// host event here without wiring a guest handler throws immediately instead
// of guests silently ignoring it.

export const EVENT_NAME = 'game';

// ---- intents: player -> host -------------------------------------------
export const IN = {
  JOIN: 'join',         // {name}
  GUESS: 'guess',       // {x: obfuscated word}  (a tower word, or a dig word)
  BUY: 'buy',           // {item, target?}
  QUIT: 'quit',         // {} (sender leaves; host handles + mirrors)
  DECREE_PICK: 'pick',  // {index} choose one of the offered decrees
  READY: 'ready',       // {} ASCENT: leave the intermission, start the next storey
  RESYNC: 'resyncreq',  // {} ask host for a full snapshot
};

// ---- broadcasts: host -> everyone (or addressed via d.to) ----------------
export const EV = {
  LOBBY: 'lobby',        // {players, settings, hostId, started}
  JOIN_ERR: 'joinerr',   // {to, reason}
  START: 'start',        // {settings, players}
  SCORES: 'scores',      // {scores, buyer?, item?}
  SHOP_ERR: 'shoperr',   // {to, reason}
  DECREE_OFFER: 'offer', // {stage, options:[constraint], ms} pick one, first pick wins
  INTERMISSION: 'inter', // ASCENT: {storey, quota, storeyScore, mortar, earned, last}
  TOWER: 'twr',          // {stage, constraint, height, hungerMs, lives, scores, combo, pickedBy?}
  TOWER_WORD: 'twrword', // {pid, word, points, height, combo, stage}
  TOWER_MISS: 'twrmiss', // {pid, word, reason, lives, combo}
  TOWER_HUNGER: 'twrhunger', // {lives, downed}
  DIG: 'dig',            // {phase:'buried'|'clear'|'out', pid, cleared, need, word?, by?, lives?}
  TOWER_BONUS: 'twrbonus',   // {reason:'milestone'|'spelled', lives, height} - team-wide heart
  PLAYER_LEFT: 'left',   // {pid}
  GAME_OVER: 'gameover', // {standings, winner, reason, height, stage, won?, storey?}
  ROOM_DEAD: 'roomdead', // {} host is closing the room
  RESYNC: 'resync',      // {to, snapshot}
};

export const HOST_BROADCASTS = Object.values(EV);
export const INTENTS = Object.values(IN);

const all = [...HOST_BROADCASTS, ...INTENTS];
if (new Set(all).size !== all.length) {
  throw new Error('protocol.js: duplicate event type in registry');
}
