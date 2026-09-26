# 🔔 RingRing

Add friends. Call them. That's it.

A Facebook-style calling app: accounts, friend requests, online status,
**1:1 video & audio calls** (WebRTC), and text chat. No build step.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000 — register two accounts (two browsers or a
private window) and call each other.

## Deploy (Render)

1. Push this folder to a GitHub repo.
2. Render → **New +** → **Web Service** → pick the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Open the URL on your phone — **HTTPS is required** for camera/mic
   (Render gives you HTTPS automatically).

## How it works

- `server.js` — Express-style HTTP API (register/login/friends) + WebSocket
  signaling server. Passwords are salted scrypt hashes, sessions last 7 days.
- The server only **relays** call setup (who's calling, SDP, ICE) and chat —
  the actual voice/video goes peer-to-peer via WebRTC, so calls are free.
- `store.js` — JSON file storage (`data/ringring.json`). No database needed.
- `public/` — the whole app: auth, friends list, chat, call UI.

## Good to know

- **1:1 calls only** in this version — no group calls yet.
- Calls need both people to have the page open (no push notifications yet).
- Uses free public STUN servers. On very strict networks (some offices,
  schools) calls may fail — adding a TURN server fixes that.
- Chat history is not saved — it lives in the open tab.
- Data lives in `data/ringring.json` — back it up if it matters to you.

## Test

```bash
npm test
```
