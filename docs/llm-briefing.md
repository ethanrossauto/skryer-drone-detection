# LLM Threat Briefing (streamed operator narration)

A production-LLM feature layered onto Skryer: it turns the structured contact picture into a concise,
spoken-style operator briefing, streamed token-by-token to the console. The LLM is the
**narration layer only** — it does **not** detect, classify, or invent contacts. The deterministic
acoustic / vision / fusion pipeline owns all detection; the model only describes what it is given.

## What it does

Given the current threat picture (the same `Contact` list streamed on `/ws/contacts`), the model
produces a short briefing, **highest threat first**, e.g.:

> *"Two contacts. Priority: Contact 7 — vision-confirmed drone, bearing 042°, ~900 m, confidence
> 0.91, closing. Also tracking Contact 3 — acoustic-only, bearing 310°, range unknown, low
> confidence. No visual on Contact 3 yet."*

Streamed token-by-token to a briefing panel so the console feels live.

## Design rationale

- **Grounded on structured data, never the source of truth.** The model receives the exact `Contact`
  records and is instructed to describe *only* those contacts. It cannot hallucinate a drone — if a
  contact isn't in the list, it can't narrate it.
- **Deterministic where it should be.** Detection, bearing, fusion, and alerting stay pure algorithm.
  The model only does the thing models are good at: fluent natural language.
- **Held off the critical path.** Alerts and the map ride the deterministic `/ws/contacts` feed. A
  model failure degrades to the last good briefing and never blocks the operator.
- **Eval-gated, not prompt-and-pray** (see Evals below).

## Architecture

The briefing layer is read-only over the same contacts, so swapping the mock source for the real
sensor pipeline later changes nothing here.

```
backend/app/
  briefing.py             # prompt building + Claude streaming call + threat ranking
  main.py                 # the /ws/briefing endpoint (mirrors /ws/contacts cadence)
  models.py               # Contact / Alert schema
  prompts/
    briefing_system.txt   # system prompt, versioned in-repo so prompts are tunable/A-B-able
backend/tests/
  test_briefing.py        # the eval suite
```

- `derive_kinematics(contacts)` — compute display-useful fields the model shouldn't infer: count and
  a threat ranking (vision-confirmed > acoustic; higher confidence; shorter range first; unknown
  range sorts last).
- `build_messages(contacts)` — render the ranked contacts into a compact, unambiguous block
  (id, kind, source, bearing, elevation, range, confidence), paired with the system prompt.
- `stream_briefing(contacts)` — async streaming via the Anthropic API; the **empty-sky case is
  answered locally with no API call** (saves tokens + latency).
- `picture_signature(contacts)` — a material-change throttle: regenerate only when the picture
  meaningfully changes (id set changes, a kind flips, or a contact crosses a range band), debounced
  to a minimum interval, instead of calling the model every tick.

## Endpoint

`/ws/briefing` streams `briefing_start` / `briefing_delta` / `briefing_end` / `briefing_error`
frames. It regenerates only on a material change, debounced to ≥5 s — calling the model every 1 s
tick would cost more and add more latency than it's worth.

## Evals

`backend/tests/test_briefing.py` runs offline by default; the live (model-calling) checks are gated
behind `SKRYER_RUN_LLM_EVALS=1` so the suite is CI-safe.

- **Offline** (no API): threat ranking, the grounded render, the empty-sky no-API-call path, and the
  material-change throttle signature.
- **Live** (`SKRYER_RUN_LLM_EVALS=1 pytest`): anti-hallucination (the briefing never mentions an id
  that isn't in the input — the key check), mentions every input id, highest-threat-first ordering,
  and an optional **LLM-as-judge** clarity score (a second model call rating clarity 1–5).

## Key handling

`anthropic` + `python-dotenv` are in `requirements.txt`; `ANTHROPIC_API_KEY` is read from a
gitignored `.env` (`.env.example` is committed). The deterministic pipeline and the offline eval
suite run without any key.

## Model choice

- `claude-haiku-4-5` — default for the per-update briefing (cheap, fast, ample for narration).
- `claude-sonnet-4-6` — if richer prioritization reasoning is wanted.

## Roadmap (v2)

- Conversational / agentic query over the air picture (tool-calling).
- Voice (STT → LLM → TTS) and an auto after-action report.
