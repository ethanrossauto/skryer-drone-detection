# Skryer — DIY 4-Mic Array Wiring (Teensy 4.0 + 4× INMP441)

Captures **4 sample-synchronized** mic channels using the Teensy Audio Library's I2S-quad mode.

**Two firmware modes share this exact wiring** (just flash a different sketch):
1. **Bench/validation —** `firmware/skryer_mic_array/`: streams raw int16 frames to the laptop over
   USB, where `../acoustic/doa.py` computes the bearing. Use this to validate the array against the
   reference and run the known-angle clap test.
2. **On-node (the 18c architecture) —** `firmware/skryer_doa/skryer_doa_node.ino`: the Teensy runs
   SRP-PHAT **itself** (C++ port of `doa.py`) and sends the finished bearing to a Heltec V3 over the
   **UART below**. Validate feasibility with no hardware via `firmware/skryer_doa/` → `make test`.

## How the sync works (the whole point)

All four mics share **one bit clock (BCLK)** and **one word-select (WS/LRCLK)**, so every sample is
taken on the same clock edge → the channels are aligned to the sample. Two mics share each data
line: one set to the **left** half of the I2S frame (`L/R → GND`), one to the **right**
(`L/R → 3.3V`). They take turns driving the shared data line and tri-state otherwise — this is by
design, not a bus conflict.

## Channel map

| Audio ch | Teensy data pin | INMP441 `L/R` pin | Suggested physical position |
|----------|-----------------|-------------------|-----------------------------|
| 0 | **8** (IN1) | GND (left)  | front-right corner |
| 1 | **8** (IN1) | 3.3V (right) | front-left corner  |
| 2 | **6** (IN2) | GND (left)  | back-left corner   |
| 3 | **6** (IN2) | 3.3V (right) | back-right corner  |

> The physical positions **must match `MIC_POSITIONS` in `doa.py`**. The default there is a 5 cm
> square in the XY plane, mics in the order above (ch0..ch3 going around the square). If you move a
> mic, update that array or the bearings will be wrong.

## Shared pins (all four mics)

| INMP441 pin | Connect to | Teensy 4.0 pin |
|-------------|------------|----------------|
| VDD | 3.3V | **3V3** (⚠️ not 5V — Teensy 4.0 is **not** 5V-tolerant) |
| GND | GND  | GND |
| SCK | Bit clock (BCLK) | **21** |
| WS  | Word select (LRCLK) | **20** |
| SD  | Serial data | **8** (mics ch0/ch1) or **6** (mics ch2/ch3) |
| L/R | Channel select | GND or 3.3V per the channel map above |

INMP441 does **not** need MCLK (pin 23) — leave it unconnected.

## Diagram

```
                         TEENSY 4.0
                    ┌──────────────────┐
        3V3 ────────┤ 3V3          GND ├──────── GND   (all mics' VDD / GND)
                    │                  │
   BCLK  (pin 21) ──┤ 21               │
   LRCLK (pin 20) ──┤ 20               │
   DATA1 (pin  8) ──┤ 8                │   ← Mic0 (L/R→GND) + Mic1 (L/R→3V3)
   DATA2 (pin  6) ──┤ 6                │   ← Mic2 (L/R→GND) + Mic3 (L/R→3V3)
                    │            USB ──┼──────► laptop (doa.py)
                    └──────────────────┘

   Each INMP441:  VDD→3V3  GND→GND  SCK→21  WS→20  SD→(8 or 6)  L/R→(GND or 3V3)

   Square layout, looking down (+X = right, +Y = forward):
            ch1 ●───────● ch0        side d = 0.05 m (matches doa.py)
                │       │
            ch2 ●───────● ch3
```

## Bring-up order

1. **Wire one mic first** (ch0: SD→8, L/R→GND). Flash the sketch, run `doa.py --raw` and confirm you
   see non-zero samples that respond to sound. This proves clocks + power before you fan out.
2. **Add the other three.** Confirm all four channels show signal.
3. **Sync test (the gate — do this before trusting any drone bearing):** snap your fingers / use a
   clicker from a *measured* angle (e.g. 90° to the right of the array's front). `doa.py` should
   report a bearing within a few degrees of that angle. Repeat at 45° and 0°. If bearings are random
   or always the same, you have a sync/wiring bug — fix that before going further.
4. **Range test:** with the array silent and still, fly the (target) drone and see how far out you
   still get a stable bearing. Log each run with `../acoustic/bench_log.py` (records distance, true
   bearing, estimated bearing, sharpness + detection rate to CSV) — that's the make-or-break Phase 0
   number.

## Teensy → Heltec V3 (Meshtastic) UART

*Only used in the on-node firmware mode (2026-06-18c).* Once the Teensy computes the bearing, it
hands ~a few bytes to the Heltec V3, which runs Meshtastic and puts it on the LoRa mesh. This is a
plain 3.3V UART — **both boards are 3.3V logic, so connect directly, no level shifter.**

| Teensy 4.0 pin | Direction | Heltec V3 pin | Purpose |
|----------------|-----------|---------------|---------|
| **1** (TX1)    | → | Heltec UART **RX** | bearing from Teensy to the mesh radio |
| **0** (RX1)    | ← | Heltec UART **TX** | optional — acks / config back from Heltec |
| **GND**        | — | Heltec **GND**     | **required** common ground for the UART |

- **3 wires** for two-way (TX, RX, GND); **2 wires** if you only push detections out (TX1→RX + GND).
  This is `Serial1` on the Teensy (`MESH.begin(115200)` in the sketch).
- **Power is separate** — the Heltec runs off its own 5V pack (USB-C); do **not** try to power it from
  the Teensy. The only wires between the two boards are the UART signal(s) + the shared GND above.
- **Heltec side:** enable the Meshtastic **Serial module** and point it at the GPIO UART pins you
  wired to (pick a free pair in the Meshtastic config; confirm against your Heltec V3 pinout). The
  sketch currently emits a compact `B,<az>,<sharpness>` CSV line — match it to the Serial module's
  framing (e.g. TEXTMSG mode) when you configure the radio.
- **Wire budget:** 3 UART wires/node × 3 nodes = 9 leads, on top of the mic-array leads — all F/F.

## Notes

- Audio Library runs at a fixed **44100 Hz, 16-bit, 128-sample blocks**. INMP441 is 24-bit but the
  library reads the top 16 bits — plenty for DoA.
- Mic spacing trades off: wider = better low-frequency timing resolution but spatial aliasing above
  ~`c/(2·spacing)` (≈3.4 kHz at 5 cm). 5 cm is a fine starting point for broadband drone noise.
- Keep the data and clock wires short and similar length; long breadboard jumpers are usually fine
  at these speeds but tidy wiring helps.
