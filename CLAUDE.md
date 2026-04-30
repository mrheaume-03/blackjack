# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

```bash
npm start          # starts server on http://localhost:3000
```

No build step, no linter, no test suite. Open `http://localhost:3000` in multiple browser tabs to simulate multiple players (one as dealer, others as players).

## Architecture

Single-file Node.js server (`server.js`) backed by one in-memory `game` object. No database — restarting the server resets all state.

**State flow:** every mutation ends with `emit()`, which broadcasts the full `publicState()` snapshot to all connected clients via Socket.io. Clients are purely reactive — they render whatever state they receive and never hold authoritative state.

### Server (`server.js`)

**`game` object** — single source of truth:
- `phase` — `'waiting' | 'betting' | 'playing' | 'dealer' | 'payout'`
- `players[]` — includes both `role: 'dealer'` and `role: 'player'` entries; dealer entries have no `hands` and are filtered from all betting/dealing/action loops
- `dealer` — `{ cards[], revealed: bool }`
- `rules` — copy of `DEFAULT_RULES`, host-configurable via `set-rules`
- `hostId` — dealer's socket id; falls back to a regular player on dealer disconnect
- `activeIdx` — index into `players[]` of whose turn it is (`-1` when no active turn)

**`publicState()`** scrubs two categories of hidden cards before broadcasting:
1. Dealer hole card (`cards[1]`) → `{ hidden: true }` until `game.dealer.revealed = true`
2. Player face-down doubled cards (`.faceDown = true` on the card object) → `{ hidden: true }` until `phase === 'payout'`

**Game flow functions:**
- `beginBetting` → `beginDealing` (async, 600ms between each card) → `checkDealerBJ` → `advanceTurn` → `dealerPlay` → `payout` → `nextRound`
- `beginDealing` is `async` and deals one card at a time with `await sleep(600)` between each card, in casino order: P1↑, P2↑…, Dealer↑ (up card = index 0), P1↑, P2↑…, Dealer↓ (hole card = index 1, hidden)
- `advanceTurn` is the turn sequencer. After all players finish, it checks whether any player has a live standing hand before calling `dealerPlay`. If all hands are bust/surrendered/blackjack, it calls `payout()` directly — the dealer's hole card is never revealed
- Disconnected players are auto-stood when it's their turn so the game doesn't stall

**Hand object:** `{ cards[], bet, status, doubled, split, insured, insDecided, result }`
- `status`: `'active' | 'stood' | 'bust' | 'surrendered' | 'blackjack'`
- `result`: set at payout — `'win' | 'lose' | 'push' | 'blackjack' | 'surrender'`

**Double face-down:** `playerAction` accepts a `faceDown` boolean. When true and the hand doesn't bust, the drawn card gets `.faceDown = true`. It stays hidden in `publicState` until payout, then flips with the existing `card-reveal` animation.

**Split aces:** Default `hitSplitAces: true` — after splitting aces, each hand gets one card automatically (dealt in the split action) and the player can then hit/stand/double freely. Re-splitting is prevented by `maxSplitHands: 2` combined with `canSplit` requiring exactly 2 cards. When `hitSplitAces: false` (standard casino rule), hand 0 auto-stands immediately and subsequent split-ace hands also auto-stand without any extra card.

### Frontend (`public/`)

**`game.js`** — `socket.on('state', render)` drives everything. Module-level variables:
- `myId`, `amHost`, `myRole` — set once on `me` event
- `isInitialRender` — suppresses card animations on first render after joining
- `pendingBet` — client-side bet accumulator, cleared on place/reset
- `handHistory[]` — session-long array of completed hands (bet, result, cards); captured once per payout phase via `payoutCaptured` flag
- `CHIP_COLORS[]` — 6-entry array assigning colors by chip position (white/slate/red/green/blue/purple), applied inline so denominations can be anything

**Action bar** — mutually exclusive panels toggled by `showPanel`/`hideAllPanels`. Panel shown depends on `state.phase` + whether it's the current player's turn. Dealer-role clients see only `#host-controls`.

**Chip denominations** — `state.rules.chipDenominations` (array of numbers, configurable by host). Colors assigned positionally via `CHIP_COLORS`. Bet amounts support decimals (50¢ chips, etc.) — no `Math.floor` on bet arithmetic.

**Incremental card rendering** — `syncCardRow()` diffs DOM vs state card arrays:
- More DOM cards than state → clear (new round)
- Hidden card becomes revealed → `revealCard()` with `card-reveal` CSS animation
- Card at same position changed rank/suit → replace (split reshuffled hand)
- New cards appended with `card-deal` animation; stagger delay = `(i - domCards.length) * 180ms`

**Card sound** — `playCardSound()` uses Web Audio API: a sine sweep (130→35 Hz, 90ms) mixed with lowpass-filtered noise (< 900 Hz, 45ms) for a felt-thump + snap. No audio files.

**Hand history modal** — `captureHandHistory()` runs once when `state.phase` first becomes `'payout'` each round (guarded by `payoutCaptured` flag). Stores player cards, dealer cards, bet, and win/loss. Displayed newest-first in `#history-modal`. Dealer cards may show `?` for hidden hole card when everyone busted.

**`formatMoney(n)`** — formats chip amounts: whole numbers as `$N`, decimals as `$N.NN`.

### Socket events (client → server)

| Event | Payload | Description |
|-------|---------|-------------|
| `join` | `{ name, role }` | `role` is `'dealer'` or `'player'` |
| `start` | — | host starts betting phase |
| `bet` | `{ amount }` | place bet during betting phase |
| `action` | `{ action, faceDown? }` | `hit`, `stand`, `double` (+ optional `faceDown: true`), `split`, `surrender`, `insurance`, `no-insurance` |
| `set-rules` | rules object | host updates table rules (waiting phase only); `chipDenominations` array validated server-side |
| `adjust-balance` | `{ id, amount }` | host adds/removes chips from any player at any time |
| `kick` | `{ id }` | host removes a player (waiting phase only) |
| `reset-game` | — | wipes all players; server emits `reset` to all clients who return to join screen |

### Configurable rules (`DEFAULT_RULES`)

| Rule | Default | Notes |
|------|---------|-------|
| `numDecks` | 6 | |
| `dealerHitsSoft17` | true | |
| `blackjackPayout` | `'3:2'` | or `'6:5'` |
| `insurance` | true | |
| `surrender` | `'late'` | `'early'` or `'none'` |
| `doubleOn` | `'any'` | `'9-11'` or `'10-11'` |
| `doubleAfterSplit` | true | |
| `maxSplitHands` | 2 | max hands per player from splitting |
| `hitSplitAces` | true | false = standard one-card auto-stand |
| `chipDenominations` | `[0.5, 1, 5]` | up to 8 values; sorted and validated server-side |
| `minBet` | 0.5 | supports decimals |
| `maxBet` | 20 | |
| `buyIn` | 10 | |
| `bettingTime` | 30 | seconds |
| `maxPlayers` | 6 | |

### Mobile layout (`style.css`)

`@media (max-width: 600px)` targets portrait phones:
- `height: 100svh` on `html/body`, `#game-screen`, `#join-screen` — fixes iOS Safari `100vh` toolbar clip
- `#action-bar` switches to `flex-direction: column` with `padding-bottom: max(0.6rem, env(safe-area-inset-bottom))`
- `.play-buttons` becomes a 3-column CSS grid so all 6 action buttons (Hit, Stand, Dbl↑, Dbl↓, Split, Surrender) fit in 2 rows
- `#sidebar` hidden; replaced by `#btn-players` opening `#players-overlay` (slide-up sheet)
- Viewport meta includes `viewport-fit=cover` for safe-area CSS

## Deployment

Hosted on Railway. Reads `process.env.PORT` (falls back to 3000). Railway auto-detects Node.js via `package.json` and runs `npm start`. Push to `master` on GitHub to trigger redeploy. Static assets (JS/CSS/HTML) are served with `Cache-Control: no-cache` so browsers always load the latest version after a redeploy.
