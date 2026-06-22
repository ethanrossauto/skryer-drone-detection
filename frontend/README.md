# Skryer frontend

React + TypeScript + Vite operator console. MapLibre GL map centred on the
perched sensor node, with a live contact overlay (bearing rays + confirmed
drones) fed by the backend WebSocket. This is the "great UI" showpiece.

## Run (dev)

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

The backend must be running (see `../backend/README.md`). Override the feed URL
by copying `.env.example` to `.env.local`.

## Layout

```
src/
  App.tsx                console layout: map + contacts panel
  components/MapView.tsx  MapLibre map: node + bearing rays + contact layer
  hooks/useContacts.ts    WebSocket feed (auto-reconnect)
  types.ts                Contact type — mirror of backend app/models.py
```
