# Skryer backend

FastAPI + asyncio server. Today it serves a **mock contact source** so the UI
shell is live before any hardware exists; the real acoustic DoA + vision
pipelines drop in behind the same `Contact` model.

## Layout

```
app/
  main.py        FastAPI app: /health + /ws/contacts WebSocket
  models.py      Contact / Alert data models (shared contract with the UI)
  mock.py        synthetic approaching-drone feed for now (perch-and-listen demo)
  acoustic/      mic-array direction-of-arrival cue — stub
  vision/        camera + small-object detector (confirm/ID) — stub
  fusion/        acoustic + vision → confirmed contact + alerts — stub
```

## Run (dev)

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

- Health: http://localhost:8000/health
- Live contacts: `ws://localhost:8000/ws/contacts` (JSON array of contacts ~1 Hz)
