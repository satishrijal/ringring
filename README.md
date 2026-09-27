# 🔔 RingRing

Add friends. Call them. That's it.

A Facebook-style calling app: accounts, friend requests, online status,
**1:1 and group video & audio calls** (WebRTC), text chat, **one-time
disappearing photo snaps** with **streaks** 🔥, user search, and a
notification center. No build step.

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

- `server.js` — HTTP API (register/login/friends/search/groups/snaps/
  notifications) + WebSocket signaling server. Passwords are salted scrypt
  hashes, sessions last 7 days.
- The server only **relays** call setup (who's calling, SDP, ICE) and chat —
  the actual voice/video goes peer-to-peer via WebRTC, so calls are free.
  Group calls are a small full-mesh (everyone connects to everyone else),
  which works great up to ~6 people.
- `store.js` — JSON file storage (`data/ringring.json`). No database needed.
- `public/` — the whole app: auth, friends list, chat, call UI.
- Snaps are stored as JPEGs in `data/snaps/` and **deleted the moment they
  are viewed** (or after 7 days unviewed). Viewing a snap records a streak
  day for that pair of friends — consecutive days keep the 🔥 alive.

## Good to know

- **Group calls**: up to 6 people per group, mesh-based — fine on normal
  home/4G networks, may strain on very slow connections.
- Calls and notifications need the page open (no push notifications when
  the app is closed — that's a native-app feature).
- Uses free public STUN servers. On very strict networks (some offices,
  schools) calls may fail — adding a TURN server fixes that.
- Chat history is not saved — it lives in the open tab.
- Data lives in `data/ringring.json` — back it up if it matters to you.
  (On Render's free tier, redeploys wipe the disk: accounts, snaps and
  streaks reset. A database upgrade fixes that.)

## Test

```bash
npm test
```
49 tests: account/friend logic, user search, notifications, groups, streaks,
view-once snaps, and live WebSocket signaling for 1:1 + group calls.
