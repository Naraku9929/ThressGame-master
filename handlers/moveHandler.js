const { validateSquare, validatePromotion } = require('../utils/validation');
const { serializeBoardForClient, getPublicPlayer } = require('../gameController');
const { scheduleRoomDeletion, emitGameEnded, checkKingDestroyed, checkMutatorDeadlock, triggerCoinFlip, checkCoinFlipSkipTurn } = require('../utils/gameLifecycle');
const { activateRule } = require('../mutators/mutatorEngine');
const { generateBotTarget } = require('../botManager');

const {
  shouldTriggerChoice, generateRuleOptions, checkExpiredRules,
  incrementMoveCount, serializeMutatorState, isRuleActive,
  removePersistentRule,
} = require('../mutators/mutatorEngine');
const { executeHook, getHooks, getWrapMoves, getCustomMoves, getBoardFromRoom, syncChessFromBoard, triggerSoftRestrictions, destroyPiece } = require('../mutators/ruleHooks');
const { isKingInCheck } = require('../mutators/checkDetector');
const { fenToBoard, offsetSquare, isSquareHardBlocked, findNearestValidSquare, getIntermediateSquares } = require('../mutators/boardUtils');

/**
 * End-of-game condition descriptors. Order matters -- checkmate before general isDraw.
 */
const END_CONDITIONS = [
  { check: c => c.isCheckmate(),          reason: 'checkmate',             hasWinner: true },
  { check: c => c.isStalemate(),          reason: 'stalemate',             hasWinner: false },
  { check: c => c.isInsufficientMaterial(), reason: 'insufficient-material', hasWinner: false },
  { check: c => c.isThreefoldRepetition(), reason: 'threefold-repetition',  hasWinner: false },
  { check: c => c.isDraw(),               reason: 'draw',                  hasWinner: false },
];

/**
 * Check all end-of-game conditions and handle accordingly.
 * Returns true if the game ended, false otherwise.
 */
async function checkGameEnd(room, io, gameManager, movingPlayer) {
  const chess = room.chess;

  for (const condition of END_CONDITIONS) {
    if (!condition.check(chess)) continue;

    const winner = condition.hasWinner ? movingPlayer.color : null;
    room.endGame(condition.reason, winner);

    emitGameEnded(io, room, condition.reason, winner);
    scheduleRoomDeletion(gameManager, room.roomCode);
    return true;
  }

  return false;
}

/**
 * Handle a player attempting to make a move.
 *
 * @param {Object} io - Socket.IO server instance
 * @param {Object} socket - The player's socket
 * @param {Object} gameManager - GameManager instance
 * @param {Object} data - Move data: {from, to, promotion?}
 */
async function handleMove(io, socket, gameManager, data) {
  const { from, to, promotion } = data || {};

  // Validate square notation
  if (!validateSquare(from) || !validateSquare(to)) {
    socket.emit('moveRejected', { error: 'Invalid square notation.' });
    return;
  }

  // Find room and player from socket
  const room = gameManager.getRoomForSocket(socket.id);
  if (!room) {
    socket.emit('moveRejected', { error: 'You are not in a room.' });
    return;
  }

  const player = room.getPlayerBySocket(socket.id);
  if (!player) {
    socket.emit('moveRejected', { error: 'Player not found in room.' });
    return;
  }

  // Game must be active
  if (room.status !== 'active') {
    socket.emit('moveRejected', { error: 'Game is not active.' });
    return;
  }

  // Standard turn enforcement via chess.js -- no _turn hack
  const currentTurn = room.chess.turn();
  if (currentTurn !== player.color) {
    socket.emit('moveRejected', { error: 'It is not your turn.' });
    return;
  }

  // Verify the piece at 'from' belongs to the player
  const pieceAtFrom = room.chess.get(from);
  if (!pieceAtFrom) {
    socket.emit('moveRejected', { error: 'No piece on that square.' });
    return;
  }
  if (pieceAtFrom.color !== player.color) {
    socket.emit('moveRejected', { error: 'That piece does not belong to you.' });
    return;
  }

  // Block moves if a mutator choice is pending for this player
  if (room.mutatorState && room.mutatorState.pendingChoice) {
    if (room.mutatorState.pendingChoice.chooser === player.color) {
      socket.emit('moveRejected', { message: 'Choose a rule before making your move.' });
      return;
    }
  }
  if (room.mutatorState && (room.mutatorState.pendingAction || room.mutatorState.pendingSecondAction)) {
    socket.emit('moveRejected', { message: 'Complete the rule selection first.' });
    return;
  }
  if (room.mutatorState && room.mutatorState.pendingRPS) {
    socket.emit('moveRejected', { message: 'Waiting for RPS resolution.' });
    return;
  }
  if (room.mutatorState && room.mutatorState.pendingCoinFlip) {
    if (room.mutatorState.pendingCoinFlip.forPlayer === player.color) {
      socket.emit('moveRejected', { message: 'Flip the coin first!' });
      return;
    }
  }

  // Handle promotion
  const chosenPromotion = validatePromotion(pieceAtFrom, to, promotion);

  // --- Mutator Restriction Check --------------------------------
  if (room.mutatorState && room.mutatorState.activeRules.length > 0) {
    const ms = room.mutatorState;
    const restrictionRules = ms.activeRules.filter(ar => {
      const ruleHooks = getHooks(ar.rule.id);
      return ruleHooks.getLegalMoveModifiers;
    });

    if (restrictionRules.length > 0) {
      let legalMoves = room.chess.moves({ verbose: true });

      for (const ar of restrictionRules) {
        const ruleHooks = getHooks(ar.rule.id);
        const filterFn = ruleHooks.getLegalMoveModifiers(room, player.color);
        if (filterFn) {
          const filtered = filterFn(legalMoves);
          if (filtered.length > 0) {
            legalMoves = filtered;
          }
          // If filtered is empty, skip this filter (safety fallback)
        }
      }

      const moveAllowed = legalMoves.some(m => m.from === from && m.to === to);
      if (!moveAllowed) {
        socket.emit('moveRejected', { error: 'Move blocked by active rule.' });
        return;
      }
    }
  }

  // --- Parry RPS Check ----------------------------------------
  if (room.mutatorState && isRuleActive(room.mutatorState, 'parry')) {
    const targetPiece = room.chess.get(to);
    if (targetPiece && targetPiece.color !== player.color && !room.mutatorState.rpsResolved) {
      // This is a capture while Parry is active -- trigger RPS
      const opponentColor = player.color === 'w' ? 'b' : 'w';
      room.mutatorState.pendingRPS = {
        move: { from, to, promotion: chosenPromotion },
        attacker: player.color,
        defender: opponentColor,
        attackerChoice: null,
        defenderChoice: null,
      };
      io.to(room.roomCode).emit('rpsPrompt', {
        attacker: player.color,
        defender: opponentColor,
      });
      return;
    }
    if (room.mutatorState.rpsResolved) {
      room.mutatorState.rpsResolved = false;
    }
  }

  // --- Custom Move Check (Pacman wrap + movement-add mutators) -----
  let isBoardMove = false;
  if (room.mutatorState) {
    // Check Pacman wrap moves
    if (isRuleActive(room.mutatorState, 'pacman_style')) {
      const wrapMoves = getWrapMoves(room, player.color);
      if (wrapMoves.find(m => m.from === from && m.to === to)) {
        isBoardMove = true;
      }
    }
    // Check movement-add custom moves (estrogen, god_kings, etc.)
    if (!isBoardMove) {
      const customMoves = getCustomMoves(room, player.color);
      if (customMoves.find(m => m.from === from && m.to === to)) {
        isBoardMove = true;
      }
    }
  }

  let moveResult;
  if (isBoardMove) {
    // Execute via board manipulation (chess.js can't handle these moves)
    const board = getBoardFromRoom(room);
    const movingPiece = board.get(from);
    const capturedPiece = board.get(to);

    // Special handling for Pawns Learned Strength (push chain)
    if (room.mutatorState && isRuleActive(room.mutatorState, 'pawns_learned_strength')
        && movingPiece && movingPiece.type === 'p' && board.get(to)) {
      const dir = movingPiece.color === 'w' ? 1 : -1;
      // Collect the chain of pieces from 'to' forward
      const chain = [];
      let chainSq = to;
      while (chainSq && board.get(chainSq)) {
        chain.push({ sq: chainSq, piece: board.get(chainSq) });
        chainSq = offsetSquare(chainSq, 0, dir);
      }
      // Shift chain: move pieces backward (from end) to avoid overwrite
      // If chainSq is null, the last piece in the chain falls off the board
      for (let i = chain.length - 1; i >= 0; i--) {
        let target = offsetSquare(chain[i].sq, 0, dir);
        board.delete(chain[i].sq);

        // Hard-blocked: redirect to nearest valid square
        if (target && isSquareHardBlocked(room, target)) {
          target = findNearestValidSquare(room, board, target, chain[i].sq);
        }

        if (target) {
          board.set(target, chain[i].piece);
          // Trigger soft restrictions (mines, pits) at destination
          triggerSoftRestrictions(room, board, target);
        }
        // If target is null, piece falls off the board or no valid square (removed)
      }
      board.delete(from);
      board.set(to, movingPiece);
    } else {
      board.delete(from);
      board.set(to, movingPiece);
    }

    // Switch turn by loading the new FEN with flipped turn
    const parts = room.chess.fen().split(' ');
    const newTurn = parts[1] === 'w' ? 'b' : 'w';
    const isCapture = !!capturedPiece;
    const isPawnMove = movingPiece && movingPiece.type === 'p';
    const halfMove = (isCapture || isPawnMove) ? 0 : parseInt(parts[4]) + 1;
    const fullMove = parts[1] === 'b' ? parseInt(parts[5]) + 1 : parseInt(parts[5]);

    // Strip castling rights when king or rook moves via custom/wrap move
    let castlingRights = parts[2];
    if (movingPiece) {
      if (movingPiece.type === 'k') {
        castlingRights = player.color === 'w'
          ? castlingRights.replace('K', '').replace('Q', '')
          : castlingRights.replace('k', '').replace('q', '');
      } else if (movingPiece.type === 'r') {
        if (from === 'a1') castlingRights = castlingRights.replace('Q', '');
        else if (from === 'h1') castlingRights = castlingRights.replace('K', '');
        else if (from === 'a8') castlingRights = castlingRights.replace('q', '');
        else if (from === 'h8') castlingRights = castlingRights.replace('k', '');
      }
    }
    if (castlingRights === '') castlingRights = '-';

    syncChessFromBoard(room, board);
    // Reload with correct turn, castling, and move counters
    const fenParts = room.chess.fen().split(' ');
    const correctedFen = fenParts[0] + ' ' + newTurn + ' ' + castlingRights + ' - ' + halfMove + ' ' + fullMove;
    room.chess.load(correctedFen, { skipValidation: true });

    moveResult = {
      from,
      to,
      san: (movingPiece.type !== 'p' ? movingPiece.type.toUpperCase() : '') + (capturedPiece ? 'x' : '') + to,
      color: player.color,
      piece: movingPiece.type,
      captured: capturedPiece ? capturedPiece.type : null,
      flags: capturedPiece ? 'c' : 'n',
      promotion: null,
    };
  } else {
    // Attempt the move via chess.js (legal move validation is built in)
    try {
      moveResult = room.chess.move({
        from,
        to,
        promotion: chosenPromotion,
      });
    } catch (err) {
      console.error('[moveHandler] chess.js move error:', err.message);
      moveResult = null;
    }

    if (!moveResult) {
      socket.emit('moveRejected', { error: 'Illegal move.' });
      return;
    }
  }

  // --- Path trap interception (mines, bottomless pits) ---
  // Check BEFORE broadcasting so the client never sees a piece arrive then vanish.
  if (room.mutatorState) {
    const ms = room.mutatorState;
    const path = getIntermediateSquares(moveResult.from, moveResult.to);
    if (path.length > 0) {
      // Find the first trap along the path
      let trapSquare = null;
      let trapType = null; // 'mine' | 'pit'
      let trapIndex = -1;

      for (const sq of path) {
        if (ms.boardModifiers.mines && ms.boardModifiers.mines.length > 0) {
          const idx = ms.boardModifiers.mines.findIndex(m => m.square === sq);
          if (idx !== -1) {
            trapSquare = sq;
            trapType = 'mine';
            trapIndex = idx;
            break;
          }
        }
        if (ms.boardModifiers.bottomlessPits) {
          if (ms.boardModifiers.bottomlessPits.find(p => p.square === sq)) {
            trapSquare = sq;
            trapType = 'pit';
            break;
          }
        }
      }

      if (trapSquare) {
        const board = getBoardFromRoom(room);
        const piece = board.get(moveResult.to);
        if (piece && piece.type !== 'k') {
          // Move piece from destination to the trap square
          board.delete(moveResult.to);
          board.set(trapSquare, piece);
          // Restore captured piece if the move was a capture
          if (moveResult.captured) {
            const capturedColor = moveResult.color === 'w' ? 'b' : 'w';
            board.set(moveResult.to, { type: moveResult.captured, color: capturedColor });
          }
          // Destroy the piece at the trap square
          destroyPiece(room, board, trapSquare);
          syncChessFromBoard(room, board);

          // Consume the mine if it was a mine
          if (trapType === 'mine') {
            ms.boardModifiers.mines.splice(trapIndex, 1);
            if (ms.boardModifiers.mines.length === 0) {
              removePersistentRule(ms, 'minefield');
            }
          }

          // Rewrite moveResult so the broadcast reflects the corrected state
          moveResult.to = trapSquare;
          moveResult.captured = null;
          moveResult.flags = 'n';
          moveResult.san = (piece.type !== 'p' ? piece.type.toUpperCase() : '') + trapSquare;
        }
      }
    }
  }

  // Record move in history
  room.moveHistory.push({
    from: moveResult.from,
    to: moveResult.to,
    san: moveResult.san,
    color: moveResult.color,
    captured: moveResult.captured || null,
    flags: moveResult.flags,
    piece: moveResult.piece,
    promotion: moveResult.promotion || null,
  });

  // Broadcast the applied move to the room
  io.to(room.roomCode).emit('moveApplied', {
    from: moveResult.from,
    to: moveResult.to,
    san: moveResult.san,
    color: moveResult.color,
    piece: moveResult.piece,
    captured: moveResult.captured || null,
    flags: moveResult.flags,
    promotion: moveResult.promotion || null,
    board: serializeBoardForClient(room.chess),
    capturedPieces: room.getCapturedPieces(),
    moveHistory: room.moveHistory,
    white: getPublicPlayer(room.white),
    black: getPublicPlayer(room.black),
  });

  // Check end-of-game conditions
  const gameEnded = await checkGameEnd(room, io, gameManager, player);
  if (gameEnded) return;

  // --- Mutator Post-Move Logic ----------------------------------
  if (room.mutatorState) {
    const ms = room.mutatorState;
    const playerColor = player.color;
    const captured = moveResult.captured || null;

    // Fire onAfterMove hooks for all active rules
    for (const ar of ms.activeRules) {
      executeHook(ar.rule.id, 'onAfterMove', room, playerColor, { from: moveResult.from, to: moveResult.to }, captured);
    }

    // Fire onCapture hooks if a piece was captured
    if (captured) {
      for (const ar of ms.activeRules) {
        executeHook(ar.rule.id, 'onCapture', room, playerColor, captured, moveResult.to);
      }
    }

    // Fire onTurnEnd hooks
    for (const ar of ms.activeRules) {
      executeHook(ar.rule.id, 'onTurnEnd', room);
    }

    // Check if a king was destroyed by mutator effects
    if (checkKingDestroyed(room, io, gameManager)) return;

    // Increment move count
    incrementMoveCount(ms);

    // Check for expired rules
    const expired = checkExpiredRules(ms);
    for (const ar of expired) {
      executeHook(ar.rule.id, 'onExpire', room, ar);
      io.to(room.roomCode).emit('mutatorExpired', {
        ruleId: ar.rule.id,
        name: ar.rule.name,
        description: ar.rule.description || '',
        fen: room.chess.fen(),
        mutatorState: serializeMutatorState(ms),
      });
    }

    // --- Coin Flip for All on Red ---------------------------------
    if (isRuleActive(ms, 'all_on_red')) {
      const nextTurn = room.chess.turn();
      triggerCoinFlip(room, io, nextTurn);
      // If tails and king has no moves, skip turn automatically
      if (!room.manualCoinFlip) {
        checkCoinFlipSkipTurn(room, io, nextTurn);
      }
    }

    // Check if mutator restrictions leave the next player with no legal moves
    if (checkMutatorDeadlock(room, io, gameManager)) return;

    // Check if next player needs to choose a rule
    if (shouldTriggerChoice(ms)) {
      const nextTurn = room.chess.turn();
      const options = generateRuleOptions(ms, room.disabledMutators || []);
      if (options.length === 0) {
        // No eligible rules -- skip mutator choice entirely
      } else {
        ms.pendingChoice = { options, chooser: nextTurn };

        io.to(room.roomCode).emit('mutatorChoice', {
          options: options.map(r => ({
            id: r.id,
            name: r.name,
            description: r.description,
            flavor: r.flavor,
            duration: r.duration,
          })),
          chooser: nextTurn,
        });

        // Bot auto-selects if it's the bot's turn (with humanizing delay)
        const nextPlayer = room.getPlayer(nextTurn);
        if (nextPlayer && nextPlayer.isBot) {
          const botThinkDelay = 3000 + Math.random() * 2000; // 3-5s
          setTimeout(() => {
            // Guard: room may have ended during delay
            if (room.status !== 'active' || !ms.pendingChoice) return;
            try {
              const randomRule = options[Math.floor(Math.random() * options.length)];
              ms.pendingChoice = null;

              // Broadcast selection highlight to both clients
              io.to(room.roomCode).emit('mutatorSelected', { ruleId: randomRule.id });

              // Tell clients the bot chose
              io.to(room.roomCode).emit('mutatorChosen', {
                rule: { id: randomRule.id, name: randomRule.name, description: randomRule.description, duration: randomRule.duration },
                chooser: nextTurn,
                requiresAction: false,
              });

              // Check if rule requires a target choice
              if (randomRule.requiresChoice) {
                ms.pendingAction = {
                  ruleId: randomRule.id,
                  actionType: randomRule.choiceType,
                  forPlayer: nextTurn,
                  rule: randomRule,
                };
                // Bot auto-selects target (with its own delay via botAutoMutatorResponse)
                const target = generateBotTarget(room, nextTurn, randomRule.choiceType);
                if (target !== null) {
                  // Check if rule also needs a second player's choice
                  if (randomRule.secondPlayerChoice) {
                    const opponentColor = nextTurn === 'w' ? 'b' : 'w';
                    const opponent = room.getPlayer(opponentColor);
                    ms.pendingSecondAction = {
                      ruleId: randomRule.id,
                      actionType: randomRule.secondChoiceType,
                      forPlayer: opponentColor,
                      firstChoiceData: target,
                      rule: randomRule,
                    };
                    ms.pendingAction = null;
                    if (opponent && opponent.isBot) {
                      const target2 = generateBotTarget(room, opponentColor, randomRule.secondChoiceType);
                      activateRule(ms, randomRule.id, nextTurn, target, target2);
                      executeHook(randomRule.id, 'onActivate', room, nextTurn, target, target2);
                      ms.pendingSecondAction = null;
                    } else if (opponent) {
                      // Human needs to pick -- emit prompt
                      const oppSocket = io.sockets.sockets.get(opponent.socketId);
                      if (oppSocket) {
                        oppSocket.emit('mutatorAction', {
                          ruleId: randomRule.id,
                          actionType: randomRule.secondChoiceType,
                          prompt: `Select target for ${randomRule.name}`,
                          forPlayer: opponentColor,
                        });
                      }
                      // Don't activate yet -- wait for human response
                      return;
                    }
                  } else {
                    // Single choice, activate directly
                    activateRule(ms, randomRule.id, nextTurn, target);
                    executeHook(randomRule.id, 'onActivate', room, nextTurn, target);
                    ms.pendingAction = null;
                  }
                } else {
                  // Target generation failed, activate without data
                  activateRule(ms, randomRule.id, nextTurn);
                  executeHook(randomRule.id, 'onActivate', room, nextTurn);
                  ms.pendingAction = null;
                }
              } else {
                // No choice needed -- instant activation
                activateRule(ms, randomRule.id, nextTurn);
                executeHook(randomRule.id, 'onActivate', room, nextTurn);
              }

              io.to(room.roomCode).emit('mutatorActivated', {
                rule: { id: randomRule.id, name: randomRule.name, description: randomRule.description, duration: randomRule.duration },
                chooser: nextTurn,
                fen: room.chess.fen(),
                mutatorState: serializeMutatorState(ms),
              });
            } catch (err) {
              console.error('[moveHandler] Bot auto-select mutator failed:', err);
              // Clear pending state to unblock the game
              ms.pendingChoice = null;
              ms.pendingAction = null;
              io.to(room.roomCode).emit('mutatorActivated', {
                rule: { id: 'error', name: 'Rule skipped', description: 'Bot selection failed' },
                chooser: nextTurn,
                fen: room.chess.fen(),
                mutatorState: serializeMutatorState(ms),
              });
            }
          }, botThinkDelay);
        }
      }
    }

    // Broadcast updated mutator state
    io.to(room.roomCode).emit('mutatorBoardUpdate', {
      fen: room.chess.fen(),
      mutatorState: serializeMutatorState(ms),
    });
  }
}

module.exports = { handleMove };
