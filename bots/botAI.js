const { Chess } = require('chess.js');

/**
 * Simple chess AI for bot players
 * Uses minimax with alpha-beta pruning at shallow depth for fast, reasonable moves
 */

// Piece values for evaluation
const PIECE_VALUES = {
  p: 100,   // Pawn
  n: 320,   // Knight
  b: 330,   // Bishop
  r: 500,   // Rook
  q: 900,   // Queen
  k: 20000, // King
};

// Positional bonuses for pawns (encourage center control and advancement)
const PAWN_TABLE = [
  [0,  0,  0,  0,  0,  0,  0,  0],
  [50, 50, 50, 50, 50, 50, 50, 50],
  [10, 10, 20, 30, 30, 20, 10, 10],
  [5,  5, 10, 25, 25, 10,  5,  5],
  [0,  0,  0, 20, 20,  0,  0,  0],
  [5, -5,-10,  0,  0,-10, -5,  5],
  [5, 10, 10,-20,-20, 10, 10,  5],
  [0,  0,  0,  0,  0,  0,  0,  0]
];

// Positional bonuses for knights (encourage center control)
const KNIGHT_TABLE = [
  [-50,-40,-30,-30,-30,-30,-40,-50],
  [-40,-20,  0,  0,  0,  0,-20,-40],
  [-30,  0, 10, 15, 15, 10,  0,-30],
  [-30,  5, 15, 20, 20, 15,  5,-30],
  [-30,  0, 15, 20, 20, 15,  0,-30],
  [-30,  5, 10, 15, 15, 10,  5,-30],
  [-40,-20,  0,  5,  5,  0,-20,-40],
  [-50,-40,-30,-30,-30,-30,-40,-50]
];

/**
 * Evaluate the board position from the perspective of the given color
 */
function evaluateBoard(chess, color) {
  let score = 0;
  const board = chess.board();

  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const piece = board[i][j];
      if (!piece) continue;

      const pieceValue = PIECE_VALUES[piece.type];
      let positionBonus = 0;

      // Add positional bonuses
      if (piece.type === 'p') {
        const row = piece.color === 'w' ? i : 7 - i;
        positionBonus = PAWN_TABLE[row][j];
      } else if (piece.type === 'n') {
        positionBonus = KNIGHT_TABLE[i][j];
      }

      const totalValue = pieceValue + positionBonus;

      // Add to score (positive for us, negative for opponent)
      if (piece.color === color) {
        score += totalValue;
      } else {
        score -= totalValue;
      }
    }
  }

  return score;
}

/**
 * Count total pieces on the board
 */
function countPieces(chess) {
  const board = chess.board();
  let count = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      if (board[i][j]) count++;
    }
  }
  return count;
}

/**
 * Order moves to improve alpha-beta pruning efficiency
 * Prioritize captures and piece values - FAST version without making/undoing moves
 * @param {boolean} isEndgame - Whether we're in endgame mode (more aggressive)
 */
function orderMoves(chess, moves, isEndgame = false) {
  return moves.sort((a, b) => {
    let aScore = 0;
    let bScore = 0;

    // Captures - prioritize higher value pieces
    if (a.captured) {
      aScore += PIECE_VALUES[a.captured] || 100;
      if (isEndgame) aScore += 200; // Boost captures in endgame
    }
    if (b.captured) {
      bScore += PIECE_VALUES[b.captured] || 100;
      if (isEndgame) bScore += 200;
    }

    // In endgame, prioritize king and queen moves (more aggressive)
    if (isEndgame) {
      if (a.piece === 'k') aScore += 150;
      if (b.piece === 'k') bScore += 150;
      if (a.piece === 'q') aScore += 100;
      if (b.piece === 'q') bScore += 100;
    }

    // Prioritize center moves
    const centerSquares = ['d4', 'd5', 'e4', 'e5'];
    if (centerSquares.includes(a.to)) aScore += 10;
    if (centerSquares.includes(b.to)) bScore += 10;

    return bScore - aScore;
  });
}

/**
 * Minimax algorithm with alpha-beta pruning
 */
function minimax(chess, depth, alpha, beta, maximizingPlayer, color, isEndgame) {
  // Base case: depth 0 or game over
  if (depth === 0 || chess.isGameOver()) {
    return evaluateBoard(chess, color);
  }

  const moves = chess.moves({ verbose: true });

  if (moves.length === 0) {
    return evaluateBoard(chess, color);
  }

  const orderedMoves = orderMoves(chess, moves, isEndgame);

  if (maximizingPlayer) {
    let maxEval = -Infinity;
    for (const move of orderedMoves) {
      chess.move(move);
      const evaluation = minimax(chess, depth - 1, alpha, beta, false, color, isEndgame);
      chess.undo();
      maxEval = Math.max(maxEval, evaluation);
      alpha = Math.max(alpha, evaluation);
      if (beta <= alpha) {
        break; // Beta cutoff
      }
    }
    return maxEval;
  } else {
    let minEval = Infinity;
    for (const move of orderedMoves) {
      chess.move(move);
      const evaluation = minimax(chess, depth - 1, alpha, beta, true, color, isEndgame);
      chess.undo();
      minEval = Math.min(minEval, evaluation);
      beta = Math.min(beta, evaluation);
      if (beta <= alpha) {
        break; // Alpha cutoff
      }
    }
    return minEval;
  }
}

/**
 * Get the best move for the bot using minimax algorithm
 * @param {Chess} chess - Chess.js instance
 * @param {string} pieceId - The piece ID (e.g., 'w_p_e2')
 * @param {string} currentSquare - The current square of the piece (e.g., 'e4')
 * @param {number} depth - Search depth (1-2 recommended for speed, 3-4 for endgame)
 * @param {boolean} onlyBotsLeft - Whether only bots remain in the game
 * @param {number} maxTimeMs - Maximum time in milliseconds to calculate (default: 50ms, endgame: 200ms)
 * @returns {object|null} - Best move object or null if no legal moves
 */
function getBestMove(chess, pieceId, currentSquare, depth = 2, onlyBotsLeft = false, maxTimeMs = null) {
  // Parse piece info from pieceId
  const [color] = pieceId.split('_');

  // Get legal moves for this specific piece at its current location
  const allMoves = chess.moves({ verbose: true, square: currentSquare });

  if (allMoves.length === 0) {
    return null;
  }

  // If only one move, return it immediately
  if (allMoves.length === 1) {
    return allMoves[0];
  }

  // Detect endgame: less than 10 pieces on board OR only bots playing
  const pieceCount = countPieces(chess);
  const isEndgame = pieceCount < 10 || onlyBotsLeft;

  // Set time limit: 50ms normal, 100ms endgame (unless specified)
  const timeLimit = maxTimeMs !== null ? maxTimeMs : (isEndgame ? 100 : 50);
  const startTime = Date.now();

  // Use shallow depth for speed - depth 1 always
  // Only increase to depth 2 in very late endgame (< 6 pieces)
  let searchDepth = (isEndgame && pieceCount < 6) ? 2 : 1;

  if (isEndgame) {
    console.log(`[botAI] Endgame detected (${pieceCount} pieces, botsOnly: ${onlyBotsLeft}), depth: ${searchDepth}, timeLimit: ${timeLimit}ms`);
  }

  let bestMove = null;
  let bestValue = -Infinity;
  const orderedMoves = orderMoves(chess, allMoves, isEndgame);

  // Limit the number of moves to evaluate for performance
  const maxMovesToEvaluate = isEndgame ? 10 : 8;
  const movesToEvaluate = orderedMoves.slice(0, maxMovesToEvaluate);

  for (const move of movesToEvaluate) {
    // Check if we've exceeded time limit
    if (Date.now() - startTime > timeLimit) {
      console.log(`[botAI] Time limit exceeded (${Date.now() - startTime}ms), returning best move so far`);
      break;
    }

    chess.move(move);
    const boardValue = minimax(chess, searchDepth - 1, -Infinity, Infinity, false, color, isEndgame);
    chess.undo();

    // Reduce randomness in endgame to play more precisely
    const randomFactor = isEndgame ? Math.random() * 5 : Math.random() * 10;
    const totalValue = boardValue + randomFactor;

    if (totalValue > bestValue) {
      bestValue = totalValue;
      bestMove = move;
    }
  }

  // If no move found (shouldn't happen), return first legal move
  if (!bestMove && allMoves.length > 0) {
    console.warn(`[botAI] No best move found, returning first legal move`);
    bestMove = allMoves[0];
  }

  return bestMove;
}

/**
 * Get a random legal move for the piece (fallback for very fast moves)
 * @param {Chess} chess - Chess.js instance
 * @param {string} pieceId - The piece ID (e.g., 'w_p_e2')
 * @param {string} currentSquare - The current square of the piece (e.g., 'e4')
 * @returns {object|null} - Random move object or null if no legal moves
 */
function getRandomMove(chess, pieceId, currentSquare) {
  try {
    const moves = chess.moves({ verbose: true, square: currentSquare });

    if (moves.length === 0) {
      console.warn(`[getRandomMove] No legal moves for piece at ${currentSquare}`);
      return null;
    }

    const randomMove = moves[Math.floor(Math.random() * moves.length)];
    console.log(`[getRandomMove] Selected ${randomMove.from} -> ${randomMove.to} from ${moves.length} options`);
    return randomMove;
  } catch (err) {
    console.error(`[getRandomMove] Error getting moves:`, err);
    return null;
  }
}

module.exports = {
  getBestMove,
  getRandomMove,
  evaluateBoard,
};
