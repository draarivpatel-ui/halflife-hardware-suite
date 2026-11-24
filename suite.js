'use strict';
// Suite simulation core. Zero dependencies, Node and browser compatible.
// All five week models live here so that app.js only handles rendering.
// No timers, no network calls, no audio contexts are created in this module.

(function (root) {
  const Suite = {};

  // -------------------------------------------------------------------------
  // Week 1: BenchRail-INA. INA219 shunt and bus voltage register model.
  // A 0.1 ohm shunt, PGA /8, 320 uV LSB, 4 mV bus LSB.
  // -------------------------------------------------------------------------
  Suite.BENCHRAIL = {
    shunt: 0.1,
    currentLSB: 40e-6,
    busLSB: 0.004,
    calibration(shunt, lsb) { return Math.floor(0.04096 / (lsb * shunt)); },
    currentRegister(amps, shunt, lsb) {
      const raw = Math.round((amps * shunt) / lsb);
      return Math.max(-32768, Math.min(32767, raw));
    },
    busRegister(volts) { return Math.round(volts / 0.004) << 3; },
    decodeShunt(raw) { return raw * 0.00001; },
    decodeBus(raw) { return ((raw >> 3) & 0xFFFF) * 0.004; },
    power(current, busVoltage) { return current * busVoltage; },
    maxCurrent(shunt) { return 0.32 / shunt; }
  };

  // -------------------------------------------------------------------------
  // Week 2: HelicalDesk. STL and OBJ parsing plus half-edge manifold checks.
  // -------------------------------------------------------------------------
  function parseSTL(text) {
    const verts = [], faces = [], normals = [];
    const lines = text.split('\n');
    let cur = [], n = null;
    for (const line of lines) {
      const nm = line.match(/facet\s+normal\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/);
      if (nm) { n = [+nm[1], +nm[2], +nm[3]]; cur = []; }
      const vm = line.match(/vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/);
      if (vm) { cur.push(verts.length); verts.push([+vm[1], +vm[2], +vm[3]]); }
      if (/endfacet/.test(line)) { faces.push(cur); normals.push(n || [0, 0, 0]); }
    }
    return { verts, faces, normals };
  }

  function parseOBJ(text) {
    const verts = [], faces = [];
    for (const line of text.split('\n')) {
      const v = line.match(/^v\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/);
      if (v) { verts.push([+v[1], +v[2], +v[3]]); continue; }
      const f = line.match(/^f\s+(\d+)\s+(\d+)\s+(\d+)/);
      if (f) faces.push([+f[1] - 1, +f[2] - 1, +f[3] - 1]);
    }
    return { verts, faces, normals: [] };
  }

  function signedVolume(mesh, faces) {
    const v = mesh.verts;
    let vol = 0;
    for (const [a, b, c] of faces || mesh.faces) {
      const p = v[a], q = v[b], r = v[c];
      vol += (p[0] * (q[1] * r[2] - q[2] * r[1]) -
              p[1] * (q[0] * r[2] - q[2] * r[0]) +
              p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    }
    return vol;
  }

  // Weld vertices by coordinate so that the half-edge check sees the shared
  // edges between adjacent triangles rather than duplicated STL corners.
  function weld(mesh) {
    const map = new Map(), verts = [];
    const faces = mesh.faces.map(tri => tri.map(i => {
      const k = mesh.verts[i].join(',');
      if (!map.has(k)) { map.set(k, verts.length); verts.push(mesh.verts[i]); }
      return map.get(k);
    }));
    return { verts, faces, normals: mesh.normals };
  }

  function manifoldStats(mesh, doWeld = true) {
    const m = doWeld ? weld(mesh) : mesh;
    const edges = new Map();
    const key = (a, b) => `${a}|${b}`;
    for (const [a, b, c] of m.faces) {
      for (const [u, v] of [[a, b], [b, c], [c, a]])
        edges.set(key(u, v), (edges.get(key(u, v)) || 0) + 1);
    }
    let unmatched = 0, duplicate = 0;
    for (const [k, count] of edges) {
      const [u, v] = k.split('|');
      const opposite = edges.get(key(v, u)) || 0;
      if (count !== 1 || opposite !== 1) unmatched++;
      if (count > 1) duplicate++;
    }
    // Connected components by union-find, with per-component signed volume.
    const parent = m.verts.map((_, i) => i);
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    for (const [a, b, c] of m.faces) { union(a, b); union(b, c); }
    const groups = new Map();
    for (const tri of m.faces) {
      const r = find(tri[0]);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(tri);
    }
    const components = [...groups.values()].map(fs => ({
      triangles: fs.length,
      volume: signedVolume(m, fs)
    }));
    // STL facet normals are verified before welding. Welding merges vertices
    // that share a coordinate, which makes near-degenerate fan triangles on
    // curved annuli collapse their cross product; checking them afterwards
    // would produce false negatives, so the original mesh is used here.
    const normalErrors = [];
    const source = mesh.normals && mesh.normals.length ? mesh : m;
    for (let i = 0; i < source.faces.length; i++) {
      if (!source.normals || !source.normals[i]) continue;
      const [a, b, c] = source.faces[i].map(j => source.verts[j]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const L = Math.hypot(...n) || 1;
      const dot = (n[0] * source.normals[i][0] + n[1] * source.normals[i][1] + n[2] * source.normals[i][2]) / L;
      if (dot < 0.99) normalErrors.push(i);
    }
    return {
      vertices: m.verts.length, triangles: m.faces.length,
      directedEdges: edges.size, unmatched, duplicate,
      volume: signedVolume(m), components, normalErrors,
      watertight: unmatched === 0 && duplicate === 0,
      outward: normalErrors.length === 0 && components.every(c => c.volume > 0)
    };
  }

  Suite.STL = { parseSTL, parseOBJ, weld, signedVolume, manifoldStats };

  // -------------------------------------------------------------------------
  // Week 3: PocketChime-R2R. Ideal 8-bit R-2R ladder solver and DDS voices.
  // -------------------------------------------------------------------------
  // Small dense linear solver (Gaussian elimination with partial pivoting).
  // Used only for the 8 node R-2R nodal system, so it stays dependency free.
  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      const tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp;
      const d = M[col][col];
      for (let c = col; c <= n; c++) M[col][c] /= d;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = M[r][col];
        if (factor === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
      }
    }
    return M.map(row => row[n]);
  }

  function ladderVoltage(code, vref = 3.3, R = 10000, TWO_R = 20000) {
    // Exact nodal analysis of a voltage mode R-2R ladder.
    // Node 0 is the LSB end (terminated by 2R to GND), node 7 is the MSB
    // end and is the high impedance output feeding the MCP6002 buffer.
    // Each node k has a 2R vertical leg to its bit voltage and R horizontal
    // resistors to its neighbours. Kirchhoff current balance at node k:
    //   sum((Vk - Vj)/R) + (Vk - Vbit_k)/(2R) [+ Vk/(2R) at node 0] = 0
    const n = 8;
    const gH = 1 / R, gV = 1 / TWO_R;
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    const b = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
      let diag = gV;
      if (k > 0) { diag += gH; A[k][k - 1] -= gH; }
      if (k < n - 1) { diag += gH; A[k][k + 1] -= gH; }
      if (k === 0) diag += gV; // 2R termination to GND
      A[k][k] = diag;
      b[k] = ((code >> k) & 1) ? vref * gV : 0;
    }
    return solveLinear(A, b)[n - 1];
  }
  function ladderCodes(vref = 3.3) {
    return Array.from({ length: 256 }, (_, c) => ladderVoltage(c, vref));
  }
  function isMonotonic(values, epsilon = 1e-12) {
    for (let i = 1; i < values.length; i++) if (values[i] - values[i - 1] < -epsilon) return false;
    return true;
  }

  const WAVEFORMS = ['pulse', 'triangle', 'saw', 'square'];
  function oscillator(waveform, phase, duty = 0.25) {
    const p = phase - Math.floor(phase);
    switch (waveform) {
      case 'pulse': return p < duty ? 1 : -1;
      case 'triangle': return 4 * Math.abs(p - 0.5) - 1;
      case 'saw': return 2 * p - 1;
      default: return p < 0.5 ? 1 : -1;
    }
  }

  // Four stage ADSR. Returns level 0..1 for a given elapsed sample count.
  function adsr(t, a, d, s, r, gateOff) {
    if (!gateOff) {
      if (t < a) return t / Math.max(1, a);
      if (t < a + d) return 1 - (1 - s) * (t - a) / Math.max(1, d);
      return s;
    }
    if (t < r) return s * (1 - t / Math.max(1, r));
    return 0;
  }

  function ddsSample(code, opts) {
    const o = opts || {};
    const voices = o.voices || [
      { waveform: 'pulse', ratio: 1.0, amp: 0.55, duty: 0.25 },
      { waveform: 'triangle', ratio: 1.5, amp: 0.28, duty: 0.5 },
      { waveform: 'saw', ratio: 2.0, amp: 0.12, duty: 0.5 },
      { waveform: 'square', ratio: 0.5, amp: 0.05, duty: 0.5 }
    ];
    const t = o.t || 0, base = o.baseHz || 220, rate = o.rate || 22050;
    let mix = 0;
    for (const v of voices) {
      const phase = (base * v.ratio * t / rate) % 1;
      mix += v.amp * oscillator(v.waveform, phase, v.duty);
    }
    const env = opts && opts.envelope !== undefined ? opts.envelope
      : adsr(t, o.attack || 200, o.decay || 900, o.sustain || 0.6, o.release || 1600, o.gateOff || false);
    const normalized = Math.max(0, Math.min(1, 0.5 + 0.5 * mix * env));
    return { code: Math.round(normalized * 255), volts: ladderVoltage(Math.round(normalized * 255)), mix, env };
  }

  Suite.DAC = { ladderVoltage, ladderCodes, isMonotonic, WAVEFORMS, oscillator, adsr, ddsSample };

  // -------------------------------------------------------------------------
  // Week 4: GlyphMatrix. SSD1306 128x64 page buffer plus 8x8 LED scan.
  // -------------------------------------------------------------------------
  const FONT = (root.GlyphFont && root.GlyphFont.FONT5X7_GLYPHS) ||
    (root.module && root.module.exports && root.module.exports.FONT5X7_GLYPHS) || null;
  function makePageBuffer() { return Array.from({ length: 8 }, () => new Uint8Array(128)); }
  class SSD1306 {
    constructor(addr) { this.addr = addr || 0x3C; this.pages = makePageBuffer(); }
    clear(on) { for (const p of this.pages) p.fill(on ? 0xFF : 0); }
    setPixel(x, y, on) {
      if (x < 0 || x > 127 || y < 0 || y > 63) return;
      const bit = 1 << (y & 7);
      if (on) this.pages[y >> 3][x] |= bit;
      else this.pages[y >> 3][x] &= ~bit & 0xFF;
    }
    getPixel(x, y) { return (this.pages[y >> 3][x] >> (y & 7)) & 1; }
    drawChar(x, y, code) {
      const glyph = FONT ? FONT[code & 0xFF] : [0, 0, 0, 0, 0];
      for (let c = 0; c < 5; c++)
        for (let r = 0; r < 7; r++)
          if (glyph[c] & (1 << r)) this.setPixel(x + c, y + r, 1);
    }
    drawString(x, y, text) {
      for (let i = 0; i < text.length; i++) this.drawChar(x + i * 6, y, text.charCodeAt(i));
    }
    hLine(x0, x1, y) { for (let x = x0; x <= x1; x++) this.setPixel(x, y, 1); }
    vLine(x, y0, y1) { for (let y = y0; y <= y1; y++) this.setPixel(x, y, 1); }
    byteCount() { return this.pages.length * this.pages[0].length; }
    serialize() { return this.pages.map(p => Array.from(p)); }
  }

  // 74HC595 scan: shift in one column byte and one row byte, then latch.
  function shift595(ser, sck, latch, columnByte, rowByte) {
    // Returns the 16 bit shift register contents, MSB first. Pure model, no IO.
    return ((rowByte & 0xFF) << 8) | (columnByte & 0xFF);
  }
  function scanRow(frame, row) {
    const columns = (~frame[row]) & 0xFF;
    return { rowByte: 1 << row, columnByte: columns, register: shift595(0, 0, 0, columns, 1 << row) };
  }
  function ledFrameFromGlyph(glyph) {
    return Array.from({ length: 8 }, (_, r) => {
      let bits = 0;
      for (let c = 0; c < 8; c++) {
        const col = c < 5 ? glyph[c] : 0;
        if (r < 7 && (col & (1 << r))) bits |= 1 << c;
      }
      return bits;
    });
  }

  Suite.Display = { SSD1306, makePageBuffer, shift595, scanRow, ledFrameFromGlyph };
  Suite.FONT = FONT;

  // -------------------------------------------------------------------------
  // Week 5: gate level ALU. Mirrors week5-logic/alu.js so the workbench and
  // the Node test suite evaluate the identical truth table.
  // -------------------------------------------------------------------------
  const xor1 = (a, b) => (a ^ b) & 1, and1 = (a, b) => a & b & 1, or1 = (a, b) => (a | b) & 1;
  function fullAdder(a, b, cin) {
    const p = xor1(a, b);
    return { sum: xor1(p, cin), carry: or1(and1(a, b), and1(p, cin)) };
  }
  function hc283(A, B, cin, invertB) {
    let carry = cin & 1, sum = 0, c3 = 0;
    for (let i = 0; i < 4; i++) {
      const cell = fullAdder((A >> i) & 1, xor1((B >> i) & 1, invertB), carry);
      sum |= cell.sum << i;
      if (i === 2) c3 = cell.carry;
      carry = cell.carry;
    }
    return { sum, carry, carryIntoMSB: c3 };
  }
  function alu(A, B, op) {
    A &= 15; B &= 15;
    const sub = op === 1 ? 1 : 0;
    const add = hc283(A, B, sub, sub);
    const outputs = [add.sum, add.sum, A & B, A | B, A ^ B];
    const Y = outputs[op] & 15;
    const a3 = (A >> 3) & 1, b3 = (B >> 3) & 1, y3 = (Y >> 3) & 1;
    const signsEqual = 1 - xor1(a3, b3), signChanged = xor1(y3, a3);
    const overflow = (op === 0 || op === 1)
      ? (sub ? and1(1 - signsEqual, signChanged) : and1(signsEqual, signChanged)) : 0;
    return {
      A, B, op, Y,
      CARRY: (op === 0 || op === 1) ? add.carry : 0,
      ZERO: Y === 0 ? 1 : 0,
      OVERFLOW: overflow,
      gates: { adderSum: add.sum, cout: add.carry, cin: sub, bx: B ^ (sub ? 15 : 0), and: A & B, or: A | B, xor: A ^ B }
    };
  }
  Suite.ALU = { OP_NAMES: ['ADD', 'SUB', 'AND', 'OR', 'XOR'], fullAdder, hc283, alu };

  // -------------------------------------------------------------------------
  // Week 1 PCB geometry description for the SVG copper layer inspector.
  // -------------------------------------------------------------------------
  Suite.BOARDS = {
    week1: { name: 'BenchRail-INA', w: 62, h: 42, nets: ['GND', 'VBUS', '+3V3', 'SDA', 'SCL', 'SHUNT_HI', 'SHUNT_LO', 'VRAIL+', 'VRAIL-'], layers: ['F.Cu', 'B.Cu', 'F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask', 'Edge.Cuts', 'F.CrtYd', 'B.CrtYd'] },
    week3: { name: 'PocketChime-R2R', w: 78, h: 56, nets: ['GND', '+3V3', 'DAC0', 'DAC1', 'DAC2', 'DAC3', 'DAC4', 'DAC5', 'DAC6', 'DAC7', 'AUDIO_L', 'AUDIO_R'], layers: ['F.Cu', 'B.Cu', 'F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask', 'Edge.Cuts', 'F.CrtYd', 'B.CrtYd'] },
    week4: { name: 'GlyphMatrix-128', w: 88, h: 54, nets: ['GND', '+3V3', 'I2C_SDA', 'I2C_SCL', 'SPI_MOSI', 'SPI_SCK', 'SPI_LATCH', 'LED_ROW0', 'LED_COL0'], layers: ['F.Cu', 'B.Cu', 'F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask', 'Edge.Cuts', 'F.CrtYd', 'B.CrtYd'] }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Suite;
  if (typeof window !== 'undefined') window.HalfLifeSuite = Suite;
})(typeof window !== 'undefined' ? window : globalThis);
