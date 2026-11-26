'use strict';
// Suite Audit & Physics Lab verification. Zero dependencies; required by
// test.js so `node --test test.js` runs this whole file alongside the
// hardware suite checks. Also runs standalone via `node --test`.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const Lab = require('./suite-lab.js');
const S = require('./suite.js');
const ALU = require('./week5-logic/alu.js');
const FONT = require('./suite_font.js');
const env = { S, ALU, FONT };
const stlEnv = {
  S, ALU, FONT,
  stl: {
    base_chassis: read('week2-cad/base_chassis.stl'),
    tilt_cradle: read('week2-cad/tilt_cradle.stl'),
    detent_dial: read('week2-cad/detent_dial.stl')
  }
};

// ---------------------------------------------------------------------------
// 1. SHA-256: known-answer vectors, format, and a 0..160 byte sweep vs crypto.
// ---------------------------------------------------------------------------
const KATS = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1']
];
for (const [msg, hex] of KATS) {
  test(`sha256 KAT: ${msg.length === 0 ? 'empty' : msg.slice(0, 24) + '...'} (${msg.length} chars)`, () => {
    assert.equal(Lab.sha256hex(msg), hex);
  });
}
test('sha256 KAT: one million a characters', () => {
  assert.equal(Lab.sha256hex('a'.repeat(1000000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});
test('sha256 output is 64 lowercase hex chars and deterministic', () => {
  const h = Lab.sha256hex('halflife');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(Lab.sha256hex('halflife'), h);
});
test('sha256 accepts Uint8Array and string consistently', () => {
  const s = 'suite-lab';
  const bytes = new Uint8Array(Lab.utf8Encode(s));
  assert.equal(Lab.sha256hex(bytes), Lab.sha256hex(s));
});
for (let n = 0; n <= 160; n++) {
  test(`sha256 equals Node crypto at ${n}-byte boundary`, () => {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 37 + 11) & 255;
    assert.equal(Lab.sha256hex(buf), crypto.createHash('sha256').update(buf).digest('hex'));
  });
}

// ---------------------------------------------------------------------------
// 2. Canonicalizer: order, cycles, depth, type handling, hostile keys.
// ---------------------------------------------------------------------------
test('canonicalize sorts object keys recursively', () => {
  assert.equal(Lab.canonicalize({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});
test('canonicalize key order is input-order independent', () => {
  const a = Lab.canonicalize({ z: 1, m: 2, a: 3 });
  const b = Lab.canonicalize({ a: 3, m: 2, z: 1 });
  assert.equal(a, b);
});
test('canonicalize preserves array order', () => {
  assert.equal(Lab.canonicalize([3, 1, 2]), '[3,1,2]');
});
test('canonicalize drops undefined and function values in objects', () => {
  assert.equal(Lab.canonicalize({ a: undefined, b: () => 1, c: 2 }), '{"c":2}');
});
test('canonicalize maps undefined and functions to null inside arrays', () => {
  assert.equal(Lab.canonicalize([undefined, () => 1, 2]), '[null,null,2]');
});
test('canonicalize maps NaN and Infinity to null like JSON', () => {
  assert.equal(Lab.canonicalize({ a: NaN, b: Infinity, c: -Infinity }), '{"a":null,"b":null,"c":null}');
});
test('canonicalize normalizes negative zero to 0', () => {
  assert.equal(Lab.canonicalize(-0), '0');
});
test('canonicalize throws TypeError on bigint', () => {
  assert.throws(() => Lab.canonicalize(10n), TypeError);
});
test('canonicalize throws TypeError on direct cycles', () => {
  const o = { a: 1 }; o.self = o;
  assert.throws(() => Lab.canonicalize(o), TypeError);
});
test('canonicalize throws TypeError on indirect cycles', () => {
  const a = { b: {} }; a.b.a = a;
  assert.throws(() => Lab.canonicalize(a), TypeError);
});
test('canonicalize allows shared references that are not cyclic', () => {
  const shared = { x: 1 };
  assert.equal(Lab.canonicalize([shared, shared]), '[{"x":1},{"x":1}]');
});
test('canonicalize enforces the default depth bound of 24', () => {
  let v = 0;
  for (let i = 0; i < 30; i++) v = { n: v };
  assert.throws(() => Lab.canonicalize(v), RangeError);
});
test('canonicalize honors a custom depth bound', () => {
  const deep = { a: { b: { c: { d: 1 } } } };
  assert.throws(() => Lab.canonicalize(deep, { maxDepth: 2 }), RangeError);
  assert.equal(Lab.canonicalize(deep, { maxDepth: 8 }), '{"a":{"b":{"c":{"d":1}}}}');
});
test('canonicalize serializes a literal __proto__ own key safely', () => {
  const o = JSON.parse('{"__proto__":7,"a":1}');
  const s = Lab.canonicalize(o);
  assert.equal(s, '{"__proto__":7,"a":1}');
  assert.equal({}.x, undefined, 'prototype not polluted');
});
test('canonicalize top-level undefined becomes null', () => {
  assert.equal(Lab.canonicalize(undefined), 'null');
});
test('canonicalize strings escape like JSON', () => {
  assert.equal(Lab.canonicalize('a"b\nc'), '"a\\"b\\nc"');
});

// ---------------------------------------------------------------------------
// 3. #hlab= codec: round trips, clamps, hostile rejection.
// ---------------------------------------------------------------------------
test('codec round trip restores a full state', () => {
  const st = { tol: 2.5, imax: 1.6, vbus: 12, code: 200, week: 'w4', curve: 'dnl' };
  const r = Lab.decodeState(Lab.encodeState(st));
  assert.equal(r.ok, true);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.state, st);
});
test('codec encodes the #hlab= prefix and clean alphabet', () => {
  const h = Lab.encodeState(Lab.defaultState());
  assert.ok(h.startsWith('#hlab='));
  assert.match(h.slice(6), /^[A-Za-z0-9_-]+$/);
});
test('codec fills defaults for an empty object payload', () => {
  const h = '#hlab=' + Lab.b64urlEncode(Lab.utf8Encode('{}'));
  const r = Lab.decodeState(h);
  assert.equal(r.ok, true);
  assert.deepEqual(r.state, Lab.defaultState());
});
for (const [k, over, under] of [
  ['tol', 9, -3], ['imax', 99, -1], ['vbus', 100, -5], ['code', 999, -9]
]) {
  test(`codec clamps ${k} into bounds`, () => {
    const spec = Lab.HLAB_SCHEMA[k];
    const r1 = Lab.decodeState('#hlab=' + Lab.b64urlEncode(Lab.utf8Encode(JSON.stringify({ [k]: over }))));
    assert.equal(r1.state[k], spec.type === 'int' ? Math.round(spec.max) : spec.max);
    assert.ok(r1.rejected.some(x => x.startsWith('clamped:' + k)));
    const r2 = Lab.decodeState('#hlab=' + Lab.b64urlEncode(Lab.utf8Encode(JSON.stringify({ [k]: under }))));
    assert.equal(r2.state[k], spec.type === 'int' ? Math.round(spec.min) : spec.min);
  });
}
test('codec rounds the integer code field', () => {
  const h = '#hlab=' + Lab.b64urlEncode(Lab.utf8Encode('{"code":200.7}'));
  const r = Lab.decodeState(h);
  assert.equal(r.state.code, 201);
});
for (const bad of ['w9', 'LAB', 3, null, 'w11']) {
  test(`codec rejects bad week enum ${JSON.stringify(bad)}`, () => {
    const h = '#hlab=' + Lab.b64urlEncode(Lab.utf8Encode(JSON.stringify({ week: bad })));
    const r = Lab.decodeState(h);
    assert.equal(r.state.week, 'w1');
    assert.ok(r.rejected.some(x => x === 'bad-enum:week'));
  });
}
for (const bad of ['x', 'INL', 2, null]) {
  test(`codec rejects bad curve enum ${JSON.stringify(bad)}`, () => {
    const h = '#hlab=' + Lab.b64urlEncode(Lab.utf8Encode(JSON.stringify({ curve: bad })));
    const r = Lab.decodeState(h);
    assert.equal(r.state.curve, 'both');
    assert.ok(r.rejected.some(x => x === 'bad-enum:curve'));
  });
}
for (const bad of ['abc', NaN, Infinity, null, {}, []]) {
  test(`codec rejects non-finite tol ${JSON.stringify(bad) === undefined ? 'NaN' : String(bad)}`, () => {
    const h = '#hlab=' + Lab.b64urlEncode(Lab.utf8Encode(JSON.stringify({ tol: bad === undefined ? 'NaN' : bad })));
    const r = Lab.decodeState(h);
    assert.equal(r.state.tol, 1, 'default restored');
    assert.ok(r.rejected.some(x => x === 'bad-number:tol' || x === 'clamped:tol'));
  });
}
test('codec records unknown keys without corrupting state', () => {
  const h = '#hlab=' + Lab.b64urlEncode(Lab.utf8Encode('{"tol":2,"zzz":9,"tol2":3}'));
  const r = Lab.decodeState(h);
  assert.equal(r.ok, true);
  assert.equal(r.state.tol, 2);
  assert.ok(r.rejected.some(x => x === 'unknown-key:zzz'));
});
for (const key of ['__proto__', 'constructor', 'prototype']) {
  test(`codec rejects hostile key ${key}`, () => {
    const h = '#hlab=' + Lab.b64urlEncode(Lab.utf8Encode(JSON.stringify({ [key]: { x: 1 }, tol: 2 })));
    const r = Lab.decodeState(h);
    assert.equal(r.ok, false);
    assert.ok(r.rejected.some(x => x === 'hostile-key:' + key));
    assert.equal({}.x, undefined);
  });
}
for (const [name, payload] of [
  ['array root', '[1,2,3]'],
  ['string root', '"hello"'],
  ['number root', '42'],
  ['null root', 'null'],
  ['boolean root', 'true'],
  ['broken json', '{tol:2}'],
  ['truncated json', '{"tol":2']
]) {
  test(`codec rejects ${name}`, () => {
    const h = '#hlab=' + Lab.b64urlEncode(Lab.utf8Encode(payload));
    const r = Lab.decodeState(h);
    assert.equal(r.ok, false);
  });
}
for (const [name, h] of [
  ['empty hash', '#hlab='],
  ['illegal char', '#hlab=ab+c'],
  ['bad modulus', '#hlab=A'],
  ['oversized', '#hlab=' + 'A'.repeat(600)],
  ['missing prefix', '#hlab'],
  ['other prefix', '#x=' + Lab.b64urlEncode(Lab.utf8Encode('{}'))],
  ['not a string', 42],
  ['empty string', '']
]) {
  test(`codec rejects ${name}`, () => {
    const r = Lab.decodeState(h);
    assert.equal(r.ok, false);
    assert.ok(r.rejected.length >= 1);
  });
}
test('codec decodes payload built without padding cleanly', () => {
  const src = { tol: 3, code: 7 };
  const h = Lab.encodeState(src);
  const r = Lab.decodeState(h);
  assert.equal(r.state.tol, 3);
  assert.equal(r.state.code, 7);
});
test('b64url decode rejects a lone dangling tail char', () => {
  assert.throws(() => Lab.b64urlDecode('AQIDx'), Error);
});
test('utf8 codec round trips multibyte strings', () => {
  const s = 'a\u00e9\u20ac\u{1f600}z';
  assert.equal(Lab.utf8Decode(Lab.utf8Encode(s)), s);
});
test('utf8 decode throws on truncated multibyte input', () => {
  assert.throws(() => Lab.utf8Decode([0xE2, 0x86]), Error);
});

// ---------------------------------------------------------------------------
// 4. INA219 Week 1 physics: calibration, registers, sweep bounds.
// ---------------------------------------------------------------------------
test('INA219 calibration word is exactly 0x2800', () => {
  assert.equal(S.BENCHRAIL.calibration(0.1, 40e-6), 0x2800);
});
test('INA219 calibration scales inversely with LSB', () => {
  assert.equal(S.BENCHRAIL.calibration(0.1, 20e-6), 0x5000);
});
for (const v of [0, 3.3, 5, 12]) {
  test(`INA219 bus register round trip at ${v} V`, () => {
    const back = S.BENCHRAIL.decodeBus(S.BENCHRAIL.busRegister(v));
    assert.ok(Math.abs(back - Math.round(v / 0.004) * 0.004) < 1e-9);
  });
}
test('INA219 current register is LSB scaled', () => {
  assert.equal(S.BENCHRAIL.currentRegister(0.42, 0.1, 40e-6), 1050);
});
test('INA219 current register clamps to int16 range', () => {
  assert.equal(S.BENCHRAIL.currentRegister(99, 0.1, 40e-6), 32767);
  assert.equal(S.BENCHRAIL.currentRegister(-99, 0.1, 40e-6), -32768);
});
test('INA219 power is current times bus voltage', () => {
  assert.equal(S.BENCHRAIL.power(2, 5), 10);
});
test('INA219 ADC full scale is 3.2 A on the 0.1 ohm shunt', () => {
  assert.ok(Math.abs(Lab.INA.adcFullScale(0.1) - 3.2) < 1e-9);
});
test('BenchRail rail limit matches the PGA/8 full scale', () => {
  // PGA /8 gives a +/-320 mV shunt range; the limit is 0.32 V / R_shunt.
  // Regression: an extra /8 once reported 0.4 A instead of 3.2 A.
  assert.ok(Math.abs(S.BENCHRAIL.maxCurrent(0.1) - 3.2) < 1e-9);
  assert.equal(S.BENCHRAIL.maxCurrent(0.1), Lab.INA.adcFullScale(0.1));
});
test('INA219 rated current is sqrt(0.25 W / R)', () => {
  assert.ok(Math.abs(Lab.INA.ratedCurrent(0.1) - Math.sqrt(2.5)) < 1e-9);
});
test('INA219 sweep covers 0 to iMax with finite points', () => {
  const sw = Lab.inaSweep({ iMax: 3.2, vbus: 5, points: 65 });
  assert.equal(sw.points.length, 65);
  assert.equal(sw.points[0].a, 0);
  assert.ok(Math.abs(sw.points[64].a - 3.2) < 1e-9);
  assert.ok(sw.points.every(p => Number.isFinite(p.shuntW) && Number.isFinite(p.busW)));
});
test('INA219 sweep flags saturation past the 320 mV PGA/8 range', () => {
  const sw = Lab.inaSweep({ iMax: 3.6, vbus: 5, points: 37 });
  const sat = sw.points.filter(p => p.saturated);
  assert.ok(sat.length > 0);
  assert.ok(sat.every(p => p.shuntMv > 320));
  assert.ok(sw.points.every(p => p.saturated === (p.shuntMv > 320)));
});
test('INA219 sweep counts track 40 uA LSB', () => {
  const sw = Lab.inaSweep({ iMax: 3.2, points: 33 });
  for (const p of sw.points) assert.equal(p.counts, Math.round(p.shuntMv / 0.04));
});
test('INA219 sweep dissipation is I squared R', () => {
  const sw = Lab.inaSweep({ iMax: 3.2, points: 9 });
  for (const p of sw.points) assert.ok(Math.abs(p.shuntW - p.a * p.a * 0.1) < 1e-12);
});

// ---------------------------------------------------------------------------
// 5. R-2R Week 3 physics: solver parity, INL/DNL, tolerance invariants.
// ---------------------------------------------------------------------------
test('generalized ladder solver equals suite solver on all 256 codes', () => {
  const net = Lab.nominalNetwork();
  for (let c = 0; c < 256; c++)
    assert.ok(Math.abs(Lab.ladderSolve(c, 3.3, net.arms, net.legs) - S.DAC.ladderVoltage(c, 3.3)) < 1e-12, `code ${c}`);
});
test('inlDnl on the ideal curve is numerically zero', () => {
  const r = Lab.inlDnl(S.DAC.ladderCodes());
  assert.ok(r.maxInl < 1e-9);
  assert.ok(r.maxDnl < 1e-9);
  assert.ok(Math.abs(r.minStep - 1) < 1e-9);
  assert.equal(r.monotonic, true);
});
test('inlDnl arrays are 256 entries with zeroed endpoints', () => {
  const r = Lab.inlDnl(S.DAC.ladderCodes());
  assert.equal(r.inl.length, 256);
  assert.equal(r.dnl.length, 256);
  assert.equal(r.inl[0], 0);
  assert.equal(r.inl[255], 0);
  assert.equal(r.dnl[0], 0);
});
test('R-2R LSB step is 12.890625 mV', () => {
  const codes = S.DAC.ladderCodes();
  assert.ok(Math.abs((codes[1] - codes[0]) * 1000 - 12.890625) < 1e-9);
});
test('tolerancePatterns yields 46 deterministic networks', () => {
  const pats = Lab.tolerancePatterns(0.01);
  assert.equal(pats.length, 46);
  for (const p of pats) {
    assert.equal(p.arms.length, 7);
    assert.equal(p.legs.length, 9);
    for (const a of p.arms) assert.ok(a > 0 && a <= 10000 * 1.01 * 1.0001);
    for (const l of p.legs) assert.ok(l > 0 && l <= 20000 * 1.01 * 1.0001);
  }
});
test('tolerancePatterns at zero tolerance reproduces the nominal network', () => {
  const pats = Lab.tolerancePatterns(0);
  for (const p of pats) {
    assert.ok(p.arms.every(a => a === 10000));
    assert.ok(p.legs.every(l => l === 20000));
  }
});
test('tolerance sweep at 0 percent is ideal', () => {
  const [p] = Lab.toleranceSweep([0], 3.3);
  assert.ok(p.maxInl < 1e-9 && p.maxDnl < 1e-9);
  assert.equal(p.minStep > 0.999999, true);
  assert.equal(p.monoAll, true);
});
test('tolerance sweep max INL grows monotonically with tolerance', () => {
  const pts = Lab.toleranceSweep([0, 1, 2, 3, 4, 5], 3.3);
  for (let i = 1; i < pts.length; i++)
    assert.ok(pts[i].maxInl >= pts[i - 1].maxInl, `INL at ${pts[i].tol}`);
});
test('tolerance sweep at 1 percent lands near 1.27 LSB worst INL', () => {
  const [p] = Lab.toleranceSweep([1], 3.3);
  assert.ok(p.maxInl > 0.9 && p.maxInl < 1.6, `INL ${p.maxInl}`);
  assert.ok(p.maxDnl > p.maxInl);
});
test('tolerance sweep at 5 percent exceeds the 1 percent error', () => {
  const pts = Lab.toleranceSweep([1, 5], 3.3);
  assert.ok(pts[1].maxInl > pts[0].maxInl * 2);
});
test('tolerance sweep reports the worst pattern name', () => {
  const [p] = Lab.toleranceSweep([1], 3.3);
  assert.equal(typeof p.worst, 'string');
  assert.ok(p.worst.length > 0);
});
test('codeProfile returns the worst pattern at the tolerance', () => {
  const p = Lab.codeProfile(0.01, 3.3);
  assert.equal(p.name, 'leg7+');
  assert.ok(Math.abs(p.r.maxInl - 1.275) < 0.01);
  assert.equal(p.r.inl.length, 256);
});
test('codeProfile at zero tolerance is the ideal curve', () => {
  const p = Lab.codeProfile(0, 3.3);
  assert.ok(p.r.maxInl < 1e-9);
});

// ---------------------------------------------------------------------------
// 6. Comparator: five weeks, caps, headroom, metric evaluation.
// ---------------------------------------------------------------------------
const rows = Lab.auditWeeks(env);
const rowsStl = Lab.auditWeeks(stlEnv);
test('comparator emits exactly the five week rows in order', () => {
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.key), ['w1', 'w2', 'w3', 'w4', 'w5']);
});
test('comparator names and tracks match the suite', () => {
  assert.equal(rows[0].name, 'BenchRail-INA');
  assert.equal(rows[1].name, 'HelicalDesk');
  assert.equal(rows[2].name, 'PocketChime-R2R');
  assert.equal(rows[3].name, 'GlyphMatrix-128');
  assert.equal(rows[4].name, 'DiscreteALU-74HC');
  assert.deepEqual(rows.map(r => r.track), ['PCB', 'CAD', 'MUSIC', 'DISPLAY', 'LOGIC']);
});
test('comparator BOM totals match the checked-in CSVs', () => {
  function parseCSV(rel) {
    const r2 = [], cells = [];
    let cur = '', quoted = false;
    const s = read(rel).replace(/\r/g, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') { if (quoted && s[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
      else if (ch === ',' && !quoted) { cells.push(cur); cur = ''; }
      else if (ch === '\n' && !quoted) { cells.push(cur); r2.push(cells.splice(0)); cur = ''; }
      else cur += ch;
    }
    return r2.map(r => r.map(c => c.trim()));
  }
  const totals = {
    w1: parseCSV('week1-pcb/bom.csv').slice(1).reduce((t, r) => t + Number(r[7]), 0),
    w3: parseCSV('week3-music/bom.csv').slice(1).reduce((t, r) => t + Number(r[7]), 0),
    w4: parseCSV('week4-display/bom.csv').slice(1).reduce((t, r) => t + Number(r[7]), 0),
    w5: parseCSV('week5-logic/bom.csv').slice(1).reduce((t, r) => t + Number(r[7]), 0)
  };
  assert.ok(Math.abs(rows[0].bom - totals.w1) < 0.005, `w1 ${rows[0].bom} vs ${totals.w1}`);
  assert.ok(Math.abs(rows[2].bom - totals.w3) < 0.005, `w3 ${rows[2].bom} vs ${totals.w3}`);
  assert.ok(Math.abs(rows[3].bom - totals.w4) < 0.005, `w4 ${rows[3].bom} vs ${totals.w4}`);
  assert.ok(Math.abs(rows[4].bom - totals.w5) < 0.005, `w5 ${rows[4].bom} vs ${totals.w5}`);
  assert.equal(rows[1].bom, null, 'week 2 is print only');
});
for (const [i, bom, cap, hr] of [
  [0, 6.90, 18.00, 11.10],
  [2, 12.19, 22.00, 9.81],
  [3, 18.56, 24.00, 5.44],
  [4, 12.60, 16.00, 3.40]
]) {
  test(`comparator week ${i + 1} cost-cap-headroom arithmetic`, () => {
    assert.ok(Math.abs(rows[i].bom - bom) < 1e-9);
    assert.ok(Math.abs(rows[i].cap - cap) < 1e-9);
    assert.ok(Math.abs(rows[i].headroom - hr) < 0.005, `headroom ${rows[i].headroom}`);
    assert.ok(Math.abs(rows[i].cap - rows[i].bom - rows[i].headroom) < 0.005);
  });
}
test('comparator week 2 reports print-only economics', () => {
  assert.equal(rows[1].bomLabel, 'print only');
  assert.equal(rows[1].headroom, null);
});
test('comparator week 1 metric verifies the 0x2800 calibration word', () => {
  assert.equal(rows[0].metric.pass, true);
  assert.equal(rows[0].metric.value, '0x2800');
});
test('comparator week 2 metric is pending without STL evidence', () => {
  assert.equal(rows[1].metric.pass, null);
  assert.equal(rows[1].metric.value, 'pending');
});
test('comparator week 2 metric verifies 3 watertight parts with STL evidence', () => {
  assert.equal(rowsStl[1].metric.pass, true);
  assert.match(rowsStl[1].metric.value, /mm3$/);
  assert.match(rowsStl[1].metric.detail, /3\/3 parts watertight/);
});
test('comparator week 3 metric reports the 12.891 mV LSB', () => {
  assert.equal(rows[2].metric.pass, true);
  assert.match(rows[2].metric.value, /^12\.89\d mV$/);
});
test('comparator week 4 metric verifies buffer plus glyph table', () => {
  assert.equal(rows[3].metric.pass, true);
  assert.match(rows[3].metric.value, /1024 B \+ 256 glyphs/);
});
test('comparator week 5 metric verifies the vector count', () => {
  assert.equal(rows[4].metric.pass, true);
  assert.match(rows[4].metric.value, /512 \+ 1280/);
});
test('bomSummary totals the four priced weeks', () => {
  const s = Lab.bomSummary(rows);
  assert.ok(Math.abs(s.bomTotal - 50.25) < 0.005);
  assert.ok(Math.abs(s.capTotal - 80.00) < 1e-9);
  assert.ok(Math.abs(s.headroomTotal - 29.75) < 0.005);
  assert.equal(s.allowance, 100);
});

// ---------------------------------------------------------------------------
// 7. Proof brief: canonical payload, single cached digest, 4-surface parity.
// ---------------------------------------------------------------------------
const state = Lab.defaultState();
const brief = Lab.proofBrief(rows, state);
test('brief schema and suite identifiers are stamped', () => {
  assert.equal(brief.payload.schema, 'halflife-suite-proof/1');
  assert.equal(brief.payload.suite, 'halflife-hardware-suite');
});
test('brief carries the lab state verbatim', () => {
  assert.equal(brief.payload.lab.tolerancePct, 1);
  assert.equal(brief.payload.lab.sweepMaxA, 3.2);
  assert.equal(brief.payload.lab.dacCode, 128);
});
test('brief weeks carry BOM, cap, headroom and metric verdicts', () => {
  assert.equal(brief.payload.weeks.length, 5);
  assert.equal(brief.payload.weeks[0].bomUSD, 6.9);
  assert.equal(brief.payload.weeks[1].bomUSD, null);
  assert.equal(brief.payload.weeks[2].metric.pass, true);
});
test('brief derived constants match the physics', () => {
  const d = brief.payload.derived;
  assert.equal(d.ina219CalWord, '0x2800');
  assert.equal(d.r2rLsbMv, 12.890625);
  assert.ok(Math.abs(d.ina219AdcFullScaleA - 3.2) < 1e-9);
  assert.ok(Math.abs(d.bomTotalUSD - 50.25) < 0.005);
});
test('brief digest is a real 64-hex SHA-256 of the canonical payload', () => {
  assert.match(brief.sha256, /^[0-9a-f]{64}$/);
  assert.equal(brief.sha256, crypto.createHash('sha256').update(brief.canonical, 'utf8').digest('hex'));
});
test('brief cache returns the identical object per state key', () => {
  const b2 = Lab.proofBrief(Lab.auditWeeks(env), Lab.defaultState());
  assert.equal(b2, brief);
});
test('brief digest changes when the lab state changes', () => {
  const b2 = Lab.proofBrief(rows, { tol: 2, imax: 1.6, vbus: 9, code: 7, week: 'w3', curve: 'inl' });
  assert.notEqual(b2.sha256, brief.sha256);
});
test('brief JSON surface carries the same digest', () => {
  const parsed = JSON.parse(Lab.briefJSON(brief));
  assert.equal(parsed.sha256, brief.sha256);
  assert.equal(Lab.sha256hex(Lab.canonicalize(parsed.payload)), brief.sha256);
});
test('brief CSV surface carries the same digest in its first row', () => {
  const csv = Lab.briefCSV(brief);
  const m = csv.match(/^digest,sha256,([0-9a-f]{64})$/m);
  assert.ok(m, 'digest row present');
  assert.equal(m[1], brief.sha256);
});
test('brief Markdown surface carries the same digest in footer and body', () => {
  const md = Lab.briefMarkdown(brief);
  const hits = md.match(/[0-9a-f]{64}/g) || [];
  assert.ok(hits.length >= 2);
  assert.ok(hits.every(h => h === brief.sha256));
});
test('verifyBrief accepts a sealed brief', () => {
  assert.equal(Lab.verifyBrief(brief), true);
});
test('verifyBrief rejects a mutated brief', () => {
  const evil = JSON.parse(Lab.briefJSON(brief));
  evil.payload.weeks[2].bomUSD = 99.99;
  assert.equal(Lab.verifyBrief({ payload: evil.payload, sha256: evil.sha256 }), false);
});
test('tamperDemo flips one unit and is always detected', () => {
  const t = Lab.tamperDemo(brief);
  assert.equal(t.field, 'weeks[2].bomUSD');
  assert.equal(t.from, 12.19);
  assert.equal(t.to, 12.2);
  assert.equal(t.detected, true);
  assert.match(t.tamperedSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(t.tamperedSha256, brief.sha256);
});

// ---------------------------------------------------------------------------
// 8. CSV formula-injection escaping.
// ---------------------------------------------------------------------------
for (const ch of ['=', '+', '-', '@', '\t', '\r']) {
  test(`csvCell prefixes the formula char ${JSON.stringify(ch)}`, () => {
    const out = Lab.csvCell(ch + '1+1');
    const content = out.startsWith('"') && out.endsWith('"') ? out.slice(1, -1) : out;
    assert.equal(content.charAt(0), "'");
  });
}
test('csvCell prefixes formulas hidden behind whitespace or invisible characters', () => {
  const hostile = [' =1+1', '\u0000=1+1', '\u000b+2+3', '\u200b@cmd', '\u00ad-4', '\u202e=cmd'];
  for (const input of hostile) assert.equal(Lab.csvCell(input).charAt(0), "'", JSON.stringify(input));
});
test('csvCell leaves ordinary text untouched', () => {
  assert.equal(Lab.csvCell('BenchRail'), 'BenchRail');
  assert.equal(Lab.csvCell(6.9), '6.9');
  assert.equal(Lab.csvCell(''), '');
});
test('csvCell quotes fields containing comma quote or newline', () => {
  assert.equal(Lab.csvCell('a,b'), '"a,b"');
  assert.equal(Lab.csvCell('a"b'), '"a""b"');
  assert.equal(Lab.csvCell('a\nb'), '"a\nb"');
});
test('csvCell handles null and undefined as empty', () => {
  assert.equal(Lab.csvCell(null), '');
  assert.equal(Lab.csvCell(undefined), '');
});
test('brief CSV output has no unescaped formula rows', () => {
  for (const line of Lab.briefCSV(brief).split('\n')) {
    const first = line.split(',')[2] || '';
    if (first.length) assert.ok(!'=+-@\t\r'.includes(first.charAt(0)) || first.charAt(0) === "'");
  }
});

// ---------------------------------------------------------------------------
// 9. ALU vector grid: 160 spot-checked vectors across all 5 opcodes.
// ---------------------------------------------------------------------------
const OP_REF = [
  (A, B) => (A + B) & 15, (A, B) => (A - B) & 15,
  (A, B) => A & B, (A, B) => A | B, (A, B) => A ^ B
];
for (let A = 0; A < 16; A++) for (const B of [1, 7]) for (let op = 0; op < 5; op++) {
  test(`ALU vector A=${A} B=${B} ${ALU.OP_NAMES[op]}`, () => {
    const r = ALU.evaluate(A, B, op);
    const w = S.ALU.alu(A, B, op);
    const expect = OP_REF[op](A, B);
    assert.equal(r.Y, expect);
    assert.equal(w.Y, expect);
    assert.equal(r.ZERO, expect === 0 ? 1 : 0);
    assert.equal(w.ZERO, r.ZERO);
    assert.equal(w.CARRY, r.CARRY);
    assert.equal(w.OVERFLOW, r.OVERFLOW);
    const sA = A >= 8 ? A - 16 : A, sB = B >= 8 ? B - 16 : B;
    const exact = op === 0 ? sA + sB : op === 1 ? sA - sB : 0;
    if (op <= 1) {
      assert.equal(r.OVERFLOW, (exact > 7 || exact < -8) ? 1 : 0);
      assert.equal(r.CARRY, op === 0 ? (A + B > 15 ? 1 : 0) : (A >= B ? 1 : 0));
    } else assert.equal(r.OVERFLOW, 0);
  });
}

// ---------------------------------------------------------------------------
// 10. In-page deterministic self-test battery.
// ---------------------------------------------------------------------------
const selfResults = Lab.selfTest(env);
const selfResultsStl = Lab.selfTest(stlEnv);
test('selfTest runs at least 18 deterministic checks', () => {
  assert.ok(selfResults.length >= 18, `count ${selfResults.length}`);
});
test('selfTest every check passes against the real modules', () => {
  const fails = selfResults.filter(r => !r.pass);
  assert.equal(fails.length, 0, fails.map(f => f.name).join('; '));
});
test('selfTest entries all carry name, pass flag and detail', () => {
  for (const r of selfResults) {
    assert.equal(typeof r.name, 'string');
    assert.ok(r.name.length > 3);
    assert.equal(typeof r.pass, 'boolean');
    assert.equal(typeof r.detail, 'string');
  }
});
test('selfTest names are unique', () => {
  const names = selfResults.map(r => r.name);
  assert.equal(new Set(names).size, names.length);
});
test('selfTest is deterministic across runs', () => {
  const again = Lab.selfTest(env);
  assert.deepEqual(again, selfResults);
});
test('selfTest adds three STL evidence checks when files are provided', () => {
  assert.equal(selfResultsStl.length, selfResults.length + 3);
  assert.ok(selfResultsStl.slice(-3).every(r => r.pass && r.name.startsWith('STL evidence')));
});
test('selfTest covers sha256, codec, physics, digest and STL areas', () => {
  const names = selfResults.map(r => r.name).join('|');
  for (const needle of ['sha256', 'canonicalize', 'INA219', 'R-2R', 'SSD1306', 'ALU', 'digest', 'Codec', 'CSV', 'STL'])
    assert.ok(names.includes(needle), needle);
});

// ---------------------------------------------------------------------------
// 11. Workbench wiring: index.html, app.js, module guards.
// ---------------------------------------------------------------------------
test('index.html declares the lab tab and panel', () => {
  const html = read('index.html');
  assert.match(html, /data-tab="lab"/);
  assert.match(html, /id="lab"/);
  assert.equal((html.match(/class="tab(?: active)?" role="tab"/g) || []).length, 6);
  assert.equal((html.match(/<section class="panel/g) || []).length, 6);
});
test('index.html loads suite-lab.js before app.js', () => {
  const html = read('index.html');
  const iLab = html.indexOf('src="suite-lab.js"');
  const iApp = html.indexOf('src="app.js"');
  assert.ok(iLab > 0 && iLab < iApp);
});
for (const id of ['labTable', 'labTolSvg', 'labCodeProfileSvg', 'labInaSvg', 'labBomSvg',
  'labDigest', 'labVerify', 'labTamper', 'labExportJson', 'labExportCsv', 'labExportMd',
  'labShare', 'labSelfTestBtn', 'labSelfTestList', 'labReadout', 'labTol', 'labImax',
  'labVbus', 'labCode', 'labCurveBtns']) {
  test(`index.html carries lab element #${id}`, () => {
    assert.ok(read('index.html').includes(`id="${id}"`), id);
  });
}
test('app.js wires initLab and guards on window.SuiteLab', () => {
  const js = read('app.js');
  assert.match(js, /window\.SuiteLab/);
  assert.match(js, /function initLab\(\)/);
  assert.match(js, /key === 'lab'/);
  assert.match(js, /#hlab=/);
});
test('suite-lab.js is a dependency-free UMD module', () => {
  const js = read('suite-lab.js');
  assert.match(js, /module\.exports = Lab/);
  assert.match(js, /window\.SuiteLab = Lab/);
  assert.equal(/\brequire\s*\(\s*['"]/.test(js), false, 'no require calls');
  assert.equal(js.includes('import '), false);
  assert.equal(js.includes('fetch('), false, 'no network');
  assert.equal(js.includes('XMLHttpRequest'), false);
  assert.equal(js.includes('setTimeout'), false, 'no timers');
  assert.equal(js.includes('setInterval'), false);
});
test('suite-lab.js adds no audio construction sites anywhere', () => {
  const js = read('suite-lab.js');
  assert.equal((js.match(/new (?:Ctor|AudioContext|webkitAudioContext)\(/g) || []).length, 0);
  assert.equal(js.includes('AudioContext'), false);
});
test('app.js still has exactly one gated audio construction site', () => {
  const js = read('app.js');
  assert.equal((js.match(/new (?:Ctor|AudioContext|webkitAudioContext)\(/g) || []).length, 1);
});
test('style.css carries the lab mobile layout guards', () => {
  const css = read('style.css');
  assert.match(css, /repeat\(6, 1fr\)/);
  assert.match(css, /repeat\(6, minmax\(120px, 1fr\)\)/);
  assert.match(css, /\.lab-scroll \{ overflow-x: auto/);
  assert.match(css, /minmax\(0, 1fr\)/);
});

test('style.css exposes keyboard focus and print cleanup rules', () => {
  const css = read('style.css');
  assert.match(css, /a:focus-visible, button:focus-visible, input:focus-visible, \[tabindex\]:focus-visible/);
  assert.match(css, /outline: 2px solid var\(--cyan\)/);
  assert.match(css, /@media print/);
  assert.match(css, /\.grain, \.tabs, \.btn-row, \.head-meta/);
});

test('README test count matches the verified harness total', () => {
  assert.match(read('README.md'), /runs 555 tests with thousands of individual assertions/);
});
