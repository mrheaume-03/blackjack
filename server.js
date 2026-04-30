const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ─── Card Utilities ───────────────────────────────────────────────────────────

function buildShoe(numDecks) {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const shoe = [];
  for (let d = 0; d < numDecks; d++)
    for (const suit of suits)
      for (const rank of ranks)
        shoe.push({ suit, rank, red: suit === '♥' || suit === '♦' });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function rankVal(rank) {
  if (rank === 'A') return 11;
  if ('JQK'.includes(rank[0])) return 10;
  return parseInt(rank);
}

function handTotal(cards) {
  let sum = 0, aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') { aces++; sum += 11; }
    else sum += rankVal(c.rank);
  }
  while (sum > 21 && aces-- > 0) sum -= 10;
  return sum;
}

function isSoft(cards) {
  let sum = 0, aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') { aces++; sum += 11; }
    else sum += rankVal(c.rank);
  }
  while (sum > 21 && aces > 0) { sum -= 10; aces--; }
  return aces > 0 && sum <= 21;
}

function isBJ(cards) {
  return cards.length === 2 && handTotal(cards) === 21;
}

// ─── Game State ───────────────────────────────────────────────────────────────

const DEFAULT_RULES = {
  numDecks: 6,
  dealerHitsSoft17: true,
  blackjackPayout: '3:2',
  insurance: true,
  surrender: 'late',
  doubleOn: 'any',
  doubleAfterSplit: true,
  maxSplitHands: 2,
  hitSplitAces: true,
  chipDenominations: [0.5, 1, 5],
  minBet: 0.5,
  maxBet: 20,
  buyIn: 10,
  bettingTime: 30,
  maxPlayers: 6,
};

const game = {
  phase: 'waiting',
  rules: { ...DEFAULT_RULES },
  players: [],
  dealer: { cards: [], revealed: false },
  shoe: [],
  activeIdx: -1,
  hostId: null,
  dealerPresent: false,
  insuranceOpen: false,
  betTimer: null,
};

function newHand(bet) {
  return { cards: [], bet, status: 'active', doubled: false, split: false, insured: 0, insDecided: false, result: null };
}

function publicState() {
  return {
    phase: game.phase,
    rules: game.rules,
    players: game.players.map(p => ({
      ...p,
      hands: p.hands.map(h => ({
        ...h,
        cards: h.cards.map(c =>
          c.faceDown && game.phase !== 'payout' ? { hidden: true } : c
        ),
      })),
    })),
    dealer: {
      cards: game.dealer.revealed
        ? game.dealer.cards
        : game.dealer.cards.map((c, i) => i === 1 ? { hidden: true } : c),
      total: game.dealer.revealed ? handTotal(game.dealer.cards) : null,
      bust: game.dealer.revealed && handTotal(game.dealer.cards) > 21,
    },
    activeIdx: game.activeIdx,
    hostId: game.hostId,
    dealerPresent: game.dealerPresent,
    insuranceOpen: game.insuranceOpen,
    shoeSize: game.shoe.length,
  };
}

function emit() { io.emit('state', publicState()); }

function draw() {
  if (game.shoe.length < 15) game.shoe = buildShoe(game.rules.numDecks);
  return game.shoe.pop();
}

// ─── Game Flow ────────────────────────────────────────────────────────────────

function beginBetting() {
  if (game.betTimer) clearTimeout(game.betTimer);
  game.phase = 'betting';
  game.dealer = { cards: [], revealed: false };
  game.activeIdx = -1;
  game.insuranceOpen = false;
  for (const p of game.players.filter(p => p.role !== 'dealer')) {
    p.hands = [];
    p.curHand = 0;
  }
  emit();
  game.betTimer = setTimeout(() => {
    for (const p of game.players)
      if (p.role !== 'dealer' && p.connected && !p.hands.length && p.chips >= game.rules.minBet)
        doPlaceBet(p.id, game.rules.minBet);
    beginDealing();
  }, game.rules.bettingTime * 1000);
}

function doPlaceBet(id, amount) {
  const p = game.players.find(p => p.id === id);
  if (!p || p.role === 'dealer' || p.hands.length) return;
  amount = Math.max(game.rules.minBet, Math.min(game.rules.maxBet, amount, p.chips));
  p.chips -= amount;
  p.hands = [newHand(amount)];
  p.curHand = 0;
  emit();
  const active = game.players.filter(p => p.connected && p.role !== 'dealer');
  if (active.length && active.every(p => p.hands.length)) {
    if (game.betTimer) clearTimeout(game.betTimer);
    beginDealing();
  }
}

async function beginDealing() {
  if (game.phase !== 'betting') return;
  const bettors = game.players.filter(p => p.role !== 'dealer' && p.hands.length);
  if (!bettors.length) { game.phase = 'waiting'; emit(); return; }
  game.phase = 'playing';
  emit();

  // Deal one card at a time: P1, P2, ..., Dealer up card, P1, P2, ..., Dealer hole card
  for (const p of bettors) { p.hands[0].cards.push(draw()); emit(); await sleep(600); }
  game.dealer.cards.push(draw()); emit(); await sleep(600);
  for (const p of bettors) { p.hands[0].cards.push(draw()); emit(); await sleep(600); }
  game.dealer.cards.push(draw()); emit(); await sleep(600);

  if (game.rules.insurance && game.dealer.cards[0].rank === 'A') {
    game.insuranceOpen = true;
    emit();
    setTimeout(() => { game.insuranceOpen = false; checkDealerBJ(); }, 10000);
    return;
  }
  checkDealerBJ();
}

function checkDealerBJ() {
  if (isBJ(game.dealer.cards)) {
    game.dealer.revealed = true;
    game.phase = 'payout';
    for (const p of game.players.filter(p => p.role !== 'dealer' && p.hands.length)) {
      for (const h of p.hands) {
        if (isBJ(h.cards)) { h.result = 'push'; p.chips += h.bet; }
        else { h.result = 'lose'; if (h.insured) p.chips += h.insured * 3; }
      }
    }
    emit();
    setTimeout(nextRound, 5000);
    return;
  }
  advanceTurn();
}

function advanceTurn() {
  // Check if current player has more hands
  if (game.activeIdx >= 0) {
    const curr = game.players[game.activeIdx];
    for (let hi = curr.curHand + 1; hi < curr.hands.length; hi++) {
      const h = curr.hands[hi];
      if (h.status === 'active') {
        curr.curHand = hi;
        if (!game.rules.hitSplitAces && h.split && h.cards[0].rank === 'A') {
          h.status = 'stood';
          emit();
          continue;
        }
        emit();
        return;
      }
    }
  }

  // Find next non-dealer player with an active hand
  for (let pi = game.activeIdx + 1; pi < game.players.length; pi++) {
    const p = game.players[pi];
    if (p.role === 'dealer' || !p.hands.length) continue;
    p.curHand = 0;
    const h = p.hands[0];
    if (h.status !== 'active') continue;
    game.activeIdx = pi;
    if (isBJ(h.cards) && !h.split) {
      h.status = 'blackjack';
      emit();
      setTimeout(advanceTurn, 600);
      return;
    }
    if (!p.connected) {
      h.status = 'stood';
      emit();
      setTimeout(advanceTurn, 600);
      return;
    }
    emit();
    return;
  }

  // Skip dealer play if no player has a live standing hand
  const anyLive = game.players.some(p =>
    p.role !== 'dealer' &&
    p.hands.some(h => h.status !== 'bust' && h.status !== 'surrendered' && h.status !== 'blackjack')
  );
  if (!anyLive) { payout(); return; }
  dealerPlay();
}

function dealerPlay() {
  game.activeIdx = -1;
  game.dealer.revealed = true;
  game.phase = 'dealer';
  emit();
  const step = () => {
    const t = handTotal(game.dealer.cards);
    const soft = isSoft(game.dealer.cards);
    if (t < 17 || (t === 17 && soft && game.rules.dealerHitsSoft17)) {
      game.dealer.cards.push(draw());
      emit();
      setTimeout(step, 900);
    } else {
      payout();
    }
  };
  setTimeout(step, 900);
}

function payout() {
  game.phase = 'payout';
  const dt = handTotal(game.dealer.cards);
  const dBust = dt > 21;
  for (const p of game.players.filter(p => p.role !== 'dealer' && p.hands.length)) {
    for (const h of p.hands) {
      if (h.result) continue;
      if (h.status === 'surrendered') { p.chips += h.bet / 2; h.result = 'surrender'; continue; }
      if (h.status === 'bust') { h.result = 'lose'; continue; }
      const pt = handTotal(h.cards);
      if (h.status === 'blackjack') {
        const mult = game.rules.blackjackPayout === '3:2' ? 1.5 : 1.2;
        p.chips += h.bet + h.bet * mult;
        h.result = 'blackjack';
      } else if (dBust || pt > dt) {
        p.chips += h.bet * 2;
        h.result = 'win';
      } else if (pt === dt) {
        p.chips += h.bet;
        h.result = 'push';
      } else {
        h.result = 'lose';
      }
    }
  }
  emit();
  setTimeout(nextRound, 5500);
}

function nextRound() {
  if (game.players.filter(p => p.connected && p.role !== 'dealer').length) beginBetting();
  else { game.phase = 'waiting'; emit(); }
}

// ─── Player Actions ───────────────────────────────────────────────────────────

function canDouble(h, p) {
  if (h.cards.length !== 2 || p.chips < h.bet) return false;
  if (h.split && !game.rules.doubleAfterSplit) return false;
  const t = handTotal(h.cards);
  if (game.rules.doubleOn === '9-11') return t >= 9 && t <= 11;
  if (game.rules.doubleOn === '10-11') return t >= 10 && t <= 11;
  return true;
}

function canSplit(h, p) {
  if (h.cards.length !== 2 || p.chips < h.bet) return false;
  if (p.hands.length >= game.rules.maxSplitHands) return false;
  return rankVal(h.cards[0].rank) === rankVal(h.cards[1].rank);
}

function playerAction(id, action, faceDown = false) {
  const p = game.players.find(p => p.id === id);
  if (!p || p.role === 'dealer') return;

  if (action === 'insurance' || action === 'no-insurance') {
    if (!game.insuranceOpen || !p.hands.length) return;
    const h = p.hands[0];
    if (h.insDecided) return;
    h.insDecided = true;
    if (action === 'insurance') {
      const ins = h.bet / 2;
      if (p.chips >= ins) { p.chips -= ins; h.insured = ins; }
    }
    emit();
    return;
  }

  const pi = game.players.indexOf(p);
  if (game.phase !== 'playing' || pi !== game.activeIdx) return;
  const h = p.hands[p.curHand];
  if (!h || h.status !== 'active') return;

  switch (action) {
    case 'hit': {
      h.cards.push(draw());
      const t = handTotal(h.cards);
      if (t > 21) { h.status = 'bust'; emit(); advanceTurn(); }
      else if (t === 21) { h.status = 'stood'; emit(); advanceTurn(); }
      else emit();
      break;
    }
    case 'stand':
      h.status = 'stood'; emit(); advanceTurn(); break;
    case 'double': {
      if (!canDouble(h, p)) return;
      p.chips -= h.bet; h.bet *= 2; h.doubled = true;
      const newCard = draw();
      const bust = handTotal([...h.cards, newCard]) > 21;
      if (!bust && faceDown) newCard.faceDown = true;
      h.cards.push(newCard);
      h.status = bust ? 'bust' : 'stood';
      emit(); advanceTurn(); break;
    }
    case 'split': {
      if (!canSplit(h, p)) return;
      p.chips -= h.bet;
      const c2 = h.cards.pop();
      h.cards.push(draw()); h.split = true;
      const nh = newHand(h.bet);
      nh.cards = [c2, draw()]; nh.split = true;
      p.hands.splice(p.curHand + 1, 0, nh);
      if (!game.rules.hitSplitAces && h.cards[0].rank === 'A') {
        h.status = 'stood'; emit(); advanceTurn(); // standard: auto-stand split aces
      } else emit();
      break;
    }
    case 'surrender': {
      if (game.rules.surrender === 'none' || h.cards.length !== 2 || h.split) return;
      h.status = 'surrendered'; emit(); advanceTurn(); break;
    }
  }
}

// ─── Sockets ──────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  // Send current lobby state so join screen can show dealer-seat availability
  socket.emit('state', publicState());

  socket.on('join', ({ name, role }) => {
    const cleanName = (name || '').trim().slice(0, 20) || `Player ${game.players.length + 1}`;
    const cleanRole = role === 'dealer' ? 'dealer' : 'player';

    // Reconnection: same name, same role, was disconnected
    const existing = game.players.find(p => p.name === cleanName && p.role === cleanRole && !p.connected);
    if (existing) {
      existing.id = socket.id;
      existing.connected = true;
      if (cleanRole === 'dealer') {
        game.dealerPresent = true;
        game.hostId = socket.id;
      }
      if (!game.hostId) game.hostId = socket.id;
      socket.emit('me', { id: socket.id, isHost: socket.id === game.hostId, role: cleanRole });
      emit();
      return;
    }

    // Enforce single dealer
    if (cleanRole === 'dealer') {
      if (game.dealerPresent) {
        socket.emit('join-error', 'The dealer seat is already taken.');
        return;
      }
      game.dealerPresent = true;
      game.hostId = socket.id;
    }

    // Enforce max players (non-dealer seats)
    if (cleanRole === 'player') {
      const seated = game.players.filter(p => p.role === 'player' && p.connected).length;
      if (seated >= game.rules.maxPlayers) {
        socket.emit('join-error', 'The table is full.');
        return;
      }
      if (!game.hostId) game.hostId = socket.id;
    }

    game.players.push({
      id: socket.id,
      name: cleanName,
      role: cleanRole,
      chips: 0,
      hands: [],
      curHand: 0,
      connected: true,
    });

    socket.emit('me', { id: socket.id, isHost: socket.id === game.hostId, role: cleanRole });
    emit();
  });

  socket.on('set-rules', rules => {
    if (socket.id !== game.hostId || game.phase !== 'waiting') return;
    const merged = { ...DEFAULT_RULES, ...rules };
    if (Array.isArray(rules.chipDenominations)) {
      const cleaned = rules.chipDenominations
        .map(Number).filter(v => v > 0 && isFinite(v))
        .sort((a, b) => a - b).slice(0, 8);
      merged.chipDenominations = cleaned.length ? cleaned : DEFAULT_RULES.chipDenominations;
    }
    game.rules = merged;
    emit();
  });

  socket.on('start', () => {
    if (socket.id !== game.hostId || game.phase !== 'waiting') return;
    if (!game.players.filter(p => p.role !== 'dealer' && p.connected && p.chips >= game.rules.minBet).length) return;
    beginBetting();
  });

  socket.on('bet', ({ amount }) => {
    if (game.phase === 'betting') doPlaceBet(socket.id, amount);
  });

  socket.on('action', ({ action, faceDown }) => playerAction(socket.id, action, faceDown));

  socket.on('adjust-balance', ({ id, amount }) => {
    if (socket.id !== game.hostId) return;
    const p = game.players.find(p => p.id === id);
    if (!p || p.role === 'dealer') return;
    p.chips = Math.max(0, p.chips + Number(amount));
    emit();
  });

  socket.on('kick', ({ id }) => {
    if (socket.id !== game.hostId) return;
    game.players = game.players.filter(p => p.id !== id);
    emit();
  });

  socket.on('reset-game', () => {
    if (socket.id !== game.hostId) return;
    if (game.betTimer) { clearTimeout(game.betTimer); game.betTimer = null; }
    game.phase = 'waiting';
    game.players = [];
    game.dealer = { cards: [], revealed: false };
    game.shoe = buildShoe(game.rules.numDecks);
    game.activeIdx = -1;
    game.hostId = null;
    game.dealerPresent = false;
    game.insuranceOpen = false;
    io.emit('reset');
    emit();
  });

  socket.on('disconnect', () => {
    const p = game.players.find(p => p.id === socket.id);
    if (!p) return;
    p.connected = false;
    if (p.role === 'dealer') {
      game.dealerPresent = false;
      // Find a player to promote to host so the game isn't stuck
      const next = game.players.find(p => p.role === 'player' && p.connected);
      game.hostId = next ? next.id : null;
      if (next) io.to(next.id).emit('promoted');
    } else if (game.hostId === socket.id) {
      const next = game.players.find(p => p.role === 'player' && p.connected);
      game.hostId = next ? next.id : null;
      if (next) io.to(next.id).emit('promoted');
    }
    emit();
  });
});

server.listen(PORT, () => {
  console.log(`\n  Blackjack server running!`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Share your Railway URL for others to join\n`);
});
