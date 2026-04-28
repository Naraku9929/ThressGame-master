/**
 * Bot Manager -- Manages a single bot opponent for 1v1 games.
 */

const crypto = require('crypto');
const { createPlayer } = require('./gameController');
const { getBestMove, evaluateBoard } = require('./bots/botAI');
const { getHooks, getCustomMoves, getWrapMoves } = require('./mutators/ruleHooks');
const { isRuleActive } = require('./mutators/mutatorEngine');
const { COLUMNS, ROWS, getIntermediateSquares } = require('./mutators/boardUtils');

let botCounter = 0;

/**
 * Check if a move passes through or lands on a trap square (mine, pit, death square).
 * Returns true if the move is dangerous.
 */
function isTrapMove(room, move) {
  if (!room.mutatorState) return false;
  const mods = room.mutatorState.boardModifiers || {};

  // Collect all dangerous squares
  const trapSquares = new Set();
  if (mods.mines) mods.mines.forEach(m => trapSquares.add(m.square));
  if (mods.bottomlessPits) mods.bottomlessPits.forEach(p => trapSquares.add(p.square));
  if (mods.deathSquares) {
    const mc = room.mutatorState.moveCount || 0;
    mods.deathSquares.forEach(d => {
      if (!d.expiresAtMove || mc < d.expiresAtMove) trapSquares.add(d.square);
    });
  }

  if (trapSquares.size === 0) return false;

  // Check destination
  if (trapSquares.has(move.to)) return true;

  // Check intermediate squares for sliding pieces
  const path = getIntermediateSquares(move.from, move.to);
  for (const sq of path) {
    if (trapSquares.has(sq)) return true;
  }

  return false;
}

/**
 * Pick the best move from a pre-filtered pool using board evaluation.
 * Unlike getBestMove (which queries chess.js for unfiltered moves),
 * this only considers moves already validated against mutator restrictions.
 *
 * @param {Object} chess - Chess.js instance
 * @param {Array} moves - Pre-filtered legal moves for a single source square
 * @param {string} color - The bot's color ('w' or 'b')
 * @returns {Object|null} Best move from the pool
 */
function getBestMoveFromPool(chess, moves, color) {
  if (moves.length === 0) return { move: null, score: -Infinity };

  let bestMove = null;
  let bestScore = -Infinity;

  for (const move of moves) {
    let score;
    try {
      const result = chess.move(move);
      if (!result) {
        // Custom/wrap move not playable in chess.js — score as current position
        score = evaluateBoard(chess, color) + Math.random() * 10;
      } else {
        score = evaluateBoard(chess, color) + Math.random() * 10;
        chess.undo();
      }
    } catch {
      // Custom/wrap move rejected by chess.js — assign neutral score
      score = evaluateBoard(chess, color) + Math.random() * 10;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  return { move: bestMove, score: bestScore };
}

/**
 * Add a bot player to a room.
 *
 * @param {Object} room - GameRoom instance
 * @param {string} color - The color for the bot ('w' or 'b')
 */
function addBotToRoom(room, color) {
  botCounter++;
  const botSocketId = `bot:${crypto.randomUUID()}`;
  const botName = `Bot ${botCounter}`;
  const botPlayerHash = crypto
    .createHash('sha256')
    .update(botSocketId)
    .digest('hex')
    .substring(0, 16);

  const bot = createPlayer(botSocketId, botName, botPlayerHash, color, true);
  room.addPlayer(bot);

  console.log(`[botManager] Added ${botName} as ${color === 'w' ? 'white' : 'black'} to room ${room.roomCode}`);
  return bot;
}

/**
 * Schedule a bot move after a random delay.
 *
 * @param {Object} room - GameRoom instance
 * @param {Object} io - Socket.IO server
 * @param {Object} gameManager - GameManager instance
 * @param {Function} handleMoveFn - The handleMove function: (io, fakeSocket, gameManager, moveData)
 * @param {Function} [afterMoveFn] - Optional callback after move (e.g. botAutoMutatorResponse)
 */
function scheduleBotMove(room, io, gameManager, handleMoveFn, afterMoveFn) {
  if (!room || room.status !== 'active') return;

  // Determine whose turn it is
  const currentTurn = room.chess.turn();
  const currentPlayer = room.getPlayer(currentTurn);

  // Only schedule if it's a bot's turn
  if (!currentPlayer || !currentPlayer.isBot) return;

  // Cancel any existing bot_move timer before scheduling a new one
  const existingTimer = room.disconnectTimers.get('bot_move');
  if (existingTimer) {
    clearTimeout(existingTimer);
    room.disconnectTimers.delete('bot_move');
  }

  // Random delay between 2000ms and 4000ms
  const delay = 2000 + Math.random() * 2000;

  const timer = setTimeout(() => {
    room.disconnectTimers.delete('bot_move');
    performBotMove(room, io, gameManager, handleMoveFn, afterMoveFn);
  }, delay);

  // Store the timeout so it can be cleared if the room ends
  room.disconnectTimers.set('bot_move', timer);
}

/**
 * Apply active mutator restriction filters to narrow the legal move pool.
 * Mirrors the restriction check in moveHandler.js so bots only pick valid moves.
 *
 * @param {Object} room - GameRoom instance
 * @param {string} playerColor - The bot's color ('w' or 'b')
 * @returns {Array} Filtered array of legal move objects
 */
function getMutatorFilteredMoves(room, playerColor) {
  let legalMoves = room.chess.moves({ verbose: true });
  if (!room.mutatorState || room.mutatorState.activeRules.length === 0) {
    return legalMoves;
  }

  // Add custom moves from movement-add mutators (estrogen, god_kings, etc.)
  const custom = getCustomMoves(room, playerColor);
  for (const cm of custom) {
    if (!legalMoves.some(m => m.from === cm.from && m.to === cm.to)) {
      legalMoves.push({ from: cm.from, to: cm.to, flags: 'n', san: cm.to });
    }
  }

  // Add wrap moves from Pacman Style
  if (isRuleActive(room.mutatorState, 'pacman_style')) {
    const wraps = getWrapMoves(room, playerColor);
    for (const wm of wraps) {
      if (!legalMoves.some(m => m.from === wm.from && m.to === wm.to)) {
        legalMoves.push({ from: wm.from, to: wm.to, flags: 'n', san: wm.to });
      }
    }
  }

  // Apply restriction filters to the full pool (includes custom/wrap moves)
  const restrictionRules = room.mutatorState.activeRules.filter(ar => {
    const ruleHooks = getHooks(ar.rule.id);
    return ruleHooks.getLegalMoveModifiers;
  });

  for (const ar of restrictionRules) {
    const ruleHooks = getHooks(ar.rule.id);
    const filterFn = ruleHooks.getLegalMoveModifiers(room, playerColor);
    if (filterFn) {
      const filtered = filterFn(legalMoves);
      if (filtered.length > 0) {
        legalMoves = filtered;
      }
    }
  }

  return legalMoves;
}

/**
 * Execute a bot move.
 *
 * @param {Object} room - GameRoom instance
 * @param {Object} io - Socket.IO server
 * @param {Object} gameManager - GameManager instance
 * @param {Function} handleMoveFn - The handleMove function: (io, fakeSocket, gameManager, moveData)
 * @param {Function} [afterMoveFn] - Optional callback after move (e.g. botAutoMutatorResponse)
 */
async function performBotMove(room, io, gameManager, handleMoveFn, afterMoveFn) {
  if (!room || room.status !== 'active') return;

  const currentTurn = room.chess.turn();
  const bot = room.getPlayer(currentTurn);

  if (!bot || !bot.isBot) return;

  // If there's a pending mutator state, reschedule instead of moving now
  if (room.mutatorState && (
    room.mutatorState.pendingRPS ||
    room.mutatorState.pendingChoice ||
    room.mutatorState.pendingAction ||
    room.mutatorState.pendingSecondAction ||
    room.mutatorState.pendingCoinFlip
  )) {
    scheduleBotMove(room, io, gameManager, handleMoveFn, afterMoveFn);
    return;
  }

  // Get mutator-filtered legal moves (respects active restrictions)
  let allMoves = getMutatorFilteredMoves(room, currentTurn);
  if (allMoves.length === 0) return;

  // Trap awareness: 50/50 chance to avoid trap moves (mines, pits, death squares)
  if (room.mutatorState && Math.random() < 0.5) {
    const safeMoves = allMoves.filter(m => !isTrapMove(room, m));
    if (safeMoves.length > 0) {
      allMoves = safeMoves;
    }
    // If all moves are traps, keep the full pool (no choice but to walk into one)
  }

  let selectedMove = null;

  // Collect active treasure squares for bonus targeting
  const treasureSquares = new Set();
  if (room.mutatorState?.boardModifiers?.treasureSquares) {
    for (const ts of room.mutatorState.boardModifiers.treasureSquares) {
      if (ts.active) treasureSquares.add(ts.square);
    }
  }

  // Try AI move: evaluate each legal move with board evaluation
  // Only consider moves from the mutator-filtered pool
  try {
    const squareSet = new Set(allMoves.map(m => m.from));
    let bestOverallMove = null;
    let bestOverallScore = -Infinity;

    for (const square of squareSet) {
      const piece = room.chess.get(square);
      if (!piece) continue;

      const squareMoves = allMoves.filter(m => m.from === square);
      const { move, score } = getBestMoveFromPool(room.chess, squareMoves, currentTurn);
      if (move && score > bestOverallScore) {
        bestOverallScore = score;
        bestOverallMove = move;
      }
    }

    if (bestOverallMove) {
      selectedMove = bestOverallMove;
    }

    // Treasure chest awareness: prioritize landing on a treasure square
    // unless the current best move is a capture or resolves check
    if (treasureSquares.size > 0 && selectedMove) {
      const isBestCapture = selectedMove.captured || (selectedMove.flags && selectedMove.flags.includes('c'));
      const inCheck = room.chess.inCheck();
      if (!isBestCapture && !inCheck) {
        const treasureMove = allMoves.find(m => treasureSquares.has(m.to));
        if (treasureMove) {
          selectedMove = treasureMove;
        }
      }
    }
  } catch (err) {
    console.warn('[botManager] AI move calculation failed:', err.message);
  }

  // Fallback to random legal move from filtered pool
  if (!selectedMove) {
    selectedMove = allMoves[Math.floor(Math.random() * allMoves.length)];
    console.log(`[botManager] Using random fallback move: ${selectedMove.from}->${selectedMove.to}`);
  }

  // Create fake socket for the bot
  const fakeSocket = {
    id: bot.socketId,
    emit: () => {},
  };

  try {
    await handleMoveFn(io, fakeSocket, gameManager, {
      from: selectedMove.from,
      to: selectedMove.to,
      promotion: selectedMove.promotion || undefined,
    });

    console.log(`[botManager] Bot ${bot.name} moved: ${selectedMove.from}->${selectedMove.to}`);

    // Handle any mutator auto-responses (RPS, target selection, etc.)
    if (afterMoveFn && room.mutatorState) {
      setTimeout(() => afterMoveFn(room, io, gameManager), 200);
    }

    // Schedule next bot move if it's still a bot's turn (after the move is processed)
    scheduleBotMove(room, io, gameManager, handleMoveFn, afterMoveFn);
  } catch (err) {
    console.error(`[botManager] Bot move execution failed:`, err.message);
  }
}

/**
 * Generate a random valid target for a mutator action.
 * @param {Object} room - GameRoom instance
 * @param {string} botColor - The bot's color ('w' or 'b')
 * @param {string} choiceType - The type of choice needed
 * @returns {*} The target data (square, column, row, array, etc.)
 */
function generateBotTarget(room, botColor, choiceType) {
  const chess = room.chess;
  const board = chess.board(); // 8x8 array

  // Helper: get all squares with pieces matching criteria
  function findSquares(filterFn) {
    const results = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = board[r][c];
        const sq = COLUMNS[c] + ROWS[7 - r];
        if (filterFn(piece, sq)) results.push(sq);
      }
    }
    return results;
  }

  const opponentColor = botColor === 'w' ? 'b' : 'w';

  switch (choiceType) {
    case 'column':
      return COLUMNS[Math.floor(Math.random() * 8)];

    case 'row':
      return ROWS[Math.floor(Math.random() * 8)];

    case 'empty_square': {
      const empty = findSquares((p) => !p);
      return empty.length > 0 ? empty[Math.floor(Math.random() * empty.length)] : null;
    }

    case 'square': {
      const sq = COLUMNS[Math.floor(Math.random() * 8)] + ROWS[Math.floor(Math.random() * 8)];
      return sq;
    }

    case 'piece': {
      const pieces = findSquares((p) => p && p.type !== 'k');
      return pieces.length > 0 ? pieces[Math.floor(Math.random() * pieces.length)] : null;
    }

    case 'friendly_piece': {
      const friendly = findSquares((p) => p && p.color === botColor && p.type !== 'k');
      return friendly.length > 0 ? friendly[Math.floor(Math.random() * friendly.length)] : null;
    }

    case 'enemy_piece': {
      const enemies = findSquares((p) => p && p.color === opponentColor && p.type !== 'k');
      return enemies.length > 0 ? enemies[Math.floor(Math.random() * enemies.length)] : null;
    }

    case 'two_squares': {
      const allSq = [];
      for (const c of COLUMNS) for (const r of ROWS) allSq.push(c + r);
      const idx1 = Math.floor(Math.random() * allSq.length);
      const sq1 = allSq.splice(idx1, 1)[0];
      const sq2 = allSq[Math.floor(Math.random() * allSq.length)];
      return [sq1, sq2];
    }

    case 'two_friendly_pawns': {
      const pawns = findSquares((p) => p && p.color === botColor && p.type === 'p');
      if (pawns.length >= 2) {
        const idx1 = Math.floor(Math.random() * pawns.length);
        const sq1 = pawns.splice(idx1, 1)[0];
        const sq2 = pawns[Math.floor(Math.random() * pawns.length)];
        return { pawns: [sq1, sq2], bishopSquare: sq1 };
      }
      return null;
    }

    case 'two_pieces_same_column': {
      // Find columns with 2+ pieces
      for (const col of COLUMNS) {
        const inCol = findSquares((p, sq) => p && sq[0] === col);
        if (inCol.length >= 2) {
          const idx1 = Math.floor(Math.random() * inCol.length);
          const sq1 = inCol.splice(idx1, 1)[0];
          const sq2 = inCol[Math.floor(Math.random() * inCol.length)];
          return { square1: sq1, square2: sq2 };
        }
      }
      return null;
    }

    case 'friendly_bishop_or_knight': {
      const pieces = findSquares((p) => p && p.color === botColor && (p.type === 'b' || p.type === 'n'));
      return pieces.length > 0 ? pieces[Math.floor(Math.random() * pieces.length)] : null;
    }

    case 'sophie': {
      const friendly = findSquares((p) => p && p.color === botColor && p.type !== 'k');
      return friendly.length > 0 ? friendly[Math.floor(Math.random() * friendly.length)] : null;
    }

    default:
      return null;
  }
}

module.exports = {
  addBotToRoom,
  scheduleBotMove,
  performBotMove,
  generateBotTarget,
};
