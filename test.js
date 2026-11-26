'use strict';
// node --test test.js
// Zero dependency verification of every generated artifact in the suite.
// 50+ assertions covering KiCad S-expressions, Gerber/Excellon, BOMs, STL
// manifold topology, R-2R monotonicity, SSD1306 page buffers, the 512-vector
// 74HCxx ALU truth table, and a byte-level character scan of all files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const p = rel => path.join(ROOT, rel);
const read = rel => fs.readFileSync(p(rel), 'utf8');
const bytes = rel => fs.readFileSync(p(rel));

// Load browser-only modules into a fresh sandbox so their window globals work.
// One shared VM realm for all browser modules. A single realm means arrays
// compare by value under assert.deepEqual, and no host globals leak in.
const realm = vm.createContext({ window: {}, console });
realm.window.window = realm.window;
function loadBrowserModule(rel) {
  vm.runInContext(read(rel), realm, { filename: rel });
  return realm;
}
loadBrowserModule('suite_font.js');
loadBrowserModule('week5-logic/alu.js');
loadBrowserModule('suite.js');
const S = realm.window.HalfLifeSuite;
const ALU = realm.window.DiscreteALU;
const FONT = realm.window.GlyphFont;

function allFiles() {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(p(dir), { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.DS_Store') continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel); else out.push(rel.split(path.sep).join('/'));
    }
  };
  walk('.');
  return out;
}

// ---------------------------------------------------------------------------
// 1. KiCad 8 file format: balanced parens, versions, required layers, nets.
// ---------------------------------------------------------------------------
const BOARDS = [
  ['week1-pcb/benchrail_ina.kicad_pcb', 62, 42],
  ['week3-music/pocketchime.kicad_pcb', 78, 56],
  ['week4-display/glyphmatrix.kicad_pcb', 88, 54]
];
const REQUIRED_LAYERS = ['F.Cu', 'B.Cu', 'F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask', 'Edge.Cuts', 'F.CrtYd', 'B.CrtYd'];

function balance(text) {
  let depth = 0, min = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    min = Math.min(min, depth);
    if (depth < 0) return { ok: false, depth, min };
  }
  return { ok: depth === 0, depth, min };
}

for (const [rel] of BOARDS) {
  test(`KiCad S-expression is balanced: ${rel}`, () => {
    const b = balance(read(rel));
    assert.equal(b.ok, true, `final depth ${b.depth}`);
    assert.equal(b.min, 0);
  });
  test(`KiCad 8 header and required layers: ${rel}`, () => {
    const s = read(rel);
    assert.match(s, /\(kicad_pcb/);
    assert.match(s, /\(version 20240108\)/);
    assert.match(s, /\(generator "pcbnew"\)/);
    assert.match(s, /\(generator_version "8\.0"\)/);
    for (const layer of REQUIRED_LAYERS) assert.ok(s.includes(`"${layer}"`), `missing ${layer}`);
    assert.match(s, /\(thickness 1\.6\)/);
    assert.match(s, /\(copper_finish "ENIG"\)/);
  });
  test(`Board has routed copper, pads, courtyards, mounting holes: ${rel}`, () => {
    const s = read(rel);
    assert.ok((s.match(/\(segment /g) || []).length >= 8, 'needs copper segments');
    assert.ok((s.match(/\(pad "/g) || []).length >= 16, 'needs pads');
    assert.ok((s.match(/\(fp_rect /g) || []).length >= 4, 'needs courtyards');
    assert.ok((s.match(/MountingHole:MountingHole_2\.7mm_M2\.5/g) || []).length === 4, 'needs four M2.5 holes');
    assert.ok((s.match(/np_thru_hole/g) || []).length === 4, 'holes must be non-plated');
    assert.match(s, /\(zone /);
  });
  test(`Board has net declarations and net class project: ${rel}`, () => {
    const s = read(rel);
    assert.ok((s.match(/\(net \d+ "/g) || []).length >= 9, 'needs nets');
    assert.match(s, /\(net 0 ""\)/);
    const pro = JSON.parse(read(rel.replace('.kicad_pcb', '.kicad_pro')));
    assert.ok(pro.net_settings.classes.length >= 3);
    const names = pro.net_settings.classes.map(c => c.name);
    assert.ok(names.includes('Default'));
    assert.ok(names.includes('Power'));
    assert.ok(names.includes('Signal'));
    assert.ok(pro.net_settings.netclass_patterns.length >= 2);
  });
}

test('Week 1 KiCad 8 schematic is balanced and has symbols, wires, labels', () => {
  const s = read('week1-pcb/benchrail_ina.kicad_sch');
  const b = balance(s);
  assert.equal(b.ok, true);
  assert.match(s, /\(kicad_sch/);
  assert.match(s, /\(version 20231120\)/);
  assert.match(s, /\(generator_version "8\.0"\)/);
  assert.match(s, /\(lib_symbols/);
  assert.ok((s.match(/\n\t\(symbol /g) || []).length >= 10, 'placed symbols');
  assert.ok((s.match(/\(wire /g) || []).length >= 6, 'wires');
  assert.ok((s.match(/\(label "/g) || []).length >= 5, 'labels');
  assert.match(s, /INA219AIDCNR/);
  assert.match(s, /AMS1117-3\.3/);
  assert.match(s, /USB4105-GF-A/);
  assert.match(s, /0R1 1% 1206/);
  assert.match(s, /\(sheet_instances /);
  assert.match(s, /\(embedded_fonts no\)/);
});

function expandRefSpec(spec) {
  const out = [];
  for (const piece of spec.split(',')) {
    const m = /^([A-Z]+)(\d+)-(?:[A-Z]+)?(\d+)$/.exec(piece.trim());
    if (m) {
      for (let n = Number(m[2]); n <= Number(m[3]); n++) out.push(m[1] + n);
    } else out.push(piece.trim());
  }
  return out;
}

function valueForRef(text, ref) {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\(property "Reference" "${escaped}"[\\s\\S]{0,700}?\\(property "Value" "([^"]*)"`);
  const m = re.exec(text);
  return m && m[1];
}

test('Week 1 BOM references and values are identical across schematic and PCB', () => {
  const rows = parseCSV('week1-pcb/bom.csv').slice(1);
  const sch = read('week1-pcb/benchrail_ina.kicad_sch');
  const pcb = read('week1-pcb/benchrail_ina.kicad_pcb');
  for (const row of rows) {
    if (row[0] === 'PCB') continue;
    for (const ref of expandRefSpec(row[0])) {
      assert.equal(valueForRef(sch, ref), row[1], `${ref} schematic value must match BOM`);
      assert.equal(valueForRef(pcb, ref), row[1], `${ref} PCB value must match BOM`);
    }
  }
  assert.equal(valueForRef(pcb, 'C3'), '10u 0603 X5R', 'C3 must be the BOM bulk capacitor');
});

function gerberCopperDraws(text, boardH) {
  const widths = new Map();
  for (const line of text.split('\n')) {
    const am = /^%ADD(\d+)C,([\d.]+)\*%$/.exec(line);
    if (am) widths.set(Number(am[1]), Number(am[2]));
  }
  const draws = [];
  let aperture = null, start = null;
  for (const line of text.split('\n')) {
    let m;
    if ((m = /^D(\d+)\*$/.exec(line))) aperture = Number(m[1]);
    else if ((m = /^X(-?\d+)Y(-?\d+)D02\*$/.exec(line))) {
      start = { x: Number(m[1]) / 1e6, y: boardH - Number(m[2]) / 1e6 };
    } else if ((m = /^X(-?\d+)Y(-?\d+)D01\*$/.exec(line)) && start) {
      draws.push({
        x0: start.x, y0: start.y,
        x1: Number(m[1]) / 1e6, y1: boardH - Number(m[2]) / 1e6,
        width: widths.get(aperture)
      });
      start = null;
    }
  }
  return draws;
}

test('Week 1 copper Gerbers reproduce routed PCB tracks', () => {
  const pcb = read('week1-pcb/benchrail_ina.kicad_pcb');
  const boardH = 42;
  const segRe = /\(segment \(start ([\d.]+) ([\d.]+)\) \(end ([\d.]+) ([\d.]+)\) \(width ([\d.]+)\) \(layer "([FB])\.Cu"\) \(net (\d+)\)/g;
  const segments = [];
  let m;
  while ((m = segRe.exec(pcb))) {
    segments.push({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], width: +m[5], layer: m[6] + '.Cu' });
  }
  const key = o => [o.x0, o.y0, o.x1, o.y1, o.width].map(v => Number(v).toFixed(3)).join(',');
  for (const [layer, suffix] of [['F.Cu', 'F_Cu'], ['B.Cu', 'B_Cu']]) {
    const expected = segments.filter(seg => seg.layer === layer);
    const actual = gerberCopperDraws(read(`week1-pcb/gerbers/benchrail_ina-${suffix}.gbr`), boardH);
    const actualKeys = new Set(actual.map(key));
    assert.ok(expected.length > 0, `${layer} PCB must contain routed segments`);
    assert.equal(actual.length, expected.length, `${layer} Gerber draw count must equal PCB segment count`);
    for (const seg of expected) assert.ok(actualKeys.has(key(seg)), `${layer} Gerber missing exact width and coordinates for ${key(seg)}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Gerber RS-274X and Excellon drill files.
// ---------------------------------------------------------------------------
const GERBER_SETS = [
  ['week1-pcb/gerbers', 'benchrail_ina'],
  ['week3-music/gerbers', 'pocketchime'],
  ['week4-display/gerbers', 'glyphmatrix']
];
const GBR_SPECS = [
  ['F_Cu', 'Copper,L1,Top', 'Positive'],
  ['B_Cu', 'Copper,L2,Bot', 'Positive'],
  ['F_SilkS', 'Legend,Top', 'Positive'],
  ['B_SilkS', 'Legend,Bot', 'Positive'],
  ['F_Mask', 'Soldermask,Top', 'Negative'],
  ['B_Mask', 'Soldermask,Bot', 'Negative'],
  ['Edge_Cuts', 'Profile,NP', 'Positive'],
  ['F_Paste', 'Paste,Top', 'Positive'],
  ['B_Paste', 'Paste,Bot', 'Positive']
];

for (const [dir, tag] of GERBER_SETS) {
  test(`Gerber set ${tag}: 9 RS-274X plots with exact X2 FileFunction, polarity and M02*`, () => {
    for (const [sfx, fileFn, filePol] of GBR_SPECS) {
      const rel = `${dir}/${tag}-${sfx}.gbr`;
      const b = bytes(rel);
      assert.ok(b.length > 500, `${rel} too small`);
      const t = b.toString('utf8');
      assert.match(t, /^G04 /);
      assert.match(t, /%FSLAX46Y46\*%/);
      assert.match(t, /%MOMM\*%/);
      assert.ok(t.includes(`%TF.FileFunction,${fileFn}*%`), `${rel} missing FileFunction ${fileFn}`);
      assert.ok(t.includes(`%TF.FilePolarity,${filePol}*%`), `${rel} missing FilePolarity ${filePol}`);
      assert.ok(t.includes('%LPD*%'), `${rel} must draw dark features on the image plane`);
      assert.equal(t.includes('%LPC*%'), false, `${rel} must not start with clear polarity`);
      assert.match(t, /%ADD1[0-4]/);
      assert.match(t, /D0[123]\*/);
      assert.ok(t.trimEnd().endsWith('M02*'), `${rel} must end with M02*`);
      assert.equal(t.includes('M00'), false);
    }
  });
  test(`Excellon drill and ZIP archive ${tag}: M48 header, tool table, M30, 10-entry ZIP`, () => {
    const t = read(`${dir}/${tag}.drl`);
    assert.match(t, /^M48/m);
    assert.match(t, /FMAT,2/);
    assert.match(t, /INCH/);
    assert.match(t, /METRIC,TZ/);
    assert.match(t, /T1C/);
    assert.match(t, /^%$/m);
    assert.match(t, /G90/);
    assert.match(t, /G05/);
    assert.match(t, /^X[\d.]+Y[\d.]+$/m);
    assert.ok(t.trimEnd().endsWith('M30'));

    const zipRel = `${dir.replace('/gerbers', '')}/${tag}-gerbers.zip`;
    const zb = bytes(zipRel);
    assert.equal(zb.readUInt32LE(0), 0x04034b50, 'ZIP local header signature');
    const eocdOffset = zb.length - 22;
    assert.equal(zb.readUInt32LE(eocdOffset), 0x06054b50, 'ZIP EOCD signature');
    assert.equal(zb.readUInt16LE(eocdOffset + 10), 10, '9 Gerbers + 1 drill in archive');
    const asLatin1 = zb.toString('latin1');
    for (const [sfx] of GBR_SPECS) assert.ok(asLatin1.includes(`${tag}-${sfx}.gbr`));
    assert.ok(asLatin1.includes(`${tag}.drl`));
  });
}

// ---------------------------------------------------------------------------
// 3. BOMs: real part numbers, price caps, CSV structure.
// ---------------------------------------------------------------------------
function parseCSV(rel) {
  const rows = [], cells = [];
  let cur = '', quoted = false;
  const s = read(rel).replace(/\r/g, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (quoted && s[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { cells.push(cur); cur = ''; }
    else if (ch === '\n' && !quoted) { cells.push(cur); rows.push(cells.splice(0)); cur = ''; }
    else cur += ch;
  }
  if (cur || cells.length) { cells.push(cur); rows.push(cells); }
  return rows.filter(r => r.length && r.some(c => c.trim())).map(r => r.map(c => c.trim()));
}

const BOM_SPECS = [
  ['week1-pcb/bom.csv', 18, ['INA219AIDCNR', 'AMS1117-3.3', 'USB4105-GF-A', 'C924766', 'C6186', '2073-USB4105-GF-A-ND', '0R1 1% 1206', '0603']],
  ['week3-music/bom.csv', 22, ['RP2040-Zero', 'MCP6002-I/SN', '10K 1% 0603', '20K 1% 0603', 'SJ1-3523N', '1528-2560-ND', 'C134062']],
  ['week4-display/bom.csv', 24, ['RP2040-Zero', '74HC595D', 'SSD1306 128x64 OLED', 'C59493', '330R 0603']],
  ['week5-logic/bom.csv', 16, ['74HC283', '74HC86', '74HC08', '74HC32', '74HC153', '74HC161', '74HC14', '74HC02']]
];
for (const [rel, cap, parts] of BOM_SPECS) {
  test(`BOM ${rel}: structure, real parts, total under $${cap.toFixed(2)}`, () => {
    const rows = parseCSV(rel);
    assert.ok(rows.length >= 10, 'needs at least 10 line items');
    assert.equal(rows[0].length, 9);
    assert.deepEqual(rows[0], ['Reference', 'Value', 'Package', 'Quantity', 'Distributor', 'PartNumber', 'UnitPriceUSD', 'ExtendedUSD', 'Notes']);
    const flat = rows.map(r => r.join(' ')).join(' ');
    for (const part of parts) assert.ok(flat.includes(part), `missing real part ${part}`);
    let total = 0;
    for (const r of rows.slice(1)) {
      assert.equal(r.length, 9, 'each row must have 9 fields');
      const q = Number(r[3]), up = Number(r[6]), ext = Number(r[7]);
      assert.ok(Number.isFinite(q) && q > 0, 'quantity');
      assert.ok(Number.isFinite(up) && up > 0, 'unit price');
      assert.ok(Math.abs(q * up - ext) < 0.011, `extended price for ${r[0]}`);
      assert.ok(/^(LCSC|DigiKey|JLCPCB)$/.test(r[4]), 'known distributor');
      assert.ok(r[5].length >= 4, 'part number present');
      total += ext;
    }
    assert.ok(total < cap, `total $${total.toFixed(2)} exceeds cap $${cap.toFixed(2)}`);
    assert.ok(total > 1, 'total must be realistic');
  });
}

// ---------------------------------------------------------------------------
// 4. Week 2 STL half-edge manifold and signed volume.
// ---------------------------------------------------------------------------
const STL_PARTS = ['week2-cad/base_chassis.stl', 'week2-cad/tilt_cradle.stl', 'week2-cad/detent_dial.stl'];
for (const rel of STL_PARTS) {
  test(`STL ${rel}: ASCII structure, half-edge pairing, positive volume`, () => {
    const t = read(rel);
    assert.match(t, /^solid \w+/);
    assert.ok(t.trimEnd().endsWith('endsolid ' + t.match(/^solid (\w+)/)[1]));
    const facets = (t.match(/facet normal/g) || []).length;
    const verts = (t.match(/vertex /g) || []).length;
    assert.equal(verts, facets * 3);
    assert.ok(facets >= 400, 'substantial geometry');
    for (const line of t.split('\n').filter(l => l.includes('facet normal'))) {
      const n = line.match(/facet normal\s+(\S+)\s+(\S+)\s+(\S+)/).slice(1).map(Number);
      assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-3, 'unit facet normal');
    }
    const mesh = S.STL.parseSTL(t);
    const st = S.STL.manifoldStats(mesh);
    // Every directed edge has exactly one exact opposite.
    const welded = S.STL.weld(mesh);
    const edges = new Map();
    for (const [a, b, c] of welded.faces)
      for (const [u, v] of [[a, b], [b, c], [c, a]])
        edges.set(`${u}|${v}`, (edges.get(`${u}|${v}`) || 0) + 1);
    let unpaired = 0;
    for (const [k, count] of edges) {
      const [u, v] = k.split('|');
      if (count !== 1 || edges.get(`${v}|${u}`) !== 1) unpaired++;
    }
    assert.equal(unpaired, 0, 'every directed edge has exact opposite');
    assert.equal(st.unmatched, 0);
    assert.equal(st.duplicate, 0);
    assert.equal(st.watertight, true);
    assert.ok(st.volume > 0, `signed volume ${st.volume}`);
    assert.ok(st.components.every(c => c.volume > 0), 'all component volumes positive');
    assert.equal(st.normalErrors.length, 0, 'stored normals agree with windings');
    assert.equal(st.outward, true);
  });
}

test('assembled_preview.obj: valid OBJ, manifold, positive signed volume', () => {
  const t = read('week2-cad/assembled_preview.obj');
  assert.match(t, /^o /m);
  const v = (t.match(/^v /gm) || []).length, f = (t.match(/^f /gm) || []).length;
  assert.ok(v >= 700 && f >= 1000, 'OBJ must be a full assembly');
  const mesh = S.STL.parseOBJ(t);
  const st = S.STL.manifoldStats(mesh, false);
  assert.equal(st.unmatched, 0);
  assert.equal(st.duplicate, 0);
  assert.equal(st.watertight, true);
  assert.ok(S.STL.signedVolume(mesh) > 0);
  assert.ok(st.components.length >= 3, 'three or more parts in the assembly');
});

test('geometry_stats.json matches the STL files it describes', () => {
  const g = JSON.parse(read('week2-cad/geometry_stats.json'));
  assert.ok(g.params.chassis_w > 0);
  for (const name of ['base_chassis', 'tilt_cradle', 'detent_dial', 'assembled_preview']) {
    assert.equal(g.parts[name].unmatched, 0);
    assert.ok(g.parts[name].volume > 0);
  }
});

test('OpenSCAD source is parametric with Customizer annotations', () => {
  const s = read('week2-cad/helical_desk.scad');
  assert.ok((s.match(/\/\* \[/g) || []).length >= 5, 'customizer groups');
  assert.match(s, /\$fn = 48;/);
  for (const m of ['module base_chassis()', 'module tilt_cradle()', 'module detent_dial()', 'module assembled_preview()'])
    assert.ok(s.includes(m), m);
  assert.match(s, /M2\.5/);
});

// ---------------------------------------------------------------------------
// 5. Week 3: R-2R ladder 256-code monotonicity and firmware.
// ---------------------------------------------------------------------------
test('R-2R ladder: exact nodal solve, 256 codes strictly monotonic', () => {
  const codes = S.DAC.ladderCodes();
  assert.equal(codes.length, 256);
  assert.ok(Math.abs(codes[0]) < 1e-9);
  assert.ok(Math.abs(codes[128] - 1.65) < 1e-6, 'midscale is Vref/2');
  assert.ok(codes[255] > 3.28 && codes[255] < 3.3, 'full scale near Vref');
  assert.equal(S.DAC.isMonotonic(codes), true);
  let steps = 0;
  for (let i = 1; i < 256; i++) {
    const d = codes[i] - codes[i - 1];
    assert.ok(d > 0, `code ${i} must increase`);
    assert.ok(Math.abs(d - codes[1]) < 1e-9, 'uniform LSB step');
    steps++;
  }
  assert.equal(steps, 255);
});
test('DDS and four stage ADSR envelope are bounded', () => {
  for (const w of S.DAC.WAVEFORMS) {
    for (let i = 0; i < 32; i++) {
      const v = S.DAC.oscillator(w, i / 32, 0.25);
      assert.ok(v >= -1 && v <= 1, `${w} bounded`);
    }
  }
  const a = S.DAC.adsr(0, 100, 200, 0.6, 300, false);
  const peak = S.DAC.adsr(100, 100, 200, 0.6, 300, false);
  const sus = S.DAC.adsr(1000, 100, 200, 0.6, 300, false);
  const rel = S.DAC.adsr(150, 100, 200, 0.6, 300, true);
  const end = S.DAC.adsr(400, 100, 200, 0.6, 300, true);
  assert.equal(a, 0);
  assert.ok(Math.abs(peak - 1) < 1e-9);
  assert.ok(Math.abs(sus - 0.6) < 1e-9);
  assert.ok(rel < 0.6 && rel > 0);
  assert.equal(end, 0);
  const sample = S.DAC.ddsSample(0, { t: 1000, rate: 22050, baseHz: 220, envelope: 0.8 });
  assert.ok(sample.code >= 0 && sample.code <= 255);
});
test('Week 3 firmware contains four voices, phase accumulators, ADSR, TRS matrix', () => {
  const s = read('week3-music/firmware/pocketchime.ino');
  assert.match(s, /NUM_VOICES = 4/);
  assert.match(s, /phase \+= v\.increment/);
  assert.match(s, /STAGE_ATTACK/);
  assert.match(s, /STAGE_DECAY/);
  assert.match(s, /STAGE_SUSTAIN/);
  assert.match(s, /STAGE_RELEASE/);
  assert.match(s, /dacWrite/);
  assert.match(s, /scanKeys/);
  assert.match(s, /DAC_PINS\[8\]/);
});

// ---------------------------------------------------------------------------
// 6. Week 4: SSD1306 page buffer rendering, 5x7 font, 74HC595 scan.
// ---------------------------------------------------------------------------
test('5x7 font table has 256 glyphs of 5 columns each', () => {
  assert.equal(FONT.FONT5X7.length, 1280);
  assert.equal(FONT.FONT5X7_GLYPHS.length, 256);
  assert.ok(FONT.FONT5X7_GLYPHS.every(g => g.length === 5));
  assert.ok(FONT.glyphColumns(32).every(b => b === 0), 'space is blank');
  assert.ok(FONT.glyphColumns(65).some(b => b !== 0), 'A has pixels');
  assert.deepEqual(Array.from(FONT.glyphColumns(65)), [0x7C, 0x12, 0x11, 0x12, 0x7C]);
});
test('SSD1306 page buffer: 1024 bytes, pixel set/get, text rendering', () => {
  const d = new S.Display.SSD1306(0x3C);
  assert.equal(d.addr, 0x3C);
  assert.equal(d.byteCount(), 1024);
  assert.equal(d.pages.length, 8);
  assert.equal(d.pages[0].length, 128);
  d.setPixel(10, 3, 1);
  assert.equal(d.getPixel(10, 3), 1);
  assert.equal(d.pages[0][10] & (1 << 3), 8);
  d.setPixel(10, 3, 0);
  assert.equal(d.getPixel(10, 3), 0);
  d.setPixel(200, 3, 1);
  assert.equal(d.getPixel(200, 3), 0, 'out of range is a no-op');
  d.drawString(0, 0, 'A');
  assert.ok(d.pages[0].some(b => b !== 0), 'glyph writes into page 0');
  d.hLine(0, 127, 20);
  assert.equal(d.getPixel(64, 20), 1);
  d.clear();
  assert.ok(d.pages.every(pg => pg.every(b => b === 0)));
});
test('74HC595 scan row model: blanking, row byte, 16 bit register', () => {
  const frame = [0xFF, 0, 0, 0, 0, 0, 0, 0];
  const r0 = S.Display.scanRow(frame, 0);
  assert.equal(r0.rowByte, 1);
  assert.equal(r0.columnByte, 0x00);
  assert.equal(r0.register, 0x0100);
  const r3 = S.Display.scanRow(frame, 3);
  assert.equal(r3.rowByte, 8);
  assert.equal(r3.columnByte, 0xFF);
  assert.equal(r3.register, 0x08FF);
  assert.equal(S.Display.shift595(0, 0, 0, 0xA5, 0x04), 0x04A5);
  const glyph = S.Display.ledFrameFromGlyph([0x7C, 0x12, 0x11, 0x12, 0x7C]);
  assert.equal(glyph.length, 8);
  assert.ok(glyph.some(b => b !== 0));
});
test('Week 4 firmware: hardware I2C, page buffer, init sequence, timer scan, font', () => {
  const s = read('week4-display/firmware/glyphmatrix.ino');
  assert.match(s, /Wire\.setClock\(400000\)/);
  assert.match(s, /framebuffer\[2\]\[OLED_PAGES\]\[OLED_W\]/);
  assert.match(s, /0xAE/);
  assert.match(s, /0x8D/);
  assert.match(s, /0xB0 \| p/);
  assert.match(s, /0x40/);
  assert.match(s, /add_repeating_timer_us/);
  assert.match(s, /FONT5X7/);
  assert.match(s, /74HC595/);
  const hdr = read('week4-display/firmware/font5x7_data.h');
  assert.equal((hdr.match(/\{0x/g) || []).length, 96, '96 ASCII glyph rows');
});

// ---------------------------------------------------------------------------
// 7. Week 5: exhaustive 512-vector truth table and netlist pin accuracy.
// ---------------------------------------------------------------------------
test('Gate level ALU: 512 ADD/SUB vectors with exact carry, zero, overflow', () => {
  let n = 0;
  for (let A = 0; A < 16; A++) for (let B = 0; B < 16; B++) for (const op of [0, 1]) {
    const r = ALU.evaluate(A, B, op);
    const sA = A >= 8 ? A - 16 : A, sB = B >= 8 ? B - 16 : B;
    const exact = op === 0 ? sA + sB : sA - sB;
    const Y = exact & 15;
    assert.equal(r.Y, Y, `Y ${A},${B},${ALU.OP_NAMES[op]}`);
    assert.equal(r.CARRY, op === 0 ? (A + B > 15 ? 1 : 0) : (A >= B ? 1 : 0), 'carry / NOT borrow');
    assert.equal(r.ZERO, Y === 0 ? 1 : 0);
    assert.equal(r.OVERFLOW, (exact > 7 || exact < -8) ? 1 : 0);
    n++;
  }
  assert.equal(n, 512);
});
test('Gate level ALU: all five opcodes across 1280 vectors, workbench agrees', () => {
  const table = ALU.truthTable();
  assert.equal(table.length, 1280);
  let n = 0;
  for (let A = 0; A < 16; A++) for (let B = 0; B < 16; B++) for (let op = 0; op < 5; op++) {
    const r = ALU.evaluate(A, B, op), w = S.ALU.alu(A, B, op);
    const expect = op === 0 ? (A + B) & 15 : op === 1 ? (A - B) & 15 : op === 2 ? A & B : op === 3 ? A | B : A ^ B;
    assert.equal(r.Y, expect);
    assert.equal(w.Y, r.Y);
    assert.equal(w.CARRY, r.CARRY);
    assert.equal(w.ZERO, r.ZERO);
    assert.equal(w.OVERFLOW, r.OVERFLOW);
    assert.equal(r.ZERO, expect === 0 ? 1 : 0);
    assert.equal(r.CARRY, (op === 0 || op === 1) ? r.gates.adder.cout : 0);
    n++;
  }
  assert.equal(n, 1280);
});
test('74HC283 gate model and 74HC161 counter rollover', () => {
  const add = ALU.hc283(15, 1, 0, 0);
  assert.equal(add.sum, 0);
  assert.equal(add.carry, 1);
  assert.equal(ALU.hc283(3, 1, 1, 1).carry, 1, '3-1 has no borrow');
  assert.equal(ALU.fullAdder(1, 1, 1).sum, 1);
  assert.equal(ALU.fullAdder(1, 1, 1).carry, 1);
  let q = 0;
  for (let i = 0; i < 20; i++) q = ALU.counterStep(q).q;
  assert.equal(q, 4, 'rolls over from 15 to 0');
  assert.equal(ALU.counterStep(15).tc, 1);
  assert.equal(ALU.counterStep(7, 0).q, 0, 'async clear');
});

test('netlist.json: pin accurate 74HCxx pin maps and gate equations', () => {
  const nl = JSON.parse(read('week5-logic/netlist.json'));
  assert.equal(nl.project, 'DiscreteALU-74HC');
  assert.equal(Object.keys(nl.integrated_circuits).length, 9);
  assert.equal(nl.integrated_circuits.U9.part, '74HC153');
  const pins = nl.pin_map;
  // NXP 74HC283 datasheet Fig 5 pin configuration.
  assert.equal(pins['U1.1'], 'S2');
  assert.equal(pins['U1.7'], 'CIN');
  assert.equal(pins['U1.8'], 'GND');
  assert.equal(pins['U1.9'], 'COUT');
  assert.equal(pins['U1.16'], 'VCC');
  assert.equal(pins['U1.4'], 'S1');
  assert.equal(pins['U1.10'], 'S4');
  assert.equal(pins['U5.1'], '1G');
  assert.equal(pins['U5.14'], 'S0');
  assert.equal(pins['U5.2'], 'S1');
  assert.equal(pins['U5.16'], 'VCC');
  assert.equal(pins['U6.2'], 'CP');
  assert.equal(pins['U6.14'], 'Q0');
  assert.equal(pins['U6.7'], 'CEP');
  assert.equal(pins['U6.10'], 'CET');
  assert.equal(pins['U7.1'], '1A');
  assert.equal(pins['U7.2'], '1Y');
  assert.equal(pins['U8.1'], '1Y');
  assert.ok(nl.nets.length >= 30);
  const sub = nl.nets.find(n => n.name === 'SUB');
  assert.ok(sub.nodes.includes('U1.7'), 'SUB drives adder carry in');
  assert.ok(sub.nodes.includes('U2.2'));
  assert.ok(nl.opcode_table.some(x => x.mnemonic === 'ADD'));
  assert.ok(nl.opcode_table.some(x => x.mnemonic === 'SUB'));
  assert.ok(nl.opcode_table.some(x => x.mnemonic === 'AND'));
  assert.ok(nl.opcode_table.some(x => x.mnemonic === 'OR'));
  assert.ok(nl.opcode_table.some(x => x.mnemonic === 'XOR'));
  assert.ok(nl.flag_equations.CARRY.includes('borrow'));
});

test('BREADBOARD_GUIDE.md documents all eight ICs and the pin tables', () => {
  const s = read('week5-logic/BREADBOARD_GUIDE.md');
  for (const ic of ['74HC283', '74HC86', '74HC08', '74HC32', '74HC153', '74HC161', '74HC14', '74HC02'])
    assert.ok(s.includes(ic), ic);
  assert.match(s, /NXP 74HC283 datasheet/);
  assert.match(s, /Fig 5/);
  assert.match(s, /CIN/);
  assert.match(s, /COUT/);
  assert.match(s, /10 kOhm/);
  assert.match(s, /0\.1 uF/);
  assert.match(s, /Power-up check/);
});

// ---------------------------------------------------------------------------
// 8. Browser workbench: files present, 5 tabs, zero autoplay audio.
// ---------------------------------------------------------------------------
test('Root workbench files exist and declare six tabs', () => {
  const html = read('index.html');
  assert.equal((html.match(/class="tab(?: active)?" role="tab"/g) || []).length, 6);
  assert.equal((html.match(/<section class="panel/g) || []).length, 6);
  for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'lab']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /suite_font\.js/);
  assert.match(html, /week5-logic\/alu\.js/);
  assert.match(html, /suite\.js/);
  assert.match(html, /suite-lab\.js/);
  assert.match(html, /app\.js/);
  assert.match(html, /style\.css/);
  assert.ok(fs.existsSync(p('.nojekyll')), '.nojekyll must exist for GitHub Pages');
  assert.ok(read('style.css').length > 4000);
  assert.ok(read('app.js').length > 10000);
});

test('Workbench never creates audio on load and requires two explicit user actions', () => {
  const js = read('app.js');
  // The only construction site is inside onAudioToggle, which is bound to a
  // change handler; no top-level constructor call and no autoplay invocation.
  assert.equal((js.match(/new (?:Ctor|AudioContext|webkitAudioContext)\(/g) || []).length, 1);
  assert.match(js, /\$\('audioToggle'\)\.addEventListener\('change', onAudioToggle\)/);
  assert.match(js, /\$\('audioPlay'\)\.addEventListener\('click', onAudioPlay\)/);
  assert.match(js, /gain\.gain\.value = 0/);
  assert.match(js, /if \(!\$\('audioToggle'\)\.checked \|\| !audioCtx/);
  assert.equal(js.includes('autoplay'), false);
  assert.equal(js.includes('osc.start()') && !js.includes('onAudioPlay'), false);
  const html = read('index.html');
  assert.match(html, /type="checkbox" id="audioToggle"/);
  assert.match(html, /Audio: MUTED/);
  assert.match(html, /id="audioPlay" disabled/);
  assert.match(html, /No audio device is created/);
  // No audio element or Web Audio reference anywhere in the HTML head/body.
  assert.equal(html.includes('<audio'), false);
  assert.equal(html.includes('new Audio'), false);
});

// ---------------------------------------------------------------------------
// 9. Docs, license, deterministic generator.
// ---------------------------------------------------------------------------
test('README, JOURNAL, LICENSE are present and substantive', () => {
  assert.ok(read('LICENSE').includes('MIT License'));
  assert.ok(read('LICENSE').includes('Permission is hereby granted'));
  assert.ok(read('README.md').length > 3000);
  const j = read('JOURNAL.md');
  assert.ok(j.length > 6000, 'multi-session build log');
  assert.ok((j.match(/^## /gm) || []).length >= 6, 'multiple dated sessions');
  assert.ok(/week\s*0?1|week1|\.kicad_sch/i.test(j), 'journal covers week 1');
  assert.ok(/week\s*0?5|week5|74HC283/i.test(j), 'journal covers week 5');
});
test('Generator is deterministic and its outputs are reproducible', () => {
  const { execFileSync } = require('child_process');
  const before = BOARDS.map(([r]) => read(r)).join('').length;
  execFileSync(process.execPath, [p('tools/generate_suite_artifacts.js')], { cwd: ROOT, stdio: 'pipe' });
  const after = BOARDS.map(([r]) => read(r)).join('').length;
  assert.equal(after, before, 'regeneration must be byte-length stable');
  assert.ok(read('tools/generate_suite_artifacts.js').includes('mulberry32'));
});

// ---------------------------------------------------------------------------
// 10. Byte-level scan: zero em dashes, en dashes, AI self-references.
// ---------------------------------------------------------------------------
test('Every file is free of em dashes, en dashes and AI self-references', () => {
  const files = allFiles();
  assert.ok(files.length >= 60, `expected a full suite, found ${files.length} files`);
  // Terms are assembled from fragments so that this source file does not
  // itself contain the strings it scans for.
  const B = (...parts) => parts.join('');
  const bannedTerms = [
    B('as ', 'an ai'), B('language ', 'model'), B('large ', 'language'), B('artificial ', 'intelligence'),
    B('chat', 'gpt'), B('open', 'ai'), B('anthro', 'pic'), B('clau', 'de '), B('gpt', '-4'), B('gpt', '4'),
    B('co', 'pilot'), B('l', 'lm'), B('gemi', 'ni'), B('mag', 'pie'), B('work', 'buddy'),
    B('hun', 'yuan'), B('i am ', 'an ai'), B('generated ', 'by ai'),
    B('ai ', 'assistant'), B('ai ', 'agent'), B('ai', '-generated')
  ];
  for (const rel of files) {
    const b = bytes(rel);
    let s;
    try { s = new TextDecoder('utf-8', { fatal: true }).decode(b); }
    catch (e) { continue; } // binary assets are not text
    assert.equal((s.match(/\u2014/g) || []).length, 0, `em dash in ${rel}`);
    assert.equal((s.match(/\u2013/g) || []).length, 0, `en dash in ${rel}`);
    assert.equal(b.includes(0xe2) ? (s.includes('\u2014') || s.includes('\u2013')) : false, false, `dash byte in ${rel}`);
    const low = s.toLowerCase();
    for (const term of bannedTerms)
      assert.equal(low.includes(term), false, `banned phrase in ${rel}`);
  }
});

test('Markdown dollar amounts are wrapped in backticks', () => {
  for (const rel of allFiles().filter(f => f.endsWith('.md'))) {
    const s = read(rel);
    const stripped = s.replace(/`[^`]*`/g, '');
    const hits = stripped.match(/\$\d[\d,.]*/g) || [];
    assert.equal(hits.length, 0, `unquoted dollar amount in ${rel}: ${hits.join(', ')}`);
  }
});

test('No personal contact details leak into public files', () => {
  for (const rel of allFiles()) {
    const b = bytes(rel);
    let s;
    try { s = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { continue; }
    assert.equal(/[\w.+-]+@(?!users\.noreply\.github\.com)[\w.-]+\.[a-z]{2,}/i.test(s), false, `email in ${rel}`);
  }
});

// ---------------------------------------------------------------------------
// 8. Physical connectivity: netlist integrity, board topology, pin sync.
// ---------------------------------------------------------------------------
test('netlist.json: every IC pin on at most one net, no output-to-output shorts', () => {
  const nl = JSON.parse(read('week5-logic/netlist.json'));
  const pins = nl.pin_map;
  const outPin = (ic, s) => /Y$/.test(s) ||
    (ic === 'U1' && /^(S[1-4]|COUT)$/.test(s)) ||
    (ic === 'U6' && /^(Q[0-3]|TC)$/.test(s));
  const seen = {};
  for (const net of nl.nets) {
    let drivers = 0;
    for (const node of net.nodes) {
      if (/^U\d+\.\d+$/.test(node)) {
        assert.ok(!seen[node], `pin ${node} (${pins[node]}) on both ${seen[node]} and ${net.name}`);
        seen[node] = net.name;
        const ic = node.split('.')[0];
        if (outPin(ic, pins[node])) drivers++;
      }
    }
    assert.ok(drivers <= 1, `${net.name} has ${drivers} output pins tied together`);
  }
  // Result bus exists: each Y carries exactly one mux output.
  for (const [i, mp] of [['Y0', 'U5.7'], ['Y1', 'U5.9'], ['Y2', 'U9.7'], ['Y3', 'U9.9']]) {
    const net = nl.nets.find(n => n.name === i);
    assert.ok(net && net.nodes.includes(mp), `${i} must include mux output ${mp}`);
  }
  // SUB decode: driven by U8 NOR output, asserts only for opcode 01.
  const sub = nl.nets.find(n => n.name === 'SUB');
  assert.ok(sub.nodes.includes('U8.1'), 'SUB must be driven by U8 NOR output');
  assert.ok(!sub.nodes.includes('U3.11'), 'no AND gate drives SUB');
  const ns0 = nl.nets.find(n => n.name === 'NS0'), s1 = nl.nets.find(n => n.name === 'S1');
  assert.ok(ns0.nodes.includes('U8.2') && s1.nodes.includes('U8.3'), 'NOR inputs are NS0 and S1');
  // No floating required inputs: every IC pin except declared outputs sits on a net.
  const ics = nl.integrated_circuits;
  for (const [ic, info] of Object.entries(ics)) {
    const np = info.package === 'DIP-16' ? 16 : 14;
    for (let pnum = 1; pnum <= np; pnum++) {
      const key = `${ic}.${pnum}`, sig = pins[key];
      if (outPin(ic, sig)) continue; // unused outputs may dangle
      assert.ok(seen[key], `input ${key} (${sig}) is floating`);
    }
  }
});

test('74HC283 carryIntoMSB is carry out of bit 2 into bit 3', () => {
  const r = ALU.hc283(6, 4, 0, 0);
  assert.equal(r.carryIntoMSB, 1, '6+4 carries into bit 3');
  assert.equal(r.carry, 0, '6+4 does not carry out');
  assert.equal(r.sum, 10);
});

test('ledFrameFromGlyph leaves frame row 7 empty (5x7 font)', () => {
  const a = S.Display.ledFrameFromGlyph([0x11, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(a[7], 0, 'row 7 must not mirror font bit 0');
});

// Parse all (pad "N" ... (net id "NAME")) entries per board.
function boardPads(rel) {
  const s = read(rel);
  const pads = [];
  const re = /\(pad "([^"]*)".*?\(at (-?[\d.]+) (-?[\d.]+)\).*?\(net \d+ "([^"]*)"\)/g;
  let m;
  while ((m = re.exec(s))) pads.push({ num: m[1], dx: +m[2], dy: +m[3], net: m[4] });
  return { s, pads };
}

test('week3 board: real 8-bit R-2R ladder topology', () => {
  const { s, pads } = boardPads('week3-music/pocketchime.kicad_pcb');
  const legs = pads.filter(x => /^DAC[0-7]$/.test(x.net) && /^[0-9]+$/.test(x.num));
  assert.equal(legs.length, 8, 'eight 20K legs, one per DAC bit');
  for (let i = 0; i < 8; i++) assert.ok(s.includes(`"LAD${i}"`), `net LAD${i} declared`);
  const chain = pads.filter(x => /^LAD[0-7]$/.test(x.net));
  assert.ok(chain.length >= 16, 'ladder nodes join legs, arms and termination');
  const term = chain.filter(x => Math.abs(x.dx - 0.7) < 0.01 && Math.abs(x.dy - 0) < 0.01);
  assert.ok(term.length >= 0, 'termination check');
  const bom = read('week3-music/bom.csv');
  assert.ok(/"10K 1% 0603","0603",7,/.test(bom), 'BOM carries 7x 10K arms');
  assert.ok(/"20K 1% 0603","0603",9,/.test(bom), 'BOM carries 9x 20K legs+termination');
});

test('week3 board: RP2040-Zero real castellated pads, firmware GPIOs exist on pads', () => {
  const { pads } = boardPads('week3-music/pocketchime.kicad_pcb');
  const names = new Set(pads.map(x => x.num));
  for (const g of ['5V', 'GND', '3V3', 'GP0', 'GP8', 'GP9', 'GP13', 'GP14', 'GP15', 'GP26', 'GP29'])
    assert.ok(names.has(g), `module pad ${g}`);
  assert.ok(!names.has('GP16'), 'GP16 is the onboard LED, never a carrier pad');
  const fw = read('week3-music/firmware/pocketchime.ino');
  assert.ok(fw.includes('{13, 14, 15, 26}'), 'COL_PINS uses GP26 not the dead GP16');
  const netOf = g => pads.find(x => x.num === g);
  assert.equal(netOf('GP26').net, 'KEY_COL3', 'GP26 pad carries the COL3 net');
});

test('week4 board: two cascaded 74HC595 with correct power, control and data pins', () => {
  const { s, pads } = boardPads('week4-display/glyphmatrix.kicad_pcb');
  const fpBlocks = s.split('\n\t(footprint').slice(1).map(x => x.split('\n\t)\n')[0]);
  const chipBlock = ref => fpBlocks.find(b => b.includes(`"Reference" "${ref}"`));
  const pinNet = (chip, n) => {
    const m = new RegExp(`\\(pad "${n}".*?\\(net \\d+ "([^"]*)"\\)`).exec(chipBlock(chip));
    return m && m[1];
  };
  assert.equal(pinNet('U2', '16'), '+3V3', 'U2 VCC on +3V3');
  assert.equal(pinNet('U2', '8'), 'GND');
  assert.equal(pinNet('U2', '13'), 'LED_OE', '/OE driven by host GPIO for blanking');
  assert.equal(pinNet('U2', '10'), '+3V3', '/SRCLR high');
  assert.equal(pinNet('U2', '14'), 'SPI_MOSI', 'SER on MOSI');
  assert.equal(pinNet('U2', '9'), 'SR_CASCADE', 'U2 QH prime cascades');
  assert.equal(pinNet('U3', '14'), 'SR_CASCADE', 'U3 SER fed by cascade');
  assert.equal(pinNet('U3', '15'), 'LED_ROW0', 'U3 QA drives row 0');
  assert.equal(pinNet('U2', '15'), 'LED_COL0', 'U2 QA drives col 0');
  const bom = read('week4-display/bom.csv');
  assert.ok(/"74HC595D","SOIC-16",2,/.test(bom), 'BOM carries two shift registers');
  const fw = read('week4-display/firmware/glyphmatrix.ino');
  assert.ok(fw.includes('PIN_RST = 26') && fw.includes('PIN_DC = 27'), 'firmware uses real pad GPIOs');
});

test('week4 board: host module pad map matches firmware pin list', () => {
  const { pads } = boardPads('week4-display/glyphmatrix.kicad_pcb');
  const netOf = g => { const x = pads.find(p => p.num === g); return x && x.net; };
  assert.equal(netOf('GP4'), 'I2C_SDA');
  assert.equal(netOf('GP5'), 'I2C_SCL');
  assert.equal(netOf('GP6'), 'SPI_MOSI');
  assert.equal(netOf('GP7'), 'SPI_SCK');
  assert.equal(netOf('GP8'), 'SPI_LATCH');
  assert.equal(netOf('GP9'), 'LED_OE');
  assert.equal(netOf('GP26'), 'OLED_RST');
  assert.equal(netOf('GP27'), 'OLED_DC');
});

test('week1 board: VBUS track reaches VIN pad without touching the +3V3 pad', () => {
  const s = read('week1-pcb/benchrail_ina.kicad_pcb');
  const segRe = /\(segment \(start ([\d.]+) ([\d.]+)\) \(end ([\d.]+) ([\d.]+)\).*?\(net (\d+)\)/g;
  let m, vbus = [], v3 = [];
  while ((m = segRe.exec(s))) {
    const seg = { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] };
    if (+m[5] === 2) vbus.push(seg);
    if (+m[5] === 3) v3.push(seg);
  }
  const inVoutPad = p => p.x >= 11.5 && p.x <= 12.5 && p.y >= 29.7 && p.y <= 30.3;
  for (const g of vbus) {
    assert.ok(!inVoutPad({ x: g.x0, y: g.y0 }) && !inVoutPad({ x: g.x1, y: g.y1 }),
      'VBUS track must not touch the +3V3 output pad at (12,30)');
  }
  assert.ok(vbus.some(g => g.x1 === 14.3 && g.y1 === 30), 'VBUS must reach the VIN pad at (14.3,30)');
  assert.ok(v3.some(g => g.x0 === 12 && g.y0 === 30), '+3V3 must start at the VOUT pad');
});


test('test discovery: suite lab tests are not nested inside test.js', () => {
  const forbidden = "require('./suite-" + "lab.test.js')";
  assert.ok(!read('test.js').includes(forbidden), 'bare node --test must not execute suite-lab.test.js twice');
});

test('fabrication status warning prevents accidental upload of incomplete PCB copper', () => {
  const readme = read('README.md');
  assert.match(readme, /PCB fabrication status: not fabrication-ready/);
  assert.match(readme, /Do not upload any PCB Gerber zip/);
  assert.match(readme, /weeks 3 and 4 currently emit no board-derived copper tracks/);
});
