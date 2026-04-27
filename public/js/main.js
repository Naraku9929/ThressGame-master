// ============================================================================
// MAIN -- Entry point & socket wiring
// ============================================================================

import { state, elements, STORAGE_KEYS, socketPath } from './state.js';
import { startPageBackground } from './animated-bg.js';
import { loadFromStorage } from './storage.js';
import {
  showPanel, setUIRenderers, preloadPieceImages, flashStatus,
  renderCapturedPieces,
} from './ui.js';
import { renderBoard, setOverlayRenderer } from './board.js';
import { renderBoardOverlays } from './mutatorUI.js';
import { bindLandingEvents, bindWaitingEvents, bindGameEvents, bindModalEvents, initMutatorSettings } from './events.js';
import {
  onConnect, onDisconnect, onConnectError,
  onJoinSuccess, onJoinError, onGameStarted,
  onMoveApplied, onMoveRejected, onGameEnded,
  onOpponentDisconnected, onOpponentReconnected,
  onResumeSuccess, onResumeRejected, onRoomsList,
  onMutatorChoice, onMutatorSelected, onMutatorChosen, onMutatorAction,
  onMutatorActivated, onMutatorExpired, onMutatorBoardUpdate,
  onRPSPrompt, onRPSResult,
  onCoinFlip, onCoinFlipStartAnimation, onCoinFlipPrompt, onCoinFlipResult,
  onRiskItRookFlipPrompt, onRiskItRookFlipResult,
  onSpectateSuccess, onSpectateKicked, onSpectateError, onSpectatorCount,
} from './socketHandlers.js';

// --- Wire cross-module renderers ----------------------------------

// ui.js needs board renderers but can't import board.js (circular)
setUIRenderers({ renderBoard, renderCapturedPieces });

// board.js needs overlay renderer but can't import mutatorUI.js (circular)
setOverlayRenderer(renderBoardOverlays);

// --- Socket Connection --------------------------------------------

function connectSocket() {
  const opts = {
    path: socketPath,
    transports: ['websocket'],   // Skip polling->websocket upgrade cycle
    upgrade: false,
  };
  state.socket = io('/', opts);

  state.socket.on('connect', onConnect);
  state.socket.on('disconnect', onDisconnect);
  state.socket.on('connect_error', onConnectError);

  // Game lifecycle
  state.socket.on('joinSuccess', onJoinSuccess);
  state.socket.on('joinError', onJoinError);
  state.socket.on('gameStarted', onGameStarted);
  state.socket.on('moveApplied', onMoveApplied);
  state.socket.on('moveRejected', onMoveRejected);
  state.socket.on('gameEnded', onGameEnded);
  state.socket.on('opponentDisconnected', onOpponentDisconnected);
  state.socket.on('opponentReconnected', onOpponentReconnected);
  state.socket.on('resumeSuccess', onResumeSuccess);
  state.socket.on('resumeRejected', onResumeRejected);
  state.socket.on('roomsList', onRoomsList);

  // Spectator events
  state.socket.on('spectateSuccess', onSpectateSuccess);
  state.socket.on('spectateKicked', onSpectateKicked);
  state.socket.on('spectateError', onSpectateError);
  state.socket.on('spectatorCount', onSpectatorCount);

  state.socket.on('resignError', (msg) => flashStatus(msg || 'Resign failed.', 3000));

  // Mutator events
  state.socket.on('mutatorChoice', onMutatorChoice);
  state.socket.on('mutatorSelected', onMutatorSelected);
  state.socket.on('mutatorChosen', onMutatorChosen);
  state.socket.on('mutatorAction', onMutatorAction);
  state.socket.on('mutatorActivated', onMutatorActivated);
  state.socket.on('mutatorExpired', onMutatorExpired);
  state.socket.on('mutatorBoardUpdate', onMutatorBoardUpdate);
  state.socket.on('rpsPrompt', onRPSPrompt);
  state.socket.on('rpsResult', onRPSResult);
  state.socket.on('coinFlip', onCoinFlip);
  state.socket.on('coinFlipPrompt', onCoinFlipPrompt);
  state.socket.on('coinFlipResult', onCoinFlipResult);
  state.socket.on('coinFlipStart', onCoinFlipStartAnimation);
  state.socket.on('riskItRookFlipPrompt', onRiskItRookFlipPrompt);
  state.socket.on('riskItRookFlipResult', onRiskItRookFlipResult);
}

// --- Initialization -----------------------------------------------

(function init() {
  // Restore saved name or use default
  const savedName = loadFromStorage(STORAGE_KEYS.name);
  if (elements.nameInput) {
    elements.nameInput.value = savedName || 'IAmBadAtChess';
  }

  // Page background disabled - using static matte
  // startPageBackground(document.body);

  // Preload SVG icons (captured pieces, etc.)
  preloadPieceImages();

  // Preload PNG piece art variations
  const _pieceVariationTypes = ['king', 'queen', 'bishop', 'knight', 'rook', 'pawn'];
  const _pieceVariationCounts = { king: 1, queen: 1, bishop: 2, knight: 2, rook: 2, pawn: 8 };
  const _assetBase = window.__assetBasePath !== undefined ? window.__assetBasePath : (window.CHESS_BASE_PATH && window.CHESS_BASE_PATH !== '/' ? window.CHESS_BASE_PATH : '');
  for (const color of ['white', 'black']) {
    for (const type of _pieceVariationTypes) {
      for (let v = 1; v <= _pieceVariationCounts[type]; v++) {
        const img = new Image();
        img.src = `${_assetBase}/images/pieces/${color}-${type}-${v}.png`;
      }
    }
  }

  // Connect socket
  connectSocket();

  // Check for ?watch= query param
  const urlParams = new URLSearchParams(window.location.search);
  const watchCode = urlParams.get('watch');
  if (watchCode) {
    // Wait for socket connection, then spectate
    state.socket.once('connect', () => {
      state.socket.emit('spectateRoom', { roomCode: watchCode });
    });
  }

  // Bind all event listeners
  bindLandingEvents();
  bindWaitingEvents();
  bindGameEvents();
  bindModalEvents();

  // Load mutator settings
  initMutatorSettings();

  // Try resume session
  const savedToken = loadFromStorage(STORAGE_KEYS.token);
  if (savedToken) {
    state.myToken = savedToken;
    elements.landingPanel?.classList.add('hidden');
    state.socket.once('connect', () => {
      state.socket.emit('resume', { token: savedToken });
    });
  } else {
    showPanel('landing');
  }
})();
