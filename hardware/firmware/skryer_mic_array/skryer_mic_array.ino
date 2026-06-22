// skryer_mic_array.ino — 4-channel synchronized I2S capture -> USB serial
//
// Teensy 4.0 + 4x INMP441 in I2S-quad mode. Streams raw int16 audio frames to
// the laptop, which runs GCC-PHAT / SRP-PHAT direction-finding (see acoustic/doa.py).
//
// Wiring (full detail in hardware/WIRING.md):
//   Shared:  SCK->pin21 (BCLK)  WS->pin20 (LRCLK)  VDD->3V3  GND->GND
//   DATA1 = pin 8 (IN1): Mic0 (L/R->GND => ch0), Mic1 (L/R->3V3 => ch1)
//   DATA2 = pin 6 (IN2): Mic2 (L/R->GND => ch2), Mic3 (L/R->3V3 => ch3)
//
// The Audio Library is fixed at 44100 Hz, 16-bit, 128-sample blocks. All four
// channels are captured on the same I2S clock, so they are sample-synchronized;
// we keep them aligned by only ever emitting a frame when ALL four queues have a
// block ready, and reading exactly one block from each.
//
// Wire format, little-endian, per 128-sample frame (1030 bytes):
//   [0xAA][0x55]                       magic
//   [uint32 frame_index]               increments by 1; gaps => dropped frames
//   [ch0: 128 x int16][ch1 ...][ch2][ch3]   planar, 256 bytes per channel
//
// Requires: Teensyduino (Audio library). Board: Teensy 4.0. USB Type: Serial.

#include <Audio.h>

AudioInputI2SQuad  i2s_quad;
AudioRecordQueue   q0, q1, q2, q3;
AudioConnection    pc0(i2s_quad, 0, q0, 0);
AudioConnection    pc1(i2s_quad, 1, q1, 0);
AudioConnection    pc2(i2s_quad, 2, q2, 0);
AudioConnection    pc3(i2s_quad, 3, q3, 0);

const uint8_t MAGIC0 = 0xAA;
const uint8_t MAGIC1 = 0x55;

uint32_t frame_index = 0;

void setup() {
  AudioMemory(60);            // generous headroom for 4 buffered queues
  Serial.begin(2000000);      // USB CDC: baud is ignored, runs at USB speed
  q0.begin(); q1.begin(); q2.begin(); q3.begin();
}

void loop() {
  // Emit only when all four channels have a block -> stay sample-aligned.
  if (q0.available() && q1.available() && q2.available() && q3.available()) {
    int16_t *b0 = q0.readBuffer();
    int16_t *b1 = q1.readBuffer();
    int16_t *b2 = q2.readBuffer();
    int16_t *b3 = q3.readBuffer();

    Serial.write(MAGIC0);
    Serial.write(MAGIC1);
    Serial.write((const uint8_t *)&frame_index, 4);

    Serial.write((const uint8_t *)b0, 256);   // 128 int16
    Serial.write((const uint8_t *)b1, 256);
    Serial.write((const uint8_t *)b2, 256);
    Serial.write((const uint8_t *)b3, 256);

    q0.freeBuffer(); q1.freeBuffer(); q2.freeBuffer(); q3.freeBuffer();
    frame_index++;
  }
}
