#!/usr/bin/env python3
"""Skryer acoustic direction-finding (GCC-PHAT / SRP-PHAT) for the DIY 4-mic array.

Reads sample-synchronized 4-channel audio frames from the Teensy over USB serial
(see hardware/firmware/skryer_mic_array) and estimates the bearing of a sound
source by SRP-PHAT: for each candidate direction, sum the PHAT-weighted cross-
correlation of every mic pair at that direction's expected time-difference.

Run WITHOUT hardware to verify the math first:
    python doa.py --selftest

Run with the array:
    python doa.py --port /dev/ttyACM0        # macOS: /dev/cu.usbmodem*  Win: COMx
    python doa.py --port /dev/ttyACM0 --raw  # just print per-channel RMS (bring-up)

Deps:  pip install numpy pyserial
"""
import argparse
import struct
import sys

import numpy as np

# ---------------------------------------------------------------------------
# Config — MUST match the physical build (see hardware/WIRING.md)
# ---------------------------------------------------------------------------
FS = 44100.0          # Audio Library fixed sample rate
C = 343.0             # speed of sound (m/s) ~20 C; adjust for temperature
D = 0.05              # square side length (m)

# Mic positions in metres, X=right, Y=forward, Z=up. Order = audio ch0..ch3.
# Default: 5 cm square in the XY plane (planar => azimuth only, elevation is
# ambiguous). For true 3D, raise one mic (give it a non-zero Z) and add an
# elevation grid below.
MIC_POSITIONS = np.array([
    [+D / 2, +D / 2, 0.0],   # ch0  front-right
    [-D / 2, +D / 2, 0.0],   # ch1  front-left
    [-D / 2, -D / 2, 0.0],   # ch2  back-left
    [+D / 2, -D / 2, 0.0],   # ch3  back-right
])

WINDOW = 4096         # samples per DoA estimate (~93 ms)
AZ_STEP_DEG = 2.0     # azimuth grid resolution
EL_GRID_DEG = [0.0]   # planar array: elevation fixed at 0. Expand for 3D arrays.

# Wire format (see the .ino)
MAGIC = b"\xAA\x55"
SAMPLES_PER_FRAME = 128
N_CH = 4
PAYLOAD = SAMPLES_PER_FRAME * 2          # bytes per channel per frame
FRAME_BYTES = 2 + 4 + N_CH * PAYLOAD     # magic + index + 4 channels


# ---------------------------------------------------------------------------
# DoA core
# ---------------------------------------------------------------------------
def gcc_phat(x, y):
    """PHAT-weighted cross-correlation of x vs y. Returns (cc, lags_seconds),
    lags monotonically increasing so np.interp can sample at an arbitrary tau."""
    n = len(x) + len(y)
    nfft = 1 << int(np.ceil(np.log2(n)))
    X = np.fft.rfft(x, nfft)
    Y = np.fft.rfft(y, nfft)
    R = X * np.conj(Y)
    R /= np.abs(R) + 1e-12               # PHAT: keep phase, flatten magnitude
    cc = np.fft.irfft(R, nfft)
    half = nfft // 2
    cc = np.concatenate((cc[-half:], cc[:half]))
    lags = np.arange(-half, half) / FS
    return cc, lags


def direction_vector(az_rad, el_rad):
    """Unit vector pointing toward the source."""
    return np.array([
        np.cos(el_rad) * np.cos(az_rad),
        np.cos(el_rad) * np.sin(az_rad),
        np.sin(el_rad),
    ])


# Precompute the mic pairs once.
_PAIRS = [(i, j) for i in range(N_CH) for j in range(i + 1, N_CH)]


def srp_phat(channels):
    """channels: (4, WINDOW) float array. Returns (az_deg, el_deg, score, sharpness)."""
    # GCC-PHAT for every pair, once.
    ccs = {}
    for (i, j) in _PAIRS:
        ccs[(i, j)] = gcc_phat(channels[i], channels[j])

    az_grid = np.deg2rad(np.arange(0.0, 360.0, AZ_STEP_DEG))
    el_grid = np.deg2rad(np.array(EL_GRID_DEG))

    best = (-np.inf, 0.0, 0.0)
    scores = []
    for el in el_grid:
        for az in az_grid:
            d = direction_vector(az, el)
            total = 0.0
            for (i, j) in _PAIRS:
                # TDOA_ij = t_i - t_j for a far-field plane wave from dir d.
                tau = -((MIC_POSITIONS[i] - MIC_POSITIONS[j]) @ d) / C
                cc, lags = ccs[(i, j)]
                total += np.interp(tau, lags, cc)
            scores.append(total)
            if total > best[0]:
                best = (total, np.rad2deg(az), np.rad2deg(el))

    scores = np.asarray(scores)
    # Sharpness: how much the peak stands out from the mean (1.0 = flat/no source).
    sharpness = best[0] / (scores.mean() + 1e-12)
    return best[1], best[2], best[0], sharpness


# ---------------------------------------------------------------------------
# Serial reader
# ---------------------------------------------------------------------------
def read_frames(port, baud=2000000):
    """Generator yielding (frame_index, (4, 128) int16 array) from the Teensy."""
    import serial  # pyserial
    ser = serial.Serial(port, baud, timeout=1)
    buf = bytearray()
    while True:
        chunk = ser.read(FRAME_BYTES)
        if not chunk:
            continue
        buf.extend(chunk)
        # Resync to magic if needed.
        idx = buf.find(MAGIC)
        if idx < 0:
            if len(buf) > 4 * FRAME_BYTES:
                del buf[:-1]
            continue
        if idx > 0:
            del buf[:idx]
        if len(buf) < FRAME_BYTES:
            continue
        frame = bytes(buf[:FRAME_BYTES])
        del buf[:FRAME_BYTES]
        (frame_index,) = struct.unpack_from("<I", frame, 2)
        flat = np.frombuffer(frame, dtype="<i2", offset=6, count=N_CH * SAMPLES_PER_FRAME)
        yield frame_index, flat.reshape(N_CH, SAMPLES_PER_FRAME)


def run_live(port, raw=False):
    window = np.zeros((N_CH, 0), dtype=np.float32)
    last_index = None
    for frame_index, block in read_frames(port):
        if last_index is not None and frame_index != last_index + 1:
            print(f"[warn] dropped {frame_index - last_index - 1} frame(s) "
                  f"-> channels may be desynced", file=sys.stderr)
        last_index = frame_index

        if raw:
            rms = np.sqrt((block.astype(np.float32) ** 2).mean(axis=1))
            print("ch RMS: " + "  ".join(f"{v:7.1f}" for v in rms))
            continue

        window = np.concatenate([window, block.astype(np.float32)], axis=1)
        if window.shape[1] >= WINDOW:
            az, el, score, sharp = srp_phat(window[:, -WINDOW:])
            window = window[:, -WINDOW:]
            flag = "" if sharp > 1.5 else "   (weak — likely no source)"
            print(f"bearing az={az:6.1f}  el={el:5.1f}  sharpness={sharp:4.2f}{flag}")


# ---------------------------------------------------------------------------
# Self-test — synthesize a plane wave from a known angle, no hardware needed
# ---------------------------------------------------------------------------
def _frac_delay(x, d_samples):
    n = len(x)
    X = np.fft.rfft(x)
    k = np.arange(len(X))
    X = X * np.exp(-2j * np.pi * k * d_samples / n)
    return np.fft.irfft(X, n)


def synth(az_true_deg, el_true_deg=0.0, snr_db=20.0, n=WINDOW, seed=0):
    rng = np.random.default_rng(seed)
    base = rng.standard_normal(n)
    d = direction_vector(np.deg2rad(az_true_deg), np.deg2rad(el_true_deg))
    chans = np.empty((N_CH, n), dtype=np.float64)
    sig_p = base.var()
    noise_std = np.sqrt(sig_p / (10 ** (snr_db / 10)))
    for c in range(N_CH):
        tau = -(MIC_POSITIONS[c] @ d) / C        # arrival time at mic c
        chans[c] = _frac_delay(base, tau * FS) + rng.standard_normal(n) * noise_std
    return chans


def run_selftest():
    print("Self-test: recover known bearings from synthetic plane waves "
          f"(array=5cm square, az grid {AZ_STEP_DEG} deg)\n")
    worst = 0.0
    for true_az in [0, 45, 90, 135, 180, 225, 270, 315]:
        chans = synth(true_az, snr_db=20.0, seed=true_az)
        az, el, score, sharp = srp_phat(chans)
        err = abs((az - true_az + 180) % 360 - 180)
        worst = max(worst, err)
        print(f"  true az={true_az:3d}  ->  est az={az:6.1f}  "
              f"err={err:4.1f} deg  sharpness={sharp:4.2f}")
    print(f"\nworst error: {worst:.1f} deg  "
          f"({'PASS' if worst <= 2 * AZ_STEP_DEG else 'CHECK geometry/grid'})")
    print("If this passes, the DoA math + geometry are correct; bugs after this "
          "are wiring/sync (run the known-angle test in hardware/WIRING.md).")


def main():
    ap = argparse.ArgumentParser(description="Skryer acoustic DoA (SRP-PHAT).")
    ap.add_argument("--port", help="serial port of the Teensy (e.g. /dev/ttyACM0)")
    ap.add_argument("--raw", action="store_true", help="print per-channel RMS only")
    ap.add_argument("--selftest", action="store_true", help="run without hardware")
    args = ap.parse_args()

    if args.selftest:
        run_selftest()
    elif args.port:
        run_live(args.port, raw=args.raw)
    else:
        ap.error("give --port <serial> for live mode, or --selftest")


if __name__ == "__main__":
    main()
