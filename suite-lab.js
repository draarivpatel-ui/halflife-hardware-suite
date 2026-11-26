'use strict';
// Suite Audit & Physics Lab core. Zero dependencies, Node and browser compatible.
// Pure deterministic module: no timers, no network, no audio, no DOM access.
// Loaded by index.html before app.js; the workbench degrades gracefully when
// this file is absent. Same code path runs under Node require and vm realms.

(function (root) {
  const Lab = {};

  // -------------------------------------------------------------------------
  // FIPS 180-4 SHA-256, pure JS over a byte array. Accepts a string (UTF-8
  // encoded), a byte array, or a Uint8Array. Returns 64 lowercase hex chars.
  // -------------------------------------------------------------------------
  const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function utf8Encode(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let cp = str.charCodeAt(i);
      if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < str.length) {
        const lo = str.charCodeAt(i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); i++; }
      }
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return out;
  }

  function utf8Decode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b < 0x80) { out += String.fromCharCode(b); continue; }
      if (b < 0xC2) throw new Error('invalid utf-8 lead byte');
      if (b < 0xE0) {
        if (i + 1 >= bytes.length || (bytes[i + 1] & 0xC0) !== 0x80) throw new Error('invalid utf-8');
        out += String.fromCharCode(((b & 31) << 6) | (bytes[++i] & 63));
        continue;
      }
      if (b < 0xF0) {
        if (i + 2 >= bytes.length) throw new Error('invalid utf-8');
        const b2 = bytes[i + 1], b3 = bytes[i + 2];
        if ((b2 & 0xC0) !== 0x80 || (b3 & 0xC0) !== 0x80) throw new Error('invalid utf-8');
        const cp = ((b & 15) << 12) | ((b2 & 63) << 6) | (b3 & 63);
        if (cp < 0x800) throw new Error('overlong utf-8');
        out += String.fromCharCode(cp); i += 2;
        continue;
      }
      if (b < 0xF5) {
        if (i + 3 >= bytes.length) throw new Error('invalid utf-8');
        const b2 = bytes[i + 1], b3 = bytes[i + 2], b4 = bytes[i + 3];
        if ((b2 & 0xC0) !== 0x80 || (b3 & 0xC0) !== 0x80 || (b4 & 0xC0) !== 0x80) throw new Error('invalid utf-8');
        const cp = ((b & 7) << 18) | ((b2 & 63) << 12) | ((b3 & 63) << 6) | (b4 & 63);
        if (cp < 0x10000 || cp > 0x10FFFF) throw new Error('invalid utf-8 codepoint');
        const c = cp - 0x10000;
        out += String.fromCharCode(0xD800 + (c >> 10), 0xDC00 + (c & 1023)); i += 3;
        continue;
      }
      throw new Error('invalid utf-8 lead byte');
    }
    return out;
  }

  function sha256hex(input) {
    let bytes;
    if (typeof input === 'string') bytes = utf8Encode(input);
    else if (input instanceof Uint8Array) bytes = Array.from(input);
    else if (Array.isArray(input)) bytes = input.slice();
    else throw new TypeError('sha256 input must be a string or byte array');
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    // 64-bit big-endian length, high word first.
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
    bytes.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < bytes.length; off += 64) {
      for (let t = 0; t < 16; t++)
        w[t] = (bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) | (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3];
      for (let t = 16; t < 64; t++) {
        const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K256[t] + w[t]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map(x => x.toString(16).padStart(8, '0')).join('');
  }

  Lab.sha256hex = sha256hex;
  Lab.utf8Encode = utf8Encode;
  Lab.utf8Decode = utf8Decode;

  // -------------------------------------------------------------------------
  // Canonical JSON serializer. Deterministic key order, cycle detection, and a
  // bounded depth so hostile structures fail instead of blowing the stack.
  // -------------------------------------------------------------------------
  function canonicalize(value, opts) {
    const maxDepth = (opts && opts.maxDepth) || 24;
    const stack = new Set();
    function num(n) {
      if (!Number.isFinite(n)) return 'null';
      if (Object.is(n, -0)) return '0';
      return JSON.stringify(n);
    }
    function ser(v, depth) {
      if (v === null) return 'null';
      const t = typeof v;
      if (t === 'number') return num(v);
      if (t === 'boolean') return v ? 'true' : 'false';
      if (t === 'string') return JSON.stringify(v);
      if (t === 'bigint') throw new TypeError('cannot canonicalize bigint');
      if (t === 'function' || t === 'undefined' || t === 'symbol') return undefined;
      if (t !== 'object') throw new TypeError('cannot canonicalize ' + t);
      if (depth > maxDepth) throw new RangeError('canonicalize depth bound exceeded');
      if (stack.has(v)) throw new TypeError('canonicalize cyclic value');
      stack.add(v);
      try {
        if (Array.isArray(v)) {
          const parts = new Array(v.length);
          for (let i = 0; i < v.length; i++) {
            const p = ser(v[i], depth + 1);
            parts[i] = p === undefined ? 'null' : p;
          }
          return '[' + parts.join(',') + ']';
        }
        const keys = Object.keys(v).sort();
        const parts = [];
        for (const k of keys) {
          if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
          const p = ser(v[k], depth + 1);
          if (p === undefined) continue;
          parts.push(JSON.stringify(k) + ':' + p);
        }
        return '{' + parts.join(',') + '}';
      } finally { stack.delete(v); }
    }
    const out = ser(value, 0);
    if (out === undefined) return 'null';
    return out;
  }
  Lab.canonicalize = canonicalize;

  // -------------------------------------------------------------------------
  // Base64url and fail-closed #hlab= state codec. Strict alphabet, strict
  // UTF-8, whitelist schema with hasOwnProperty guards and bounds clamping.
  // -------------------------------------------------------------------------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function b64urlEncode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : -1, b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
      s += B64[b0 >> 2];
      s += B64[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)];
      s += b1 < 0 ? '' : B64[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)];
      s += b2 < 0 ? '' : B64[b2 & 63];
    }
    return s;
  }
  const B64IDX = (() => { const m = new Map(); for (let i = 0; i < 64; i++) m.set(B64[i], i); return m; })();
  function b64urlDecode(s) {
    if (typeof s !== 'string' || s.length === 0 || s.length % 4 === 1) throw new Error('bad base64url length');
    const out = [];
    for (let i = 0; i < s.length; i += 4) {
      const c = [0, 1, 2, 3].map(j => {
        const ch = s[i + j];
        if (ch === undefined) return -1;
        if (!B64IDX.has(ch)) throw new Error('bad base64url char');
        return B64IDX.get(ch);
      });
      if (c[0] < 0 || c[1] < 0) throw new Error('bad base64url tail');
      out.push((c[0] << 2) | (c[1] >> 4));
      if (c[2] >= 0) {
        out.push(((c[1] & 15) << 4) | (c[2] >> 2));
        if (c[3] >= 0) out.push(((c[2] & 3) << 6) | c[3]);
      } else if (c[3] >= 0) throw new Error('bad base64url tail');
    }
    return out;
  }
  Lab.b64urlEncode = b64urlEncode;
  Lab.b64urlDecode = b64urlDecode;

  // Whitelisted lab state schema: names, types, bounds, defaults.
  const HLAB_SCHEMA = {
    tol:   { type: 'num', min: 0, max: 5, def: 1 },
    imax:  { type: 'num', min: 0.1, max: 3.2, def: 3.2 },
    vbus:  { type: 'num', min: 0, max: 32, def: 5 },
    code:  { type: 'int', min: 0, max: 255, def: 128 },
    week:  { type: 'enum', vals: ['w1', 'w2', 'w3', 'w4', 'w5'], def: 'w1' },
    curve: { type: 'enum', vals: ['inl', 'dnl', 'both'], def: 'both' }
  };
  const HOSTILE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  function defaultState() {
    const s = {};
    for (const [k, spec] of Object.entries(HLAB_SCHEMA)) s[k] = spec.def;
    return s;
  }

  function sanitizeState(obj) {
    const rejected = [];
    const state = defaultState();
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { state, rejected: ['root-not-object'], hostile: false };
    }
    let hostile = false;
    for (const k of Object.keys(obj)) {
      if (HOSTILE_KEYS.has(k)) { hostile = true; rejected.push('hostile-key:' + k); }
      else if (!Object.prototype.hasOwnProperty.call(HLAB_SCHEMA, k)) rejected.push('unknown-key:' + k);
    }
    if (hostile) return { state: defaultState(), rejected, hostile: true };
    for (const [k, spec] of Object.entries(HLAB_SCHEMA)) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      const v = obj[k];
      if (spec.type === 'num' || spec.type === 'int') {
        const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
        if (!Number.isFinite(n)) { rejected.push('bad-number:' + k); continue; }
        let c = Math.min(spec.max, Math.max(spec.min, n));
        if (spec.type === 'int') c = Math.round(c);
        if (c !== v) rejected.push('clamped:' + k);
        state[k] = c;
      } else if (spec.type === 'enum') {
        if (spec.vals.indexOf(v) >= 0) state[k] = v;
        else rejected.push('bad-enum:' + k);
      }
    }
    return { state, rejected, hostile: false };
  }

  function encodeState(state) {
    const clean = defaultState();
    if (state && typeof state === 'object') {
      for (const k of Object.keys(HLAB_SCHEMA)) {
        if (Object.prototype.hasOwnProperty.call(state, k)) clean[k] = state[k];
      }
    }
    const s = sanitizeState(clean).state;
    return '#hlab=' + b64urlEncode(utf8Encode(canonicalize(s)));
  }

  function decodeState(hash) {
    if (typeof hash !== 'string') return { ok: false, state: defaultState(), rejected: ['not-a-string'] };
    const h = hash.charAt(0) === '#' ? hash : '#' + hash;
    if (!h.startsWith('#hlab=')) return { ok: false, state: defaultState(), rejected: ['missing-prefix'] };
    const b64 = h.slice(6);
    if (b64.length === 0 || b64.length > 512 || !/^[A-Za-z0-9_-]+$/.test(b64))
      return { ok: false, state: defaultState(), rejected: ['bad-base64url'] };
    let parsed;
    try {
      const text = utf8Decode(b64urlDecode(b64));
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, state: defaultState(), rejected: ['bad-payload'] };
    }
    const r = sanitizeState(parsed);
    if (r.hostile) return { ok: false, state: r.state, rejected: r.rejected };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { ok: false, state: r.state, rejected: r.rejected.concat(['root-not-object']) };
    return { ok: true, state: r.state, rejected: r.rejected };
  }

  Lab.HLAB_SCHEMA = HLAB_SCHEMA;
  Lab.defaultState = defaultState;
  Lab.sanitizeState = sanitizeState;
  Lab.encodeState = encodeState;
  Lab.decodeState = decodeState;

  // -------------------------------------------------------------------------
  // Week 3 physics: generalized R-2R nodal solve plus tolerance mismatch
  // profiles. arms[0..6] join nodes k and k+1, legs[0..7] feed the bit
  // voltages, legs[8] is the node-0 termination to GND.
  // -------------------------------------------------------------------------
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

  function ladderSolve(code, vref, arms, legs) {
    const n = 8;
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    const b = new Array(n).fill(0);
    for (let k = 0; k < n; k++) {
      let diag = 1 / legs[k];
      b[k] = ((code >> k) & 1) ? vref / legs[k] : 0;
      if (k > 0) { diag += 1 / arms[k - 1]; A[k][k - 1] = -1 / arms[k - 1]; }
      if (k < n - 1) { diag += 1 / arms[k]; A[k][k + 1] = -1 / arms[k]; }
      if (k === 0) diag += 1 / legs[8];
      A[k][k] = diag;
    }
    return solveLinear(A, b)[n - 1];
  }

  function ladderCodesCustom(vref, arms, legs) {
    const out = new Array(256);
    for (let c = 0; c < 256; c++) out[c] = ladderSolve(c, vref, arms, legs);
    return out;
  }

  // Endpoint-referenced INL/DNL in LSB units for a 256-code transfer curve.
  function inlDnl(volts) {
    const lsb = (volts[255] - volts[0]) / 255;
    const inl = new Array(256), dnl = new Array(256);
    let maxInl = 0, maxDnl = 0, minStep = Infinity, maxInlCode = 0, maxDnlCode = 0;
    for (let c = 0; c < 256; c++) {
      const ideal = volts[0] + c * lsb;
      inl[c] = (volts[c] - ideal) / lsb;
      if (Math.abs(inl[c]) > maxInl) { maxInl = Math.abs(inl[c]); maxInlCode = c; }
      if (c === 0) { dnl[c] = 0; continue; }
      const step = (volts[c] - volts[c - 1]) / lsb;
      dnl[c] = step - 1;
      if (step < minStep) minStep = step;
      if (Math.abs(dnl[c]) > maxDnl) { maxDnl = Math.abs(dnl[c]); maxDnlCode = c; }
    }
    return { inl, dnl, lsb, maxInl, maxDnl, maxInlCode, maxDnlCode, minStep, monotonic: minStep > 0 };
  }

  // Deterministic resistor multiplier profiles for a worst-case tolerance
  // sweep. mult = 1 + tol * s where s in [-1, 1]. Covers uniform, opposing,
  // alternating, single-element stress, and seeded pseudo-random spreads.
  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function tolerancePatterns(tol) {
    const t = tol;
    const pats = [];
    // Each entry carries real resistances: nominal value times (1 + tol * s).
    const mk = (name, armS, legS) => pats.push({
      name,
      arms: Array.from({ length: 7 }, (_, j) => 10000 * (1 + t * armS(j))),
      legs: Array.from({ length: 9 }, (_, k) => 20000 * (1 + t * legS(k)))
    });
    mk('uniform+', () => 1, () => 1);
    mk('uniform-', () => -1, () => -1);
    mk('legsUp', () => -1, () => 1);
    mk('legsDown', () => 1, () => -1);
    mk('alternate', j => (j % 2 ? 1 : -1), k => (k % 2 ? -1 : 1));
    mk('alternate2', j => (j % 2 ? -1 : 1), k => (k % 2 ? 1 : -1));
    for (let k = 0; k < 9; k++) {
      mk('leg' + k + '+', () => -1, j => (j === k ? 1 : -1));
      mk('leg' + k + '-', () => 1, j => (j === k ? -1 : 1));
    }
    for (let j = 0; j < 7; j++) {
      mk('arm' + j + '+', i => (i === j ? 1 : -1), () => -1);
      mk('arm' + j + '-', i => (i === j ? -1 : 1), () => 1);
    }
    for (let s = 0; s < 8; s++) {
      const rng = mulberry(0x9e3779b9 ^ (s * 0x85ebca6b));
      const legS = Array.from({ length: 9 }, () => rng() * 2 - 1);
      const armS = Array.from({ length: 7 }, () => rng() * 2 - 1);
      mk('seed' + s, j => armS[j], k => legS[k]);
    }
    return pats;
  }

  function nominalNetwork() {
    return { arms: new Array(7).fill(10000), legs: new Array(9).fill(20000) };
  }

  // Worst-case INL/DNL across every deterministic pattern at one tolerance.
  function tolerancePoint(tolFrac, vref) {
    const pats = tolerancePatterns(tolFrac);
    let maxInl = 0, maxDnl = 0, minStep = Infinity, worst = '', monoCount = 0;
    for (const p of pats) {
      const volts = ladderCodesCustom(vref, p.arms, p.legs);
      const r = inlDnl(volts);
      if (r.maxInl > maxInl) { maxInl = r.maxInl; worst = p.name; }
      if (r.maxDnl > maxDnl) maxDnl = r.maxDnl;
      if (r.minStep < minStep) minStep = r.minStep;
      if (r.monotonic) monoCount++;
    }
    return { tol: tolFrac, maxInl, maxDnl, minStep, worst, patterns: pats.length, monoCount, monoAll: monoCount === pats.length };
  }

  function toleranceSweep(tolPercents, vref) {
    const v = vref || 3.3;
    return tolPercents.map(tp => tolerancePoint(tp / 100, v));
  }

  // Per-code INL profile for the worst pattern at a given tolerance.
  function codeProfile(tolFrac, vref) {
    const pats = tolerancePatterns(tolFrac);
    let best = null, bestInl = -1;
    for (const p of pats) {
      const volts = ladderCodesCustom(vref, p.arms, p.legs);
      const r = inlDnl(volts);
      if (r.maxInl > bestInl) { bestInl = r.maxInl; best = { name: p.name, volts, r }; }
    }
    return best;
  }

  Lab.ladderSolve = ladderSolve;
  Lab.ladderCodesCustom = ladderCodesCustom;
  Lab.inlDnl = inlDnl;
  Lab.tolerancePatterns = tolerancePatterns;
  Lab.tolerancePoint = tolerancePoint;
  Lab.toleranceSweep = toleranceSweep;
  Lab.codeProfile = codeProfile;
  Lab.nominalNetwork = nominalNetwork;

  // -------------------------------------------------------------------------
  // Week 1 physics: INA219 shunt sweep helpers. PGA/8 full-scale shunt range
  // is +/-320 mV, so the ADC saturates at 3.2 A on the 0.1 ohm 1206 shunt.
  // The 0.25 W package rating limits continuous current near 1.58 A.
  // -------------------------------------------------------------------------
  const INA = {
    shunt: 0.1,
    currentLSB: 40e-6,
    busLSB: 0.004,
    pga8Range: 0.32,
    shuntPowerW: 0.25,
    adcFullScale(shunt) { return this.pga8Range / shunt; },
    ratedCurrent(shunt) { return Math.sqrt(this.shuntPowerW / shunt); }
  };

  function inaSweep(opts) {
    const o = opts || {};
    const shunt = o.shunt || INA.shunt;
    const vbus = o.vbus === undefined ? 5 : o.vbus;
    const iMax = o.iMax || INA.adcFullScale(shunt);
    const n = o.points || 65;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = iMax * i / (n - 1);
      const shuntV = a * shunt;
      pts.push({
        a,
        shuntMv: shuntV * 1000,
        shuntW: a * a * shunt,
        busW: a * vbus,
        counts: Math.round(shuntV / INA.currentLSB),
        saturated: shuntV > INA.pga8Range
      });
    }
    return {
      points: pts, shunt, vbus, iMax,
      adcFs: INA.adcFullScale(shunt),
      ratedA: INA.ratedCurrent(shunt),
      maxShuntW: iMax * iMax * shunt,
      maxBusW: iMax * vbus
    };
  }
  Lab.INA = INA;
  Lab.inaSweep = inaSweep;

  // -------------------------------------------------------------------------
  // Five-week comparator. BOM totals are verified against the checked-in CSVs
  // by the Node test suite; week 2 is a print-only track with no priced BOM.
  // Caps are the internal per-week budgets from the README and test.js.
  // -------------------------------------------------------------------------
  const WEEKS = [
    { key: 'w1', name: 'BenchRail-INA', track: 'PCB', desc: 'USB-C dual-rail INA219 monitor', bom: 6.90, cap: 18.00 },
    { key: 'w2', name: 'HelicalDesk', track: 'CAD', desc: '3-stage snap-fit printed stand', bom: null, cap: null },
    { key: 'w3', name: 'PocketChime-R2R', track: 'MUSIC', desc: '8-bit R-2R ladder synth', bom: 12.19, cap: 22.00 },
    { key: 'w4', name: 'GlyphMatrix-128', track: 'DISPLAY', desc: 'Dual SSD1306 + 74HC595 badge', bom: 18.56, cap: 24.00 },
    { key: 'w5', name: 'DiscreteALU-74HC', track: 'LOGIC', desc: '4-bit 74HCxx gate-level ALU', bom: 12.60, cap: 16.00 }
  ];
  const PROGRAM_ALLOWANCE = 100;

  function round6(x) { return Math.round(x * 1e6) / 1e6; }
  function money(x) { return x === null || x === undefined ? null : round6(x); }

  // env = { S: HalfLifeSuite, ALU: DiscreteALU api, FONT: font module, stl: {name: text} }
  function evalWeekMetric(key, env) {
    const S = env && env.S;
    if (key === 'w1') {
      const M = S.BENCHRAIL;
      const cal = M.calibration(0.1, 40e-6);
      const pass = cal === 0x2800;
      return {
        label: 'INA219 calibration word',
        value: '0x' + cal.toString(16).toUpperCase().padStart(4, '0'),
        detail: '0.1 ohm shunt, 40 uA LSB, PGA/8',
        pass
      };
    }
    if (key === 'w2') {
      const stl = env && env.stl;
      const names = ['base_chassis', 'tilt_cradle', 'detent_dial'];
      if (!stl || !names.every(n => typeof stl[n] === 'string' && stl[n].length > 0))
        return { label: 'STL manifold audit', value: 'pending', detail: 'STL evidence not loaded', pass: null };
      let vol = 0, watertight = 0;
      for (const n of names) {
        const st = S.STL.manifoldStats(S.STL.parseSTL(stl[n]));
        if (st.watertight && st.volume > 0 && st.outward) watertight++;
        vol += st.volume;
      }
      return {
        label: '3-part watertight manifold volume',
        value: round6(vol).toFixed(1) + ' mm3',
        detail: watertight + '/3 parts watertight, outward normals',
        pass: watertight === 3
      };
    }
    if (key === 'w3') {
      const codes = S.DAC.ladderCodes();
      const lsb = codes[1] - codes[0];
      const mono = S.DAC.isMonotonic(codes);
      const r = inlDnl(codes);
      const pass = mono && codes.length === 256 && Math.abs(lsb - 0.012890625) < 1e-9;
      return {
        label: 'R-2R ladder LSB step',
        value: (lsb * 1000).toFixed(3) + ' mV',
        detail: '256 codes, max INL ' + r.maxInl.toExponential(1) + ' LSB, monotonic',
        pass
      };
    }
    if (key === 'w4') {
      const d = new S.Display.SSD1306(0x3C);
      const glyphs = env.FONT && env.FONT.FONT5X7_GLYPHS ? env.FONT.FONT5X7_GLYPHS.length : 0;
      const pass = d.byteCount() === 1024 && glyphs === 256;
      return {
        label: 'SSD1306 page buffer + font',
        value: '1024 B + ' + glyphs + ' glyphs',
        detail: '8 pages x 128 B, 74HC595 scan duty 12.5%',
        pass
      };
    }
    // w5
    const ALU = env && env.ALU;
    if (!ALU) return { label: 'ALU vectors', value: 'pending', detail: 'evaluator missing', pass: null };
    let fails = 0, n = 0;
    for (let A = 0; A < 16; A++) for (let B = 0; B < 16; B++) for (const op of [0, 1]) {
      const r = ALU.evaluate(A, B, op);
      const sA = A >= 8 ? A - 16 : A, sB = B >= 8 ? B - 16 : B;
      const exact = op === 0 ? sA + sB : sA - sB;
      if (r.Y !== (exact & 15) || r.CARRY !== (op === 0 ? (A + B > 15 ? 1 : 0) : (A >= B ? 1 : 0)) ||
          r.ZERO !== ((exact & 15) === 0 ? 1 : 0) || r.OVERFLOW !== ((exact > 7 || exact < -8) ? 1 : 0)) fails++;
      n++;
    }
    const table = ALU.truthTable();
    const pass = fails === 0 && n === 512 && table.length === 1280;
    return {
      label: 'Gate-level ALU verification',
      value: '512 + 1280 vectors',
      detail: fails + ' flag/result failures, exhaustive',
      pass
    };
  }

  function auditWeeks(env) {
    return WEEKS.map(w => {
      const metric = evalWeekMetric(w.key, env || {});
      return {
        key: w.key, name: w.name, track: w.track, desc: w.desc,
        bom: w.bom, cap: w.cap,
        bomLabel: w.bom === null ? 'print only' : '$' + w.bom.toFixed(2),
        capLabel: w.cap === null ? 'program ' : '$' + w.cap.toFixed(2),
        headroom: w.cap === null ? null : money(w.cap - w.bom),
        metric, tab: w.key
      };
    });
  }

  function bomSummary(rows) {
    let bom = 0, cap = 0;
    for (const r of rows) { if (r.bom !== null) { bom += r.bom; cap += r.cap; } }
    return { bomTotal: round6(bom), capTotal: round6(cap), headroomTotal: round6(cap - bom), allowance: PROGRAM_ALLOWANCE };
  }

  Lab.WEEKS = WEEKS;
  Lab.PROGRAM_ALLOWANCE = PROGRAM_ALLOWANCE;
  Lab.evalWeekMetric = evalWeekMetric;
  Lab.auditWeeks = auditWeeks;
  Lab.bomSummary = bomSummary;
  Lab.round6 = round6;

  // -------------------------------------------------------------------------
  // Audited Suite Proof Brief. One canonical payload per state key, cached so
  // every surface (fingerprint, JSON, CSV, Markdown) stamps one digest.
  // -------------------------------------------------------------------------
  const briefCache = new Map();

  function buildPayload(auditRows, labState) {
    const summary = bomSummary(auditRows);
    return {
      schema: 'halflife-suite-proof/1',
      suite: 'halflife-hardware-suite',
      lab: {
        tolerancePct: labState.tol, sweepMaxA: labState.imax, busV: labState.vbus,
        dacCode: labState.code, highlightedWeek: labState.week, curveMode: labState.curve
      },
      weeks: auditRows.map(r => ({
        key: r.key, name: r.name, track: r.track,
        bomUSD: r.bom, capUSD: r.cap, headroomUSD: r.headroom,
        metric: { label: r.metric.label, value: String(r.metric.value), pass: r.metric.pass === null ? 'pending' : !!r.metric.pass }
      })),
      derived: {
        ina219CalWord: '0x2800',
        r2rLsbMv: 12.890625,
        ina219AdcFullScaleA: round6(INA.adcFullScale(0.1)),
        shuntRatedCurrentA: round6(INA.ratedCurrent(0.1)),
        bomTotalUSD: summary.bomTotal,
        capTotalUSD: summary.capTotal,
        headroomTotalUSD: summary.headroomTotal,
        programAllowanceUSD: summary.allowance
      }
    };
  }

  function proofBrief(auditRows, labState) {
    const payload = buildPayload(auditRows, labState);
    const canonical = canonicalize(payload);
    const stateKey = sha256hex(canonicalize({ p: payload }));
    if (briefCache.has(stateKey)) return briefCache.get(stateKey);
    const brief = {
      payload,
      canonical,
      sha256: sha256hex(canonical),
      bytes: utf8Encode(canonical).length,
      key: stateKey
    };
    briefCache.set(stateKey, brief);
    return brief;
  }

  function briefJSON(brief) {
    return canonicalize({ payload: brief.payload, sha256: brief.sha256 });
  }

  function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[\s=+\-@\x00-\x1f\x7f-\x9f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufe00-\ufe0f]/.test(s)) s = "'" + s;
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function briefCSV(brief) {
    const lines = ['section,field,value'];
    lines.push(['digest', 'sha256', brief.sha256].map(csvCell).join(','));
    lines.push(['digest', 'payload_bytes', brief.bytes].map(csvCell).join(','));
    for (const w of brief.payload.weeks) {
      lines.push(['week', w.key + ' name', w.name].map(csvCell).join(','));
      lines.push(['week', w.key + ' bom_usd', w.bomUSD === null ? 'print only' : w.bomUSD].map(csvCell).join(','));
      lines.push(['week', w.key + ' cap_usd', w.capUSD === null ? 'n/a' : w.capUSD].map(csvCell).join(','));
      lines.push(['week', w.key + ' headroom_usd', w.headroomUSD === null ? 'n/a' : w.headroomUSD].map(csvCell).join(','));
      lines.push(['week', w.key + ' metric', w.metric.label + ' = ' + w.metric.value].map(csvCell).join(','));
      lines.push(['week', w.key + ' verified', String(w.metric.pass)].map(csvCell).join(','));
    }
    for (const [k, v] of Object.entries(brief.payload.derived))
      lines.push(['derived', k, v].map(csvCell).join(','));
    return lines.join('\n');
  }

  function briefMarkdown(brief) {
    const p = brief.payload;
    const lines = [
      '# Half Life Hardware Suite - Audited Proof Brief',
      '',
      'Canonical payload bytes: ' + brief.bytes,
      'SHA-256: `' + brief.sha256 + '`',
      '',
      '| Week | Track | BOM USD | Cap USD | Headroom USD | Verified metric |',
      '| --- | --- | --- | --- | --- | --- |'
    ];
    for (const w of p.weeks) {
      const bom = w.bomUSD === null ? 'print only' : '`$' + w.bomUSD.toFixed(2) + '`';
      const cap = w.capUSD === null ? 'n/a' : '`$' + w.capUSD.toFixed(2) + '`';
      const hr = w.headroomUSD === null ? 'n/a' : '`$' + w.headroomUSD.toFixed(2) + '`';
      lines.push('| ' + w.key + ' ' + w.name + ' | ' + w.track + ' | ' + bom + ' | ' + cap + ' | ' + hr + ' | ' +
        w.metric.label + ': ' + w.metric.value + ' (' + (w.metric.pass === 'pending' ? 'pending' : w.metric.pass ? 'pass' : 'fail') + ') |');
    }
    lines.push('');
    lines.push('Totals: BOM `' + '$' + p.derived.bomTotalUSD.toFixed(2) + '` vs caps `' + '$' + p.derived.capTotalUSD.toFixed(2) +
      '`, headroom `' + '$' + p.derived.headroomTotalUSD.toFixed(2) + '` under a `' + '$' + p.derived.programAllowanceUSD.toFixed(2) + '` program allowance.');
    lines.push('');
    lines.push('Digest footer: sha256=' + brief.sha256);
    return lines.join('\n');
  }

  function verifyBrief(brief) {
    if (!brief || !brief.payload || typeof brief.sha256 !== 'string') return false;
    return sha256hex(canonicalize(brief.payload)) === brief.sha256;
  }

  // Deterministic one-unit tamper: bump the week-3 BOM by one cent and re-seal.
  function tamperDemo(brief) {
    const mutated = JSON.parse(brief.canonical);
    mutated.weeks[2].bomUSD = round6(mutated.weeks[2].bomUSD + 0.01);
    const tamperedSha = sha256hex(canonicalize(mutated));
    return {
      field: 'weeks[2].bomUSD',
      from: brief.payload.weeks[2].bomUSD,
      to: mutated.weeks[2].bomUSD,
      originalSha256: brief.sha256,
      tamperedSha256: tamperedSha,
      detected: tamperedSha !== brief.sha256
    };
  }

  Lab.proofBrief = proofBrief;
  Lab.briefJSON = briefJSON;
  Lab.briefCSV = briefCSV;
  Lab.briefMarkdown = briefMarkdown;
  Lab.verifyBrief = verifyBrief;
  Lab.tamperDemo = tamperDemo;
  Lab.csvCell = csvCell;
  Lab._briefCache = briefCache;

  // -------------------------------------------------------------------------
  // Deterministic in-page self-tests. env = {S, ALU, FONT, stl?}. Returns a
  // list of {name, pass, detail} checks; every check is pure and repeatable.
  // -------------------------------------------------------------------------
  const TETRA_STL = [
    'solid tetra',
    'facet normal 0 0 -1',
    'outer loop', 'vertex 0 0 0', 'vertex 0 1 0', 'vertex 1 0 0', 'endloop', 'endfacet',
    'facet normal -1 0 0',
    'outer loop', 'vertex 0 0 0', 'vertex 0 0 1', 'vertex 0 1 0', 'endloop', 'endfacet',
    'facet normal 0 -1 0',
    'outer loop', 'vertex 0 0 0', 'vertex 1 0 0', 'vertex 0 0 1', 'endloop', 'endfacet',
    'facet normal 0.577350269 0.577350269 0.577350269',
    'outer loop', 'vertex 1 0 0', 'vertex 0 1 0', 'vertex 0 0 1', 'endloop', 'endfacet',
    'endsolid tetra'
  ].join('\n');

  function selfTest(env) {
    const S = env.S, ALU = env.ALU, FONT = env.FONT;
    const out = [];
    const check = (name, pass, detail) => out.push({ name, pass: !!pass, detail: String(detail) });
    const tryCheck = (name, fn) => {
      try { const r = fn(); check(name, r === undefined ? true : r.pass, r === undefined ? '' : r.detail); }
      catch (e) { check(name, false, 'threw: ' + e.message); }
    };

    tryCheck('sha256 known vector: empty string', () => ({
      pass: sha256hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      detail: sha256hex('').slice(0, 16)
    }));
    tryCheck('sha256 known vector: abc', () => ({
      pass: sha256hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      detail: sha256hex('abc').slice(0, 16)
    }));
    tryCheck('sha256 known vector: 448-bit message', () => ({
      pass: sha256hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq') ===
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      detail: 'multi-block boundary'
    }));
    tryCheck('sha256 known vector: one million a', () => ({
      pass: sha256hex('a'.repeat(1000000)) === 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
      detail: '15625 blocks'
    }));
    tryCheck('canonicalize: deterministic key order', () => {
      const a = canonicalize({ b: 1, a: { d: 2, c: 3 } });
      return { pass: a === '{"a":{"c":3,"d":2},"b":1}', detail: a };
    });
    tryCheck('canonicalize: cycles rejected', () => {
      const o = { a: 1 }; o.self = o;
      let threw = false;
      try { canonicalize(o); } catch (e) { threw = e instanceof TypeError; }
      return { pass: threw, detail: 'TypeError on cyclic value' };
    });
    tryCheck('canonicalize: depth bound enforced', () => {
      let v = 1;
      for (let i = 0; i < 40; i++) v = { next: v };
      let threw = false;
      try { canonicalize(v); } catch (e) { threw = e instanceof RangeError; }
      return { pass: threw, detail: 'RangeError past depth 24' };
    });
    tryCheck('INA219 calibration register is 0x2800', () => {
      const cal = S.BENCHRAIL.calibration(0.1, 40e-6);
      return { pass: cal === 0x2800, detail: '0x' + cal.toString(16).toUpperCase() };
    });
    tryCheck('INA219 bus register round trip', () => {
      const raw = S.BENCHRAIL.busRegister(5.0);
      const back = S.BENCHRAIL.decodeBus(raw);
      return { pass: Math.abs(back - 5.0) < 1e-9, detail: back + ' V' };
    });
    tryCheck('INA219 current register scaling', () => {
      const raw = S.BENCHRAIL.currentRegister(0.42, 0.1, 40e-6);
      return { pass: raw === 1050, detail: raw + ' counts' };
    });
    tryCheck('R-2R ladder LSB is 12.891 mV', () => {
      const codes = S.DAC.ladderCodes();
      const lsb = (codes[1] - codes[0]) * 1000;
      return { pass: Math.abs(lsb - 12.890625) < 1e-6, detail: lsb.toFixed(4) + ' mV' };
    });
    tryCheck('R-2R 256-code curve strictly monotonic', () => {
      const codes = S.DAC.ladderCodes();
      let ok = codes.length === 256;
      for (let i = 1; i < 256; i++) if (!(codes[i] > codes[i - 1])) ok = false;
      return { pass: ok && S.DAC.isMonotonic(codes), detail: 'codes 0..255' };
    });
    tryCheck('R-2R generalized solver matches suite solver', () => {
      const net = nominalNetwork();
      let maxDiff = 0;
      for (let c = 0; c < 256; c += 17)
        maxDiff = Math.max(maxDiff, Math.abs(ladderSolve(c, 3.3, net.arms, net.legs) - S.DAC.ladderVoltage(c, 3.3)));
      return { pass: maxDiff < 1e-12, detail: 'max diff ' + maxDiff.toExponential(2) };
    });
    tryCheck('Tolerance sweep: 0% ideal, worsens with tolerance', () => {
      const pts = toleranceSweep([0, 1, 2, 3, 4, 5], 3.3);
      const ok = pts[0].maxInl < 1e-9 && pts[0].maxDnl < 1e-9 &&
        pts[5].maxInl >= pts[4].maxInl && pts[4].maxInl >= pts[3].maxInl &&
        pts[2].maxInl >= pts[1].maxInl && pts[5].maxInl > 0.01;
      return { pass: ok, detail: 'INL ' + pts[0].maxInl.toExponential(1) + ' to ' + pts[5].maxInl.toFixed(3) + ' LSB' };
    });
    tryCheck('SSD1306 page buffer is 1024 bytes in 8 pages', () => {
      const d = new S.Display.SSD1306(0x3C);
      return { pass: d.byteCount() === 1024 && d.pages.length === 8 && d.pages[0].length === 128, detail: '8x128' };
    });
    tryCheck('Font table holds 256 glyphs of 5 columns', () => {
      const g = FONT.FONT5X7_GLYPHS;
      return { pass: g.length === 256 && g.every(x => x.length === 5), detail: '256x5' };
    });
    tryCheck('ALU: 512 ADD/SUB vectors exact', () => {
      let fails = 0;
      for (let A = 0; A < 16; A++) for (let B = 0; B < 16; B++) for (const op of [0, 1]) {
        const r = ALU.evaluate(A, B, op);
        const sA = A >= 8 ? A - 16 : A, sB = B >= 8 ? B - 16 : B;
        const exact = op === 0 ? sA + sB : sA - sB;
        if (r.Y !== (exact & 15) || r.OVERFLOW !== ((exact > 7 || exact < -8) ? 1 : 0)) fails++;
      }
      return { pass: fails === 0, detail: '512 checked, ' + fails + ' failed' };
    });
    tryCheck('ALU: 1280 five-opcode vectors cross-check', () => {
      let mism = 0;
      for (let A = 0; A < 16; A++) for (let B = 0; B < 16; B++) for (let op = 0; op < 5; op++) {
        const n = ALU.evaluate(A, B, op), w = S.ALU.alu(A, B, op);
        if (n.Y !== w.Y || n.CARRY !== w.CARRY || n.ZERO !== w.ZERO || n.OVERFLOW !== w.OVERFLOW) mism++;
      }
      return { pass: mism === 0, detail: 'suite.js vs week5-logic/alu.js' };
    });
    tryCheck('Proof brief: digest parity across 4 surfaces', () => {
      const rows = auditWeeks(env);
      const st = defaultState();
      const b = proofBrief(rows, st);
      const surfaces = [b.sha256, JSON.parse(briefJSON(b)).sha256,
        (briefCSV(b).match(/^digest,sha256,([0-9a-f]{64})$/m) || [])[1],
        (briefMarkdown(b).match(/sha256=([0-9a-f]{64})/) || [])[1]];
      return { pass: surfaces.every(x => x === b.sha256), detail: b.sha256.slice(0, 16) };
    });
    tryCheck('Proof brief: verify accepts, tamper detected', () => {
      const rows = auditWeeks(env);
      const b = proofBrief(rows, defaultState());
      const t = tamperDemo(b);
      return { pass: verifyBrief(b) && t.detected, detail: t.field + ' ' + t.from + ' -> ' + t.to };
    });
    tryCheck('Codec: #hlab= round trip restores state', () => {
      const st = { tol: 2.5, imax: 1.6, vbus: 12, code: 200, week: 'w4', curve: 'dnl' };
      const r = decodeState(encodeState(st));
      const ok = r.ok && r.state.tol === 2.5 && r.state.imax === 1.6 && r.state.vbus === 12 &&
        r.state.code === 200 && r.state.week === 'w4' && r.state.curve === 'dnl';
      return { pass: ok, detail: encodeState(st).slice(0, 22) + '...' };
    });
    tryCheck('Codec: hostile payloads rejected', () => {
      const hostile = ['#hlab=', '#hlab=!!!', '#hlab=' + b64urlEncode(utf8Encode('{"__proto__":{"x":1}}')),
        '#hlab=' + b64urlEncode(utf8Encode('[1,2]')), '#hlab=' + b64urlEncode(utf8Encode('"s"')),
        '', '#other=' + b64urlEncode(utf8Encode('{}')), '#hlab=' + 'A'.repeat(600)];
      const bad = hostile.filter(h => decodeState(h).ok).length;
      return { pass: bad === 0, detail: bad + ' of ' + hostile.length + ' slipped through' };
    });
    tryCheck('CSV: formula injection escaped', () => {
      const samples = ['=1+1', '+x', '-x', '@x', '\tx', '\rx', ' =1+1', '\u200b=1+1', '\u0000=1+1'];
      const ok = samples.every(s => csvCell(s).charAt(0) === "'");
      return { pass: ok && csvCell('safe') === 'safe', detail: samples.length + ' hostile prefixes' };
    });
    tryCheck('STL tetrahedron parses watertight with volume', () => {
      const st = S.STL.manifoldStats(S.STL.parseSTL(TETRA_STL));
      return { pass: st.watertight && st.outward && Math.abs(st.volume - 1 / 6) < 1e-9, detail: 'V=' + st.volume.toFixed(4) };
    });
    tryCheck('Comparator: 5 weeks, headroom arithmetic', () => {
      const rows = auditWeeks(env);
      const ok = rows.length === 5 && Math.abs(rows[0].headroom - 11.10) < 1e-9 &&
        rows[1].bom === null && Math.abs(rows[4].headroom - 3.40) < 1e-9;
      return { pass: ok, detail: 'w1 headroom $' + rows[0].headroom.toFixed(2) };
    });

    if (env.stl && ['base_chassis', 'tilt_cradle', 'detent_dial'].every(n => typeof env.stl[n] === 'string')) {
      for (const n of ['base_chassis', 'tilt_cradle', 'detent_dial']) {
        tryCheck('STL evidence ' + n + ' watertight', () => {
          const st = S.STL.manifoldStats(S.STL.parseSTL(env.stl[n]));
          return { pass: st.watertight && st.volume > 0 && st.outward, detail: 'V=' + st.volume.toFixed(1) + ' mm3' };
        });
      }
    }
    return out;
  }

  Lab.selfTest = selfTest;
  Lab.TETRA_STL = TETRA_STL;

  if (typeof module !== 'undefined' && module.exports) module.exports = Lab;
  if (typeof window !== 'undefined') window.SuiteLab = Lab;
})(typeof window !== 'undefined' ? window : globalThis);
