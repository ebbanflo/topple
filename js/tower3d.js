// The tower, as an actual three-dimensional object.
//
// Pure CSS 3D: every floor is a real slab with front/top/left/right faces in a
// `preserve-3d` scene, so the stack has genuine depth, parallax and occlusion -
// and the letters stay selectable text rather than a texture. Nothing here
// touches game state; it renders whatever rows it is handed.
//
// This module is deliberately swappable: the whole surface is
// `sync / push / miss / stress / collapse / reset`, so a WebGL renderer could
// take its place without any other file changing.

import { TOWER } from './config.js';
import { el } from './util.js';

const VISIBLE = TOWER.visibleRows;
const rnd = (a, b) => a + Math.random() * (b - a);

export class Tower3D {
  // root: the element that owns the perspective (see .t3d-stage in style.css)
  constructor(root) {
    this.root = root;
    this.camera = el('div', { class: 't3d-camera' });
    this.world = el('div', { class: 't3d-world' });
    this.ground = el('div', { class: 't3d-ground' },
      el('div', { class: 't3d-ground-face' }));
    this.world.append(this.ground);
    this.camera.append(this.world);
    root.replaceChildren(this.camera);
    this.floors = new Map(); // absolute floor index -> element
    this.count = 0;          // absolute floors ever placed (this render pass)
    this.base = 0;           // absolute index of the bottom-most mounted floor
    this.collapsed = false;
    this.setYaw(0);
    this.fit();
    // The band the tower gets is whatever the rest of the screen leaves over,
    // and on a phone that changes when Safari's toolbars collapse or the device
    // rotates. Re-fit on every one of those.
    if (window.ResizeObserver) {
      this._ro = new ResizeObserver(() => this.fit());
      this._ro.observe(this.root);
    }
    window.addEventListener('orientationchange', () => setTimeout(() => this.fit(), 250));
  }

  // Size a floor so that a FULL stack (TOWER.visibleRows of them) fits inside
  // the space this renderer actually has, instead of being clipped off the top.
  // Everything about a slab scales off --fh, so this one number does it all.
  fit() {
    const h = this.root.clientHeight;
    if (!h) return;
    // 0.82 leaves room for the ground offset below and the landing animation's
    // overshoot above; the clamp keeps floors legible on tiny screens and stops
    // them ballooning on a desktop monitor.
    const fh = Math.max(13, Math.min(30, (h * 0.82) / VISIBLE));
    this.root.style.setProperty('--fh', `${fh.toFixed(2)}px`);
    this.root.style.setProperty('--fd', `${(fh * 1.25).toFixed(2)}px`);
    this.root.style.setProperty('--glyph', `${Math.max(10, Math.min(17, fh * 0.68)).toFixed(2)}px`);
  }

  // Idle drift: a slow yaw so the structure reads as solid without the player
  // touching anything. Driven by the UI ticker.
  setYaw(deg) {
    this.camera.style.setProperty('--yaw', `${deg}deg`);
  }

  // 0..1 - how close the hunger clock is to striking. Past the threshold the
  // whole structure starts to shiver.
  stress(pct) {
    this.root.classList.toggle('stressed', pct > 0.7 && !this.collapsed);
  }

  reset() {
    this.collapsed = false;
    this.root.classList.remove('collapsing', 'stressed');
    for (const node of this.floors.values()) node.remove();
    this.floors.clear();
    this.count = 0;
    this.base = 0;
    this.world.style.setProperty('--base', '0');
  }

  // Full rebuild from an authoritative row list (start of run, resync).
  sync(rows, colorFor) {
    this.reset();
    const start = Math.max(0, rows.length - VISIBLE);
    this.count = start;
    for (let i = start; i < rows.length; i++) this._mount(rows[i], colorFor, false);
    this._settleBase();
  }

  // One new floor lands. `instant` skips the entrance animation.
  push(row, colorFor) {
    if (this.collapsed) return;
    this._mount(row, colorFor, true);
    this._settleBase();
  }

  _mount(row, colorFor, animate) {
    const idx = this.count++;
    const accent = colorFor(row.pid) || 'currentColor';
    const slab = el('div', { class: 't3d-slab' });
    const front = el('div', { class: 't3d-face t3d-front' });
    for (const ch of row.word) {
      front.append(el('span', { class: 't3d-glyph', text: ch.toUpperCase() }));
    }
    front.append(el('span', { class: 't3d-pts', text: `+${row.points.toLocaleString('en-US')}` }));
    slab.append(
      front,
      el('div', { class: 't3d-face t3d-top' }),
      el('div', { class: 't3d-face t3d-side t3d-left' }),
      el('div', { class: 't3d-face t3d-side t3d-right' }),
    );
    const floor = el('div', {
      class: 't3d-floor' + (animate ? ' landing' : ''),
      'data-testid': `floor-${idx}`,
      'data-word': row.word,
      style: {
        '--i': String(idx),
        '--sig': accent,
        // hand-stacked jitter: no two floors sit perfectly square
        '--jx': `${rnd(-1.8, 1.8)}px`,
        '--jr': `${rnd(-0.65, 0.65)}deg`,
      },
    }, slab);
    this.floors.set(idx, floor);
    this.world.append(floor);
    if (animate) {
      // let the browser paint the pre-animation state before releasing it
      requestAnimationFrame(() => floor.classList.add('landed'));
    } else {
      floor.classList.add('landed');
    }
  }

  // Keep exactly VISIBLE floors mounted and slide the world down by one floor
  // per new arrival - the transition on .t3d-world is the camera climbing.
  _settleBase() {
    const newBase = Math.max(0, this.count - VISIBLE);
    for (let i = this.base; i < newBase; i++) {
      const node = this.floors.get(i);
      if (node) {
        node.classList.add('sinking');
        setTimeout(() => node.remove(), 420);
        this.floors.delete(i);
      }
    }
    this.base = newBase;
    this.world.style.setProperty('--base', String(newBase));
  }

  // A life lost: the structure takes the hit but stays up.
  miss() {
    if (this.collapsed) return;
    this.root.classList.remove('jolt');
    void this.root.offsetWidth;
    this.root.classList.add('jolt');
  }

  // A blessing: light runs up the stack.
  bless() {
    let i = 0;
    for (const node of [...this.floors.values()]) {
      node.classList.remove('blessed');
      void node.offsetWidth;
      node.style.setProperty('--bless-delay', `${i++ * 45}ms`);
      node.classList.add('blessed');
    }
  }

  // The tower falls. Bottom floors buckle first; everything above follows and
  // tumbles out of frame.
  collapse() {
    if (this.collapsed) return;
    this.collapsed = true;
    this.root.classList.remove('stressed');
    this.root.classList.add('collapsing');
    const nodes = [...this.floors.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
    nodes.forEach((node, i) => {
      const dir = Math.random() < 0.5 ? -1 : 1;
      node.style.setProperty('--fall-delay', `${i * 55}ms`);
      node.style.setProperty('--fall-x', `${dir * rnd(40, 190)}px`);
      node.style.setProperty('--fall-z', `${rnd(-90, 140)}px`);
      node.style.setProperty('--fall-spin', `${dir * rnd(28, 115)}deg`);
      node.style.setProperty('--fall-tip', `${rnd(-70, 70)}deg`);
      node.classList.add('falling');
    });
  }
}
