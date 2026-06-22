# Skryer — Acoustic-Cued Drone-Detection Sentry

> *Scry* — to perceive what's hidden, to see at a distance.

Skryer is a cheap, **passive acoustic early-warning layer** for spotting non-cooperative drones,
with one slick operator console. A small network of **perched, motors-off (silent) microphone-array
nodes** each hears a drone and computes a bearing; the bearings are **triangulated to a 3D track
with range**, and a **ground/mast PTZ camera** slews to confirm and identify the threat. Built in
public as a portfolio piece, AI-assisted end to end.

**Live demo:** [skryer.ca](https://skryer.ca) — the operator console running on a built-in mock
contact source (no hardware required), including the streamed LLM operator briefing.

## Why acoustic + vision (not RF)

*Passive* RF counter-UAS is beaten by **RF-silent fiber-optic FPV drones** (fielded in Ukraine from
2024; NATO ran a 2025 innovation challenge on exactly this gap). Skryer leads with *hearing* and
*seeing* — modalities a fiber-optic drone can't hide from — and emits nothing, so it survives the
electronic-warfare environment where those threats appear. (Honest caveat: *radar* still detects
fiber-optic FPVs; acoustic's edge over radar is being passive, cheap, and good at low altitude — not
out-detecting it.)

## How it works

1. **Perch (silent listen).** Each node sits with motors off → zero ego-noise → acoustic detection
   at max range with clean bearings; each computes its own bearing locally.
2. **Triangulate (direction + range).** ≥3 nodes share bearings over a low-rate **Meshtastic LoRa
   mesh**; a ground station fuses them (AoA triangulation) into a 3D track — the thing a single
   array can't give.
3. **Confirm (ground camera).** A ground/mast PTZ camera slews to the fused bearing and zooms to
   visually confirm/ID. Skryer is the **detect-and-cue** layer — it hands a track to an effector; it
   is not the shooter.

> **Honest envelope.** Per-node detection is short range (tens-to-low-hundreds of metres for FPVs,
> up to ~km for loud Shahed-class). Useful warning time comes from forward-deploying the nodes as a
> perimeter ring (standoff buys reaction time), and the system is a **complementary passive layer**
> in a layered defence — not a long-range or standalone solution.

## Stack

- **Ground station / fusion:** Python — FastAPI + asyncio, MQTT internal bus, NumPy/SciPy (acoustic
  triangulation), OpenCV + YOLO (vision on the PTZ feed).
- **Per node:** DIY 4× INMP441 I2S array + Teensy 4.0 — the Teensy both **captures** (sample-synced
  I2S-quad) and runs **SRP-PHAT direction-finding on-board** (no Pi), then hands the bearing over a
  3-wire UART to a **Heltec V3** running Meshtastic, which ships the ~10–20 byte bearing over LoRa.
- **Frontend:** React + TypeScript, MapLibre GL + deck.gl, live WebSocket feed.
- **LLM briefing:** a streamed, eval-gated natural-language operator briefing grounded on the live
  contact data — see [`docs/llm-briefing.md`](docs/llm-briefing.md).
- **Ops:** Docker Compose, systemd with auto-restart + stalled-stream watchdog.

## Repo layout

```
backend/    FastAPI server — /health + /ws/contacts live feed + /ws/briefing (see backend/README.md)
frontend/   React + TS + MapLibre operator console (see frontend/README.md)
acoustic/   SRP-PHAT direction-finding (Python reference) + bench-test logger
hardware/   wiring + Teensy firmware: mic-array capture, and the on-node C++ DoA port
docs/       design notes (the LLM briefing layer)
```

The backend currently serves a **mock contact source** (synthetic drones closing on the perched
node) so the UI is live before any sensor hardware exists. The real acoustic DoA and vision
pipelines drop in behind the same `Contact` model.

## Quickstart (dev)

Two terminals:

```bash
# terminal 1 — backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload          # http://localhost:8000

# terminal 2 — frontend
cd frontend
npm install
npm run dev                            # http://localhost:5173
```

Open http://localhost:5173 — the node sits at centre and synthetic drone contacts should appear on
bearing rays, escalating from amber acoustic cues to red confirmed drones as they close. The LLM
briefing layer is optional and needs an `ANTHROPIC_API_KEY` (see `backend/.env.example` and
`docs/llm-briefing.md`); everything else runs without it.

## Status

🚧 **In progress (2026).** Scaffold + bench DoA code built and verified; the operator console and
the streamed LLM briefing are live on [skryer.ca](https://skryer.ca). The **on-node SRP-PHAT C++
port** (`hardware/firmware/skryer_doa/`) is host-validated — it recovers known bearings to the grid
limit (≤2°) with real-time headroom on the Teensy 4.0. Next: wire one array, validate on-device,
then prove **multi-node triangulation → bearing + range** over the Meshtastic mesh → ground-camera
confirm. The deliverable is the **detect → range → confirm** demo; flight/mobility is a v2 roadmap
direction, not in the current build.
