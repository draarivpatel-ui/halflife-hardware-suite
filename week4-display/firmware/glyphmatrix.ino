// GlyphMatrix-128 firmware: dual SSD1306 128x64 OLED plus 74HC595 8x8 LED.
// Target: RP2040-Zero, Arduino RP2040 core.
//
// Implements a hardware I2C SSD1306 page-buffer driver with no external
// graphics library, a timer multiplexed 74HC595 scan, and a 5x7 ASCII font
// table. Both displays are refreshed from one 1 kB framebuffer per panel.

#include <Arduino.h>
#include <Wire.h>

static const uint8_t OLED_W = 128;
static const uint8_t OLED_H = 64;
static const uint8_t OLED_PAGES = OLED_H / 8;
static const uint8_t OLED_ADDR[2] = {0x3C, 0x3D};
static const uint8_t PIN_RST = 26;
static const uint8_t PIN_DC = 27;
static const uint8_t PIN_SDA = 4;
static const uint8_t PIN_SCL = 5;
static const uint8_t PIN_MOSI = 6;
static const uint8_t PIN_SCK = 7;
static const uint8_t PIN_LATCH = 8;
static const uint8_t PIN_OE = 9;

static uint8_t framebuffer[2][OLED_PAGES][OLED_W];
static uint8_t ledFrame[8];        // one byte per row, bit 0 is column 0
static volatile uint8_t scanRow = 0;
static struct repeating_timer scanTimer;

// 5x7 classic fixed-space bitmap, 256 glyphs x 5 column bytes. The complete
// table is emitted by tools/generate_suite_artifacts.js into font5x7.js for
// the browser workbench; this compact subset covers ASCII 0x20..0x7F and is
// generated from the same source data.
static const uint8_t FONT5X7[][5] PROGMEM = {
  #include "font5x7_data.h"
};

static inline void oledCommand(uint8_t panel, uint8_t cmd) {
  Wire.beginTransmission(OLED_ADDR[panel]);
  Wire.write(0x00); // control byte: command stream
  Wire.write(cmd);
  Wire.endTransmission();
}

static inline void oledCommand2(uint8_t panel, uint8_t a, uint8_t b) {
  Wire.beginTransmission(OLED_ADDR[panel]);
  Wire.write(0x00); Wire.write(a); Wire.write(b);
  Wire.endTransmission();
}

static void oledInit(uint8_t panel) {
  oledCommand(panel, 0xAE);                 // display off
  oledCommand2(panel, 0xD5, 0x80);         // clock divide
  oledCommand2(panel, 0xA8, OLED_H - 1);   // multiplex
  oledCommand2(panel, 0xD3, 0x00);         // display offset
  oledCommand(panel, 0x40);                // start line 0
  oledCommand2(panel, 0x8D, 0x14);         // charge pump on
  oledCommand2(panel, 0x20, 0x00);         // horizontal addressing
  oledCommand(panel, 0xA1);                // segment remap
  oledCommand(panel, 0xC8);                // COM scan direction
  oledCommand2(panel, 0xDA, 0x12);         // COM pins
  oledCommand2(panel, 0x81, 0x7F);         // contrast
  oledCommand2(panel, 0xD9, 0xF1);         // precharge
  oledCommand2(panel, 0xDB, 0x40);         // VCOM deselect
  oledCommand(panel, 0xA4);                // resume to RAM content
  oledCommand(panel, 0xA6);                // normal, not inverted
  for (uint8_t p = 0; p < OLED_PAGES; p++) {
    oledCommand(panel, 0xB0 | p);
    oledCommand(panel, 0x00);
    oledCommand(panel, 0x10);
  }
  oledCommand(panel, 0xAF);                // display on
}

static void oledFlush(uint8_t panel) {
  for (uint8_t p = 0; p < OLED_PAGES; p++) {
    oledCommand(panel, 0xB0 | p);
    oledCommand(panel, 0x00);
    oledCommand(panel, 0x10);
    // 32 byte I2C chunks stay inside the Wire transfer buffer.
    for (uint8_t x = 0; x < OLED_W; x += 16) {
      Wire.beginTransmission(OLED_ADDR[panel]);
      Wire.write(0x40); // control byte: data stream
      for (uint8_t k = 0; k < 16; k++) Wire.write(framebuffer[panel][p][x + k]);
      Wire.endTransmission();
    }
  }
}

static inline void setPixel(uint8_t panel, int16_t x, int16_t y, bool on) {
  if (x < 0 || x >= OLED_W || y < 0 || y >= OLED_H) return;
  const uint8_t bit = 1 << (y & 7);
  if (on) framebuffer[panel][y >> 3][x] |= bit;
  else framebuffer[panel][y >> 3][x] &= (uint8_t)~bit;
}

static void clearPanel(uint8_t panel, bool on = false) {
  memset(framebuffer[panel], on ? 0xFF : 0x00, OLED_PAGES * OLED_W);
}

// Draw one 5x7 glyph. Columns are LSB-top, matching the glcdfont layout.
static void drawChar(uint8_t panel, int16_t x, int16_t y, char ch, bool on = true) {
  const uint8_t idx = (uint8_t)ch - 0x20;
  if (idx >= (uint8_t)(sizeof(FONT5X7) / sizeof(FONT5X7[0]))) return;
  for (uint8_t c = 0; c < 5; c++) {
    const uint8_t col = pgm_read_byte(&FONT5X7[idx][c]);
    for (uint8_t r = 0; r < 7; r++) if (col & (1 << r)) setPixel(panel, x + c, y + r, on);
  }
}

static void drawString(uint8_t panel, int16_t x, int16_t y, const char *s) {
  while (*s) { drawChar(panel, x, y, *s++); x += 6; }
}

static void drawHLine(uint8_t panel, int16_t x0, int16_t x1, int16_t y) {
  for (int16_t x = x0; x <= x1; x++) setPixel(panel, x, y, true);
}

static void drawVLine(uint8_t panel, int16_t x, int16_t y0, int16_t y1) {
  for (int16_t y = y0; y <= y1; y++) setPixel(panel, x, y, true);
}

// 74HC595: one byte for the eight column lines, one bit for the active row.
// Columns are active LOW (sink), rows are active HIGH (source).
static void shiftOutByte(uint8_t value) {
  for (uint8_t i = 0; i < 8; i++) {
    digitalWrite(PIN_MOSI, (value & (1 << i)) ? HIGH : LOW);
    digitalWrite(PIN_SCK, HIGH);
    digitalWrite(PIN_SCK, LOW);
  }
}

static bool IRAM_ATTR onScan(struct repeating_timer *t) {
  (void)t;
  const uint8_t row = scanRow;
  digitalWrite(PIN_OE, HIGH);              // blank during shift to avoid ghosting
  const uint8_t columns = (uint8_t)~ledFrame[row];
  shiftOutByte((uint8_t)(1 << row));      // second 74HC595 stage, row select
  shiftOutByte(columns);                 // first 74HC595 stage, column select
  digitalWrite(PIN_LATCH, HIGH);
  digitalWrite(PIN_LATCH, LOW);
  digitalWrite(PIN_OE, LOW);
  scanRow = (row + 1) & 7;
  return true;
}

static void renderTelemetry(uint32_t tick) {
  clearPanel(0);
  drawString(0, 2, 2, "GLYPHMATRIX-128");
  drawHLine(0, 0, 127, 12);
  drawString(0, 2, 18, "PANEL 0 / 0x3C");
  drawString(0, 2, 30, "I2C 400KHZ  OK");
  drawString(0, 2, 42, "FPS 007  V3V3");
  drawString(0, 2, 54, "HALF LIFE W4");
  clearPanel(1);
  drawString(1, 2, 2, "HALF LIFE 2026");
  drawHLine(1, 0, 127, 12);
  // Animated bar graph drawn straight into the page buffer.
  for (uint8_t i = 0; i < 8; i++) {
    const uint8_t h = 8 + ((tick / 4 + i * 7) % 40);
    drawVLine(1, 8 + i * 14, 58 - h, 58);
  }
  // Mirror the 8x8 LED frame onto panel 1 as an 8x8 pixel block.
  for (uint8_t r = 0; r < 8; r++) for (uint8_t c = 0; c < 8; c++)
    if (ledFrame[r] & (1 << c)) setPixel(1, 64 + c * 3, 20 + r * 3, true);
}

static void updateLedFrame(uint32_t tick) {
  for (uint8_t r = 0; r < 8; r++) {
    // A rotating diagonal plus a breathing border, all computed as bits.
    uint8_t bits = (uint8_t)(1 << ((tick / 8 + r) & 7));
    if ((tick / 32) & 1) bits |= (r == 0 || r == 7) ? 0xFF : 0x81;
    ledFrame[r] = bits;
  }
}

void setup() {
  Wire.setSDA(PIN_SDA);
  Wire.setSCL(PIN_SCL);
  Wire.begin();
  Wire.setClock(400000);
  pinMode(PIN_RST, OUTPUT);
  pinMode(PIN_DC, OUTPUT);
  digitalWrite(PIN_DC, LOW);
  digitalWrite(PIN_RST, LOW);
  delay(10);
  digitalWrite(PIN_RST, HIGH);
  delay(10);
  pinMode(PIN_MOSI, OUTPUT);
  pinMode(PIN_SCK, OUTPUT);
  pinMode(PIN_LATCH, OUTPUT);
  pinMode(PIN_OE, OUTPUT);
  digitalWrite(PIN_LATCH, LOW);
  digitalWrite(PIN_OE, HIGH);
  oledInit(0);
  oledInit(1);
  add_repeating_timer_us(-1250, onScan, nullptr, &scanTimer); // 100 Hz row x 8
}

void loop() {
  static uint32_t tick = 0;
  updateLedFrame(tick);
  renderTelemetry(tick);
  oledFlush(0);
  oledFlush(1);
  tick++;
  delay(40);
}
