/**
 * Board utility functions for mutator operations.
 * Provides FEN parsing, piece manipulation, and square helpers.
 */

const COLUMNS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const ROWS = ['1', '2', '3', '4', '5', '6', '7', '8'];

/**
 * Parse a FEN string into an 8x8 board map.
 * Returns Map<square, {type, color}> e.g. Map { 'e1' => {type:'k', color:'w'} }
 */
function fenToBoard(fen) {
  const board = new Map();
  const ranks = fen.split(' ')[0].split('/');

  for (let r = 0; r < 8; r++) {
    let col = 0;
    for (const ch of ranks[r]) {
      if (ch >= '1' && ch <= '8') {
        col += parseInt(ch);
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        const type = ch.toLowerCase();
        const square = COLUMNS[col] + ROWS[7 - r];
        board.set(square, { type, color });
        col++;
      }
    }
  }

  return board;
}

/**
 * Convert an 8x8 board map back to a FEN piece placement string.
 */
function boardToFenPlacement(board) {
  const ranks = [];
  for (let r = 7; r >= 0; r--) {
    let rank = '';
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const square = COLUMNS[c] + ROWS[r];
      const piece = board.get(square);
      if (piece) {
        if (empty > 0) { rank += empty; empty = 0; }
        const ch = piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
        rank += ch;
      } else {
        empty++;
      }
    }
    if (empty > 0) rank += empty;
    ranks.push(rank);
  }
  return ranks.join('/');
}

/**
 * Rebuild a full FEN from a board map and metadata.
 * Strips castling rights and en passant (mutators often invalidate them).
 */
function buildFen(board, turn, fullMoveNum) {
  const placement = boardToFenPlacement(board);
  // After mutator board manipulation, castling rights and en passant are unreliable
  return `${placement} ${turn} - - 0 ${fullMoveNum || 1}`;
}

/**
 * Get all squares occupied by a specific color.
 */
function getSquaresByColor(board, color) {
  const squares = [];
  for (const [sq, piece] of board) {
    if (piece.color === color) squares.push(sq);
  }
  return squares;
}

/**
 * Get all empty squares on the board.
 */
function getEmptySquares(board) {
  const empty = [];
  for (const col of COLUMNS) {
    for (const row of ROWS) {
      const sq = col + row;
      if (!board.has(sq)) empty.push(sq);
    }
  }
  return empty;
}

/**
 * Get all pieces of a specific type and color.
 */
function findPieces(board, type, color) {
  const result = [];
  for (const [sq, piece] of board) {
    if (piece.type === type && piece.color === color) {
      result.push({ square: sq, ...piece });
    }
  }
  return result;
}

/**
 * Move a piece from one square to another (removing anything on the target).
 */
function movePiece(board, from, to) {
  const piece = board.get(from);
  if (!piece) return null;
  const captured = board.get(to) || null;
  board.delete(from);
  board.set(to, piece);
  return captured;
}

/**
 * Place a piece on a square.
 */
function placePiece(board, square, type, color) {
  board.set(square, { type, color });
}

/**
 * Remove a piece from a square.
 */
function removePiece(board, square) {
  const piece = board.get(square);
  board.delete(square);
  return piece;
}

/**
 * Swap two squares (both may or may not have pieces).
 */
function swapSquares(board, sq1, sq2) {
  const p1 = board.get(sq1) || null;
  const p2 = board.get(sq2) || null;
  board.delete(sq1);
  board.delete(sq2);
  if (p1) board.set(sq2, p1);
  if (p2) board.set(sq1, p2);
}

/**
 * Get adjacent squares (including diagonals).
 */
function getAdjacentSquares(square) {
  const col = COLUMNS.indexOf(square[0]);
  const row = ROWS.indexOf(square[1]);
  const adj = [];
  for (let dc = -1; dc <= 1; dc++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (dc === 0 && dr === 0) continue;
      const nc = col + dc;
      const nr = row + dr;
      if (nc >= 0 && nc < 8 && nr >= 0 && nr < 8) {
        adj.push(COLUMNS[nc] + ROWS[nr]);
      }
    }
  }
  return adj;
}

/**
 * Get the column index (0-7) for a square.
 */
function colIndex(square) {
  return COLUMNS.indexOf(square[0]);
}

/**
 * Get the row index (0-7) for a square.
 */
function rowIndex(square) {
  return ROWS.indexOf(square[1]);
}

/**
 * Get all squares in a column (by letter or index).
 */
function getColumnSquares(col) {
  const colLetter = typeof col === 'number' ? COLUMNS[col] : col;
  return ROWS.map(r => colLetter + r);
}

/**
 * Get all squares in a row (by number string or index).
 */
function getRowSquares(row) {
  const rowChar = typeof row === 'number' ? ROWS[row] : row;
  return COLUMNS.map(c => c + rowChar);
}

/**
 * Get a random element from an array.
 */
function randomFrom(arr) {
  if (!arr || arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Get the "forward" direction for a color. White moves up (+1 row), Black moves down (-1 row).
 */
function forwardDir(color) {
  return color === 'w' ? 1 : -1;
}

/**
 * Apply an offset to a square. Returns null if out of bounds.
 */
function offsetSquare(square, colOffset, rowOffset) {
  const c = colIndex(square) + colOffset;
  const r = rowIndex(square) + rowOffset;
  if (c < 0 || c > 7 || r < 0 || r > 7) return null;
  return COLUMNS[c] + ROWS[r];
}

/**
 * Check if a square is hard-blocked by a field-restriction mutator.
 * Hard blocks: Nuclear Fallout (blockedSquares), No Man's Land (blocked columns).
 * NOT hard blocks: mines, pits, frozen columns, tornado.
 */
function isSquareHardBlocked(room, square) {
  const ms = room.mutatorState;
  if (!ms) return false;

  // Nuclear Fallout blocked squares
  const blocked = ms.boardModifiers && ms.boardModifiers.blockedSquares;
  if (blocked && blocked.some(b => b.square === square)) return true;

  // No Man's Land blocked columns
  const nmlRules = ms.activeRules.filter(ar => ar.rule.id === 'no_mans_land');
  for (const ar of nmlRules) {
    const col = typeof ar.choiceData === 'number' ? COLUMNS[ar.choiceData] : ar.choiceData;
    if (square[0] === col) return true;
  }

  return false;
}

/**
 * Get all empty squares that are not hard-blocked by field-restriction mutators.
 */
function getValidEmptySquares(room, board) {
  return getEmptySquares(board).filter(sq => !isSquareHardBlocked(room, sq));
}

/**
 * Find the nearest valid (empty + not hard-blocked) square to a target.
 * Uses Manhattan distance. Ties broken by proximity to origin (backtrack preference).
 * Returns null if no valid square exists.
 */
function findNearestValidSquare(room, board, target, origin) {
  const targetCol = colIndex(target);
  const targetRow = rowIndex(target);
  const originCol = colIndex(origin);
  const originRow = rowIndex(origin);

  let best = null;
  let bestDist = Infinity;
  let bestOriginDist = Infinity;

  for (let c = 0; c < 8; c++) {
    for (let r = 0; r < 8; r++) {
      const sq = COLUMNS[c] + ROWS[r];
      if (board.has(sq)) continue;
      if (isSquareHardBlocked(room, sq)) continue;
      const dist = Math.abs(c - targetCol) + Math.abs(r - targetRow);
      const oDist = Math.abs(c - originCol) + Math.abs(r - originRow);
      if (dist < bestDist || (dist === bestDist && oDist < bestOriginDist)) {
        best = sq;
        bestDist = dist;
        bestOriginDist = oDist;
      }
    }
  }

  return best;
}

/**
 * Get the intermediate squares a sliding piece passes through (exclusive of from and to).
 * Returns an empty array for knights or single-step moves.
 */
function getIntermediateSquares(from, to) {
  const fc = colIndex(from), fr = rowIndex(from);
  const tc = colIndex(to), tr = rowIndex(to);
  const dc = Math.sign(tc - fc);
  const dr = Math.sign(tr - fr);
  const dist = Math.max(Math.abs(tc - fc), Math.abs(tr - fr));

  // Knights or single-step moves have no intermediates
  if (dist <= 1) return [];
  // Knights move in L-shape (2+1), not along a line
  if (Math.abs(tc - fc) + Math.abs(tr - fr) === 3 &&
      Math.abs(tc - fc) >= 1 && Math.abs(tr - fr) >= 1) return [];

  const squares = [];
  let c = fc + dc, r = fr + dr;
  while (c !== tc || r !== tr) {
    if (c < 0 || c > 7 || r < 0 || r > 7) break;
    squares.push(COLUMNS[c] + ROWS[r]);
    c += dc;
    r += dr;
  }
  return squares;
}

module.exports = {
  COLUMNS,
  ROWS,
  fenToBoard,
  boardToFenPlacement,
  buildFen,
  getSquaresByColor,
  getEmptySquares,
  findPieces,
  movePiece,
  placePiece,
  removePiece,
  swapSquares,
  getAdjacentSquares,
  colIndex,
  rowIndex,
  getColumnSquares,
  getRowSquares,
  randomFrom,
  forwardDir,
  offsetSquare,
  isSquareHardBlocked,
  getValidEmptySquares,
  findNearestValidSquare,
  getIntermediateSquares,
};
