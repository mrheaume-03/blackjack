const socket = io();

let myId      = null;
let amHost    = false;
let myRole    = null;
let state     = null;
let pendingBet = 0;
let betTimerEnd = 0;
let betTimerInterval = null;

// ─── Connection & Identity ────────────────────────────────────────────────────

socket.on('me', ({ id, isHost, role }) => {
  myId   = id;
  amHost = isHost;
  myRole = role;
  el('join-screen').classList.add('hidden');
  el('game-screen').classList.remove('hidden');
  applyHostUI();
});

socket.on('promoted', () => {
  amHost = true;
  applyHostUI();
  showToast('You are now the host');
});

socket.on('state', (s) => {
  if (!myId) updateDealerButton(s);
  state = s;
  if (myId) render();
});

socket.on('join-error', (msg) => {
  const errEl = el('join-error');
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
});

// ─── Join ─────────────────────────────────────────────────────────────────────

function updateDealerButton(s) {
  const btn = el('btn-join-dealer');
  if (!btn) return;
  if (s.dealerPresent) {
    btn.disabled = true;
    btn.textContent = 'Dealer Seat Taken';
  } else {
    btn.disabled = false;
    btn.textContent = '🂠 Take Dealer Seat';
  }
}

el('btn-join-dealer').addEventListener('click', () => doJoin('dealer'));
el('btn-join-player').addEventListener('click', () => doJoin('player'));

el('name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doJoin('player');
});

function doJoin(role) {
  const name = el('name-input').value.trim();
  if (!name) { el('name-input').focus(); return; }
  el('join-error').classList.add('hidden');
  socket.emit('join', { name, role });
}

function applyHostUI() {
  el('rules-btn').classList.toggle('hidden', !amHost);
  el('host-controls').classList.toggle('hidden', !amHost);
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  if (!state) return;
  renderHeader();
  renderDealer();
  renderPlayers();
  renderActionBar();
  renderSidebar();
  if (amHost) syncRulesPanel();
}

function renderHeader() {
  const labels = {
    waiting: 'Waiting for Players',
    betting:  'Place Your Bets',
    playing:  'Players\' Turn',
    dealer:   'Dealer\'s Turn',
    payout:   'Showdown',
  };
  el('phase-display').textContent = labels[state.phase] || state.phase.toUpperCase();
  const decks = state.rules.numDecks;
  const totalCards = decks * 52;
  el('shoe-display').textContent = state.shoeSize
    ? `Shoe: ${state.shoeSize} / ${totalCards} cards`
    : '';
  el('btn-start').classList.toggle('hidden', !(amHost && state.phase === 'waiting'));
}

// ─── Dealer ───────────────────────────────────────────────────────────────────

function renderDealer() {
  const row = el('dealer-cards');
  row.innerHTML = '';
  for (const card of state.dealer.cards) row.appendChild(makeCard(card));

  const totalEl = el('dealer-total');
  if (state.dealer.total !== null) {
    const t = state.dealer.total;
    totalEl.textContent = t > 21 ? `${t}  — BUST` : t;
    totalEl.style.color = t > 21 ? 'var(--red)' : 'var(--gold)';
  } else {
    totalEl.textContent = '';
  }
}

// ─── Players ──────────────────────────────────────────────────────────────────

function renderPlayers() {
  const row = el('players-row');
  row.innerHTML = '';
  // Only render non-dealer players in the seats row
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p.role === 'dealer') continue;
    const isMe     = p.id === myId;
    const isActive = i === state.activeIdx;
    row.appendChild(buildSeat(p, isMe, isActive));
  }
}

function buildSeat(p, isMe, isActive) {
  const seat = div('seat');
  if (isMe)     seat.classList.add('my-seat');
  if (isActive) seat.classList.add('active');
  if (!p.connected) seat.classList.add('inactive');

  const nameDiv = div('seat-name');
  nameDiv.textContent = p.name;
  if (isMe) nameDiv.classList.add('me-label');
  seat.appendChild(nameDiv);

  const chipsDiv = div('seat-chips');
  chipsDiv.textContent = `$${p.chips.toLocaleString()}`;
  seat.appendChild(chipsDiv);

  if (!p.connected) {
    const gone = div('disconnected-badge');
    gone.textContent = 'disconnected';
    seat.appendChild(gone);
  }

  if (p.hands && p.hands.length > 0) {
    const handsDiv = div('seat-hands');
    p.hands.forEach((hand, hi) => {
      const isActiveHand = isActive && hi === p.curHand;
      handsDiv.appendChild(buildHandBlock(hand, isActiveHand));
    });
    seat.appendChild(handsDiv);
  } else if (state.phase === 'betting') {
    const bw = div('bet-waiting');
    bw.textContent = p.hands && p.hands.length ? '✓ Bet placed' : 'Waiting to bet...';
    seat.appendChild(bw);
  }

  return seat;
}

function buildHandBlock(hand, isActiveHand) {
  const block = div('hand-block');
  if (isActiveHand) block.classList.add('active-hand');

  const cardRow = div('card-row');
  for (const card of hand.cards) cardRow.appendChild(makeCard(card));
  block.appendChild(cardRow);

  if (hand.cards.length > 0) {
    const t = clientTotal(hand.cards);
    const betDiv = div('hand-bet');
    betDiv.textContent = `Bet: $${hand.bet}${hand.doubled ? ' (2×)' : ''}${hand.insured ? ` + ins $${hand.insured}` : ''}`;
    block.appendChild(betDiv);

    if (hand.status !== 'blackjack' && hand.status !== 'surrendered') {
      const totDiv = div('hand-total');
      totDiv.textContent = t > 21 ? `${t} — BUST` : t;
      totDiv.style.color = t > 21 ? 'var(--red)' : '';
      block.appendChild(totDiv);
    }
  }

  const resultText = getResultText(hand);
  if (resultText) {
    const rd = div('hand-result');
    rd.classList.add(getResultClass(hand));
    rd.textContent = resultText;
    block.appendChild(rd);
  }

  return block;
}

function getResultText(hand) {
  if (hand.result === 'win')       return '+ WIN';
  if (hand.result === 'blackjack') return '★ BLACKJACK';
  if (hand.result === 'push')      return '— PUSH';
  if (hand.result === 'lose')      return '✗ LOSE';
  if (hand.result === 'surrender') return 'SURRENDER';
  if (hand.status === 'blackjack') return '★ BLACKJACK';
  if (hand.status === 'bust')      return 'BUST';
  if (hand.status === 'stood')     return '';
  return '';
}

function getResultClass(hand) {
  if (hand.result === 'win' || hand.result === 'blackjack') return 'win';
  if (hand.result === 'blackjack') return 'blackjack';
  if (hand.result === 'push')   return 'push';
  if (hand.result === 'lose')   return 'lose';
  if (hand.result === 'surrender') return 'surrender';
  if (hand.status === 'blackjack') return 'blackjack';
  if (hand.status === 'bust')   return 'bust';
  return '';
}

// ─── Cards ────────────────────────────────────────────────────────────────────

function makeCard(card) {
  const c = div('card');
  if (card.hidden) { c.classList.add('card-back'); return c; }
  c.classList.add(card.red ? 'red' : 'black');
  c.innerHTML = `<span class="c-top">${card.rank}</span><span class="c-suit">${card.suit}</span><span class="c-bot">${card.rank}</span>`;
  return c;
}

function clientTotal(cards) {
  const vis = cards.filter(c => !c.hidden);
  let sum = 0, aces = 0;
  for (const c of vis) {
    if (c.rank === 'A') { aces++; sum += 11; }
    else if (['J','Q','K'].includes(c.rank)) sum += 10;
    else sum += parseInt(c.rank);
  }
  while (sum > 21 && aces-- > 0) sum -= 10;
  return sum;
}

// ─── Action Bar ───────────────────────────────────────────────────────────────

function renderActionBar() {
  hideAllPanels();
  if (!myId || !state) return;

  // Dealer sees nothing in the action bar — their controls are in host-controls
  if (myRole === 'dealer') return;

  const me = state.players.find(p => p.id === myId);
  const myIdx = state.players.findIndex(p => p.id === myId);

  // Host start button visibility
  el('btn-start').classList.toggle('hidden', !(amHost && state.phase === 'waiting'));

  // Insurance phase check (before normal play)
  if (state.insuranceOpen && me && me.hands && me.hands.length > 0) {
    const h = me.hands[0];
    if (!h.insDecided) {
      showPanel('panel-insurance');
      startInsuranceTimer();
      return;
    }
  }

  switch (state.phase) {
    case 'waiting':
      if (!amHost) showPanel('panel-waiting');
      break;

    case 'betting':
      if (me && me.hands && me.hands.length === 0) {
        showPanel('panel-bet');
        renderBetPanel(me);
        startBetTimer();
      } else if (me && me.hands && me.hands.length > 0) {
        showPanel('panel-watching');
        el('watching-msg').textContent = 'Bet placed — waiting for others...';
      }
      break;

    case 'playing':
      if (myIdx === state.activeIdx) {
        showPanel('panel-play');
        renderPlayPanel(me);
      } else {
        showPanel('panel-watching');
        const activePlayer = state.players[state.activeIdx];
        el('watching-msg').textContent = activePlayer
          ? `Waiting for ${activePlayer.name}...`
          : 'Waiting...';
      }
      break;

    case 'dealer':
      showPanel('panel-watching');
      el('watching-msg').textContent = 'Dealer is playing...';
      break;

    case 'payout':
      showPanel('panel-payout');
      renderPayoutMsg(me);
      break;
  }
}

function hideAllPanels() {
  ['panel-waiting','panel-bet','panel-play','panel-insurance','panel-watching','panel-payout']
    .forEach(id => el(id).classList.add('hidden'));
  stopBetTimer();
}

function showPanel(id) {
  el(id).classList.remove('hidden');
}

// ─── Bet Panel ────────────────────────────────────────────────────────────────

function renderBetPanel(me) {
  const chipRow = el('chip-row');
  chipRow.innerHTML = '';
  const denominations = [5, 10, 25, 100, 500];
  for (const val of denominations) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    if (val === 25)  btn.classList.add('chip-25');
    if (val === 100) btn.classList.add('chip-100');
    if (val === 500) btn.classList.add('chip-500');
    btn.textContent = val >= 1000 ? `$${val/1000}k` : `$${val}`;
    const would = pendingBet + val;
    btn.disabled = would > state.rules.maxBet || val > me.chips;
    btn.addEventListener('click', () => addChip(val, me));
    chipRow.appendChild(btn);
  }
  el('bet-amount').textContent = `$${pendingBet}`;
  el('btn-place-bet').disabled = pendingBet < state.rules.minBet && me.chips >= state.rules.minBet;
}

function addChip(val, me) {
  const would = pendingBet + val;
  if (would <= state.rules.maxBet && would <= me.chips) {
    pendingBet = would;
    el('bet-amount').textContent = `$${pendingBet}`;
    renderBetPanel(me);
  }
}

function startBetTimer() {
  if (betTimerEnd === 0) betTimerEnd = Date.now() + state.rules.bettingTime * 1000;
  stopBetTimer();
  betTimerInterval = setInterval(() => {
    const secs = Math.max(0, Math.ceil((betTimerEnd - Date.now()) / 1000));
    const timerEl = el('bet-timer-display');
    timerEl.textContent = `${secs}s remaining`;
    timerEl.classList.toggle('urgent', secs <= 5);
    if (secs === 0) stopBetTimer();
  }, 250);
}

function startInsuranceTimer() {
  const insEnd = Date.now() + 10000;
  const timerEl = el('ins-timer-display');
  const iv = setInterval(() => {
    const secs = Math.max(0, Math.ceil((insEnd - Date.now()) / 1000));
    timerEl.textContent = `${secs}s`;
    timerEl.classList.toggle('urgent', secs <= 3);
    if (secs === 0) clearInterval(iv);
  }, 250);
}

function stopBetTimer() {
  if (betTimerInterval) { clearInterval(betTimerInterval); betTimerInterval = null; }
}

el('btn-clear-bet').addEventListener('click', () => {
  pendingBet = 0;
  el('bet-amount').textContent = '$0';
  if (state) {
    const me = state.players.find(p => p.id === myId);
    if (me) renderBetPanel(me);
  }
});

el('btn-place-bet').addEventListener('click', () => {
  const amt = pendingBet >= state.rules.minBet ? pendingBet : state.rules.minBet;
  socket.emit('bet', { amount: amt });
  pendingBet = 0;
  betTimerEnd = 0;
});

// ─── Play Panel ───────────────────────────────────────────────────────────────

function renderPlayPanel(me) {
  if (!me || !me.hands) return;
  const h = me.hands[me.curHand];
  if (!h) return;

  const t = clientTotal(h.cards);
  const twoCards = h.cards.length === 2;

  const canDouble = twoCards && me.chips >= h.bet
    && (!h.split || state.rules.doubleAfterSplit)
    && checkDoubleOn(t, state.rules.doubleOn);

  const canSplit = twoCards && me.chips >= h.bet
    && me.hands.length < state.rules.maxSplitHands
    && clientRankVal(h.cards[0].rank) === clientRankVal(h.cards[1].rank);

  const canSurrender = state.rules.surrender !== 'none' && twoCards && !h.split;

  el('btn-double').disabled    = !canDouble;
  el('btn-split').disabled     = !canSplit;
  el('btn-surrender').disabled = !canSurrender;
}

function checkDoubleOn(t, rule) {
  if (rule === 'any')   return true;
  if (rule === '9-11')  return t >= 9 && t <= 11;
  if (rule === '10-11') return t >= 10 && t <= 11;
  return false;
}

function clientRankVal(rank) {
  if (rank === 'A') return 11;
  if ('JQK'.includes(rank)) return 10;
  return parseInt(rank);
}

// ─── Payout Display ───────────────────────────────────────────────────────────

function renderPayoutMsg(me) {
  if (!me || !me.hands || !me.hands.length) { el('payout-msg').textContent = ''; return; }
  const parts = me.hands.map(h => {
    if (h.result === 'blackjack') return `★ Blackjack! +$${Math.floor(h.bet * (state.rules.blackjackPayout === '3:2' ? 1.5 : 1.2))}`;
    if (h.result === 'win')       return `Win! +$${h.bet}`;
    if (h.result === 'push')      return 'Push — bet returned';
    if (h.result === 'lose')      return `Lose -$${h.bet}`;
    if (h.result === 'surrender') return `Surrender — half bet returned`;
    return '';
  }).filter(Boolean);
  el('payout-msg').textContent = parts.join('   |   ');
}

// ─── Play Button Events ───────────────────────────────────────────────────────

el('btn-hit').addEventListener('click',       () => socket.emit('action', { action: 'hit' }));
el('btn-stand').addEventListener('click',     () => socket.emit('action', { action: 'stand' }));
el('btn-double').addEventListener('click',    () => socket.emit('action', { action: 'double' }));
el('btn-split').addEventListener('click',     () => socket.emit('action', { action: 'split' }));
el('btn-surrender').addEventListener('click', () => socket.emit('action', { action: 'surrender' }));

el('btn-ins-yes').addEventListener('click', () => socket.emit('action', { action: 'insurance' }));
el('btn-ins-no').addEventListener('click',  () => socket.emit('action', { action: 'no-insurance' }));

el('btn-start').addEventListener('click', () => socket.emit('start'));

// ─── Rules Panel ─────────────────────────────────────────────────────────────

el('rules-btn').addEventListener('click', () => el('rules-panel').classList.toggle('hidden'));
el('rules-close').addEventListener('click', () => el('rules-panel').classList.add('hidden'));

el('rules-save').addEventListener('click', () => {
  socket.emit('set-rules', {
    numDecks:           parseInt(el('r-decks').value),
    dealerHitsSoft17:   el('r-soft17').checked,
    blackjackPayout:    el('r-bj-pay').value,
    insurance:          el('r-ins').checked,
    surrender:          el('r-surrender').value,
    doubleOn:           el('r-double-on').value,
    doubleAfterSplit:   el('r-das').checked,
    maxSplitHands:      parseInt(el('r-max-split-hands').value),
    hitSplitAces:       el('r-hsa').checked,
    minBet:             parseInt(el('r-min').value),
    maxBet:             parseInt(el('r-max').value),
    buyIn:              parseInt(el('r-buyin').value),
    maxPlayers:         parseInt(el('r-max-players').value),
    bettingTime:        parseInt(el('r-btime').value),
  });
  el('rules-panel').classList.add('hidden');
});

function syncRulesPanel() {
  if (!state) return;
  const r = state.rules;
  setVal('r-decks',           r.numDecks);
  setChk('r-soft17',          r.dealerHitsSoft17);
  setVal('r-bj-pay',          r.blackjackPayout);
  setChk('r-ins',             r.insurance);
  setVal('r-surrender',       r.surrender);
  setVal('r-double-on',       r.doubleOn);
  setChk('r-das',             r.doubleAfterSplit);
  setVal('r-max-split-hands', r.maxSplitHands);
  setChk('r-hsa',             r.hitSplitAces);
  setVal('r-min',             r.minBet);
  setVal('r-max',             r.maxBet);
  setVal('r-buyin',           r.buyIn);
  setVal('r-max-players',     r.maxPlayers);
  setVal('r-btime',           r.bettingTime);
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function renderSidebar() {
  const list = el('players-list');
  list.innerHTML = '';
  if (!state) return;

  // Sort dealer to the top
  const sorted = [...state.players].sort((a, b) => {
    if (a.role === 'dealer' && b.role !== 'dealer') return -1;
    if (b.role === 'dealer' && a.role !== 'dealer') return 1;
    return 0;
  });

  for (const p of sorted) {
    const item = div('pl-item');
    if (!p.connected) item.classList.add('pl-gone');

    const nameRow = div('pl-name-row');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'pl-name';
    nameSpan.textContent = p.name;
    nameRow.appendChild(nameSpan);

    if (p.role === 'dealer') {
      const badge = document.createElement('span');
      badge.className = 'pl-dealer-badge';
      badge.textContent = 'DEALER';
      nameRow.appendChild(badge);
    } else if (p.id === state.hostId) {
      const h = document.createElement('span');
      h.className = 'pl-host'; h.textContent = 'HOST';
      nameRow.appendChild(h);
    }
    if (p.id === myId) {
      const y = document.createElement('span');
      y.className = 'pl-you'; y.textContent = 'you';
      nameRow.appendChild(y);
    }
    item.appendChild(nameRow);

    if (p.role !== 'dealer') {
      const chips = div('pl-chips');
      chips.textContent = `$${p.chips.toLocaleString()}`;
      item.appendChild(chips);
    }

    if (amHost && p.id !== myId && p.role !== 'dealer') {
      const actions = div('pl-actions');
      const rebuyBtn = document.createElement('button');
      rebuyBtn.className = 'pl-btn';
      rebuyBtn.textContent = '+ Rebuy';
      rebuyBtn.addEventListener('click', () => socket.emit('rebuy', { id: p.id }));
      actions.appendChild(rebuyBtn);

      if (state.phase === 'waiting') {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'pl-btn';
        kickBtn.textContent = 'Kick';
        kickBtn.addEventListener('click', () => {
          if (confirm(`Remove ${p.name} from the table?`)) socket.emit('kick', { id: p.id });
        });
        actions.appendChild(kickBtn);
      }
      item.appendChild(actions);
    }

    list.appendChild(item);
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--red);color:var(--text);padding:0.6rem 1.2rem;font-size:0.85rem;z-index:999;pointer-events:none;';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function el(id)          { return document.getElementById(id); }
function div(cls)        { const d = document.createElement('div'); if (cls) d.className = cls; return d; }
function setVal(id, v)   { el(id).value   = v; }
function setChk(id, v)   { el(id).checked = v; }
