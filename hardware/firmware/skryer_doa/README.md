# skryer_doa — on-node SRP-PHAT (Teensy 4.0 C++ port of `acoustic/doa.py`)

The 2026-06-18c architecture moves direction-finding **onto the Teensy**: each node
computes its own bearing and ships ~a few bytes to a Heltec V3 over UART, which
puts it on the Meshtastic LoRa mesh. This folder is that port, plus a host
harness to **prove it works before any hardware is ordered**.

## Why this exists / what it proves

The make-or-break question from the pivot was: *can the verified Python SRP-PHAT
run on the Teensy, at the same accuracy, fast enough to be real-time?* This
scaffolding answers **yes** with a runnable test — the algorithm compiles and is
validated on a laptop (no Teensy needed) against the same self-test `doa.py` uses.

## Files

| File | Role |
|------|------|
| `skryer_doa.h` / `.cpp` | The SRP-PHAT core. Geometry/constants kept identical to `acoustic/doa.py`. Compiles on host **and** Teensy. |
| `fft.h` | Portable radix-2 FFT so the core runs anywhere. On Teensy, swap for CMSIS `arm_rfft_fast_f32` for speed (see below). |
| `selftest.cpp` | Host harness — synthesizes known-bearing plane waves, checks recovery + times the compute. Guarded out of the Arduino build. |
| `skryer_doa_node.ino` | Teensy sketch: I2S-quad capture → `srp_phat()` → bearing out USB + UART to the Heltec. |
| `Makefile` | `make test` builds + runs the host self-test. |

## Run the feasibility test (host, no hardware)

```sh
make test
```

Expected (matches `python3 ../../../acoustic/doa.py --selftest`):

```
worst error: 2.0 deg  (PASS)
per-estimate compute (this host, portable radix-2 FFT): ~1.2 ms
```

PASS = worst azimuth error ≤ 2× the grid step (4°), the same bar `doa.py` uses.
The C++ port lands at **≤2°**, the grid limit — i.e. the port is correct.

## Feasibility verdict (the point of all this)

**Accuracy:** identical to the Python reference (≤2° on the 2° grid), in `float32`,
using a 4096-pt **circular** GCC-PHAT (valid because the true inter-mic delay is
≤ diagonal/c ≈ 9 samples — tiny vs the window, so no zero-pad is needed). 4096 is
also the max length CMSIS `arm_rfft_fast_f32` supports, so this is the on-device
ceiling and we sit right at it.

**Compute:** one estimate = 4 forward + 6 inverse FFTs + a 180×6 grid steer.
- Host (x86, *naive* portable FFT): **~1.2 ms** — already 74× faster than the
  93 ms of audio each window represents.
- Teensy 4.0 (600 MHz M7 + FPU, CMSIS `arm_rfft_fast_f32`): a 4096-pt real FFT
  benches ≈ 150–250 µs on the M7, so 10 FFTs ≈ **~2–2.5 ms/estimate** incl. the
  PHAT step and grid (grid is ~10 µs). That's **~35–45× real-time headroom** —
  plenty, even with overlap for faster updates. *(Estimated from published CMSIS
  M7 FFT benchmarks; confirm with the on-device `micros()` print in the sketch.)*

**Memory:** static scratch ≈ 256 KB (`g_spec` 128 KB + `g_cc` 96 KB + `g_R` 32 KB)
of the Teensy 4.0's 1 MB. Fits; put the big buffers in `DMAMEM` (RAM2) to keep
RAM1 free. CMSIS real-FFT (half-spectrum) roughly halves `g_spec`.

**Bottom line: the Teensy-only node is feasible — comfortably real-time, same
accuracy, fits in RAM. Safe to order the parts.**

## Porting to CMSIS (production speed, on-device)

The portable `fft.h` is for validation and works on ARM too (just slower). For
real deployment, in `skryer_doa.cpp` replace the `fft()` calls with CMSIS-DSP:

- `arm_rfft_fast_instance_f32` initialized once for `WINDOW` (forward + inverse).
- Forward each channel → real-FFT half-spectrum; PHAT-normalize the complex bins;
  inverse-FFT back to the cross-correlation.
- CMSIS ships with Teensyduino (`arm_math.h`); no extra install.

Only `skryer_doa.cpp` changes — `skryer_doa.h`, the sketch, and the host test stay
as-is, so `make test` keeps validating the algorithm.

## Keep in sync with `acoustic/doa.py`

`MIC_POS`, `D_SIDE`, `FS`, `C_SOUND`, `AZ_STEP_DEG`, and `WINDOW` here mirror the
Python. If the physical array changes, update **both** or the bearings diverge.
The gate before trusting any hardware bearing is still the known-angle clap test
in `hardware/WIRING.md`.
