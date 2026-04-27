// ============================================================================
// MUTATOR UI -- Panel cards, history, overlays, RPS, coin flip
// ============================================================================

import { state, elements, boardSquares, escapeHtml } from './state.js';
import { showModal, hideModal, flashStatus } from './ui.js';
import { startBackground, stopBackground } from './animated-bg.js';

// ============================================================================
// FLOATING TOOLTIP (escapes overflow containers)
// ============================================================================

let _tooltipEl = null;

function getTooltipEl() {
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.className = 'floating-tooltip';
    document.body.appendChild(_tooltipEl);
  }
  return _tooltipEl;
}

function showFloatingTooltip(e) {
  const tip = getTooltipEl();
  tip.textContent = e.currentTarget.dataset.tip;
  tip.style.opacity = '1';
  tip.style.visibility = 'visible';
  const rect = e.currentTarget.getBoundingClientRect();
  tip.style.left = `${rect.left + rect.width / 2}px`;
  tip.style.top = `${rect.top - 6}px`;
}

function hideFloatingTooltip() {
  const tip = getTooltipEl();
  tip.style.opacity = '0';
  tip.style.visibility = 'hidden';
}

// ============================================================================
// ANIMATION HELPERS
// ============================================================================

function elasticOut(t) {
  // Gentle overshoot (~5%) then settle -- no springy bounce
  const s = 1.3;
  const t1 = t - 1;
  return t1 * t1 * ((s + 1) * t1 + s) + 1;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * rAF-driven lerp of translateY on an element.
 * Returns a Promise that resolves when animation finishes.
 */
function lerpCardY(el, fromY, toY, duration, easeFn = easeOutCubic) {
  return new Promise(resolve => {
    const start = performance.now();
    el.style.transform = `translateY(${fromY}px)`;

    function tick(now) {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const eased = easeFn(t);
      const y = fromY + (toY - fromY) * eased;
      el.style.transform = `translateY(${y}px)`;

      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        el.style.transform = toY === 0 ? '' : `translateY(${toY}px)`;
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });
}

/**
 * Staggered elastic entrance from below the panel.
 * Each card gets 500ms to animate in, with 200ms stagger so each settles before the next starts.
 */
function animateEntranceSequence(cardEls) {
  const CARD_DURATION = 900;
  const STAGGER = 400;

  const promises = cardEls.map((el, i) => {
    const panelRect = elements.mutatorPanel?.getBoundingClientRect();
    const startY = panelRect ? panelRect.height + 60 : 400;
    el.style.transform = `translateY(${startY}px)`;
    el.style.opacity = '1';

    return new Promise(resolve => {
      setTimeout(() => {
        lerpCardY(el, startY, 0, CARD_DURATION, elasticOut).then(resolve);
      }, i * STAGGER);
    });
  });

  return Promise.all(promises);
}

/**
 * Slide cards down off the panel bottom -- generous, smooth exit.
 */
function animateExitDown(cardEls) {
  const EXIT_DURATION = 450;
  const STAGGER = 80;
  const promises = cardEls.map((el, i) => {
    const panelRect = elements.mutatorPanel?.getBoundingClientRect();
    const targetY = panelRect ? panelRect.height + 60 : 400;
    return new Promise(resolve => {
      setTimeout(() => {
        el.style.transition = `opacity ${EXIT_DURATION}ms ease-out`;
        el.style.opacity = '0.2';
        lerpCardY(el, 0, targetY, EXIT_DURATION, easeOutCubic).then(() => {
          el.remove();
          resolve();
        });
      }, i * STAGGER);
    });
  });
  return Promise.all(promises);
}

/**
 * Slide cards up off the panel top -- smooth staggered exit.
 */
function animateExitUp(cardEls) {
  const EXIT_DURATION = 450;
  const STAGGER = 80;
  const promises = cardEls.map((el, i) => {
    const elRect = el.getBoundingClientRect();
    const targetY = -(elRect.height + 60);
    return new Promise(resolve => {
      setTimeout(() => {
        el.style.transition = `opacity ${EXIT_DURATION}ms ease-out`;
        el.style.opacity = '0.2';
        lerpCardY(el, 0, targetY, EXIT_DURATION, easeOutCubic).then(() => {
          el.remove();
          resolve();
        });
      }, i * STAGGER);
    });
  });
  return Promise.all(promises);
}

/**
 * Gravity drop for expired persistent cards -- dramatic fade + fall.
 */
function animateDropOff(cardEl) {
  const DROP_DURATION = 600;
  const panelRect = elements.mutatorPanel?.getBoundingClientRect();
  const targetY = panelRect ? panelRect.height + 100 : 500;
  cardEl.style.transition = `opacity ${DROP_DURATION}ms ease-in`;
  cardEl.style.opacity = '0.15';
  return lerpCardY(cardEl, 0, targetY, DROP_DURATION, easeOutCubic).then(() => {
    cardEl.remove();
  });
}

// ============================================================================
// CARD DOM CREATION
// ============================================================================

/**
 * Unified card builder for choice cards and persistent/active cards.
 * @param {object} opts
 * @param {string} opts.id - Rule ID
 * @param {string} opts.name - Rule display name
 * @param {string} opts.description - Rule description
 * @param {string} opts.status - 'choice' | 'persistent'
 * @param {boolean} [opts.isChooser] - Whether user can interact (choice cards)
 * @param {string} [opts.badgeText] - Badge text override
 * @param {string} [opts.remainingText] - Remaining moves text
 * @param {object} [opts.ruleData] - Full rule data to attach to element
 */
function buildCardElement({ id, name, description, status, isChooser, badgeText, remainingText, ruleData }) {
  const card = document.createElement('div');
  card.className = 'mutator-card' + (status === 'choice' && !isChooser ? ' non-chooser' : '');
  card.dataset.ruleId = id;
  card.dataset.status = status;
  if (status === 'persistent') card.style.pointerEvents = 'none';

  const remSpan = remainingText
    ? `<span class="mutator-card-remaining">${remainingText}</span>`
    : '<span class="mutator-card-remaining hidden"></span>';

  card.innerHTML = `
    <h4 class="mutator-card-name">${escapeHtml(name)}</h4>
    <p class="mutator-card-desc">${escapeHtml(description || '')}</p>
    <span class="mutator-card-badge">${badgeText || ''}</span>
    ${remSpan}
  `;

  if (ruleData) card._ruleData = ruleData;
  return card;
}

function createCardElement(rule, isChooser) {
  const durationText = rule.duration
    ? (rule.duration[0] === rule.duration[1]
      ? `${rule.duration[0]} moves`
      : `${rule.duration[0]}-${rule.duration[1]} moves`)
    : 'Instant';

  return buildCardElement({
    id: rule.id,
    name: rule.name,
    description: rule.description,
    status: 'choice',
    isChooser,
    badgeText: durationText,
    ruleData: rule,
  });
}

function buildPersistentCard(ar) {
  const remaining = ar.expiresAtMove != null
    ? ar.expiresAtMove - state.mutatorState.moveCount
    : null;
  const remainingText = remaining != null
    ? `${remaining} move${remaining !== 1 ? 's' : ''} left`
    : '';

  return buildCardElement({
    id: ar.id,
    name: ar.name,
    description: ar.description || '',
    status: 'persistent',
    badgeText: ar.persistent ? 'Persistent' : 'Active',
    remainingText,
  });
}

// ============================================================================
// MUTATOR PANEL -- Card lifecycle
// ============================================================================

/**
 * Clear the panel. Called on game start.
 */
export function initMutatorPanel() {
  if (elements.mutatorPanel) {
    elements.mutatorPanel.innerHTML = '';
  }
  if (elements.activeMutatorsRow) {
    elements.activeMutatorsRow.innerHTML = '';
  }
  if (elements.mutatorChoicePanel) {
    elements.mutatorChoicePanel.classList.add('hidden');
  }
  state.mutatorHistory = [];
  state.mutatorPanelAnimating = false;
}

/**
 * Show 3 new choice cards in the panel.
 * First slides any existing persistent cards UP out, then animates
 * new cards UP from the bottom with elastic bounce.
 */
export async function showChoiceCards(options, isChooser) {
  if (!elements.mutatorPanel) return;
  state.mutatorPanelAnimating = true;
  state.isChoosingRule = isChooser;

  // Animate existing history cards up and out before showing choices
  const existingHistory = [...elements.mutatorPanel.querySelectorAll('.mutator-history-card')];
  if (existingHistory.length > 0) {
    await animateExitUp(existingHistory);
  }

  // Clear choice panel and show it
  elements.mutatorPanel.innerHTML = '';
  if (elements.mutatorChoicePanel) {
    elements.mutatorChoicePanel.classList.remove('hidden');
  }

  // Create new choice cards
  const cardEls = options.map(rule => {
    const card = createCardElement(rule, isChooser);
    card.style.opacity = '0';
    elements.mutatorPanel.appendChild(card);

    if (isChooser) {
      card.addEventListener('click', () => {
        if (state.mutatorPanelAnimating && !state.isChoosingRule) return;
        state.socket.emit('selectMutator', { ruleId: rule.id });
        // Disable further clicks immediately
        elements.mutatorPanel.querySelectorAll('.mutator-card[data-status="choice"]').forEach(c => {
          c.style.pointerEvents = 'none';
        });
      });
    }

    return card;
  });

  // Add waiting text for non-chooser
  if (!isChooser) {
    const waitingP = document.createElement('p');
    waitingP.className = 'mutator-waiting';
    waitingP.id = 'mutator-panel-waiting';
    waitingP.textContent = 'Waiting for opponent to choose...';
    waitingP.style.opacity = '0';
    elements.mutatorPanel.appendChild(waitingP);
    // Fade in after cards settle (700ms per card + 400ms stagger)
    setTimeout(() => { waitingP.style.opacity = '1'; waitingP.style.transition = 'opacity 0.4s ease-out'; }, 700 + 400 * options.length);
  }

  // Animate entrance
  await animateEntranceSequence(cardEls);
  startBackground(elements.mutatorChoicePanel || elements.mutatorPanel);
  state.mutatorPanelAnimating = false;
}

/**
 * Highlight the selected card (both clients see this).
 * Slides unselected cards down off the panel.
 */
export async function highlightSelectedCard(ruleId) {
  if (!elements.mutatorPanel) return;
  state.mutatorPanelAnimating = true;
  state.isChoosingRule = false;

  // Remove waiting text
  const waitingEl = document.getElementById('mutator-panel-waiting');
  if (waitingEl) waitingEl.remove();

  stopBackground();

  const allChoiceCards = [...elements.mutatorPanel.querySelectorAll('.mutator-card[data-status="choice"]')];
  const selectedCard = allChoiceCards.find(c => c.dataset.ruleId === ruleId);
  const unselectedCards = allChoiceCards.filter(c => c.dataset.ruleId !== ruleId);

  // Highlight selected
  if (selectedCard) {
    selectedCard.classList.add('selected');
    selectedCard.style.pointerEvents = 'none';
  }

  // Brief hold so both players see the highlight
  await new Promise(r => setTimeout(r, 700));

  // Slide unselected down
  if (unselectedCards.length > 0) {
    await animateExitDown(unselectedCards);
  }

  // Slide selected card out, then restore history cards
  if (selectedCard) {
    await animateExitDown([selectedCard]);
  }

  // Slide history cards back in (panel stays visible)
  await animateHistoryEntrance();

  state.mutatorPanelAnimating = false;
}

/**
 * Add a persistent/active mutator card to the bottom row.
 */
export function addPersistentCard(rule) {
  if (!elements.activeMutatorsRow) return;

  // Don't duplicate
  if (elements.activeMutatorsRow.querySelector(`.active-mutator-card[data-rule-id="${rule.id}"]`)) return;

  const activeRule = state.mutatorState?.activeRules?.find(ar => ar.id === rule.id);
  const card = buildActiveCard(activeRule || rule);
  elements.activeMutatorsRow.appendChild(card);
}

/**
 * Update remaining move counts on all active mutator cards in bottom row.
 */
export function updatePersistentCards() {
  if (!elements.activeMutatorsRow || !state.mutatorState) return;

  const cards = elements.activeMutatorsRow.querySelectorAll('.active-mutator-card');
  cards.forEach(card => {
    const ruleId = card.dataset.ruleId;
    const activeRule = state.mutatorState.activeRules?.find(ar => ar.id === ruleId);
    const durationEl = card.querySelector('.rule-duration');

    if (activeRule && durationEl && activeRule.expiresAtMove != null) {
      const left = activeRule.expiresAtMove - state.mutatorState.moveCount;
      durationEl.textContent = `${left} move${left !== 1 ? 's' : ''} left`;
    }
  });
}

/**
 * Remove an expired card from the active mutators row.
 */
export async function expirePersistentCard(ruleId) {
  if (!elements.activeMutatorsRow) return;
  const card = elements.activeMutatorsRow.querySelector(`.active-mutator-card[data-rule-id="${ruleId}"]`);
  if (card) {
    card.style.transition = 'opacity 0.4s ease-out, transform 0.4s ease-out';
    card.style.opacity = '0';
    card.style.transform = 'translateY(20px) scale(0.9)';
    await new Promise(r => setTimeout(r, 450));
    card.remove();
  }
}

/**
 * Remove a choice card (for instant rules that don't persist).
 * Also hides the choice panel if no cards remain.
 */
export async function removeChoiceCard(ruleId) {
  if (!elements.mutatorPanel) return;
  const card = elements.mutatorPanel.querySelector(`.mutator-card[data-rule-id="${ruleId}"]`);
  if (card) {
    await animateExitDown([card]);
  }
  // Hide choice panel if empty
  if (elements.mutatorChoicePanel && elements.mutatorPanel.querySelectorAll('.mutator-card').length === 0) {
    elements.mutatorChoicePanel.classList.add('hidden');
  }
}

/**
 * Re-add any active persistent rules that are missing from the bottom row.
 * Called after a selection flow completes so previously-active rules reappear.
 */
export function syncPersistentCards() {
  if (!elements.activeMutatorsRow || !state.mutatorState) return;

  const activeRules = state.mutatorState.activeRules || [];
  activeRules.forEach(ar => {
    if (elements.activeMutatorsRow.querySelector(`.active-mutator-card[data-rule-id="${ar.id}"]`)) return;
    elements.activeMutatorsRow.appendChild(buildActiveCard(ar));
  });
}

/**
 * Restore active mutator cards without animation (for game resume).
 */
export function restorePersistentCards() {
  if (!elements.activeMutatorsRow || !state.mutatorState) return;
  elements.activeMutatorsRow.innerHTML = '';

  const activeRules = state.mutatorState.activeRules || [];
  activeRules.forEach(ar => {
    elements.activeMutatorsRow.appendChild(buildActiveCard(ar));
  });
}

// ============================================================================
// ACTIVE MUTATOR CARD BUILDER (bottom row)
// ============================================================================

/**
 * Build an active mutator card for the bottom row.
 */
function buildActiveCard(ar) {
  const card = document.createElement('div');
  card.className = 'active-mutator-card';
  card.dataset.ruleId = ar.id;

  const desc = document.createElement('p');
  desc.className = 'rule-desc';
  desc.textContent = ar.name;
  card.appendChild(desc);

  const duration = document.createElement('p');
  duration.className = 'rule-duration';
  if (ar.expiresAtMove != null && state.mutatorState) {
    const left = ar.expiresAtMove - state.mutatorState.moveCount;
    duration.textContent = `${left} move${left !== 1 ? 's' : ''} left`;
  } else if (ar.persistent) {
    duration.textContent = 'Persistent';
  } else {
    duration.textContent = 'Active';
  }
  card.appendChild(duration);

  if (ar.description) {
    card.setAttribute('data-tooltip', ar.description);
  }

  return card;
}

// ============================================================================
// MUTATOR HISTORY (displayed in the choice panel when idle)
// ============================================================================

/**
 * Add a completed mutator to the history log and re-render in panel.
 */
export function addToHistory(rule, type) {
  state.mutatorHistory.push({
    id: rule.id,
    name: rule.name,
    description: rule.description || '',
    type,
  });
}

/**
 * Build a small history card for a previously-activated mutator.
 */
function buildHistoryCard(entry) {
  const card = document.createElement('div');
  card.className = 'mutator-history-card';
  card.dataset.ruleId = entry.id;

  const typeLabel = entry.type === 'instant' ? 'Instant'
    : entry.type === 'expired' ? 'Expired'
    : 'Used';

  card.innerHTML = `
    <span class="history-card-name">${escapeHtml(entry.name)}</span>
    <span class="history-card-type">${typeLabel}</span>
  `;

  if (entry.description) {
    card.addEventListener('mouseenter', showFloatingTooltip);
    card.addEventListener('mouseleave', hideFloatingTooltip);
    card.dataset.tip = entry.description;
  }

  return card;
}

/**
 * Render history cards into the choice panel (no animation).
 * Called after selection completes or on resume.
 */
export function renderMutatorHistory() {
  if (!elements.mutatorPanel) return;
  // Only render if no active choice is showing
  const hasChoiceCards = elements.mutatorPanel.querySelector('.mutator-card[data-status="choice"]');
  if (hasChoiceCards) return;

  // Clear panel and populate with history
  elements.mutatorPanel.innerHTML = '';
  if (state.mutatorHistory.length === 0) return;

  state.mutatorHistory.forEach(entry => {
    elements.mutatorPanel.appendChild(buildHistoryCard(entry));
  });
}

/**
 * Animate history cards sliding back into the panel from below.
 */
async function animateHistoryEntrance() {
  if (!elements.mutatorPanel) return;

  elements.mutatorPanel.innerHTML = '';
  if (state.mutatorHistory.length === 0) return;

  const cards = state.mutatorHistory.map(entry => {
    const card = buildHistoryCard(entry);
    card.style.opacity = '0';
    elements.mutatorPanel.appendChild(card);
    return card;
  });

  // Gentle staggered fade-slide from below
  const DURATION = 400;
  const STAGGER = 60;

  const promises = cards.map((card, i) => {
    return new Promise(resolve => {
      setTimeout(() => {
        card.style.opacity = '1';
        lerpCardY(card, 30, 0, DURATION, easeOutCubic).then(resolve);
      }, i * STAGGER);
    });
  });

  await Promise.all(promises);
}

// ============================================================================
// BOARD OVERLAYS
// ============================================================================

export function renderBoardOverlays() {
  document.querySelectorAll('.board-overlay').forEach(el => el.remove());
  if (!state.mutatorState) return;

  for (const [, data] of computeDesiredOverlays()) {
    addSquareOverlay(data.square, data.type, data.icon);
  }
}

function addSquareOverlay(square, type, icon) {
  const squareEl = boardSquares.get(square);
  if (!squareEl) return;
  const overlay = document.createElement('div');
  overlay.className = `board-overlay board-overlay-${type}`;
  overlay.textContent = icon;
  squareEl.appendChild(overlay);
}

// ============================================================================
// OVERLAY ANIMATION SYSTEM
// ============================================================================

const OVERLAY_ANIM_MAP = {
  mine: 'drop', bomb: 'drop', pit: 'drop', timebomb: 'drop',
  frozen: 'frost', iceage: 'frost',
  portal: 'swirl',
  death: 'flash',
  tornado: 'spin',
  mitosis: 'fade',
  treasure: 'fade', invulnerable: 'fade', blocked: 'fade', nomansland: 'fade',
};

function snapshotOverlays() {
  const snapshot = new Map();
  document.querySelectorAll('.board-overlay').forEach(el => {
    const square = el.parentElement?.dataset?.square;
    const typeClass = [...el.classList].find(c => c.startsWith('board-overlay-') && c !== 'board-overlay');
    const type = typeClass ? typeClass.replace('board-overlay-', '') : 'unknown';
    if (square) snapshot.set(`${type}:${square}`, el);
  });
  return snapshot;
}

function computeDesiredOverlays() {
  const result = new Map();
  if (!state.mutatorState) return result;
  const mods = state.mutatorState.boardModifiers || {};
  const mc = state.mutatorState.moveCount || 0;
  const alive = (entry) => !entry.expiresAtMove || mc < entry.expiresAtMove;
  const COLS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ROWS = ['1', '2', '3', '4', '5', '6', '7', '8'];

  if (mods.mines) mods.mines.forEach(m => result.set(`mine:${m.square}`, { type: 'mine', icon: '\uD83D\uDCA3', square: m.square }));
  if (mods.blockedSquares) mods.blockedSquares.forEach(b => result.set(`blocked:${b.square}`, { type: 'blocked', icon: '\u2715', square: b.square }));
  if (mods.bottomlessPits) mods.bottomlessPits.forEach(b => result.set(`pit:${b.square}`, { type: 'pit', icon: '\uD83D\uDC80', square: b.square }));
  if (mods.portals) mods.portals.filter(alive).forEach(p => {
    result.set(`portal:${p.square1}`, { type: 'portal', icon: '\uD83C\uDF00', square: p.square1 });
    result.set(`portal:${p.square2}`, { type: 'portal', icon: '\uD83C\uDF00', square: p.square2 });
  });
  if (mods.treasureSquares) mods.treasureSquares.forEach(t => {
    if (t.active) result.set(`treasure:${t.square}`, { type: 'treasure', icon: '\uD83D\uDCE6', square: t.square });
  });
  if (mods.deathSquares) mods.deathSquares.filter(alive).forEach(d => result.set(`death:${d.square}`, { type: 'death', icon: '\u26A1', square: d.square }));
  if (mods.tornadoSquare) {
    result.set(`tornado:${mods.tornadoSquare.square}`, { type: 'tornado', icon: '\uD83C\uDF2A\uFE0F', square: mods.tornadoSquare.square });
  }
  if (mods.frozenColumns) mods.frozenColumns.filter(alive).forEach(fc => {
    for (let i = 0; i < ROWS.length; i++) {
      const sq = fc.column + ROWS[i];
      result.set(`frozen:${sq}`, { type: 'frozen', icon: '\u2744\uFE0F', square: sq, rowIndex: i });
    }
  });
  if (mods.invulnerable) mods.invulnerable.filter(alive).forEach(iv => result.set(`invulnerable:${iv.square}`, { type: 'invulnerable', icon: '\uD83D\uDEE1\uFE0F', square: iv.square }));
  if (mods.livingBombs) mods.livingBombs.filter(alive).forEach(lb => result.set(`bomb:${lb.square}`, { type: 'bomb', icon: '\uD83D\uDCA5', square: lb.square }));

  if (state.mutatorState.activeRules) {
    state.mutatorState.activeRules.forEach(ar => {
      if (ar.id === 'mitosis' && ar.choiceData) {
        result.set(`mitosis:${ar.choiceData}`, { type: 'mitosis', icon: '\uD83E\uDDEC', square: ar.choiceData });
      }
      if (ar.id === 'no_mans_land' && ar.choiceData) {
        const col = typeof ar.choiceData === 'number' ? COLS[ar.choiceData] : ar.choiceData;
        for (let i = 0; i < ROWS.length; i++) {
          const sq = col + ROWS[i];
          result.set(`nomansland:${sq}`, { type: 'nomansland', icon: '\u2718', square: sq });
        }
      }
    });
  }
  if (state.mutatorState.activeRules && state.mutatorState.activeRules.some(ar => ar.id === 'ice_age')) {
    for (const col of ['a', 'h']) {
      for (let i = 0; i < ROWS.length; i++) {
        const sq = col + ROWS[i];
        result.set(`iceage:${sq}`, { type: 'iceage', icon: '\u2744\uFE0F', square: sq, rowIndex: i });
      }
    }
  }
  if (state.mutatorState.activeRules && state.mutatorState.activeRules.some(ar => ar.id === 'time_bomb')) {
    for (let i = 0; i < ROWS.length; i++) {
      const sq = 'e' + ROWS[i];
      result.set(`timebomb:${sq}`, { type: 'timebomb', icon: '\uD83D\uDCA3', square: sq });
    }
  }

  return result;
}

function addSquareOverlayAnimated(square, type, icon, rowIndex) {
  const squareEl = boardSquares.get(square);
  if (!squareEl) return;
  const overlay = document.createElement('div');
  const animType = OVERLAY_ANIM_MAP[type] || 'fade';
  overlay.className = `board-overlay board-overlay-${type} board-overlay-entering-${animType}`;
  overlay.textContent = icon;
  if ((animType === 'frost') && rowIndex !== undefined) {
    overlay.style.animationDelay = `${rowIndex * 50}ms`;
  }
  squareEl.appendChild(overlay);
  overlay.addEventListener('animationend', () => {
    overlay.classList.remove(`board-overlay-entering-${animType}`);
    overlay.style.animationDelay = '';
  }, { once: true });
}

function animateOverlayRemoval(el) {
  el.classList.add('board-overlay-exiting');
  el.addEventListener('animationend', () => {
    if (el.parentNode) el.remove();
  }, { once: true });
  setTimeout(() => {
    if (el.parentNode) el.remove();
  }, 300);
}

export function renderBoardOverlaysAnimated() {
  const oldSnapshot = snapshotOverlays();
  const newDesired = computeDesiredOverlays();

  for (const [key, el] of oldSnapshot) {
    if (!newDesired.has(key)) {
      animateOverlayRemoval(el);
    }
  }

  for (const [key, data] of newDesired) {
    if (!oldSnapshot.has(key)) {
      addSquareOverlayAnimated(data.square, data.type, data.icon, data.rowIndex);
    }
  }
}

// ============================================================================
// TARGET SELECTION
// ============================================================================

export function showTargetSelection(promptText, actionType, callback, validSquares) {
  state.isSelectingTarget = true;
  state.targetActionType = actionType;
  state.targetSelectionCallback = callback;

  const bar = document.getElementById('target-selection-bar');
  const text = document.getElementById('target-selection-text');
  if (bar && text) {
    text.textContent = promptText;
    bar.classList.remove('hidden');
  }

  const isSophie = actionType === 'sophie';
  const highlightClass = isSophie ? 'square-highlight-sophie' : 'square-highlight-target';
  state.targetHighlightClass = highlightClass;

  // Build set of king squares to exclude from piece-targeting choices
  const kingSquares = new Set();
  if (['piece', 'friendly_piece', 'enemy_piece'].includes(actionType) && state.chessInstance) {
    const board = state.chessInstance.board();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p && p.type === 'k') {
          kingSquares.add('abcdefgh'[c] + (8 - r));
        }
      }
    }
  }

  const allowed = validSquares ? new Set(validSquares) : null;
  boardSquares.forEach((el, sq) => {
    if (kingSquares.has(sq)) return;
    if (!allowed || allowed.has(sq)) {
      el.classList.add(highlightClass);
      el.addEventListener('click', handleTargetClick);
    }
  });
}

function handleTargetClick(event) {
  if (!state.isSelectingTarget || !state.targetSelectionCallback) return;

  const squareEl = event.currentTarget;
  const square = squareEl.dataset.square;
  if (!square) return;

  // For column-type choices, extract just the column letter
  // For row-type choices, extract just the row number
  let target = square;
  if (state.targetActionType === 'column') {
    target = square[0];
  } else if (state.targetActionType === 'row') {
    target = square[1];
  }

  state.targetSelectionCallback(target);
  hideTargetSelection();
}

export function hideTargetSelection() {
  state.isSelectingTarget = false;
  state.targetSelectionCallback = null;
  state.targetActionType = null;

  const bar = document.getElementById('target-selection-bar');
  if (bar) bar.classList.add('hidden');

  const cls = state.targetHighlightClass || 'square-highlight-target';
  boardSquares.forEach((el) => {
    el.classList.remove('square-highlight-target');
    el.classList.remove('square-highlight-sophie');
    el.removeEventListener('click', handleTargetClick);
  });
  state.targetHighlightClass = null;
}

// ============================================================================
// RPS UI
// ============================================================================

let _rpsAbort = null;
const RPS_ICONS = { rock: '\u{1FAA8}', paper: '\uD83D\uDCC4', scissors: '\u2702\uFE0F' };

export function showRPSModal(payload) {
  const modal = document.getElementById('rps-modal');
  const context = document.getElementById('rps-context');
  const pickPhase = document.getElementById('rps-pick-phase');
  const showdown = document.getElementById('rps-showdown');
  const outcomeEl = document.getElementById('rps-outcome');

  if (context) context.textContent = payload.message || 'A capture is being contested!';
  if (pickPhase) pickPhase.classList.remove('hidden');
  if (showdown) showdown.classList.add('hidden');
  if (outcomeEl) outcomeEl.classList.add('hidden');

  if (_rpsAbort) _rpsAbort.abort();
  _rpsAbort = new AbortController();
  const { signal } = _rpsAbort;

  modal.querySelectorAll('.rps-btn').forEach(btn => {
    btn.disabled = false;
    btn.classList.remove('rps-fade-out');
    btn.addEventListener('click', () => {
      state.socket.emit('rpsChoice', { choice: btn.dataset.choice });
      // Fade out unselected buttons, highlight chosen
      modal.querySelectorAll('.rps-btn').forEach(b => {
        b.disabled = true;
        if (b !== btn) b.classList.add('rps-fade-out');
      });
      btn.style.borderColor = 'var(--accent)';
      btn.style.background = 'rgba(129, 182, 76, 0.15)';
      // Store choice for showdown phase
      state._rpsMyChoice = btn.dataset.choice;
    }, { signal });
  });

  // Store attacker/defender from prompt
  state._rpsAttacker = payload.attacker;
  state._rpsDefender = payload.defender;

  showModal('rps-modal');
}

export function showRPSResult(payload) {
  const pickPhase = document.getElementById('rps-pick-phase');
  const showdown = document.getElementById('rps-showdown');
  const youLabel = document.getElementById('rps-you-label');
  const oppLabel = document.getElementById('rps-opp-label');
  const youCard = document.getElementById('rps-you-card');
  const oppCard = document.getElementById('rps-opp-card');
  const oppChoice = document.getElementById('rps-opp-choice');
  const outcomeEl = document.getElementById('rps-outcome');

  // Determine which choices are mine vs opponent
  const isAttacker = payload.attacker === state.myColor;
  const myChoice = isAttacker ? payload.attackerChoice : payload.defenderChoice;
  const theirChoice = isAttacker ? payload.defenderChoice : payload.attackerChoice;

  // Set labels to White/Black
  const myColorName = state.myColor === 'w' ? 'White' : 'Black';
  const oppColorName = state.myColor === 'w' ? 'Black' : 'White';
  if (youLabel) youLabel.textContent = myColorName;
  if (oppLabel) oppLabel.textContent = oppColorName;

  // Set card contents
  const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1);
  if (youCard) youCard.textContent = `${RPS_ICONS[myChoice] || ''} ${capitalize(myChoice)}`;
  if (oppChoice) oppChoice.textContent = `${RPS_ICONS[theirChoice] || ''} ${capitalize(theirChoice)}`;

  // Reset opponent card flip state
  if (oppCard) oppCard.classList.remove('flipped');

  // Transition: hide pick buttons, show showdown
  if (pickPhase) pickPhase.classList.add('hidden');
  if (showdown) showdown.classList.remove('hidden');

  // After a beat, flip opponent's card
  setTimeout(() => {
    if (oppCard) oppCard.classList.add('flipped');
  }, 500);

  // After flip completes, show outcome
  setTimeout(() => {
    if (outcomeEl) {
      if (payload.outcome === 'tie') {
        outcomeEl.textContent = 'Tie! Capture proceeds.';
      } else if (payload.captureProceeds) {
        outcomeEl.textContent = 'Attack succeeds!';
      } else {
        outcomeEl.textContent = 'Attack blocked!';
      }
      outcomeEl.classList.remove('hidden');
    }
  }, 1200);

  // Close modal after result is shown
  setTimeout(() => {
    hideModal('rps-modal');
  }, 3500);
}

// ============================================================================
// COIN FLIP (All on Red)
// ============================================================================

let pendingCoinResult = null;

export function onCoinFlip(payload) {
  pendingCoinResult = payload.result;
  const isMyTurn = payload.forPlayer === state.myColor;
  showCoinFlipOverlay(payload.result, isMyTurn);
}

function showCoinFlipOverlay(result, isMyTurn) {
  const overlay = document.getElementById('coin-flip-overlay');
  const coin = document.getElementById('coin-flip-coin');
  const instruction = document.getElementById('coin-flip-instruction');
  const resultText = document.getElementById('coin-flip-result-text');

  coin.className = 'coin';
  resultText.classList.add('hidden');
  instruction.classList.remove('hidden');

  if (isMyTurn) {
    instruction.textContent = 'Click the coin to flip!';
    coin.style.cursor = 'pointer';
    coin.onclick = () => {
      coin.onclick = null;
      coin.style.cursor = 'default';
      instruction.classList.add('hidden');
      state.socket.emit('coinFlipStart');
      startCoinAnimation(coin, result, resultText, overlay);
    };
  } else {
    instruction.textContent = 'Opponent is flipping...';
    coin.style.cursor = 'default';
    coin.onclick = null;
  }

  showModal('coin-flip-overlay');
}

export function onCoinFlipStartAnimation() {
  const coin = document.getElementById('coin-flip-coin');
  const resultText = document.getElementById('coin-flip-result-text');
  const overlay = document.getElementById('coin-flip-overlay');
  const instruction = document.getElementById('coin-flip-instruction');
  if (instruction) instruction.classList.add('hidden');
  startCoinAnimation(coin, pendingCoinResult, resultText, overlay);
}

function startCoinAnimation(coin, result, resultText, overlay) {
  coin.className = 'coin flipping' + (result === 'tails' ? ' land-tails' : '');

  setTimeout(() => {
    resultText.classList.remove('hidden');
    resultText.className = 'coin-flip-result-text ' + result;
    resultText.textContent = result === 'heads'
      ? 'Heads \u2014 move freely!'
      : 'Tails \u2014 King only!';

    setTimeout(() => {
      hideModal('coin-flip-overlay');
    }, 1500);
  }, 1500);
}

// ============================================================================
// RISK IT ROOK COIN FLIP OVERLAY
// ============================================================================

export function showRiskItRookOverlay(flipData) {
  return new Promise((resolve) => {
    const isChooser = flipData.chooserColor === state.myColor;
    const chooserLabel = isChooser ? 'Your' : "Opponent's";
    const opponentLabel = isChooser ? "Opponent's" : 'Your';

    // Create temporary overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    overlay.id = 'risk-it-rook-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.innerHTML = `<div class="modal-content coin-flip-content risk-it-rook-content"></div>`;
    document.body.appendChild(overlay);

    const content = overlay.querySelector('.modal-content');

    // Phase 1: Chooser's flip (1 coin)
    content.innerHTML = `
      <h2>Risk it Rook</h2>
      <p class="risk-phase-label">${chooserLabel} flip:</p>
      <div class="risk-coins-row">
        <div class="coin" id="rir-coin-1">
          <div class="coin-face coin-heads">H</div>
          <div class="coin-face coin-tails">T</div>
        </div>
      </div>
      <p id="rir-result-1" class="coin-flip-result-text hidden"></p>
    `;

    // Start phase 1 animation
    setTimeout(() => {
      const coin1 = document.getElementById('rir-coin-1');
      const result1 = document.getElementById('rir-result-1');
      coin1.className = 'coin flipping' + (flipData.chooserFlip === 'tails' ? ' land-tails' : '');

      setTimeout(() => {
        result1.classList.remove('hidden');
        result1.className = 'coin-flip-result-text ' + flipData.chooserFlip;
        if (flipData.chooserFlip === 'heads') {
          result1.textContent = flipData.chooserSquare
            ? `Heads \u2014 Rook spawned!`
            : 'Heads \u2014 but no empty squares!';
        } else {
          result1.textContent = 'Tails \u2014 no Rook!';
        }

        // Transition to phase 2
        setTimeout(() => showPhase2(), 1500);
      }, 1500);
    }, 400);

    function showPhase2() {
      content.innerHTML = `
        <h2>Risk it Rook</h2>
        <p class="risk-phase-label">${opponentLabel} flips (need both heads):</p>
        <div class="risk-coins-row">
          <div class="coin" id="rir-coin-2a">
            <div class="coin-face coin-heads">H</div>
            <div class="coin-face coin-tails">T</div>
          </div>
          <div class="coin" id="rir-coin-2b">
            <div class="coin-face coin-heads">H</div>
            <div class="coin-face coin-tails">T</div>
          </div>
        </div>
        <p id="rir-result-2" class="coin-flip-result-text hidden"></p>
      `;

      setTimeout(() => {
        const coin2a = document.getElementById('rir-coin-2a');
        const coin2b = document.getElementById('rir-coin-2b');
        const result2 = document.getElementById('rir-result-2');

        coin2a.className = 'coin flipping' + (flipData.opponentFlip1 === 'tails' ? ' land-tails' : '');
        setTimeout(() => {
          coin2b.className = 'coin flipping' + (flipData.opponentFlip2 === 'tails' ? ' land-tails' : '');
        }, 300);

        setTimeout(() => {
          result2.classList.remove('hidden');
          const bothHeads = flipData.opponentFlip1 === 'heads' && flipData.opponentFlip2 === 'heads';
          if (bothHeads) {
            result2.className = 'coin-flip-result-text heads';
            result2.textContent = flipData.opponentSquare
              ? 'Both Heads \u2014 Rook spawned!'
              : 'Both Heads \u2014 but no empty squares!';
          } else {
            result2.className = 'coin-flip-result-text tails';
            result2.textContent = 'No Rook!';
          }

          // Close and clean up
          setTimeout(() => {
            overlay.remove();
            resolve();
          }, 1800);
        }, 1800);
      }, 400);
    }
  });
}

// ============================================================================
// RISK IT ROOK MANUAL FLIP
// ============================================================================

let _rirAbort = null;

export function onRiskItRookFlipPrompt(payload) {
  const bar = document.getElementById('coin-flip-manual');
  const text = document.getElementById('coin-flip-manual-text');
  if (!bar || !text) return;

  text.textContent = payload.flipLabel || 'Risk it Rook: What did you flip?';
  bar.classList.remove('hidden');

  if (_rirAbort) _rirAbort.abort();
  _rirAbort = new AbortController();
  const { signal } = _rirAbort;

  bar.querySelectorAll('.coin-manual-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.socket.emit('riskItRookFlipChoice', { choice: btn.dataset.choice });
      bar.classList.add('hidden');
    }, { signal });
  });
}

export function onRiskItRookFlipResult(payload) {
  const bar = document.getElementById('coin-flip-manual');
  if (bar) bar.classList.add('hidden');

  const isChooserPhase = payload.phase === 'chooser';
  const isMyFlip = payload.forPlayer === state.myColor;
  const who = isMyFlip ? 'You' : 'Opponent';
  const label = isChooserPhase ? '' : ` (flip ${payload.phase === 'opponent1' ? '1/2' : '2/2'})`;

  flashStatus(`${who} flipped: ${payload.result}${label}`, 2000);
}

let _coinAbort = null;

export function onCoinFlipPrompt(payload) {
  if (payload.forPlayer !== state.myColor) return;
  const bar = document.getElementById('coin-flip-manual');
  if (bar) bar.classList.remove('hidden');

  if (_coinAbort) _coinAbort.abort();
  _coinAbort = new AbortController();
  const { signal } = _coinAbort;

  bar.querySelectorAll('.coin-manual-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.socket.emit('coinFlipChoice', { choice: btn.dataset.choice });
      bar.classList.add('hidden');
    }, { signal });
  });
}

export function onCoinFlipResult(payload) {
  const bar = document.getElementById('coin-flip-manual');
  if (bar) bar.classList.add('hidden');

  if (payload.manual && payload.forPlayer !== state.myColor) {
    flashStatus(
      payload.result === 'heads' ? 'Opponent chose: Heads \u2014 move freely!' : 'Opponent chose: Tails \u2014 King only!',
      3000
    );
  }
}
