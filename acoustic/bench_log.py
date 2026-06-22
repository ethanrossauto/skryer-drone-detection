#!/usr/bin/env python3
"""Skryer bench-test logger — record range-test runs + bearings to CSV.

Wraps the live DoA pipeline (acoustic/doa.py) and appends one row per DoA
estimate to a CSV, tagged with the run's metadata (distance, true bearing,
label). Prints a summary at the end so each run answers "at this range, how
often did we detect, and how accurate was the bearing?".

Examples:
    # 20 s run, drone parked 15 m away at 90 deg to the array front:
    python bench_log.py --port /dev/ttyACM0 --distance 15 --true-az 90 --label backyard-r1

    # open-ended run (Ctrl-C to stop), no known angle:
    python bench_log.py --port /dev/ttyACM0 --distance 30 --label far

Deps:  pip install numpy pyserial   (same as doa.py)
"""
import argparse
import csv
import os
import sys
import time

import numpy as np

from doa import read_frames, srp_phat, WINDOW, N_CH, SAMPLES_PER_FRAME

DETECT_SHARPNESS = 1.5            # peak/mean above this == "detected" (matches doa.py)
FIELDS = [
    "iso_time", "label", "distance_m", "true_az_deg",
    "est_az_deg", "est_el_deg", "sharpness", "az_error_deg", "detected",
]


def az_error(est, true):
    if true is None:
        return ""
    return abs((est - true + 180.0) % 360.0 - 180.0)


def run(args):
    new_file = not os.path.exists(args.out)
    fh = open(args.out, "a", newline="")
    writer = csv.DictWriter(fh, fieldnames=FIELDS)
    if new_file:
        writer.writeheader()

    print(f"Logging to {args.out}  (label={args.label}, distance={args.distance} m, "
          f"true_az={args.true_az})")
    print("Ctrl-C to stop." if args.duration is None
          else f"Running for {args.duration} s.")

    window = np.zeros((N_CH, 0), dtype=np.float32)
    rows = []
    t0 = time.time()
    try:
        for _frame_index, block in read_frames(args.port):
            window = np.concatenate([window, block.astype(np.float32)], axis=1)
            if window.shape[1] >= WINDOW:
                az, el, _score, sharp = srp_phat(window[:, -WINDOW:])
                window = window[:, -WINDOW:]
                err = az_error(az, args.true_az)
                detected = sharp > DETECT_SHARPNESS
                row = {
                    "iso_time": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "label": args.label,
                    "distance_m": args.distance,
                    "true_az_deg": "" if args.true_az is None else args.true_az,
                    "est_az_deg": round(az, 1),
                    "est_el_deg": round(el, 1),
                    "sharpness": round(sharp, 2),
                    "az_error_deg": "" if err == "" else round(err, 1),
                    "detected": int(detected),
                }
                writer.writerow(row)
                fh.flush()
                rows.append(row)
                mark = "DET" if detected else "  ."
                print(f"  [{mark}] az={az:6.1f}  el={el:5.1f}  sharp={sharp:4.2f}"
                      + ("" if err == "" else f"  err={err:4.1f}"))
            if args.duration is not None and time.time() - t0 >= args.duration:
                break
    except KeyboardInterrupt:
        print("\nstopped.")
    finally:
        fh.close()

    summarize(rows, args)


def summarize(rows, args):
    if not rows:
        print("no estimates recorded.")
        return
    n = len(rows)
    det = [r for r in rows if r["detected"]]
    print(f"\n--- summary: {args.label} @ {args.distance} m ---")
    print(f"windows: {n}   detected: {len(det)} ({100 * len(det) / n:.0f}%)")
    if det:
        az = np.array([r["est_az_deg"] for r in det])
        print(f"median bearing (detected): {np.median(az):.1f} deg")
        errs = [r["az_error_deg"] for r in det if r["az_error_deg"] != ""]
        if errs:
            print(f"median |error|: {np.median(errs):.1f} deg   "
                  f"max |error|: {np.max(errs):.1f} deg")
    print(f"(appended to {args.out})")


def main():
    ap = argparse.ArgumentParser(description="Skryer bench-test logger (DoA -> CSV).")
    ap.add_argument("--port", required=True, help="Teensy serial port (e.g. /dev/ttyACM0)")
    ap.add_argument("--distance", type=float, required=True, help="drone distance in metres")
    ap.add_argument("--true-az", type=float, default=None,
                    help="known source azimuth in deg (for error stats); omit if unknown")
    ap.add_argument("--label", default="run", help="short tag for this run")
    ap.add_argument("--duration", type=float, default=None,
                    help="seconds to log; omit to run until Ctrl-C")
    ap.add_argument("--out", default="bench_log.csv", help="CSV file to append to")
    run(ap.parse_args())


if __name__ == "__main__":
    main()
