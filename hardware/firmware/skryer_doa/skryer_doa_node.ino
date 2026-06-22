// skryer_doa_node.ino — on-node bearing computation (Teensy 4.0).
//
// The post-2026-06-18c architecture: each node computes its OWN bearing on the
// Teensy (no laptop, no Pi) and sends ~a few bytes to a Heltec V3 over UART; the
// Heltec puts it on the Meshtastic LoRa mesh; the laptop fuses 3 nodes' bearings
// into a triangulated track. This sketch is the Teensy half.
//
// Pipeline:  I2S-quad capture (4x INMP441, sample-synced)  ->  accumulate one
//            WINDOW (4096 samples)  ->  srp_phat()  ->  emit bearing on:
//              - USB Serial   (debug / bench validation against acoustic/doa.py)
//              - Serial1 UART (-> Heltec V3 Meshtastic Serial module -> mesh)
//
// Wiring: array per hardware/WIRING.md; Teensy<->Heltec UART per the new
// "Teensy -> Heltec UART" section there (TX1=pin1 -> Heltec RX, GND<->GND).
//
// Board: Teensy 4.0 | USB Type: Serial | Requires: Teensyduino (Audio library).
//
// PERF: skryer_doa.cpp uses the portable fft.h by default so this builds with
// zero extra libraries. For production speed, swap to CMSIS arm_rfft_fast_f32
// (see README.md -> "Porting to CMSIS"); the .ino does not change.

#include <Audio.h>
#include "skryer_doa.h"

using namespace skryer;

AudioInputI2SQuad  i2s_quad;
AudioRecordQueue   q0, q1, q2, q3;
AudioConnection    pc0(i2s_quad, 0, q0, 0);
AudioConnection    pc1(i2s_quad, 1, q1, 0);
AudioConnection    pc2(i2s_quad, 2, q2, 0);
AudioConnection    pc3(i2s_quad, 3, q3, 0);

// One WINDOW of float audio per channel (DMAMEM => RAM2, keeps RAM1 free).
DMAMEM float chbuf[N_CH][WINDOW];
static float* const CH[N_CH] = {chbuf[0], chbuf[1], chbuf[2], chbuf[3]};
static int fill = 0;                          // samples accumulated so far

const int BLOCK = 128;                         // Audio Library block size
HardwareSerial& MESH = Serial1;                // UART to the Heltec V3

void setup() {
  AudioMemory(60);
  Serial.begin(2000000);                       // USB debug
  MESH.begin(115200);                          // UART -> Heltec (Meshtastic Serial module)
  doa_init();
  q0.begin(); q1.begin(); q2.begin(); q3.begin();
}

// Append one synchronized 128-sample block from all four channels.
static void append_block(int16_t* b0, int16_t* b1, int16_t* b2, int16_t* b3) {
  for (int i = 0; i < BLOCK; ++i) {
    chbuf[0][fill + i] = (float)b0[i];
    chbuf[1][fill + i] = (float)b1[i];
    chbuf[2][fill + i] = (float)b2[i];
    chbuf[3][fill + i] = (float)b3[i];
  }
  fill += BLOCK;
}

void loop() {
  // Stay sample-aligned: only consume when all four queues have a block.
  if (q0.available() && q1.available() && q2.available() && q3.available()) {
    append_block(q0.readBuffer(), q1.readBuffer(), q2.readBuffer(), q3.readBuffer());
    q0.freeBuffer(); q1.freeBuffer(); q2.freeBuffer(); q3.freeBuffer();

    if (fill >= WINDOW) {
      uint32_t t0 = micros();
      DoaResult r = srp_phat(CH, WINDOW);
      uint32_t dt = micros() - t0;

      bool detected = r.sharpness > 1.5f;      // matches doa.py's gate

      // Debug line (USB) — compare directly against acoustic/doa.py output.
      Serial.printf("bearing az=%6.1f  el=%5.1f  sharp=%4.2f  %s  (%lu us)\n",
                    r.az_deg, r.el_deg, r.sharpness, detected ? "DET" : " . ", dt);

      // Mesh payload (UART -> Heltec) — only send real detections to keep the
      // LoRa duty cycle tiny. Compact CSV; the laptop fuser tags it with this
      // node's surveyed position+heading. TODO: match the Heltec Meshtastic
      // Serial module framing (TEXTMSG mode) once the radio is configured.
      if (detected) {
        MESH.printf("B,%.1f,%.2f\n", r.az_deg, r.sharpness);
      }

      fill = 0;                                // next window (no overlap)
    }
  }
}
