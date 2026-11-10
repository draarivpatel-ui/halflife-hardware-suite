// HelicalDesk: Parametric 3-Stage Snap-Fit Instrument Stand & Rotary Detent Pod
// OpenSCAD source for Hack Club Half Life Week 2 and Hack Club Atlantis.
//
// All dimensions are in millimetres. Every parameter below is exposed to the
// OpenSCAD Customizer (Design > Customizer in OpenSCAD 2021.01 or newer) via
// the bracketed annotations. The same numeric set is mirrored in
// tools/generate_suite_artifacts.js so that the checked-in STL and OBJ files
// are deterministic reproductions of this model.
//
// Print settings: PLA, 0.2 mm layer height, 3 perimeters, 15% infill, no
// supports needed. Snap tabs are oriented to print flat on the build plate.
// Allow 0.2 mm clearance on the hinge bore for an M2.5 screw.

/* [Chassis] */
chassis_w = 92;        // [60:140] Overall chassis width
chassis_d = 64;        // [40:100] Overall chassis depth
chassis_h = 8;         // [4:16] Base plate thickness
rim = 3.2;             // [2:6] Raised perimeter rim width
rim_h = 2.2;           // [1:5] Raised perimeter rim height
boss_r = 6.4;          // [4:12] Central rotary boss outer radius
boss_bore = 2.6;       // [2:4] M2.5 clearance bore radius
boss_h = 5.0;          // [2:10] Boss height above base plate

/* [Tilt cradle] */
cradle_w = 62;         // [40:90] Instrument cradle width
cradle_d = 44;         // [30:70] Instrument cradle depth
cradle_h = 5;          // [3:10] Cradle floor thickness
cheek_w = 3.0;         // [2:6] Side cheek wall thickness
cheek_h = 10;          // [5:20] Side cheek height
rear_lip_h = 6;        // [3:12] Rear stop lip height
hinge_r = 5.2;         // [3:9] Cradle hinge boss radius

/* [Detent dial] */
dial_r = 21;           // [12:35] Dial outer radius
dial_h = 6;            // [3:12] Dial thickness
dial_bore = 2.6;       // [2:4] Dial bore radius
detents = 12;          // [6:24] Number of radial detent teeth
tooth_in = 0.9;        // [0.4:2] Tooth radial inset
tooth_out = 1.4;       // [0.5:3] Tooth radial protrusion
tooth_half = 0.85;     // [0.4:2] Tooth half width

/* [Snap fit] */
snap_len = 3.0;        // [1.5:6] Latch tab length
snap_w = 1.6;          // [0.8:3] Latch tab width
snap_h = 1.1;          // [0.5:2] Latch tab height
snap_count = 3;        // [2:5] Number of latch tabs
clearance = 0.2;       // [0.1:0.5] Print clearance on mating bores

/* [Assembly] */
cradle_dx = 15;        // [0:30] Cradle X offset in assembled preview
cradle_dy = 10;        // [0:25] Cradle Y offset in assembled preview
cradle_dz = 12;        // [0:25] Cradle Z offset in assembled preview
dial_dz = 15;          // [0:25] Dial Z offset in assembled preview
$fn = 48;              // [16:96] Circle tessellation segments

module ring(r_out, r_in, h) {
  difference() {
    cylinder(h = h, r = r_out);
    translate([0, 0, -1])
      cylinder(h = h + 2, r = r_in);
  }
}

module base_chassis() {
  // Solid base plate.
  cube([chassis_w, chassis_d, chassis_h]);
  // Raised perimeter rim built as four bars so the center stays open.
  translate([0, 0, chassis_h])
    cube([chassis_w, rim, rim_h]);
  translate([0, chassis_d - rim, chassis_h])
    cube([chassis_w, rim, rim_h]);
  translate([0, rim, chassis_h])
    cube([rim, chassis_d - 2 * rim, rim_h]);
  translate([chassis_w - rim, rim, chassis_h])
    cube([rim, chassis_d - 2 * rim, rim_h]);
  // Rotary boss with an M2.5 through bore.
  translate([chassis_w / 2, chassis_d / 2, chassis_h])
    ring(boss_r, boss_bore, boss_h);
  // Rear snap-fit latch tabs, evenly spaced along the rear rim.
  for (i = [0 : snap_count - 1]) {
    x = 18 + i * ((chassis_w - 36) / max(1, snap_count - 1));
    translate([x, chassis_d - rim - snap_len, chassis_h + rim_h])
      cube([snap_w, snap_len, snap_h]);
  }
}

module tilt_cradle() {
  cube([cradle_w, cradle_d, cradle_h]);
  // Side cheeks hold the instrument at a fixed angle.
  translate([0, 0, cradle_h])
    cube([cheek_w, cradle_d, cheek_h]);
  translate([cradle_w - cheek_w, 0, cradle_h])
    cube([cheek_w, cradle_d, cheek_h]);
  // Rear stop lip.
  translate([0, cradle_d - 3, cradle_h])
    cube([cradle_w, 3, rear_lip_h]);
  // Hinge boss that mates with the chassis rotary boss.
  translate([cradle_w / 2, cradle_d / 2, cradle_h])
    ring(hinge_r, boss_bore + clearance, 2.4);
  // Front snap receivers spaced to match the chassis latch tabs.
  for (i = [0 : snap_count - 1]) {
    x = 8 + i * ((cradle_w - 16 - snap_w) / max(1, snap_count - 1));
    translate([x, 0, cradle_h + 0.4])
      cube([snap_w + 0.4, snap_len, 1.4]);
  }
}

module detent_dial() {
  ring(dial_r, dial_bore, dial_h);
  // Radial detent teeth. Each tooth is a rotated closed box so the result is
  // a single manifold solid without a boolean union.
  for (i = [0 : detents - 1]) {
    a = 360 * i / detents;
    rotate([0, 0, a])
      translate([dial_r - tooth_in, -tooth_half, dial_h * 0.25])
        cube([tooth_in + tooth_out, 2 * tooth_half, dial_h * 0.55]);
  }
}

// Render one part at a time by commenting out the other two calls, or use the
// assembled_preview module to see all three stages stacked for a screenshot.
module assembled_preview() {
  base_chassis();
  translate([cradle_dx, cradle_dy, cradle_dz]) tilt_cradle();
  translate([chassis_w / 2, chassis_d / 2, dial_dz]) detent_dial();
}

// Default render: all three printable parts laid out side by side.
translate([0, 0, 0]) base_chassis();
translate([chassis_w + 14, 0, 0]) tilt_cradle();
translate([chassis_w + cradle_w + 30, 0, 0]) detent_dial();
