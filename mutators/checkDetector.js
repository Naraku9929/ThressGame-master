/**
 * Custom check and checkmate detection for mutator-aware games.
 *
 * When movement-modifying rules are active, chess.js's in_check() is unreliable.
 * This module provides mutator-aware alternatives.
 */

const { fenToBoard, colIndex, rowIndex, COLUMNS, ROWS, offsetSquare } = require('./boardUtils');

const SLIDING_WRAP_DIRS = {
  r: [[-1, 0], [1, 0], [0, -1], [0, 1]],
  q: [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]],
  b: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
};

/**
 * Compute wrap-around attack squares for Pacman mode.
 * Traces each direction until it exits the board, then continues from the opposite edge.
 */
function getPacmanWrapAttacks(square, piece, board) {
  const attacks = [];
  const dirs = SLIDING_WRAP_DIRS[piece.type];

  // Non-sliding pieces: handle single-step wraps (king, knight)
  if (!dirs) {
    const offsets = piece.type === 'k'
      ? [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]
      : [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for (const [dc, dr] of offsets) {
      let c = colIndex(square) + dc;
      let r = rowIndex(square) + dr;
      if (c < 0 || c > 7) {
        c = c < 0 ? c + 8 : c - 8;
        if (c >= 0 && c <= 7 && r >= 0 && r <= 7) {
          const wrapSq = COLUMNS[c] + ROWS[r];
          if (!attacks.includes(wrapSq)) attacks.push(wrapSq);
        }
      }
    }
    return attacks;
  }

  for (const [dc, dr] of dirs) {
    let c = colIndex(square) + dc;
    let r = rowIndex(square) + dr;
    let blocked = false;

    while (c >= 0 && c <= 7 && r >= 0 && r <= 7) {
      if (board.has(COLUMNS[c] + ROWS[r])) { blocked = true; break; }
      c += dc;
      r += dr;
    }

    // Only wrap when exiting horizontally and row is still in bounds
    if (!blocked && (c < 0 || c > 7) && r >= 0 && r <= 7) {
      c = c < 0 ? c + 8 : c - 8;
      while (c >= 0 && c <= 7 && r >= 0 && r <= 7) {
        const wrapSq = COLUMNS[c] + ROWS[r];
        if (!attacks.includes(wrapSq)) attacks.push(wrapSq);
        if (board.has(wrapSq)) break;
        c += dc;
        r += dr;
      }
    }
  }
  return attacks;
}

/**
 * Generate all squares a piece can attack from a given position.
 * Takes active mutator rules into account.
 *
 * @param {string} square - The piece's current square
 * @param {{type: string, color: string}} piece - The piece
 * @param {Map} board - Current board state
 * @param {object} mutatorState - Active mutator state
 * @returns {string[]} - Array of squares this piece can attack
 */
function getAttackSquares(square, piece, board, mutatorState) {
  if (!mutatorState || !mutatorState.activeRules || mutatorState.activeRules.length === 0) {
    return getStandardAttackSquares(square, piece, board);
  }

  const activeIds = new Set(mutatorState.activeRules.map(ar => ar.rule.id));
  let attacks;

  // Proletariat: ALL pieces move/attack like Pawns
  if (activeIds.has('proletariat')) {
    attacks = getPawnAttacks(square, piece.color);
    return applyPostModifiers(attacks, square, board, activeIds);
  }

  // Trains Rights: Kings <-> Queens swap movement
  if (activeIds.has('trains_rights')) {
    if (piece.type === 'k') {
      attacks = getSlidingAttacks(square, board, [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]);
    } else if (piece.type === 'q') {
      attacks = getKingAttacks(square);
    } else {
      attacks = getStandardAttackSquaresForType(square, piece, board);
    }
  } else {
    attacks = getStandardAttackSquaresForType(square, piece, board);
  }

  // Estrogen: Kings can ALSO move like Queens (adds to existing)
  if (activeIds.has('estrogen') && piece.type === 'k') {
    const queenAttacks = getSlidingAttacks(square, board, [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]);
    attacks = [...new Set([...attacks, ...queenAttacks])];
  }

  // Knee Surgery / God Kings: Kings can move 2 squares in every direction
  if ((activeIds.has('knee_surgery') || activeIds.has('god_kings')) && piece.type === 'k') {
    for (let dc = -2; dc <= 2; dc++) {
      for (let dr = -2; dr <= 2; dr++) {
        if (dc === 0 && dr === 0) continue;
        const sq = offsetSquare(square, dc, dr);
        if (sq && !attacks.includes(sq)) attacks.push(sq);
      }
    }
  }

  // Pawns with Viagra: Pawns can also attack left and right
  if (activeIds.has('pawns_with_viagra') && piece.type === 'p') {
    const left = offsetSquare(square, -1, 0);
    const right = offsetSquare(square, 1, 0);
    if (left && !attacks.includes(left)) attacks.push(left);
    if (right && !attacks.includes(right)) attacks.push(right);
  }

  // Short Stop: limit all attacks to distance 1; give knights orthogonal attacks
  if (activeIds.has('short_stop')) {
    if (piece.type === 'n') {
      // Replace L-shaped attacks with orthogonal 1-square attacks
      attacks = [];
      for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const sq = offsetSquare(square, dc, dr);
        if (sq) attacks.push(sq);
      }
    } else {
      const col = colIndex(square);
      const row = rowIndex(square);
      attacks = attacks.filter(sq => {
        const tc = colIndex(sq);
        const tr = rowIndex(sq);
        return Math.abs(tc - col) <= 1 && Math.abs(tr - row) <= 1;
      });
    }
  }

  if (activeIds.has('pacman_style')) {
    for (const sq of getPacmanWrapAttacks(square, piece, board)) {
      if (!attacks.includes(sq)) attacks.push(sq);
    }
  }

  return applyPostModifiers(attacks, square, board, activeIds);
}

/**
 * Standard attack squares for a piece (no mutators).
 */
function getStandardAttackSquares(square, piece, board) {
  switch (piece.type) {
    case 'p': return getPawnAttacks(square, piece.color);
    case 'n': return getKnightAttacks(square);
    case 'b': return getSlidingAttacks(square, board, [[-1,-1],[-1,1],[1,-1],[1,1]]);
    case 'r': return getSlidingAttacks(square, board, [[-1,0],[1,0],[0,-1],[0,1]]);
    case 'q': return getSlidingAttacks(square, board, [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]);
    case 'k': return getKingAttacks(square);
    default: return [];
  }
}

function getPawnAttacks(square, color) {
  const dir = color === 'w' ? 1 : -1;
  const attacks = [];
  const left = offsetSquare(square, -1, dir);
  const right = offsetSquare(square, 1, dir);
  if (left) attacks.push(left);
  if (right) attacks.push(right);
  return attacks;
}

function getKnightAttacks(square) {
  const offsets = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  const attacks = [];
  for (const [dc, dr] of offsets) {
    const sq = offsetSquare(square, dc, dr);
    if (sq) attacks.push(sq);
  }
  return attacks;
}

function getSlidingAttacks(square, board, directions) {
  const attacks = [];
  for (const [dc, dr] of directions) {
    let current = square;
    while (true) {
      current = offsetSquare(current, dc, dr);
      if (!current) break;
      attacks.push(current);
      if (board.has(current)) break; // blocked by piece
    }
  }
  return attacks;
}

function getKingAttacks(square) {
  const attacks = [];
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (dc === 0 && dr === 0) continue;
      const sq = offsetSquare(square, dc, dr);
      if (sq) attacks.push(sq);
    }
  }
  return attacks;
}

/**
 * Get standard attack squares for a specific piece type (without full piece object lookup).
 */
function getStandardAttackSquaresForType(square, piece, board) {
  switch (piece.type) {
    case 'p': return getPawnAttacks(square, piece.color);
    case 'n': return getKnightAttacks(square);
    case 'b': return getSlidingAttacks(square, board, [[-1,-1],[-1,1],[1,-1],[1,1]]);
    case 'r': return getSlidingAttacks(square, board, [[-1,0],[1,0],[0,-1],[0,1]]);
    case 'q': return getSlidingAttacks(square, board, [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]);
    case 'k': return getKingAttacks(square);
    default: return [];
  }
}

/**
 * Apply post-processing modifiers (placeholder for future modifiers).
 * Pacman wrap is now handled in getAttackSquares via getPacmanWrapAttacks.
 */
function applyPostModifiers(attacks, square, board, activeIds) {
  return attacks;
}

/**
 * Check if a king of the given color is in check.
 *
 * @param {Map} board - Board state
 * @param {string} kingColor - 'w' or 'b'
 * @param {object} mutatorState - Active mutator state
 * @returns {boolean}
 */
function isKingInCheck(board, kingColor, mutatorState) {
  // Find the king
  let kingSquare = null;
  for (const [sq, piece] of board) {
    if (piece.type === 'k' && piece.color === kingColor) {
      kingSquare = sq;
      break;
    }
  }
  if (!kingSquare) return false; // no king found (shouldn't happen)

  // Check if any enemy piece can attack the king's square
  const enemyColor = kingColor === 'w' ? 'b' : 'w';
  for (const [sq, piece] of board) {
    if (piece.color !== enemyColor) continue;
    const attacks = getAttackSquares(sq, piece, board, mutatorState);
    if (attacks.includes(kingSquare)) return true;
  }

  return false;
}

/**
 * Check if a move would leave the player's own king in check.
 *
 * @param {Map} board - Board state (will be cloned)
 * @param {string} from - Source square
 * @param {string} to - Target square
 * @param {string} playerColor - Moving player's color
 * @param {object} mutatorState - Active mutator state
 * @returns {boolean} true if the move is illegal (leaves king in check)
 */
function wouldLeaveKingInCheck(board, from, to, playerColor, mutatorState) {
  // Clone the board and apply the move
  const testBoard = new Map(board);
  testBoard.delete(from);
  testBoard.set(to, board.get(from));

  return isKingInCheck(testBoard, playerColor, mutatorState);
}

module.exports = {
  getAttackSquares,
  getStandardAttackSquares,
  getStandardAttackSquaresForType,
  applyPostModifiers,
  isKingInCheck,
  wouldLeaveKingInCheck,
  // Export helpers for rule implementations to override
  getPawnAttacks,
  getKnightAttacks,
  getSlidingAttacks,
  getKingAttacks,
};
