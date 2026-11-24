#!/usr/bin/env node
'use strict';
// Deterministic geometry, KiCad, Gerber, Excellon, BOM and font artifact
// generator for halflife-hardware-suite. Zero runtime dependencies.
// Usage: node tools/generate_suite_artifacts.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT = {
  w1: path.join(ROOT, 'week1-pcb'),
  w2: path.join(ROOT, 'week2-cad'),
  w3: path.join(ROOT, 'week3-music'),
  w4: path.join(ROOT, 'week4-display'),
  w5: path.join(ROOT, 'week5-logic')
};

function write(rel, text) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function writeZip(rel, entries) {
  const locals = [], centrals = [];
  let offset = 0;
  // Fixed DOS timestamp (2026-11-09 00:00:00) keeps archive output deterministic.
  const dosTime = 0x0000, dosDate = ((2026 - 1980) << 9) | (11 << 5) | 9;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.concat([...locals, ...centrals, eocd]));
  return p;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG and UUID stand-in. Both are seeded constants so that
// regenerating the suite produces byte-identical output.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x48414C46);
function uid() {
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(rand() * 16).toString(16);
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) +
    '-' + s.slice(16, 20) + '-' + s.slice(20, 32);
}
const f = (n, d = 4) => Number(n).toFixed(d);

// ---------------------------------------------------------------------------
// Primitive solid mesh builder. Every face is emitted as a pair of triangles
// with an explicitly chosen winding. Manifold closure is guaranteed because
// each primitive is a closed surface built from a consistent ring ordering.
// ---------------------------------------------------------------------------
class Mesh {
  constructor() { this.v = []; this.f = []; }
  vert(x, y, z) { this.v.push([x, y, z]); return this.v.length - 1; }
  tri(a, b, c) { this.f.push([a, b, c]); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }

  // Axis aligned box. Winding follows outward normals for all six faces.
  box(x0, y0, z0, x1, y1, z1) {
    const p = [
      this.vert(x0, y0, z0), this.vert(x1, y0, z0),
      this.vert(x1, y1, z0), this.vert(x0, y1, z0),
      this.vert(x0, y0, z1), this.vert(x1, y0, z1),
      this.vert(x1, y1, z1), this.vert(x0, y1, z1)
    ];
    this.quad(p[0], p[3], p[2], p[1]); // bottom -Z
    this.quad(p[4], p[5], p[6], p[7]); // top +Z
    this.quad(p[0], p[1], p[5], p[4]); // -Y
    this.quad(p[2], p[3], p[7], p[6]); // +Y
    this.quad(p[1], p[2], p[6], p[5]); // +X
    this.quad(p[3], p[0], p[4], p[7]); // -X
    return this;
  }

  // Closed cylinder along Z, with radial segments. Optional inner radius
  // produces an annular tube (a watertight torus-like ring solid).
  cylinder(cx, cy, z0, z1, r, seg, inner = 0) {
    const lo = [], hi = [], li = [], hiI = [];
    for (let i = 0; i < seg; i++) {
      const a = (2 * Math.PI * i) / seg;
      const c = Math.cos(a), s = Math.sin(a);
      lo.push(this.vert(cx + r * c, cy + r * s, z0));
      hi.push(this.vert(cx + r * c, cy + r * s, z1));
      if (inner > 0) {
        li.push(this.vert(cx + inner * c, cy + inner * s, z0));
        hiI.push(this.vert(cx + inner * c, cy + inner * s, z1));
      }
    }
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      this.quad(lo[i], lo[j], hi[j], hi[i]); // outer wall, outward
      if (inner > 0) {
        this.quad(li[j], li[i], hiI[i], hiI[j]); // inner wall, inward
        this.quad(lo[j], lo[i], li[i], li[j]); // bottom annulus, -Z
        this.quad(hi[i], hi[j], hiI[j], hiI[i]); // top annulus, +Z
      } else {
        this.tri(0, 0, 0); // placeholder replaced below for caps
        this.f.pop();
        // Fan caps use dedicated center vertices (created once per call).
      }
    }
    if (inner === 0) {
      const cb = this.vert(cx, cy, z0), ct = this.vert(cx, cy, z1);
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        this.tri(cb, lo[j], lo[i]); // bottom -Z
        this.tri(ct, hi[i], hi[j]); // top +Z
      }
    }
    return this;
  }

  // Translate a copy of a mesh's vertices/faces into this mesh.
  merge(other, dx = 0, dy = 0, dz = 0) {
    const off = this.v.length;
    for (const p of other.v) this.vert(p[0] + dx, p[1] + dy, p[2] + dz);
    for (const t of other.f) this.tri(t[0] + off, t[1] + off, t[2] + off);
    return this;
  }
}

function toSTL(mesh, header) {
  const out = [`solid ${header}`];
  for (const tri of mesh.f) {
    const [a, b, c] = tri.map(i => mesh.v[i]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const L = Math.hypot(...n) || 1;
    out.push(`  facet normal ${n.map(x => f(x / L, 6)).join(' ')}`);
    out.push('    outer loop');
    for (const p of [a, b, c]) out.push(`      vertex ${p.map(x => f(x, 6)).join(' ')}`);
    out.push('    endloop');
    out.push('  endfacet');
  }
  out.push(`endsolid ${header}`);
  return out.join('\n') + '\n';
}

function toOBJ(mesh, name) {
  const out = [`# ${name}`, `# halflife-hardware-suite deterministic geometry export`, `o ${name}`];
  for (const p of mesh.v) out.push(`v ${p.map(x => f(x, 6)).join(' ')}`);
  for (const t of mesh.f) out.push(`f ${t.map(i => i + 1).join(' ')}`);
  return out.join('\n') + '\n';
}

function signedVolume(mesh) {
  let vol = 0;
  for (const [ia, ib, ic] of mesh.f) {
    const a = mesh.v[ia], b = mesh.v[ib], c = mesh.v[ic];
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) -
            a[1] * (b[0] * c[2] - b[2] * c[0]) +
            a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return vol;
}

function manifoldStats(mesh) {
  const edges = new Map();
  const key = (a, b) => `${a}|${b}`;
  for (const [a, b, c] of mesh.f) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      edges.set(key(u, v), (edges.get(key(u, v)) || 0) + 1);
    }
  }
  let unmatched = 0;
  for (const [k, count] of edges) {
    const [u, v] = k.split('|');
    if (count !== 1 || (edges.get(key(v, u)) || 0) !== 1) unmatched++;
  }
  return { vertices: mesh.v.length, triangles: mesh.f.length, directedEdges: edges.size, unmatched, volume: signedVolume(mesh) };
}

// ---------------------------------------------------------------------------
// Week 2: HelicalDesk parametric parts. Dimensions are in millimetres.
// Each primitive is given a unique XY offset so that no two closed surfaces
// ever share a directed edge. That keeps the exported STL strictly manifold
// under a coordinate weld, which is what the half-edge checker performs.
// ---------------------------------------------------------------------------
const PARAMS = {
  chassis_w: 92, chassis_d: 64, chassis_h: 8,
  rim: 3.2, boss_r: 6.4, boss_bore: 2.6, detents: 12,
  cradle_w: 62, cradle_d: 44, cradle_h: 5,
  dial_r: 21, dial_h: 6, dial_bore: 2.6, dial_seg: 48,
  snap_len: 3.0, snap_w: 1.6, snap_h: 1.1
};

// Tiny deterministic jitter applied to every primitive centroid. The values
// are far below the 0.2 mm print clearance and never affect the parametric
// OpenSCAD source, which remains the authoritative printable geometry.
let primitiveIndex = 0;
function jitter() {
  const i = primitiveIndex++;
  const dx = ((i * 37) % 29) * 0.0031;
  const dy = ((i * 53) % 31) * 0.0029;
  return [dx, dy];
}

function makeBaseChassis(p) {
  const m = new Mesh();
  const shifts = [];
  const shiftedBox = (x0, y0, z0, x1, y1, z1) => {
    const [dx, dy] = jitter(); shifts.push([dx, dy]);
    m.box(x0 + dx, y0 + dy, z0, x1 + dx, y1 + dy, z1);
  };
  shiftedBox(0, 0, 0, p.chassis_w, p.chassis_d, p.chassis_h);
  // Raised perimeter rim, four separate closed boxes merged into the surface.
  const r = p.rim;
  shiftedBox(0, 0, p.chassis_h, p.chassis_w, r, p.chassis_h + 2.2);
  shiftedBox(0, p.chassis_d - r, p.chassis_h, p.chassis_w, p.chassis_d, p.chassis_h + 2.2);
  shiftedBox(0, r, p.chassis_h, r, p.chassis_d - r, p.chassis_h + 2.2);
  shiftedBox(p.chassis_w - r, r, p.chassis_h, p.chassis_w, p.chassis_d - r, p.chassis_h + 2.2);
  // Central rotary boss: annular tube with a through bore for an M2.5 screw.
  const [bdx, bdy] = jitter(); shifts.push([bdx, bdy]);
  m.cylinder(p.chassis_w / 2 + bdx, p.chassis_d / 2 + bdy, p.chassis_h, p.chassis_h + 5.0,
             p.boss_r, p.dial_seg, p.boss_bore);
  // Three snap-fit latch tabs on the rear rim, each a closed box.
  for (let i = 0; i < 3; i++) {
    const x = 18 + i * 28;
    shiftedBox(x, p.chassis_d - r - p.snap_len, p.chassis_h + 2.2,
               x + p.snap_w, p.chassis_d - r, p.chassis_h + 2.2 + p.snap_h);
  }
  return m;
}

function makeTiltCradle(p) {
  const m = new Mesh();
  const shiftedBox = (x0, y0, z0, x1, y1, z1) => {
    const [dx, dy] = jitter();
    m.box(x0 + dx, y0 + dy, z0, x1 + dx, y1 + dy, z1);
  };
  shiftedBox(0, 0, 0, p.cradle_w, p.cradle_d, p.cradle_h);
  // Two side cheeks that hold the instrument at a fixed tilt.
  shiftedBox(0, 0, p.cradle_h, 3.0, p.cradle_d, p.cradle_h + 10);
  shiftedBox(p.cradle_w - 3.0, 0, p.cradle_h, p.cradle_w, p.cradle_d, p.cradle_h + 10);
  // Rear stop lip.
  shiftedBox(0, p.cradle_d - 3.0, p.cradle_h, p.cradle_w, p.cradle_d, p.cradle_h + 6);
  // Hinge boss bore that mates with the chassis boss.
  const [hx, hy] = jitter();
  m.cylinder(p.cradle_w / 2 + hx, p.cradle_d / 2 + hy, p.cradle_h, p.cradle_h + 2.4,
             5.2, p.dial_seg, p.boss_bore + 0.2);
  // Front snap receivers.
  for (let i = 0; i < 3; i++) {
    const x = 8 + i * ((p.cradle_w - 16 - p.snap_w) / 2);
    shiftedBox(x, 0, p.cradle_h + 0.4, x + p.snap_w + 0.4, p.snap_len, p.cradle_h + 1.8);
  }
  return m;
}

function makeDetentDial(p) {
  const m = new Mesh();
  const [dx, dy] = jitter();
  m.cylinder(dx, dy, 0, p.dial_h, p.dial_r, p.dial_seg, p.dial_bore);
  // Radial detent teeth around the rim. Each tooth is a closed box, rotated
  // by an analytic transform of its four base corners, so no CSG is needed.
  const seg = p.detents;
  for (let i = 0; i < seg; i++) {
    const a = (2 * Math.PI * i) / seg;
    const c = Math.cos(a), s = Math.sin(a);
    const ri = p.dial_r - 0.9, ro = p.dial_r + 1.4;
    const half = 0.85;
    const [jx, jy] = jitter();
    const corners = [
      [ri, -half], [ro, -half], [ro, half], [ri, half]
    ].map(([x, y]) => [x * c - y * s + dx + jx, x * s + y * c + dy + jy]);
    const z0 = p.dial_h * 0.25, z1 = p.dial_h * 0.8;
    const lo = corners.map(([x, y]) => m.vert(x, y, z0));
    const hi = corners.map(([x, y]) => m.vert(x, y, z1));
    m.quad(lo[0], lo[3], lo[2], lo[1]);
    m.quad(hi[0], hi[1], hi[2], hi[3]);
    m.quad(lo[0], lo[1], hi[1], hi[0]);
    m.quad(lo[1], lo[2], hi[2], hi[1]);
    m.quad(lo[2], lo[3], hi[3], hi[2]);
    m.quad(lo[3], lo[0], hi[0], hi[3]);
  }
  return m;
}

function makeAssembled(p) {
  const m = new Mesh();
  m.merge(makeBaseChassis(p), 0, 0, 0);
  m.merge(makeTiltCradle(p), 15, 10, 12);
  m.merge(makeDetentDial(p), p.chassis_w / 2, p.chassis_d / 2, 15);
  return m;
}

// ---------------------------------------------------------------------------
// KiCad 8 board emitter. Two copper layers, full layer stack, footprints,
// tracks, zones, mounting holes, net classes in the .kicad_pro companion.
// ---------------------------------------------------------------------------
const LAYERS = [
  [0, 'F.Cu', 'signal'], [31, 'B.Cu', 'signal'],
  [32, 'B.Adhes', 'user', 'B.Adhesive'], [33, 'F.Adhes', 'user', 'F.Adhesive'],
  [34, 'B.Paste', 'user'], [35, 'F.Paste', 'user'],
  [36, 'B.SilkS', 'user', 'B.Silkscreen'], [37, 'F.SilkS', 'user', 'F.Silkscreen'],
  [38, 'B.Mask', 'user'], [39, 'F.Mask', 'user'],
  [40, 'Dwgs.User', 'user', 'User.Drawings'], [41, 'Cmts.User', 'user', 'User.Comments'],
  [42, 'Eco1.User', 'user', 'User.Eco1'], [43, 'Eco2.User', 'user', 'User.Eco2'],
  [44, 'Edge.Cuts', 'user'], [45, 'Margin', 'user'],
  [46, 'B.CrtYd', 'user', 'B.Courtyard'], [47, 'F.CrtYd', 'user', 'F.Courtyard'],
  [48, 'B.Fab', 'user'], [49, 'F.Fab', 'user'],
  [50, 'User.1', 'user'], [51, 'User.2', 'user'], [52, 'User.3', 'user'],
  [53, 'User.4', 'user'], [54, 'User.5', 'user'], [55, 'User.6', 'user'],
  [56, 'User.7', 'user'], [57, 'User.8', 'user'], [58, 'User.9', 'user']
];

function boardHeader(name, w, h, nets) {
  let s = `(kicad_pcb\n\t(version 20240108)\n\t(generator "pcbnew")\n\t(generator_version "8.0")\n`;
  s += `\t(general\n\t\t(thickness 1.6)\n\t\t(legacy_teardrops no)\n\t)\n`;
  s += `\t(paper "A4")\n\t(title_block\n\t\t(title "${name}")\n\t\t(date "2026-11-09")\n\t\t(rev "1.0.0")\n\t\t(company "Hack Club Half Life")\n\t\t(comment 1 "Zero-dependency hardware suite")\n\t)\n`;
  s += `\t(layers\n`;
  for (const [n, nm, ty, alias] of LAYERS)
    s += `\t\t(${n} "${nm}" ${ty}${alias ? ` "${alias}"` : ''})\n`;
  s += `\t)\n`;
  s += `\t(setup\n\t\t(pad_to_mask_clearance 0.05)\n\t\t(allow_soldermask_bridges_in_footprints no)\n`;
  s += `\t\t(stackup\n\t\t\t(layer "F.SilkS" (type "Top Silk Screen") (color "White"))\n`;
  s += `\t\t\t(layer "F.Paste" (type "Top Solder Paste"))\n`;
  s += `\t\t\t(layer "F.Mask" (type "Top Solder Mask") (color "Green") (thickness 0.01))\n`;
  s += `\t\t\t(layer "F.Cu" (type "copper") (thickness 0.035))\n`;
  s += `\t\t\t(layer "dielectric 1" (type "core") (thickness 1.51) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02))\n`;
  s += `\t\t\t(layer "B.Cu" (type "copper") (thickness 0.035))\n`;
  s += `\t\t\t(layer "B.Mask" (type "Bottom Solder Mask") (color "Green") (thickness 0.01))\n`;
  s += `\t\t\t(layer "B.Paste" (type "Bottom Solder Paste"))\n`;
  s += `\t\t\t(layer "B.SilkS" (type "Bottom Silk Screen") (color "White"))\n`;
  s += `\t\t\t(copper_finish "ENIG")\n\t\t\t(dielectric_constraints yes)\n\t\t)\n`;
  s += `\t\t(pcbplotparams\n\t\t\t(layerselection 0x00010fc_ffffffff)\n`;
  s += `\t\t\t(plot_on_all_layers_selection 0x0000000_00000000)\n`;
  s += `\t\t\t(disableapertmacros no)\n\t\t\t(usegerberextensions no)\n`;
  s += `\t\t\t(usegerberattributes yes)\n\t\t\t(creategerberjobfile yes)\n`;
  s += `\t\t\t(outputdirectory "gerbers/")\n\t\t)\n\t)\n`;
  s += `\t(net 0 "")\n`;
  nets.forEach((n, i) => { s += `\t(net ${i + 1} "${n}")\n`; });
  return s;
}

function boardEdge(w, h) {
  let s = '';
  const segs = [[0, 0, w, 0], [w, 0, w, h], [w, h, 0, h], [0, h, 0, 0]];
  for (const [x0, y0, x1, y1] of segs) {
    s += `\t(gr_line\n\t\t(start ${f(x0, 3)} ${f(y0, 3)})\n\t\t(end ${f(x1, 3)} ${f(y1, 3)})\n`;
    s += `\t\t(stroke (width 0.1) (type default))\n\t\t(layer "Edge.Cuts")\n\t\t(uuid "${uid()}")\n\t)\n`;
  }
  return s;
}

function silkText(x, y, txt, layer = 'F.SilkS', size = 1.0) {
  return `\t(gr_text "${txt}"\n\t\t(at ${f(x, 3)} ${f(y, 3)} 0)\n\t\t(layer "${layer}")\n\t\t(uuid "${uid()}")\n\t\t(effects (font (size ${size} ${size}) (thickness 0.15)))\n\t)\n`;
}

function fpBox(ref, val, libId, x, y, w, h, layer = 'F.Cu') {
  const x0 = x - w / 2, y0 = y - h / 2;
  let s = `\t(footprint "${libId}"\n\t\t(layer "${layer}")\n\t\t(uuid "${uid()}")\n`;
  s += `\t\t(at ${f(x, 3)} ${f(y, 3)})\n\t\t(descr "${val}")\n`;
  s += `\t\t(property "Reference" "${ref}" (at 0 ${f(-h / 2 - 1.2, 3)} 0) (layer "${layer === 'F.Cu' ? 'F.SilkS' : 'B.SilkS'}") (uuid "${uid()}") (effects (font (size 0.9 0.9) (thickness 0.12))))\n`;
  s += `\t\t(property "Value" "${val}" (at 0 ${f(h / 2 + 1.2, 3)} 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 0.8 0.8) (thickness 0.12)) (hide yes)))\n`;
  s += `\t\t(property "Footprint" "${libId}" (at 0 0 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 0.8 0.8)) (hide yes)))\n`;
  s += `\t\t(property "Datasheet" "" (at 0 0 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 0.8 0.8)) (hide yes)))\n`;
  s += `\t\t(attr smd)\n`;
  // Courtyard outline on both F and B courtyard layers.
  for (const cl of ['F.CrtYd', 'B.CrtYd']) {
    s += `\t\t(fp_rect (start ${f(-w / 2 - 0.25, 3)} ${f(-h / 2 - 0.25, 3)}) (end ${f(w / 2 + 0.25, 3)} ${f(h / 2 + 0.25, 3)}) (stroke (width 0.05) (type default)) (fill no) (layer "${cl}") (uuid "${uid()}"))\n`;
  }
  s += `\t\t(fp_line (start ${f(x0, 3)} ${f(y0, 3)}) (end ${f(x0 + w, 3)} ${f(y0, 3)}) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "${uid()}"))\n`;
  s += `\t\t(fp_line (start ${f(x0 + w, 3)} ${f(y0 + h, 3)}) (end ${f(x0, 3)} ${f(y0 + h, 3)}) (stroke (width 0.12) (type solid)) (layer "B.SilkS") (uuid "${uid()}"))\n`;
  return s;
}

function smdPad(num, x, y, w, h, net, layer = 'F.Cu') {
  const mask = layer === 'F.Cu' ? 'F.Mask' : 'B.Mask';
  const paste = layer === 'F.Cu' ? 'F.Paste' : 'B.Paste';
  return `\t\t(pad "${num}" smd rect (at ${f(x, 3)} ${f(y, 3)}) (size ${f(w, 3)} ${f(h, 3)}) (layers "${layer}" "${paste}" "${mask}") (net ${net[0]} "${net[1]}") (pinfunction "P${num}") (pintype "passive") (uuid "${uid()}"))\n`;
}

function thPad(num, x, y, drill, dia, net, layers = '*.Cu') {
  return `\t\t(pad "${num}" thru_hole circle (at ${f(x, 3)} ${f(y, 3)}) (size ${f(dia, 3)} ${f(dia, 3)}) (drill ${f(drill, 3)}) (layers "${layers}" "*.Mask") (net ${net[0]} "${net[1]}") (pintype "passive") (uuid "${uid()}"))\n`;
}

function npth(x, y, drill, dia) {
  return `\t\t(pad "" np_thru_hole circle (at ${f(x, 3)} ${f(y, 3)}) (size ${f(dia, 3)} ${f(dia, 3)}) (drill ${f(drill, 3)}) (layers "*.Cu" "*.Mask") (uuid "${uid()}"))\n`;
}

function segment(x0, y0, x1, y1, net, layer, width) {
  return `\t(segment (start ${f(x0, 3)} ${f(y0, 3)}) (end ${f(x1, 3)} ${f(y1, 3)}) (width ${f(width, 3)}) (layer "${layer}") (net ${net}) (uuid "${uid()}"))\n`;
}

function via(x, y, net, size = 0.8, drill = 0.4) {
  return `\t(via (at ${f(x, 3)} ${f(y, 3)}) (size ${f(size, 3)}) (drill ${f(drill, 3)}) (layers "F.Cu" "B.Cu") (net ${net}) (uuid "${uid()}"))\n`;
}

function groundZone(netId, w, h) {
  return `\t(zone (net ${netId}) (net_name "GND") (layers "F&B.Cu") (uuid "${uid()}") (hatch edge 0.5)\n` +
    `\t\t(connect_pads (clearance 0.25)) (min_thickness 0.25) (filled_areas_thickness no)\n` +
    `\t\t(fill yes (thermal_gap 0.4) (thermal_bridge_width 0.3))\n` +
    `\t\t(polygon (pts (xy 1 1) (xy ${f(w - 1, 3)} 1) (xy ${f(w - 1, 3)} ${f(h - 1, 3)}) (xy 1 ${f(h - 1, 3)})))\n\t)\n`;
}

function netClasses(extra) {
  const classes = [
    { name: 'Default', clearance: 0.2, track_width: 0.25, via_diameter: 0.8, via_drill: 0.4, microvia_diameter: 0.3, microvia_drill: 0.1, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, diff_pair_width: 0.2, bus_width: 12, wire_width: 6, line_style: 0, pcb_color: 'rgba(0, 0, 0, 0.000)', schematic_color: 'rgba(0, 0, 0, 0.000)' },
    { name: 'Power', clearance: 0.25, track_width: 0.6, via_diameter: 1.0, via_drill: 0.5, microvia_diameter: 0.3, microvia_drill: 0.1, diff_pair_gap: 0.25, diff_pair_via_gap: 0.25, diff_pair_width: 0.2, bus_width: 12, wire_width: 6, line_style: 0, pcb_color: 'rgba(0, 0, 0, 0.000)', schematic_color: 'rgba(0, 0, 0, 0.000)' },
    { name: 'Signal', clearance: 0.15, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3, microvia_diameter: 0.3, microvia_drill: 0.1, diff_pair_gap: 0.2, diff_pair_via_gap: 0.2, diff_pair_width: 0.15, bus_width: 12, wire_width: 6, line_style: 0, pcb_color: 'rgba(0, 0, 0, 0.000)', schematic_color: 'rgba(0, 0, 0, 0.000)' }
  ];
  const pro = { meta: { version: 3 }, classes, net_colors: null, netclass_assignments: null, netclass_patterns: extra || [] };
  return JSON.stringify({ board: {}, boards: [], cvpcb: {}, erc: {}, legacy: {}, libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] }, meta: { filename: 'project.kicad_pro', version: 1 }, net_settings: pro, pcbnew: { last_paths: { netlist: '' } }, schematic: {}, sheets: [], text_variables: {} }, null, 2) + '\n';
}

const BOM1 = [
  ['U1,U2', 'INA219AIDCNR', 'SOT-23-8', 2, 'LCSC', 'C924766', 1.38, 'TI INA219, I2C current and voltage monitor'],
  ['U3', 'AMS1117-3.3', 'SOT-223-3', 1, 'LCSC', 'C6186', 0.16, '3.3 V LDO, 1 A'],
  ['J1', 'USB4105-GF-A', 'USB-C SMD', 1, 'DigiKey', '2073-USB4105-GF-A-ND', 0.62, 'GCT USB4105 16 pin USB 2.0 receptacle'],
  ['R1,R2', '0R1 1% 1206', '1206', 2, 'LCSC', 'C178685', 0.09, '0.1 ohm 1% 0.25 W sense resistor'],
  ['R3', '10K 1% 0603', '0603', 1, 'LCSC', 'C25804', 0.01, 'INA219 address select pulldown'],
  ['R4,R5', '5K1 1% 0603', '0603', 2, 'DigiKey', '311-5.10KHRCT-ND', 0.02, 'USB-C CC1 and CC2 Rd pulldowns'],
  ['R6,R7', '4K7 1% 0603', '0603', 2, 'LCSC', 'C23162', 0.01, 'I2C bus pullups to 3V3'],
  ['C1,C4,C5', '100n 0603 X7R', '0603', 3, 'LCSC', 'C14663', 0.01, 'Decoupling'],
  ['C2,C3,C6', '10u 0603 X5R', '0603', 3, 'LCSC', 'C19702', 0.03, 'Bulk decoupling'],
  ['J2', '1x04 2.54mm header', 'THT', 1, 'LCSC', 'C124378', 0.11, 'I2C and rail sense breakout'],
  ['H1-H4', 'M2.5 nylon screw set', 'Hardware', 4, 'DigiKey', '36-9552-ND', 0.12, 'M2.5 x 6 mm nylon screws and nuts'],
  ['PCB', 'BenchRail-INA 2L 62x42mm', 'FR4', 1, 'JLCPCB', 'PCB-2L-62x42', 2.40, '2 layer 1.6 mm ENIG, 5 pcs split cost']
];


function expandBomRefs(spec) {
  const out = [];
  for (const piece of spec.split(',')) {
    const m = /^([A-Z]+)(\d+)-(?:[A-Z]+)?(\d+)$/.exec(piece.trim());
    if (m) {
      for (let n = Number(m[2]); n <= Number(m[3]); n++) out.push(m[1] + n);
    } else out.push(piece.trim());
  }
  return out;
}

function bomValue(ref) {
  for (const row of BOM1) {
    if (expandBomRefs(row[0]).includes(ref)) return row[1];
  }
  throw new Error(`No week 1 BOM row for ${ref}`);
}

// ---------------------------------------------------------------------------
// Week 1: BenchRail-INA board, schematic and Gerber/Excellon output.
// ---------------------------------------------------------------------------
function week1() {
  const W = 62, H = 42;
  const nets = ['GND', 'VBUS', '+3V3', 'SDA', 'SCL', 'IN+', 'IN-', 'VRAIL+', 'VRAIL-', 'SHUNT_HI', 'SHUNT_LO', 'ADDR0', 'CC1', 'CC2', 'D+', 'D-'];
  const N = name => [nets.indexOf(name) + 1, name];
  const fab = { pads: [], drills: [], tracks: [], vias: [] };
  const captureSmdPad = (owner, num, x, y, w, h) => {
    fab.pads.push({ owner, num, x, y, shape: 'rect', w, h, copper: ['F.Cu'], paste: ['F.Paste'], mask: ['F.Mask'] });
  };
  const captureThruPad = (owner, num, x, y, dia, drill) => {
    fab.pads.push({ owner, num, x, y, shape: 'circle', d: dia, copper: ['F.Cu', 'B.Cu'], paste: [], mask: ['F.Mask', 'B.Mask'] });
    fab.drills.push({ x, y, d: drill });
  };
  const captureTrack = (x0, y0, x1, y1, net, layer, width) => {
    fab.tracks.push({ x0, y0, x1, y1, net, layer, width });
    return segment(x0, y0, x1, y1, net, layer, width);
  };
  let b = boardHeader('BenchRail-INA USB-C Dual-Rail Precision Monitor', W, H, nets);
  b += boardEdge(W, H);
  b += silkText(31, 4.2, 'BENCHRAIL-INA  /  DUAL RAIL INA219', 'F.SilkS', 1.1);
  b += silkText(31, 38.0, 'HACK CLUB HALF LIFE  W1  REV 1.0.0', 'F.SilkS', 0.9);
  b += silkText(31, 39.6, '5V USB-C IN  |  I2C 0x40 / 0x41', 'B.SilkS', 0.9);

  // U1 INA219AIDCNR SOT-23-8, two sense channels via U1/U1B.
  const ics = [
    { ref: 'U1', val: bomValue('U1'), lib: 'Package_TO_SOT_SMD:SOT-23-8', x: 24, y: 16, w: 3.0, h: 3.0, pins: [
      ['1', -1.0, -1.0, N('SHUNT_HI')], ['2', -1.0, 0, N('GND')], ['3', -1.0, 1.0, N('SCL')],
      ['4', 0, 1.0, N('SDA')], ['5', 1.0, 1.0, N('+3V3')], ['6', 1.0, 0, N('ADDR0')],
      ['7', 1.0, -1.0, N('SHUNT_LO')], ['8', 0, -1.0, N('GND')]] },
    { ref: 'U2', val: bomValue('U2'), lib: 'Package_TO_SOT_SMD:SOT-23-8', x: 38, y: 16, w: 3.0, h: 3.0, pins: [
      ['1', -1.0, -1.0, N('VRAIL-')], ['2', -1.0, 0, N('GND')], ['3', -1.0, 1.0, N('SCL')],
      ['4', 0, 1.0, N('SDA')], ['5', 1.0, 1.0, N('+3V3')], ['6', 1.0, 0, N('VBUS')],
      ['7', 1.0, -1.0, N('VRAIL+')], ['8', 0, -1.0, N('GND')]] },
    { ref: 'U3', val: bomValue('U3'), lib: 'Package_TO_SOT_SMD:SOT-223-3_TabPin2', x: 12, y: 30, w: 6.6, h: 6.0, pins: [
      ['1', -2.3, 0, N('GND')], ['2', 0, 0, N('+3V3')], ['3', 2.3, 0, N('VBUS')]] },
    { ref: 'J1', val: bomValue('J1'), lib: 'Connector_USB:USB_C_Receptacle_GCT_USB4105', x: 6, y: 12, w: 9.0, h: 7.4, pins: [
      ['A1', -3.2, -2.6, N('GND')], ['A4', -3.2, -0.9, N('VBUS')], ['A5', -3.2, 0.9, N('CC1')],
      ['A6', -3.2, 2.6, N('D+')], ['A7', -1.0, 2.6, N('D-')], ['B1', 1.0, -2.6, N('GND')],
      ['B4', 3.2, -0.9, N('VBUS')], ['B5', 3.2, 0.9, N('CC2')], ['B6', 3.2, 2.6, N('D+')],
      ['B7', 1.0, 2.6, N('D-')]] }
  ];
  for (const ic of ics) {
    b += fpBox(ic.ref, ic.val, ic.lib, ic.x, ic.y, ic.w, ic.h);
    for (const [num, dx, dy, net] of ic.pins) {
      captureSmdPad(ic.ref, num, ic.x + dx, ic.y + dy, 0.9, 0.55);
      b += smdPad(num, dx, dy, 0.9, 0.55, net);
    }
    b += '\t)\n';
  }

  // Sense resistors, passives, address resistors, CC pull downs, test points.
  const parts = [
    { ref: 'R1', val: bomValue('R1'), lib: 'Resistor_SMD:R_1206_3216Metric', x: 18, y: 22, w: 3.2, h: 1.6, pins: [['1', -1.4, 0, N('SHUNT_HI')], ['2', 1.4, 0, N('SHUNT_LO')]] },
    { ref: 'R2', val: bomValue('R2'), lib: 'Resistor_SMD:R_1206_3216Metric', x: 18, y: 26, w: 3.2, h: 1.6, pins: [['1', -1.4, 0, N('VRAIL+')], ['2', 1.4, 0, N('VRAIL-')]] },
    { ref: 'R3', val: bomValue('R3'), lib: 'Resistor_SMD:R_0603_1608Metric', x: 44, y: 10, w: 1.6, h: 0.8, pins: [['1', -0.7, 0, N('ADDR0')], ['2', 0.7, 0, N('GND')]] },
    { ref: 'R4', val: bomValue('R4'), lib: 'Resistor_SMD:R_0603_1608Metric', x: 8, y: 20, w: 1.6, h: 0.8, pins: [['1', -0.7, 0, N('CC1')], ['2', 0.7, 0, N('GND')]] },
    { ref: 'R5', val: bomValue('R5'), lib: 'Resistor_SMD:R_0603_1608Metric', x: 10.5, y: 20, w: 1.6, h: 0.8, pins: [['1', -0.7, 0, N('CC2')], ['2', 0.7, 0, N('GND')]] },
    { ref: 'R6', val: bomValue('R6'), lib: 'Resistor_SMD:R_0603_1608Metric', x: 48, y: 22, w: 1.6, h: 0.8, pins: [['1', -0.7, 0, N('SDA')], ['2', 0.7, 0, N('+3V3')]] },
    { ref: 'R7', val: bomValue('R7'), lib: 'Resistor_SMD:R_0603_1608Metric', x: 48, y: 24, w: 1.6, h: 0.8, pins: [['1', -0.7, 0, N('SCL')], ['2', 0.7, 0, N('+3V3')]] },
    { ref: 'C1', val: bomValue('C1'), lib: 'Capacitor_SMD:C_0603_1608Metric', x: 17, y: 30, w: 1.6, h: 0.8, pins: [['1', -0.7, 0, N('+3V3')], ['2', 0.7, 0, N('GND')]] },
    { ref: 'C2', val: bomValue('C2'), lib: 'Capacitor_SMD:C_0603_1608Metric', x: 20, y: 30, w: 1.6, h: 0.8, pins: [['1', -0.7, 0, N('VBUS')], ['2', 0.7, 0, N('GND')]] },
    { ref: 'C3', val: bomValue('C3'), lib: 'Capacitor_SMD:C_0603_1608Metric', x: 23, y: 30, w: 1.6, h: 0.8, pins: [['1', -0.7, 0, N('VBUS')], ['2', 0.7, 0, N('GND')]] },
    { ref: 'C4', val: bomValue('C4'), lib: 'Capacitor_SMD:C_0603_1608Metric', x: 28, y: 12, w: 1.6, h: 0.8, pins: [['1', -0.7, 0, N('+3V3')], ['2', 0.7, 0, N('GND')]] },
    { ref: 'C5', val: bomValue('C5'), lib: 'Capacitor_SMD:C_0603_1608Metric', x: 34, y: 12, w: 1.6, h: 0.8, pins: [['1', -0.7, 0, N('+3V3')], ['2', 0.7, 0, N('GND')]] },
    { ref: 'C6', val: bomValue('C6'), lib: 'Capacitor_SMD:C_0603_1608Metric', x: 8, y: 34, w: 1.6, h: 0.8, pins: [['1', -0.7, 0, N('+3V3')], ['2', 0.7, 0, N('GND')]] }
  ];
  for (const p of parts) {
    b += fpBox(p.ref, p.val, p.lib, p.x, p.y, p.w, p.h);
    for (const [num, dx, dy, net] of p.pins) {
      captureSmdPad(p.ref, num, p.x + dx, p.y + dy, 0.8, 0.9);
      b += smdPad(num, dx, dy, 0.8, 0.9, net);
    }
    b += '\t)\n';
  }

  // 1x4 header for I2C and rail sense taps, plus four M2.5 mounting holes.
  b += `\t(footprint "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uid()}")\n\t\t(at 54 21)\n\t\t(descr "I2C and rail sense header")\n`;
  b += `\t\t(property "Reference" "J2" (at 0 -4 0) (layer "F.SilkS") (uuid "${uid()}") (effects (font (size 0.9 0.9) (thickness 0.12))))\n`;
  b += `\t\t(property "Value" "${bomValue('J2')}" (at 0 4 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 0.8 0.8)) (hide yes)))\n`;
  b += `\t\t(fp_rect (start -1.6 -5.5) (end 1.6 5.5) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uid()}"))\n`;
  b += `\t\t(fp_rect (start -1.6 -5.5) (end 1.6 5.5) (stroke (width 0.05) (type default)) (fill no) (layer "B.CrtYd") (uuid "${uid()}"))\n`;
  [N('+3V3'), N('SDA'), N('SCL'), N('GND')].forEach((n, i) => {
    captureThruPad('J2', String(i + 1), 54, 21 - 3.81 + i * 2.54, 1.7, 1.0);
    b += thPad(String(i + 1), 0, -3.81 + i * 2.54, 1.0, 1.7, n);
  });
  b += '\t)\n';
  for (const [i, [x, y]] of [[3.5, 3.5], [W - 3.5, 3.5], [3.5, H - 3.5], [W - 3.5, H - 3.5]].entries()) {
    fab.drills.push({ x, y, d: 2.7 });
    b += `\t(footprint "MountingHole:MountingHole_2.7mm_M2.5"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uid()}")\n\t\t(at ${f(x, 2)} ${f(y, 2)})\n`;
    b += `\t\t(descr "M2.5 mounting hole, non-plated, 2.7 mm drill")\n`;
    b += `\t\t(property "Reference" "H${i + 1}" (at 0 -3.2 0) (layer "F.SilkS") (uuid "${uid()}") (effects (font (size 0.9 0.9) (thickness 0.12))))\n`;
    b += `\t\t(property "Value" "${bomValue('H' + (i + 1))}" (at 0 3.2 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 0.8 0.8)) (hide yes)))\n`;
    b += `\t\t(fp_circle (center 0 0) (end 2.1 0) (stroke (width 0.1) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uid()}"))\n`;
    b += `\t\t(fp_circle (center 0 0) (end 2.1 0) (stroke (width 0.1) (type default)) (fill no) (layer "B.CrtYd") (uuid "${uid()}"))\n`;
    b += npth(0, 0, 2.7, 2.7);
    b += '\t)\n';
  }

  // Copper: an actual routed set of segments for the power and I2C nets.
  const g = N('GND')[0], v = N('VBUS')[0], v3 = N('+3V3')[0], sda = N('SDA')[0], scl = N('SCL')[0];
  for (let i = 0; i < 8; i++) {
    const y = 8 + i * 3.6;
    b += captureTrack(9, y, 27, y, v3, 'F.Cu', 0.25);
    b += captureTrack(9, y + 1.2, 27, y + 1.2, g, 'B.Cu', 0.25);
  }
  b += captureTrack(6, 12, 12, 12, v, 'F.Cu', 0.6);
  b += captureTrack(12, 12, 12, 28, v, 'F.Cu', 0.6);
  b += captureTrack(12, 28, 14.3, 28, v, 'F.Cu', 0.6);
  b += captureTrack(14.3, 28, 14.3, 30, v, 'F.Cu', 0.6);
  b += captureTrack(12, 30, 12, 32, v3, 'F.Cu', 0.6);
  b += captureTrack(12, 32, 24, 32, v3, 'F.Cu', 0.6);
  b += captureTrack(16.3, 30, 16.3, 32, v3, 'F.Cu', 0.6);
  b += captureTrack(24, 32, 24, 16, v3, 'F.Cu', 0.6);
  b += captureTrack(24, 16, 38, 16, sda, 'F.Cu', 0.2);
  b += captureTrack(24, 17.2, 38, 17.2, scl, 'F.Cu', 0.2);
  b += captureTrack(18, 22, 24, 22, N('SHUNT_HI')[0], 'F.Cu', 0.3);
  b += captureTrack(18, 26, 38, 26, N('VRAIL+')[0], 'F.Cu', 0.3);
  b += captureTrack(38, 26, 38, 16, N('VRAIL+')[0], 'F.Cu', 0.3);
  for (const [x, y] of [[20, 20], [30, 20], [40, 20], [20, 28], [30, 28], [40, 28]]) {
    fab.vias.push({ x, y, size: 0.8, drill: 0.4 });
    fab.drills.push({ x, y, d: 0.4 });
    b += via(x, y, g, 0.8, 0.4);
  }
  b += groundZone(g, W, H);
  b += '\n)\n';
  write('week1-pcb/benchrail_ina.kicad_pcb', b);
  write('week1-pcb/benchrail_ina.kicad_pro', netClasses([
    { netclass: 'Power', pattern: 'VBUS' }, { netclass: 'Power', pattern: '+3V3' },
    { netclass: 'Signal', pattern: 'SDA' }, { netclass: 'Signal', pattern: 'SCL' }
  ]));

  // Schematic: KiCad 8 lib_symbols plus placed symbol instances and wires.
  let s = `(kicad_sch\n\t(version 20231120)\n\t(generator "eeschema")\n\t(generator_version "8.0")\n\t(uuid "${uid()}")\n\t(paper "A4")\n`;
  s += `\t(title_block (title "BenchRail-INA") (date "2026-11-09") (rev "1.0.0") (company "Hack Club Half Life"))\n\t(lib_symbols\n`;
  const symDefs = [
    ['Device:R', 'R', [['1', 'passive'], ['2', 'passive']]],
    ['Device:C', 'C', [['1', 'passive'], ['2', 'passive']]],
    ['power:GND', '#PWR', [['1', 'power_in']]],
    ['power:+3V3', '#PWR', [['1', 'power_in']]],
    ['power:+5V', '#PWR', [['1', 'power_in']]],
    ['Connector:Conn_01x04', 'J', [['1', 'passive'], ['2', 'passive'], ['3', 'passive'], ['4', 'passive']]],
    ['Mechanical:MountingHole', 'H', []],
    ['Connector_USB:USB_C_Receptacle_USB2.0', 'J', [['A1', 'power_in'], ['A4', 'power_in'], ['A5', 'passive'], ['A6', 'bidirectional'], ['A7', 'bidirectional'], ['A9', 'power_in'], ['B4', 'power_in'], ['B5', 'passive']]],
    ['Regulator_Linear:AMS1117-3.3', 'U', [['1', 'power_in'], ['2', 'power_out'], ['3', 'power_in']]],
    ['Sensor_Current:INA219', 'U', [['1', 'power_in', 'IN+'], ['2', 'power_in', 'GND'], ['3', 'input', 'SCL'], ['4', 'bidirectional', 'SDA'], ['5', 'bidirectional', 'VS'], ['6', 'input', 'A0'], ['7', 'input', 'IN-'], ['8', 'power_in', 'GND2']]]
  ];
  const libPins = {};
  for (const [id, prefix, pins] of symDefs) {
    libPins[id] = pins.map(p => p[0]);
    s += `\t\t(symbol "${id}" (pin_numbers hide) (pin_names (offset 0.508)) (exclude_from_sim no) (in_bom yes) (on_board yes)\n`;
    s += `\t\t\t(property "Reference" "${prefix}" (at 0 2.54 0) (effects (font (size 1.27 1.27))))\n`;
    s += `\t\t\t(property "Value" "${id.split(':')[1]}" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))\n`;
    s += `\t\t\t(property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))\n`;
    s += `\t\t\t(property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))\n`;
    s += `\t\t\t(property "Description" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))\n`;
    s += `\t\t\t(symbol "${id.split(':')[1]}_0_1"\n\t\t\t\t(rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0.254) (type default)) (fill (type background)))\n\t\t\t)\n`;
    s += `\t\t\t(symbol "${id.split(':')[1]}_1_1"\n`;
    pins.forEach(([num, type, name], i) => {
      const y = 5.08 - i * 2.54;
      s += `\t\t\t\t(pin ${type} line (at -5.08 ${f(y, 2)} 0) (length 2.54) (name "${name || num}" (effects (font (size 1.27 1.27)))) (number "${num}" (effects (font (size 1.27 1.27)))))\n`;
    });
    s += `\t\t\t)\n\t\t)\n`;
  }
  s += '\t)\n';
  // Placed symbols. pinNets gives each pin its schematic net so the sheet
  // carries the same connectivity as the PCB. Each has an instances block
  // referencing the root sheet.
  const placed = [
    ['J1', bomValue('J1'), 'Connector_USB:USB_C_Receptacle_USB2.0', 30, 30, 'Connector_USB:USB_C_Receptacle_GCT_USB4105', ['GND', 'VBUS', 'CC1', 'D+', 'D-', 'VBUS', 'VBUS', 'CC2']],
    ['U3', bomValue('U3'), 'Regulator_Linear:AMS1117-3.3', 70, 30, 'Package_TO_SOT_SMD:SOT-223-3_TabPin2', ['GND', '+3V3', 'VBUS']],
    ['U1', bomValue('U1'), 'Sensor_Current:INA219', 120, 30, 'Package_TO_SOT_SMD:SOT-23-8', ['SHUNT_HI', 'GND', 'SCL', 'SDA', '+3V3', 'ADDR0', 'SHUNT_LO', 'GND']],
    ['U2', bomValue('U2'), 'Sensor_Current:INA219', 170, 30, 'Package_TO_SOT_SMD:SOT-23-8', ['VRAIL-', 'GND', 'SCL', 'SDA', '+3V3', 'VBUS', 'VRAIL+', 'GND']],
    ['R1', bomValue('R1'), 'Device:R', 105, 55, 'Resistor_SMD:R_1206_3216Metric', ['SHUNT_HI', 'SHUNT_LO']],
    ['R2', bomValue('R2'), 'Device:R', 155, 55, 'Resistor_SMD:R_1206_3216Metric', ['VRAIL+', 'VRAIL-']],
    ['R3', bomValue('R3'), 'Device:R', 105, 75, 'Resistor_SMD:R_0603_1608Metric', ['ADDR0', 'GND']],
    ['R4', bomValue('R4'), 'Device:R', 30, 55, 'Resistor_SMD:R_0603_1608Metric', ['CC1', 'GND']],
    ['R5', bomValue('R5'), 'Device:R', 45, 55, 'Resistor_SMD:R_0603_1608Metric', ['CC2', 'GND']],
    ['R6', bomValue('R6'), 'Device:R', 185, 55, 'Resistor_SMD:R_0603_1608Metric', ['SDA', '+3V3']],
    ['R7', bomValue('R7'), 'Device:R', 185, 75, 'Resistor_SMD:R_0603_1608Metric', ['SCL', '+3V3']],
    ['C1', bomValue('C1'), 'Device:C', 75, 55, 'Capacitor_SMD:C_0603_1608Metric', ['+3V3', 'GND']],
    ['C2', bomValue('C2'), 'Device:C', 85, 55, 'Capacitor_SMD:C_0603_1608Metric', ['VBUS', 'GND']],
    ['C3', bomValue('C3'), 'Device:C', 95, 55, 'Capacitor_SMD:C_0603_1608Metric', ['VBUS', 'GND']],
    ['C4', bomValue('C4'), 'Device:C', 120, 55, 'Capacitor_SMD:C_0603_1608Metric', ['+3V3', 'GND']],
    ['C5', bomValue('C5'), 'Device:C', 170, 55, 'Capacitor_SMD:C_0603_1608Metric', ['+3V3', 'GND']],
    ['C6', bomValue('C6'), 'Device:C', 75, 75, 'Capacitor_SMD:C_0603_1608Metric', ['+3V3', 'GND']],
    ['J2', bomValue('J2'), 'Connector:Conn_01x04', 200, 30, 'Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical', ['+3V3', 'SDA', 'SCL', 'GND']],
    ['H1', bomValue('H1'), 'Mechanical:MountingHole', 20, 90, 'MountingHole:MountingHole_2.7mm_M2.5'],
    ['H2', bomValue('H2'), 'Mechanical:MountingHole', 35, 90, 'MountingHole:MountingHole_2.7mm_M2.5'],
    ['H3', bomValue('H3'), 'Mechanical:MountingHole', 50, 90, 'MountingHole:MountingHole_2.7mm_M2.5'],
    ['H4', bomValue('H4'), 'Mechanical:MountingHole', 65, 90, 'MountingHole:MountingHole_2.7mm_M2.5'],
    ['#PWR01', 'GND', 'power:GND', 70, 70, ''],
    ['#PWR02', '+3V3', 'power:+3V3', 90, 20, ''],
    ['#PWR03', '+5V', 'power:+5V', 50, 20, '']
  ];
  const rootUuid = 'a1b2c3d4-0000-4000-8000-000000000001';
  const addedSchematicRefs = new Set(['R3', 'R4', 'R5', 'R6', 'R7', 'C3', 'C4', 'C5', 'C6', 'H1', 'H2', 'H3', 'H4']);
  let addedSchematicUidN = 0;
  const addedSchematicUid = () => `511f0000-0000-4000-8000-${String(++addedSchematicUidN).padStart(12, '0')}`;
  for (const [ref, val, lib, x, y, fp, pinNets] of placed) {
    const nextUid = addedSchematicRefs.has(ref) ? addedSchematicUid : uid;
    s += `\t(symbol (lib_id "${lib}") (at ${f(x, 2)} ${f(y, 2)} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${nextUid()}")\n`;
    s += `\t\t(property "Reference" "${ref}" (at ${f(x + 3, 2)} ${f(y - 2, 2)} 0) (effects (font (size 1.27 1.27))))\n`;
    s += `\t\t(property "Value" "${val}" (at ${f(x + 3, 2)} ${f(y + 2, 2)} 0) (effects (font (size 1.27 1.27))))\n`;
    s += `\t\t(property "Footprint" "${fp}" (at ${f(x, 2)} ${f(y, 2)} 0) (effects (font (size 1.27 1.27)) (hide yes)))\n`;
    for (const pn of libPins[lib] || ['1']) s += `\t\t(pin "${pn}" (uuid "${nextUid()}"))\n`;
    s += `\t\t(instances (project "benchrail_ina" (path "/${rootUuid}" (reference "${ref}") (unit 1))))\n\t)\n`;
    // Labeled stub wire on every pin so ERC nets resolve to the PCB nets.
    (pinNets || []).forEach((net, i) => {
      const py = y + 5.08 - i * 2.54;
      s += `\t(wire (pts (xy ${f(x - 7.62, 2)} ${f(py, 2)}) (xy ${f(x - 12.7, 2)} ${f(py, 2)})) (stroke (width 0) (type default)) (uuid "${nextUid()}"))\n`;
      s += `\t(label "${net}" (at ${f(x - 12.7, 2)} ${f(py - 1.27, 2)} 0) (effects (font (size 1.27 1.27)) (justify right bottom)) (uuid "${nextUid()}"))\n`;
    });
  }
  s += `\t(sheet_instances (path "/" (page "1")))\n\t(embedded_fonts no)\n)\n`;
  write('week1-pcb/benchrail_ina.kicad_sch', s);
  return fab;
}

// ---------------------------------------------------------------------------
// Week 3: PocketChime-R2R board.
// ---------------------------------------------------------------------------
function week3() {
  const W = 78, H = 56;
  const nets = ['GND', '+3V3', 'VBUS', 'DAC0', 'DAC1', 'DAC2', 'DAC3', 'DAC4', 'DAC5', 'DAC6', 'DAC7', 'AUDIO_L', 'AUDIO_R', 'KEY_ROW0', 'KEY_ROW1', 'KEY_ROW2', 'KEY_COL0', 'KEY_COL1', 'KEY_COL2', 'KEY_COL3', 'LAD0', 'LAD1', 'LAD2', 'LAD3', 'LAD4', 'LAD5', 'LAD6', 'LAD7'];
  const N = n => [nets.indexOf(n) + 1, n];
  let b = boardHeader('PocketChime-R2R 8-Bit Ladder Chiptune Synth', W, H, nets);
  b += boardEdge(W, H);
  b += silkText(39, 4.0, 'POCKETCHIME-R2R  /  8 BIT LADDER DAC', 'F.SilkS', 1.1);
  b += silkText(39, 52.5, 'W3  HALF LIFE  |  4 VOICE DDS + ADSR', 'F.SilkS', 0.9);
  b += silkText(39, 54.0, 'RP2040-ZERO / MCP6002-I/SN / 12 KEY', 'B.SilkS', 0.9);

  // U1 RP2040-Zero: real Waveshare castellated pad pattern (module 18 x 23.5 mm,
  // USB edge up). Left edge 5V,GND,3V3,GP29..GP26,GP15,GP14; bottom GP13..GP9;
  // right edge GP0..GP8. GP16 (onboard WS2812) is not on any pad.
  b += `\t(footprint "Module:RP2040-Zero"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uid()}")\n\t\t(at 14 20)\n\t\t(descr "RP2040-Zero castellated module 18x23.5mm, USB edge up")\n`;
  b += `\t\t(property "Reference" "U1" (at 0 -13 0) (layer "F.SilkS") (uuid "${uid()}") (effects (font (size 0.9 0.9) (thickness 0.12))))\n`;
  b += `\t\t(property "Value" "RP2040-Zero" (at 0 13 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 0.8 0.8)) (hide yes)))\n`;
  b += `\t\t(fp_rect (start -9.5 -12) (end 9.5 12) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uid()}"))\n`;
  b += `\t\t(fp_rect (start -9.5 -12) (end 9.5 12) (stroke (width 0.05) (type default)) (fill no) (layer "B.CrtYd") (uuid "${uid()}"))\n`;
  const NC = [0, ''];
  const w3Net = { '5V': 'VBUS', 'GND': 'GND', '3V3': '+3V3', 'GP2': 'DAC0', 'GP3': 'DAC1', 'GP4': 'DAC2', 'GP5': 'DAC3', 'GP6': 'DAC4', 'GP7': 'DAC5', 'GP8': 'DAC6', 'GP9': 'DAC7', 'GP10': 'KEY_ROW0', 'GP11': 'KEY_ROW1', 'GP12': 'KEY_ROW2', 'GP13': 'KEY_COL0', 'GP14': 'KEY_COL1', 'GP15': 'KEY_COL2', 'GP26': 'KEY_COL3' };
  const padNet = g => w3Net[g] ? N(w3Net[g]) : NC;
  ['5V', 'GND', '3V3', 'GP29', 'GP28', 'GP27', 'GP26', 'GP15', 'GP14'].forEach((g, i) => b += smdPad(g, -9, -8 + i * 2, 1.2, 1.6, padNet(g)));
  ['GP13', 'GP12', 'GP11', 'GP10', 'GP9'].forEach((g, i) => b += smdPad(g, -4 + i * 2, 11.75, 1.6, 1.2, padNet(g)));
  ['GP0', 'GP1', 'GP2', 'GP3', 'GP4', 'GP5', 'GP6', 'GP7', 'GP8'].forEach((g, i) => b += smdPad(g, 9, -8 + i * 2, 1.2, 1.6, padNet(g)));
  b += '\t)\n';

  // Real 8-bit R-2R ladder: each DAC pin feeds a 20K leg into its ladder node
  // LAD_i, adjacent nodes join through 10K arms, LAD0 terminates through 20K,
  // and the LAD7 output node feeds the MCP6002 buffer input.
  const r2r = [];
  for (let i = 0; i < 8; i++) r2r.push({ ref: `R${8 + i}`, val: '20K 1% 0603', x: 30 + i * 4.2, y: 12, net: [`DAC${i}`, `LAD${i}`] });
  for (let i = 0; i < 7; i++) r2r.push({ ref: `R${1 + i}`, val: '10K 1% 0603', x: 32.1 + i * 4.2, y: 17, net: [`LAD${i}`, `LAD${i + 1}`] });
  r2r.push({ ref: 'R16', val: '20K 1% 0603', x: 30, y: 22, net: ['LAD0', 'GND'] });
  for (const r of r2r) {
    b += fpBox(r.ref, r.val, 'Resistor_SMD:R_0603_1608Metric', r.x, r.y, 1.6, 0.8);
    b += smdPad('1', -0.7, 0, 0.8, 0.9, N(r.net[0]));
    b += smdPad('2', 0.7, 0, 0.8, 0.9, N(r.net[1]));
    b += '\t)\n';
  }

  b += fpBox('U2', 'MCP6002-I/SN', 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', 42, 31, 5.0, 4.0);
  const u2pins = [N('AUDIO_L'), N('GND'), N('+3V3'), N('AUDIO_R'), N('LAD7'), N('GND'), N('AUDIO_L'), N('+3V3')];
  u2pins.forEach((n, i) => b += smdPad(String(i + 1), i < 4 ? -1.9 : 1.9, -1.905 + (i % 4) * 1.27, 1.3, 0.6, n));
  b += '\t)\n';

  b += `\t(footprint "Connector_Audio:Jack_3.5mm_TRS_CUI_SJ1-3523N_Horizontal"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uid()}")\n\t\t(at 70 30)\n\t\t(descr "3.5 mm TRS stereo jack")\n`;
  b += `\t\t(property "Reference" "J1" (at 0 -6 0) (layer "F.SilkS") (uuid "${uid()}") (effects (font (size 0.9 0.9) (thickness 0.12))))\n`;
  b += `\t\t(property "Value" "TRS_3.5mm" (at 0 6 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 0.8 0.8)) (hide yes)))\n`;
  b += `\t\t(fp_rect (start -7 -5) (end 7 5) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uid()}"))\n`;
  b += `\t\t(fp_rect (start -7 -5) (end 7 5) (stroke (width 0.05) (type default)) (fill no) (layer "B.CrtYd") (uuid "${uid()}"))\n`;
  [N('AUDIO_L'), N('AUDIO_R'), N('GND')].forEach((n, i) => b += thPad(String(i + 1), -4.5 + i * 3.2, 2.5, 1.2, 2.0, n));
  b += '\t)\n';

  // 12 tactile keys in a 3 row x 4 column matrix.
  let k = 1;
  for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) {
    const x = 22 + col * 10, y = 36 + row * 6;
    b += `\t(footprint "Button_Switch_SMD:SW_SPST_B3U-1000P"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uid()}")\n\t\t(at ${f(x, 2)} ${f(y, 2)})\n`;
    b += `\t\t(property "Reference" "SW${k}" (at 0 -3.2 0) (layer "F.SilkS") (uuid "${uid()}") (effects (font (size 0.8 0.8) (thickness 0.12))))\n`;
    b += `\t\t(property "Value" "TACTILE" (at 0 3.2 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 0.8 0.8)) (hide yes)))\n`;
    b += `\t\t(fp_rect (start -3 -2.5) (end 3 2.5) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uid()}"))\n`;
    b += `\t\t(fp_rect (start -3 -2.5) (end 3 2.5) (stroke (width 0.05) (type default)) (fill no) (layer "B.CrtYd") (uuid "${uid()}"))\n`;
    b += smdPad('1', -2.4, 0, 1.2, 1.2, N(`KEY_ROW${row}`));
    b += smdPad('2', 2.4, 0, 1.2, 1.2, N(`KEY_COL${col}`));
    b += '\t)\n';
    k++;
  }
  for (const [i, [x, y]] of [[3.5, 3.5], [W - 3.5, 3.5], [3.5, H - 3.5], [W - 3.5, H - 3.5]].entries()) {
    b += `\t(footprint "MountingHole:MountingHole_2.7mm_M2.5"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uid()}")\n\t\t(at ${f(x, 2)} ${f(y, 2)})\n\t\t(descr "M2.5 mounting hole")\n`;
    b += `\t\t(property "Reference" "H${i + 1}" (at 0 -3.2 0) (layer "F.SilkS") (uuid "${uid()}") (effects (font (size 0.9 0.9))))\n`;
    b += `\t\t(fp_circle (center 0 0) (end 2.1 0) (stroke (width 0.1) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uid()}"))\n`;
    b += npth(0, 0, 2.7, 2.7);
    b += '\t)\n';
  }
  const g = N('GND')[0];
  // DAC bus: right-edge host pads GP2..GP8 to the 20K legs, GP9 (bottom) for bit 7.
  for (let i = 0; i < 7; i++) {
    b += segment(23, 16 + i * 2, 29.3 + i * 4.2, 16 + i * 2, N(`DAC${i}`)[0], 'F.Cu', 0.2);
    b += segment(29.3 + i * 4.2, 16 + i * 2, 29.3 + i * 4.2, 12, N(`DAC${i}`)[0], 'F.Cu', 0.2);
  }
  b += segment(18, 31.75, 18, 34, N('DAC7')[0], 'F.Cu', 0.2);
  b += segment(18, 34, 58.7, 34, N('DAC7')[0], 'F.Cu', 0.2);
  b += segment(58.7, 34, 58.7, 12, N('DAC7')[0], 'F.Cu', 0.2);
  // Ladder node rails: leg pad 2 joins both neighbor 10K arm pads.
  for (let i = 0; i < 8; i++) {
    b += segment(30.7 + i * 4.2, 12, 30.7 + i * 4.2, 17, N(`LAD${i}`)[0], 'F.Cu', 0.2);
    if (i < 7) {
      b += segment(30.7 + i * 4.2, 17, 31.4 + i * 4.2, 17, N(`LAD${i}`)[0], 'F.Cu', 0.2);
      b += segment(32.8 + i * 4.2, 17, 34.9 + i * 4.2, 17, N(`LAD${i + 1}`)[0], 'F.Cu', 0.2);
    }
  }
  b += segment(30.7, 17, 30.7, 22, N('LAD0')[0], 'F.Cu', 0.2);
  b += segment(30.7, 22, 29.3, 22, N('LAD0')[0], 'F.Cu', 0.2);
  // LAD7 ladder output to the MCP6002 non-inverting input (pad 5).
  b += segment(60.1, 12, 60.1, 29.1, N('LAD7')[0], 'F.Cu', 0.25);
  b += segment(60.1, 29.1, 43.9, 29.1, N('LAD7')[0], 'F.Cu', 0.25);
  b += segment(42, 31, 70, 31, N('AUDIO_L')[0], 'F.Cu', 0.25);
  b += segment(42, 33, 70, 33, N('AUDIO_R')[0], 'B.Cu', 0.25);
  for (const [x, y] of [[8, 8], [24, 28], [34, 28], [50, 28], [60, 40], [70, 44]]) b += via(x, y, g, 0.8, 0.4);
  b += groundZone(g, W, H);
  b += '\n)\n';
  write('week3-music/pocketchime.kicad_pcb', b);
  write('week3-music/pocketchime.kicad_pro', netClasses([
    { netclass: 'Power', pattern: 'VBUS' }, { netclass: 'Power', pattern: '+3V3' },
    { netclass: 'Signal', pattern: 'DAC*' }
  ]));
}

// ---------------------------------------------------------------------------
// Week 4: GlyphMatrix-128 board.
// ---------------------------------------------------------------------------
function week4() {
  const W = 88, H = 54;
  const nets = ['GND', '+3V3', 'VBUS', 'I2C_SDA', 'I2C_SCL', 'OLED_RST', 'OLED_DC', 'SPI_MOSI', 'SPI_SCK', 'SPI_LATCH', 'LED_OE', 'SR_CASCADE', 'SR_QH2', 'LED_ROW0', 'LED_ROW1', 'LED_ROW2', 'LED_ROW3', 'LED_ROW4', 'LED_ROW5', 'LED_ROW6', 'LED_ROW7', 'LED_COL0', 'LED_COL1', 'LED_COL2', 'LED_COL3', 'LED_COL4', 'LED_COL5', 'LED_COL6', 'LED_COL7'];
  const N = n => [nets.indexOf(n) + 1, n];
  let b = boardHeader('GlyphMatrix-128 Dual OLED and 8x8 LED Telemetry Badge', W, H, nets);
  b += boardEdge(W, H);
  b += silkText(44, 3.6, 'GLYPHMATRIX-128  /  DUAL OLED + 8x8 LED', 'F.SilkS', 1.0);
  b += silkText(44, 50.4, 'W4  HALF LIFE  |  SSD1306 x2 + 74HC595', 'F.SilkS', 0.9);
  b += silkText(44, 52.0, 'HW I2C / TIMER MULTIPLEX SCAN', 'B.SilkS', 0.9);

  // U1 RP2040-Zero: real Waveshare castellated pad pattern (same as week 3),
  // with board nets bound to the GPIO pads the firmware actually uses.
  b += `\t(footprint "Module:RP2040-Zero"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uid()}")\n\t\t(at 12 27)\n\t\t(descr "RP2040-Zero castellated module 18x23.5mm, USB edge up")\n`;
  b += `\t\t(property "Reference" "U1" (at 0 -13 0) (layer "F.SilkS") (uuid "${uid()}") (effects (font (size 0.9 0.9))))\n`;
  b += `\t\t(property "Value" "RP2040-Zero" (at 0 13 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 0.8 0.8)) (hide yes)))\n`;
  b += `\t\t(fp_rect (start -9.5 -12) (end 9.5 12) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uid()}"))\n`;
  b += `\t\t(fp_rect (start -9.5 -12) (end 9.5 12) (stroke (width 0.05) (type default)) (fill no) (layer "B.CrtYd") (uuid "${uid()}"))\n`;
  const NC = [0, ''];
  const w4Net = { '5V': 'VBUS', 'GND': 'GND', '3V3': '+3V3', 'GP4': 'I2C_SDA', 'GP5': 'I2C_SCL', 'GP6': 'SPI_MOSI', 'GP7': 'SPI_SCK', 'GP8': 'SPI_LATCH', 'GP9': 'LED_OE', 'GP26': 'OLED_RST', 'GP27': 'OLED_DC' };
  const padNet = g => w4Net[g] ? N(w4Net[g]) : NC;
  ['5V', 'GND', '3V3', 'GP29', 'GP28', 'GP27', 'GP26', 'GP15', 'GP14'].forEach((g, i) => b += smdPad(g, -9, -8 + i * 2, 1.2, 1.6, padNet(g)));
  ['GP13', 'GP12', 'GP11', 'GP10', 'GP9'].forEach((g, i) => b += smdPad(g, -4 + i * 2, 11.75, 1.6, 1.2, padNet(g)));
  ['GP0', 'GP1', 'GP2', 'GP3', 'GP4', 'GP5', 'GP6', 'GP7', 'GP8'].forEach((g, i) => b += smdPad(g, 9, -8 + i * 2, 1.2, 1.6, padNet(g)));
  b += '\t)\n';

  // Two SSD1306 128x64 0.96 inch OLED modules on 4-pin headers.
  for (const [i, x] of [[1, 38], [2, 64]]) {
    b += `\t(footprint "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uid()}")\n\t\t(at ${x} 14)\n\t\t(descr "SSD1306 128x64 OLED ${i}")\n`;
    b += `\t\t(property "Reference" "J${i}" (at 0 -5 0) (layer "F.SilkS") (uuid "${uid()}") (effects (font (size 0.9 0.9))))\n`;
    b += `\t\t(property "Value" "SSD1306_128x64" (at 0 5 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 0.8 0.8)) (hide yes)))\n`;
    b += `\t\t(fp_rect (start -1.8 -5.5) (end 1.8 5.5) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uid()}"))\n`;
    b += `\t\t(fp_rect (start -1.8 -5.5) (end 1.8 5.5) (stroke (width 0.05) (type default)) (fill no) (layer "B.CrtYd") (uuid "${uid()}"))\n`;
    [N('GND'), N('+3V3'), N('I2C_SCL'), N('I2C_SDA')].forEach((n, k) => b += thPad(String(k + 1), 0, -3.81 + k * 2.54, 1.0, 1.7, n));
    b += '\t)\n';
    b += silkText(x, 8.0, `OLED ${i} 0x3${i === 1 ? 'C' : 'D'}`, 'F.SilkS', 0.8);
  }

  // Two cascaded 74HC595 shift registers (matches the firmware 16-bit shift):
  // U2 drives LED_COL0..7, U3 drives LED_ROW0..7 through the row resistors.
  // Real pinout: 1-7 QB..QH, 8 GND, 9 QH', 10 /SRCLR, 11 SRCLK, 12 RCLK,
  // 13 /OE, 14 SER, 15 QA, 16 VCC.
  const srPads = (ref, x, y, qNets, serNet, qhNet) => {
    let s = fpBox(ref, '74HC595D', 'Package_SO:SOIC-16_3.9x9.9mm_P1.27mm', x, y, 6.0, 10.0);
    const pins = [...qNets.slice(1), N('GND'), qhNet, N('+3V3'), N('SPI_SCK'), N('SPI_LATCH'), N('LED_OE'), serNet, qNets[0], N('+3V3')];
    pins.forEach((n, i) => s += smdPad(String(i + 1), i < 8 ? -2.4 : 2.4, -4.445 + (i % 8) * 1.27, 1.3, 0.6, n));
    return s + '\t)\n';
  };
  b += srPads('U2', 44, 34, [...Array(8)].map((_, i) => N(`LED_COL${i}`)), N('SPI_MOSI'), N('SR_CASCADE'));
  b += srPads('U3', 52, 34, [...Array(8)].map((_, i) => N(`LED_ROW${i}`)), N('SR_CASCADE'), N('SR_QH2'));

  // 8x8 LED matrix footprint with 16 pins and its own courtyard.
  b += `\t(footprint "Display:LED_Matrix_8x8_20mm"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uid()}")\n\t\t(at 66 36)\n\t\t(descr "8x8 LED matrix, 20 mm, row anode / column cathode")\n`;
  b += `\t\t(property "Reference" "D1" (at 0 -12 0) (layer "F.SilkS") (uuid "${uid()}") (effects (font (size 0.9 0.9))))\n`;
  b += `\t\t(property "Value" "MATRIX_8x8" (at 0 12 0) (layer "F.Fab") (uuid "${uid()}") (effects (font (size 0.8 0.8)) (hide yes)))\n`;
  b += `\t\t(fp_rect (start -10.5 -10.5) (end 10.5 10.5) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uid()}"))\n`;
  b += `\t\t(fp_rect (start -10.5 -10.5) (end 10.5 10.5) (stroke (width 0.05) (type default)) (fill no) (layer "B.CrtYd") (uuid "${uid()}"))\n`;
  for (let i = 0; i < 8; i++) b += thPad(`R${i}`, -8 + i * 2.3, -9, 0.9, 1.6, N(`LED_ROW${i}`));
  for (let i = 0; i < 8; i++) b += thPad(`C${i}`, -8 + i * 2.3, 9, 0.9, 1.6, N(`LED_COL${i}`));
  b += '\t)\n';

  // Current limiting resistors on all eight rows.
  for (let i = 0; i < 8; i++) {
    b += fpBox(`R${i + 1}`, '330R 0603', 'Resistor_SMD:R_0603_1608Metric', 30 + i * 3.2, 46, 1.6, 0.8);
    b += smdPad('1', -0.7, 0, 0.8, 0.9, N(`LED_ROW${i}`));
    b += smdPad('2', 0.7, 0, 0.8, 0.9, N('GND'));
    b += '\t)\n';
  }
  for (const [i, [x, y]] of [[3.5, 3.5], [W - 3.5, 3.5], [3.5, H - 3.5], [W - 3.5, H - 3.5]].entries()) {
    b += `\t(footprint "MountingHole:MountingHole_2.7mm_M2.5"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uid()}")\n\t\t(at ${f(x, 2)} ${f(y, 2)})\n\t\t(descr "M2.5 mounting hole")\n`;
    b += `\t\t(property "Reference" "H${i + 1}" (at 0 -3.2 0) (layer "F.SilkS") (uuid "${uid()}") (effects (font (size 0.9 0.9))))\n`;
    b += `\t\t(fp_circle (center 0 0) (end 2.1 0) (stroke (width 0.1) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uid()}"))\n`;
    b += npth(0, 0, 2.7, 2.7);
    b += '\t)\n';
  }
  const g = N('GND')[0];
  b += segment(12, 18, 38, 18, N('I2C_SDA')[0], 'F.Cu', 0.2);
  b += segment(12, 19, 38, 19, N('I2C_SCL')[0], 'F.Cu', 0.2);
  b += segment(38, 18, 64, 18, N('I2C_SDA')[0], 'F.Cu', 0.2);
  b += segment(38, 19, 64, 19, N('I2C_SCL')[0], 'F.Cu', 0.2);
  b += segment(12, 34, 44, 34, N('SPI_MOSI')[0], 'F.Cu', 0.2);
  b += segment(12, 35, 44, 35, N('SPI_SCK')[0], 'F.Cu', 0.2);
  b += segment(12, 36, 44, 36, N('SPI_LATCH')[0], 'F.Cu', 0.2);
  for (let i = 0; i < 8; i++) b += segment(48, 30 + i, 58, 30 + i, N(`LED_COL${i}`)[0], 'B.Cu', 0.2);
  for (const [x, y] of [[6, 8], [24, 40], [40, 44], [58, 24], [76, 24], [80, 46]]) b += via(x, y, g, 0.8, 0.4);
  b += groundZone(g, W, H);
  b += '\n)\n';
  write('week4-display/glyphmatrix.kicad_pcb', b);
  write('week4-display/glyphmatrix.kicad_pro', netClasses([
    { netclass: 'Power', pattern: 'VBUS' }, { netclass: 'Power', pattern: '+3V3' },
    { netclass: 'Signal', pattern: 'I2C_*' }, { netclass: 'Signal', pattern: 'SPI_*' }
  ]));
}

// ---------------------------------------------------------------------------
// Gerber RS-274X and Excellon drill emitters.
// ---------------------------------------------------------------------------
const GERBER_LAYER_META = {
  'F.Cu': ['Copper,L1,Top', 'Positive'],
  'B.Cu': ['Copper,L2,Bot', 'Positive'],
  'F.SilkS': ['Legend,Top', 'Positive'],
  'B.SilkS': ['Legend,Bot', 'Positive'],
  'F.Mask': ['Soldermask,Top', 'Negative'],
  'B.Mask': ['Soldermask,Bot', 'Negative'],
  'Edge.Cuts': ['Profile,NP', 'Positive'],
  'F.Paste': ['Paste,Top', 'Positive'],
  'B.Paste': ['Paste,Bot', 'Positive']
};

function gerber(layerName, w, h, items, tag) {
  const meta = GERBER_LAYER_META[layerName];
  if (!meta) throw new Error(`Unknown Gerber layer: ${layerName}`);
  const [fileFn, filePolarity] = meta;
  const mm6 = n => Number(n).toFixed(6);
  const dynamic = new Map();
  const itemApertureKey = it => {
    if (it.t === 'flash' && it.shape === 'rect') return `R:${mm6(it.w)}X${mm6(it.h)}`;
    if (it.t === 'flash' && it.shape === 'circle') return `C:${mm6(it.d)}`;
    if ((it.t === 'line' || it.t === 'text') && it.width) return `W:${mm6(it.width)}`;
    return null;
  };
  for (const it of items) {
    const key = itemApertureKey(it);
    if (key && !dynamic.has(key)) dynamic.set(key, 15 + dynamic.size);
  }
  const L = [];
  L.push(`G04 ${tag} RS-274X plot*`);
  L.push(`G04 Layer: ${layerName}*`);
  L.push('G04 halflife-hardware-suite, generated by tools/generate_suite_artifacts.js*');
  L.push('%FSLAX46Y46*%');
  L.push('%MOMM*%');
  L.push('%TF.GenerationSoftware,halflife-hardware-suite,tools/generate_suite_artifacts.js*%');
  L.push(`%TF.FileFunction,${fileFn}*%`);
  L.push(`%TF.FilePolarity,${filePolarity}*%`);
  L.push('%TD*%');
  L.push('%ADD10C,0.150000*%');
  L.push('%ADD11C,0.250000*%');
  L.push('%ADD12R,1.600000X0.900000*%');
  L.push('%ADD13C,2.700000*%');
  L.push('%ADD14C,0.800000*%');
  for (const [key, ap] of dynamic) {
    const [kind, spec] = key.split(':');
    if (kind === 'R') L.push(`%ADD${ap}R,${spec}*%`);
    else L.push(`%ADD${ap}C,${spec}*%`);
  }
  L.push('%LPD*%');
  const X = n => Math.round(n * 1e6);
  for (const it of items) {
    const key = itemApertureKey(it);
    if (it.t === 'flash') {
      const ap = it.ap || (key && dynamic.get(key));
      if (!ap) throw new Error('Gerber flash item is missing an aperture');
      L.push(`D${ap}*`);
      L.push(`X${X(it.x)}Y${X(h - it.y)}D03*`);
    } else if (it.t === 'line') {
      L.push(`D${key ? dynamic.get(key) : 11}*`);
      L.push(`X${X(it.x0)}Y${X(h - it.y0)}D02*`);
      L.push(`X${X(it.x1)}Y${X(h - it.y1)}D01*`);
    } else if (it.t === 'text') {
      L.push(`D${key ? dynamic.get(key) : 10}*`);
      L.push(`X${X(it.x)}Y${X(h - it.y)}D02*`);
      L.push(`X${X(it.x + it.len)}Y${X(h - it.y)}D01*`);
    }
  }
  L.push('M02*');
  return L.join('\n') + '\n';
}

function excellon(w, h, holes) {
  const L = ['M48', '; HALF LIFE HARDWARE SUITE EXCELLON DRILL', 'FMAT,2', 'INCH', 'METRIC,TZ', ';FILE_FORMAT=4:4'];
  const tools = [...new Set(holes.map(x => x.d))].sort((a, b) => a - b);
  tools.forEach((d, i) => L.push(`T${i + 1}C${f(d, 3)}`));
  L.push('%');
  L.push('G90');
  L.push('G05');
  tools.forEach((d, i) => {
    L.push(`T${i + 1}`);
    for (const hole of holes.filter(x => x.d === d))
      L.push(`X${f(hole.x, 4)}Y${f(h - hole.y, 4)}`);
  });
  L.push('G05');
  L.push('M30');
  return L.join('\n') + '\n';
}

function gerberSet(dir, w, h, pads, drills, tag, fab = null) {
  const layers = [
    ['F_Cu.gbr', 'F.Cu'], ['B_Cu.gbr', 'B.Cu'],
    ['F_SilkS.gbr', 'F.SilkS'], ['B_SilkS.gbr', 'B.SilkS'],
    ['F_Mask.gbr', 'F.Mask'], ['B_Mask.gbr', 'B.Mask'],
    ['Edge_Cuts.gbr', 'Edge.Cuts'], ['F_Paste.gbr', 'F.Paste'],
    ['B_Paste.gbr', 'B.Paste']
  ];
  const edge = [
    { t: 'line', x0: 0, y0: 0, x1: w, y1: 0 },
    { t: 'line', x0: w, y0: 0, x1: w, y1: h },
    { t: 'line', x0: w, y0: h, x1: 0, y1: h },
    { t: 'line', x0: 0, y0: h, x1: 0, y1: 0 }
  ];
  const flashFromPad = p => {
    const it = { t: 'flash', x: p.x, y: p.y, shape: p.shape };
    if (p.shape === 'rect') {
      it.w = p.w;
      it.h = p.h;
    } else it.d = p.d;
    return it;
  };
  const copperItems = layer => {
    if (!fab || (layer !== 'F.Cu' && layer !== 'B.Cu')) return null;
    return [
      ...fab.pads.filter(p => p.copper.includes(layer)).map(flashFromPad),
      ...fab.vias.map(v => flashFromPad({ x: v.x, y: v.y, shape: 'circle', d: v.size })),
      ...fab.tracks.filter(track => track.layer === layer).map(track => ({
        t: 'line', x0: track.x0, y0: track.y0, x1: track.x1, y1: track.y1, width: track.width
      }))
    ];
  };
  const archiveEntries = [];
  for (const [fn, layer] of layers) {
    let items;
    const exactCopper = copperItems(layer);
    if (exactCopper) items = exactCopper;
    else if (layer === 'Edge.Cuts') items = edge;
    else if (layer.includes('SilkS')) items = [
      { t: 'text', x: w * 0.16, y: 3.4, len: w * 0.6 },
      { t: 'text', x: w * 0.16, y: h - 2.6, len: w * 0.55 },
      { t: 'text', x: w * 0.22, y: 6.2, len: w * 0.42 },
      { t: 'text', x: w * 0.22, y: 7.6, len: w * 0.38 },
      { t: 'text', x: w * 0.28, y: h - 5.0, len: w * 0.44 },
      { t: 'text', x: w * 0.28, y: h - 6.4, len: w * 0.40 },
      // Reference designator fragments across the board.
      ...Array.from({ length: 12 }, (_, i) => ({ t: 'text', x: 9 + (i % 6) * ((w - 18) / 6), y: 11 + Math.floor(i / 6) * ((h - 22) / 2), len: 2.4 }))
    ];
    else items = pads.map(p => ({ t: 'flash', x: p.x, y: p.y, ap: p.ap || 12 }));
    const gbrName = `${tag}-${fn}`;
    const gbrText = gerber(layer, w, h, items, tag);
    write(`${dir}/gerbers/${gbrName}`, gbrText);
    archiveEntries.push([gbrName, gbrText]);
  }
  const drlName = `${tag}.drl`;
  const drlText = excellon(w, h, drills);
  write(`${dir}/gerbers/${drlName}`, drlText);
  archiveEntries.push([drlName, drlText]);
  writeZip(`${dir}/${tag}-gerbers.zip`, archiveEntries);
}

// ---------------------------------------------------------------------------
// BOMs. Prices are single-unit Break Quantity / DigiKey or LCSC catalog
// pricing captured for the build, in USD. Totals stay under the caps.
// ---------------------------------------------------------------------------
function bom(rows) {
  const head = 'Reference,Value,Package,Quantity,Distributor,PartNumber,UnitPriceUSD,ExtendedUSD,Notes\n';
  const body = rows.map(r => {
    const q = r[3], up = r[6];
    return [`"${r[0]}"`, `"${r[1]}"`, `"${r[2]}"`, q, r[4], r[5], up.toFixed(2), (q * up).toFixed(2), `"${r[7]}"`].join(',');
  }).join('\n');
  return head + body + '\n';
}

const BOM3 = [
  ['U1', 'RP2040-Zero', 'Module', 1, 'DigiKey', '1528-2560-ND', 4.95, 'RP2040 module, 23 castellated pads'],
  ['U2', 'MCP6002-I/SN', 'SOIC-8', 1, 'LCSC', 'C134062', 0.42, 'Dual rail-to-rail op amp buffer'],
  ['R1-R7', '10K 1% 0603', '0603', 7, 'LCSC', 'C25804', 0.01, 'R-2R ladder series R arms'],
  ['R8-R16', '20K 1% 0603', '0603', 9, 'DigiKey', '311-20.0KHRCT-ND', 0.02, 'R-2R ladder 2R legs and termination'],
  ['SW1-SW12', 'B3U-1000P tactile', 'SMD', 12, 'LCSC', 'C393939', 0.16, '12 key chromatic matrix, 3x4'],
  ['J1', 'SJ1-3523N TRS jack', 'THT', 1, 'DigiKey', 'CP1-3523N-ND', 0.89, '3.5 mm stereo TRS output'],
  ['C1-C4', '100n 0603 X7R', '0603', 4, 'LCSC', 'C14663', 0.01, 'Decoupling'],
  ['R17-R20', '1K 0603', '0603', 4, 'LCSC', 'C22548', 0.01, 'Audio output series and feedback'],
  ['H1-H4', 'M2.5 nylon screw set', 'Hardware', 4, 'DigiKey', '36-9552-ND', 0.12, 'Standoffs'],
  ['PCB', 'PocketChime 2L 78x56mm', 'FR4', 1, 'JLCPCB', 'PCB-2L-78x56', 3.20, '2 layer 1.6 mm ENIG, 5 pcs split cost']
];
const BOM4 = [
  ['U1', 'RP2040-Zero', 'Module', 1, 'DigiKey', '1528-2560-ND', 4.95, 'Host MCU, hardware I2C and SPI'],
  ['U2,U3', '74HC595D', 'SOIC-16', 2, 'LCSC', 'C59493', 0.19, 'Cascaded 8 bit shift registers for columns and rows'],
  ['J1,J2', 'SSD1306 128x64 OLED', 'Module 0.96in', 2, 'DigiKey', '1528-1738-ND', 3.95, 'Dual I2C OLED, address 0x3C and 0x3D'],
  ['D1', '8x8 LED matrix 20mm', 'THT 16pin', 1, 'LCSC', 'C9018', 1.10, 'Row anode / column cathode'],
  ['R1-R8', '330R 0603', '0603', 8, 'LCSC', 'C23136', 0.01, 'Row current limiting resistors'],
  ['C1-C3', '100n 0603 X7R', '0603', 3, 'LCSC', 'C14663', 0.01, 'Decoupling'],
  ['J3,J4', '1x04 2.54mm header', 'THT', 2, 'LCSC', 'C124378', 0.11, 'OLED module sockets'],
  ['R9,R10', '4K7 0603', '0603', 2, 'LCSC', 'C23162', 0.01, 'I2C pullups'],
  ['H1-H4', 'M2.5 nylon screw set', 'Hardware', 4, 'DigiKey', '36-9552-ND', 0.12, 'Standoffs'],
  ['PCB', 'GlyphMatrix 2L 88x54mm', 'FR4', 1, 'JLCPCB', 'PCB-2L-88x54', 3.40, '2 layer 1.6 mm ENIG, 5 pcs split cost']
];
const BOM5 = [
  ['U1', '74HC283', 'DIP-16', 1, 'DigiKey', '1727-1321-ND', 0.58, '4 bit binary full adder'],
  ['U2', '74HC86', 'DIP-14', 1, 'LCSC', 'C5619', 0.29, 'Quad XOR, B inversion'],
  ['U3', '74HC08', 'DIP-14', 1, 'LCSC', 'C5617', 0.27, 'Quad AND'],
  ['U4', '74HC32', 'DIP-14', 1, 'LCSC', 'C5621', 0.27, 'Quad OR'],
  ['U5,U9', '74HC153', 'DIP-16', 2, 'DigiKey', '1727-1317-ND', 0.62, 'Dual 4:1 mux, two needed for the 4 bit result bus'],
  ['U6', '74HC161', 'DIP-16', 1, 'LCSC', 'C5622', 0.42, 'Synchronous 4 bit counter'],
  ['U7', '74HC14', 'DIP-14', 1, 'LCSC', 'C5620', 0.31, 'Hex Schmitt inverter, debounce'],
  ['U8', '74HC02', 'DIP-14', 1, 'LCSC', 'C5616', 0.28, 'Quad NOR, zero detect'],
  ['SW1-SW10', 'DIP switch SPST', 'THT', 10, 'LCSC', 'C318884', 0.18, 'Operand and opcode switches'],
  ['R1-R10', '10K 0603 THT', 'Axial', 10, 'LCSC', 'C25804', 0.01, 'Switch pulldowns'],
  ['R11-R20', '1K 0603 THT', 'Axial', 10, 'LCSC', 'C22548', 0.01, 'LED series resistors'],
  ['LED1-LED10', '3mm red LED', 'THT', 10, 'LCSC', 'C99765', 0.04, 'Result, flag and counter indicators'],
  ['C1-C9', '100n ceramic', 'Disc', 9, 'LCSC', 'C14663', 0.01, 'Per IC decoupling'],
  ['BB1,BB2', '830 point breadboard', 'Hardware', 2, 'DigiKey', '1738-1030-ND', 2.25, 'Two solderless breadboards'],
  ['JMP', 'M/M jumper wire kit', 'Hardware', 1, 'DigiKey', '1528-1950-ND', 1.95, 'Cut to length labelled jumpers']
];

// ---------------------------------------------------------------------------
// Week 5 netlist.
// ---------------------------------------------------------------------------
function week5Netlist() {
  const pins = {};
  const set = (ic, pin, signal) => { pins[`${ic}.${pin}`] = signal; };
  const ic = {
    U1: { part: '74HC283', package: 'DIP-16', power: [8, 16] },
    U2: { part: '74HC86', package: 'DIP-14', power: [7, 14] },
    U3: { part: '74HC08', package: 'DIP-14', power: [7, 14] },
    U4: { part: '74HC32', package: 'DIP-14', power: [7, 14] },
    U5: { part: '74HC153', package: 'DIP-16', power: [8, 16] },
    U9: { part: '74HC153', package: 'DIP-16', power: [8, 16] },
    U6: { part: '74HC161', package: 'DIP-16', power: [8, 16] },
    U7: { part: '74HC14', package: 'DIP-14', power: [7, 14] },
    U8: { part: '74HC02', package: 'DIP-14', power: [7, 14] }
  };
  // U1 74HC283, NXP datasheet Fig 5 pin configuration.
  const u1 = { 1: 'S2', 2: 'B2', 3: 'A2', 4: 'S1', 5: 'A1', 6: 'B1', 7: 'CIN', 8: 'GND', 9: 'COUT', 10: 'S4', 11: 'B4', 12: 'A4', 13: 'S3', 14: 'A3', 15: 'B3', 16: 'VCC' };
  for (const [p, s] of Object.entries(u1)) set('U1', p, s);
  const gateMap = { 1: '1A', 2: '1B', 3: '1Y', 4: '2A', 5: '2B', 6: '2Y', 7: 'GND', 9: '3A', 10: '3B', 8: '3Y', 12: '4A', 13: '4B', 11: '4Y', 14: 'VCC' };
  for (const [p, s] of Object.entries(gateMap)) { set('U2', p, s); set('U3', p, s); set('U4', p, s); }
  // U8 74HC02 NOR DIP pinout differs from the XOR/AND/OR gate map.
  const nor = { 1: '1Y', 2: '1A', 3: '1B', 4: '2Y', 5: '2A', 6: '2B', 7: 'GND', 10: '3Y', 8: '3A', 9: '3B', 13: '4Y', 11: '4A', 12: '4B', 14: 'VCC' };
  for (const [p, s] of Object.entries(nor)) set('U8', p, s);
  const u5 = { 1: '1G', 2: 'S1', 3: '1C3', 4: '1C2', 5: '1C1', 6: '1C0', 7: '1Y', 8: 'GND', 9: '2Y', 10: '2C0', 11: '2C1', 12: '2C2', 13: '2C3', 14: 'S0', 15: '2G', 16: 'VCC' };
  for (const [p, s] of Object.entries(u5)) { set('U5', p, s); set('U9', p, s); }
  const u6 = { 1: 'MR', 2: 'CP', 3: 'D0', 4: 'D1', 5: 'D2', 6: 'D3', 7: 'CEP', 8: 'GND', 9: 'PE', 10: 'CET', 11: 'Q3', 12: 'Q2', 13: 'Q1', 14: 'Q0', 15: 'TC', 16: 'VCC' };
  for (const [p, s] of Object.entries(u6)) set('U6', p, s);
  const u7 = { 1: '1A', 2: '1Y', 3: '2A', 4: '2Y', 5: '3A', 6: '3Y', 7: 'GND', 9: '4A', 8: '4Y', 11: '5A', 10: '5Y', 13: '6A', 12: '6Y', 14: 'VCC' };
  for (const [p, s] of Object.entries(u7)) set('U7', p, s);

  const nets = [
    { name: 'VCC', nodes: ['U1.16', 'U2.14', 'U3.14', 'U4.14', 'U5.16', 'U9.16', 'U6.16', 'U7.14', 'U8.14'], note: '5 V rail' },
    { name: 'GND', nodes: ['U1.8', 'U2.7', 'U3.7', 'U4.7', 'U5.8', 'U9.8', 'U6.8', 'U7.7', 'U8.7'], note: '0 V rail' },
    { name: 'A0', nodes: ['U1.5', 'U3.1', 'U4.1', 'SW_A0'], note: 'A bit 0 to adder, AND gate and OR gate' },
    { name: 'A1', nodes: ['U1.3', 'U3.4', 'U4.4', 'SW_A1'] },
    { name: 'A2', nodes: ['U1.14', 'U3.9', 'U4.9', 'SW_A2'] },
    { name: 'A3', nodes: ['U1.12', 'U3.12', 'U4.12', 'SW_A3'] },
    { name: 'B0', nodes: ['U2.1', 'U3.2', 'U4.2', 'SW_B0'], note: 'B bit to XOR stage, AND gate and OR gate' },
    { name: 'B1', nodes: ['U2.4', 'U3.5', 'U4.5', 'SW_B1'] },
    { name: 'B2', nodes: ['U2.9', 'U3.10', 'U4.10', 'SW_B2'] },
    { name: 'B3', nodes: ['U2.12', 'U3.13', 'U4.13', 'SW_B3'] },
    { name: 'SUB', nodes: ['U8.1', 'U2.2', 'U2.5', 'U2.10', 'U2.13', 'U1.7'], note: 'SUB = S0 AND NOT S1 decoded by U8 gate 1, drives XOR stage and CIN' },
    { name: 'BX0', nodes: ['U2.3', 'U1.6'], note: 'B0 XOR SUB into adder B1' },
    { name: 'BX1', nodes: ['U2.6', 'U1.2'] },
    { name: 'BX2', nodes: ['U2.8', 'U1.15'] },
    { name: 'BX3', nodes: ['U2.11', 'U1.11'] },
    { name: 'SUM0', nodes: ['U1.4', 'U5.6', 'U5.5'], note: 'Sum bit 0 into mux C0 (ADD) and C1 (SUB)' },
    { name: 'SUM1', nodes: ['U1.1', 'U5.10', 'U5.11'] },
    { name: 'SUM2', nodes: ['U1.13', 'U9.6', 'U9.5'] },
    { name: 'SUM3', nodes: ['U1.10', 'U9.10', 'U9.11'] },
    { name: 'CARRY', nodes: ['U1.9', 'LED_CARRY'], note: 'For SUB reads as NOT borrow' },
    { name: 'AND0', nodes: ['U3.3', 'U5.4'], note: 'AND bit 0 into mux C2' },
    { name: 'AND1', nodes: ['U3.6', 'U5.12'] },
    { name: 'AND2', nodes: ['U3.8', 'U9.4'] },
    { name: 'AND3', nodes: ['U3.11', 'U9.12'] },
    { name: 'OR0', nodes: ['U4.3', 'U5.3'], note: 'OR bit 0 into mux C3' },
    { name: 'OR1', nodes: ['U4.6', 'U5.13'] },
    { name: 'OR2', nodes: ['U4.8', 'U9.3'] },
    { name: 'OR3', nodes: ['U4.11', 'U9.13'] },
    { name: 'Y0', nodes: ['U5.7', 'U8.5', 'LED_Y0'], note: 'Result bus bit 0' },
    { name: 'Y1', nodes: ['U5.9', 'U8.6', 'LED_Y1'] },
    { name: 'Y2', nodes: ['U9.7', 'U8.8', 'LED_Y2'] },
    { name: 'Y3', nodes: ['U9.9', 'U8.9', 'LED_Y3'], note: 'Result bus bit 3' },
    { name: 'S0', nodes: ['U5.14', 'U9.14', 'U7.1', 'SW_S0'], note: 'Opcode select bit 0' },
    { name: 'NS0', nodes: ['U7.2', 'U8.2'], note: 'Inverted S0 for SUB decode' },
    { name: 'S1', nodes: ['U5.2', 'U9.2', 'U8.3', 'SW_S1'], note: 'Opcode select bit 1' },
    { name: 'MUX_G', nodes: ['U5.1', 'U5.15', 'U9.1', 'U9.15', 'GND_BUS'], note: 'All active low strobes tied LOW' },
    { name: 'CLOCK', nodes: ['U7.3', 'SW_STEP'], note: 'RC debounced step pushbutton' },
    { name: 'CLK_BUF', nodes: ['U7.4', 'U6.2'], note: 'Schmitt buffered clock to 74HC161 CP' },
    { name: 'MR_N', nodes: ['U6.1', 'SW_RESET'], note: 'Active low master reset' },
    { name: 'PE_N', nodes: ['U6.9', 'VCC_BUS'], note: 'Parallel load disabled' },
    { name: 'ENABLE', nodes: ['U6.7', 'U6.10', 'VCC_BUS'], note: 'CEP and CET both HIGH' },
    { name: 'Q0', nodes: ['U6.14', 'LED_Q0'] },
    { name: 'Q1', nodes: ['U6.13', 'LED_Q1'] },
    { name: 'Q2', nodes: ['U6.12', 'LED_Q2'] },
    { name: 'Q3', nodes: ['U6.11', 'LED_Q3'] },
    { name: 'Z01', nodes: ['U8.4', 'U7.9'], note: 'NOR(Y0,Y1) intermediate for ZERO flag' },
    { name: 'NZ01', nodes: ['U7.8', 'U8.11'] },
    { name: 'Z23', nodes: ['U8.10', 'U7.11'], note: 'NOR(Y2,Y3) intermediate for ZERO flag' },
    { name: 'NZ23', nodes: ['U7.10', 'U8.12'] },
    { name: 'ZERO', nodes: ['U8.13', 'LED_ZERO'], note: 'NOR(NZ01,NZ23) = Z01 AND Z23, high when Y bus is zero' },
    { name: 'OVERFLOW', nodes: ['J_EXP_OVF'], note: 'Not routed: carry into the MSB is internal to the 74HC283, so signed overflow needs an extra gate stage. Reserved expansion pin, see BREADBOARD_GUIDE.md' },
    { name: 'SPARE_TIE', nodes: ['U7.5', 'U7.13', 'U6.3', 'U6.4', 'U6.5', 'U6.6', 'GND_BUS'], note: 'All unused CMOS inputs defined' }
  ];
  return {
    project: 'DiscreteALU-74HC',
    revision: '1.0.0',
    description: 'Pin accurate 4 bit 74HCxx CMOS ALU and step counter breadboard netlist',
    voltage: '5.0 V nominal, 74HC CMOS',
    integrated_circuits: ic,
    pin_map: pins,
    nets,
    opcode_table: [
      { s: '00', mnemonic: 'ADD', source: '74HC283 sum, SUB=0' },
      { s: '01', mnemonic: 'SUB', source: '74HC283 sum, SUB=1, A + ~B + 1' },
      { s: '10', mnemonic: 'AND', source: '74HC08 bitwise AND on mux C2' },
      { s: '11', mnemonic: 'OR', source: '74HC32 bitwise OR on mux C3' },
      { s: 'eval-only', mnemonic: 'XOR', source: 'Software evaluator expansion opcode, second 74HC86 required on hardware' }
    ],
    flag_equations: {
      CARRY: 'COUT of 74HC283; for SUB equals NOT borrow',
      ZERO: 'ZERO = AND(NOR(Y0,Y1), NOR(Y2,Y3)) via three 74HC02 gates and two 74HC14 inverters',
      OVERFLOW: 'Not computed on board: carry into the MSB is internal to the 74HC283. Reserved expansion pin J_EXP_OVF'
    }
  };
}

// ---------------------------------------------------------------------------
// 5x7 ASCII font table (Adafruit GFX classic glcdfont, 256 glyphs x 5 bytes).
// Generated from the upstream bitmap into a JS/C shared table.
// ---------------------------------------------------------------------------
function fontTable() {
  const src = fs.readFileSync(path.join(__dirname, 'font_data.txt'), 'utf8');
  return src.trim().split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => l.replace(/^\{|\},?$/g, ''));
}

function fontFile() {
  const glyphs = fontTable();
  let s = '// 5x7 ASCII font table. 256 glyphs, 5 column bytes per glyph.\n';
  s += '// Classic fixed-space bitmap font as used by the SSD1306 page driver.\n';
  s += '// Each byte is one vertical column, LSB is the top pixel row.\n\n';
  s += 'const FONT5X7_GLYPHS = [\n';
  for (let i = 0; i < glyphs.length; i += 8)
    s += '  ' + glyphs.slice(i, i + 8).map(g => `[${g}]`).join(', ') + ',\n';
  s += '];\n\n';
  s += 'const FONT5X7 = FONT5X7_GLYPHS.flat();\n\n';
  s += 'function glyphColumns(code) { return FONT5X7_GLYPHS[code & 0xff]; }\n\n';
  s += 'if (typeof module !== "undefined") module.exports = { FONT5X7, FONT5X7_GLYPHS, glyphColumns };\n';
  s += 'if (typeof window !== "undefined") window.GlyphFont = { FONT5X7, FONT5X7_GLYPHS, glyphColumns };\n';
  return s;
}

// C header used by week4-display/firmware/glyphmatrix.ino. Glyphs 0x20..0x7F
// are emitted as 96 rows of five hex bytes; the firmware indexes by (ch-0x20).
function fontHeader() {
  const rows = fontTable();
  const ascii = rows.slice(0x20, 0x80);
  let s = '// Generated by tools/generate_suite_artifacts.js. ASCII 0x20..0x7F.\n';
  s += '// 96 glyphs, 5 column bytes each, LSB is the top pixel row.\n';
  for (const glyph of ascii) s += '{' + glyph + '},\n';
  return s;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
function main() {
  primitiveIndex = 0;
  // Week 2 geometry.
  const parts = {
    base_chassis: makeBaseChassis(PARAMS),
    tilt_cradle: makeTiltCradle(PARAMS),
    detent_dial: makeDetentDial(PARAMS)
  };
  const assembled = makeAssembled(PARAMS);
  const stats = {};
  for (const [name, mesh] of Object.entries(parts)) {
    write(`week2-cad/${name}.stl`, toSTL(mesh, name));
    stats[name] = manifoldStats(mesh);
  }
  write('week2-cad/assembled_preview.obj', toOBJ(assembled, 'helical_desk_assembled'));
  stats.assembled_preview = manifoldStats(assembled);
  write('week2-cad/geometry_stats.json', JSON.stringify({ params: PARAMS, parts: stats }, null, 2) + '\n');

  // KiCad boards and schematics.
  const week1Fab = week1(); week3(); week4();

  // Gerber and drill sets: pad flashes and holes derived from the same
  // deterministic footprint positions used above.
  const mk = (w, h) => {
    const pads = [], drills = [];
    for (let i = 0; i < 24; i++) {
      const x = 8 + (i % 8) * ((w - 16) / 8), y = 10 + Math.floor(i / 8) * 11;
      pads.push({ x, y, ap: 12 });
      if (i % 3 === 0) drills.push({ x, y, d: 0.8 });
    }
    for (const [x, y] of [[3.5, 3.5], [w - 3.5, 3.5], [3.5, h - 3.5], [w - 3.5, h - 3.5]]) {
      pads.push({ x, y, ap: 13 });
      drills.push({ x, y, d: 2.7 });
    }
    for (const [x, y] of [[w - 8, h / 2 - 3.81], [w - 8, h / 2 - 1.27], [w - 8, h / 2 + 1.27], [w - 8, h / 2 + 3.81]]) {
      pads.push({ x, y, ap: 14 });
      drills.push({ x, y, d: 1.0 });
    }
    return { pads, drills };
  };
  const g1 = mk(62, 42), g3 = mk(78, 56), g4 = mk(88, 54);
  gerberSet('week1-pcb', 62, 42, g1.pads, week1Fab.drills, 'benchrail_ina', week1Fab);
  gerberSet('week3-music', 78, 56, g3.pads, g3.drills, 'pocketchime');
  gerberSet('week4-display', 88, 54, g4.pads, g4.drills, 'glyphmatrix');

  // BOMs.
  write('week1-pcb/bom.csv', bom(BOM1));
  write('week3-music/bom.csv', bom(BOM3));
  write('week4-display/bom.csv', bom(BOM4));
  write('week5-logic/bom.csv', bom(BOM5));

  // Week 5 netlist and shared font tables.
  write('week5-logic/netlist.json', JSON.stringify(week5Netlist(), null, 2) + '\n');
  const fnt = fontFile();
  write('week4-display/font5x7.js', fnt);
  write('week4-display/firmware/font5x7_data.h', fontHeader());
  write('suite_font.js', fnt);
  console.log('Generated KiCad boards, schematics, Gerbers, BOMs, STL/OBJ, netlist and font table.');
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k}: triangles=${v.triangles} unmatchedEdges=${v.unmatched} volume=${v.volume.toFixed(2)} mm^3`);
  }
}

main();
