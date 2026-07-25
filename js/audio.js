// All sound is synthesized with WebAudio - no audio files. The palette is
// mechanical on purpose: typewriter key strikes, a carriage-return bell,
// stone-on-stone thunks as floors land, and a long structural groan when the
// tower comes down. The on/off toggle persists in localStorage.

import { STORE } from './config.js';

let ctx = null;
let master = null;
let enabled = localStorage.getItem(STORE.sound) !== 'off';

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function soundEnabled() { return enabled; }
export function setSound(on) {
  enabled = on;
  localStorage.setItem(STORE.sound, on ? 'on' : 'off');
}

function tone({ freq = 440, type = 'sine', dur = 0.12, gain = 0.5, at = 0, slide = 0 }) {
  if (!enabled) return;
  try {
    const c = ac();
    const t0 = c.currentTime + at;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(24, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  } catch { /* audio unavailable */ }
}

// Filtered noise burst - the mechanical half of everything here. `q` tightens
// the band (high q = a struck key, low q = a wash of debris).
function noise({ dur = 0.15, gain = 0.3, at = 0, freq = 1200, q = 1, type = 'bandpass' }) {
  if (!enabled) return;
  try {
    const c = ac();
    const t0 = c.currentTime + at;
    const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
  } catch { /* audio unavailable */ }
}

// A struck typebar: a hard click plus a short pitched body.
function strike({ at = 0, gain = 0.3, body = 220, bright = 2600 } = {}) {
  noise({ dur: 0.035, gain: gain * 0.9, at, freq: bright, q: 1.4 });
  tone({ freq: body, type: 'square', dur: 0.03, gain: gain * 0.35, at });
}

// Stone landing on stone: low thump with a dusty tail.
function thunk({ at = 0, gain = 0.4, freq = 120 } = {}) {
  tone({ freq, type: 'sine', dur: 0.22, gain, at, slide: -55 });
  noise({ dur: 0.14, gain: gain * 0.35, at, freq: 380, q: 0.7 });
}

export const sfx = {
  // ---- the typewriter ----
  key: () => strike({ body: 200 + Math.random() * 60, bright: 2400 + Math.random() * 900 }),
  back: () => { noise({ dur: 0.05, gain: 0.22, freq: 900, q: 1.2 }); tone({ freq: 130, type: 'square', dur: 0.04, gain: 0.18 }); },
  invalid: () => { // a jammed typebar
    tone({ freq: 96, type: 'sawtooth', dur: 0.16, gain: 0.28, slide: -34 });
    noise({ dur: 0.18, gain: 0.22, freq: 320, q: 0.6, at: 0.02 });
  },
  // carriage return: the bell, then the slide
  bell: () => { tone({ freq: 1720, type: 'sine', dur: 0.5, gain: 0.3 }); tone({ freq: 2580, type: 'sine', dur: 0.35, gain: 0.1 }); },
  ret: () => { sfx.bell(); noise({ dur: 0.22, gain: 0.16, freq: 1500, q: 0.5, at: 0.06 }); },

  // ---- the tower ----
  land: (i = 0) => { thunk({ at: 0, gain: 0.42, freq: 132 - Math.min(60, i * 2) }); noise({ dur: 0.07, gain: 0.12, freq: 2200, q: 1.1, at: 0.01 }); },
  points: () => [1245, 1568, 1865].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.09, gain: 0.16, at: i * 0.045 })),
  combo: (n = 2) => tone({ freq: 620 + Math.min(8, n) * 90, type: 'triangle', dur: 0.1, gain: 0.22, slide: 260 }),
  crack: () => { // a life lost: masonry splitting
    noise({ dur: 0.24, gain: 0.3, freq: 620, q: 0.5 });
    tone({ freq: 150, type: 'sawtooth', dur: 0.26, gain: 0.24, slide: -70 });
  },
  hunger: () => { // the tower groans for a word
    tone({ freq: 88, type: 'sine', dur: 0.9, gain: 0.3, slide: -26 });
    tone({ freq: 133, type: 'triangle', dur: 0.7, gain: 0.12, at: 0.05, slide: -40 });
    noise({ dur: 0.7, gain: 0.1, freq: 240, q: 0.4, at: 0.1 });
  },
  collapse: () => { // the whole structure comes down
    tone({ freq: 140, type: 'sawtooth', dur: 2.0, gain: 0.34, slide: -118 });
    noise({ dur: 2.2, gain: 0.3, freq: 300, q: 0.25, type: 'lowpass' });
    for (let i = 0; i < 14; i++) {
      noise({ dur: 0.12, gain: 0.12, freq: 500 + Math.random() * 2200, q: 1.2, at: 0.15 + Math.random() * 1.5 });
    }
  },
  stage: () => { sfx.bell(); [392, 523, 659].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.16, gain: 0.2, at: 0.08 + i * 0.075 })); },
  heart: () => [784, 1047, 1319].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.18, gain: 0.22, at: i * 0.08 })),
  bless: () => { sfx.bell(); [523, 659, 784, 1047, 1319].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.22, gain: 0.2, at: 0.1 + i * 0.09 })); },

  // ---- rescue / chrome ----
  flip: (i = 0) => strike({ at: i * 0.055, gain: 0.26, body: 240 + i * 40, bright: 2000 + i * 260 }),
  solve: () => [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.16, gain: 0.28, at: i * 0.08 })),
  fail: () => [262, 208, 156].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.24, gain: 0.26, at: i * 0.14 })),
  buy: () => { noise({ dur: 0.06, gain: 0.2, freq: 1800, q: 1.5 }); tone({ freq: 880, type: 'triangle', dur: 0.1, gain: 0.22, at: 0.05, slide: 320 }); },
  join: () => { strike({ gain: 0.25 }); tone({ freq: 660, type: 'triangle', dur: 0.14, gain: 0.2, at: 0.03, slide: 180 }); },
  pop: () => tone({ freq: 980, type: 'sine', dur: 0.07, gain: 0.2, slide: 260 }),
  win: () => [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.2, gain: 0.18, at: i * 0.09 })),
};
