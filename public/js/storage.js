// ============================================================================
// SESSION / STORAGE
// ============================================================================

import { state, STORAGE_KEYS, boardSquares } from './state.js';

export function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage not available
  }
}

export function loadFromStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function removeFromStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage not available
  }
}

export function clearSession() {
  state.myToken = null;
  removeFromStorage(STORAGE_KEYS.token);
}

export function resetGameState() {
  state.isGameActive = false;
  state.isSpectator = false;
  state.currentFen = null;
  state.currentTurn = null;
  state.moveHistory = [];
  state.capturedPieces = { w: [], b: [] };
  state.whitePlayer = null;
  state.blackPlayer = null;
  state.selectedSquare = null;
  state.legalMoves = [];
  state.lastMove = null;
  state.myColor = null;
  state.roomCode = null;
  state.chessInstance = null;
  state.pendingPromotion = null;
  state.mutatorState = null;
  state.isChoosingRule = false;
  state.isSelectingTarget = false;
  state.targetSelectionCallback = null;
  boardSquares.clear();
}
