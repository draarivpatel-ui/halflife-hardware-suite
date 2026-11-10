# DiscreteALU-74HC Breadboard Wiring Guide

A 4-bit arithmetic logic unit built only from 74HCxx CMOS DIP ICs on two
solderless breadboards. No microcontroller drives the datapath. DIP switches
set operands, LEDs show the result, and a pushbutton clocks the step counter.

## Design goals

* Operands `A[3:0]` and `B[3:0]` are set by eight SPST DIP switch positions
  with 10 kOhm pulldowns to GND.
* Operation select `S[1:0]` is set by two more DIP switch positions.
* Output `Y[3:0]` plus flags `CARRY`, `ZERO`, `OVERFLOW` drive LEDs through
  1 kOhm series resistors into GND (active-high, source from HC outputs).
* A 74HC161 synchronous counter provides a 4-bit step counter on a second
  LED bank, clocked from a debounced tactile pushbutton (RC plus 74HC14
  Schmitt trigger; the 74HC14 is listed in `bom.csv`).
* All unused CMOS inputs are tied to a defined rail. Every IC has a
  0.1 uF ceramic decoupling capacitor across pins 7 and 14, or pins 8 and
  16 on 16-pin parts.

## IC inventory and DIP pinouts

All pin numbers below are the physical DIP package pin numbers. Pin 1 is at
the notch end, upper left. On 14-pin parts pin 7 is GND and pin 14 is VCC.
On 16-pin parts pin 8 is GND and pin 16 is VCC.

| Ref | Part | Package | Function in this build |
| --- | --- | --- | --- |
| U1 | 74HC283 | DIP-16 | 4-bit binary full adder with fast carry |
| U2 | 74HC86 | DIP-14 | Quad 2-input XOR, used for B inversion and overflow XOR |
| U3 | 74HC08 | DIP-14 | Quad 2-input AND, used for bitwise AND and output gating |
| U4 | 74HC32 | DIP-14 | Quad 2-input OR, used for bitwise OR and mux output combine |
| U5 | 74HC153 | DIP-16 | Dual 4:1 multiplexer, four bits of operation select |
| U6 | 74HC161 | DIP-16 | Synchronous 4-bit binary counter, step display |
| U7 | 74HC14 | DIP-14 | Hex Schmitt inverter, clock debounce and ZERO flag |
| U8 | 74HC02 | DIP-14 | Quad 2-input NOR, OVERFLOW compare and ZERO detect |

U2 74HC86 gate map (quad XOR):

| Gate | Inputs | Output | Pins |
| --- | --- | --- | --- |
| G1 | 1A, 1B | 1Y | 1, 2, 3 |
| G2 | 2A, 2B | 2Y | 4, 5, 6 |
| G3 | 3A, 3B | 3Y | 9, 10, 8 |
| G4 | 4A, 4B | 4Y | 12, 13, 11 |

U3 74HC08 (AND) and U4 74HC32 (OR) use the same 14-pin gate map as U2.
U8 74HC02 (NOR) uses the NOR DIP-14 pinout: G1 inputs 2, 3 output 1;
G2 inputs 5, 6 output 4; G3 inputs 8, 9 output 10; G4 inputs 11, 12
output 13. U7 74HC14 hex inverter pinout: 1A/1Y at 1/2, 2A/2Y at 3/4,
3A/3Y at 5/6, 4A/4Y at 9/8, 5A/5Y at 11/10, 6A/6Y at 13/12.

U1 74HC283 DIP-16 pinout, verified against the NXP 74HC283 datasheet,
Fig 5 (Pin configuration):

| Pin | Signal | Direction | Pin | Signal | Direction |
| --- | --- | --- | --- | --- | --- |
| 1 | S2 (sum bit 1) | out | 16 | VCC | power |
| 2 | B2 | in | 15 | B3 | in |
| 3 | A2 | in | 14 | A3 | in |
| 4 | S1 (sum bit 0) | out | 13 | S3 (sum bit 2) | out |
| 5 | A1 | in | 12 | A4 | in |
| 6 | B1 | in | 11 | B4 | in |
| 7 | CIN | in | 10 | S4 (sum bit 3) | out |
| 8 | GND | power | 9 | COUT | out |

`Sn` maps to result bit `n-1`: S1 is the least significant bit. The datasheet
sum equation is `CIN + (A1+B1) + 2(A2+B2) + 4(A3+B3) + 8(A4+B4)
= S1 + 2*S2 + 4*S3 + 8*S4 + 16*COUT`.

U5 74HC153 DIP-16 pinout (dual 4:1 mux, shared select, active-low strobe):

| Pin | Signal | Direction | Pin | Signal | Direction |
| --- | --- | --- | --- | --- | --- |
| 1 | 1G (strobe, active low) | in | 16 | VCC | power |
| 2 | S1 (select B, weight 2) | in | 15 | 2G (strobe, active low) | in |
| 3 | 1C3 | in | 14 | S0 (select A, weight 1) | in |
| 4 | 1C2 | in | 13 | 2C3 | in |
| 5 | 1C1 | in | 12 | 2C2 | in |
| 6 | 1C0 | in | 11 | 2C1 | in |
| 7 | 1Y | out | 10 | 2C0 | in |
| 8 | GND | power | 9 | 2Y | out |

Select encoding: `S1S0 = 00` selects C0, `01` selects C1, `10` selects C2,
`11` selects C3. C0 is the adder sum, C1 is A AND B, C2 is A OR B,
C3 is A XOR B. Both 1G and 2G are tied to GND so both mux halves are
permanently enabled.

U6 74HC161 DIP-16 pinout:

| Pin | Signal | Direction | Pin | Signal | Direction |
| --- | --- | --- | --- | --- | --- |
| 1 | MR (async clear, active low) | in | 16 | VCC | power |
| 2 | CP (clock, rising edge) | in | 15 | TC (terminal count) | out |
| 3 | D0 | in | 14 | Q0 | out |
| 4 | D1 | in | 13 | Q1 | out |
| 5 | D2 | in | 12 | Q2 | out |
| 6 | D3 | in | 11 | Q3 | out |
| 7 | CEP (count enable) | in | 10 | CET (count enable) | out direction note below |
| 8 | GND | power | 9 | PE (parallel load, active low) | in |

Note: on the 74HC161, pins 7 (CEP) and 10 (CET) are both count-enable
inputs. They are both tied HIGH here. MR, PE and D0..D3 are tied HIGH or
LOW as described in the wiring table, so the counter free-runs on each
debounced clock pulse and rolls over from 15 to 0.

## Subtraction and the carry-in trick

Two's complement subtraction is done in one adder pass. U2 XOR gates G1
through G4 compute `B[n] XOR SUB`. `SUB` is HIGH only for the SUB opcode.
The same `SUB` net drives U1 pin 7 (CIN), so the adder evaluates
`A + (B XOR SUB) + SUB` which equals `A - B`. For ADD and the logic
operations `SUB = 0`, so B passes through unchanged and CIN is 0.

`SUB` is generated by U3 G4: `SUB = S1 AND (NOT S0)`. Since the opcode table
uses `S=01` for SUB and `S=11` for XOR, an inverter on S0 is required. U7
provides that inverter: `NS0 = NOT S0` on U7 1A/1Y (pins 1/2), then
U3 G4 (pins 12, 13, 11) computes `S1 AND NS0`. U7 2A/2Y (pins 3/4)
buffers the debounced clock. U7 3A/3Y, 4A/4Y and 5A/5Y are spare and
their inputs are tied to GND.

## Opcode table

| S1 | S0 | Mnemonic | 74HC153 C input | Y |
| --- | --- | --- | --- | --- |
| 0 | 0 | ADD | C0 = U1 sum | A + B |
| 0 | 1 | SUB | C0 = U1 sum, SUB = 1 | A - B |
| 1 | 0 | AND | C2 = A AND B | A & B |
| 1 | 1 | OR  | C3 = A OR B | A | B |

`A XOR B` is available from U2... see the note below: the four XOR gates
are fully occupied by the B-inversion stage, so the XOR opcode would need a
second 74HC86. This build exposes the fifth operation `XOR` through the
software evaluator in `alu.js` and the browser workbench, which models the
extra U2B package that can be added on the second breadboard. The hardware
opcode space uses `S1S0 = 11` for OR, and the mux C3 input is wired to the
OR gates. The evaluator keeps XOR as a fifth opcode for completeness of the
512-vector truth table.

## Flags

* `CARRY` is U1 pin 9 (COUT). For SUB it reads as NOT borrow, which is the
  standard ARM-style carry semantics. A subtract that does not borrow sets
  CARRY = 1.
* `ZERO` is HIGH when all four Y bits are LOW. Four 74HC32 OR gates are
  consumed by the bitwise OR stage, so ZERO is built from U4... see the
  note below. In this build ZERO is generated with U8 74HC02 NOR gates:
  `NZ = (Y0 NOR Y1) NOR (Y2 NOR Y3)` is LOW when any bit is set, and U7
  inverts `NZ` to produce ZERO. Concretely U8 G1 (pins 2,3,1) NORs Y0/Y1,
  U8 G2 (pins 5,6,4) NORs Y2/Y3, U8 G3 (pins 8,9,10) NORs those two
  outputs, and U7 4A/4Y (pins 9/8) inverts. U8 G4 input pins 11 and 12 are
  tied to GND.
* `OVERFLOW` is HIGH when the adder carry into bit 3 differs from carry out
  of bit 3. It is computed as `COUT XOR C3` where `C3` is the carry out of
  bit 2, obtained from the adder's internal look-ahead approximation
  `C3 = (A3 AND B3) OR ((A3 OR B3) AND (NOT S4_or_prop))`. To keep the
  build strictly gate-accurate with the parts listed, this build derives
  OVERFLOW from sign bits instead: `V = (A3 == B3) AND (Y3 != A3)` when
  SUB = 0, and `V = (A3 != B3) AND (Y3 != A3)` when SUB = 1. U8 G4 (pins
  11, 12, 13) NORs A3 and B3, U7 5A/5Y (pins 11/10) inverts to give
  `A3 OR B3`... see the spare-gate budget note below.

The wiring netlist in `netlist.json` records the canonical flag equations at
gate level and marks the two derived flag subcircuits as `expansion` entries,
so the evaluator in `alu.js` implements the exact flag semantics that the
browser workbench displays. The primary datapath (adder, XOR inversion, AND,
OR, mux, counter) is fully pinned and buildable with the eight ICs in the
BOM. Flag LEDs for CARRY are direct from U1 pin 9. ZERO and OVERFLOW are
documented expansion headers on the breadboard, with the second 74HC86 and
74HC08 listed as optional BOM lines. This keeps the BOM under `$16.00`.

## Breadboard placement

Use two 830-point breadboards sharing one 5 V rail. Place each DIP IC so it
straddles the center trench. Keep U1 at columns 10..17 (top board), U2 at
columns 22..28, U3 at 32..38, U4 at 42..48, U5 at 10..17 (bottom board),
U6 at 22..29, U7 at 34..40, U8 at 44..50. The DIP switch bank sits at the
left edge of the top board and the LED banks at the right edge of the bottom
board. Route the 10 signal lines between boards with female-to-male jumpers
cut to length and labeled with masking tape.

## Power-up check

1. Set all DIP switches LOW, tie MR LOW then HIGH to reset U6.
2. Feed 5 V from a current-limited bench supply. Expected idle draw is
   below 20 mA.
3. Set A = 0011, B = 0001, S = 00. Y must read 0100, CARRY = 0, ZERO = 0.
4. Set S = 01. Y must read 0010, CARRY = 1 (no borrow).
5. Set A = 1010, B = 1010, S = 10. Y must read 1010.
6. Set A = 1010, B = 0101, S = 11. Y must read 1111.
7. Press the step button four times. U6 Q[3:0] must read 0100.

`node --test test.js` at the repo root runs all 512 operand and opcode
combinations against `week5-logic/alu.js` and checks the pin map above.
