'use strict';
// Gate level evaluator for the DiscreteALU-74HC breadboard datapath.
// Zero dependencies. Node and browser compatible (also sets window.DiscreteALU).
// The bit operations mirror the 74HCxx gate network in netlist.json:
//   74HC86 XOR inverts B when SUB is asserted
//   74HC283 adds A + (B XOR SUB) + SUB
//   74HC08 / 74HC32 / 74HC86 compute bitwise AND / OR / XOR
//   74HC153 selects one of those four results with S[1:0]
//   74HC161 counts step clock pulses
// Flag logic implements the equations documented in BREADBOARD_GUIDE.md.

const OP = Object.freeze({ ADD: 0, SUB: 1, AND: 2, OR: 3, XOR: 4 });
const OP_NAMES = ['ADD', 'SUB', 'AND', 'OR', 'XOR'];
const MASK = 0xF;

const xor = (a, b) => (a ^ b) & 1;
const and = (a, b) => (a & b) & 1;
const or = (a, b) => (a | b) & 1;

// One gate level full adder cell. Returns { sum, carry }.
function fullAdder(a, b, cin) {
  const p = xor(a, b);
  const sum = xor(p, cin);
  const g = and(a, b);
  const carry = or(g, and(p, cin));
  return { sum, carry };
}

// 74HC283: ripple the four bit cells, exactly as the fast-carry IC resolves.
function hc283(A, B, cin, invertB = 0) {
  let carry = cin & 1, sum = 0, c3 = 0;
  for (let i = 0; i < 4; i++) {
    const a = (A >> i) & 1;
    const b = xor((B >> i) & 1, invertB & 1);
    const cell = fullAdder(a, b, carry);
    sum |= cell.sum << i;
    if (i === 2) c3 = cell.carry; // carry out of bit 2 is carry into bit 3
    carry = cell.carry;
  }
  return { sum: sum & MASK, carry: carry & 1, carryIntoMSB: c3 };
}

// Zero flag: 74HC02 NOR tree plus two 74HC14 inverters, then a final NOR.
// n01 = NOR(Y0,Y1), n23 = NOR(Y2,Y3); inverters give h01 = Y0|Y1 and
// h23 = Y2|Y3; the last NOR gives NOT(Y0|Y1|Y2|Y3) = ZERO.
function zeroFlag(Y) {
  const n01 = 1 - or((Y >> 0) & 1, (Y >> 1) & 1);
  const n23 = 1 - or((Y >> 2) & 1, (Y >> 3) & 1);
  const h01 = 1 - n01;
  const h23 = 1 - n23;
  return 1 - or(h01, h23);
}

// Overflow flag from the sign bit formulation in BREADBOARD_GUIDE.md.
function overflowFlag(A, B, Y, sub) {
  const a3 = (A >> 3) & 1, b3 = (B >> 3) & 1, y3 = (Y >> 3) & 1;
  const signsEqual = 1 - xor(a3, b3);
  const signChanged = xor(y3, a3);
  return sub ? and(1 - signsEqual, signChanged) : and(signsEqual, signChanged);
}

function evaluate(A, B, op) {
  A &= MASK; B &= MASK;
  const sub = op === OP.SUB ? 1 : 0;
  const adder = hc283(A, B, sub, sub);
  const andBits = (A & B) & MASK;
  const orBits = (A | B) & MASK;
  const xorBits = (A ^ B) & MASK;
  const muxOut = [adder.sum, adder.sum, andBits, orBits, xorBits];
  const Y = muxOut[op] & MASK;
  const gates = {
    adder: { sum: adder.sum, cout: adder.carry, cin: sub, bx: xor(B, sub ? MASK : 0) },
    hc08_and: andBits, hc32_or: orBits, hc86_xor: xorBits,
    hc153_select: op,
    hc153_c0: adder.sum, hc153_c1: adder.sum, hc153_c2: andBits, hc153_c3: orBits
  };
  return {
    A, B, op, opcode: OP_NAMES[op], Y,
    CARRY: op === OP.ADD || op === OP.SUB ? adder.carry : 0,
    ZERO: zeroFlag(Y),
    OVERFLOW: (op === OP.ADD || op === OP.SUB) ? overflowFlag(A, B, Y, sub) : 0,
    gates
  };
}

// 512-vector exhaustive truth table: 16 A x 16 B x 2 hardware opcodes is 512
// for ADD/SUB; the full five-opcode table is 16 x 16 x 5 = 1280 vectors.
function truthTable(ops) {
  const list = ops || [OP.ADD, OP.SUB, OP.AND, OP.OR, OP.XOR];
  const rows = [];
  for (const op of list) for (let A = 0; A < 16; A++) for (let B = 0; B < 16; B++)
    rows.push(evaluate(A, B, op));
  return rows;
}

// 74HC161 synchronous 4-bit counter model, used by the step display.
function counterStep(state, mrN = 1, peN = 1, cep = 1, cet = 1, d = 0) {
  if (!mrN) return { q: 0, tc: 0 };
  if (!peN) return { q: d & MASK, tc: cet && (d & MASK) === MASK ? 1 : 0 };
  if (!cep || !cet) return { q: state & MASK, tc: cet && (state & MASK) === MASK ? 1 : 0 };
  const q = ((state & MASK) + 1) & MASK;
  return { q, tc: cet && (state & MASK) === MASK ? 1 : 0 };
}

const api = { OP, OP_NAMES, fullAdder, hc283, zeroFlag, overflowFlag, evaluate, truthTable, counterStep };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.DiscreteALU = api;
