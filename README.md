# halflife-hardware-suite

Five manufacturable hardware designs built for [Hack Club Half Life](https://halflife.hackclub.com/) and the parametric CAD practice of [Hack Club Atlantis](https://atlantis.hackclub.com/), plus a zero-dependency browser workbench that inspects all five. Everything is checked in as source, fabrication output, firmware, and repeatable tests. No build step, no package manager, no external assets.

Live workbench: <https://aariv.me/halflife-hardware-suite/>
Repository: <https://github.com/draarivpatel-ui/halflife-hardware-suite>

## Why this exists

Half Life runs five weekly design tracks before five weeks of building: **PCBs**, **CAD**, **music**, **displays**, and **breadboard logic**. Each track qualifies for up to `$100.00` in parts funding, and finishing the program earns a 3D printer and a Half Life sticker sheet. This suite treats each week as a real design exercise with a real BOM, real fabrication files, and a real verification harness rather than a slide deck.

| Week | Track | Project | Board / part count | BOM total |
| --- | --- | --- | --- | --- |
| 1 | PCB | `BenchRail-INA` USB-C dual-rail precision current and voltage monitor | 62 x 42 mm, 2 layer | `$6.90` |
| 2 | CAD | `HelicalDesk` parametric 3-stage snap-fit stand and rotary detent pod | 3 STL + 1 OBJ | print only |
| 3 | Music | `PocketChime-R2R` 8-bit ladder chiptune synthesizer | 78 x 56 mm, 2 layer | `$12.19` |
| 4 | Displays | `GlyphMatrix-128` dual SSD1306 OLED + 74HC595 8x8 LED badge | 88 x 54 mm, 2 layer | `$18.56` |
| 5 | Breadboard logic | `DiscreteALU-74HC` 4-bit CMOS ALU and step counter | 9 DIP ICs | `$12.60` |

All four priced BOMs sit far below the `$100.00` per-project allowance and below the tighter internal caps of `$18.00`, `$22.00`, `$24.00`, and `$16.00`. The combined priced total is `$50.25`, leaving room for shipping, spare passives, and a second prototype round.

## Quick start

```bash
git clone https://github.com/draarivpatel-ui/halflife-hardware-suite.git
cd halflife-hardware-suite
node --test test.js
```

Open `index.html` in any modern browser. It uses plain HTML, CSS, and JavaScript, so it also works from a local file; a static server gives the workbench live access to the checked-in KiCad, STL, and netlist sources. No npm install, no bundler, no CDN.

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/
```

To regenerate every deterministic artifact from one place:

```bash
node tools/generate_suite_artifacts.js
```

The generator uses a seeded PRNG, so re-running it leaves the KiCad boards, Gerbers, drill files, BOMs, STL, OBJ, netlist, and font tables unchanged. The OpenSCAD source remains the authoritative printable geometry for Week 2.

## The five designs

### Week 1: `week1-pcb/` BenchRail-INA

A USB-C powered dual-rail telemetry board. Two `INA219AIDCNR` monitors read independent 0.1 ohm 1% 1206 shunts, one per rail, at I2C addresses 0x40 and 0x41. An `AMS1117-3.3` LDO supplies the logic, a `USB4105-GF-A` receptacle brings in 5 V with 5K1 CC pulldowns, and 0603 decoupling caps sit at every IC. Four M2.5 non-plated mounting holes and a full ground pour complete the layout.

Files: `benchrail_ina.kicad_sch`, `benchrail_ina.kicad_pcb`, `benchrail_ina.kicad_pro`, `gerbers/` (9 RS-274X plots plus Excellon `.drl`), `bom.csv`.

The `.kicad_pro` declares three net classes: Default (0.20 mm clearance / 0.25 mm track), Power (0.25 mm / 0.60 mm), and Signal (0.15 mm / 0.20 mm). Patterns assign VBUS and 3V3 to Power, SDA and SCL to Signal.

**Power-up check:** current-limited 5 V supply, all DIP switches off, idle draw below 30 mA; read the bus voltage register and confirm the calibration word 0x2800 for a 0.1 ohm shunt at a 40 uA LSB.

### Week 2: `week2-cad/` HelicalDesk

`helical_desk.scad` is a fully parameterized OpenSCAD model with Customizer groups for chassis, cradle, dial, snap fit, and assembly. The three printable stages are a base chassis with a raised rim and M2.5 rotary boss, a tilt cradle with side cheeks, rear lip and hinge bore, and a 12-tooth detent dial. No supports are needed; PLA at 0.2 mm layers, 3 perimeters, 15% infill.

`tools/generate_suite_artifacts.js` mirrors the same parameter set and writes `base_chassis.stl`, `tilt_cradle.stl`, `detent_dial.stl`, and `assembled_preview.obj`. `week2-cad/geometry_stats.json` records half-edge pairing, connected components, and signed volume for each part. Every exported STL passes the strict check that each directed edge has exactly one exact opposite, all component volumes are positive, and all stored facet normals agree with their triangle windings.

### Week 3: `week3-music/` PocketChime-R2R

An 8-bit voltage-mode R-2R ladder built from eight 10K horizontal arms and eight 20K vertical legs (seven legs plus a 20K termination), all 0603 1%. An `RP2040-Zero` drives the eight GPIO bits as one bus write; a `MCP6002-I/SN` rail-to-rail dual op amp buffers the ladder into a 3.5 mm TRS jack. Twelve tactile switches form a 3x4 chromatic key matrix.

`firmware/pocketchime.ino` implements four phase-accumulator DDS voices (pulse, triangle, saw, square) and a four-stage ADSR running in a 22050 Hz repeating-timer ISR. The phase increment is `f * 2^32 / sample_rate`; the bus write is a masked GPIO operation.

The workbench solves the ladder by Gaussian elimination on the eight-node Kirchhoff system, giving a strictly monotonic 256-code transfer curve with a uniform 12.891 mV LSB at a 3.3 V reference.

### Week 4: `week4-display/` GlyphMatrix-128

Two 128x64 SSD1306 OLED modules on hardware I2C at 0x3C and 0x3D, plus an 8x8 LED matrix driven by a `74HC595` shift register. `firmware/glyphmatrix.ino` contains a complete SSD1306 init sequence, a 1 KiB page-buffer renderer, a 5x7 bitmap font, and a timer-multiplexed row scan with output blanking during the shift to prevent ghosting.

`font5x7_data.h` carries all 96 printable ASCII glyphs; `font5x7.js` and the root `suite_font.js` carry the full 256-glyph table for the browser simulator. No display library is used.

### Week 5: `week5-logic/` DiscreteALU-74HC

Eight 74HCxx DIP ICs on two 830-point breadboards. A `74HC283` full adder, `74HC86` XOR B-inversion stage, `74HC08` AND, `74HC32` OR, `74HC153` dual 4:1 output mux, `74HC161` step counter, `74HC14` Schmitt debounce, and `74HC02` NOR zero detector. Subtraction uses the two's complement trick: `SUB` drives all four XOR inputs and the adder CIN, so `A + (B XOR SUB) + SUB` equals `A - B`.

`netlist.json` records every physical DIP pin. The 74HC283 pin map was checked against the NXP datasheet Fig 5 (pin configuration), where pin 1 is S2, pin 7 is CIN, pin 9 is COUT, and pin 16 is VCC. `BREADBOARD_GUIDE.md` gives the gate maps, opcode table, flag equations, placement, and a seven-step power-up check. `alu.js` is a gate-level evaluator shared by the Node tests and the browser prover.

## Browser workbench

`index.html` is a six-tab engineering studio:

1. **PCB**: an SVG layer inspector that parses the checked-in `.kicad_pcb` for copper segments, pads, mounting holes, silkscreen text, and Edge.Cuts. Nine independently toggleable layers plus an INA219 register and power model.
2. **CAD**: a Canvas turntable that parses the real ASCII STL, flat-shades it with a depth sort and fixed light vector, supports shaded and wireframe modes, and reports half-edge pairing, signed volume, connected components, and normal agreement.
3. **Music**: the 256-code R-2R staircase alongside an ADSR / four-voice DDS oscilloscope. **No Web Audio object is created on load, on tab switch, or at any point without an explicit user click.** A muted-by-default checkbox creates a silent context; a separate Play control is required before any oscillator starts.
4. **Displays**: two 128x64 page buffers drawn pixel by pixel with a 5x7 font, plus a live 74HC595 8x8 row scan showing the shift register contents.
5. **Logic**: clickable operand bits, five opcodes, gate-level signal flow, flag LEDs, a pin-map browser for all nine ICs, a 74HC161 step counter, and an exhaustive 512 plus 1280 vector verifier.
6. **Lab**: a deterministic Suite Audit & Physics Lab driven by `suite-lab.js`, a pure UMD module with no DOM, network, or timers. It hosts a five-week cross-track comparator (BOM vs cap with headroom and a verified physics metric per week, clickable rows jump into each tab), an R-2R tolerance and INL/DNL sensitivity chart re-solving the real eight-node Kirchhoff system under 46 deterministic worst-case resistor patterns, an INA219 shunt power and ADC full-scale sweep, a clickable BOM-vs-cap budget frontier, and an audited proof brief whose on-page fingerprint, JSON, CSV (formula-injection escaped), and Markdown exports all stamp one cached canonical SHA-256 digest. Lab state round-trips through a fail-closed `#hlab=` URL hash, and an in-page runner executes a 25-check deterministic self-test battery (28 checks once the STL files load) against the live models.

`style.css` is a self-contained dark instrument-panel theme with responsive layouts and reduced-motion support. `.nojekyll` keeps GitHub Pages from ignoring the underscore-prefixed or data files.

## Verification

`node --test test.js` runs 552 tests with thousands of individual assertions:

* KiCad 8 `(version 20240108)` PCB and `(version 20231120)` schematic headers, balanced S-expression parentheses, all nine required layers, net classes, routed copper, pads, courtyards, and four M2.5 holes per board.
* RS-274X `G04`, `%FSLAX46Y46*%`, `%MOMM*%`, aperture definitions, and a terminating `M02*` on all 27 Gerber plots; Excellon `M48`, `FMAT,2`, tool table, `G90`, `G05`, coordinate records, and `M30` on all three drill files.
* BOM CSV structure, real LCSC / DigiKey / JLCPCB part numbers, extended-price arithmetic, and the four price caps.
* STL half-edge manifoldness (every directed edge has its exact opposite), positive signed volume per connected component, and facet normal agreement with triangle winding; OBJ validity for the assembly.
* Exact 256-code R-2R monotonicity with uniform LSB steps, bounded DDS waveforms, and all four ADSR stages.
* SSD1306 1024-byte page-buffer set/get and text rendering, the 256-glyph 5x7 table, and the 74HC595 16-bit scan register model.
* All 512 ADD/SUB operand vectors with exact carry, zero, and overflow, plus all 1280 five-opcode vectors cross-checked between the browser model and `alu.js`.
* Byte-level scan of every file for zero em dashes, zero en dashes, zero AI self-references, backtick-wrapped dollar amounts in Markdown, and no personal contact details.
* The autoplay guard: exactly one `AudioContext` construction site, bound only to a change handler, with gain zero until the separate Play click.
* Lab (`suite-lab.test.js`, required by `test.js`): FIPS 180-4 SHA-256 known-answer vectors plus a 0-to-160-byte boundary sweep against Node `crypto`, canonicalizer key-order, cycle, and depth-bound tests, hostile `#hlab=` codec rejection (`__proto__`, bad roots, bad base64url, clamp violations), R-2R generalized-solver parity with the suite solver across all 256 codes, tolerance-sweep invariants, INA219 sweep bounds, comparator BOM-vs-cap and metric verdicts cross-checked against the real CSVs, formula-injection CSV escaping, single-digest parity across all four export surfaces, one-unit tamper detection, a 160-vector ALU spot grid, the 25-check deterministic self-test battery, and DOM wiring assertions for the sixth tab.

## Repository layout

```
index.html  style.css  suite.js  suite-lab.js  app.js  suite_font.js
test.js  suite-lab.test.js  .nojekyll  README.md  JOURNAL.md  LICENSE
tools/
  generate_suite_artifacts.js   deterministic artifact generator
  font_data.txt                 256 glyph x 5 byte source table
week1-pcb/    kicad_sch  kicad_pcb  kicad_pro  gerbers/  benchrail_ina-gerbers.zip  bom.csv
week2-cad/    helical_desk.scad  3x stl  assembled_preview.obj  geometry_stats.json
week3-music/  kicad_pcb  kicad_pro  gerbers/  pocketchime-gerbers.zip  bom.csv  firmware/pocketchime.ino
week4-display/ kicad_pcb  kicad_pro  gerbers/  glyphmatrix-gerbers.zip  bom.csv  firmware/  font5x7.js
week5-logic/  netlist.json  BREADBOARD_GUIDE.md  alu.js  bom.csv
```

## Fabrication notes

* All PCBs are 2 layer, 1.6 mm FR4, 0.035 mm copper, ENIG finish, green mask, with a 1.51 mm FR4 dielectric core.
* Gerbers use 4.6 format, millimetres, Gerber X2 `%TF.FileFunction` and `%TF.FilePolarity` attributes, and 4.4 metric drill coordinates.
* Upload `<board>-gerbers.zip` (containing all nine `.gbr` plots plus `<board>.drl`, with `Edge.Cuts` mapped to `Profile,NP`) directly to PCBWay, JLCPCB, or OSH Park.
* BOM prices are single-unit catalog prices captured for this build. They exclude shipping and customs, which Half Life does not cover.
* Week 2 prints without supports. Allow a 0.2 mm bore clearance on the M2.5 hinge.
* Week 5 uses a current-limited 5 V bench supply and expects under 20 mA idle draw. Tie every unused CMOS input to a defined rail.

## License

MIT. See `LICENSE`.
