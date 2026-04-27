// ============================================================================
// BOARD -- Rendering, animation, legal moves, move submission
// ============================================================================

import {
  state, elements, boardSquares, pieceImageCache, renderedPieces,
  COLOR_NAMES, PIECE_NAMES, PIECE_ICONS, assetBasePath, PIECE_VARIATION_COUNTS,
} from './state.js';
import { showModal, hideModal, flashStatus } from './ui.js';

// Overlay renderer hook -- set by main.js to wire mutatorUI without circular import
let _renderBoardOverlays = () => {};
export function setOverlayRenderer(fn) { _renderBoardOverlays = fn; }

// Cache for modifier Sets -- invalidated when mutatorState reference changes
let _modCache = { ref: null, invulnerable: null, frozenCols: null, blocked: null, nmlCols: null };
const _COLS_CACHE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function getModifierSets() {
  const ms = state.mutatorState;
  if (ms !== null && _modCache.ref === ms) return _modCache;
  _modCache.ref = ms;
  const bm = ms?.boardModifiers;
  const mc = ms?.moveCount ?? 0;
  _modCache.invulnerable = bm?.invulnerable ? new Set(bm.invulnerable.filter(iv => !iv.expiresAtMove || mc < iv.expiresAtMove).map(iv => iv.square)) : null;
  _modCache.frozenCols = bm?.frozenColumns ? new Set(bm.frozenColumns.filter(fc => !fc.expiresAtMove || mc < fc.expiresAtMove).map(fc => fc.column)) : null;
  _modCache.blocked = bm?.blockedSquares ? new Set(bm.blockedSquares.map(b => b.square)) : null;
  const nml = new Set();
  if (ms?.activeRules) {
    for (const ar of ms.activeRules) {
      if (ar.id === 'no_mans_land' && ar.choiceData != null) {
        const col = typeof ar.choiceData === 'number' ? _COLS_CACHE[ar.choiceData] : ar.choiceData;
        if (col) nml.add(col);
      }
    }
  }
  _modCache.nmlCols = nml;
  return _modCache;
}

// ============================================================================
// PIECE VARIATION HELPERS
// ============================================================================

function getRandomVariation(pieceType) {
  const count = PIECE_VARIATION_COUNTS[pieceType] || 1;
  return Math.floor(Math.random() * count) + 1;
}

function getPieceImagePath(color, type, variation) {
  const colorName = color === 'w' ? 'white' : 'black';
  const typeNames = { k: 'king', q: 'queen', b: 'bishop', n: 'knight', r: 'rook', p: 'pawn' };
  return `${assetBasePath}/images/pieces/${colorName}-${typeNames[type]}-${variation}.png`;
}

export function updatePieceVariations(fen) {
  const pieces = parseFenToPieces(fen);
  const oldVariations = state.pieceArtVariations;
  const newVariations = {};

  for (const [square, piece] of pieces) {
    const { color, type } = piece;
    const existing = oldVariations[square];

    if (existing && existing.color === color && existing.type === type) {
      newVariations[square] = existing;
    } else {
      newVariations[square] = { color, type, variation: getRandomVariation(type) };
    }
  }

  state.pieceArtVariations = newVariations;
}

// ============================================================================
// BOARD RENDERING
// ============================================================================

export function initializeBoard() {
  const boardEl = elements.board;
  if (!boardEl) return;
  boardEl.innerHTML = '';
  boardSquares.clear();
  renderedPieces.clear();

  const flipped = !state.isSpectator && state.myColor === 'b';

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      let rank, fileIndex;
      if (flipped) {
        rank = row + 1;
        fileIndex = 7 - col;
      } else {
        rank = 8 - row;
        fileIndex = col;
      }

      const fileChar = String.fromCharCode(97 + fileIndex);
      const square = `${fileChar}${rank}`;

      const squareEl = document.createElement('button');
      squareEl.type = 'button';
      squareEl.className = `square ${(fileIndex + rank) % 2 === 0 ? 'dark' : 'light'}`;
      squareEl.dataset.square = square;
      squareEl.setAttribute('aria-label', `Square ${square}`);
      squareEl.addEventListener('click', () => handleSquareClick(square));
      boardEl.appendChild(squareEl);
      boardSquares.set(square, squareEl);
    }
  }
}

export function renderBoard() {
  if (!state.currentFen) return;

  if (boardSquares.size === 0) {
    initializeBoard();
  }

  updatePieceVariations(state.currentFen);
  const pieces = parseFenToPieces(state.currentFen);

  for (const [square, squareEl] of boardSquares) {
    const piece = pieces.get(square);
    const variation = piece ? (state.pieceArtVariations[square]?.variation || 1) : null;
    const newKey = piece ? `${piece.color}:${piece.type}:${variation}` : null;
    const oldKey = renderedPieces.get(square) || null;

    if (newKey !== oldKey) {
      squareEl.replaceChildren();
      if (piece) {
        const img = createPieceImg(piece.color, piece.type, square);
        if (img) squareEl.appendChild(img);
      }
      renderedPieces.set(square, newKey);
    }
  }

  updateHighlights(pieces);
  _renderBoardOverlays();
}

export function updateHighlights(pieces) {
  if (!pieces) {
    pieces = parseFenToPieces(state.currentFen);
  }

  const inCheck = state.chessInstance && state.chessInstance.inCheck();
  const legalSet = new Set(state.legalMoves);

  for (const [square, squareEl] of boardSquares) {
    squareEl.classList.toggle('selected', state.selectedSquare === square);
    squareEl.classList.toggle('last-move', !!(state.lastMove && (state.lastMove.from === square || state.lastMove.to === square)));

    const isLegal = legalSet.has(square);
    const piece = pieces.get(square);
    squareEl.classList.toggle('legal-move', isLegal && !piece);
    squareEl.classList.toggle('legal-capture', isLegal && !!piece);
    squareEl.classList.toggle('in-check', !!(inCheck && piece && piece.type === 'k' && piece.color === state.currentTurn));
  }
}

export function createPieceImg(color, type, square, variationOverride) {
  const variation = variationOverride || state.pieceArtVariations[square]?.variation || 1;
  const src = getPieceImagePath(color, type, variation);

  const img = document.createElement('img');
  img.src = src;
  img.className = 'piece-icon';
  img.alt = `${COLOR_NAMES[color]} ${PIECE_NAMES[type]}`;
  img.draggable = false;
  return img;
}

export function parseFenToPieces(fen) {
  const pieces = new Map();
  if (!fen) return pieces;

  const ranks = fen.split(' ')[0].split('/');
  for (let r = 0; r < ranks.length; r++) {
    let fileIndex = 0;
    for (const ch of ranks[r]) {
      if (ch >= '1' && ch <= '8') {
        fileIndex += parseInt(ch, 10);
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        const type = ch.toLowerCase();
        const fileChar = String.fromCharCode(97 + fileIndex);
        const rank = 8 - r;
        const square = `${fileChar}${rank}`;
        pieces.set(square, { color, type });
        fileIndex++;
      }
    }
  }
  return pieces;
}

// ============================================================================
// PIECE & BOARD ANIMATION SYSTEM
// ============================================================================

function squareDistance(sq1, sq2) {
  const dc = Math.abs(sq1.charCodeAt(0) - sq2.charCodeAt(0));
  const dr = Math.abs(parseInt(sq1[1]) - parseInt(sq2[1]));
  return dc + dr;
}

function diffBoards(oldFen, newFen) {
  const oldPieces = parseFenToPieces(oldFen);
  const newPieces = parseFenToPieces(newFen);

  const departed = new Map();
  const arrived = new Map();

  for (const [sq, oldP] of oldPieces) {
    const newP = newPieces.get(sq);
    if (!newP || newP.color !== oldP.color || newP.type !== oldP.type) {
      departed.set(sq, oldP);
    }
  }
  for (const [sq, newP] of newPieces) {
    const oldP = oldPieces.get(sq);
    if (!oldP || oldP.color !== newP.color || oldP.type !== newP.type) {
      arrived.set(sq, newP);
    }
  }

  const moves = [];
  const vanished = [];
  const appeared = [];

  for (const [fromSq, dep] of departed) {
    let bestMatch = null;
    let bestDist = Infinity;
    for (const [toSq, arr] of arrived) {
      if (arr.color === dep.color && arr.type === dep.type) {
        const dist = squareDistance(fromSq, toSq);
        if (dist < bestDist) {
          bestDist = dist;
          bestMatch = toSq;
        }
      }
    }
    if (bestMatch) {
      moves.push({ from: fromSq, to: bestMatch, color: dep.color, type: dep.type });
      arrived.delete(bestMatch);
    } else {
      vanished.push({ square: fromSq, color: dep.color, type: dep.type });
    }
  }

  for (const [sq, arr] of arrived) {
    appeared.push({ square: sq, color: arr.color, type: arr.type });
  }

  return { moves, appeared, vanished };
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function getSquareCenter(square) {
  const el = boardSquares.get(square);
  if (!el) return null;
  const containerRect = elements.board.parentElement.getBoundingClientRect();
  const squareRect = el.getBoundingClientRect();
  return {
    x: squareRect.left - containerRect.left + squareRect.width / 2,
    y: squareRect.top - containerRect.top + squareRect.height / 2,
    w: squareRect.width,
    h: squareRect.height,
  };
}

function createGhost(color, type, square, variationOverride) {
  const pos = getSquareCenter(square);
  if (!pos) return null;

  const img = createPieceImg(color, type, square, variationOverride);
  if (!img) return null;

  const size = pos.w * 0.85;
  img.className = 'piece-ghost';
  img.style.cssText = `
    position: absolute;
    width: ${size}px;
    height: ${size}px;
    left: ${pos.x - size / 2}px;
    top: ${pos.y - size / 2}px;
    z-index: 10;
    pointer-events: none;
    will-change: transform;
  `;
  return img;
}

function lerpGhost(ghost, fromSquare, toSquare, duration) {
  return new Promise((resolve) => {
    const fromPos = getSquareCenter(fromSquare);
    const toPos = getSquareCenter(toSquare);
    if (!fromPos || !toPos) {
      if (ghost.parentNode) ghost.remove();
      resolve();
      return;
    }

    const size = fromPos.w * 0.85;
    const startX = fromPos.x - size / 2;
    const startY = fromPos.y - size / 2;
    const endX = toPos.x - size / 2;
    const endY = toPos.y - size / 2;
    const dx = endX - startX;
    const dy = endY - startY;

    let startTime = null;
    let cancelled = false;
    let rafId = null;

    function tick(timestamp) {
      if (cancelled) return;
      if (!startTime) startTime = timestamp;

      const elapsed = timestamp - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = easeOutCubic(t);

      const x = startX + dx * eased;
      const y = startY + dy * eased;
      ghost.style.left = x + 'px';
      ghost.style.top = y + 'px';

      if (t < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        resolve();
      }
    }

    rafId = requestAnimationFrame(tick);

    const handle = {
      cancel() {
        cancelled = true;
        if (rafId) cancelAnimationFrame(rafId);
        resolve();
      }
    };
    state.activeAnimations.push(handle);
  });
}

function fadeOutGhost(ghost, duration) {
  return new Promise((resolve) => {
    let startTime = null;
    let cancelled = false;
    let rafId = null;

    function tick(timestamp) {
      if (cancelled) return;
      if (!startTime) startTime = timestamp;

      const elapsed = timestamp - startTime;
      const t = Math.min(elapsed / duration, 1);

      ghost.style.opacity = String(1 - t);
      ghost.style.transform = `scale(${1 - t * 0.5})`;

      if (t < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        if (ghost.parentNode) ghost.remove();
        resolve();
      }
    }

    rafId = requestAnimationFrame(tick);
    const handle = {
      cancel() {
        cancelled = true;
        if (rafId) cancelAnimationFrame(rafId);
        if (ghost.parentNode) ghost.remove();
        resolve();
      }
    };
    state.activeAnimations.push(handle);
  });
}

export async function waitForAnimation() {
  if (state.animationPromise) {
    await state.animationPromise;
  }
}

export async function animateMoveWithRender(oldFen, newFen) {
  const diff = diffBoards(oldFen, newFen);

  if (diff.moves.length === 0 && diff.vanished.length === 0 && diff.appeared.length === 0) {
    renderBoard();
    return;
  }

  state.isAnimating = true;
  state.activeAnimations = [];
  const container = elements.board.parentElement;

  let resolveAnimation;
  state.animationPromise = new Promise(r => { resolveAnimation = r; });

  const ghosts = [];
  const vanishGhosts = [];

  // Snapshot variations BEFORE renderBoard() overwrites pieceArtVariations
  const snapshotVariations = { ...state.pieceArtVariations };

  for (const move of diff.moves) {
    const ghostVariation = snapshotVariations[move.from]?.variation || 1;
    const ghost = createGhost(move.color, move.type, move.from, ghostVariation);
    if (ghost) {
      container.appendChild(ghost);
      ghosts.push({ ghost, from: move.from, to: move.to });
    }
  }

  for (const v of diff.vanished) {
    const ghostVariation = snapshotVariations[v.square]?.variation || 1;
    const ghost = createGhost(v.color, v.type, v.square, ghostVariation);
    if (ghost) {
      container.appendChild(ghost);
      vanishGhosts.push(ghost);
    }
  }

  renderBoard();

  const hiddenPieces = new Map();
  for (const g of ghosts) {
    const destEl = boardSquares.get(g.to);
    const real = destEl?.querySelector('.piece-icon');
    if (real) {
      real.style.visibility = 'hidden';
      hiddenPieces.set(g.to, real);
    }
  }

  const appearPieces = [];
  for (const a of diff.appeared) {
    const el = boardSquares.get(a.square);
    const real = el?.querySelector('.piece-icon');
    if (real) {
      real.style.visibility = 'hidden';
      appearPieces.push(real);
    }
  }

  const promises = [];

  for (const g of ghosts) {
    const dist = squareDistance(g.from, g.to);
    const duration = Math.min(200 + dist * 30, 450);
    promises.push(lerpGhost(g.ghost, g.from, g.to, duration));
  }

  for (const vg of vanishGhosts) {
    promises.push(fadeOutGhost(vg, 200));
  }

  await Promise.all(promises);

  for (const g of ghosts) {
    if (g.ghost.parentNode) g.ghost.remove();
  }

  for (const [sq, real] of hiddenPieces) {
    real.style.visibility = '';
    real.classList.add('piece-settling');
    real.addEventListener('animationend', () => {
      real.classList.remove('piece-settling');
    }, { once: true });
  }

  for (const el of appearPieces) {
    el.style.visibility = '';
    el.classList.add('piece-appearing');
    el.addEventListener('animationend', () => {
      el.classList.remove('piece-appearing');
    }, { once: true });
  }

  state.activeAnimations = [];
  state.isAnimating = false;
  state.animationPromise = null;
  resolveAnimation();
}

export function skipCurrentAnimations() {
  for (const handle of state.activeAnimations) {
    handle.cancel();
  }
  state.activeAnimations = [];

  document.querySelectorAll('.piece-ghost').forEach(g => g.remove());

  document.querySelectorAll('.piece-icon').forEach(el => {
    el.style.visibility = '';
    el.classList.remove('piece-settling', 'piece-appearing');
  });

  state.isAnimating = false;
  renderBoard();
}

// ============================================================================
// SQUARE CLICK HANDLING & MOVE LOGIC
// ============================================================================

function handleSquareClick(square) {
  if (state.isAnimating) return;
  if (state.isSelectingTarget) return;
  if (state.isSpectator) return;
  if (!state.isGameActive || !state.myColor || !state.chessInstance) return;

  if (state.currentTurn !== state.myColor) {
    if (!state.selectedSquare) {
      console.warn('[board] Not my turn. currentTurn:', state.currentTurn, 'myColor:', state.myColor);
      flashStatus("It's not your turn.", 2000);
    }
    if (state.selectedSquare) {
      state.selectedSquare = null;
      state.legalMoves = [];
      updateHighlights();
    }
    return;
  }

  const pieces = parseFenToPieces(state.currentFen);
  const pieceOnSquare = pieces.get(square);

  if (state.selectedSquare && state.legalMoves.includes(square)) {
    attemptMove(state.selectedSquare, square);
    return;
  }

  if (pieceOnSquare && pieceOnSquare.color === state.myColor) {
    if (state.selectedSquare === square) {
      state.selectedSquare = null;
      state.legalMoves = [];
    } else {
      state.selectedSquare = square;
      state.legalMoves = getLegalMovesForSquare(square);
    }
    updateHighlights(pieces);
    return;
  }

  if (state.selectedSquare) {
    state.selectedSquare = null;
    state.legalMoves = [];
    updateHighlights(pieces);
  }
}

export function getLegalMovesForSquare(square) {
  if (!state.chessInstance) {
    console.warn('[board] getLegalMoves: no chessInstance');
    return [];
  }
  try {
    const pieces = parseFenToPieces(state.currentFen);
    const piece = pieces.get(square);
    if (!piece) return [];

    const mods = getModifierSets();

    // Source-square restrictions
    if (isRuleActiveClient('severe_constipation') && (piece.type === 'b' || piece.type === 'n')) return [];
    if (isRuleActiveClient('hobbit_battle') && piece.type !== 'p') return [];
    if (isRuleActiveClient('ice_age') && (square[0] === 'a' || square[0] === 'h')) return [];

    if (mods.frozenCols) {
      if (mods.frozenCols.has(square[0])) return [];
    }

    if (state.mutatorState?.activeRules) {
      for (const ar of state.mutatorState.activeRules) {
        if (ar.id === 'mitosis' && ar.choiceData === square) return [];
      }
    }

    if (isRuleActiveClient('all_on_red') && state.mutatorState?.coinFlipResult) {
      if (state.mutatorState.coinFlipResult.result === 'tails' && piece.type !== 'k') return [];
    }

    // Base legal moves from chess.js
    const moves = state.chessInstance.moves({ square, verbose: true });
    let targets = moves.map(m => m.to);

    if (targets.length === 0 && !state.mutatorState?.activeRules?.length) {
      console.warn('[board] getLegalMoves: chess.js returned 0 moves for', square,
        'fen:', state.currentFen, 'turn:', state.chessInstance.turn(), 'myColor:', state.myColor);
    }

    // Proletariat
    if (isRuleActiveClient('proletariat') && piece.type !== 'p') {
      targets = [];
    }

    // Pacman wraps
    if (isPacmanActive()) {
      const wrapTargets = getClientWrapMoves(square, pieces);
      for (const t of wrapTargets) {
        if (!targets.includes(t)) targets.push(t);
      }
    }

    // Custom moves from mutators
    const customTargets = getClientCustomMoves(square, pieces);
    for (const t of customTargets) {
      if (!targets.includes(t)) targets.push(t);
    }

    // Destination-based restrictions
    if (isRuleActiveClient('god_kings') || isRuleActiveClient('mind_control')) {
      targets = targets.filter(to => {
        const target = pieces.get(to);
        return !target || target.type !== 'k';
      });
    }

    if (isRuleActiveClient('christmas_truce')) {
      const nonCaptures = targets.filter(to => !pieces.has(to));
      if (nonCaptures.length > 0) targets = nonCaptures;
    }

    if (isRuleActiveClient('hobbit_slaughter')) {
      targets = targets.filter(to => {
        const target = pieces.get(to);
        if (!target) return true;
        return target.type === 'p';
      });
    }

    if (mods.invulnerable) {
      targets = targets.filter(to => !mods.invulnerable.has(to) || !pieces.has(to));
    }

    if (mods.frozenCols) {
      targets = targets.filter(to => {
        if (!mods.frozenCols.has(to[0])) return true;
        return !pieces.has(to);
      });
    }

    if (isRuleActiveClient('no_cowards')) {
      const fromRow = parseInt(square[1]);
      const forward = targets.filter(to => {
        const toRow = parseInt(to[1]);
        return state.myColor === 'w' ? toRow > fromRow : toRow < fromRow;
      });
      if (forward.length > 0) targets = forward;
    }

    if (isRuleActiveClient('short_stop')) {
      const fromCol = _COLS_CACHE.indexOf(square[0]);
      const fromRow = parseInt(square[1]);
      targets = targets.filter(to => {
        const toCol = _COLS_CACHE.indexOf(to[0]);
        const toRow = parseInt(to[1]);
        return Math.abs(toCol - fromCol) <= 1 && Math.abs(toRow - fromRow) <= 1;
      });
    }

    if (isRuleActiveClient('trains_rights') && piece.type === 'q') {
      const fromCol = _COLS_CACHE.indexOf(square[0]);
      const fromRow = parseInt(square[1]);
      targets = targets.filter(to => {
        const toCol = _COLS_CACHE.indexOf(to[0]);
        const toRow = parseInt(to[1]);
        return Math.abs(toCol - fromCol) <= 1 && Math.abs(toRow - fromRow) <= 1;
      });
    }

    if (isRuleActiveClient('ice_physics') && (piece.type === 'b' || piece.type === 'r' || piece.type === 'q')) {
      const fromCol = _COLS_CACHE.indexOf(square[0]);
      const fromRow = parseInt(square[1]);
      const byDir = new Map();
      for (const to of targets) {
        const dc = _COLS_CACHE.indexOf(to[0]) - fromCol;
        const dr = parseInt(to[1]) - fromRow;
        const dirC = dc === 0 ? 0 : (dc > 0 ? 1 : -1);
        const dirR = dr === 0 ? 0 : (dr > 0 ? 1 : -1);
        const key = `${dirC},${dirR}`;
        const dist = Math.max(Math.abs(dc), Math.abs(dr));
        const existing = byDir.get(key);
        if (!existing || dist > existing.dist) {
          byDir.set(key, { to, dist });
        }
      }
      targets = [...byDir.values()].map(e => e.to);
    }

    if (mods.blocked && mods.blocked.size > 0) {
      const fromColIdx = _COLS_CACHE.indexOf(square[0]);
      const fromRowNum = parseInt(square[1]);
      targets = targets.filter(to => {
        if (mods.blocked.has(to)) return false;
        const toColIdx = _COLS_CACHE.indexOf(to[0]);
        const toRowNum = parseInt(to[1]);
        const dc = Math.sign(toColIdx - fromColIdx);
        const dr = Math.sign(toRowNum - fromRowNum);
        if (dc === 0 && dr === 0) return true;
        let c = fromColIdx + dc, r = fromRowNum + dr;
        while (c !== toColIdx || r !== toRowNum) {
          const sq = _COLS_CACHE[c] + r;
          if (mods.blocked.has(sq)) return false;
          c += dc;
          r += dr;
        }
        return true;
      });
    }

    if (mods.nmlCols && mods.nmlCols.size > 0) {
      const fromColIdx = _COLS_CACHE.indexOf(square[0]);
      targets = targets.filter(to => {
        const toColIdx = _COLS_CACHE.indexOf(to[0]);
        if (mods.nmlCols.has(to[0])) return false;
        if (fromColIdx !== toColIdx) {
          const minC = Math.min(fromColIdx, toColIdx);
          const maxC = Math.max(fromColIdx, toColIdx);
          for (const bc of mods.nmlCols) {
            const bcIdx = _COLS_CACHE.indexOf(bc);
            if (bcIdx > minC && bcIdx < maxC) return false;
          }
        }
        return true;
      });
    }

    // Forced-move restrictions
    if (isRuleActiveClient('bloodthirsty')) {
      const allMoves = state.chessInstance.moves({ verbose: true });
      const anyCapture = allMoves.some(m => m.captured);
      if (anyCapture) {
        const captures = targets.filter(to => pieces.has(to));
        targets = captures;
      }
    }

    if (state.mutatorState?.boardModifiers?.tornadoSquare) {
      const tSq = state.mutatorState.boardModifiers.tornadoSquare.square;
      const allMoves = state.chessInstance.moves({ verbose: true });
      const anyCanReachTornado = allMoves.some(m => m.to === tSq);
      if (anyCanReachTornado) {
        if (targets.includes(tSq)) {
          targets = [tSq];
        } else {
          targets = [];
        }
      }
    }

    return targets;
  } catch (err) {
    console.error('[board] getLegalMoves error:', err);
    return [];
  }
}

function isPacmanActive() {
  return state.mutatorState && state.mutatorState.activeRules &&
    state.mutatorState.activeRules.some(ar => ar.id === 'pacman_style');
}

function isRuleActiveClient(ruleId) {
  return state.mutatorState && state.mutatorState.activeRules &&
    state.mutatorState.activeRules.some(ar => ar.id === ruleId);
}


function getClientCustomMoves(square, pieces) {
  if (!state.currentFen || !state.myColor) return [];
  const COLS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ROWS = ['1', '2', '3', '4', '5', '6', '7', '8'];
  const piece = pieces.get(square);
  if (!piece || piece.color !== state.myColor) return [];

  const col = COLS.indexOf(square[0]);
  const row = ROWS.indexOf(square[1]);
  const results = [];

  function offset(c, r, dc, dr) {
    const nc = c + dc, nr = r + dr;
    if (nc < 0 || nc > 7 || nr < 0 || nr > 7) return null;
    return COLS[nc] + ROWS[nr];
  }

  // Proletariat
  if (isRuleActiveClient('proletariat') && piece.type !== 'p') {
    const dir = state.myColor === 'w' ? 1 : -1;
    const ahead = offset(col, row, 0, dir);
    if (ahead && !pieces.has(ahead)) results.push(ahead);
    const diagLeft = offset(col, row, -1, dir);
    const diagRight = offset(col, row, 1, dir);
    if (diagLeft) {
      const t = pieces.get(diagLeft);
      if (t && t.color !== state.myColor) results.push(diagLeft);
    }
    if (diagRight) {
      const t = pieces.get(diagRight);
      if (t && t.color !== state.myColor) results.push(diagRight);
    }
  }

  // Short Stop: Knights get orthogonal 1-square moves
  if (isRuleActiveClient('short_stop') && piece.type === 'n') {
    for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const to = offset(col, row, dc, dr);
      if (to) {
        const t = pieces.get(to);
        if (!t || t.color !== state.myColor) results.push(to);
      }
    }
  }

  // Estrogen
  if (isRuleActiveClient('estrogen') && piece.type === 'k') {
    const dirs = [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
    for (const [dc, dr] of dirs) {
      let c2 = col, r2 = row;
      while (true) {
        c2 += dc; r2 += dr;
        if (c2 < 0 || c2 > 7 || r2 < 0 || r2 > 7) break;
        const sq = COLS[c2] + ROWS[r2];
        const occ = pieces.get(sq);
        const dist = Math.max(Math.abs(c2 - col), Math.abs(r2 - row));
        if (occ && occ.color === state.myColor) break;
        if (dist > 1) results.push(sq);
        if (occ) break;
      }
    }
  }

  // Trains Rights
  if (isRuleActiveClient('trains_rights') && piece.type === 'k') {
    const dirs = [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
    for (const [dc, dr] of dirs) {
      let c2 = col, r2 = row;
      while (true) {
        c2 += dc; r2 += dr;
        if (c2 < 0 || c2 > 7 || r2 < 0 || r2 > 7) break;
        const sq = COLS[c2] + ROWS[r2];
        const occ = pieces.get(sq);
        const dist = Math.max(Math.abs(c2 - col), Math.abs(r2 - row));
        if (occ && occ.color === state.myColor) break;
        if (dist > 1) results.push(sq);
        if (occ) break;
      }
    }
  }

  // God Kings / Knee Surgery
  if ((isRuleActiveClient('god_kings') || isRuleActiveClient('knee_surgery')) && piece.type === 'k') {
    for (let dc = -2; dc <= 2; dc++) {
      for (let dr = -2; dr <= 2; dr++) {
        if (dc === 0 && dr === 0) continue;
        if (Math.abs(dc) <= 1 && Math.abs(dr) <= 1) continue;
        const sq = offset(col, row, dc, dr);
        if (!sq) continue;
        const occ = pieces.get(sq);
        if (occ && occ.color === state.myColor) continue;
        results.push(sq);
      }
    }
  }

  // Pawns with Viagra
  if (isRuleActiveClient('pawns_with_viagra') && piece.type === 'p') {
    const left = offset(col, row, -1, 0);
    const right = offset(col, row, 1, 0);
    if (left) { const o = pieces.get(left); if (o && o.color !== state.myColor) results.push(left); }
    if (right) { const o = pieces.get(right); if (o && o.color !== state.myColor) results.push(right); }
  }

  // Pawns Learned Strength
  if (isRuleActiveClient('pawns_learned_strength') && piece.type === 'p') {
    const dir = piece.color === 'w' ? 1 : -1;
    const ahead = offset(col, row, 0, dir);
    if (ahead) {
      const occ = pieces.get(ahead);
      if (occ) results.push(ahead);
    }
  }

  return results;
}

function getClientWrapMoves(square, pieces) {
  if (!state.currentFen || !state.myColor) return [];
  const COLS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ROWS = ['1', '2', '3', '4', '5', '6', '7', '8'];
  const piece = pieces.get(square);
  if (!piece || piece.color !== state.myColor) return [];

  const col = COLS.indexOf(square[0]);
  const row = ROWS.indexOf(square[1]);
  const results = [];

  const slideDirs = {
    r: [[0, 1], [0, -1], [1, 0], [-1, 0]],
    b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
    q: [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]],
  };

  if (slideDirs[piece.type]) {
    for (const [dr, dc] of slideDirs[piece.type]) {
      let r = row, c = col, blocked = false;
      while (true) {
        r += dr; c += dc;
        const rOob = r < 0 || r > 7;
        const cOob = c < 0 || c > 7;
        if (rOob && cOob) { blocked = true; break; }
        if (rOob || cOob) break;
        const sq = COLS[c] + ROWS[r];
        if (pieces.get(sq)) { blocked = true; break; }
      }
      if (blocked) continue;
      const rOob = r < 0 || r > 7;
      const cOob = c < 0 || c > 7;
      if (!rOob && !cOob) continue;
      if (cOob) c = c < 0 ? c + 8 : c - 8;
      if (rOob) r = r < 0 ? r + 8 : r - 8;
      while (c >= 0 && c <= 7 && r >= 0 && r <= 7) {
        const wrapSq = COLS[c] + ROWS[r];
        const occ = pieces.get(wrapSq);
        if (occ) {
          if (occ.color !== state.myColor) results.push(wrapSq);
          break;
        }
        results.push(wrapSq);
        r += dr; c += dc;
      }
    }
  }

  if (piece.type === 'n') {
    const knightOffsets = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for (const [dr, dc] of knightOffsets) {
      const nr = row + dr;
      let nc = col + dc;
      if (nr < 0 || nr > 7) continue;
      if (nc >= 0 && nc <= 7) continue;
      nc = nc < 0 ? nc + 8 : nc - 8;
      if (nc < 0 || nc > 7) continue;
      const wrapSq = COLS[nc] + ROWS[nr];
      const occ = pieces.get(wrapSq);
      if (occ && occ.color === state.myColor) continue;
      results.push(wrapSq);
    }
  }

  if (piece.type === 'k') {
    const kingOffsets = [[0,-1],[0,1],[1,-1],[1,1],[-1,-1],[-1,1]];
    for (const [dr, dc] of kingOffsets) {
      const nr = row + dr;
      let nc = col + dc;
      if (nr < 0 || nr > 7) continue;
      if (nc >= 0 && nc <= 7) continue;
      nc = nc < 0 ? nc + 8 : nc - 8;
      const wrapSq = COLS[nc] + ROWS[nr];
      const occ = pieces.get(wrapSq);
      if (occ && occ.color === state.myColor) continue;
      results.push(wrapSq);
    }
  }

  if (piece.type === 'p') {
    const dir = piece.color === 'w' ? 1 : -1;
    for (const dc of [-1, 1]) {
      const nr = row + dir;
      let nc = col + dc;
      if (nr < 0 || nr > 7) continue;
      if (nc >= 0 && nc <= 7) continue;
      nc = nc < 0 ? nc + 8 : nc - 8;
      const wrapSq = COLS[nc] + ROWS[nr];
      const occ = pieces.get(wrapSq);
      if (occ && occ.color !== state.myColor) results.push(wrapSq);
    }
  }

  return results;
}

// ============================================================================
// MOVE SUBMISSION & PROMOTION
// ============================================================================

function attemptMove(from, to) {
  const pieces = parseFenToPieces(state.currentFen);
  const piece = pieces.get(from);
  if (piece && piece.type === 'p') {
    const targetRank = to[1];
    const isPromotionRank =
      (piece.color === 'w' && targetRank === '8') ||
      (piece.color === 'b' && targetRank === '1');

    if (isPromotionRank) {
      state.pendingPromotion = { from, to };
      showPromotionModal(piece.color);
      return;
    }
  }

  sendMove(from, to);
}

function sendMove(from, to, promotion) {
  state.selectedSquare = null;
  state.legalMoves = [];

  const moveData = { from, to };
  if (promotion) moveData.promotion = promotion;

  state.socket.emit('move', moveData);
}

function showPromotionModal(color) {
  if (!elements.promotionChoices) return;
  elements.promotionChoices.innerHTML = '';

  const promotionPieces = ['q', 'r', 'b', 'n'];
  const names = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };

  promotionPieces.forEach(type => {
    const btn = document.createElement('button');
    btn.className = 'promotion-choice';
    btn.title = names[type];

    const img = createPieceImg(state.myColor, type, null, 1);
    if (img) {
      img.className = 'promotion-piece-img';
      btn.appendChild(img);
    }

    const label = document.createElement('span');
    label.textContent = names[type];
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      hideModal('promotion-modal');
      if (state.pendingPromotion) {
        sendMove(state.pendingPromotion.from, state.pendingPromotion.to, type);
        state.pendingPromotion = null;
      }
    });

    elements.promotionChoices.appendChild(btn);
  });

  showModal('promotion-modal');
}

export function cancelPromotion() {
  state.pendingPromotion = null;
  state.selectedSquare = null;
  state.legalMoves = [];
  hideModal('promotion-modal');
  renderBoard();
}
