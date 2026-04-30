# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
npm start          # starts server on http://localhost:3000
```

No build step, no linter, no test suite. There is only one script. Open `http://localhost:3000` in multiple browser tabs to simulate multiple players.

## Architecture

Single-file Node.js server (`server.js`) backed by an in-memory game object. No database. The entire game state is one `game` object that lives for the lifetime of the process — restarting the server resets all state.

**State flow:** every mutation to `game` ends with a call to `emit()`, which broadcasts the full `publicState()` snapshot to all connected clients via Socket.io. Clients are purely reactive — they render whatever state they receive.

### Server (`server.js`)

- **`game` object** — single source of truth: `phase`, `players[]`, `dealer`, `shoe`, `rules`, `hostId`, `dealerPresent`
- **`publicState()`** — scrubs the dealer's hole card before sending to clients (`{ hidden: true }` when not revealed)
- **`game.rules`** — all configurable table settings; only the host/dealer can change them via `set-rules` socket event, and only when `phase === 'waiting'`
- **`game.players[]`** — includes both `role: 'dealer'` and `role: 'player'` entries. The dealer player has no `hands` and is filtered out of all betting/dealing/action loops
- **`game.hostId`** — always points to the dealer's socket id; falls back to a regular player if the dealer disconnects

Game phases cycle: `waiting → betting → playing → dealer → payout → (back to betting)`

Key functions: `beginBetting`, `beginDealing`, `advanceTurn`, `dealerPlay`, `payout`, `nextRound`. `advanceTurn` is the main turn-sequencing function — it walks `game.players` by index, skipping dealer-role players.

**Balance system:** Players join with `chips: 0`. The dealer uses the `adjust-balance` socket event to add or remove chips from any player at any time. The `start` handler silently no-ops if no player has `chips >= minBet`.

### Frontend (`public/`)

- **`game.js`** — one `socket.on('state', render)` listener drives everything. `render()` calls sub-renderers for header, dealer area, player seats, action bar, and sidebar
- **`myId` / `amHost` / `myRole`** — three module-level variables set once on the `me` socket event; `isInitialRender` flag suppresses card animations on first render after joining
- **Action bar panels** are mutually exclusive divs toggled via `showPanel` / `hideAllPanels` based on `state.phase` and whether it's the current player's turn
- Dealer-role clients skip all action-bar panels (betting, playing, payout) and only see the host controls (`#host-controls`)
- The join screen receives a `state` broadcast immediately on socket connect (before `join` is emitted) — this is how the "Dealer Seat Taken" button state is set before the user types a name

**Incremental card rendering:** Player seats and dealer cards are updated in-place rather than cleared and rebuilt on every state update. `renderPlayers()` matches existing `.seat[data-player-id]` DOM nodes to state players and calls `updateSeat()` for existing seats or `buildSeat()` for new ones. `syncCardRow()` appends only new cards (with flip animation + sound), handles hidden→revealed flips via `revealCard()`, and detects card replacement due to splits by comparing `data-rank`/`data-suit` attributes.

**Card animation:** `card-deal` keyframe does a rotateY flip-in (0.4s, `animation-fill-mode: both` so cards are invisible during stagger delay). `card-reveal` keyframe handles the dealer hole card flip. `playCardSound()` generates a synthetic snap via Web Audio API (bandpass-filtered noise burst, no audio files needed).

**Balance modal:** `openBalanceModal(playerId)` populates and shows `#balance-modal`. The overlay player list (`#players-overlay-list`) is an `innerHTML` copy of the sidebar with no event listeners — it uses delegated click on `[data-balance-id]` attributes instead.

### Socket events (client → server)

| Event | Payload | Description |
|-------|---------|-------------|
| `join` | `{ name, role }` | role is `'dealer'` or `'player'` |
| `start` | — | host starts betting phase |
| `bet` | `{ amount }` | place a bet during betting phase |
| `action` | `{ action }` | `hit`, `stand`, `double`, `split`, `surrender`, `insurance`, `no-insurance` |
| `set-rules` | rules object | host updates table rules (waiting phase only) |
| `adjust-balance` | `{ id, amount }` | host adds (positive) or removes (negative) chips from a player |
| `kick` | `{ id }` | host removes a player (waiting phase only) |
| `reset-game` | — | host wipes all players and resets to clean state; server emits `reset` to all clients who return to join screen |

### Configurable rules (`DEFAULT_RULES`)

`numDecks`, `dealerHitsSoft17`, `blackjackPayout` (`3:2`/`6:5`), `insurance`, `surrender` (`late`/`early`/`none`), `doubleOn` (`any`/`9-11`/`10-11`), `doubleAfterSplit`, `maxSplitHands` (integer — max hands per player from splitting), `hitSplitAces`, `minBet`, `maxBet`, `buyIn`, `maxPlayers`, `bettingTime`

### Mobile layout (`style.css`)

`@media (max-width: 600px)` catches all portrait iPhones (≤430px wide). Key rules:
- `height: 100svh` on `html/body`, `#game-screen`, `#join-screen` — fixes iOS Safari's `100vh` bug where browser toolbar clips content
- `#action-bar` switches to `flex-direction: column` with `padding-bottom: max(0.6rem, env(safe-area-inset-bottom))` for iPhone home indicator
- `.play-buttons` becomes a `3-column CSS grid` so all 5 action buttons fit in 2 rows
- `#sidebar` is hidden; replaced by a `#btn-players` button that opens `#players-overlay` (slide-up sheet)
- Viewport meta includes `viewport-fit=cover` to enable safe-area CSS

## Deployment

Hosted on Railway. The server reads `process.env.PORT` (falls back to 3000). No other environment variables are needed. Railway auto-detects Node.js via `package.json` and runs `npm start`. Push to `master` on GitHub to trigger a Railway redeploy.
