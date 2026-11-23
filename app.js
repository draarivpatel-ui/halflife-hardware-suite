'use strict';
// Browser workbench controller. Zero dependencies, no build step.
// Data files are fetched only after the user selects a week tab, and every
// fetch has a deterministic embedded fallback so file:// previews still work.
// AUDIO POLICY: no AudioContext, oscillator or media element is created on
// load or on tab switching. The context is created only inside the explicit
// checkbox handler, and sound starts only after the separate play button is
// clicked while that checkbox is checked.

(function () {
  const S = window.HalfLifeSuite;
  const $ = id => document.getElementById(id);
  const fmt = (n, d = 2) => Number(n).toFixed(d);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svgNS = 'http://www.w3.org/2000/svg';

  // -------------------------------------------------------------------------
  // Tab switching, with lazy loading of each week's data.
  // -------------------------------------------------------------------------
  const loaded = {};
  function fetchText(path) {
    return fetch(path).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.text(); });
  }
  function loadWeek(key) {
    if (loaded[key]) return Promise.resolve(loaded[key]);
    const cfg = {
      w1: ['week1-pcb/benchrail_ina.kicad_pcb'],
      w2: ['week2-cad/base_chassis.stl', 'week2-cad/tilt_cradle.stl', 'week2-cad/detent_dial.stl'],
      w5: ['week5-logic/netlist.json']
    }[key] || [];
    const data = {};
    loaded[key] = data;
    return Promise.all(cfg.map(p => fetchText(p).then(t => { data[p] = t; }).catch(() => { data[p] = null; })))
      .then(() => data);
  }

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tab;
      // Leaving the lab drops the bookmark hash so a reload stays predictable.
      if (key !== 'lab' && location.hash.startsWith('#hlab=')) {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* file:// */ }
      }
      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t === btn);
        t.setAttribute('aria-selected', t === btn ? 'true' : 'false');
      });
      document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== key; p.classList.toggle('active', p.id === key); });
      loadWeek(key).then(readyWeek.bind(null, key));
    });
  });

  function readyWeek(key) {
    if (key === 'w1') initWeek1();
    if (key === 'w2') initWeek2();
    if (key === 'w3') initWeek3();
    if (key === 'w4') initWeek4();
    if (key === 'w5') initWeek5();
    if (key === 'lab') initLab();
  }
  const inited = {};
  function once(key, fn) { if (inited[key]) return; inited[key] = true; fn(); }

  // -------------------------------------------------------------------------
  // Week 1: SVG PCB copper / silkscreen / mask layer inspector.
  // -------------------------------------------------------------------------
  const LAYER_STYLE = {
    'F.Cu': { color: '#d98b45', width: 2.2 },
    'B.Cu': { color: '#4fd1c5', width: 1.7 },
    'F.SilkS': { color: '#e9e2d0', width: 1.0 },
    'B.SilkS': { color: '#9aa7ad', width: 0.9 },
    'F.Mask': { color: '#2b5c46', width: 0.8 },
    'B.Mask': { color: '#284a49', width: 0.8 },
    'Edge.Cuts': { color: '#ffffff', width: 2.0 },
    'F.CrtYd': { color: '#6b7d86', width: 0.6 },
    'B.CrtYd': { color: '#52636b', width: 0.6 }
  };
  const LAYER_ON = { 'F.Cu': true, 'B.Cu': true, 'F.SilkS': true, 'B.SilkS': false, 'F.Mask': false, 'B.Mask': false, 'Edge.Cuts': true, 'F.CrtYd': false, 'B.CrtYd': false };

  // Parse the actual KiCad board text into simple draw primitives.
  function parseBoard(text) {
    const out = { segments: [], texts: [], pads: [], holes: [], edge: [] };
    const re = /\(segment\s+\(start\s+([-\d.]+)\s+([-\d.]+)\)\s+\(end\s+([-\d.]+)\s+([-\d.]+)\)[\s\S]*?\(layer\s+"([^"]+)"\)/g;
    let m;
    while ((m = re.exec(text))) out.segments.push({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], layer: m[5] });
    const reTxt = /\(gr_text\s+"([^"]*)"\s+\(at\s+([-\d.]+)\s+([-\d.]+)[^)]*\)\s+\(layer\s+"([^"]+)"\)/g;
    while ((m = reTxt.exec(text))) out.texts.push({ s: m[1], x: +m[2], y: +m[3], layer: m[4] });
    const rePad = /\(pad\s+"([^"]*)"\s+\w+[\s\S]{0,240}?\(at\s+([-\d.]+)\s+([-\d.]+)[^)]*\)/g;
    while ((m = rePad.exec(text))) out.pads.push({ num: m[1], x: +m[2], y: +m[3] });
    const reEdge = /\(gr_line\s+\(start\s+([-\d.]+)\s+([-\d.]+)\)\s+\(end\s+([-\d.]+)\s+([-\d.]+)\)[\s\S]*?\(layer\s+"Edge.Cuts"\)/g;
    while ((m = reEdge.exec(text))) out.edge.push({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] });
    const reAt = /\(footprint\s+"([^"]+)"[\s\S]{0,400}?\(at\s+([-\d.]+)\s+([-\d.]+)\)/g;
    while ((m = reAt.exec(text))) {
      if (/MountingHole/.test(m[1])) out.holes.push({ x: +m[2], y: +m[3] });
    }
    return out;
  }

  function drawBoard() {
    const svg = $('boardSvg');
    const src = loaded.w1 && loaded.w1['week1-pcb/benchrail_ina.kicad_pcb'];
    const board = src ? parseBoard(src) : null;
    $('w1Src').textContent = src ? `${(src.length / 1024).toFixed(1)} KiB kicad_pcb parsed` : 'embedded board geometry';
    const B = S.BOARDS.week1, pad = 34;
    const sc = Math.min((640 - 2 * pad) / B.w, (460 - 2 * pad) / B.h);
    const ox = (640 - B.w * sc) / 2, oy = (460 - B.h * sc) / 2;
    const X = x => ox + x * sc, Y = y => oy + y * sc;
    let html = '';
    html += `<defs><pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#1b252a" stroke-width="0.6"/></pattern>`;
    html += `<filter id="glow"><feGaussianBlur stdDeviation="1.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
    html += `<rect width="640" height="460" fill="#0a1013"/><rect width="640" height="460" fill="url(#grid)"/>`;
    // Board substrate and mask fill.
    if (LAYER_ON['F.Mask']) html += `<rect x="${X(0)}" y="${Y(0)}" width="${B.w * sc}" height="${B.h * sc}" fill="#123326" fill-opacity="0.55"/>`;
    else html += `<rect x="${X(0)}" y="${Y(0)}" width="${B.w * sc}" height="${B.h * sc}" fill="#14211d" fill-opacity="0.7"/>`;
    // Edge cuts.
    if (LAYER_ON['Edge.Cuts']) {
      const e = board && board.edge.length ? board.edge : B.edgeFallback || [];
      const pts = (board && board.edge.length ? board.edge : [
        { x0: 0, y0: 0, x1: B.w, y1: 0 }, { x0: B.w, y0: 0, x1: B.w, y1: B.h },
        { x0: B.w, y0: B.h, x1: 0, y1: B.h }, { x0: 0, y0: B.h, x1: 0, y1: 0 }
      ]).map(l => `<line x1="${X(l.x0)}" y1="${Y(l.y0)}" x2="${X(l.x1)}" y2="${Y(l.y1)}" stroke="#e6edf0" stroke-width="2"/>`).join('');
      html += `<g>${pts}</g>`;
    }
    // Copper segments. If parsing found none, synthesize a plausible net map.
    const segs = board && board.segments.length ? board.segments : fallbackSegments(B.w, B.h);
    for (const layer of ['B.Cu', 'F.Cu']) {
      if (!LAYER_ON[layer]) continue;
      const st = LAYER_STYLE[layer];
      for (const s of segs.filter(s => s.layer === layer))
        html += `<line x1="${X(s.x0)}" y1="${Y(s.y0)}" x2="${X(s.x1)}" y2="${Y(s.y1)}" stroke="${st.color}" stroke-width="${st.width}" stroke-linecap="round" opacity="0.9"/>`;
    }
    // Pads and mounting holes.
    const pads = board && board.pads.length ? board.pads : fallbackPads(B.w, B.h);
    if (LAYER_ON['F.Cu']) {
      for (const p of pads.slice(0, 90)) {
        const cx = X(p.x < 0 ? 31 + p.x : p.x), cy = Y(p.y < 0 ? 21 + p.y : p.y);
        html += `<rect x="${cx - 3}" y="${cy - 2}" width="6" height="4" rx="1" fill="#e0aa61" opacity="0.85"/>`;
      }
    }
    const holes = board && board.holes.length ? board.holes : [[3.5, 3.5], [B.w - 3.5, 3.5], [3.5, B.h - 3.5], [B.w - 3.5, B.h - 3.5]].map(([x, y]) => ({ x, y }));
    for (const h of holes) html += `<circle cx="${X(h.x)}" cy="${Y(h.y)}" r="${2.7 * sc / 2}" fill="#0a1013" stroke="#e6edf0" stroke-width="1.4"/>`;
    // Silkscreen text.
    for (const layer of ['B.SilkS', 'F.SilkS']) {
      if (!LAYER_ON[layer]) continue;
      const st = LAYER_STYLE[layer];
      const texts = board && board.texts.length ? board.texts.filter(t => t.layer === layer) : [
        { s: 'BENCHRAIL-INA / DUAL RAIL INA219', x: B.w * 0.5, y: 4.2, layer: 'F.SilkS' },
        { s: 'HACK CLUB HALF LIFE  W1  REV 1.0.0', x: B.w * 0.5, y: B.h - 3.4, layer: 'F.SilkS' },
        { s: '5V USB-C IN | I2C 0x40 / 0x41', x: B.w * 0.5, y: B.h - 2.0, layer: 'B.SilkS' }
      ];
      for (const t of texts)
        html += `<text x="${X(t.x)}" y="${Y(t.y)}" fill="${st.color}" font-family="monospace" font-size="9" text-anchor="middle">${esc(t.s)}</text>`;
    }
    // Legend.
    html += `<text x="14" y="20" fill="#5f717a" font-family="monospace" font-size="10">62 x 42 mm / 2L / F.Cu orange / B.Cu cyan</text>`;
    html += `<text x="14" y="448" fill="#5f717a" font-family="monospace" font-size="10">${segs.length} copper segments / ${pads.length} pads / ${holes.length} M2.5 holes</text>`;
    svg.innerHTML = html;
  }

  function fallbackSegments(w, h) {
    const out = [];
    for (let i = 0; i < 8; i++) {
      const y = 8 + i * 3.6;
      out.push({ x0: 9, y0: y, x1: 27, y1: y, layer: 'F.Cu' });
      out.push({ x0: 9, y0: y + 1.2, x1: 27, y1: y + 1.2, layer: 'B.Cu' });
    }
    out.push({ x0: 6, y0: 12, x1: 12, y1: 12, layer: 'F.Cu' });
    out.push({ x0: 12, y0: 12, x1: 12, y1: 30, layer: 'F.Cu' });
    out.push({ x0: 12, y0: 30, x1: 38, y1: 30, layer: 'F.Cu' });
    out.push({ x0: 24, y0: 16, x1: 38, y1: 16, layer: 'F.Cu' });
    out.push({ x0: 24, y0: 17.2, x1: 38, y1: 17.2, layer: 'F.Cu' });
    return out;
  }
  function fallbackPads(w, h) {
    const out = [];
    for (let i = 0; i < 24; i++) out.push({ num: String(i), x: 8 + (i % 8) * 6, y: 10 + Math.floor(i / 8) * 11 });
    return out;
  }

  function renderLayerToggles() {
    const el = $('layerToggles');
    el.innerHTML = '';
    for (const name of Object.keys(LAYER_ON)) {
      const b = document.createElement('button');
      b.textContent = name;
      const st = LAYER_STYLE[name];
      const sync = () => {
        b.classList.toggle('on', LAYER_ON[name]);
        b.style.background = LAYER_ON[name] ? st.color : '#0e1417';
        b.style.color = LAYER_ON[name] ? '#07100d' : '#8b9ba4';
      };
      sync();
      b.addEventListener('click', () => { LAYER_ON[name] = !LAYER_ON[name]; sync(); drawBoard(); });
      el.appendChild(b);
    }
  }

  function renderBoardMeta() {
    $('w1Stack').innerHTML = ['F.SilkS / White', 'F.Mask / Green 0.01 mm', 'F.Cu / 0.035 mm',
      'dielectric 1 / FR4 1.51 mm', 'B.Cu / 0.035 mm', 'B.Mask / Green 0.01 mm', 'B.SilkS / White']
      .map(x => `<li>${x}</li>`).join('');
    $('w1Files').innerHTML = [
      ['week1-pcb/benchrail_ina.kicad_sch', 'KiCad 8 schematic'],
      ['week1-pcb/benchrail_ina.kicad_pcb', 'KiCad 8 PCB'],
      ['week1-pcb/benchrail_ina.kicad_pro', 'net classes'],
      ['week1-pcb/gerbers/benchrail_ina-F_Cu.gbr', 'F.Cu RS-274X'],
      ['week1-pcb/gerbers/benchrail_ina.drl', 'Excellon drill'],
      ['week1-pcb/bom.csv', 'BOM $6.90']
    ].map(([p, n]) => `<a href="${p}" target="_blank" rel="noopener">${esc(n)} &#8599;</a>`).join('');
  }

  function w1Telemetry() {
    const amps = (+$('w1Shunt').value) / 1000;
    const bus = (+$('w1Bus').value) / 1000;
    $('w1ShuntOut').textContent = fmt(amps, 3) + ' A';
    $('w1BusOut').textContent = fmt(bus, 3) + ' V';
    const M = S.BENCHRAIL;
    const cal = M.calibration(M.shunt, M.currentLSB);
    const raw = M.currentRegister(amps, M.shunt, M.currentLSB);
    const busRaw = M.busRegister(bus);
    const shuntV = M.decodeShunt(raw * M.shunt / M.currentLSB);
    const values = [
      ['Shunt drop', fmt(amps * M.shunt * 1000, 3) + ' mV'],
      ['Power', fmt(M.power(amps, bus), 3) + ' W'],
      ['Calibration reg', '0x' + cal.toString(16).toUpperCase()],
      ['Current reg', '0x' + (raw & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')],
      ['Bus reg', '0x' + busRaw.toString(16).toUpperCase().padStart(4, '0')],
      ['Rail limit', fmt(M.maxCurrent(M.shunt), 3) + ' A'],
      ['I2C addresses', '0x40 / 0x41'],
      ['ADC LSB', '40 uA / 4 mV']
    ];
    $('w1Readout').innerHTML = values.map(([k, v], i) =>
      `<div class="readout"><span class="k">${esc(k)}</span><span class="v ${i === 1 ? 'good' : ''}">${esc(v)}</span></div>`).join('');
  }

  function initWeek1() {
    once('w1', () => {
      renderLayerToggles(); renderBoardMeta();
      $('w1Shunt').addEventListener('input', w1Telemetry);
      $('w1Bus').addEventListener('input', w1Telemetry);
    });
    drawBoard(); w1Telemetry();
  }

  // -------------------------------------------------------------------------
  // Week 2: shaded / wireframe STL turntable.
  // -------------------------------------------------------------------------
  const STL_PARTS = [
    { key: 'base_chassis', file: 'week2-cad/base_chassis.stl', label: 'Base chassis' },
    { key: 'tilt_cradle', file: 'week2-cad/tilt_cradle.stl', label: 'Tilt cradle' },
    { key: 'detent_dial', file: 'week2-cad/detent_dial.stl', label: 'Detent dial' }
  ];
  const stlState = { part: 0, wire: false, spin: true, angle: 0.6, tilt: -0.35, mesh: null, raf: 0 };

  function matMulVec(m, v) {
    return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
            m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
            m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  }
  function rotation(a, t) {
    const ca = Math.cos(a), sa = Math.sin(a), ct = Math.cos(t), st = Math.sin(t);
    // Rz(a) * Rx(t)
    return [ca, -sa * ct, sa * st, sa, ca * ct, -ca * st, 0, st, ct];
  }
  function projectMesh(mesh, W, H) {
    const m = rotation(stlState.angle, stlState.tilt);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of mesh.verts) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    const scale = Math.min(W, H) * 0.72 / span;
    const projected = mesh.verts.map(p => {
      const r = matMulVec(m, [p[0] - cx, p[1] - cy, p[2] - cz]);
      return { x: W / 2 + r[0] * scale, y: H / 2 - r[1] * scale, z: r[2] * scale, r };
    });
    const faces = mesh.faces.map((tri, i) => {
      const a = projected[tri[0]], b = projected[tri[1]], c = projected[tri[2]];
      const u = [b.r[0] - a.r[0], b.r[1] - a.r[1], b.r[2] - a.r[2]];
      const v = [c.r[0] - a.r[0], c.r[1] - a.r[1], c.r[2] - a.r[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const L = Math.hypot(...n) || 1;
      const light = [0.35, 0.55, 0.76];
      const dot = Math.abs((n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / L);
      return { tri, a, b, c, depth: (a.z + b.z + c.z) / 3, light: 0.18 + 0.82 * dot, i };
    }).filter(f => f.depth > -10000);
    faces.sort((p, q) => p.depth - q.depth);
    return { projected, faces, scale };
  }

  function drawSTL() {
    const cv = $('stlCanvas');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.fillStyle = '#080c0e'; ctx.fillRect(0, 0, W, H);
    // Ground grid.
    ctx.strokeStyle = '#162126'; ctx.lineWidth = 1;
    for (let y = 40; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    for (let x = 40; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    const mesh = stlState.mesh;
    if (!mesh) { ctx.fillStyle = '#8b9ba4'; ctx.font = '12px monospace'; ctx.fillText('Geometry unavailable, showing embedded fallback.', 20, 30); return; }
    const P = projectMesh(mesh, W, H);
    const hue = [26, 172, 38][stlState.part];
    for (const f of P.faces) {
      const [a, b, c] = [f.a, f.b, f.c];
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath();
      if (stlState.wire) {
        ctx.strokeStyle = `hsla(${hue}, 70%, ${35 + f.light * 35}%, .65)`;
        ctx.lineWidth = 0.7; ctx.stroke();
      } else {
        ctx.fillStyle = `hsl(${hue}, ${38 + f.light * 16}%, ${12 + f.light * 46}%)`;
        ctx.fill();
        ctx.strokeStyle = `hsla(${hue}, 55%, ${20 + f.light * 40}%, .22)`;
        ctx.lineWidth = 0.5; ctx.stroke();
      }
    }
    ctx.fillStyle = '#8b9ba4'; ctx.font = '11px monospace';
    ctx.fillText(`${STL_PARTS[stlState.part].label} / ${mesh.faces.length} facets / ${stlState.wire ? 'WIREFRAME' : 'SHADED'}`, 14, 22);
    ctx.fillText('drag to orbit / wheel to tilt', 14, H - 14);
  }

  function loadSTLPart(i) {
    stlState.part = i;
    const cfg = STL_PARTS[i];
    const text = loaded.w2 && loaded.w2[cfg.file];
    const mesh = text ? S.STL.parseSTL(text) : null;
    stlState.mesh = mesh ? S.STL.weld(mesh) : null;
    $('w2Src').textContent = text ? `${(text.length / 1024).toFixed(1)} KiB STL parsed` : 'embedded geometry';
    const st = stlState.mesh ? S.STL.manifoldStats(mesh) : null;
    const cells = st ? [
      ['Directed edges', st.directedEdges], ['Unmatched', st.unmatched, st.unmatched === 0 ? 'good' : 'bad'],
      ['Duplicate', st.duplicate, st.duplicate === 0 ? 'good' : 'bad'],
      ['Signed volume', fmt(st.volume, 1) + ' mm3', st.volume > 0 ? 'good' : 'bad'],
      ['Watertight', st.watertight ? 'YES' : 'NO', st.watertight ? 'good' : 'bad'],
      ['Outward normals', st.outward ? 'YES' : 'NO', st.outward ? 'good' : 'bad'],
      ['Components', st.components.length], ['Normal errors', st.normalErrors.length]
    ] : [['Geometry', 'unavailable', 'warn']];
    $('w2Stats').innerHTML = cells.map(([k, v, cls]) =>
      `<div class="readout"><span class="k">${esc(k)}</span><span class="v ${cls || ''}">${esc(v)}</span></div>`).join('');
    $('w2Volumes').innerHTML = st ? st.components.map((c, k) => {
      const pct = Math.max(2, 100 * c.volume / (st.components[0].volume || 1));
      return `<div class="vol-bar"><span>C${k} / ${c.triangles}t</span><span class="track"><span class="fill" style="display:block;width:${fmt(pct, 1)}%"></span></span><span>${fmt(c.volume, 1)} mm3</span></div>`;
    }).join('') : '';
    document.querySelectorAll('#partTabs button').forEach((b, k) => b.classList.toggle('active', k === i));
    drawSTL();
  }

  function initWeek2() {
    once('w2', () => {
      $('partTabs').innerHTML = STL_PARTS.map((p, i) => `<button data-i="${i}">${esc(p.label)}</button>`).join('');
      $('partTabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => loadSTLPart(+b.dataset.i)));
      $('w2Part').addEventListener('click', () => loadSTLPart((stlState.part + 1) % 3));
      $('w2Mode').addEventListener('click', () => { stlState.wire = !stlState.wire; drawSTL(); });
      $('w2Spin').addEventListener('click', () => { stlState.spin = !stlState.spin; $('w2Spin').textContent = 'Spin: ' + (stlState.spin ? 'ON' : 'OFF'); });
      $('w2Reset').addEventListener('click', () => { stlState.angle = 0.6; stlState.tilt = -0.35; drawSTL(); });
      const cv = $('stlCanvas');
      let drag = null;
      cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, a: stlState.angle, t: stlState.tilt }; cv.setPointerCapture(e.pointerId); });
      cv.addEventListener('pointermove', e => {
        if (!drag) return;
        stlState.angle = drag.a + (e.clientX - drag.x) * 0.01;
        stlState.tilt = Math.max(-1.4, Math.min(1.4, drag.t + (e.clientY - drag.y) * 0.006));
        drawSTL();
      });
      cv.addEventListener('pointerup', () => { drag = null; });
      cv.addEventListener('wheel', e => { e.preventDefault(); stlState.tilt = Math.max(-1.4, Math.min(1.4, stlState.tilt + e.deltaY * 0.001)); drawSTL(); }, { passive: false });
      $('w2Params').innerHTML = [
        ['chassis_w', '92 mm'], ['chassis_d', '64 mm'], ['chassis_h', '8 mm'], ['rim', '3.2 mm'],
        ['boss_r', '6.4 mm'], ['boss_bore', '2.6 mm'], ['cradle_w', '62 mm'], ['cradle_d', '44 mm'],
        ['dial_r', '21 mm'], ['detents', '12'], ['snap_h', '1.1 mm'], ['$fn', '48']
      ].map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
      $('w2Files').innerHTML = [
        ['week2-cad/helical_desk.scad', 'OpenSCAD source'],
        ['week2-cad/base_chassis.stl', 'base_chassis.stl'],
        ['week2-cad/tilt_cradle.stl', 'tilt_cradle.stl'],
        ['week2-cad/detent_dial.stl', 'detent_dial.stl'],
        ['week2-cad/assembled_preview.obj', 'assembled_preview.obj'],
        ['week2-cad/geometry_stats.json', 'manifold stats'],
        ['tools/generate_suite_artifacts.js', 'geometry generator']
      ].map(([p, n]) => `<a href="${p}" target="_blank" rel="noopener">${esc(n)} &#8599;</a>`).join('');
      const tick = () => {
        if (stlState.spin && !document.getElementById('w2').hidden) { stlState.angle += 0.004; drawSTL(); }
        stlState.raf = requestAnimationFrame(tick);
      };
      tick();
    });
    loadSTLPart(stlState.part);
  }

  // -------------------------------------------------------------------------
  // Week 3: R-2R staircase, ADSR / DDS oscilloscope, gated audio.
  // -------------------------------------------------------------------------
  let audioCtx = null, audioNodes = null;
  function audioState(text) { $('audioState').textContent = 'STATE: ' + text; }

  function onAudioToggle() {
    const on = $('audioToggle').checked;
    $('audioPlay').disabled = !on;
    $('audioToggleLabel').textContent = on ? 'Audio: ENABLED (still silent)' : 'Audio: MUTED (click to opt in)';
    if (!on) {
      if (audioNodes && audioNodes.osc) { try { audioNodes.osc.stop(); } catch (e) { /* already stopped */ } }
      if (audioNodes && audioNodes.gain) audioNodes.gain.gain.value = 0;
      if (audioCtx) audioCtx.suspend().catch(() => {});
      audioState('context suspended, output muted');
      return;
    }
    // The AudioContext is created here and nowhere else, inside the explicit
    // user click handler. Its gain stays at zero until the play button fires.
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) { audioState('Web Audio unavailable on this device'); return; }
      if (!audioCtx) {
        audioCtx = new Ctor();
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        gain.connect(audioCtx.destination);
        audioNodes = { gain, osc: null };
      }
      audioState('context created, gain 0.0, no source started');
    } catch (e) { audioState('context creation failed'); }
  }

  function onAudioPlay() {
    if (!$('audioToggle').checked || !audioCtx || !audioNodes) { audioState('muted, nothing played'); return; }
    if (audioNodes.osc) { try { audioNodes.osc.stop(); } catch (e) { /* already stopped */ } audioNodes.osc = null; }
    audioCtx.resume().then(() => {
      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 220;
      const env = audioCtx.createGain();
      env.gain.value = 0;
      // Deliberately tiny and brief. User asked for sound by clicking Play.
      env.gain.linearRampToValueAtTime(0.04, audioCtx.currentTime + 0.02);
      env.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.35);
      osc.connect(env); env.connect(audioNodes.gain);
      audioNodes.gain.gain.value = 1;
      osc.start(); osc.stop(audioCtx.currentTime + 0.36);
      audioNodes.osc = osc;
      audioState('explicit 220 Hz test tone played for 0.36 s');
    }).catch(() => audioState('context resume blocked'));
  }

  function drawDAC() {
    const cv = $('dacCanvas'); if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.fillStyle = '#080c0e'; ctx.fillRect(0, 0, W, H);
    const L = 48, R = 16, T = 18, B = 34;
    ctx.strokeStyle = '#263238'; ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const y = T + (H - T - B) * i / 8;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
      ctx.fillStyle = '#5f717a'; ctx.font = '10px monospace';
      ctx.fillText(fmt(3.3 * (1 - i / 8), 2) + 'V', 6, y + 3);
    }
    for (let i = 0; i <= 8; i++) {
      const x = L + (W - L - R) * i / 8;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, H - B); ctx.stroke();
      ctx.fillStyle = '#5f717a'; ctx.fillText(String(i * 32), x - 8, H - 14);
    }
    const codes = S.DAC.ladderCodes();
    const code = +$('w3Code').value;
    ctx.beginPath();
    for (let c = 0; c < 256; c++) {
      const x = L + (W - L - R) * c / 255, y = T + (H - T - B) * (1 - codes[c] / 3.3);
      if (c === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#4fd1c5'; ctx.lineWidth = 2; ctx.stroke();
    // Ideal straight line for comparison.
    ctx.beginPath(); ctx.moveTo(L, H - B); ctx.lineTo(W - R, T);
    ctx.strokeStyle = '#5a4a28'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    // Selected code marker.
    const mx = L + (W - L - R) * code / 255, my = T + (H - T - B) * (1 - codes[code] / 3.3);
    ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.fillStyle = '#f2a63b'; ctx.fill();
    ctx.strokeStyle = '#f2a63b'; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(mx, H - B); ctx.lineTo(mx, my); ctx.lineTo(L, my); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#8b9ba4'; ctx.font = '10px monospace';
    ctx.fillText('DAC CODE', W - 106, H - 14);
    ctx.fillText('VOUT', 6, 12);
    ctx.fillStyle = '#ffcd7a'; ctx.fillText(`code ${code} = ${fmt(codes[code], 4)} V`, mx + 8, Math.max(16, my - 8));
  }

  function drawScope() {
    const cv = $('scopeCanvas'); if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.fillStyle = '#080c0e'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#1e2a30'; ctx.lineWidth = 1;
    for (let y = 24; y < H; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    for (let x = 30; x < W; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    const a = +$('w3Attack').value, d = +$('w3Decay').value, s = +$('w3Sustain').value / 100, r = +$('w3Release').value;
    const total = a + d + 2200 + r;
    // ADSR envelope trace.
    ctx.beginPath();
    for (let px = 0; px < W; px++) {
      const t = px / W * total;
      const off = t > a + d + 2200;
      const env = S.DAC.adsr(off ? t - a - d - 2200 : t, a, d, s, r, off);
      const y = H - 16 - env * (H - 32);
      if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
    }
    ctx.strokeStyle = '#f2a63b'; ctx.lineWidth = 2; ctx.stroke();
    // Four voice DDS sample trace, quantized to the ladder codes.
    ctx.beginPath();
    const rate = 22050, baseHz = 220;
    for (let px = 0; px < W; px++) {
      const t = Math.floor(px / W * total);
      const off = t > a + d + 2200;
      const env = S.DAC.adsr(off ? t - a - d - 2200 : t, a, d, s, r, off);
      const o = S.DAC.ddsSample(0, { t, rate, baseHz, envelope: env });
      const y = H / 2 - (o.code / 255 - 0.5) * (H - 44);
      if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
    }
    ctx.strokeStyle = '#4fd1c5'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#8b9ba4'; ctx.font = '10px monospace';
    ctx.fillText('ADSR (amber) / 4-VOICE DDS QUANTIZED TO 8 BIT (cyan)', 10, 14);
    $('w3ScopeLabel').textContent = `A ${a} / D ${d} / S ${fmt(s, 2)} / R ${r}`;
  }

  function w3Readout() {
    const code = +$('w3Code').value;
    const codes = S.DAC.ladderCodes();
    const lsb = codes[1] - codes[0];
    const mono = S.DAC.isMonotonic(codes);
    const vals = [
      ['Current code', code + ' / 255'], ['VOUT', fmt(codes[code], 4) + ' V'],
      ['LSB step', fmt(lsb * 1000, 3) + ' mV'], ['Full scale', fmt(codes[255], 4) + ' V'],
      ['INL / ideal', fmt((codes[code] - code * 3.3 / 255) * 1000, 3) + ' mV'],
      ['256-code monotonic', mono ? 'YES' : 'NO', mono ? 'good' : 'bad'],
      ['DDS voices', '4'], ['Envelope stages', 'A / D / S / R']
    ];
    $('w3Readout').innerHTML = vals.map(([k, v, c]) => `<div class="readout"><span class="k">${esc(k)}</span><span class="v ${c || ''}">${esc(v)}</span></div>`).join('');
  }

  function initWeek3() {
    once('w3', () => {
      ['w3Attack', 'w3Decay', 'w3Sustain', 'w3Release', 'w3Code'].forEach(id => {
        $(id).addEventListener('input', () => {
          $('w3AttackOut').textContent = $('w3Attack').value + ' smp';
          $('w3DecayOut').textContent = $('w3Decay').value + ' smp';
          $('w3SustainOut').textContent = fmt(+$('w3Sustain').value / 100, 2);
          $('w3ReleaseOut').textContent = $('w3Release').value + ' smp';
          $('w3CodeOut').textContent = $('w3Code').value;
          drawDAC(); drawScope(); w3Readout();
        });
      });
      $('audioToggle').addEventListener('change', onAudioToggle);
      $('audioPlay').addEventListener('click', onAudioPlay);
      $('w3Files').innerHTML = [
        ['week3-music/pocketchime.kicad_pcb', 'KiCad 8 PCB'],
        ['week3-music/firmware/pocketchime.ino', 'DDS + ADSR firmware'],
        ['week3-music/gerbers/pocketchime-F_Cu.gbr', 'F.Cu RS-274X'],
        ['week3-music/gerbers/pocketchime.drl', 'Excellon drill'],
        ['week3-music/bom.csv', 'BOM $12.19']
      ].map(([p, n]) => `<a href="${p}" target="_blank" rel="noopener">${esc(n)} &#8599;</a>`).join('');
      audioState('no AudioContext created');
    });
    drawDAC(); drawScope(); w3Readout();
  }

  // -------------------------------------------------------------------------
  // Week 4: SSD1306 page buffers and 74HC595 scan.
  // -------------------------------------------------------------------------
  const disp = { p0: null, p1: null, frame: new Uint8Array(8), invert: false, animate: true, scan: 0, tick: 0 };

  function drawOLED(canvas, panel) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#05080a'; ctx.fillRect(0, 0, W, H);
    const px = W / 128;
    const inv = disp.invert;
    for (let page = 0; page < 8; page++) for (let x = 0; x < 128; x++) {
      const byte = panel.pages[page][x];
      for (let b = 0; b < 8; b++) {
        const on = ((byte >> b) & 1) === 1;
        if ((on && !inv) || (!on && inv)) {
          ctx.fillStyle = '#9ce8dc';
          ctx.fillRect(x * px, (page * 8 + b) * px, px - 0.35, px - 0.35);
        }
      }
    }
    ctx.strokeStyle = '#1c2b2c'; ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }

  function renderPanels() {
    disp.p0.clear(); disp.p1.clear();
    const text = $('w4Text').value;
    $('w4TextLen').textContent = text.length + ' chars';
    disp.p0.drawString(2, 2, 'GLYPHMATRIX-128');
    disp.p0.hLine(0, 127, 12);
    disp.p0.drawString(2, 18, text.toUpperCase());
    disp.p0.drawString(2, 30, 'PANEL 0 / 0x3C');
    disp.p0.drawString(2, 42, 'HW I2C 400KHZ OK');
    disp.p0.drawString(2, 54, 'HALF LIFE W4');
    disp.p1.drawString(2, 2, 'HALF LIFE 2026');
    disp.p1.hLine(0, 127, 12);
    const off = +$('w4Bars').value;
    for (let i = 0; i < 8; i++) {
      const h = 8 + ((off + i * 7) % 40);
      disp.p1.vLine(8 + i * 14, 58 - h, 58);
    }
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
      if (disp.frame[r] & (1 << c)) disp.p1.setPixel(60 + c * 3, 20 + r * 3, 1);
    drawOLED($('oled0'), disp.p0);
    drawOLED($('oled1'), disp.p1);
    const lit0 = disp.p0.pages.reduce((s, p) => s + p.reduce((t, b) => t + popcount8(b), 0), 0);
    const lit1 = disp.p1.pages.reduce((s, p) => s + p.reduce((t, b) => t + popcount8(b), 0), 0);
    const scan = S.Display.scanRow(Array.from(disp.frame), disp.scan);
    $('w4Readout').innerHTML = [
      ['Panel 0 buffer', '1024 bytes'], ['Panel 1 buffer', '1024 bytes'],
      ['Lit pixels 0', lit0], ['Lit pixels 1', lit1],
      ['Active row', disp.scan], ['Shift register', '0x' + scan.register.toString(16).toUpperCase().padStart(4, '0')],
      ['Column byte', '0x' + scan.columnByte.toString(16).toUpperCase().padStart(2, '0')],
      ['Row byte', '0x' + scan.rowByte.toString(16).toUpperCase().padStart(2, '0')]
    ].map(([k, v]) => `<div class="readout"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
    $('w4RowLabel').textContent = `row ${disp.scan} / ghost blanking active`;
  }
  function popcount8(b) { let n = 0; while (b) { n += b & 1; b >>= 1; } return n; }

  function drawLED() {
    const cv = $('ledCanvas'); if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    ctx.fillStyle = '#080c0e'; ctx.fillRect(0, 0, W, H);
    const cell = 36, pad = 16;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const on = (disp.frame[r] >> c) & 1;
      const active = r === disp.scan;
      const x = pad + c * cell, y = pad + r * cell;
      ctx.beginPath(); ctx.arc(x + cell / 2, y + cell / 2, cell * 0.33, 0, Math.PI * 2);
      if (on && active) {
        ctx.fillStyle = '#ffcd7a'; ctx.shadowColor = '#f2a63b'; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;
      } else if (on) { ctx.fillStyle = '#6c4c1e'; ctx.fill(); }
      else { ctx.fillStyle = '#182126'; ctx.fill(); }
      ctx.strokeStyle = active ? '#4a5b62' : '#1d282d'; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.fillStyle = '#5f717a'; ctx.font = '10px monospace';
    ctx.fillText(`74HC595 / scanning row ${disp.scan}`, 16, H - 6);
  }

  function updateFrame() {
    const glyph = window.GlyphFont ? window.GlyphFont.glyphColumns(+$('w4Glyph').value) : [0x7C, 0x12, 0x11, 0x12, 0x7C];
    const base = S.Display.ledFrameFromGlyph(glyph);
    for (let r = 0; r < 8; r++) {
      let bits = base[r];
      if ((disp.tick >> 4) & 1) bits |= (r === 0 || r === 7) ? 0xFF : 0x81;
      disp.frame[r] = bits & 0xFF;
    }
  }

  function initWeek4() {
    once('w4', () => {
      disp.p0 = new S.Display.SSD1306(0x3C);
      disp.p1 = new S.Display.SSD1306(0x3D);
      ['w4Text', 'w4Bars', 'w4Glyph', 'w4Scan'].forEach(id => $(id).addEventListener('input', () => {
        $('w4BarsOut').textContent = $('w4Bars').value;
        $('w4GlyphOut').textContent = $('w4Glyph').value;
        $('w4ScanOut').textContent = $('w4Scan').value;
        disp.scan = +$('w4Scan').value;
        updateFrame(); renderPanels(); drawLED();
      }));
      $('w4Animate').addEventListener('click', () => {
        disp.animate = !disp.animate;
        $('w4Animate').textContent = 'Animation: ' + (disp.animate ? 'ON' : 'OFF');
      });
      $('w4Invert').addEventListener('click', () => { disp.invert = !disp.invert; renderPanels(); });
      $('w4Files').innerHTML = [
        ['week4-display/glyphmatrix.kicad_pcb', 'KiCad 8 PCB'],
        ['week4-display/firmware/glyphmatrix.ino', 'I2C + scan firmware'],
        ['week4-display/firmware/font5x7_data.h', '5x7 font header'],
        ['week4-display/font5x7.js', 'font table'],
        ['week4-display/gerbers/glyphmatrix-F_Cu.gbr', 'F.Cu RS-274X'],
        ['week4-display/bom.csv', 'BOM $18.56']
      ].map(([p, n]) => `<a href="${p}" target="_blank" rel="noopener">${esc(n)} &#8599;</a>`).join('');
      setInterval(() => {
        if (document.getElementById('w4').hidden) return;
        if (disp.animate) {
          disp.tick++;
          disp.scan = disp.tick & 7;
          $('w4Scan').value = disp.scan; $('w4ScanOut').textContent = disp.scan;
          $('w4Bars').value = (disp.tick >> 1) & 63; $('w4BarsOut').textContent = $('w4Bars').value;
        }
        updateFrame(); renderPanels(); drawLED();
      }, 180);
    });
    updateFrame(); renderPanels(); drawLED();
  }

  // -------------------------------------------------------------------------
  // Week 5: ALU prover, pin map, counter.
  // -------------------------------------------------------------------------
  const aluState = { A: 3, B: 1, op: 0, q: 0, ic: 'U1' };

  function bitsHtml(container, value, clickable, onToggle) {
    container.innerHTML = '';
    for (let i = 3; i >= 0; i--) {
      const b = document.createElement('button');
      b.className = 'bit' + ((value >> i) & 1 ? ' on' : '') + (clickable ? '' : ' out');
      b.textContent = (value >> i) & 1;
      b.setAttribute('aria-label', `bit ${i}`);
      if (clickable) b.addEventListener('click', () => onToggle(i));
      container.appendChild(b);
    }
  }
  function renderALU() {
    bitsHtml($('bitsA'), aluState.A, true, i => { aluState.A ^= 1 << i; renderALU(); });
    bitsHtml($('bitsB'), aluState.B, true, i => { aluState.B ^= 1 << i; renderALU(); });
    const r = S.ALU.alu(aluState.A, aluState.B, aluState.op);
    bitsHtml($('bitsY'), r.Y, false);
    $('binA').textContent = aluState.A.toString(2).padStart(4, '0') + ' (' + aluState.A + ')';
    $('binB').textContent = aluState.B.toString(2).padStart(4, '0') + ' (' + aluState.B + ')';
    $('binY').textContent = r.Y.toString(2).padStart(4, '0') + ' (' + r.Y + ')';
    $('signalFlow').innerHTML = [
      `SUB = <span class="sig">${r.gates.cin}</span> &rarr; 74HC86 B inversion: B ^ SUB = <span class="sig">${r.gates.bx.toString(2).padStart(4, '0')}</span>`,
      `74HC283: A + BX + CIN = <span class="sig">${r.gates.adderSum.toString(2).padStart(4, '0')}</span>, COUT = <span class="sig">${r.gates.cout}</span>`,
      `74HC08 AND = <span class="sig">${r.gates.and.toString(2).padStart(4, '0')}</span> / 74HC32 OR = <span class="sig">${r.gates.or.toString(2).padStart(4, '0')}</span> / 74HC86 XOR = <span class="sig">${r.gates.xor.toString(2).padStart(4, '0')}</span>`,
      `74HC153 select C${aluState.op} &rarr; Y = <span class="sig">${r.Y.toString(2).padStart(4, '0')}</span>`
    ].join('<br>');
    $('flagRow').innerHTML = [['CARRY', r.CARRY], ['ZERO', r.ZERO], ['OVERFLOW', r.OVERFLOW]]
      .map(([k, v]) => `<span class="flag ${v ? 'on' : ''}">${k} = ${v}</span>`).join('');
    document.querySelectorAll('#opRow button').forEach((b, i) => b.classList.toggle('active', i === aluState.op));
    bitsHtml($('bitsQ'), aluState.q, false);
    $('counterRead').textContent = `Q = ${aluState.q.toString(2).padStart(4, '0')} (${aluState.q}) / 74HC161`;
  }

  function renderPins() {
    const nl = loaded.w5 && loaded.w5['week5-logic/netlist.json'];
    const map = nl ? JSON.parse(nl).pin_map : null;
    const rows = [];
    if (map) {
      const entries = Object.entries(map).filter(([k]) => k.startsWith(aluState.ic + '.')).map(([k, v]) => [+k.split('.')[1], v]).sort((a, b) => a[0] - b[0]);
      const half = Math.ceil(entries.length / 2);
      for (let i = 0; i < half; i++) {
        const l = entries[i], r = entries[i + half];
        rows.push(`<tr><td>${l[0]}</td><td>${esc(l[1])}</td><td>${r ? r[0] : ''}</td><td>${r ? esc(r[1]) : ''}</td></tr>`);
      }
    } else rows.push('<tr><td colspan="4">netlist.json unavailable over file://</td></tr>');
    $('pinTable').innerHTML = rows.join('');
    document.querySelectorAll('#icSelect button').forEach(b => b.classList.toggle('active', b.dataset.ic === aluState.ic));
  }

  function verifyAll() {
    const ref = window.DiscreteALU;
    let checked512 = 0, checked1280 = 0, fails = [];
    for (let A = 0; A < 16; A++) for (let B = 0; B < 16; B++) for (const op of [0, 1]) {
      const r = S.ALU.alu(A, B, op);
      const signedA = A >= 8 ? A - 16 : A, signedB = B >= 8 ? B - 16 : B;
      const exact = op === 0 ? signedA + signedB : signedA - signedB;
      const expectY = exact & 15;
      const expectC = op === 0 ? (A + B > 15 ? 1 : 0) : (A >= B ? 1 : 0);
      const expectV = (exact > 7 || exact < -8) ? 1 : 0;
      const expectZ = expectY === 0 ? 1 : 0;
      if (r.Y !== expectY || r.CARRY !== expectC || r.ZERO !== expectZ || r.OVERFLOW !== expectV)
        fails.push(`ADD/SUB ${A},${B},op${op}`);
      checked512++;
    }
    let cross = 0;
    for (let A = 0; A < 16; A++) for (let B = 0; B < 16; B++) for (let op = 0; op < 5; op++) {
      const r = S.ALU.alu(A, B, op);
      if (typeof window.DiscreteALU !== 'undefined') {
        const n = window.DiscreteALU.evaluate(A, B, op);
        if (n.Y === r.Y && n.CARRY === r.CARRY && n.ZERO === r.ZERO && n.OVERFLOW === r.OVERFLOW) cross++;
      }
      checked1280++;
    }
    const lines = [
      `512-vector ADD/SUB truth table: ${checked512} cases, ${fails.length} failures`,
      `1280-vector five-opcode table: ${checked1280} cases`,
      `Cross-check against week5-logic/alu.js: ${cross} / ${checked1280} identical`,
      fails.length ? `FAILURES: ${fails.slice(0, 6).join(', ')}` : 'RESULT: PASS, all flags and results exact'
    ];
    $('w5VerifyOut').textContent = lines.join('\n');
  }

  function initWeek5() {
    once('w5', () => {
      $('opRow').innerHTML = S.ALU.OP_NAMES.map((n, i) => `<button data-op="${i}">${n}</button>`).join('');
      $('opRow').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { aluState.op = +b.dataset.op; renderALU(); }));
      $('icSelect').innerHTML = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8'].map(x => `<button data-ic="${x}">${x}</button>`).join('');
      $('icSelect').querySelectorAll('button').forEach(b => b.addEventListener('click', () => { aluState.ic = b.dataset.ic; renderPins(); }));
      $('w5Verify').addEventListener('click', verifyAll);
      $('w5Random').addEventListener('click', () => { aluState.A = Math.floor(Math.random() * 16); aluState.B = Math.floor(Math.random() * 16); renderALU(); });
      $('w5Step').addEventListener('click', () => {
        aluState.q = typeof window.DiscreteALU !== 'undefined'
          ? window.DiscreteALU.counterStep(aluState.q).q : (aluState.q + 1) & 15;
        renderALU();
      });
      $('w5Files').innerHTML = [
        ['week5-logic/netlist.json', 'pin accurate netlist'],
        ['week5-logic/BREADBOARD_GUIDE.md', 'breadboard guide'],
        ['week5-logic/alu.js', 'gate level evaluator'],
        ['week5-logic/bom.csv', 'BOM $12.60']
      ].map(([p, n]) => `<a href="${p}" target="_blank" rel="noopener">${esc(n)} &#8599;</a>`).join('');
    });
    renderALU(); renderPins();
  }

  // -------------------------------------------------------------------------
  // Lab: deterministic suite audit, tolerance physics, proof brief, self-tests.
  // All math lives in window.SuiteLab (suite-lab.js). When that file is absent
  // the five hardware tabs keep working untouched and the lab panel reports
  // the module as unavailable.
  // -------------------------------------------------------------------------
  const Lab = window.SuiteLab || null;
  const TOLS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
  const lab = { state: null, sweep: null, profile: null, rows: null, brief: null, stl: null, selfResults: null };

  function labEnv() { return { S, ALU: window.DiscreteALU, FONT: window.GlyphFont, stl: lab.stl }; }
  function labState() { if (!lab.state) lab.state = Lab.defaultState(); return lab.state; }
  function computeSweep() { if (!lab.sweep) lab.sweep = Lab.toleranceSweep(TOLS, 3.3); return lab.sweep; }
  function computeRows() { lab.rows = Lab.auditWeeks(labEnv()); return lab.rows; }
  function computeBrief() { lab.brief = Lab.proofBrief(lab.rows || computeRows(), labState()); return lab.brief; }
  function computeProfile() {
    const st = labState();
    if (!lab.profile || lab.profile.tol !== st.tol) {
      const p = Lab.codeProfile(st.tol / 100, 3.3);
      lab.profile = { tol: st.tol, name: p.name, r: p.r };
    }
    return lab.profile;
  }

  function syncHash() {
    try { history.replaceState(null, '', Lab.encodeState(labState())); } catch (e) { /* file:// */ }
    const d = Lab.decodeState(location.hash);
    let status = d.ok
      ? (d.rejected.length ? 'restored / ' + d.rejected.length + ' clamped' : 'round-trip clean')
      : 'rejected: ' + (d.rejected[0] || 'input');
    if (lab.bootRejection) { status = 'rejected: ' + lab.bootRejection + ' (defaults kept)'; lab.bootRejection = ''; }
    $('labCodecStatus').textContent = status;
  }

  function jumpToWeek(key) {
    labState().week = key;
    syncHash();
    renderComparator();
    const btn = document.querySelector('.tab[data-tab="' + key + '"]');
    if (btn) btn.click();
  }

  function renderComparator() {
    const rows = computeRows();
    const st = labState();
    $('labTable').innerHTML = rows.map((r, i) => {
      const badge = r.metric.pass === true ? '<span class="lab-badge ok">PASS</span>'
        : r.metric.pass === false ? '<span class="lab-badge bad">FAIL</span>'
        : '<span class="lab-badge pend">N/A</span>';
      const hr = r.headroom === null ? 'n/a' : '$' + r.headroom.toFixed(2);
      return `<tr class="lab-row${r.key === st.week ? ' lab-sel' : ''}" tabindex="0" data-week="${r.key}" aria-label="jump to ${esc(r.name)}">` +
        `<td><span class="lab-wk">W${i + 1}</span> <strong>${esc(r.name)}</strong><small>${esc(r.desc)}</small></td>` +
        `<td>${r.bomLabel}</td><td>${r.capLabel}</td><td>${hr}</td>` +
        `<td>${esc(r.metric.label)} = <b>${esc(r.metric.value)}</b><small>${esc(r.metric.detail)}</small></td>` +
        `<td>${badge}</td></tr>`;
    }).join('');
    $('labTable').querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', () => jumpToWeek(tr.dataset.week));
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpToWeek(tr.dataset.week); } });
    });
    const sum = Lab.bomSummary(rows);
    $('labCmpStatus').textContent = 'BOM $' + sum.bomTotal.toFixed(2) + ' vs caps $' + sum.capTotal.toFixed(2);
  }

  function svgAxes(id, W, H, L, R, T, B, xTicks, yTicks, xFmt, yFmt, xLabel, yLabel) {
    let h = `<rect width="${W}" height="${H}" fill="#0a1013"/>`;
    for (const v of yTicks) {
      h += `<line x1="${L}" y1="${v.y}" x2="${W - R}" y2="${v.y}" stroke="#1b252a"/>`;
      h += `<text x="${L - 8}" y="${v.y + 3}" fill="#5f717a" font-size="10" font-family="monospace" text-anchor="end">${yFmt(v.v)}</text>`;
    }
    for (const v of xTicks) {
      h += `<line x1="${v.x}" y1="${T}" x2="${v.x}" y2="${H - B}" stroke="#141d21"/>`;
      h += `<text x="${v.x}" y="${H - B + 14}" fill="#5f717a" font-size="9" font-family="monospace" text-anchor="middle">${xFmt(v.v)}</text>`;
    }
    h += `<text x="${L - 40}" y="${T - 8}" fill="#5f717a" font-size="9" font-family="monospace">${yLabel}</text>`;
    h += `<text x="${W - R - 66}" y="${H - 8}" fill="#5f717a" font-size="9" font-family="monospace">${xLabel}</text>`;
    return h;
  }

  function renderTolChart() {
    const pts = computeSweep();
    const st = labState();
    const W = 700, H = 320, L = 52, R = 18, T = 26, B = 40;
    const peak = Math.max(0.2, ...pts.map(p => Math.max(p.maxInl, p.maxDnl)));
    const yMax = Math.ceil(peak * 10) / 10 + 0.05;
    const X = t => L + (W - L - R) * t / 5;
    const Y = v => T + (H - T - B) * (1 - Math.min(v, yMax) / yMax);
    let h = svgAxes(0, W, H, L, R, T, B,
      TOLS.map(t => ({ v: t, x: X(t) })),
      [0, 1, 2, 3, 4, 5].map(i => ({ v: yMax * i / 5, y: Y(yMax * i / 5) })),
      t => t + '%', v => v.toFixed(2), 'tolerance', 'LSB err');
    h += `<text x="${L + 8}" y="${T + 12}" fill="#f2a63b" font-size="10" font-family="monospace">INL worst</text>`;
    h += `<text x="${L + 8}" y="${T + 26}" fill="#4fd1c5" font-size="10" font-family="monospace">DNL worst</text>`;
    if (yMax >= 1) h += `<line x1="${L}" y1="${Y(1)}" x2="${W - R}" y2="${Y(1)}" stroke="#5a4a28" stroke-dasharray="4 4"/>` +
      `<text x="${W - R - 92}" y="${Y(1) - 6}" fill="#5f717a" font-size="9" font-family="monospace">ideal step 1.0</text>`;
    const path = k => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.tol * 100).toFixed(1)} ${Y(p[k]).toFixed(1)}`).join(' ');
    if (st.curve !== 'dnl') h += `<path d="${path('maxInl')}" fill="none" stroke="#f2a63b" stroke-width="2"/>`;
    if (st.curve !== 'inl') h += `<path d="${path('maxDnl')}" fill="none" stroke="#4fd1c5" stroke-width="2"/>`;
    for (const p of pts) {
      const tp = p.tol * 100;
      const sel = Math.abs(st.tol - tp) < 1e-9;
      for (const k of ['maxInl', 'maxDnl']) {
        if ((k === 'maxInl' && st.curve === 'dnl') || (k === 'maxDnl' && st.curve === 'inl')) continue;
        const col = k === 'maxInl' ? '#f2a63b' : '#4fd1c5';
        h += `<g class="hit" tabindex="0" role="button" data-tol="${tp}" aria-label="tolerance ${tp} percent, ${k} ${p[k].toFixed(3)} LSB">` +
          `<circle cx="${X(tp)}" cy="${Y(p[k])}" r="${sel ? 5 : 3.5}" fill="${col}"${sel ? ' stroke="#e6edf0" stroke-width="1.5"' : ''}/>` +
          `<circle cx="${X(tp)}" cy="${Y(p[k])}" r="13" fill="rgba(0,0,0,0)" pointer-events="all"/></g>`;
      }
    }
    $('labTolSvg').innerHTML = h;
    $('labTolSvg').querySelectorAll('g.hit').forEach(g => {
      const pick = () => { labState().tol = +g.dataset.tol; renderLab(); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
    const sp = pts.reduce((a, p) => Math.abs(p.tol * 100 - st.tol) < Math.abs(a.tol * 100 - st.tol) ? p : a, pts[0]);
    $('labTolStatus').textContent = sp.patterns + ' patterns, worst ' + sp.worst;
    $('labTolNote').textContent = 'At ' + fmt(st.tol, 1) + '% worst-case mismatch across ' + sp.patterns +
      ' deterministic patterns: max INL ' + fmt(sp.maxInl, 3) + ' LSB, max DNL ' + fmt(sp.maxDnl, 3) +
      ' LSB, min step ' + fmt(sp.minStep, 3) + ' LSB, monotonic in ' + sp.monoCount + '/' + sp.patterns + ' patterns.';
  }

  function renderProfile() {
    const p = computeProfile();
    const st = labState();
    const r = p.r;
    const W = 700, H = 170, L = 46, R = 14, T = 18, B = 28;
    const m = Math.max(0.2, r.maxInl * 1.15);
    const X = c => L + (W - L - R) * c / 255;
    const Y = v => T + (H - T - B) * (1 - (v + m) / (2 * m));
    let h = svgAxes(0, W, H, L, R, T, B,
      [0, 64, 128, 192, 255].map(c => ({ v: c, x: X(c) })),
      [-m, -m / 2, 0, m / 2, m].map(v => ({ v, y: Y(v) })),
      c => String(c), v => v.toFixed(2), 'code', 'INL');
    h += `<path d="` + r.inl.map((v, c) => `${c ? 'L' : 'M'}${X(c).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ') + `" fill="none" stroke="#f2a63b" stroke-width="1.6"/>`;
    const cy = Y(r.inl[st.code]);
    h += `<circle cx="${X(st.code)}" cy="${cy}" r="5" fill="#ffcd7a" stroke="#e6edf0" stroke-width="1.2"/>` +
      `<line x1="${X(st.code)}" y1="${cy}" x2="${X(st.code)}" y2="${H - B}" stroke="#5a4a28" stroke-dasharray="3 3"/>` +
      `<text x="${Math.min(W - 160, X(st.code) + 8)}" y="${Math.max(T + 6, cy - 8)}" fill="#ffcd7a" font-size="10" font-family="monospace">code ${st.code}: ${fmt(r.inl[st.code], 3)} LSB</text>`;
    $('labCodeProfileSvg').innerHTML = h;
    $('labProfileLabel').textContent = 'worst pattern ' + p.name + ' at ' + fmt(st.tol, 1) + '%';
  }

  function renderInaChart() {
    const st = labState();
    const sw = Lab.inaSweep({ iMax: st.imax, vbus: st.vbus, points: 65 });
    const W = 700, H = 300, L = 52, R = 18, T = 26, B = 38;
    const yMax = Math.max(0.4, Math.max(sw.maxBusW, sw.maxShuntW) * 1.08);
    const X = a => L + (W - L - R) * a / sw.iMax;
    const Y = w => T + (H - T - B) * (1 - w / yMax);
    let h = svgAxes(0, W, H, L, R, T, B,
      [0, 1, 2, 3, 4].map(i => ({ v: sw.iMax * i / 4, x: X(sw.iMax * i / 4) })),
      [0, 1, 2, 3, 4, 5].map(i => ({ v: yMax * i / 5, y: Y(yMax * i / 5) })),
      a => fmt(a, 1), w => fmt(w, 1), 'amps', 'watts');
    h += `<text x="${L + 8}" y="${T + 12}" fill="#f2a63b" font-size="10" font-family="monospace">shunt I^2R</text>`;
    h += `<text x="${L + 8}" y="${T + 26}" fill="#4fd1c5" font-size="10" font-family="monospace">bus power</text>`;
    const curve = (k, col) => `<path d="` + sw.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.a).toFixed(1)} ${Y(p[k]).toFixed(1)}`).join(' ') + `" fill="none" stroke="${col}" stroke-width="2"/>`;
    h += curve('shuntW', '#f2a63b') + curve('busW', '#4fd1c5');
    const mark = (a, label, col) => {
      if (a > sw.iMax) return '';
      const pw = a * a * sw.shunt, pb = a * sw.vbus;
      return `<line x1="${X(a)}" y1="${T}" x2="${X(a)}" y2="${H - B}" stroke="${col}" stroke-dasharray="4 4"/>` +
        `<g class="hit" tabindex="0" role="button" data-a="${a}" aria-label="${esc(label)} at ${fmt(a, 2)} amps">` +
        `<circle cx="${X(a)}" cy="${Y(pw)}" r="5" fill="${col}"/>` +
        `<circle cx="${X(a)}" cy="${Y(pw)}" r="14" fill="rgba(0,0,0,0)" pointer-events="all"/></g>` +
        `<text x="${X(a) + 6}" y="${T + 12}" fill="${col}" font-size="9" font-family="monospace">${esc(label)}</text>`;
    };
    h += mark(sw.ratedA, '0.25W rated ' + fmt(sw.ratedA, 2) + 'A', '#7fd18a');
    h += mark(sw.adcFs, 'ADC FS ' + fmt(sw.adcFs, 2) + 'A', '#ec6b5e');
    $('labInaSvg').innerHTML = h;
    $('labInaSvg').querySelectorAll('g.hit').forEach(g => {
      const note = () => {
        const a = +g.dataset.a;
        $('labInaNote').textContent = 'Probe ' + fmt(a, 3) + ' A: shunt drop ' + fmt(a * sw.shunt * 1000, 1) +
          ' mV, dissipation ' + fmt(a * a * sw.shunt, 3) + ' W, bus power ' + fmt(a * sw.vbus, 3) + ' W, ' +
          Math.round(a * sw.shunt / 40e-6) + ' counts' + (a * sw.shunt > 0.32 ? ' (ADC saturated)' : '') + '.';
      };
      g.addEventListener('click', note);
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); note(); } });
    });
    $('labInaStatus').textContent = 'FS ' + fmt(sw.adcFs, 2) + ' A / rated ' + fmt(sw.ratedA, 2) + ' A';
    $('labInaNote').textContent = 'At ' + fmt(sw.iMax, 3) + ' A on the 0.1 ohm 1206 shunt: drop ' + fmt(sw.iMax * 0.1 * 1000, 0) +
      ' mV, dissipation ' + fmt(sw.maxShuntW, 3) + ' W (package rated 0.25 W), bus power ' + fmt(sw.maxBusW, 2) +
      ' W at ' + fmt(sw.vbus, 2) + ' V, LSB ' + '40 uA (' + Math.round(sw.iMax * 0.1 / 40e-6) + ' counts).';
  }

  function renderBomChart() {
    const rows = computeRows();
    const W = 700, H = 300, L = 48, R = 18, T = 30, B = 42;
    const yMax = 26;
    const colW = (W - L - R) / 5;
    const X = i => L + i * colW;
    const Y = v => T + (H - T - B) * (1 - v / yMax);
    let h = svgAxes(0, W, H, L, R, T, B,
      [],
      [0, 5, 10, 15, 20, 25].map(v => ({ v, y: Y(v) })),
      v => '', v => '$' + v, '', 'USD');
    rows.forEach((r, i) => {
      const cx = X(i), bw = colW * 0.34;
      h += `<g class="hit" tabindex="0" role="button" data-week="${r.key}" aria-label="jump to ${esc(r.name)}">` +
        `<rect x="${cx}" y="${T}" width="${colW}" height="${H - T - B}" fill="rgba(0,0,0,0)" pointer-events="all"/>`;
      if (r.cap !== null)
        h += `<rect x="${cx + colW * 0.30}" y="${Y(r.cap)}" width="${bw}" height="${H - B - Y(r.cap)}" fill="#1a2227" stroke="#39474f"/>`;
      if (r.bom !== null) {
        h += `<rect x="${cx + colW * 0.30}" y="${Y(r.bom)}" width="${bw}" height="${H - B - Y(r.bom)}" fill="#f2a63b" opacity="0.85"/>`;
        h += `<text x="${cx + colW * 0.30 + bw / 2}" y="${Y(r.bom) - 6}" fill="#ffcd7a" font-size="10" font-family="monospace" text-anchor="middle">$${r.bom.toFixed(2)}</text>`;
        h += `<text x="${cx + colW * 0.30 + bw / 2}" y="${Y(r.cap) - 6}" fill="#8b9ba4" font-size="9" font-family="monospace" text-anchor="middle">cap $${r.cap.toFixed(0)}</text>`;
      } else {
        h += `<text x="${cx + colW / 2}" y="${T + 34}" fill="#5f717a" font-size="10" font-family="monospace" text-anchor="middle">print</text>`;
        h += `<text x="${cx + colW / 2}" y="${T + 48}" fill="#5f717a" font-size="10" font-family="monospace" text-anchor="middle">only</text>`;
      }
      h += `<text x="${cx + colW / 2}" y="${H - B + 16}" fill="#8b9ba4" font-size="10" font-family="monospace" text-anchor="middle">${r.key}</text>` +
        `<text x="${cx + colW / 2}" y="${H - B + 30}" fill="#5f717a" font-size="8" font-family="monospace" text-anchor="middle">${esc(r.name)}</text></g>`;
    });
    $('labBomSvg').innerHTML = h;
    $('labBomSvg').querySelectorAll('g.hit').forEach(g => {
      g.addEventListener('click', () => jumpToWeek(g.dataset.week));
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jumpToWeek(g.dataset.week); } });
    });
  }

  function renderReadout() {
    const st = labState();
    const pts = computeSweep();
    const sp = pts.reduce((a, p) => Math.abs(p.tol * 100 - st.tol) < Math.abs(a.tol * 100 - st.tol) ? p : a, pts[0]);
    const b = computeBrief();
    const vals = [
      ['Tolerance', fmt(st.tol, 1) + ' %'], ['Sweep max', fmt(st.imax, 3) + ' A'],
      ['Bus voltage', fmt(st.vbus, 3) + ' V'], ['DAC probe', st.code + ' / 255'],
      ['Max INL', fmt(sp.maxInl, 3) + ' LSB'], ['Max DNL', fmt(sp.maxDnl, 3) + ' LSB'],
      ['Min step', fmt(sp.minStep, 3) + ' LSB'], ['Worst pattern', sp.worst],
      ['Week focus', st.week.toUpperCase()], ['Digest', b.sha256.slice(0, 12) + '...']
    ];
    $('labReadout').innerHTML = vals.map(([k, v]) =>
      `<div class="readout"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  }

  function renderDigest() {
    const b = computeBrief();
    $('labDigest').textContent = b.sha256;
    $('labDigestStatus').textContent = b.bytes + ' canonical bytes';
  }

  function download(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function renderLab() {
    if (!Lab) return;
    computeRows();
    renderComparator(); renderTolChart(); renderProfile(); renderInaChart(); renderBomChart(); renderReadout(); renderDigest(); syncHash();
    document.querySelectorAll('#labCurveBtns button').forEach(b => b.classList.toggle('active', b.dataset.c === labState().curve));
  }

  function initLab() {
    if (!Lab) {
      once('lab-missing', () => {
        $('labCmpStatus').textContent = 'suite-lab.js unavailable';
        $('labDigest').textContent = 'module not loaded';
      });
      return;
    }
    once('lab', () => {
      lab.state = Lab.defaultState();
      if (location.hash.startsWith('#hlab=')) {
        const d = Lab.decodeState(location.hash);
        if (d.ok) lab.state = d.state;
        else lab.bootRejection = d.rejected.join(', ') || 'input';
        $('labCodecStatus').textContent = d.ok ? 'restored from hash' : 'rejected: ' + lab.bootRejection;
      }
      const s = labState();
      $('labTol').value = Math.round(s.tol * 10); $('labTolOut').textContent = fmt(s.tol, 1) + '%';
      $('labImax').value = Math.round(s.imax * 1000); $('labImaxOut').textContent = fmt(s.imax, 3) + ' A';
      $('labVbus').value = Math.round(s.vbus * 1000); $('labVbusOut').textContent = fmt(s.vbus, 3) + ' V';
      $('labCode').value = s.code; $('labCodeOut').textContent = String(s.code);
      const bind = (id, out, apply, show) => $(id).addEventListener('input', () => {
        const v = +$(id).value;
        apply(v); $(out).textContent = show(v); renderLab();
      });
      bind('labTol', 'labTolOut', v => labState().tol = v / 10, v => fmt(v / 10, 1) + '%');
      bind('labImax', 'labImaxOut', v => labState().imax = v / 1000, v => fmt(v / 1000, 3) + ' A');
      bind('labVbus', 'labVbusOut', v => labState().vbus = v / 1000, v => fmt(v / 1000, 3) + ' V');
      bind('labCode', 'labCodeOut', v => labState().code = v, v => String(v));
      $('labCurveBtns').innerHTML = ['inl', 'dnl', 'both'].map(c => `<button data-c="${c}">${c.toUpperCase()}</button>`).join('');
      $('labCurveBtns').querySelectorAll('button').forEach(b =>
        b.addEventListener('click', () => { labState().curve = b.dataset.c; renderLab(); }));
      $('labVerify').addEventListener('click', () => {
        const b = computeBrief();
        $('labDigestOut').textContent = Lab.verifyBrief(b)
          ? 'VERIFY PASS: recomputed sha256 of the canonical payload equals ' + b.sha256.slice(0, 20) + '...'
          : 'VERIFY FAIL: digest mismatch';
      });
      $('labTamper').addEventListener('click', () => {
        const b = computeBrief();
        const t = Lab.tamperDemo(b);
        $('labDigestOut').textContent = t.detected
          ? 'TAMPER DETECTED: ' + t.field + ' ' + t.from + ' -> ' + t.to + ' gives sha256 ' + t.tamperedSha256.slice(0, 20) +
            '... vs sealed ' + t.originalSha256.slice(0, 20) + '...'
          : 'tamper not detected (unexpected)';
      });
      $('labExportJson').addEventListener('click', () => download('halflife-proof-brief.json', Lab.briefJSON(computeBrief()), 'application/json'));
      $('labExportCsv').addEventListener('click', () => download('halflife-proof-brief.csv', Lab.briefCSV(computeBrief()), 'text/csv'));
      $('labExportMd').addEventListener('click', () => download('halflife-proof-brief.md', Lab.briefMarkdown(computeBrief()), 'text/markdown'));
      $('labShare').addEventListener('click', () => {
        syncHash();
        const link = location.href;
        const done = ok => { $('labDigestOut').textContent = ok ? 'State link copied: ' + link : 'State link: ' + link; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(() => done(true), () => done(false));
        else done(false);
      });
      $('labSelfTestBtn').addEventListener('click', () => {
        lab.selfResults = Lab.selfTest(labEnv());
        const n = lab.selfResults.filter(r => r.pass).length;
        $('labSelfTestCount').textContent = n + ' / ' + lab.selfResults.length + ' passed';
        $('labSelfTestList').innerHTML = lab.selfResults.map(r =>
          `<li class="${r.pass ? 'ok' : 'bad'}">${r.pass ? 'PASS' : 'FAIL'} ${esc(r.name)} <b>${esc(r.detail)}</b></li>`).join('');
      });
      $('labFiles').innerHTML = [
        ['suite-lab.js', 'lab module (UMD)'], ['test.js', 'node --test entry'],
        ['suite-lab.test.js', 'lab test suite'], ['suite.js', 'physics models'],
        ['week5-logic/alu.js', 'gate evaluator']
      ].map(([p, n]) => `<a href="${p}" target="_blank" rel="noopener">${esc(n)} &#8599;</a>`).join('');
      loadWeek('w2').then(d => {
        const st = {
          base_chassis: d['week2-cad/base_chassis.stl'],
          tilt_cradle: d['week2-cad/tilt_cradle.stl'],
          detent_dial: d['week2-cad/detent_dial.stl']
        };
        lab.stl = st.base_chassis ? st : null;
        renderComparator(); renderDigest();
      });
      window.__hllab = {
        lab, state: labState, sweep: computeSweep, rows: () => lab.rows, brief: () => lab.brief,
        selftest: () => lab.selfResults, codec: Lab, render: renderLab
      };
    });
    renderLab();
  }

  // -------------------------------------------------------------------------
  // Boot: week 1 is visible, no other week fetches until its tab is clicked.
  // A #hlab= bookmark boots straight into the lab with its state restored.
  // -------------------------------------------------------------------------
  $('footTot').textContent = 'BOM $6.90 / $12.19 / $18.56 / $12.60';
  if (Lab && location.hash.startsWith('#hlab=')) {
    const labTab = document.querySelector('.tab[data-tab="lab"]');
    if (labTab) labTab.click(); else loadWeek('w1').then(() => readyWeek('w1'));
  } else {
    loadWeek('w1').then(() => readyWeek('w1'));
  }
})();
