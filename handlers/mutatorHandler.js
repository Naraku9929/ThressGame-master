'use strict';

const { resolveRPS, VALID_RPS_CHOICES } = require('../utils/rps');
const { validateSquare } = require('../utils/validation');
const {
  activateRule, serializeMutatorState, isRuleActive,
} = require('../mutators/mutatorEngine');
const { executeHook, riskItRookPlaceRooks } = require('../mutators/ruleHooks');
const { serializeBoardForClient, getPublicPlayer } = require('../gameController');
const { isKingInCheck } = require('../mutators/checkDetector');
const { COLUMNS, ROWS, fenToBoard, isSquareHardBlocked } = require('../mutators/boardUtils');
const { checkKingDestroyed, checkMutatorDeadlock, checkParryDeadlock, triggerCoinFlip, checkCoinFlipSkipTurn } = require('../utils/gameLifecycle');

/**
 * Create mutator handler functions with injected dependencies.
 * Uses a factory to avoid circular imports between handlers.
 *
 * @param {Object} deps
 * @param {Function} deps.handleMove - moveHandler.handleMove
 * @param {Function} deps.scheduleBotMove - botManager.scheduleBotMove
 * @param {Function} deps.generateBotTarget - botManager.generateBotTarget
 * @returns {{ botAutoMutatorResponse: Function, registerSocketHandlers: Function }}
 */
function createMutatorHandlers({ handleMove, scheduleBotMove, generateBotTarget }) {

  /**
   * Resolve an RPS result once both choices are in.
   */
  async function resolveRPSResult(room, io, gameManager, ms, rps, handleMove, scheduleBotMove, botAutoMutatorResponse) {
    const outcome = resolveRPS(rps.attackerChoice, rps.defenderChoice);
    const captureProceeds = outcome !== 'defender';

    io.to(room.roomCode).emit('rpsResult', {
      attacker: rps.attacker,
      defender: rps.defender,
      attackerChoice: rps.attackerChoice,
      defenderChoice: rps.defenderChoice,
      outcome,
      captureProceeds,
    });

    if (captureProceeds) {
      ms.rpsResolved = true;
      const pendingMove = rps.move;
      ms.pendingRPS = null;

      const attackerPlayer = room.getPlayer(rps.attacker);
      if (attackerPlayer) {
        const attackerSocket = attackerPlayer.isBot
          ? { id: attackerPlayer.socketId, emit: () => {} }
          : io.sockets.sockets.get(attackerPlayer.socketId);
        if (attackerSocket) {
          await handleMove(io, attackerSocket, gameManager, pendingMove);
          if (room.status === 'active') {
            scheduleBotMove(room, io, gameManager, handleMove, botAutoMutatorResponse);
          }
        }
      }
    } else {
      ms.pendingRPS = null;

      // Parry blocked the attack -- attacker loses their turn
      const fen = room.chess.fen();
      const parts = fen.split(' ');
      parts[1] = parts[1] === 'w' ? 'b' : 'w';
      room.chess.load(parts.join(' '), { skipValidation: true });

      io.to(room.roomCode).emit('moveApplied', {
        from: null, to: null, san: '(blocked)', color: rps.attacker,
        piece: null, captured: null, flags: '', promotion: null,
        board: serializeBoardForClient(room.chess),
        skipTurn: true,
        skipMessage: 'Parry! Capture was blocked -- turn lost!',
        moveHistory: room.moveHistory,
        white: getPublicPlayer(room.white),
        black: getPublicPlayer(room.black),
      });

      // Schedule bot move if opponent is bot
      if (room.status === 'active') {
        scheduleBotMove(room, io, gameManager, handleMove, botAutoMutatorResponse);
      }
    }
  }

  /**
   * Handle bot auto-responses for mutator actions and RPS.
   */
  function botAutoMutatorResponse(room, io, gameManager) {
    const ms = room.mutatorState;
    if (!ms) return;

    // Bot auto-responds to target selection
    if (ms.pendingAction && ms.pendingAction.forPlayer) {
      const player = room.getPlayer(ms.pendingAction.forPlayer);
      if (player && player.isBot) {
        const target = generateBotTarget(room, player.color, ms.pendingAction.actionType);
        if (target !== null) {
          const ruleId = ms.pendingAction.ruleId;
          const rule = ms.pendingAction.rule;

          if (rule.secondPlayerChoice && !ms.pendingSecondAction) {
            const opponentColor = player.color === 'w' ? 'b' : 'w';
            ms.pendingSecondAction = {
              ruleId,
              actionType: rule.secondChoiceType,
              forPlayer: opponentColor,
              firstChoiceData: target,
              rule,
            };
            ms.pendingAction = null;

            const opponent = room.getPlayer(opponentColor);
            if (opponent && opponent.isBot) {
              setTimeout(() => botAutoMutatorResponse(room, io, gameManager), 1200 + Math.random() * 600);
            } else if (opponent && !opponent.isBot) {
              const oppSocket = io.sockets.sockets.get(opponent.socketId);
              if (oppSocket) {
                oppSocket.emit('mutatorAction', {
                  ruleId,
                  actionType: rule.secondChoiceType,
                  prompt: `Select target for ${rule.name}`,
                  forPlayer: opponentColor,
                });
              }
            }
            return;
          }

          // Final activation
          const choiceData = ms.pendingSecondAction
            ? ms.pendingSecondAction.firstChoiceData
            : target;
          const secondChoiceData = ms.pendingSecondAction ? target : null;

          activateRule(ms, ruleId, ms.pendingAction.forPlayer, choiceData, secondChoiceData, rule.duration);
          executeHook(ruleId, 'onActivate', room, ms.pendingAction.forPlayer, choiceData, secondChoiceData);

          ms.pendingAction = null;
          ms.pendingSecondAction = null;

          const botPayload1 = {
            rule: { id: rule.id, name: rule.name, description: rule.description, duration: rule.duration },
            chooser: player.color,
            fen: room.chess.fen(),
            mutatorState: serializeMutatorState(ms),
          };
          if (room._riskItRookResult) {
            botPayload1.riskItRookFlip = room._riskItRookResult;
            delete room._riskItRookResult;
          }
          io.to(room.roomCode).emit('mutatorActivated', botPayload1);
          checkKingDestroyed(room, io, gameManager);
          checkMutatorDeadlock(room, io, gameManager);
          if (room.status === 'active') scheduleBotMove(room, io, gameManager, handleMove, botAutoMutatorResponse);
        }
      }
    }

    // Bot auto-responds to pending second action
    if (ms.pendingSecondAction && ms.pendingSecondAction.forPlayer) {
      const player = room.getPlayer(ms.pendingSecondAction.forPlayer);
      if (player && player.isBot) {
        const target = generateBotTarget(room, player.color, ms.pendingSecondAction.actionType);
        if (target !== null) {
          const ruleId = ms.pendingSecondAction.ruleId;
          const rule = ms.pendingSecondAction.rule;
          const choiceData = ms.pendingSecondAction.firstChoiceData;
          const secondChoiceData = target;
          const chooserColor = player.color === 'w' ? 'b' : 'w';

          activateRule(ms, ruleId, chooserColor, choiceData, secondChoiceData, rule.duration);
          executeHook(ruleId, 'onActivate', room, chooserColor, choiceData, secondChoiceData);

          ms.pendingAction = null;
          ms.pendingSecondAction = null;

          const botPayload2 = {
            rule: { id: rule.id, name: rule.name, description: rule.description, duration: rule.duration },
            chooser: chooserColor,
            fen: room.chess.fen(),
            mutatorState: serializeMutatorState(ms),
          };
          if (room._riskItRookResult) {
            botPayload2.riskItRookFlip = room._riskItRookResult;
            delete room._riskItRookResult;
          }
          io.to(room.roomCode).emit('mutatorActivated', botPayload2);
          checkKingDestroyed(room, io, gameManager);
          checkMutatorDeadlock(room, io, gameManager);
          if (room.status === 'active') scheduleBotMove(room, io, gameManager, handleMove, botAutoMutatorResponse);
        }
      }
    }

    // Bot auto-responds to RPS (with humanizing delay)
    if (ms.pendingRPS) {
      const rps = ms.pendingRPS;
      const choices = ['rock', 'paper', 'scissors'];
      const attacker = room.getPlayer(rps.attacker);
      const defender = room.getPlayer(rps.defender);

      const needsBotAttacker = attacker && attacker.isBot && !rps.attackerChoice;
      const needsBotDefender = defender && defender.isBot && !rps.defenderChoice;

      if (needsBotAttacker || needsBotDefender) {
        const rpsDelay = 800 + Math.random() * 400; // 0.8-1.2s
        setTimeout(() => {
          if (!ms.pendingRPS || room.status !== 'active') return;
          if (needsBotAttacker && !rps.attackerChoice) {
            rps.attackerChoice = choices[Math.floor(Math.random() * 3)];
          }
          if (needsBotDefender && !rps.defenderChoice) {
            rps.defenderChoice = choices[Math.floor(Math.random() * 3)];
          }
          // Resolve if both have chosen
          if (rps.attackerChoice && rps.defenderChoice) {
            resolveRPSResult(room, io, gameManager, ms, rps, handleMove, scheduleBotMove, botAutoMutatorResponse);
          }
        }, rpsDelay);
      } else if (rps.attackerChoice && rps.defenderChoice) {
        resolveRPSResult(room, io, gameManager, ms, rps, handleMove, scheduleBotMove, botAutoMutatorResponse);
      }
    }
  }

  /**
   * Register all mutator-related socket event handlers.
   *
   * @param {Object} socket - Socket.IO client socket
   * @param {Object} io - Socket.IO server
   * @param {Object} gameManager - GameManager instance
   */
  function registerSocketHandlers(socket, io, gameManager) {

    socket.on('selectMutator', (data) => {
      if (!data || typeof data.ruleId !== 'string') return;

      const room = gameManager.getRoomForSocket(socket.id);
      if (!room || !room.mutatorState) return;
      const ms = room.mutatorState;
      if (!ms.pendingChoice) return;

      const player = room.getPlayerBySocket(socket.id);
      if (!player || player.color !== ms.pendingChoice.chooser) return;

      const ruleId = data.ruleId;
      const option = ms.pendingChoice.options.find(o => o.id === ruleId);
      if (!option) return;

      if (option.requiresChoice) {
        ms.pendingAction = {
          ruleId,
          actionType: option.choiceType,
          forPlayer: player.color,
          rule: option,
        };
        ms.pendingChoice = null;
        io.to(room.roomCode).emit('mutatorChosen', {
          rule: { id: option.id, name: option.name, description: option.description, duration: option.duration },
          chooser: player.color,
          requiresAction: true,
          actionType: option.choiceType,
          forPlayer: player.color,
        });

        // For sophie choice type, pre-select 2 random friendly pieces
        let sophieOptions = null;
        if (option.choiceType === 'sophie') {
          const board = room.chess.board();
          const friendly = [];

          for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
              const p = board[r][c];
              if (p && p.color === player.color && p.type !== 'k') {
                friendly.push(COLUMNS[c] + ROWS[7 - r]);
              }
            }
          }
          if (friendly.length >= 2) {
            const i1 = Math.floor(Math.random() * friendly.length);
            const sq1 = friendly.splice(i1, 1)[0];
            const sq2 = friendly[Math.floor(Math.random() * friendly.length)];
            sophieOptions = [sq1, sq2];
            ms.pendingAction.sophieOptions = sophieOptions;
          }
        }

        let actionPrompt;
        if (option.choiceType === 'sophie') {
          actionPrompt = 'Choose which piece to sacrifice';
        } else if (option.choiceType === 'two_friendly_pawns') {
          actionPrompt = 'Select a pawn to sacrifice (1/2)';
        } else if (option.choiceType === 'two_squares') {
          actionPrompt = `Select first square for ${option.name}`;
        } else if (option.choiceType === 'two_pieces_same_column') {
          actionPrompt = `Select first piece for ${option.name}`;
        } else {
          actionPrompt = `Select target for ${option.name}`;
        }

        socket.emit('mutatorAction', {
          ruleId,
          actionType: option.choiceType,
          prompt: actionPrompt,
          forPlayer: player.color,
          sophieOptions,
        });

        const targetPlayer = room.getPlayer(ms.pendingAction.forPlayer);
        if (targetPlayer && targetPlayer.isBot) {
          setTimeout(() => botAutoMutatorResponse(room, io, gameManager), 1200 + Math.random() * 600);
        }
        return;
      }

      // Broadcast selection to both clients before activation
      io.to(room.roomCode).emit('mutatorSelected', { ruleId });

      // Instant activation (no choice needed)
      activateRule(ms, ruleId, player.color, undefined, undefined, option.duration);
      executeHook(ruleId, 'onActivate', room, player.color);

      const board = fenToBoard(room.chess.fen());
      const checkState = {
        whiteInCheck: isKingInCheck(board, 'w', ms),
        blackInCheck: isKingInCheck(board, 'b', ms),
      };

      const activatedPayload = {
        rule: { id: option.id, name: option.name, description: option.description, duration: option.duration },
        chooser: player.color,
        fen: room.chess.fen(),
        mutatorState: serializeMutatorState(ms),
        checkState,
      };

      // Attach Risk it Rook flip data if present
      if (room._riskItRookResult) {
        activatedPayload.riskItRookFlip = room._riskItRookResult;
        delete room._riskItRookResult;
      }

      io.to(room.roomCode).emit('mutatorActivated', activatedPayload);

      // Check if a king was destroyed by the instant mutator activation
      checkKingDestroyed(room, io, gameManager);

      // Check if mutator restrictions leave the current player with no legal moves
      checkMutatorDeadlock(room, io, gameManager);

      // Ensure bot gets its move after mutator selection
      if (room.status === 'active') scheduleBotMove(room, io, gameManager, handleMove, botAutoMutatorResponse);

      // If All on Red just activated, trigger immediate coin flip
      if (option.id === 'all_on_red' || isRuleActive(ms, 'all_on_red')) {
        const nextTurn = room.chess.turn();
        triggerCoinFlip(room, io, nextTurn);
        if (!room.manualCoinFlip) {
          checkCoinFlipSkipTurn(room, io, nextTurn);
        }
      }

      // Risk it Rook manual mode: prompt players for coin flips
      if (option.id === 'risk_it_rook' && room._riskItRookPending) {
        promptRiskItRookFlip(room, io, gameManager);
      }
    });

    socket.on('mutatorActionResponse', (data) => {
      if (!data || data.targets == null) return;

      const room = gameManager.getRoomForSocket(socket.id);
      if (!room || !room.mutatorState) return;
      const ms = room.mutatorState;

      if (ms.pendingAction && ms.pendingAction.forPlayer) {
        const player = room.getPlayerBySocket(socket.id);
        if (!player || player.color !== ms.pendingAction.forPlayer) return;

        const ruleId = ms.pendingAction.ruleId;
        const rule = ms.pendingAction.rule;

        // --- Validate target selection ------------------------------
        const choiceType = ms.pendingAction.actionType;
        let target = data.targets;

        // Normalize column/row choices -- client may send full square like "e4"
        if (choiceType === 'column' && typeof target === 'string' && target.length > 1) {
          target = target[0]; // extract column letter
        }
        if (choiceType === 'row' && typeof target === 'string' && target.length > 1) {
          target = target[1]; // extract row number
        }

        // Square-based targets must be valid board squares
        const SQUARE_CHOICE_TYPES = ['square', 'empty_square', 'piece', 'friendly_piece',
          'enemy_piece', 'friendly_bishop_or_knight', 'sophie',
          'two_friendly_pawns', 'two_squares', 'two_pieces_same_column'];
        if (SQUARE_CHOICE_TYPES.includes(choiceType) && typeof target === 'string') {
          if (!validateSquare(target)) return;
        }

        if (choiceType === 'empty_square' && target) {
          const piece = room.chess.get(target);
          if (piece) {
            socket.emit('mutatorAction', {
              ruleId,
              actionType: choiceType,
              prompt: 'That square is not empty! Select an empty square.',
              forPlayer: player.color,
            });
            return;
          }
          if (isSquareHardBlocked(room, target)) {
            socket.emit('mutatorAction', {
              ruleId,
              actionType: choiceType,
              prompt: 'That square is blocked! Select a different empty square.',
              forPlayer: player.color,
            });
            return;
          }
        }
        if ((choiceType === 'piece' || choiceType === 'friendly_piece') && target) {
          const piece = room.chess.get(target);
          if (piece && piece.type === 'k') {
            socket.emit('mutatorAction', {
              ruleId,
              actionType: choiceType,
              prompt: 'You cannot select a King! Choose another piece.',
              forPlayer: player.color,
            });
            return;
          }
        }
        if (choiceType === 'enemy_piece' && target) {
          const piece = room.chess.get(target);
          if (!piece || piece.color === player.color) {
            socket.emit('mutatorAction', {
              ruleId,
              actionType: choiceType,
              prompt: 'You must select an enemy piece!',
              forPlayer: player.color,
            });
            return;
          }
          if (piece.type === 'k') {
            socket.emit('mutatorAction', {
              ruleId,
              actionType: choiceType,
              prompt: 'You cannot target the King! Choose another piece.',
              forPlayer: player.color,
            });
            return;
          }
        }

        // --- Multi-step choice types ---------------------------------
        // These require multiple clicks from the human player, collected
        // one at a time and assembled into structured choiceData.

        if (choiceType === 'two_friendly_pawns') {
          if (!ms.pendingAction.partialData) {
            // Step 1: first pawn selected -- validate it's a friendly pawn
            const piece = room.chess.get(target);
            if (!piece || piece.color !== player.color || piece.type !== 'p') {
              socket.emit('mutatorAction', {
                ruleId, actionType: choiceType,
                prompt: 'Select one of YOUR pawns to sacrifice (1/2)',
                forPlayer: player.color,
              });
              return;
            }
            ms.pendingAction.partialData = { pawns: [target] };
            socket.emit('mutatorAction', {
              ruleId, actionType: choiceType,
              prompt: 'Select a second pawn to sacrifice (2/2)',
              forPlayer: player.color,
            });
            return;
          } else if (ms.pendingAction.partialData.pawns.length === 1) {
            // Step 2: second pawn selected
            const piece = room.chess.get(target);
            if (!piece || piece.color !== player.color || piece.type !== 'p') {
              socket.emit('mutatorAction', {
                ruleId, actionType: choiceType,
                prompt: 'Select one of YOUR pawns to sacrifice (2/2)',
                forPlayer: player.color,
              });
              return;
            }
            if (target === ms.pendingAction.partialData.pawns[0]) {
              socket.emit('mutatorAction', {
                ruleId, actionType: choiceType,
                prompt: 'Pick a DIFFERENT pawn (2/2)',
                forPlayer: player.color,
              });
              return;
            }
            ms.pendingAction.partialData.pawns.push(target);
            socket.emit('mutatorAction', {
              ruleId, actionType: 'empty_square',
              prompt: 'Select an empty square for the new Bishop',
              forPlayer: player.color,
            });
            return;
          } else {
            // Step 3: bishop placement -- must be empty and not blocked
            const piece = room.chess.get(target);
            if (piece) {
              socket.emit('mutatorAction', {
                ruleId, actionType: 'empty_square',
                prompt: 'That square is occupied! Select an empty square for the Bishop',
                forPlayer: player.color,
              });
              return;
            }
            if (isSquareHardBlocked(room, target)) {
              socket.emit('mutatorAction', {
                ruleId, actionType: 'empty_square',
                prompt: 'That square is blocked! Select a different empty square for the Bishop',
                forPlayer: player.color,
              });
              return;
            }
            // All 3 inputs collected -- assemble structured choiceData
            target = {
              pawns: ms.pendingAction.partialData.pawns,
              bishopSquare: target,
            };
          }
        }

        if (choiceType === 'two_squares') {
          if (!ms.pendingAction.partialData) {
            ms.pendingAction.partialData = { square1: target };
            socket.emit('mutatorAction', {
              ruleId, actionType: choiceType,
              prompt: `Select second square for ${rule.name}`,
              forPlayer: player.color,
            });
            return;
          } else {
            target = {
              square1: ms.pendingAction.partialData.square1,
              square2: target,
            };
          }
        }

        if (choiceType === 'two_pieces_same_column') {
          if (!ms.pendingAction.partialData) {
            ms.pendingAction.partialData = { square1: target };
            socket.emit('mutatorAction', {
              ruleId, actionType: choiceType,
              prompt: `Select second piece in the same column for ${rule.name}`,
              forPlayer: player.color,
            });
            return;
          } else {
            // Validate same column
            if (target[0] !== ms.pendingAction.partialData.square1[0]) {
              socket.emit('mutatorAction', {
                ruleId, actionType: choiceType,
                prompt: 'Must be in the same column! Select second piece',
                forPlayer: player.color,
              });
              return;
            }
            target = {
              square1: ms.pendingAction.partialData.square1,
              square2: target,
            };
          }
        }

        // Check if second player also needs to choose
        if (rule.secondPlayerChoice && !ms.pendingSecondAction) {
          const choiceData = target;
          const opponentColor = player.color === 'w' ? 'b' : 'w';
          ms.pendingSecondAction = {
            ruleId,
            actionType: rule.secondChoiceType,
            forPlayer: opponentColor,
            firstChoiceData: choiceData,
            rule,
          };
          ms.pendingAction = null;

          // For sophie choice type, pre-select 2 random friendly pieces for opponent
          let sophieOptions2 = null;
          if (rule.secondChoiceType === 'sophie') {
            const board = room.chess.board();
            const friendly = [];

            for (let r = 0; r < 8; r++) {
              for (let c = 0; c < 8; c++) {
                const p = board[r][c];
                if (p && p.color === opponentColor && p.type !== 'k') {
                  friendly.push(COLUMNS[c] + ROWS[7 - r]);
                }
              }
            }
            if (friendly.length >= 2) {
              const i1 = Math.floor(Math.random() * friendly.length);
              const sq1 = friendly.splice(i1, 1)[0];
              const sq2 = friendly[Math.floor(Math.random() * friendly.length)];
              sophieOptions2 = [sq1, sq2];
              ms.pendingSecondAction.sophieOptions = sophieOptions2;
            }
          }

          const opponent = room.getPlayer(opponentColor);
          if (opponent && !opponent.isBot) {
            const oppSocket = io.sockets.sockets.get(opponent.socketId);
            if (oppSocket) {
              oppSocket.emit('mutatorAction', {
                ruleId,
                actionType: rule.secondChoiceType,
                prompt: rule.secondChoiceType === 'sophie'
                  ? 'Choose which piece to sacrifice'
                  : `Select target for ${rule.name}`,
                forPlayer: opponentColor,
                sophieOptions: sophieOptions2,
              });
            }
          }
          const secondPlayer = room.getPlayer(opponentColor);
          if (secondPlayer && secondPlayer.isBot) {
            setTimeout(() => botAutoMutatorResponse(room, io, gameManager), 1200 + Math.random() * 600);
          }
          return;
        }

        // Final activation
        const choiceData = ms.pendingSecondAction
          ? ms.pendingSecondAction.firstChoiceData
          : target;
        const secondChoiceData = ms.pendingSecondAction ? target : null;

        activateRule(ms, ruleId, ms.pendingChoice?.chooser || player.color, choiceData, secondChoiceData, rule.duration);
        executeHook(ruleId, 'onActivate', room, player.color, choiceData, secondChoiceData);

        ms.pendingAction = null;
        ms.pendingSecondAction = null;

        const activatedPayload2 = {
          rule: { id: rule.id, name: rule.name, description: rule.description, duration: rule.duration },
          chooser: player.color,
          fen: room.chess.fen(),
          mutatorState: serializeMutatorState(ms),
        };

        // Attach Risk it Rook flip data if present
        if (room._riskItRookResult) {
          activatedPayload2.riskItRookFlip = room._riskItRookResult;
          delete room._riskItRookResult;
        }

        io.to(room.roomCode).emit('mutatorActivated', activatedPayload2);

        // Check if a king was destroyed by the mutator activation
        checkKingDestroyed(room, io, gameManager);

        // Check if mutator restrictions leave the current player with no legal moves
        checkMutatorDeadlock(room, io, gameManager);

        // Ensure bot gets its move after mutator action resolution
        if (room.status === 'active') scheduleBotMove(room, io, gameManager, handleMove, botAutoMutatorResponse);

        // If All on Red is active, trigger immediate coin flip
        if (ruleId === 'all_on_red' || isRuleActive(ms, 'all_on_red')) {
          const nextTurn = room.chess.turn();
          triggerCoinFlip(room, io, nextTurn);
          if (!room.manualCoinFlip) {
            checkCoinFlipSkipTurn(room, io, nextTurn);
          }
        }
      }

      // --- Handle human response to pendingSecondAction --------------
      // (e.g., bot selected Mind Control, human needs to pick their target)
      if (ms.pendingSecondAction && ms.pendingSecondAction.forPlayer) {
        const player = room.getPlayerBySocket(socket.id);
        if (!player || player.color !== ms.pendingSecondAction.forPlayer) return;

        const ruleId = ms.pendingSecondAction.ruleId;
        const rule = ms.pendingSecondAction.rule;
        let target = data.targets;

        // Normalize column/row
        const choiceType = ms.pendingSecondAction.actionType;
        if (choiceType === 'column' && typeof target === 'string' && target.length > 1) {
          target = target[0];
        }
        if (choiceType === 'row' && typeof target === 'string' && target.length > 1) {
          target = target[1];
        }
        if (['square', 'empty_square', 'piece', 'friendly_piece',
          'enemy_piece', 'friendly_bishop_or_knight', 'sophie'].includes(choiceType) && typeof target === 'string') {
          if (!validateSquare(target)) return;
        }

        // Sophie choice: validate against offered options
        if (choiceType === 'sophie' && ms.pendingSecondAction.sophieOptions) {
          if (!ms.pendingSecondAction.sophieOptions.includes(target)) return;
        }

        // King protection for piece-targeting choices
        if ((choiceType === 'enemy_piece' || choiceType === 'piece' || choiceType === 'friendly_piece') && target) {
          const piece = room.chess.get(target);
          if (piece && piece.type === 'k') {
            socket.emit('mutatorAction', {
              ruleId,
              actionType: choiceType,
              prompt: 'You cannot target the King! Choose another piece.',
              forPlayer: player.color,
            });
            return;
          }
        }

        const choiceData = ms.pendingSecondAction.firstChoiceData;
        const secondChoiceData = target;
        const chooserColor = player.color === 'w' ? 'b' : 'w';

        activateRule(ms, ruleId, chooserColor, choiceData, secondChoiceData, rule.duration);
        executeHook(ruleId, 'onActivate', room, chooserColor, choiceData, secondChoiceData);

        ms.pendingAction = null;
        ms.pendingSecondAction = null;

        const activatedPayload3 = {
          rule: { id: rule.id, name: rule.name, description: rule.description, duration: rule.duration },
          chooser: chooserColor,
          fen: room.chess.fen(),
          mutatorState: serializeMutatorState(ms),
        };

        if (room._riskItRookResult) {
          activatedPayload3.riskItRookFlip = room._riskItRookResult;
          delete room._riskItRookResult;
        }

        io.to(room.roomCode).emit('mutatorActivated', activatedPayload3);
        checkKingDestroyed(room, io, gameManager);
        checkMutatorDeadlock(room, io, gameManager);

        // Ensure bot gets its move after second-action resolution
        if (room.status === 'active') scheduleBotMove(room, io, gameManager, handleMove, botAutoMutatorResponse);

        if (ruleId === 'all_on_red' || isRuleActive(ms, 'all_on_red')) {
          const nextTurn = room.chess.turn();
          triggerCoinFlip(room, io, nextTurn);
          if (!room.manualCoinFlip) {
            checkCoinFlipSkipTurn(room, io, nextTurn);
          }
        }
      }
    });

    socket.on('rpsChoice', (data) => {
      if (!data || typeof data.choice !== 'string') return;
      const choice = data.choice.toLowerCase();
      if (!VALID_RPS_CHOICES.includes(choice)) return;

      const room = gameManager.getRoomForSocket(socket.id);
      if (!room || !room.mutatorState || !room.mutatorState.pendingRPS) return;
      const rps = room.mutatorState.pendingRPS;
      const player = room.getPlayerBySocket(socket.id);
      if (!player) return;

      if (player.color === rps.attacker) {
        rps.attackerChoice = choice;
      } else if (player.color === rps.defender) {
        rps.defenderChoice = choice;
      }

      // Both chosen? Resolve via shared helper
      if (rps.attackerChoice && rps.defenderChoice) {
        resolveRPSResult(room, io, gameManager, room.mutatorState, rps, handleMove, scheduleBotMove, botAutoMutatorResponse);
      }
    });

    socket.on('coinFlipChoice', (data) => {
      if (!data || typeof data.choice !== 'string') return;

      const room = gameManager.getRoomForSocket(socket.id);
      if (!room || !room.mutatorState) return;
      const ms = room.mutatorState;
      if (!ms.pendingCoinFlip) return;
      const player = room.getPlayerBySocket(socket.id);
      if (!player || player.color !== ms.pendingCoinFlip.forPlayer) return;

      const choice = data.choice === 'heads' ? 'heads' : 'tails';
      ms.coinFlipResult = { result: choice, moveCount: ms.moveCount };
      ms.pendingCoinFlip = null;

      io.to(room.roomCode).emit('coinFlipResult', { result: choice, forPlayer: player.color, manual: true });

      // If tails and king has no moves, skip turn
      checkCoinFlipSkipTurn(room, io, player.color);
    });

    socket.on('coinFlipStart', () => {
      const room = gameManager.getRoomForSocket(socket.id);
      if (!room) return;
      socket.to(room.roomCode).emit('coinFlipStart', {});
    });

    // --- Risk it Rook manual coin flip --------------------------
    socket.on('riskItRookFlipChoice', (data) => {
      if (!data || (data.choice !== 'heads' && data.choice !== 'tails')) return;

      const room = gameManager.getRoomForSocket(socket.id);
      if (!room || !room._riskItRookPending) return;
      const pending = room._riskItRookPending;
      const player = room.getPlayerBySocket(socket.id);
      if (!player) return;

      const choice = data.choice;

      if (pending.phase === 'chooser' && player.color === pending.chooserColor) {
        pending.flips.chooserFlip = choice;
        pending.phase = 'opponent1';
        io.to(room.roomCode).emit('riskItRookFlipResult', {
          phase: 'chooser', result: choice, forPlayer: pending.chooserColor, manual: true,
        });
        promptRiskItRookFlip(room, io, gameManager);
      } else if (pending.phase === 'opponent1' && player.color === pending.opponentColor) {
        pending.flips.opponentFlip1 = choice;
        pending.phase = 'opponent2';
        io.to(room.roomCode).emit('riskItRookFlipResult', {
          phase: 'opponent1', result: choice, forPlayer: pending.opponentColor, manual: true,
        });
        promptRiskItRookFlip(room, io, gameManager);
      } else if (pending.phase === 'opponent2' && player.color === pending.opponentColor) {
        pending.flips.opponentFlip2 = choice;
        io.to(room.roomCode).emit('riskItRookFlipResult', {
          phase: 'opponent2', result: choice, forPlayer: pending.opponentColor, manual: true,
        });
        // All flips collected -- place rooks
        finalizeRiskItRook(room, io, gameManager);
      }
    });
  }

  /**
   * Prompt the next player for their Risk it Rook manual coin flip.
   * Bots auto-respond with random choices.
   */
  function promptRiskItRookFlip(room, io, gameManager) {
    const pending = room._riskItRookPending;
    if (!pending) return;

    let targetColor, flipLabel, flipNumber;
    if (pending.phase === 'chooser') {
      targetColor = pending.chooserColor;
      flipLabel = 'Risk it Rook: What did you flip?';
      flipNumber = 1;
    } else if (pending.phase === 'opponent1') {
      targetColor = pending.opponentColor;
      flipLabel = 'Risk it Rook: What did you flip? (1/2)';
      flipNumber = 1;
    } else if (pending.phase === 'opponent2') {
      targetColor = pending.opponentColor;
      flipLabel = 'Risk it Rook: What did you flip? (2/2)';
      flipNumber = 2;
    } else {
      return;
    }

    const targetPlayer = room.getPlayer(targetColor);
    if (!targetPlayer) return;

    if (targetPlayer.isBot) {
      // Bot auto-picks (with humanizing delay per flip)
      const flipDelay = 800 + Math.random() * 400; // 0.8-1.2s
      setTimeout(() => {
        if (!room._riskItRookPending || room.status !== 'active') return;
        const result = Math.random() < 0.5 ? 'heads' : 'tails';
        if (pending.phase === 'chooser') {
          pending.flips.chooserFlip = result;
          pending.phase = 'opponent1';
          io.to(room.roomCode).emit('riskItRookFlipResult', {
            phase: 'chooser', result, forPlayer: targetColor, manual: true,
          });
          promptRiskItRookFlip(room, io, gameManager);
        } else if (pending.phase === 'opponent1') {
          pending.flips.opponentFlip1 = result;
          pending.phase = 'opponent2';
          io.to(room.roomCode).emit('riskItRookFlipResult', {
            phase: 'opponent1', result, forPlayer: targetColor, manual: true,
          });
          promptRiskItRookFlip(room, io, gameManager);
        } else if (pending.phase === 'opponent2') {
          pending.flips.opponentFlip2 = result;
          io.to(room.roomCode).emit('riskItRookFlipResult', {
            phase: 'opponent2', result, forPlayer: targetColor, manual: true,
          });
          finalizeRiskItRook(room, io, gameManager);
        }
      }, flipDelay);
    } else {
      // Human player -- send prompt
      const targetSocket = io.sockets.sockets.get(targetPlayer.socketId);
      if (targetSocket) {
        targetSocket.emit('riskItRookFlipPrompt', {
          phase: pending.phase,
          flipLabel,
          flipNumber,
          forPlayer: targetColor,
        });
      }
    }
  }

  /**
   * All manual flips collected -- place rooks and emit board update.
   */
  function finalizeRiskItRook(room, io, gameManager) {
    const pending = room._riskItRookPending;
    if (!pending) return;

    riskItRookPlaceRooks(room, pending.chooserColor, pending.flips);
    delete room._riskItRookPending;

    const ms = room.mutatorState;
    const payload = {
      fen: room.chess.fen(),
      mutatorState: serializeMutatorState(ms),
    };

    // Include flip results for client visualization
    if (room._riskItRookResult) {
      payload.riskItRookFlip = room._riskItRookResult;
      delete room._riskItRookResult;
    }

    io.to(room.roomCode).emit('mutatorBoardUpdate', payload);
    checkKingDestroyed(room, io, gameManager);
    checkMutatorDeadlock(room, io, gameManager);
  }

  return { botAutoMutatorResponse, registerSocketHandlers };
}

module.exports = { createMutatorHandlers };
