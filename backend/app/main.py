"""Skryer server — FastAPI app exposing health + a live drone-contact WebSocket.

Run (from backend/):  uvicorn app.main:app --reload
The UI connects to ws://<host>:8000/ws/contacts and receives a JSON array of
non-cooperative contacts roughly once per second.
"""

from __future__ import annotations

import asyncio
import contextlib
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.briefing import picture_signature, stream_briefing
from app.mock import MockContactSource

# Tick rate for the live feed (seconds).
TICK_SECONDS = 1.0

# Don't call the LLM every tick — regenerate the briefing only when the picture
# materially changes, and never more often than this (cost + the model call can take
# longer than a tick).
MIN_BRIEFING_INTERVAL_SECONDS = 5.0

app = FastAPI(title="Skryer", version=__version__)

# The Vite dev server runs on :5173; allow it (and localhost variants) in dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": __version__}


@app.websocket("/ws/contacts")
async def ws_contacts(ws: WebSocket) -> None:
    """Stream the current threat picture as a JSON array of contacts each tick.

    Today this is the mock source; swapping in the real acoustic DoA + vision
    pipeline changes nothing here as long as it yields `Contact`s.
    """
    await ws.accept()
    source = MockContactSource()
    try:
        while True:
            contacts = source.step()
            await ws.send_json([c.model_dump() for c in contacts])
            await asyncio.sleep(TICK_SECONDS)
    except WebSocketDisconnect:
        pass
    finally:
        with contextlib.suppress(RuntimeError):
            await ws.close()


@app.websocket("/ws/briefing")
async def ws_briefing(ws: WebSocket) -> None:
    """Stream a natural-language operator briefing of the current threat picture.

    This is the LLM *narration* layer — it never detects anything and is deliberately
    NOT on the critical path: the operator learns about threats from `/ws/contacts`
    (deterministic, sub-second). The briefing arrives a beat later as colour on top, so
    if the model is slow or down the console is fully usable. Each briefing is tagged
    with a timestamp so the UI can show how stale the narration is relative to the map.

    Throttle: regenerate only when the picture materially changes (new/dropped contact,
    kind change, or a contact crosses a range band), debounced to MIN_BRIEFING_INTERVAL.
    """
    await ws.accept()
    source = MockContactSource()
    last_signature = None
    last_generated = 0.0  # monotonic clock
    try:
        while True:
            contacts = source.step()
            signature = picture_signature(contacts)
            now = time.monotonic()
            if signature != last_signature and (now - last_generated) >= MIN_BRIEFING_INTERVAL_SECONDS:
                last_signature = signature
                last_generated = now
                await ws.send_json({"type": "briefing_start", "ts": time.time()})
                try:
                    async for delta in stream_briefing(contacts):
                        await ws.send_json({"type": "briefing_delta", "text": delta})
                    await ws.send_json({"type": "briefing_end"})
                except Exception as exc:  # noqa: BLE001 — degrade gracefully, never crash the socket
                    # The model failed (timeout, rate limit, no key). The operator still
                    # has the full picture on /ws/contacts; just tell the panel to keep
                    # showing the last good briefing.
                    await ws.send_json({"type": "briefing_error", "message": str(exc)})
            await asyncio.sleep(TICK_SECONDS)
    except WebSocketDisconnect:
        pass
    finally:
        with contextlib.suppress(RuntimeError):
            await ws.close()
