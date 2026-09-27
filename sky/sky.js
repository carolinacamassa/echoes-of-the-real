/* The Sky of Echoes: renders window.SKY (built by build_sky.py) as a night sky.
 *
 * It opens like an old film: a title card, then the Dreamer's verse, and an
 * iris that opens onto the sky. The sky itself has three layers under one
 * camera. A canvas draws the deep field: a band of dust and the places of the
 * myth as stippled nebulae, over a soft blur, and several thousand stars as
 * single pixels and small engraved sparkles. Above it one "world" element holds
 * the constellations as SVG (gold star glyphs on a faint atlas grid) and their
 * names as HTML, moved with a single CSS transform. The pointer acts like a
 * lantern: figures near it show faintly, and the one under it traces itself in.
 */
(() => {
  'use strict';

  const SKY = window.SKY;
  if (!SKY) return;

  const W = SKY.sky.width;
  const H = SKY.sky.height;
  const MX = SKY.sky.marginX;
  const LAST = SKY.corpus.chapters;
  const BIN = SKY.corpus.bin;
  const CONS = SKY.constellations;
  const NEBS = SKY.nebulae;
  const byId = new Map([...CONS, ...NEBS].map((o) => [o.id, o]));

  const $ = (sel, root = document) => root.querySelector(sel);
  const fmt = (n) => n.toLocaleString('en-US');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeIn = (t) => t * t * (1.6 * t - 0.6);
  const GREEK = 'αβγδεζηθικλμνξοπρστυφχψω';
  const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
  const NS = 'http://www.w3.org/2000/svg';

  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reduceQuery.matches;
  reduceQuery.addEventListener?.('change', (e) => { reduced = e.matches; });

  const isTouch = matchMedia('(hover: none)').matches;
  if (isTouch) document.body.classList.add('touch');
  // Set here as well as in the markup, for hosts that supply their own <body>.
  document.body.classList.add('overture-open');

  const chapterX = (c) => MX + ((c - 1) / (LAST - 1)) * (W - 2 * MX);
  const eclipticY = (x) => H * 0.62 - H * 0.2 * Math.sin(Math.PI * clamp((x - MX) / (W - 2 * MX), 0, 1));

  function svgEl(tag, attrs = {}, parent) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
  }

  function seeded(seed) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A hand-drawn star: n points, with every other point shorter when `alt`
  // is set, like the eight-pointed stars painted on old altarpieces.
  function starPath(R, n = 6, inner = 0.36, rot = -Math.PI / 2, alt = 0) {
    let d = '';
    for (let k = 0; k < n * 2; k++) {
      const outer = k % 2 === 0;
      const long = outer && (k / 2) % 2 === 1 ? 1 - alt : 1;
      const r = outer ? R * long : R * inner;
      const a = rot + (k * Math.PI) / n;
      d += `${k ? 'L' : 'M'}${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
    }
    return `${d}Z`;
  }

  // ---------------------------------------------------------------- text fills

  const fills = {
    sub: `${CONS.length} figures, ${NEBS.length} nebulae, ${fmt(LAST)} chapters`,
    catalogue: `Brightest first. The number beside each name is how many times the ${fmt(LAST)} chapters name it.`,
    'about-1': `This sky is drawn from the ${fmt(LAST)} chapters of Echoes of the Real, about ${fmt(Math.round(SKY.corpus.words / 1000) * 1000)} words in which the same figures keep returning under the same names, as different beings in different ages of the story. Each constellation is one of those recurring names. The names were found by counting every capitalised word and title across the chapters, and each one was read in context before it was given a place here.`,
  };
  document.querySelectorAll('[data-fill]').forEach((el) => {
    const text = fills[el.dataset.fill];
    if (text) el.textContent = text;
  });

  // ---------------------------------------------------------------- film grain

  (function makeGrain() {
    // One tile of monochrome noise, light and dark specks on transparent.
    // The page's copy is jumped around by CSS a dozen times a second; the
    // paper's copy is fainter and stays still.
    const tile = (strength) => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const g = c.getContext('2d');
      const img = g.createImageData(256, 256);
      const r = seeded(77);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = r();
        const tone = v > 0.5 ? 255 : 0;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = tone;
        img.data[i + 3] = Math.pow(Math.abs(v - 0.5) * 2, 1.5) * 255 * strength;
      }
      g.putImageData(img, 0, 0);
      return `url(${c.toDataURL()})`;
    };
    $('.grain').style.backgroundImage = tile(1);
    document.documentElement.style.setProperty('--paper-grain', tile(0.16));
  })();

  // -------------------------------------------------------------------- camera

  const canvas = $('#heavens');
  const ctx = canvas.getContext('2d');
  const viewport = $('#viewport');
  const world = $('#world');
  const svg = $('#figures');
  const labelLayer = $('#labels');

  const view = { w: 0, h: 0, dpr: 1, fit: 1, s: 1 };
  const cam = { x: W / 2, y: H / 2 };
  const par = { x: 0, y: 0, tx: 0, ty: 0 };
  let camTween = null;
  let lastTransform = '';
  let lastScaleChange = 0;
  let labelsDirty = true;

  function resize() {
    view.w = window.innerWidth;
    view.h = window.innerHeight;
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
    const fit = Math.min(view.w / W, view.h / H);
    // On a tall phone, fill the height and let the reader pan across instead
    // of shrinking the whole sky into a strip.
    const oldFit = view.fit;
    view.fit = Math.max(fit, (view.h / H) * 0.78);
    view.s = clamp(view.s * (view.fit / oldFit), view.fit, view.fit * 3);
    setScale(view.s);
    clampCam();
    sizeLeader();
  }

  function setScale(s) {
    view.s = clamp(s, view.fit, view.fit * 3);
    world.style.setProperty('--px', (1 / view.s).toFixed(4));
    // Stars grow and shrink with the square root of the zoom, so they stay
    // legible on a phone and do not balloon when the reader zooms in.
    world.style.setProperty('--ss', Math.sqrt(0.6 / view.s).toFixed(4));
    labelsDirty = true;
    lastScaleChange = performance.now();
  }

  function camBounds() {
    const hw = view.w / (2 * view.s);
    const hh = view.h / (2 * view.s);
    const slack = 60;
    const extraRight = folioOpen && view.w > 760 ? Math.min(480, view.w) / view.s : 0;
    const extraBottom = folioOpen && view.w <= 760 ? (view.h * 0.84) / view.s : 0;
    const bx = W <= 2 * hw ? [W / 2, W / 2] : [hw - slack, W - hw + slack + extraRight];
    const by = H <= 2 * hh ? [H / 2, H / 2] : [hh - slack, H - hh + slack + extraBottom];
    if (extraRight && W <= 2 * hw) bx[1] = W / 2 + extraRight;
    if (extraBottom && H <= 2 * hh) by[1] = H / 2 + extraBottom;
    return { bx, by };
  }

  function clampCam() {
    const { bx, by } = camBounds();
    cam.x = clamp(cam.x, bx[0], bx[1]);
    cam.y = clamp(cam.y, by[0], by[1]);
  }

  function transform() {
    const s = view.s;
    return {
      s,
      tx: view.w / 2 - cam.x * s + par.x,
      ty: view.h / 2 - cam.y * s + par.y,
    };
  }

  function toWorld(px, py) {
    const t = transform();
    return { x: (px - t.tx) / t.s, y: (py - t.ty) / t.s };
  }

  function flyTo(x, y, duration = 1100) {
    const { bx, by } = camBounds();
    const to = { x: clamp(x, bx[0], bx[1]), y: clamp(y, by[0], by[1]) };
    if (reduced) {
      cam.x = to.x;
      cam.y = to.y;
      camTween = null;
      return;
    }
    camTween = { from: { x: cam.x, y: cam.y }, to, t0: performance.now(), duration };
  }

  // Where to point the camera so a figure sits in the part of the screen the
  // open panel leaves free.
  function focusPoint(item) {
    let x = item.x;
    let y = item.y;
    if (folioOpen) {
      if (view.w > 760) x += Math.min(480, view.w) / (2 * view.s);
      else y += (view.h * 0.84) / (2 * view.s) - 20 / view.s;
    }
    return { x, y };
  }

  // ------------------------------------------------------------- background

  const rand = seeded(1108);
  const FIELD = { x0: -0.6 * W, y0: -0.8 * H, w: 2.2 * W, h: 2.6 * H };
  // The band of dust runs corner to corner, a little bowed, like our own
  // galaxy seen edge-on but tilted the other way.
  const bandAt = (t) => ({
    x: FIELD.x0 + FIELD.w * (0.12 + 0.76 * t),
    y: FIELD.y0 + FIELD.h * (0.78 - 0.56 * t) + Math.sin(t * Math.PI) * H * 0.18,
  });

  function gauss() {
    return (rand() + rand() + rand() + rand() - 2) / 2;
  }

  // Bone, a cool ash and a warm grey: the whole sky is nearly monochrome.
  const TINTS = [[236, 228, 210], [236, 228, 210], [236, 228, 210], [178, 190, 204], [178, 190, 204], [214, 200, 176]];
  const TINT_CSS = TINTS.map((t) => `rgb(${t.join(',')})`);

  const stars = [];
  function addStar(x, y, bright) {
    stars.push({
      x, y,
      // Most stars are single pixels; the bright few are small sparkles.
      kind: bright ? 'spark' : 'px',
      r: bright ? 0.7 + Math.pow(rand(), 2.5) * 1.3 : rand() < 0.14 ? 2 : 1,
      a: bright ? 0.5 + rand() * 0.45 : 0.18 + rand() * 0.5,
      tint: Math.floor(rand() * TINTS.length),
      tw: rand() < 0.45 ? 0.7 + rand() * 2.2 : 0,
      ph: rand() * Math.PI * 2,
      depth: bright ? 0.82 : 0.6,
    });
  }
  for (let i = 0; i < 1700; i++) addStar(FIELD.x0 + rand() * FIELD.w, FIELD.y0 + rand() * FIELD.h, rand() < 0.07);
  for (let i = 0; i < 1900; i++) {
    const p = bandAt(rand());
    addStar(p.x + gauss() * 90, p.y + gauss() * 260, rand() < 0.04);
  }
  stars.sort((a, b) => a.depth - b.depth);

  // A soft round glow, stamped under the brighter sparkles.
  const glowSprite = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(250,244,230,1)');
    grad.addColorStop(0.2, 'rgba(250,244,230,0.7)');
    grad.addColorStop(0.5, 'rgba(250,244,230,0.12)');
    grad.addColorStop(1, 'rgba(250,244,230,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    return c;
  })();

  // One soft blur pass hides the gradient banding that upscaling would show.
  function softenCanvas(target, px) {
    const copy = document.createElement('canvas');
    copy.width = target.width;
    copy.height = target.height;
    copy.getContext('2d').drawImage(target, 0, 0);
    const g = target.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'copy';
    g.filter = `blur(${px}px)`;
    g.drawImage(copy, 0, 0);
    g.filter = 'none';
    g.globalCompositeOperation = 'source-over';
  }

  // Turn a soft field into stipple: each texel becomes a dot, or nothing,
  // with a chance that follows the field's density. Drawn without smoothing,
  // the dots stay square, halfway between an engraver's stipple and a pixel.
  function stipple(src, gain, curve, seed) {
    const w = src.width;
    const h = src.height;
    const data = src.getContext('2d').getImageData(0, 0, w, h).data;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const g = out.getContext('2d');
    const img = g.createImageData(w, h);
    const d = img.data;
    const r = seeded(seed);
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      if (!a) continue;
      const p = Math.pow(Math.min(1, a * gain), curve);
      if (r() < p) {
        d[i] = (data[i] + 236) / 2;
        d[i + 1] = (data[i + 1] + 228) / 2;
        d[i + 2] = (data[i + 2] + 210) / 2;
        d[i + 3] = 110 + r() * 145;
      }
    }
    g.putImageData(img, 0, 0);
    return out;
  }

  // The dust band and the nebulae are painted once into offscreen canvases:
  // a blurred glow for low focus, and a stipple of it for fine detail.
  const DUST_K = 0.3;
  const dust = document.createElement('canvas');
  dust.width = Math.round(FIELD.w * DUST_K);
  dust.height = Math.round(FIELD.h * DUST_K);
  (function paintDust() {
    const g = dust.getContext('2d');
    g.scale(DUST_K, DUST_K);
    g.translate(-FIELD.x0, -FIELD.y0);
    g.globalCompositeOperation = 'lighter';
    const hues = [[140, 152, 166], [152, 148, 138], [120, 134, 152]];
    for (let i = 0; i < 280; i++) {
      const p = bandAt(rand());
      const x = p.x + gauss() * 150;
      const y = p.y + gauss() * 240;
      const r = 160 + rand() * 440;
      const [cr, cg, cb] = hues[Math.floor(rand() * hues.length)];
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      const a = 0.016 + rand() * 0.03;
      grad.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
      grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // Dark lanes through the middle of the band.
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 110; i++) {
      const p = bandAt(rand());
      const x = p.x + gauss() * 60 + 60;
      const y = p.y + gauss() * 90 - 40;
      const r = 80 + rand() * 220;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(0,0,0,0.35)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    softenCanvas(dust, 6);
  })();
  const dustDots = stipple(dust, 0.95, 1.45, 31);

  // Places keep a faint tint of their own, well short of colour.
  const NEB_TINTS = {
    garden: [150, 180, 162],
    pearl: [212, 208, 228],
    amber: [216, 192, 150],
    rose: [214, 176, 184],
    blue: [160, 180, 208],
    violet: [184, 172, 210],
  };
  const NEB_K = 0.35;
  const nebLayer = document.createElement('canvas');
  nebLayer.width = Math.round(W * NEB_K);
  nebLayer.height = Math.round(H * NEB_K);
  (function paintNebulae() {
    const g = nebLayer.getContext('2d');
    g.scale(NEB_K, NEB_K);
    g.globalCompositeOperation = 'lighter';
    for (const n of NEBS) {
      const r0 = n.radius;
      const [cr, cg, cb] = NEB_TINTS[n.hue] || NEB_TINTS.violet;
      const local = seeded(n.id.length * 7919 + Math.round(n.x));
      for (let i = 0; i < 46; i++) {
        const ang = local() * Math.PI * 2;
        const dist = Math.pow(local(), 0.8) * r0 * 0.75;
        const x = n.x + Math.cos(ang) * dist * 1.25;
        const y = n.y + Math.sin(ang) * dist * 0.8;
        const r = r0 * (0.22 + local() * 0.5);
        const a = 0.03 + local() * 0.045;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
        grad.addColorStop(0.6, `rgba(${cr},${cg},${cb},${a * 0.35})`);
        grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      const core = g.createRadialGradient(n.x, n.y, 0, n.x, n.y, r0 * 0.35);
      core.addColorStop(0, `rgba(${cr},${cg},${cb},0.12)`);
      core.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      g.fillStyle = core;
      g.fillRect(n.x - r0, n.y - r0, r0 * 2, r0 * 2);
      n._stars = Array.from({ length: 22 }, () => {
        const ang = local() * Math.PI * 2;
        const dist = Math.pow(local(), 0.7) * r0 * 0.6;
        return { x: n.x + Math.cos(ang) * dist * 1.2, y: n.y + Math.sin(ang) * dist * 0.8, r: 0.6 + local() * 1.1, a: 0.4 + local() * 0.5 };
      });
    }
    softenCanvas(nebLayer, 5);
  })();
  const nebDots = stipple(nebLayer, 1.7, 1.3, 53);

  const meteors = [];
  let nextMeteor = performance.now() + 9000;

  function layerOffset(t, depth) {
    // Far layers move less than the constellations when the camera pans.
    const homeX = view.w / 2 - (W / 2) * t.s;
    const homeY = view.h / 2 - (H / 2) * t.s;
    return { x: homeX + (t.tx - homeX) * depth, y: homeY + (t.ty - homeY) * depth };
  }

  function drawSky(now) {
    const t = transform();
    const { w, h, dpr } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#060709');
    bg.addColorStop(0.6, '#090a0d');
    bg.addColorStop(1, '#0c0d10');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Dust band, far away: the glow smoothed, the stipple crisp.
    const far = layerOffset(t, 0.55);
    const fx = far.x + FIELD.x0 * t.s;
    const fy = far.y + FIELD.y0 * t.s;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = 0.7;
    ctx.drawImage(dust, fx, fy, FIELD.w * t.s, FIELD.h * t.s);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.34;
    ctx.drawImage(dustDots, Math.round(fx), Math.round(fy), Math.round(FIELD.w * t.s), Math.round(FIELD.h * t.s));

    // Nebulae, at the depth of the figures.
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.8;
    ctx.drawImage(nebLayer, t.tx, t.ty, W * t.s, H * t.s);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 0.7;
    ctx.drawImage(nebDots, Math.round(t.tx), Math.round(t.ty), Math.round(W * t.s), Math.round(H * t.s));
    ctx.imageSmoothingEnabled = true;

    // Background stars.
    const time = now / 1000;
    const zoomBoost = Math.sqrt(view.s / view.fit);
    let off = null;
    let lastDepth = -1;
    for (const st of stars) {
      if (st.depth !== lastDepth) {
        off = layerOffset(t, st.depth);
        lastDepth = st.depth;
      }
      const x = off.x + st.x * t.s;
      const y = off.y + st.y * t.s;
      if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
      let a = st.a;
      if (st.tw && !reduced) a *= 0.66 + 0.34 * Math.sin(time * st.tw + st.ph);
      ctx.globalAlpha = a;
      if (st.kind === 'px') {
        ctx.fillStyle = TINT_CSS[st.tint];
        ctx.fillRect(Math.round(x), Math.round(y), st.r, st.r);
      } else {
        const size = st.r * 7 * zoomBoost;
        ctx.drawImage(glowSprite, x - size / 2, y - size / 2, size, size);
        // Four fine rays, as an engraver marks a bright star.
        const L = st.r * 4.5 * zoomBoost;
        ctx.globalAlpha = a * 0.55;
        ctx.strokeStyle = TINT_CSS[st.tint];
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(x - L, y);
        ctx.lineTo(x + L, y);
        ctx.moveTo(x, y - L);
        ctx.lineTo(x, y + L);
        ctx.stroke();
      }
    }

    // Stars inside the nebulae.
    for (const n of NEBS) {
      for (const st of n._stars) {
        const x = t.tx + st.x * t.s;
        const y = t.ty + st.y * t.s;
        if (x < -6 || y < -6 || x > w + 6 || y > h + 6) continue;
        const size = st.r * 5 * zoomBoost;
        ctx.globalAlpha = st.a * (0.8 + 0.2 * Math.sin(time * 0.7 + st.x));
        ctx.drawImage(glowSprite, x - size / 2, y - size / 2, size, size);
      }
    }

    // The lantern: a faint warmth where the reader is looking.
    if (pointer.inside && !isTouch) {
      const r = 240;
      const grad = ctx.createRadialGradient(pointer.px, pointer.py, 0, pointer.px, pointer.py, r);
      grad.addColorStop(0, 'rgba(236,228,210,0.04)');
      grad.addColorStop(1, 'rgba(236,228,210,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.fillRect(pointer.px - r, pointer.py - r, r * 2, r * 2);
    }

    // An occasional falling star.
    if (!reduced && now > nextMeteor && !document.hidden) {
      const angle = (Math.PI / 5) + rand() * (Math.PI / 8);
      const dir = rand() < 0.5 ? 1 : -1;
      meteors.push({
        x: w * (0.15 + rand() * 0.7), y: h * (0.05 + rand() * 0.35),
        vx: Math.cos(angle) * dir * 900, vy: Math.sin(angle) * 900,
        t0: now, life: 700 + rand() * 500,
      });
      nextMeteor = now + 14000 + rand() * 22000;
    }
    for (let i = meteors.length - 1; i >= 0; i--) {
      const m = meteors[i];
      const k = (now - m.t0) / m.life;
      if (k >= 1) { meteors.splice(i, 1); continue; }
      const hx = m.x + m.vx * k * (m.life / 1000);
      const hy = m.y + m.vy * k * (m.life / 1000);
      const tx2 = hx - m.vx * 0.12;
      const ty2 = hy - m.vy * 0.12;
      const grad = ctx.createLinearGradient(hx, hy, tx2, ty2);
      const a = Math.sin(k * Math.PI) * 0.8;
      grad.addColorStop(0, `rgba(245,240,228,${a})`);
      grad.addColorStop(1, 'rgba(245,240,228,0)');
      ctx.globalAlpha = 1;
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(tx2, ty2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------ figures and names

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  world.style.width = `${W}px`;
  world.style.height = `${H}px`;
  labelLayer.style.width = `${W}px`;
  labelLayer.style.height = `${H}px`;

  const defs = svgEl('defs', {}, svg);
  const glow = svgEl('radialGradient', { id: 'starglow' }, defs);
  svgEl('stop', { offset: '0', 'stop-color': '#fff4dc', 'stop-opacity': '0.9' }, glow);
  svgEl('stop', { offset: '0.22', 'stop-color': '#e2c688', 'stop-opacity': '0.32' }, glow);
  svgEl('stop', { offset: '0.6', 'stop-color': '#caa663', 'stop-opacity': '0.06' }, glow);
  svgEl('stop', { offset: '1', 'stop-color': '#caa663', 'stop-opacity': '0' }, glow);

  // The grid of an old atlas: circles of declination and hour lines around a
  // pole that lies far below the bottom of the sky.
  (function drawGraticule() {
    const g = svgEl('g', { class: 'grat', 'aria-hidden': 'true' }, svg);
    const cx = W / 2;
    const cy = H * 2.9;
    const a0 = -Math.PI / 2 - 0.62;
    const a1 = -Math.PI / 2 + 0.62;
    for (let R = 2350; R <= 4500; R += 175) {
      const x0 = cx + Math.cos(a0) * R;
      const y0 = cy + Math.sin(a0) * R;
      const x1 = cx + Math.cos(a1) * R;
      const y1 = cy + Math.sin(a1) * R;
      svgEl('path', { d: `M${x0.toFixed(1)} ${y0.toFixed(1)}A${R} ${R} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}` }, g);
    }
    for (let a = a0; a <= a1 + 1e-6; a += (a1 - a0) / 14) {
      const x0 = cx + Math.cos(a) * 2350;
      const y0 = cy + Math.sin(a) * 2350;
      const x1 = cx + Math.cos(a) * 4500;
      const y1 = cy + Math.sin(a) * 4500;
      svgEl('path', { d: `M${x0.toFixed(1)} ${y0.toFixed(1)}L${x1.toFixed(1)} ${y1.toFixed(1)}` }, g);
    }
  })();

  // The path of the chapters.
  (function drawEcliptic() {
    const g = svgEl('g', { class: 'ecl', 'aria-hidden': 'true' }, svg);
    let d = '';
    for (let x = MX; x <= W - MX; x += 12) d += `${d ? 'L' : 'M'}${x.toFixed(1)} ${eclipticY(x).toFixed(1)}`;
    svgEl('path', { d }, g);
    const ticks = [1];
    for (let c = 100; c < LAST - 60; c += 100) ticks.push(c);
    ticks.push(LAST);
    for (const c of ticks) {
      const x = chapterX(c);
      const y = eclipticY(x);
      svgEl('line', { x1: x, y1: y - 6, x2: x, y2: y + 6 }, g);
      const label = svgEl('text', { x, y: y + 24, 'text-anchor': 'middle' }, g);
      label.textContent = c === 1 ? 'ch. 1' : c === LAST ? `ch. ${fmt(LAST)}` : fmt(c);
    }
    const name = svgEl('text', { x: chapterX(LAST), y: eclipticY(chapterX(LAST)) + 46, 'text-anchor': 'end', class: 'ecl-name' }, g);
    name.textContent = 'the path of the chapters';
  })();

  function pathFor(item) {
    let d = '';
    for (const line of item.lines) {
      line.forEach((i, k) => {
        const [x, y] = item.stars[i];
        d += `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
      });
    }
    return d;
  }

  function magnitudeWords(m) {
    return `${ORDINAL[m]} magnitude`;
  }

  function figNo(item) {
    return NEBS.includes(item) ? `Nebula ${NEBS.indexOf(item) + 1}` : `Fig. ${CONS.indexOf(item) + 1}`;
  }

  for (const c of CONS) {
    const g = svgEl('g', {
      class: 'con',
      transform: `translate(${c.x} ${c.y})`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${c.name}, a constellation of the ${magnitudeWords(c.magnitude)}, named ${fmt(c.mentions)} times`,
      'data-id': c.id,
    }, svg);
    svgEl('circle', { class: 'hit', r: c.radius * 1.08 }, g);
    const d = pathFor(c);
    svgEl('path', { class: 'glow', d, pathLength: '1' }, g);
    svgEl('path', { class: 'trace', d, pathLength: '1' }, g);
    const local = seeded(c.mentions * 31 + c.stars.length);
    c.stars.forEach(([x, y, size], i) => {
      const st = svgEl('g', { class: 'st' }, g);
      st.style.transform = `translate(${x}px, ${y}px) scale(var(--ss, 1))`;
      const R = size * 2.3;
      svgEl('circle', { class: 'halo', r: size * 6, fill: 'url(#starglow)' }, st);
      if (i === c.alpha) {
        // The brightest star bursts into fine rays when its figure wakes.
        const rays = svgEl('g', { class: 'rays' }, st);
        const n = 30;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + local() * 0.09;
          const r0 = R * 1.3;
          const r1 = R * (2 + local() * 3.4);
          svgEl('line', {
            x1: (Math.cos(a) * r0).toFixed(2), y1: (Math.sin(a) * r0).toFixed(2),
            x2: (Math.cos(a) * r1).toFixed(2), y2: (Math.sin(a) * r1).toFixed(2),
          }, rays);
        }
      }
      const shape = i === c.alpha
        ? starPath(R * 1.3, 8, 0.3, -Math.PI / 2 + (local() - 0.5) * 0.2, 0.42)
        : starPath(R, 6, 0.36, -Math.PI / 2 + (local() - 0.5) * 0.5);
      const glyph = svgEl('path', { class: 'glyph', d: shape }, st);
      glyph.style.setProperty('--tw-d', `${(2.5 + local() * 5).toFixed(2)}s`);
      glyph.style.setProperty('--tw-o', `${(-local() * 8).toFixed(2)}s`);
      svgEl('circle', { class: 'core', r: (R * 0.2).toFixed(2) }, st);
    });
    c._b = {
      minX: Math.min(...c.stars.map((s) => s[0])),
      maxX: Math.max(...c.stars.map((s) => s[0])),
      minY: Math.min(...c.stars.map((s) => s[1])),
      maxY: Math.max(...c.stars.map((s) => s[1])),
    };
    c._g = g;

    const label = document.createElement('div');
    label.className = 'label';
    const nm = document.createElement('span');
    nm.className = 'nm';
    [...c.name.toUpperCase()].forEach((ch, i) => {
      const s = document.createElement('span');
      s.textContent = ch === ' ' ? ' ' : ch;
      s.style.setProperty('--i', i);
      nm.appendChild(s);
    });
    label.appendChild(nm);
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `named ${fmt(c.mentions)} times · ch. ${c.first}–${fmt(c.last)}`;
    label.appendChild(sub);
    const tap = document.createElement('span');
    tap.className = 'tap';
    tap.textContent = 'tap again to read';
    label.appendChild(tap);
    labelLayer.appendChild(label);
    c._label = label;
    c._sweep = (c.x / W) * 2.2;
    g.style.setProperty('--sweep', `${c._sweep.toFixed(2)}s`);

    g.addEventListener('focus', () => {
      setLit(c);
      if (!folioOpen || selected !== c) ensureVisible(c);
    });
    g.addEventListener('blur', () => { if (lit === c && hover !== c) setLit(null); });
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFolio(c);
      }
    });
  }

  for (const n of NEBS) {
    const label = document.createElement('div');
    label.className = 'label neb';
    const nm = document.createElement('span');
    nm.className = 'nm';
    [...n.name].forEach((ch, i) => {
      const s = document.createElement('span');
      s.textContent = ch === ' ' ? ' ' : ch;
      s.style.setProperty('--i', i);
      nm.appendChild(s);
    });
    label.appendChild(nm);
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `a place · named ${fmt(n.mentions)} times`;
    label.appendChild(sub);
    labelLayer.appendChild(label);
    n._label = label;
  }

  // Names go below a figure when there is room, otherwise above, to the
  // right or to the left: brightest figures choose first, and a name may not
  // cover another name or another figure's stars.
  const PLACES = {
    below: (c) => [c.x, c.y + c._b.maxY],
    above: (c) => [c.x, c.y + c._b.minY],
    right: (c) => [c.x + c._b.maxX, c.y],
    left: (c) => [c.x + c._b.minX, c.y],
    center: (n) => [n.x, n.y],
    'neb-above': (n) => [n.x, n.y - n.radius * 0.28],
    'neb-below': (n) => [n.x, n.y + n.radius * 0.28],
  };

  function setPlace(item, place) {
    const [x, y] = PLACES[place](item);
    const el = item._label;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.dataset.place = place;
  }

  function placeLabels() {
    labelsDirty = false;
    const t = transform();
    const pad = 6;
    const boxOf = (c) => ({
      l: t.tx + (c.x + c._b.minX) * t.s - 6,
      r: t.tx + (c.x + c._b.maxX) * t.s + 6,
      t: t.ty + (c.y + c._b.minY) * t.s - 6,
      b: t.ty + (c.y + c._b.maxY) * t.s + 6,
    });
    const figures = CONS.map((c) => ({ c, box: boxOf(c) }));
    const taken = [];
    const overlap = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    const cost = (item, rect) => {
      const box = { l: rect.left - pad, r: rect.right + pad, t: rect.top - pad, b: rect.bottom + pad };
      let total = 0;
      for (const other of taken) total += overlap(box, other) * 3;
      for (const f of figures) if (f.c !== item) total += overlap(box, f.box);
      // Names that would hang off the edge of the sky are a last resort.
      const edgeL = t.tx;
      const edgeR = t.tx + W * t.s;
      const edgeT = t.ty;
      const edgeB = t.ty + H * t.s;
      total += (Math.max(0, edgeL - box.l) + Math.max(0, box.r - edgeR) + Math.max(0, edgeT - box.t) + Math.max(0, box.b - edgeB)) * 40;
      return total;
    };
    const order = [...CONS].sort((a, b) => a.magnitude - b.magnitude || b.mentions - a.mentions);
    for (const item of [...order, ...NEBS]) {
      const places = CONS.includes(item) ? ['below', 'above', 'right', 'left'] : ['center', 'neb-above', 'neb-below'];
      let best = null;
      for (const place of places) {
        setPlace(item, place);
        const rect = item._label.querySelector('.nm').getBoundingClientRect();
        const score = cost(item, rect);
        if (!best || score < best.score) best = { place, score, rect };
        if (score === 0) break;
      }
      setPlace(item, best.place);
      taken.push({ l: best.rect.left - pad, r: best.rect.right + pad, t: best.rect.top - pad, b: best.rect.bottom + pad });
    }
  }

  function ensureVisible(item) {
    const t = transform();
    const sx = t.tx + item.x * t.s;
    const sy = t.ty + item.y * t.s;
    const pad = 120;
    if (sx < pad || sx > view.w - pad || sy < pad || sy > view.h - pad) {
      const p = focusPoint(item);
      flyTo(p.x, p.y, 900);
    }
  }

  // ------------------------------------------------------------ interaction

  const pointer = { px: -1e4, py: -1e4, inside: false };
  let hover = null;     // the figure under the pointer
  let lit = null;       // the figure currently drawn in full
  let selected = null;  // the figure whose folio is open
  let folioOpen = false;
  let armed = null;     // touch: the figure tapped once
  let nearDirty = true;

  function setLit(item) {
    if (lit === item) return;
    if (lit) {
      lit._g?.classList.remove('lit');
      lit._label.classList.remove('lit', 'show-tap');
    }
    lit = item;
    if (lit) {
      lit._g?.classList.add('lit');
      lit._label.classList.add('lit');
      if (armed === lit) lit._label.classList.add('show-tap');
      document.body.classList.add('hint-done');
    }
  }

  function hitTest(wx, wy) {
    let best = null;
    let bestScore = Infinity;
    for (const c of CONS) {
      const d = Math.hypot(wx - c.x, wy - c.y);
      const score = d / c.radius;
      if (score <= 1.08 && score < bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (best) return best;
    for (const n of NEBS) {
      const d = Math.hypot((wx - n.x) / 1.2, (wy - n.y) / 0.8);
      if (d <= n.radius * 0.5) return n;
    }
    return null;
  }

  function updateNear() {
    if (!nearDirty) return;
    nearDirty = false;
    const p = pointer.inside ? toWorld(pointer.px, pointer.py) : { x: -1e5, y: -1e5 };
    const reach = 320 / Math.sqrt(view.s / view.fit);
    for (const c of CONS) {
      const d = Math.max(0, Math.hypot(p.x - c.x, p.y - c.y) - c.radius);
      const near = isTouch ? 0 : Math.pow(clamp(1 - d / reach, 0, 1), 1.6);
      if (Math.abs((c._near || 0) - near) > 0.015 || (near === 0 && c._near)) {
        c._near = near;
        c._g.style.setProperty('--near', near.toFixed(3));
        c._g.classList.toggle('near', near > 0.02);
      }
    }
    const h = pointer.inside ? hitTest(p.x, p.y) : null;
    if (h !== hover) {
      hover = h;
      viewport.classList.toggle('over-figure', !!h);
      if (!isTouch) setLit(h);
    }
  }

  // Dragging pans, a short press selects, a wheel or pinch zooms.
  const touches = new Map();
  let drag = null;
  let pinch = null;

  viewport.addEventListener('pointerdown', (e) => {
    viewport.setPointerCapture?.(e.pointerId);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.s };
      drag = null;
      return;
    }
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
    camTween = null;
  });

  viewport.addEventListener('pointermove', (e) => {
    pointer.px = e.clientX;
    pointer.py = e.clientY;
    pointer.inside = true;
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!isTouch) {
      par.tx = ((e.clientX / view.w) - 0.5) * -18;
      par.ty = ((e.clientY / view.h) - 0.5) * -12;
    }
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.s * (d / pinch.d));
    } else if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 6) {
        drag.moved = true;
        viewport.classList.add('dragging');
      }
      if (drag.moved) {
        cam.x = drag.cx - dx / view.s;
        cam.y = drag.cy - dy / view.s;
        clampCam();
      }
    }
    nearDirty = true;
  });

  function endPointer(e) {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (!drag) return;
    const wasClick = !drag.moved && e.type === 'pointerup';
    drag = null;
    viewport.classList.remove('dragging');
    if (wasClick) handleClick(e);
  }
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);
  viewport.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') {
      pointer.inside = false;
      nearDirty = true;
      par.tx = par.ty = 0;
    }
  });

  function handleClick(e) {
    const p = toWorld(e.clientX, e.clientY);
    const h = hitTest(p.x, p.y);
    if (e.pointerType !== 'mouse') {
      // First tap wakes a figure, the second opens it.
      if (h && armed === h) {
        armed = null;
        openFolio(h);
      } else if (h) {
        armed = h;
        setLit(null);
        setLit(h);
      } else {
        armed = null;
        setLit(null);
        if (folioOpen) closeFolio();
      }
      return;
    }
    if (h) openFolio(h);
    else if (folioOpen) closeFolio();
  }

  function zoomAt(px, py, s) {
    const before = toWorld(px, py);
    setScale(s);
    const t = transform();
    cam.x += before.x - (px - t.tx) / t.s;
    cam.y += before.y - (py - t.ty) / t.s;
    clampCam();
    nearDirty = true;
  }

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    camTween = null;
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 1.2) {
      zoomAt(e.clientX, e.clientY, view.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    } else {
      cam.x += e.deltaX / view.s;
      clampCam();
      nearDirty = true;
    }
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if (stage !== 'sky') {
      if (e.key === 'Escape') return iris(view.w / 2, view.h / 2);
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        return stage === 'title' ? toVerse() : iris(view.w / 2, view.h / 2);
      }
      return;
    }
    if (e.key === 'Escape') {
      if (openPanel) return closePanel(openPanel);
      if (folioOpen) return closeFolio();
    }
    const target = e.target;
    if (target && (target.closest?.('.panel') || target.tagName === 'BUTTON')) return;
    const step = 80 / view.s;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      flyTo(cam.x + moves[e.key][0], cam.y + moves[e.key][1], 300);
    } else if (e.key === '+' || e.key === '=') {
      zoomAt(view.w / 2, view.h / 2, view.s * 1.25);
    } else if (e.key === '-') {
      zoomAt(view.w / 2, view.h / 2, view.s / 1.25);
    }
  });

  window.addEventListener('resize', () => { resize(); nearDirty = true; });

  // ---------------------------------------------------------------- folio

  const folio = $('#folio');
  const folioBody = $('#folio-body');
  let returnFocus = null;

  function escapeHTML(s) {
    return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  // The figure as an engraved plate: blue-ink lines, gold stars, and Bayer
  // letters from the brightest star down.
  function diagramSVG(c) {
    const xs = c.stars.map((s) => s[0]);
    const ys = c.stars.map((s) => s[1]);
    const pad = 28;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const w = Math.max(...xs) - minX + pad;
    const h = Math.max(...ys) - minY + pad;
    const unit = Math.max(w, h) / 300;
    const order = c.stars.map((s, i) => i).sort((a, b) => c.stars[b][2] - c.stars[a][2]);
    let out = `<svg class="diagram" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" role="img" aria-label="Chart of ${escapeHTML(c.name)}, ${c.stars.length} stars">`;
    for (const line of c.lines) {
      for (let k = 1; k < line.length; k++) {
        const [x1, y1] = c.stars[line[k - 1]];
        const [x2, y2] = c.stars[line[k]];
        out += `<line class="ln" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" vector-effect="non-scaling-stroke"/>`;
      }
    }
    order.forEach((i, rank) => {
      const [x, y, size] = c.stars[i];
      const R = (size * 1.1 + 2.2) * unit;
      const d = i === c.alpha ? starPath(R * 1.3, 8, 0.3, -Math.PI / 2, 0.42) : starPath(R, 6, 0.38);
      out += `<path class="dg" transform="translate(${x} ${y})" d="${d}"/>`;
      if (rank < GREEK.length) {
        out += `<text x="${(x + unit * 9).toFixed(1)}" y="${(y - unit * 7).toFixed(1)}" style="font-size:${(unit * 14).toFixed(1)}px">${GREEK[rank]}</text>`;
      }
    });
    return `${out}</svg>`;
  }

  function peakWindow(bins) {
    // The 5-bin (50-chapter) stretch in which the name turns up most often.
    let best = 0;
    let at = 0;
    for (let i = 0; i + 5 <= bins.length; i++) {
      const sum = bins.slice(i, i + 5).reduce((a, b) => a + b, 0);
      if (sum > best) { best = sum; at = i; }
    }
    return { from: at * BIN + 1, to: Math.min((at + 5) * BIN, LAST), count: best };
  }

  function ephemerisHTML(item) {
    const n = item.bins.length;
    const bw = 4;
    const H0 = 54;
    const width = n * bw;
    let bars = '';
    item.bins.forEach((v, i) => {
      if (!v) return;
      const h = Math.max(1.5, (v / BIN) * H0);
      bars += `<rect class="bar" x="${i * bw + 0.5}" y="${(H0 - h).toFixed(1)}" width="${bw - 1.5}" height="${h.toFixed(1)}"/>`;
    });
    let tickText = '';
    for (const c of [1, 250, 500, 750, 1000]) {
      const x = ((c - 1) / BIN) * bw;
      tickText += `<text class="tick" x="${x.toFixed(1)}" y="${H0 + 16}" text-anchor="${c === 1 ? 'start' : 'middle'}">${c === 1 ? 'ch. 1' : fmt(c)}</text>`;
    }
    const peak = peakWindow(item.bins);
    const note = `Named in ${fmt(item.chapterCount)} of ${fmt(LAST)} chapters, most often in chapters ${fmt(peak.from)} to ${fmt(peak.to)}, where it appears in ${peak.count} of ${peak.to - peak.from + 1}.`;
    return `
      <div class="ephemeris">
        <h3>Where it shines</h3>
        <svg viewBox="0 0 ${width} ${H0 + 20}" role="img" aria-label="${note}" data-eph="${item.id}">
          <rect class="cursor" x="-10" y="0" width="${bw}" height="${H0}" />
          <line class="base" x1="0" y1="${H0 + 0.5}" x2="${width}" y2="${H0 + 0.5}"/>
          ${bars}
          ${tickText}
        </svg>
        <p class="ephemeris-note">${note}</p>
      </div>`;
  }

  const tip = $('#tip');
  function wireEphemeris(item) {
    const chart = folioBody.querySelector('[data-eph]');
    if (!chart) return;
    const cursor = chart.querySelector('.cursor');
    const n = item.bins.length;
    const show = (e) => {
      const r = chart.getBoundingClientRect();
      const i = clamp(Math.floor(((e.clientX - r.left) / r.width) * n), 0, n - 1);
      const from = i * BIN + 1;
      const to = Math.min((i + 1) * BIN, LAST);
      cursor.setAttribute('x', i * 4);
      const v = item.bins[i];
      tip.innerHTML = `Chapters ${from}–${fmt(to)}<br>${v ? `named in ${v} of ${to - from + 1}` : 'absent'}`;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = `${clamp(e.clientX - tw / 2, 8, view.w - tw - 8)}px`;
      tip.style.top = `${r.top - tip.offsetHeight - 8}px`;
    };
    chart.addEventListener('pointermove', show);
    chart.addEventListener('pointerdown', show);
    chart.addEventListener('pointerleave', () => {
      tip.hidden = true;
      cursor.setAttribute('x', -10);
    });
  }

  function folioHTML(item) {
    const isNeb = NEBS.includes(item);
    const kin = item.related.map((id) => byId.get(id)).filter(Boolean);
    const no = figNo(item);
    const plate = isNeb ? '' : `
      <figure class="plate">
        ${diagramSVG(item)}
        <figcaption><span class="px">${no}.</span> ${escapeHTML(item.name)}, a constellation of the ${magnitudeWords(item.magnitude)}, drawn in ${item.stars.length} stars.</figcaption>
      </figure>`;
    return `
      <p class="fig-no">${isNeb ? `${no}, a place in the myth` : `${no}, a figure of the ${magnitudeWords(item.magnitude)}`}</p>
      <h2 id="folio-name" tabindex="-1">${escapeHTML(item.name)}</h2>
      ${item.aka ? `<p class="aka">${escapeHTML(item.aka)}</p>` : ''}
      ${plate}
      <dl class="stats">
        <div><dt>Times named</dt><dd>${fmt(item.mentions)}</dd></div>
        <div><dt>Chapters</dt><dd>${fmt(item.chapterCount)}</dd></div>
        <div><dt>First chapter</dt><dd>${fmt(item.first)}</dd></div>
        <div><dt>Last chapter</dt><dd>${fmt(item.last)}</dd></div>
      </dl>
      ${ephemerisHTML(item)}
      <div class="story">${item.desc.map((p) => `<p>${escapeHTML(p)}</p>`).join('')}</div>
      ${item.excerpts.length ? `<div class="excerpts"><h3>From the myth</h3>${item.excerpts.map((x) => `
        <blockquote><p>${escapeHTML(x.text)}</p><cite><span class="px">ch. ${fmt(x.ch)}</span>${escapeHTML(x.title)}</cite></blockquote>`).join('')}</div>` : ''}
      ${kin.length ? `<div class="kin"><h3>Close to it in the story</h3><ul>${kin.map((k) => `<li><button type="button" data-go="${k.id}">${escapeHTML(k.name)}</button></li>`).join('')}</ul></div>` : ''}
    `;
  }

  function openFolio(item, { fly = true, focus = true } = {}) {
    closePanel(openPanel, { restore: false });
    if (!folioOpen) returnFocus = document.activeElement;
    if (selected) {
      selected._g?.classList.remove('sel');
      selected._label.classList.remove('sel');
    }
    selected = item;
    item._g?.classList.add('sel');
    item._label.classList.add('sel');
    document.body.classList.add('has-sel', 'hint-done');
    folioBody.innerHTML = folioHTML(item);
    folio.scrollTop = 0;
    wireEphemeris(item);
    folioOpen = true;
    folio.inert = false;
    folio.classList.add('open');
    if (fly) {
      const p = focusPoint(item);
      flyTo(p.x, p.y);
    }
    if (focus) $('#folio-name').focus({ preventScroll: true });
    try {
      history.replaceState(null, '', `#${item.id}`);
    } catch (err) { /* some hosts refuse history changes */ }
  }

  function closeFolio() {
    if (!folioOpen) return;
    folioOpen = false;
    folio.classList.remove('open');
    folio.inert = true;
    tip.hidden = true;
    document.body.classList.remove('has-sel');
    if (selected) {
      selected._g?.classList.remove('sel');
      selected._label.classList.remove('sel');
      selected = null;
    }
    clampCam();
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (err) { /* ignore */ }
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
  }

  folioBody.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (!go) return;
    const item = byId.get(go.dataset.go);
    if (item) openFolio(item);
  });

  // --------------------------------------------------- the index and notes

  const panels = { catalogue: $('#catalogue'), about: $('#about') };
  let openPanel = null;

  function openSide(name) {
    if (openPanel === name) return closePanel(name);
    closePanel(openPanel, { restore: false });
    const el = panels[name];
    el.inert = false;
    el.classList.add('open');
    openPanel = name;
    const button = $(`#btn-${name}`);
    button.setAttribute('aria-expanded', 'true');
    el.querySelector('h2').focus({ preventScroll: true });
  }

  function closePanel(name, { restore = true } = {}) {
    if (!name || openPanel !== name) return;
    const el = panels[name];
    el.classList.remove('open');
    el.inert = true;
    openPanel = null;
    const button = $(`#btn-${name}`);
    button.setAttribute('aria-expanded', 'false');
    if (restore) button.focus({ preventScroll: true });
  }

  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.close === 'folio') closeFolio();
      else closePanel(b.dataset.close);
    });
  });

  (function buildCatalogue() {
    const root = $('#catalogue-groups');
    const groups = new Map();
    for (const c of CONS) {
      if (!groups.has(c.magnitude)) groups.set(c.magnitude, []);
      groups.get(c.magnitude).push(c);
    }
    let html = '';
    for (const [m, list] of groups) {
      html += `<section class="catalogue-group"><h3>${ORDINAL[m][0].toUpperCase()}${ORDINAL[m].slice(1)} magnitude</h3><ul class="catalogue-list">`;
      const size = 7 + (5 - m) * 2.5;
      for (const c of list) {
        html += `<li><button type="button" data-cat="${c.id}"><svg class="icon" width="${size}" height="${size}" viewBox="-10 -10 20 20" aria-hidden="true"><path d="${starPath(10, 6, 0.38)}"/></svg><span class="nm">${escapeHTML(c.name)}</span><span class="leader"></span><span class="ct">${fmt(c.mentions)}</span></button></li>`;
      }
      html += '</ul></section>';
    }
    if (NEBS.length) {
      html += '<section class="catalogue-group"><h3>Nebulae, the places</h3><ul class="catalogue-list">';
      for (const n of NEBS) {
        const [r, g, b] = NEB_TINTS[n.hue] || NEB_TINTS.violet;
        const ink = `rgb(${Math.round(r * 0.45)},${Math.round(g * 0.45)},${Math.round(b * 0.45)})`;
        html += `<li><button type="button" data-cat="${n.id}"><span class="neb-dot" style="color:${ink}"></span><span class="nm">${escapeHTML(n.name)}</span><span class="leader"></span><span class="ct">${fmt(n.mentions)}</span></button></li>`;
      }
      html += '</ul></section>';
    }
    root.innerHTML = html;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (b) openFolio(byId.get(b.dataset.cat));
    });
    const preview = (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      setLit(byId.get(b.dataset.cat));
    };
    root.addEventListener('pointerover', preview);
    root.addEventListener('focusin', preview);
    root.addEventListener('pointerleave', () => setLit(hover));
  })();

  $('#btn-catalogue').addEventListener('click', () => openSide('catalogue'));
  $('#btn-about').addEventListener('click', () => openSide('about'));

  const btnAll = $('#btn-all');
  btnAll.addEventListener('click', () => {
    const on = !document.body.classList.contains('all');
    document.body.classList.toggle('all', on);
    btnAll.setAttribute('aria-pressed', String(on));
    document.body.classList.add('hint-done');
  });

  // ----------------------------------------------------------------- overture
  //
  // A title card, a dissolve to the verse, and an iris onto the sky. The
  // card sits on a strip of film: a faint engraved chart behind it, a
  // projector's hot spot, and specks of dust and the odd hair that come and go.

  const overture = $('#overture');
  const cardTitle = $('#card-title');
  const cardVerse = $('#card-verse');
  const leader = $('#leader');
  const lctx = leader.getContext('2d');
  let stage = 'title';
  let stageTimer = null;
  let chartPattern = null;
  let lastLeader = 0;
  const film = { hair: null };
  const frand = seeded(24);

  function sizeLeader() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    leader.width = Math.round(view.w * dpr);
    leader.height = Math.round(view.h * dpr);
    // The faint chart behind the title, drawn once per size.
    chartPattern = document.createElement('canvas');
    chartPattern.width = leader.width;
    chartPattern.height = leader.height;
    const g = chartPattern.getContext('2d');
    g.scale(dpr, dpr);
    const cx = view.w / 2;
    const cy = view.h * 2.2;
    g.strokeStyle = 'rgba(255,255,255,0.0825)';
    g.lineWidth = 1;
    for (let R = view.h * 1.3; R < view.h * 2.4; R += view.h * 0.12) {
      g.beginPath();
      g.arc(cx, cy, R, Math.PI * 1.1, Math.PI * 1.9);
      g.stroke();
    }
    for (let a = Math.PI * 1.1; a <= Math.PI * 1.9; a += Math.PI / 22) {
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * view.h * 1.3, cy + Math.sin(a) * view.h * 1.3);
      g.lineTo(cx + Math.cos(a) * view.h * 2.4, cy + Math.sin(a) * view.h * 2.4);
      g.stroke();
    }
    const r = seeded(9);
    g.fillStyle = 'rgba(255,255,255,0.17)';
    for (let i = 0; i < 90; i++) {
      const x = r() * view.w;
      const y = r() * view.h;
      const R = 1.5 + Math.pow(r(), 3) * 5;
      g.save();
      g.translate(x, y);
      g.globalAlpha = 0.4 + r() * 0.6;
      g.fill(new Path2D(starPath(R, 6, 0.38)));
      g.restore();
    }
  }

  function drawLeader(now) {
    if (now - lastLeader < 42) return; // about 24 frames a second
    lastLeader = now;
    const dpr = leader.width / view.w;
    const w = view.w;
    const h = view.h;
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const flick = reduced ? 1 : 0.915 + frand() * 0.085;
    const hot = lctx.createRadialGradient(w / 2, h * 0.46, 0, w / 2, h * 0.46, Math.max(w, h) * 0.75);
    const lum = Math.round(26 * flick);
    hot.addColorStop(0, `rgb(${lum},${lum},${lum - 1})`);
    hot.addColorStop(0.55, 'rgb(12,12,12)');
    hot.addColorStop(1, 'rgb(3,3,3)');
    lctx.fillStyle = hot;
    lctx.fillRect(0, 0, w, h);
    const jx = reduced ? 0 : (frand() - 0.5) * 1.2;
    const jy = reduced ? 0 : (frand() - 0.5) * 1.2;
    lctx.globalAlpha = flick;
    lctx.drawImage(chartPattern, jx, jy, w, h);
    lctx.globalAlpha = 1;
    if (reduced) return;
    // Dust specks, one frame each.
    const specks = frand() < 0.55 ? 0 : 1 + Math.floor(frand() * 4);
    for (let i = 0; i < specks; i++) {
      lctx.fillStyle = frand() < 0.6 ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.45)';
      lctx.beginPath();
      lctx.ellipse(frand() * w, frand() * h, 0.6 + frand() * 2.2, 0.6 + frand() * 1.6, frand() * Math.PI, 0, Math.PI * 2);
      lctx.fill();
    }
    // Now and then a hair drifts through the gate.
    if (!film.hair && frand() < 0.012) {
      film.hair = { x: frand() * w, y: frand() * h, len: 30 + frand() * 70, bend: (frand() - 0.5) * 40, life: 3 + Math.floor(frand() * 5) };
    }
    if (film.hair) {
      const hr = film.hair;
      lctx.strokeStyle = 'rgba(0,0,0,0.6)';
      lctx.lineWidth = 1;
      lctx.beginPath();
      lctx.moveTo(hr.x, hr.y);
      lctx.quadraticCurveTo(hr.x + hr.bend, hr.y + hr.len / 2, hr.x + hr.bend * 0.3, hr.y + hr.len);
      lctx.stroke();
      if (--hr.life <= 0) film.hair = null;
    }
  }

  function showCard(card) {
    for (const c of [cardTitle, cardVerse]) c.classList.toggle('shown', c === card);
  }

  function toTitle() {
    stage = 'title';
    showCard(cardTitle);
    clearTimeout(stageTimer);
    stageTimer = setTimeout(toVerse, 7200);
  }

  function toVerse() {
    clearTimeout(stageTimer);
    stage = 'verse';
    // Restart the verse so it writes itself in again.
    cardVerse.querySelectorAll('.ln, .verse-credit, .enter').forEach((el) => {
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    });
    showCard(cardVerse);
  }

  function kindle() {
    // The Dreamer's cosmos kindles: every figure traces itself in, sweeping
    // from the first chapter to the last, and then goes dark again. Where the
    // sky is wider than the screen, the view travels with the sweep.
    if (reduced) return;
    const { bx } = camBounds();
    if (bx[1] - bx[0] > 40) {
      cam.x = bx[0];
      camTween = { from: { x: bx[0], y: cam.y }, to: { x: bx[1], y: cam.y }, t0: performance.now() + 500, duration: 3600 };
    }
    for (const c of CONS) {
      setTimeout(() => {
        c._g.classList.add('kindled');
        c._label.classList.add('kindled');
        setTimeout(() => {
          c._g.classList.remove('kindled');
          c._label.classList.remove('kindled');
        }, 2300);
      }, 700 + c._sweep * 1000);
    }
  }

  function finishOverture() {
    overture.classList.add('gone');
    overture.inert = true;
    overture.style.maskImage = '';
    overture.style.webkitMaskImage = '';
    requestAnimationFrame(() => overture.classList.remove('irising'));
  }

  // An iris opens from where the reader clicked and the sky shows through.
  function iris(x, y) {
    if (stage === 'sky') return;
    stage = 'sky';
    clearTimeout(stageTimer);
    document.body.classList.remove('overture-open');
    kindle();
    if (reduced) {
      finishOverture();
      return;
    }
    overture.classList.add('irising');
    const maxR = Math.hypot(Math.max(x, view.w - x), Math.max(y, view.h - y)) + 80;
    const t0 = performance.now();
    const step = (now) => {
      const k = clamp((now - t0) / 1500, 0, 1);
      const r = maxR * easeIn(k);
      const m = `radial-gradient(circle at ${x}px ${y}px, transparent ${r.toFixed(1)}px, #000 ${(r + 36).toFixed(1)}px)`;
      overture.style.maskImage = m;
      overture.style.webkitMaskImage = m;
      if (k < 1) requestAnimationFrame(step);
      else finishOverture();
    };
    requestAnimationFrame(step);
  }

  function enterQuietly() {
    stage = 'sky';
    clearTimeout(stageTimer);
    document.body.classList.remove('overture-open');
    finishOverture();
  }

  function showVerseAgain() {
    closeFolio();
    closePanel(openPanel, { restore: false });
    overture.inert = false;
    overture.classList.remove('gone');
    document.body.classList.add('overture-open');
    toVerse();
  }

  overture.addEventListener('click', (e) => {
    if (e.target.closest('#skip')) return;
    if (stage === 'title') toVerse();
    else if (stage === 'verse') iris(e.clientX, e.clientY);
  });
  $('#enter').addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    iris(e.clientX || r.left + r.width / 2, e.clientY || r.top + r.height / 2);
  });
  $('#skip').addEventListener('click', (e) => {
    e.stopPropagation();
    iris(view.w / 2, view.h / 2);
  });
  $('#btn-verse').addEventListener('click', showVerseAgain);

  // --------------------------------------------------------------- the loop

  function frame(now) {
    par.x += (par.tx - par.x) * 0.05;
    par.y += (par.ty - par.y) * 0.05;
    if (reduced) { par.x = par.y = 0; }
    if (camTween && now >= camTween.t0) {
      const k = clamp((now - camTween.t0) / camTween.duration, 0, 1);
      const e = ease(k);
      cam.x = camTween.from.x + (camTween.to.x - camTween.from.x) * e;
      cam.y = camTween.from.y + (camTween.to.y - camTween.from.y) * e;
      if (k >= 1) camTween = null;
      nearDirty = true;
    }
    const t = transform();
    const css = `translate3d(${t.tx.toFixed(2)}px, ${t.ty.toFixed(2)}px, 0) scale(${t.s.toFixed(5)})`;
    if (css !== lastTransform) {
      world.style.transform = css;
      lastTransform = css;
      nearDirty = true;
    }
    updateNear();
    if (labelsDirty && now - lastScaleChange > 180) placeLabels();
    if (!overture.classList.contains('gone')) drawLeader(now);
    if (stage !== 'title' || overture.classList.contains('irising')) drawSky(now);
    requestAnimationFrame(frame);
  }

  resize();
  // Names are measured to place them, so measure again once the fonts arrive.
  document.fonts?.ready.then(() => { labelsDirty = true; });

  // A link to one figure (#the-weaver) skips the overture and opens it.
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (fromHash && byId.has(fromHash)) {
    enterQuietly();
    const item = byId.get(fromHash);
    folioOpen = true; // so the camera leaves room for the panel
    const p = focusPoint(item);
    cam.x = p.x;
    cam.y = p.y;
    folioOpen = false;
    openFolio(item, { fly: false, focus: false });
    clampCam();
  } else {
    setTimeout(toTitle, reduced ? 0 : 450);
  }

  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (byId.has(id)) {
      enterQuietly();
      openFolio(byId.get(id));
    }
  });

  requestAnimationFrame(frame);
})();
