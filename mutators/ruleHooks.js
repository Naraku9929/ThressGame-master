/**
 * Rule hook implementations.
 * Each rule ID maps to an object of hook functions.
 * Hooks receive (room, chooserColor, choiceData, secondChoiceData) for onActivate,
 * and (room, player, move, captured) for onAfterMove, etc.
 *
 * Board manipulation is done via boardUtils on a Map parsed from the FEN.
 * After manipulation, call syncChessFromBoard(room) to update chess.js.
 */

const {
  fenToBoard, buildFen, getEmptySquares, findPieces,
  movePiece, placePiece, removePiece, swapSquares,
  getAdjacentSquares, getColumnSquares, getRowSquares,
  colIndex, rowIndex, COLUMNS, ROWS, randomFrom, forwardDir, offsetSquare,
  getSquaresByColor,
  isSquareHardBlocked, findNearestValidSquare, getValidEmptySquares,
} = require('./boardUtils');
const { isRuleActive } = require('./mutatorEngine');

/**
 * Parse the current board from chess.js and return as a Map.
 */
function getBoardFromRoom(room) {
  return fenToBoard(room.chess.fen());
}

/**
 * After manipulating the board Map, sync it back into chess.js.
 */
function syncChessFromBoard(room, board) {
  // Auto-promote pawns that reach the OPPONENT's back rank
  // White promotes on row 8, black promotes on row 1
  // Pawns on their OWN back rank (white on 1, black on 8) should NOT promote
  for (const col of COLUMNS) {
    for (const edgeRow of ['1', '8']) {
      const sq = col + edgeRow;
      const piece = board.get(sq);
      if (piece && piece.type === 'p') {
        const isOpponentBackRank = (piece.color === 'w' && edgeRow === '8') ||
                                    (piece.color === 'b' && edgeRow === '1');
        if (isOpponentBackRank) {
          board.set(sq, { type: 'q', color: piece.color });
        }
      }
    }
  }
  const parts = room.chess.fen().split(' ');
  const turn = parts[1];
  const fullMove = parts[5];
  const newFen = buildFen(board, turn, fullMove);
  room.chess.load(newFen, { skipValidation: true });
}

const { resolveRPS } = require('../utils/rps');

/**
 * Place rooks for Risk it Rook based on flip results.
 * Used by both auto mode (random flips) and manual mode (player-chosen flips).
 */
function riskItRookPlaceRooks(room, chooserColor, flips) {
  const board = getBoardFromRoom(room);
  const opponentColor = chooserColor === 'w' ? 'b' : 'w';

  const chooserFlip = flips ? flips.chooserFlip : (Math.random() < 0.5 ? 'heads' : 'tails');
  const opponentFlip1 = flips ? flips.opponentFlip1 : (Math.random() < 0.5 ? 'heads' : 'tails');
  const opponentFlip2 = flips ? flips.opponentFlip2 : (Math.random() < 0.5 ? 'heads' : 'tails');

  let chooserSquare = null;
  let opponentSquare = null;

  if (chooserFlip === 'heads') {
    const empty = getValidEmptySquares(room, board);
    if (empty.length > 0) {
      chooserSquare = randomFrom(empty);
      safePlacePiece(room, board, chooserSquare, 'r', chooserColor);
    }
  }

  if (opponentFlip1 === 'heads' && opponentFlip2 === 'heads') {
    const empty = getValidEmptySquares(room, board);
    if (empty.length > 0) {
      opponentSquare = randomFrom(empty);
      safePlacePiece(room, board, opponentSquare, 'r', opponentColor);
    }
  }

  syncChessFromBoard(room, board);

  room._riskItRookResult = {
    chooserColor,
    opponentColor,
    chooserFlip,
    opponentFlip1,
    opponentFlip2,
    chooserSquare,
    opponentSquare,
  };
}

/**
 * Standard piece destruction function. ALL mutator piece removals should use this.
 * When Parry is active, auto-rolls RPS for the piece -- defender wins = piece survives.
 *
 * @param {Object} room - GameRoom instance (needed for Parry check)
 * @param {Map} board - Board map from getBoardFromRoom
 * @param {string} square - The square to remove the piece from
 * @returns {boolean} true if piece was removed, false if it survived (Parry save)
 */
function destroyPiece(room, board, square) {
  const piece = board.get(square);
  if (!piece) return false;

  // Kings can never be destroyed by mutator effects
  if (piece.type === 'k') return false;

  // Invulnerability Potion -- protected pieces can't be destroyed
  if (room.mutatorState) {
    const ms = room.mutatorState;
    const invul = (ms.boardModifiers.invulnerable || [])
      .filter(iv => !iv.expiresAtMove || ms.moveCount < iv.expiresAtMove);
    if (invul.some(iv => iv.square === square)) {
      return false;
    }
  }

  // Parry RPS check -- each removal individually rolls RPS
  if (room.mutatorState && isRuleActive(room.mutatorState, 'parry')) {
    const choices = ['rock', 'paper', 'scissors'];
    const attackerChoice = choices[Math.floor(Math.random() * 3)];
    const defenderChoice = choices[Math.floor(Math.random() * 3)];
    const result = resolveRPS(attackerChoice, defenderChoice);

    if (result === 'defender') {
      console.log(`[Parry] ${piece.color}${piece.type} at ${square} survived! (${attackerChoice} vs ${defenderChoice})`);
      return false; // Piece survives
    }
    console.log(`[Parry] ${piece.color}${piece.type} at ${square} destroyed (${attackerChoice} vs ${defenderChoice})`);
  }

  removePiece(board, square);
  return true;
}

/**
 * Trigger mine/pit destruction when a piece lands on a soft-restricted square.
 * Kings survive but mines are still consumed.
 * @returns {boolean} true if piece was destroyed, false otherwise
 */
function triggerSoftRestrictions(room, board, square) {
  const ms = room.mutatorState;
  if (!ms) return false;

  const piece = board.get(square);
  if (!piece || piece.type === 'k') {
    // Kings survive, but still consume mines
    if (ms.boardModifiers && ms.boardModifiers.mines) {
      const mineIdx = ms.boardModifiers.mines.findIndex(m => m.square === square);
      if (mineIdx !== -1) {
        ms.boardModifiers.mines.splice(mineIdx, 1);
        if (ms.boardModifiers.mines.length === 0) {
          const { removePersistentRule } = require('./mutatorEngine');
          removePersistentRule(ms, 'minefield');
        }
      }
    }
    return false;
  }

  // Check mines
  if (ms.boardModifiers && ms.boardModifiers.mines) {
    const mineIdx = ms.boardModifiers.mines.findIndex(m => m.square === square);
    if (mineIdx !== -1) {
      ms.boardModifiers.mines.splice(mineIdx, 1);
      if (ms.boardModifiers.mines.length === 0) {
        const { removePersistentRule } = require('./mutatorEngine');
        removePersistentRule(ms, 'minefield');
      }
      return destroyPiece(room, board, square);
    }
  }

  // Check bottomless pits
  if (ms.boardModifiers && ms.boardModifiers.bottomlessPits) {
    const pit = ms.boardModifiers.bottomlessPits.find(p => p.square === square);
    if (pit) {
      return destroyPiece(room, board, square);
    }
  }

  return false;
}

/**
 * Move a piece safely with field-restriction validation.
 * If destination is hard-blocked, redirects to nearest valid square.
 * Triggers soft restrictions (mines/pits) after placement.
 * @returns {string|null} final square or null if piece destroyed/no valid square
 */
function safeMovePiece(room, board, from, to) {
  let finalSquare = to;

  if (isSquareHardBlocked(room, to)) {
    const piece = board.get(from);
    if (!piece) return null;
    board.delete(from);
    finalSquare = findNearestValidSquare(room, board, to, from);
    if (!finalSquare) return null;
    board.set(finalSquare, piece);
  } else {
    movePiece(board, from, to);
  }

  triggerSoftRestrictions(room, board, finalSquare);
  return finalSquare;
}

/**
 * Place a piece safely. If square is hard-blocked or occupied, redirect.
 * @returns {string|null} final square or null if no valid square
 */
function safePlacePiece(room, board, square, type, color) {
  let finalSquare = square;

  if (isSquareHardBlocked(room, square) || board.has(square)) {
    finalSquare = findNearestValidSquare(room, board, square, square);
    if (!finalSquare) return null;
  }

  placePiece(board, finalSquare, type, color);
  triggerSoftRestrictions(room, board, finalSquare);
  return finalSquare;
}

/**
 * Swap two squares safely. Fails if either destination is hard-blocked and
 * a piece would land there. Triggers soft restrictions after swap.
 * @returns {boolean} true if swap succeeded, false if blocked
 */
function safeSwapSquares(room, board, sq1, sq2) {
  const p1 = board.get(sq1) || null;
  const p2 = board.get(sq2) || null;

  if (p1 && isSquareHardBlocked(room, sq2)) return false;
  if (p2 && isSquareHardBlocked(room, sq1)) return false;

  swapSquares(board, sq1, sq2);

  if (p1) triggerSoftRestrictions(room, board, sq2);
  if (p2) triggerSoftRestrictions(room, board, sq1);

  return true;
}

// --- HOOK IMPLEMENTATIONS -----------------------------------------

const hooks = {
  // --- Going Woke -----------------------------------------------
  going_woke: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      // Process columns e-h (right half), right to left
      for (let c = 4; c < 8; c++) {
        for (const row of ROWS) {
          const sq = COLUMNS[c] + row;
          const piece = board.get(sq);
          if (!piece) continue;
          const targetCol = c - 1;
          const target = COLUMNS[targetCol] + row;
          if (!board.has(target) && !isSquareHardBlocked(room, target)) {
            movePiece(board, sq, target);
            triggerSoftRestrictions(room, board, target);
          }
        }
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- March of the Pawnguins -----------------------------------
  march_of_the_pawnguins: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      // Process white pawns (move up, from rank 7 down to avoid double-move)
      for (let r = 6; r >= 0; r--) {
        for (const col of COLUMNS) {
          const sq = col + ROWS[r];
          const piece = board.get(sq);
          if (!piece || piece.type !== 'p' || piece.color !== 'w') continue;
          const target = col + ROWS[r + 1];
          if (target && !board.has(target) && !isSquareHardBlocked(room, target)) {
            movePiece(board, sq, target);
            triggerSoftRestrictions(room, board, target);
          }
        }
      }
      // Process black pawns (move down, from rank 2 up)
      for (let r = 1; r < 8; r++) {
        for (const col of COLUMNS) {
          const sq = col + ROWS[r];
          const piece = board.get(sq);
          if (!piece || piece.type !== 'p' || piece.color !== 'b') continue;
          const target = col + ROWS[r - 1];
          if (target && !board.has(target) && !isSquareHardBlocked(room, target)) {
            movePiece(board, sq, target);
            triggerSoftRestrictions(room, board, target);
          }
        }
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- The Rumbling ---------------------------------------------
  the_rumbling: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      // White pawns advance and kill
      for (let r = 6; r >= 0; r--) {
        for (const col of COLUMNS) {
          const sq = col + ROWS[r];
          const piece = board.get(sq);
          if (!piece || piece.type !== 'p' || piece.color !== 'w') continue;
          const target = col + ROWS[r + 1];
          if (target && !isSquareHardBlocked(room, target)) {
            const targetPiece = board.get(target);
            if (!targetPiece || targetPiece.type !== 'k') {
              // Move pawn forward, killing non-King occupant
              if (targetPiece) {
                if (!destroyPiece(room, board, target)) continue; // Parry saved it, pawn can't advance
              }
              movePiece(board, sq, target);
              triggerSoftRestrictions(room, board, target);
            }
          }
        }
      }
      // Black pawns advance and kill
      for (let r = 1; r < 8; r++) {
        for (const col of COLUMNS) {
          const sq = col + ROWS[r];
          const piece = board.get(sq);
          if (!piece || piece.type !== 'p' || piece.color !== 'b') continue;
          const target = col + ROWS[r - 1];
          if (target && !isSquareHardBlocked(room, target)) {
            const targetPiece = board.get(target);
            if (!targetPiece || targetPiece.type !== 'k') {
              if (targetPiece) {
                if (!destroyPiece(room, board, target)) continue; // Parry saved it
              }
              movePiece(board, sq, target);
              triggerSoftRestrictions(room, board, target);
            }
          }
        }
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- They Deserved It -----------------------------------------
  they_deserved_it: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      const nonKings = [];
      for (const [sq, piece] of board) {
        if (piece.type !== 'k') nonKings.push(sq);
      }
      if (nonKings.length > 0) {
        const target = randomFrom(nonKings);
        destroyPiece(room, board, target);
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Born Again Christian -------------------------------------
  born_again_christian: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      for (const [sq, piece] of board) {
        if (piece.type === 'q') {
          board.set(sq, { type: 'b', color: piece.color });
        }
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Dub Thee Knight ---------------------------------------------
  dub_thee_knight: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      const allPawns = [];
      for (const [sq, piece] of board) {
        if (piece.type === 'p') allPawns.push(sq);
      }
      // Pick up to 2 random pawns
      const count = Math.min(2, allPawns.length);
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(Math.random() * allPawns.length);
        const sq = allPawns.splice(idx, 1)[0];
        const piece = board.get(sq);
        board.set(sq, { type: 'n', color: piece.color });
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Back That Shit Up ------------------------------------------
  back_that_shit_up: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      // White pawns move backward (down, row index - 1). Process from rank 2 upward (low index first).
      for (let r = 1; r < 8; r++) {
        for (const col of COLUMNS) {
          const sq = col + ROWS[r];
          const piece = board.get(sq);
          if (!piece || piece.type !== 'p' || piece.color !== 'w') continue;
          const target = col + ROWS[r - 1];
          if (target && !board.has(target) && !isSquareHardBlocked(room, target)) {
            movePiece(board, sq, target);
            triggerSoftRestrictions(room, board, target);
          }
        }
      }
      // Black pawns move backward (up, row index + 1). Process from rank 7 downward (high index first).
      for (let r = 6; r >= 0; r--) {
        for (const col of COLUMNS) {
          const sq = col + ROWS[r];
          const piece = board.get(sq);
          if (!piece || piece.type !== 'p' || piece.color !== 'b') continue;
          const target = col + ROWS[r + 1];
          if (target && !board.has(target) && !isSquareHardBlocked(room, target)) {
            movePiece(board, sq, target);
            triggerSoftRestrictions(room, board, target);
          }
        }
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Column Swap ------------------------------------------------
  column_swap: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      // Pick 2 random distinct columns
      const colIndices = [0, 1, 2, 3, 4, 5, 6, 7];
      const idx1 = Math.floor(Math.random() * colIndices.length);
      const col1 = colIndices.splice(idx1, 1)[0];
      const idx2 = Math.floor(Math.random() * colIndices.length);
      const col2 = colIndices[idx2];
      // Swap contents for each row
      for (const row of ROWS) {
        const sq1 = COLUMNS[col1] + row;
        const sq2 = COLUMNS[col2] + row;
        safeSwapSquares(room, board, sq1, sq2);
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Hot Drop ---------------------------------------------------
  hot_drop: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      const empty = getValidEmptySquares(room, board);
      if (empty.length > 0) {
        const wIdx = Math.floor(Math.random() * empty.length);
        const wSq = empty.splice(wIdx, 1)[0];
        safePlacePiece(room, board, wSq, 'q', 'w');
      }
      const empty2 = getValidEmptySquares(room, board);
      if (empty2.length > 0) {
        const bSq = randomFrom(empty2);
        safePlacePiece(room, board, bSq, 'q', 'b');
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Minefield --------------------------------------------------
  minefield: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      const empty = getValidEmptySquares(room, board);
      if (!room.mutatorState.boardModifiers.mines) {
        room.mutatorState.boardModifiers.mines = [];
      }
      const count = Math.min(2, empty.length);
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(Math.random() * empty.length);
        const sq = empty.splice(idx, 1)[0];
        room.mutatorState.boardModifiers.mines.push({ square: sq });
      }
    },
    onAfterMove(room, playerColor, move) {
      const ms = room.mutatorState;
      if (!ms.boardModifiers.mines || ms.boardModifiers.mines.length === 0) return;

      // Path traps are handled in moveHandler before broadcast.
      // Here we only check the destination square.

      // Check destination square
      const mineIdx = ms.boardModifiers.mines.findIndex(m => m.square === move.to);
      if (mineIdx !== -1) {
        const board = getBoardFromRoom(room);
        const piece = board.get(move.to);
        if (piece && piece.type !== 'k') {
          if (destroyPiece(room, board, move.to)) {
            syncChessFromBoard(room, board);
          }
        }
        ms.boardModifiers.mines.splice(mineIdx, 1);
        if (ms.boardModifiers.mines.length === 0) {
          const { removePersistentRule } = require('./mutatorEngine');
          removePersistentRule(ms, 'minefield');
        }
      }
    },
  },

  // --- Risk It Rook -----------------------------------------------
  risk_it_rook: {
    onActivate(room, chooserColor) {
      // Manual mode: defer rook placement until players submit their flip choices
      if (room.manualCoinFlip) {
        room._riskItRookPending = {
          chooserColor,
          opponentColor: chooserColor === 'w' ? 'b' : 'w',
          phase: 'chooser', // 'chooser' -> 'opponent1' -> 'opponent2' -> done
          flips: {},
        };
        return;
      }

      // Auto mode: random flips + immediate placement
      riskItRookPlaceRooks(room, chooserColor);
    },
  },

  // --- Nuclear Fallout --------------------------------------------
  nuclear_fallout: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      const empty = getValidEmptySquares(room, board);
      if (!room.mutatorState.boardModifiers.blockedSquares) {
        room.mutatorState.boardModifiers.blockedSquares = [];
      }
      const count = Math.min(2, empty.length);
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(Math.random() * empty.length);
        const sq = empty.splice(idx, 1)[0];
        room.mutatorState.boardModifiers.blockedSquares.push({ square: sq, permanent: true });
      }
    },
    getLegalMoveModifiers(room, playerColor) {
      const ms = room.mutatorState;
      const blocked = ms.boardModifiers.blockedSquares;
      if (!blocked || blocked.length === 0) return null;
      const blockedSet = new Set(blocked.map(b => b.square));

      return (moves) => {
        const filtered = moves.filter(m => {
          // Can't enter a blocked square
          if (blockedSet.has(m.to)) return false;
          // Sliding pieces can't cross blocked squares
          const fromCol = COLUMNS.indexOf(m.from[0]);
          const fromRow = parseInt(m.from[1]);
          const toCol = COLUMNS.indexOf(m.to[0]);
          const toRow = parseInt(m.to[1]);
          const dc = Math.sign(toCol - fromCol);
          const dr = Math.sign(toRow - fromRow);
          if (dc === 0 && dr === 0) return true;
          let c = fromCol + dc, r = fromRow + dr;
          while (c !== toCol || r !== toRow) {
            const sq = COLUMNS[c] + r;
            if (blockedSet.has(sq)) return false;
            c += dc;
            r += dr;
          }
          return true;
        });
        return filtered.length > 0 ? filtered : moves;
      };
    },
  },

  // --- Chaaaarge! -------------------------------------------------
  chaaaarge: {
    onActivate(room, chooserColor) {
      const board = getBoardFromRoom(room);
      const dir = forwardDir(chooserColor);
      // Process from closest-to-enemy rank backward to avoid double-moves
      // White (dir=+1): process from rank 8 (index 7) down to rank 1 (index 0)
      // Black (dir=-1): process from rank 1 (index 0) up to rank 8 (index 7)
      const startR = dir === 1 ? 7 : 0;
      const endR = dir === 1 ? -1 : 8;
      const stepR = dir === 1 ? -1 : 1;
      for (let r = startR; r !== endR; r += stepR) {
        for (const col of COLUMNS) {
          const sq = col + ROWS[r];
          const piece = board.get(sq);
          if (!piece || piece.color !== chooserColor || piece.type === 'k') continue;
          const target = offsetSquare(sq, 0, dir);
          if (target && !board.has(target) && !isSquareHardBlocked(room, target)) {
            movePiece(board, sq, target);
            triggerSoftRestrictions(room, board, target);
          }
        }
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- The Enemy is Routed ----------------------------------------
  the_enemy_is_routed: {
    onActivate(room, chooserColor) {
      const board = getBoardFromRoom(room);
      const opponentColor = chooserColor === 'w' ? 'b' : 'w';
      // Opponent's backward direction is opposite of their forward
      const backDir = -forwardDir(opponentColor);
      // Process from closest-to-their-own-backline rank first to avoid double-moves
      // If opponent is white (backDir = -1): process from rank 1 (index 0) up
      // If opponent is black (backDir = +1): process from rank 8 (index 7) down
      const startR = backDir === -1 ? 0 : 7;
      const endR = backDir === -1 ? 8 : -1;
      const stepR = backDir === -1 ? 1 : -1;
      for (let r = startR; r !== endR; r += stepR) {
        for (const col of COLUMNS) {
          const sq = col + ROWS[r];
          const piece = board.get(sq);
          if (!piece || piece.color !== opponentColor || piece.type === 'k') continue;
          const target = offsetSquare(sq, 0, backDir);
          if (target && !board.has(target) && !isSquareHardBlocked(room, target)) {
            movePiece(board, sq, target);
            triggerSoftRestrictions(room, board, target);
          }
        }
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Get Up in Their Face ---------------------------------------
  get_up_in_their_face: {
    onActivate(room, chooserColor) {
      const board = getBoardFromRoom(room);
      const dir = forwardDir(chooserColor);
      // Process from closest-to-enemy rank backward to avoid double-moves
      const startR = dir === 1 ? 7 : 0;
      const endR = dir === 1 ? -1 : 8;
      const stepR = dir === 1 ? -1 : 1;
      for (let r = startR; r !== endR; r += stepR) {
        for (const col of COLUMNS) {
          const sq = col + ROWS[r];
          const piece = board.get(sq);
          if (!piece || piece.color !== chooserColor || piece.type === 'k') continue;
          // Slide forward until hitting an occupied square, edge, or hard-blocked square
          let current = sq;
          while (true) {
            const next = offsetSquare(current, 0, dir);
            if (!next || board.has(next) || isSquareHardBlocked(room, next)) break;
            current = next;
          }
          if (current !== sq) {
            movePiece(board, sq, current);
            triggerSoftRestrictions(room, board, current);
          }
        }
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- A Light Breeze ---------------------------------------------
  a_light_breeze: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      // Columns D (index 3) and E (index 4) move one square to the right (index+1).
      // Process column E first (rightmost), then D, to avoid collisions.
      for (const cIdx of [4, 3]) {
        for (const row of ROWS) {
          const sq = COLUMNS[cIdx] + row;
          const piece = board.get(sq);
          if (!piece) continue;
          const targetCol = cIdx + 1;
          if (targetCol > 7) continue;
          const target = COLUMNS[targetCol] + row;
          if (isSquareHardBlocked(room, target)) continue;
          const targetPiece = board.get(target);
          if (targetPiece && targetPiece.type === 'k') continue; // Don't kill Kings
          if (targetPiece) {
            if (!destroyPiece(room, board, target)) continue; // Parry saved it
          }
          movePiece(board, sq, target);
          triggerSoftRestrictions(room, board, target);
        }
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Mind Control -----------------------------------------------
  mind_control: {
    onActivate(room, chooserColor, choiceData, secondChoiceData) {
      const board = getBoardFromRoom(room);
      // choiceData = square of chooser's target (enemy piece to convert)
      if (choiceData) {
        const piece = board.get(choiceData);
        if (piece && piece.type !== 'k') {
          board.set(choiceData, { type: piece.type, color: chooserColor });
        }
      }
      // secondChoiceData = square of opponent's target (enemy piece to convert)
      if (secondChoiceData) {
        const opponentColor = chooserColor === 'w' ? 'b' : 'w';
        const piece = board.get(secondChoiceData);
        if (piece && piece.type !== 'k') {
          board.set(secondChoiceData, { type: piece.type, color: opponentColor });
        }
      }
      syncChessFromBoard(room, board);
    },
    getLegalMoveModifiers(room) {
      const board = getBoardFromRoom(room);
      return (moves) => {
        // Block king captures on the same turn Mind Control activates
        const filtered = moves.filter(m => {
          const target = board.get(m.to);
          return !target || target.type !== 'k';
        });
        return filtered.length > 0 ? filtered : moves;
      };
    },
  },

  // --- Drafted for Battle -----------------------------------------
  drafted_for_battle: {
    onActivate(room, chooserColor, choiceData, secondChoiceData) {
      const board = getBoardFromRoom(room);
      const opponentColor = chooserColor === 'w' ? 'b' : 'w';
      // choiceData = square of chooser's bishop/knight to swap with their King
      if (choiceData) {
        const kings = findPieces(board, 'k', chooserColor);
        if (kings.length > 0) {
          safeSwapSquares(room, board, kings[0].square, choiceData);
        }
      }
      // secondChoiceData = square of opponent's bishop/knight to swap with their King
      if (secondChoiceData) {
        const kings = findPieces(board, 'k', opponentColor);
        if (kings.length > 0) {
          safeSwapSquares(room, board, kings[0].square, secondChoiceData);
        }
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Anti-Camping -----------------------------------------------
  anti_camping: {
    onActivate(room, chooserColor, choiceData) {
      const board = getBoardFromRoom(room);
      // choiceData = square of the enemy piece to swap
      if (!choiceData) return;
      // Reject king targets (defense-in-depth -- also validated in mutatorHandler)
      const targetPiece = board.get(choiceData);
      if (!targetPiece || targetPiece.type === 'k') return;
      // Find a random friendly non-King piece
      const friendlyNonKing = [];
      for (const [sq, piece] of board) {
        if (piece.color === chooserColor && piece.type !== 'k') {
          friendlyNonKing.push(sq);
        }
      }
      const validFriendly = friendlyNonKing.filter(sq => !isSquareHardBlocked(room, sq));
      if (validFriendly.length > 0) {
        const friendlySq = randomFrom(validFriendly);
        safeSwapSquares(room, board, choiceData, friendlySq);
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Bottomless Pit ---------------------------------------------
  bottomless_pit: {
    onActivate(room, chooserColor, choiceData) {
      if (!choiceData) return;
      if (!room.mutatorState.boardModifiers.bottomlessPits) {
        room.mutatorState.boardModifiers.bottomlessPits = [];
      }
      room.mutatorState.boardModifiers.bottomlessPits.push({ square: choiceData });
    },
    onAfterMove(room, playerColor, move) {
      const ms = room.mutatorState;
      if (!ms.boardModifiers.bottomlessPits) return;

      // Path traps are handled in moveHandler before broadcast.
      // Here we only check the destination square.

      // Check destination square
      const pit = ms.boardModifiers.bottomlessPits.find(p => p.square === move.to);
      if (pit) {
        const board = getBoardFromRoom(room);
        const piece = board.get(move.to);
        if (piece && piece.type !== 'k') {
          if (destroyPiece(room, board, move.to)) {
            syncChessFromBoard(room, board);
          }
        }
      }
    },
  },

  // --- Moving Up the Corporate Ladder -----------------------------
  moving_up_the_corporate_ladder: {
    onActivate(room, chooserColor, choiceData) {
      if (!choiceData) return;
      const board = getBoardFromRoom(room);
      // choiceData = { square1, square2 } or array [sq1, sq2]
      const sq1 = Array.isArray(choiceData) ? choiceData[0] : choiceData.square1;
      const sq2 = Array.isArray(choiceData) ? choiceData[1] : choiceData.square2;
      if (sq1 && sq2) {
        safeSwapSquares(room, board, sq1, sq2);
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Hurricane --------------------------------------------------
  hurricane: {
    onActivate(room, chooserColor, choiceData) {
      if (choiceData === null || choiceData === undefined) return;
      const board = getBoardFromRoom(room);
      // choiceData = row number (could be string '1'-'8' or index 0-7)
      const rowChar = typeof choiceData === 'number' && choiceData >= 0 && choiceData <= 7
        ? ROWS[choiceData]
        : String(choiceData);
      // Get all pieces in the row, sorted by column (left to right)
      const piecesInRow = [];
      for (const col of COLUMNS) {
        const sq = col + rowChar;
        const piece = board.get(sq);
        if (piece) {
          piecesInRow.push(piece);
          board.delete(sq);
        }
      }
      // Place them left-justified
      for (let i = 0; i < piecesInRow.length; i++) {
        const sq = COLUMNS[i] + rowChar;
        board.set(sq, piecesInRow[i]);
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Sophie's Choice -------------------------------------------
  sophies_choice: {
    onActivate(room, chooserColor, choiceData, secondChoiceData) {
      const board = getBoardFromRoom(room);
      // choiceData = square of chooser's piece to kill
      if (choiceData) {
        destroyPiece(room, board, choiceData);
      }
      // secondChoiceData = square of opponent's piece to kill
      if (secondChoiceData) {
        destroyPiece(room, board, secondChoiceData);
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Two Kids in a Trenchcoat -----------------------------------
  two_kids_in_a_trenchcoat: {
    onActivate(room, chooserColor, choiceData) {
      if (!choiceData) return;
      const board = getBoardFromRoom(room);
      // choiceData = { pawns: [sq1, sq2], bishopSquare: sq }
      const pawns = choiceData.pawns || [];
      const bishopSquare = choiceData.bishopSquare;
      // Remove the 2 pawns (voluntary sacrifice -- skip Parry)
      for (const sq of pawns) {
        removePiece(board, sq);
      }
      // Place a bishop of the chooser's color
      if (bishopSquare) {
        safePlacePiece(room, board, bishopSquare, 'b', chooserColor);
      }
      syncChessFromBoard(room, board);
    },
  },

  // --- Restriction Rules ------------------------------------------

  // --- Severe Constipation ----------------------------------------
  severe_constipation: {
    getLegalMoveModifiers(room, playerColor) {
      // Bishops and Knights cannot move
      return (moves) => moves.filter(m => m.piece !== 'b' && m.piece !== 'n');
    },
  },

  // --- Hobbit Battle ----------------------------------------------
  hobbit_battle: {
    getLegalMoveModifiers(room, playerColor) {
      // ONLY Pawns can be moved
      return (moves) => moves.filter(m => m.piece === 'p');
    },
  },

  // --- Bloodthirsty ----------------------------------------------
  bloodthirsty: {
    getLegalMoveModifiers(room, playerColor) {
      // Must capture if possible
      return (moves) => {
        const captures = moves.filter(m => m.captured);
        return captures.length > 0 ? captures : moves;
      };
    },
  },

  // --- Ice Age ---------------------------------------------------
  ice_age: {
    getLegalMoveModifiers(room, playerColor) {
      // Pieces in columns a and h are frozen (can't move)
      return (moves) => moves.filter(m => {
        const fromCol = m.from[0];
        return fromCol !== 'a' && fromCol !== 'h';
      });
    },
  },

  // --- No Cowards ------------------------------------------------
  no_cowards: {
    getLegalMoveModifiers(room, playerColor) {
      // All moves must advance toward opponent's side
      return (moves) => {
        const forward = moves.filter(m => {
          const fromRow = parseInt(m.from[1]);
          const toRow = parseInt(m.to[1]);
          return playerColor === 'w' ? toRow > fromRow : toRow < fromRow;
        });
        // If no forward moves, allow all (safety)
        return forward.length > 0 ? forward : moves;
      };
    },
  },

  // --- All on Red ------------------------------------------------
  all_on_red: {
    getLegalMoveModifiers(room, playerColor) {
      const ms = room.mutatorState;
      // Block moves if coin flip hasn't been resolved yet
      if (ms.pendingCoinFlip && ms.pendingCoinFlip.forPlayer === playerColor) {
        return (moves) => []; // No moves allowed until flip is resolved
      }
      // Read cached result (set by server in moveHandler or coinFlipChoice handler)
      if (!ms.coinFlipResult || ms.coinFlipResult.moveCount !== ms.moveCount) {
        // Fallback: if somehow no result cached, flip now (shouldn't happen in normal flow)
        ms.coinFlipResult = {
          result: Math.random() < 0.5 ? 'heads' : 'tails',
          moveCount: ms.moveCount,
        };
      }
      if (ms.coinFlipResult.result === 'tails') {
        return (moves) => moves.filter(m => m.piece === 'k');
      }
      return null;
    },
  },

  // --- Mr. Freeze ------------------------------------------------
  mr_freeze: {
    onActivate(room, chooserColor, choiceData) {
      if (!choiceData) return;
      const ms = room.mutatorState;
      // choiceData is a column letter ('a'-'h') or column index (0-7)
      const column = typeof choiceData === 'number' ? COLUMNS[choiceData] : choiceData;
      // Find the active rule to get its expiresAtMove
      const activeRule = ms.activeRules.find(ar => ar.rule.id === 'mr_freeze');
      const expiresAtMove = activeRule ? activeRule.expiresAtMove : ms.moveCount + 9;
      ms.boardModifiers.frozenColumns.push({
        column,
        expiresAtMove,
        immune: true,
      });
    },
    onExpire(room) {
      const ms = room.mutatorState;
      ms.boardModifiers.frozenColumns = ms.boardModifiers.frozenColumns.filter(
        fc => fc.expiresAtMove === null || ms.moveCount < fc.expiresAtMove
      );
    },
    getLegalMoveModifiers(room, playerColor) {
      const ms = room.mutatorState;
      const frozenCols = (ms.boardModifiers.frozenColumns || [])
        .filter(fc => !fc.expiresAtMove || ms.moveCount < fc.expiresAtMove);
      if (frozenCols.length === 0) return null;
      const frozenSet = new Set(frozenCols.map(fc => fc.column));
      return (moves) => moves.filter(m => {
        // Can't move FROM a frozen column
        if (frozenSet.has(m.from[0])) return false;
        // Can't capture INTO a frozen column (pieces are immune)
        if (m.captured && frozenSet.has(m.to[0])) return false;
        return true;
      });
    },
  },

  // --- No Man's Land ---------------------------------------------
  no_mans_land: {
    onActivate(room, chooserColor, choiceData) {
      // choiceData is a column letter ('a'-'h') or column index (0-7)
      // Stored in the active rule's choiceData -- no board modifier needed
      // getLegalMoveModifiers reads from activeRules
    },
    getLegalMoveModifiers(room, playerColor) {
      const ms = room.mutatorState;
      const activeRules = ms.activeRules.filter(ar => ar.rule.id === 'no_mans_land');
      if (activeRules.length === 0) return null;
      const blockedCols = new Set(activeRules.map(ar => {
        const col = ar.choiceData;
        return typeof col === 'number' ? COLUMNS[col] : col;
      }));
      const blockedColIndices = new Set([...blockedCols].map(c => COLUMNS.indexOf(c)));

      // No pieces may ENTER or CROSS the blocked column
      // For sliding pieces (bishop, rook, queen), check all intermediate squares
      return (moves) => moves.filter(m => {
        const toCol = m.to[0];
        // Destination is in blocked column -- always blocked
        if (blockedCols.has(toCol)) return false;

        // Check if the path crosses a blocked column (sliding pieces only)
        const fromColIdx = COLUMNS.indexOf(m.from[0]);
        const toColIdx = COLUMNS.indexOf(m.to[0]);
        if (fromColIdx === toColIdx) return true; // same column, no crossing

        const minCol = Math.min(fromColIdx, toColIdx);
        const maxCol = Math.max(fromColIdx, toColIdx);
        for (const blocked of blockedColIndices) {
          if (blocked > minCol && blocked < maxCol) return false;
        }
        return true;
      });
    },
  },

  // --- Tornado ---------------------------------------------------
  tornado: {
    onActivate(room, chooserColor, choiceData) {
      if (!choiceData) return;
      const ms = room.mutatorState;
      const activeRule = ms.activeRules.find(ar => ar.rule.id === 'tornado');
      const expiresAtMove = activeRule ? activeRule.expiresAtMove : ms.moveCount + 9;
      ms.boardModifiers.tornadoSquare = {
        square: choiceData,
        expiresAtMove,
      };
    },
    getLegalMoveModifiers(room, playerColor) {
      const ms = room.mutatorState;
      const tornado = ms.boardModifiers.tornadoSquare;
      if (!tornado || (tornado.expiresAtMove && ms.moveCount >= tornado.expiresAtMove)) return null;
      // If any piece CAN move to the tornado square, it MUST
      return (moves) => {
        const toTornado = moves.filter(m => m.to === tornado.square);
        return toTornado.length > 0 ? toTornado : moves;
      };
    },
  },

  // --- Death Modifiers ----------------------------------------------

  // --- Down with the Ship ----------------------------------------
  down_with_the_ship: {
    onCapture(room, playerColor, capturedPiece, captureSquare) {
      // The capturing piece (now on captureSquare) also dies
      const board = getBoardFromRoom(room);
      const piece = board.get(captureSquare);
      if (piece && piece.type !== 'k') {
        if (destroyPiece(room, board, captureSquare)) {
          syncChessFromBoard(room, board);
        }
      }
    },
  },

  // --- Second Chance ---------------------------------------------
  second_chance: {
    onCapture(room, playerColor, capturedPiece, captureSquare) {
      // 50% chance the captured piece revives on a random empty square
      if (capturedPiece === 'k') return; // Kings don't get second chances this way
      if (Math.random() < 0.5) {
        const board = getBoardFromRoom(room);
        const empty = getValidEmptySquares(room, board);
        if (empty.length > 0) {
          const sq = randomFrom(empty);
          const capturedColor = playerColor === 'w' ? 'b' : 'w';
          safePlacePiece(room, board, sq, capturedPiece, capturedColor);
          syncChessFromBoard(room, board);
        }
      }
    },
  },

  // --- Kamikaze --------------------------------------------------
  kamikaze: {
    onCapture(room, playerColor, capturedPiece, captureSquare) {
      // 25% chance ALL adjacent pieces die
      if (Math.random() < 0.25) {
        const board = getBoardFromRoom(room);
        const adjacent = getAdjacentSquares(captureSquare);
        let removed = false;
        for (const sq of adjacent) {
          const piece = board.get(sq);
          if (piece && piece.type !== 'k') {
            if (destroyPiece(room, board, sq)) removed = true;
          }
        }
        if (removed) {
          syncChessFromBoard(room, board);
        }
      }
    },
  },

  // --- Christmas Truce -------------------------------------------
  christmas_truce: {
    getLegalMoveModifiers(room, playerColor) {
      // No pieces can die -- filter out all capture moves
      return (moves) => {
        const nonCaptures = moves.filter(m => !m.captured);
        // Safety: if all moves are captures (forced capture position), allow them
        return nonCaptures.length > 0 ? nonCaptures : moves;
      };
    },
  },

  // --- Hobbit Slaughter ------------------------------------------
  hobbit_slaughter: {
    getLegalMoveModifiers(room, playerColor) {
      // Only Pawns can die -- filter out captures of non-pawn pieces
      return (moves) => moves.filter(m => {
        if (!m.captured) return true; // non-capture moves are fine
        return m.captured === 'p'; // only allow capturing pawns
      });
    },
  },

  // --- Soul Link -------------------------------------------------
  soul_link: {
    onCapture(room, playerColor, capturedPiece, captureSquare) {
      // If a Knight, Rook, or Bishop dies, all of the same type + color also die
      if (!['n', 'r', 'b'].includes(capturedPiece)) return;
      const board = getBoardFromRoom(room);
      const capturedColor = playerColor === 'w' ? 'b' : 'w';
      const linked = findPieces(board, capturedPiece, capturedColor);
      let removed = false;
      for (const p of linked) {
        if (destroyPiece(room, board, p.square)) removed = true;
      }
      if (removed) {
        syncChessFromBoard(room, board);
      }
    },
  },

  // --- Critical Strike -------------------------------------------
  critical_strike: {
    onCapture(room, playerColor, capturedPiece, captureSquare) {
      // 50% chance to also capture a random adjacent enemy piece
      if (Math.random() < 0.5) {
        const board = getBoardFromRoom(room);
        const adjacent = getAdjacentSquares(captureSquare);
        const opponentColor = playerColor === 'w' ? 'b' : 'w';
        const enemyAdj = adjacent.filter(sq => {
          const piece = board.get(sq);
          return piece && piece.color === opponentColor && piece.type !== 'k';
        });
        if (enemyAdj.length > 0) {
          const target = randomFrom(enemyAdj);
          if (destroyPiece(room, board, target)) {
            syncChessFromBoard(room, board);
          }
        }
      }
    },
  },

  // --- Invulnerability Potion ------------------------------------
  invulnerability_potion: {
    onActivate(room, chooserColor) {
      const board = getBoardFromRoom(room);
      const friendlyNonKing = [];
      for (const [sq, piece] of board) {
        if (piece.color === chooserColor && piece.type !== 'k') {
          friendlyNonKing.push(sq);
        }
      }
      const count = Math.min(2, friendlyNonKing.length);
      const ms = room.mutatorState;
      const activeRule = ms.activeRules.find(ar => ar.rule.id === 'invulnerability_potion');
      const expiresAtMove = activeRule ? activeRule.expiresAtMove : ms.moveCount + 6;
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(Math.random() * friendlyNonKing.length);
        const sq = friendlyNonKing.splice(idx, 1)[0];
        ms.boardModifiers.invulnerable.push({
          square: sq,
          color: chooserColor,
          expiresAtMove,
        });
      }
    },
    getLegalMoveModifiers(room, playerColor) {
      const ms = room.mutatorState;
      const invulnerable = (ms.boardModifiers.invulnerable || [])
        .filter(iv => !iv.expiresAtMove || ms.moveCount < iv.expiresAtMove);
      if (invulnerable.length === 0) return null;
      const invulnerableSquares = new Set(invulnerable.map(iv => iv.square));
      // Can't capture pieces on invulnerable squares
      return (moves) => moves.filter(m => {
        if (m.captured && invulnerableSquares.has(m.to)) return false;
        return true;
      });
    },
    onAfterMove(room, playerColor, move) {
      // Track invulnerable pieces as they move
      const ms = room.mutatorState;
      for (const iv of ms.boardModifiers.invulnerable) {
        if (iv.square === move.from && iv.color === playerColor) {
          iv.square = move.to;
        }
      }
    },
    onExpire(room) {
      const ms = room.mutatorState;
      ms.boardModifiers.invulnerable = (ms.boardModifiers.invulnerable || [])
        .filter(iv => iv.expiresAtMove && ms.moveCount < iv.expiresAtMove);
    },
  },

  // --- Blood Sacrifice ------------------------------------------
  blood_sacrifice: {
    onTurnEnd(room) {
      const board = getBoardFromRoom(room);
      // The player who just moved sacrifices a random non-King piece
      const justMoved = room.chess.turn() === 'w' ? 'b' : 'w';
      const friendlyNonKing = [];
      for (const [sq, piece] of board) {
        if (piece.color === justMoved && piece.type !== 'k') {
          friendlyNonKing.push(sq);
        }
      }
      if (friendlyNonKing.length > 0) {
        const target = randomFrom(friendlyNonKing);
        if (destroyPiece(room, board, target)) {
          syncChessFromBoard(room, board);
        }
      }
    },
  },

  // --- Portal Storm ---------------------------------------------
  portal_storm: {
    onTurnEnd(room) {
      const board = getBoardFromRoom(room);
      const nonKings = [];
      for (const [sq, piece] of board) {
        if (piece.type !== 'k' && !isSquareHardBlocked(room, sq)) nonKings.push(sq);
      }
      if (nonKings.length >= 2) {
        const idx1 = Math.floor(Math.random() * nonKings.length);
        const sq1 = nonKings.splice(idx1, 1)[0];
        const sq2 = randomFrom(nonKings);
        safeSwapSquares(room, board, sq1, sq2);
        syncChessFromBoard(room, board);
      }
    },
  },

  // --- Portal 3 -------------------------------------------------
  portal_3: {
    onActivate(room, chooserColor, choiceData) {
      if (!choiceData) return;
      const ms = room.mutatorState;
      const sq1 = Array.isArray(choiceData) ? choiceData[0] : choiceData.square1;
      const sq2 = Array.isArray(choiceData) ? choiceData[1] : choiceData.square2;
      const activeRule = ms.activeRules.find(ar => ar.rule.id === 'portal_3');
      const expiresAtMove = activeRule ? activeRule.expiresAtMove : ms.moveCount + 9;
      ms.boardModifiers.portals.push({
        square1: sq1,
        square2: sq2,
        expiresAtMove,
      });
    },
    onTurnEnd(room) {
      const ms = room.mutatorState;
      const portals = (ms.boardModifiers.portals || [])
        .filter(p => !p.expiresAtMove || ms.moveCount < p.expiresAtMove);
      if (portals.length === 0) return;
      const board = getBoardFromRoom(room);
      for (const portal of portals) {
        safeSwapSquares(room, board, portal.square1, portal.square2);
      }
      syncChessFromBoard(room, board);
    },
    onExpire(room) {
      const ms = room.mutatorState;
      ms.boardModifiers.portals = (ms.boardModifiers.portals || [])
        .filter(p => p.expiresAtMove && ms.moveCount < p.expiresAtMove);
    },
  },

  // --- Religious Conversion -------------------------------------
  religious_conversion: {
    onAfterMove(room, playerColor, move) {
      const board = getBoardFromRoom(room);
      const piece = board.get(move.to);
      if (!piece || piece.type !== 'b') return; // Only bishops convert
      const adjacent = getAdjacentSquares(move.to);
      let converted = false;
      for (const sq of adjacent) {
        const adj = board.get(sq);
        if (adj && adj.type === 'p' && adj.color !== piece.color) {
          board.set(sq, { type: 'p', color: piece.color });
          converted = true;
        }
      }
      if (converted) {
        syncChessFromBoard(room, board);
      }
    },
  },

  // --- Living Bomb ----------------------------------------------
  living_bomb: {
    onActivate(room, chooserColor, choiceData) {
      if (!choiceData) return;
      const ms = room.mutatorState;
      const board = getBoardFromRoom(room);
      const piece = board.get(choiceData);
      const activeRule = ms.activeRules.find(ar => ar.rule.id === 'living_bomb');
      const expiresAtMove = activeRule ? activeRule.expiresAtMove : ms.moveCount + 9;
      ms.boardModifiers.livingBombs.push({
        square: choiceData,
        piece: piece ? piece.type : null,
        expiresAtMove,
      });
    },
    onAfterMove(room, playerColor, move) {
      // Track living bomb as its piece moves
      const ms = room.mutatorState;
      for (const lb of ms.boardModifiers.livingBombs) {
        if (lb.square === move.from) {
          lb.square = move.to;
        }
      }
    },
    onExpire(room) {
      const ms = room.mutatorState;
      const board = getBoardFromRoom(room);
      let changed = false;
      const remaining = [];
      for (const lb of ms.boardModifiers.livingBombs) {
        if (lb.expiresAtMove && ms.moveCount >= lb.expiresAtMove) {
          // Bomb explodes
          const piece = board.get(lb.square);
          if (piece) {
            const adjacent = getAdjacentSquares(lb.square);
            for (const sq of adjacent) {
              const adj = board.get(sq);
              if (adj && adj.type !== 'k') {
                if (destroyPiece(room, board, sq)) changed = true;
              }
            }
            // Bomb piece also dies
            if (piece.type !== 'k') {
              if (destroyPiece(room, board, lb.square)) changed = true;
            }
          }
        } else {
          remaining.push(lb);
        }
      }
      ms.boardModifiers.livingBombs = remaining;
      if (changed) syncChessFromBoard(room, board);
    },
  },

  // --- Mitosis --------------------------------------------------
  mitosis: {
    getLegalMoveModifiers(room, playerColor) {
      // The chosen piece cannot move while mitosis is active
      const ms = room.mutatorState;
      const activeRules = ms.activeRules.filter(ar => ar.rule.id === 'mitosis');
      if (activeRules.length === 0) return null;
      const frozenSquares = new Set(activeRules.map(ar => ar.choiceData));
      return (moves) => moves.filter(m => !frozenSquares.has(m.from));
    },
    onExpire(room, activeRule) {
      if (!activeRule || !activeRule.choiceData) return;
      const targetSquare = activeRule.choiceData;
      const board = getBoardFromRoom(room);
      const piece = board.get(targetSquare);
      if (piece && piece.type !== 'k') {
        // Spawn duplicate in an empty adjacent square (never duplicate kings)
        const adjacent = getAdjacentSquares(targetSquare);
        const emptyAdj = adjacent.filter(sq => !board.has(sq) && !isSquareHardBlocked(room, sq));
        if (emptyAdj.length > 0) {
          const sq = randomFrom(emptyAdj);
          safePlacePiece(room, board, sq, piece.type, piece.color);
          syncChessFromBoard(room, board);
        }
      }
    },
  },

  // --- Treasure Chest -------------------------------------------
  treasure_chest: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      const empty = getValidEmptySquares(room, board);
      if (empty.length > 0) {
        const sq = randomFrom(empty);
        const ms = room.mutatorState;
        ms.boardModifiers.treasureSquares.push({ square: sq, active: true });
      }
    },
    onAfterMove(room, playerColor, move) {
      const ms = room.mutatorState;
      for (const ts of ms.boardModifiers.treasureSquares) {
        if (ts.active && ts.square === move.to) {
          // Promote the piece that entered the treasure square
          const board = getBoardFromRoom(room);
          const piece = board.get(move.to);
          if (piece && piece.type !== 'k' && piece.type !== 'q') {
            board.set(move.to, { type: 'q', color: piece.color });
            syncChessFromBoard(room, board);
          }
          ts.active = false;
        }
      }
    },
    onExpire(room) {
      // Deactivate any uncollected treasure squares so the overlay clears
      const ms = room.mutatorState;
      for (const ts of ms.boardModifiers.treasureSquares) {
        ts.active = false;
      }
    },
  },

  // --- Summoning Ritual -----------------------------------------
  summoning_ritual: {
    onExpire(room) {
      const board = getBoardFromRoom(room);
      const corners = ['a1', 'h1', 'a8', 'h8'];
      let wCount = 0, bCount = 0;
      for (const sq of corners) {
        const piece = board.get(sq);
        if (piece) {
          if (piece.color === 'w') wCount++;
          else bCount++;
        }
      }
      if (wCount === bCount) return; // Tie, nobody wins
      const winner = wCount > bCount ? 'w' : 'b';
      const empty = getValidEmptySquares(room, board);
      if (empty.length > 0) {
        const sq = randomFrom(empty);
        safePlacePiece(room, board, sq, 'r', winner);
        syncChessFromBoard(room, board);
      }
    },
  },

  // --- Call Down Lightning ---------------------------------------
  call_down_lightning: {
    onActivate(room) {
      const board = getBoardFromRoom(room);
      const empty = getValidEmptySquares(room, board);
      if (empty.length > 0) {
        const sq = randomFrom(empty);
        const ms = room.mutatorState;
        const activeRule = ms.activeRules.find(ar => ar.rule.id === 'call_down_lightning');
        const expiresAtMove = activeRule ? activeRule.expiresAtMove : ms.moveCount + 9;
        ms.boardModifiers.deathSquares.push({ square: sq, expiresAtMove });
      }
    },
    onExpire(room) {
      const ms = room.mutatorState;
      const board = getBoardFromRoom(room);
      let changed = false;
      const remaining = [];
      for (const ds of ms.boardModifiers.deathSquares) {
        if (ds.expiresAtMove && ms.moveCount >= ds.expiresAtMove) {
          // Check who controls this square
          const piece = board.get(ds.square);
          if (piece) {
            // Controller is the piece's color. Kill a random enemy non-King.
            const enemyColor = piece.color === 'w' ? 'b' : 'w';
            const enemies = [];
            for (const [sq, p] of board) {
              if (p.color === enemyColor && p.type !== 'k') enemies.push(sq);
            }
            if (enemies.length > 0) {
              const target = randomFrom(enemies);
              if (destroyPiece(room, board, target)) changed = true;
            }
          }
        } else {
          remaining.push(ds);
        }
      }
      ms.boardModifiers.deathSquares = remaining;
      if (changed) syncChessFromBoard(room, board);
    },
  },

  // --- Get The Fuck Off -----------------------------------------
  get_the_fuck_off: {
    onActivate(room, chooserColor, choiceData) {
      if (!choiceData) return;
      const ms = room.mutatorState;
      const sq1 = Array.isArray(choiceData) ? choiceData[0] : choiceData.square1;
      const sq2 = Array.isArray(choiceData) ? choiceData[1] : choiceData.square2;
      const activeRule = ms.activeRules.find(ar => ar.rule.id === 'get_the_fuck_off');
      const expiresAtMove = activeRule ? activeRule.expiresAtMove : ms.moveCount + 9;
      if (sq1) ms.boardModifiers.deathSquares.push({ square: sq1, expiresAtMove });
      if (sq2) ms.boardModifiers.deathSquares.push({ square: sq2, expiresAtMove });
    },
    onExpire(room) {
      const ms = room.mutatorState;
      const board = getBoardFromRoom(room);
      let changed = false;
      const remaining = [];
      for (const ds of ms.boardModifiers.deathSquares) {
        if (ds.expiresAtMove && ms.moveCount >= ds.expiresAtMove) {
          const piece = board.get(ds.square);
          if (piece && piece.type !== 'k') {
            if (destroyPiece(room, board, ds.square)) changed = true;
          }
        } else {
          remaining.push(ds);
        }
      }
      ms.boardModifiers.deathSquares = remaining;
      if (changed) syncChessFromBoard(room, board);
    },
  },

  // --- Gigachad Aura --------------------------------------------
  gigachad_aura: {
    onExpire(room) {
      const board = getBoardFromRoom(room);
      let changed = false;
      // Kill all non-King pieces adjacent to any King
      for (const [sq, piece] of board) {
        if (piece.type === 'k') {
          const adjacent = getAdjacentSquares(sq);
          for (const adjSq of adjacent) {
            const adjPiece = board.get(adjSq);
            if (adjPiece && adjPiece.type !== 'k') {
              if (destroyPiece(room, board, adjSq)) changed = true;
            }
          }
        }
      }
      if (changed) syncChessFromBoard(room, board);
    },
  },

  // --- Time Bomb ------------------------------------------------
  time_bomb: {
    onExpire(room) {
      const board = getBoardFromRoom(room);
      let changed = false;
      for (const row of ROWS) {
        const sq = 'e' + row;
        const piece = board.get(sq);
        if (piece && piece.type !== 'k') {
          if (destroyPiece(room, board, sq)) changed = true;
        }
      }
      if (changed) syncChessFromBoard(room, board);
    },
  },

  // --- Parry ----------------------------------------------------
  parry: {
    // RPS logic is handled in moveHandler.js and server.js
  },

  // --- Duration Movement Modifiers ---------------------------------
  // These rules are handled in checkDetector.js, not here.
  // Stub entries for completeness:
  proletariat: {
    getLegalMoveModifiers(room, playerColor) {
      // All pieces move like pawns -- block all standard non-pawn moves
      return (moves) => {
        const pawnMoves = moves.filter(m => m.piece === 'p');
        // Non-pawn pieces use custom moves instead; return pawn moves only
        // Safety fallback: if no pawn moves exist, allow all (player has no pawns)
        return pawnMoves.length > 0 ? pawnMoves : moves;
      };
    },
  },
  short_stop: {
    getLegalMoveModifiers(room, playerColor) {
      return (moves) => moves.filter(m => {
        const dc = Math.abs(colIndex(m.to) - colIndex(m.from));
        const dr = Math.abs(rowIndex(m.to) - rowIndex(m.from));
        return dc <= 1 && dr <= 1;
      });
    },
  },
  pawns_with_viagra: {},
  trains_rights: {
    getLegalMoveModifiers(room, playerColor) {
      // Queens move like Kings (restrict to 1-square moves)
      return (moves) => moves.filter(m => {
        if (m.piece !== 'q') return true;
        const dc = Math.abs(colIndex(m.to) - colIndex(m.from));
        const dr = Math.abs(rowIndex(m.to) - rowIndex(m.from));
        return dc <= 1 && dr <= 1;
      });
    },
  },
  estrogen: {},
  ice_physics: {
    getLegalMoveModifiers(room, playerColor) {
      // Sliding pieces (bishop, rook, queen) must move maximum distance
      const SLIDING = new Set(['b', 'r', 'q']);
      return (moves) => {
        // Separate sliding and non-sliding moves
        const nonSliding = [];
        // Group sliding moves by "from + direction"
        const slidingByDir = new Map();
        for (const m of moves) {
          if (!SLIDING.has(m.piece)) {
            nonSliding.push(m);
            continue;
          }
          const dc = colIndex(m.to) - colIndex(m.from);
          const dr = rowIndex(m.to) - rowIndex(m.from);
          // Normalize to unit direction vector
          const dirC = dc === 0 ? 0 : (dc > 0 ? 1 : -1);
          const dirR = dr === 0 ? 0 : (dr > 0 ? 1 : -1);
          const key = `${m.from}:${dirC},${dirR}`;
          const dist = Math.max(Math.abs(dc), Math.abs(dr));
          const existing = slidingByDir.get(key);
          if (!existing || dist > existing.dist) {
            slidingByDir.set(key, { move: m, dist });
          }
        }
        // Return non-sliding moves + only the farthest move per direction
        return nonSliding.concat([...slidingByDir.values()].map(e => e.move));
      };
    },
  },
  pacman_style: {},
  god_kings: {
    getLegalMoveModifiers(room, playerColor) {
      const board = getBoardFromRoom(room);
      return (moves) => {
        // Kings are immune -- can't be captured, filter out moves that target a king
        const filtered = moves.filter(m => {
          const target = board.get(m.to);
          return !target || target.type !== 'k';
        });
        return filtered.length > 0 ? filtered : moves;
      };
    },
  },
  early_promotion: {
    onAfterMove(room, playerColor, move) {
      const board = getBoardFromRoom(room);
      const piece = board.get(move.to);
      if (!piece || piece.type !== 'p') return;
      const toRow = parseInt(move.to[1]);
      // White pawns promote at row 6, black at row 3
      const promotionRow = piece.color === 'w' ? 6 : 3;
      if (toRow === promotionRow) {
        board.set(move.to, { type: 'q', color: piece.color });
        syncChessFromBoard(room, board);
      }
    },
  },
  knee_surgery: {},
  pawns_learned_strength: {},
  cash_grab: {
    onAfterMove(room, playerColor, move) {
      const board = getBoardFromRoom(room);
      const piece = board.get(move.to);
      if (!piece || piece.type === 'k' || piece.type === 'q') return;
      // Skip pawns - chess.js already handles their back-line promotion
      if (piece.type === 'p') return;
      const toRow = parseInt(move.to[1]);
      // Any non-pawn piece reaching the opponent's back line promotes to queen
      const backLine = piece.color === 'w' ? 8 : 1;
      if (toRow === backLine) {
        board.set(move.to, { type: 'q', color: piece.color });
        syncChessFromBoard(room, board);
      }
    },
  },
};

/**
 * Get the hook object for a rule, or an empty object if not yet implemented.
 */
function getHooks(ruleId) {
  return hooks[ruleId] || {};
}

/**
 * Execute a hook for a rule if it exists.
 */
function executeHook(ruleId, hookName, ...args) {
  const ruleHooks = getHooks(ruleId);
  if (ruleHooks[hookName]) {
    return ruleHooks[hookName](...args);
  }
  return undefined;
}

/**
 * Generate wrap-around moves for Pacman Style.
 * Returns array of { from, to } for moves that wrap left/right edges.
 */
function getWrapMoves(room, playerColor) {
  const board = getBoardFromRoom(room);
  const wrapMoves = [];

  // Sliding directions that involve horizontal movement (can wrap left/right)
  const slideDirs = {
    r: [[0, 1], [0, -1]],                    // rook: horizontal only
    b: [[1, 1], [1, -1], [-1, 1], [-1, -1]], // bishop: diagonals
    q: [[0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]], // queen: both
  };

  // Knight offsets
  const knightOffsets = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];

  // King offsets (horizontal/diagonal, 1 step)
  const kingOffsets = [[0, -1], [0, 1], [1, -1], [1, 1], [-1, -1], [-1, 1]];

  for (const [square, piece] of board) {
    if (piece.color !== playerColor) continue;

    const col = colIndex(square);
    const row = rowIndex(square);

    // Sliding pieces (rook, bishop, queen)
    if (slideDirs[piece.type]) {
      for (const [dr, dc] of slideDirs[piece.type]) {
        // Slide from piece position toward the edge, then wrap
        let r = row;
        let c = col;
        // First, slide to the edge in the given direction (consuming normal squares)
        let blocked = false;
        while (true) {
          r += dr;
          c += dc;
          if (r < 0 || r > 7) { blocked = true; break; } // hit top/bottom, stop
          if (c < 0 || c > 7) break; // hit left/right edge -- this is where we wrap
          const sq = COLUMNS[c] + ROWS[r];
          const occupant = board.get(sq);
          if (occupant) {
            blocked = true;
            break; // blocked by a piece before reaching edge
          }
        }
        if (blocked || (c >= 0 && c <= 7)) continue; // didn't reach left/right edge

        // Wrap the column
        c = c < 0 ? c + 8 : c - 8;

        // Continue sliding from the wrapped position
        while (c >= 0 && c <= 7 && r >= 0 && r <= 7) {
          const wrapSq = COLUMNS[c] + ROWS[r];
          const occupant = board.get(wrapSq);
          if (occupant) {
            if (occupant.color !== playerColor) {
              wrapMoves.push({ from: square, to: wrapSq }); // capture
            }
            break; // blocked
          }
          wrapMoves.push({ from: square, to: wrapSq });
          r += dr;
          c += dc;
        }
      }
    }

    // Knight wrapping
    if (piece.type === 'n') {
      for (const [dr, dc] of knightOffsets) {
        const nr = row + dr;
        let nc = col + dc;
        if (nr < 0 || nr > 7) continue; // off top/bottom
        if (nc >= 0 && nc <= 7) continue; // normal move, not a wrap
        nc = nc < 0 ? nc + 8 : nc - 8;
        if (nc < 0 || nc > 7) continue;
        const wrapSq = COLUMNS[nc] + ROWS[nr];
        const occupant = board.get(wrapSq);
        if (occupant && occupant.color === playerColor) continue; // friendly
        wrapMoves.push({ from: square, to: wrapSq });
      }
    }

    // King wrapping (1 step horizontal/diagonal)
    if (piece.type === 'k') {
      for (const [dr, dc] of kingOffsets) {
        const nr = row + dr;
        let nc = col + dc;
        if (nr < 0 || nr > 7) continue;
        if (nc >= 0 && nc <= 7) continue; // normal move
        nc = nc < 0 ? nc + 8 : nc - 8;
        const wrapSq = COLUMNS[nc] + ROWS[nr];
        const occupant = board.get(wrapSq);
        if (occupant && occupant.color === playerColor) continue;
        wrapMoves.push({ from: square, to: wrapSq });
      }
    }

    // Pawn wrapping (diagonal captures only -- pawns don't move horizontally)
    if (piece.type === 'p') {
      const dir = piece.color === 'w' ? 1 : -1;
      for (const dc of [-1, 1]) {
        const nr = row + dir;
        let nc = col + dc;
        if (nr < 0 || nr > 7) continue;
        if (nc >= 0 && nc <= 7) continue; // normal
        nc = nc < 0 ? nc + 8 : nc - 8;
        const wrapSq = COLUMNS[nc] + ROWS[nr];
        const occupant = board.get(wrapSq);
        if (occupant && occupant.color !== playerColor) {
          wrapMoves.push({ from: square, to: wrapSq });
        }
      }
    }
  }

  return wrapMoves;
}

/**
 * Generate custom (non-standard) moves from movement-add mutators.
 * Returns array of { from, to } for moves chess.js doesn't know about.
 * Validates each move doesn't leave own king in check.
 */
function getCustomMoves(room, playerColor) {
  const ms = room.mutatorState;
  if (!ms || ms.activeRules.length === 0) return [];

  const { wouldLeaveKingInCheck, getSlidingAttacks } = require('./checkDetector');
  const board = getBoardFromRoom(room);
  const activeIds = new Set(ms.activeRules.map(ar => ar.rule.id));
  const customMoves = [];

  // Helper: add a move if the target is empty or has enemy piece, and doesn't leave king in check
  function tryAdd(from, to) {
    if (!to) return;
    const target = board.get(to);
    if (target && target.color === playerColor) return; // can't capture own piece
    if (wouldLeaveKingInCheck(board, from, to, playerColor, ms)) return;
    // Don't duplicate moves chess.js already handles
    customMoves.push({ from, to });
  }

  // --- Proletariat: All non-pawn pieces move like pawns ---
  if (activeIds.has('proletariat')) {
    const dir = forwardDir(playerColor);
    for (const [sq, piece] of board) {
      if (piece.color !== playerColor || piece.type === 'p') continue;
      // Forward 1 (if empty)
      const ahead = offsetSquare(sq, 0, dir);
      if (ahead && !board.has(ahead)) {
        tryAdd(sq, ahead);
      }
      // Diagonal captures (forward-left, forward-right)
      const diagLeft = offsetSquare(sq, -1, dir);
      const diagRight = offsetSquare(sq, 1, dir);
      if (diagLeft) {
        const t = board.get(diagLeft);
        if (t && t.color !== playerColor) tryAdd(sq, diagLeft);
      }
      if (diagRight) {
        const t = board.get(diagRight);
        if (t && t.color !== playerColor) tryAdd(sq, diagRight);
      }
    }
  }

  // --- Short Stop: Knights get orthogonal 1-square moves ---
  if (activeIds.has('short_stop')) {
    for (const [sq, piece] of board) {
      if (piece.color !== playerColor || piece.type !== 'n') continue;
      for (const [dc, dr] of [[0,1],[0,-1],[1,0],[-1,0]]) {
        const to = offsetSquare(sq, dc, dr);
        if (to) tryAdd(sq, to);
      }
    }
  }

  // --- Estrogen: Kings slide like Queens (in addition to normal 1-square) ---
  if (activeIds.has('estrogen')) {
    for (const [sq, piece] of board) {
      if (piece.color !== playerColor || piece.type !== 'k') continue;
      const dirs = [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for (const [dc, dr] of dirs) {
        let current = sq;
        while (true) {
          current = offsetSquare(current, dc, dr);
          if (!current) break;
          const occupant = board.get(current);
          if (occupant && occupant.color === playerColor) break;
          // Only add if distance > 1 (chess.js already has 1-square king moves)
          const dist = Math.max(Math.abs(colIndex(current) - colIndex(sq)), Math.abs(rowIndex(current) - rowIndex(sq)));
          if (dist > 1) tryAdd(sq, current);
          if (occupant) break; // can capture but can't slide further
        }
      }
    }
  }

  // --- Trains Rights: Kings slide like Queens, Queens move like Kings ---
  if (activeIds.has('trains_rights')) {
    for (const [sq, piece] of board) {
      if (piece.color !== playerColor) continue;
      if (piece.type === 'k') {
        // King gets queen-like sliding (distance > 1 only)
        const dirs = [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
        for (const [dc, dr] of dirs) {
          let current = sq;
          while (true) {
            current = offsetSquare(current, dc, dr);
            if (!current) break;
            const occupant = board.get(current);
            if (occupant && occupant.color === playerColor) break;
            const dist = Math.max(Math.abs(colIndex(current) - colIndex(sq)), Math.abs(rowIndex(current) - rowIndex(sq)));
            if (dist > 1) tryAdd(sq, current);
            if (occupant) break;
          }
        }
      }
      // Queen restriction to 1-square is handled via getLegalMoveModifiers
    }
  }

  // --- God Kings / Knee Surgery: Kings can move 2 squares in any direction ---
  if (activeIds.has('god_kings') || activeIds.has('knee_surgery')) {
    for (const [sq, piece] of board) {
      if (piece.color !== playerColor || piece.type !== 'k') continue;
      for (let dc = -2; dc <= 2; dc++) {
        for (let dr = -2; dr <= 2; dr++) {
          if (dc === 0 && dr === 0) continue;
          // Only distance-2 moves (chess.js handles distance-1)
          if (Math.abs(dc) <= 1 && Math.abs(dr) <= 1) continue;
          const target = offsetSquare(sq, dc, dr);
          tryAdd(sq, target);
        }
      }
    }
  }

  // --- Pawns with Viagra: Pawns can capture sideways (left and right) ---
  if (activeIds.has('pawns_with_viagra')) {
    for (const [sq, piece] of board) {
      if (piece.color !== playerColor || piece.type !== 'p') continue;
      const left = offsetSquare(sq, -1, 0);
      const right = offsetSquare(sq, 1, 0);
      // Sideways capture only (must have enemy piece there)
      if (left) {
        const t = board.get(left);
        if (t && t.color !== playerColor) tryAdd(sq, left);
      }
      if (right) {
        const t = board.get(right);
        if (t && t.color !== playerColor) tryAdd(sq, right);
      }
    }
  }

  // --- Pawns Learned Strength: Pawns can push ANY piece forward ---
  // Pawn moves into an occupied square (any color) as a MOVE, not capture.
  // The occupant is pushed 1 square forward; chain reactions propagate.
  // If the chain reaches the board edge, the last piece is removed.
  if (activeIds.has('pawns_learned_strength')) {
    const dir = forwardDir(playerColor);
    for (const [sq, piece] of board) {
      if (piece.color !== playerColor || piece.type !== 'p') continue;
      const ahead = offsetSquare(sq, 0, dir);
      if (!ahead) continue;
      const occupant = board.get(ahead);
      if (!occupant) continue; // normal pawn move, chess.js handles it
      // Always valid -- chain either shifts into empty space or last piece falls off
      tryAdd(sq, ahead);
    }
  }

  return customMoves;
}

module.exports = {
  hooks,
  getHooks,
  executeHook,
  getBoardFromRoom,
  syncChessFromBoard,
  getWrapMoves,
  getCustomMoves,
  destroyPiece,
  riskItRookPlaceRooks,
  triggerSoftRestrictions,
  safeMovePiece,
  safePlacePiece,
  safeSwapSquares,
};
