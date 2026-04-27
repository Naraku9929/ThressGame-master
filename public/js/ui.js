// ============================================================================
// UI -- Panels, status, game info
// ============================================================================

import {
  state, elements, boardSquares, pieceImageCache,
  STORAGE_KEYS, COLOR_NAMES, PIECE_NAMES, PIECE_ICONS,
  assetBasePath, escapeHtml,
} from './state.js';
import { saveToStorage, removeFromStorage, clearSession, resetGameState } from './storage.js';

// These will be wired by main.js to avoid circular imports
let _renderBoard = null;
let _renderCapturedPieces = null;

export function setUIRenderers({ renderBoard, renderCapturedPieces }) {
  _renderBoard = renderBoard;
  _renderCapturedPieces = renderCapturedPieces;
}

// ============================================================================
// VIEW MANAGEMENT
// ============================================================================

export function showPanel(panelId) {
  const panels = ['landing', 'waiting', 'game'];
  panels.forEach(id => {
    const el = document.getElementById(`${id}-panel`);
    if (el) {
      el.classList.toggle('hidden', id !== panelId);
    }
  });

  if (panelId === 'landing') {
    startRoomsPolling();
  } else {
    stopRoomsPolling();
  }
}

export function showLanding() {
  resetGameState();
  showPanel('landing');
}

export function showWaiting(code) {
  if (elements.roomCodeText) {
    elements.roomCodeText.dataset.code = code;
    elements.roomCodeText.textContent = '****';
  }
  if (elements.roomCodeToggle) {
    elements.roomCodeToggle.textContent = 'Show';
  }
  showPanel('waiting');
}

export function showGame() {
  showPanel('game');
  if (elements.sidebarRoomCode) {
    elements.sidebarRoomCode.dataset.code = state.roomCode || '';
    elements.sidebarRoomCode.textContent = '****';
  }
  if (elements.sidebarCodeToggle) {
    elements.sidebarCodeToggle.textContent = 'Show';
  }
  updatePlayerBars();
  updateTurnIndicator();
  if (_renderBoard) _renderBoard();
  if (_renderCapturedPieces) _renderCapturedPieces();

  // Spectator UI adjustments
  const banner = document.getElementById('spectator-banner');
  if (banner) banner.classList.toggle('hidden', !state.isSpectator);
  if (elements.resignButton) elements.resignButton.classList.toggle('hidden', state.isSpectator);

  // Show lock button for players in private rooms only
  const lockBtn = document.getElementById('disable-spectating-btn');
  if (lockBtn) {
    lockBtn.classList.toggle('hidden', state.isSpectator);
  }

  // Hide choice panel on game start (will be shown when choices arrive)
  const choicePanel = document.getElementById('mutator-choice-panel');
  if (choicePanel) choicePanel.classList.add('hidden');
}

// ============================================================================
// MODALS
// ============================================================================

export function showModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

export function hideModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

// ============================================================================
// ROOMS LIST (LANDING PAGE)
// ============================================================================

export function startRoomsPolling() {
  if (state.socket && state.socket.connected) {
    state.socket.emit('joinLobby');
    state.socket.emit('listRooms');
  }
  stopRoomsPolling();
  state.roomsPollingInterval = setInterval(() => {
    if (state.socket && state.socket.connected) {
      state.socket.emit('listRooms');
    }
  }, 5000);
}

export function stopRoomsPolling() {
  if (state.roomsPollingInterval) {
    clearInterval(state.roomsPollingInterval);
    state.roomsPollingInterval = null;
  }
}

export function renderRoomsList(waitingRooms, activeRooms = []) {
  if (!elements.roomsList) return;

  const waiting = waitingRooms || [];
  const active = activeRooms || [];

  // --- Waiting rooms table ---
  let waitingTable = elements.roomsList.querySelector('.rooms-table:not(.active-games-table)');
  if (!waitingTable) {
    waitingTable = document.createElement('table');
    waitingTable.className = 'rooms-table';
    waitingTable.innerHTML = '<thead><tr><th>Room</th><th>Host</th><th>Open Color</th><th></th></tr></thead><tbody></tbody>';
    // Insert before active section or at end
    const activeHeading = elements.roomsList.querySelector('.active-games-heading');
    if (activeHeading) {
      elements.roomsList.insertBefore(waitingTable, activeHeading);
    } else {
      elements.roomsList.appendChild(waitingTable);
    }
  }
  _diffWaitingRows(waitingTable.querySelector('tbody'), waiting);
  waitingTable.style.display = waiting.length > 0 ? '' : 'none';

  // --- Active games section ---
  let activeHeading = elements.roomsList.querySelector('.active-games-heading');
  let activeTable = elements.roomsList.querySelector('.active-games-table');
  if (!activeHeading) {
    activeHeading = document.createElement('h3');
    activeHeading.className = 'active-games-heading';
    activeHeading.textContent = 'Live Games';
    elements.roomsList.appendChild(activeHeading);
  }
  if (!activeTable) {
    activeTable = document.createElement('table');
    activeTable.className = 'rooms-table active-games-table';
    activeTable.innerHTML = '<thead><tr><th>White</th><th>Black</th><th>Viewers</th><th></th></tr></thead><tbody></tbody>';
    elements.roomsList.appendChild(activeTable);
  }
  _diffActiveRows(activeTable.querySelector('tbody'), active);
  activeHeading.style.display = active.length > 0 ? '' : 'none';
  activeTable.style.display = active.length > 0 ? '' : 'none';

  // Show/hide empty placeholder
  let emptyMsg = elements.roomsList.querySelector('.rooms-empty');
  if (waiting.length === 0 && active.length === 0) {
    if (!emptyMsg) {
      emptyMsg = document.createElement('p');
      emptyMsg.className = 'rooms-empty';
      emptyMsg.textContent = 'No open rooms. Create one!';
      elements.roomsList.appendChild(emptyMsg);
    }
  } else if (emptyMsg) {
    emptyMsg.remove();
  }
}

function _bindJoinBtn(btn) {
  btn.addEventListener('click', (e) => {
    const code = e.target.dataset.code;
    const name = elements.nameInput?.value.trim();
    if (!name) return;
    const btns = [
      elements.createRoomBtn, elements.joinRoomBtn, elements.playBotBtn,
      elements.createRoomSubmit, elements.joinCodeSubmit,
    ];
    btns.forEach(b => { if (b) b.disabled = true; });
    if (elements.nameInput) elements.nameInput.disabled = true;
    state.socket.emit('joinRoom', { name, roomCode: code });
  });
}

function _bindWatchBtn(btn) {
  btn.addEventListener('click', (e) => {
    const code = e.target.dataset.code;
    state.socket.emit('spectateRoom', { roomCode: code });
  });
}

function _diffWaitingRows(tbody, rooms) {
  const newCodes = new Set(rooms.map(r => r.roomCode));
  const existingRows = tbody.querySelectorAll('tr[data-code]');
  const existingCodes = new Map();

  // Remove rows no longer present
  existingRows.forEach(row => {
    const code = row.dataset.code;
    if (!newCodes.has(code)) {
      row.remove();
    } else {
      existingCodes.set(code, row);
    }
  });

  // Add/update rows
  rooms.forEach(room => {
    const code = room.roomCode;
    const openColor = room.openColor ? COLOR_NAMES[room.openColor] || room.openColor : 'Any';

    if (existingCodes.has(code)) {
      // Update existing row cells in case data changed
      const row = existingCodes.get(code);
      const cells = row.querySelectorAll('td');
      cells[1].textContent = room.creatorName || 'Unknown';
      cells[2].textContent = openColor;
    } else {
      // Create new row
      const row = document.createElement('tr');
      row.className = 'room-row';
      row.dataset.code = code;
      row.innerHTML =
        `<td class="room-code-cell">${escapeHtml(code)}</td>` +
        `<td>${escapeHtml(room.creatorName || 'Unknown')}</td>` +
        `<td>${openColor}</td>` +
        `<td><button class="btn-primary btn-small room-join-btn" data-code="${escapeHtml(code)}">Join</button></td>`;
      _bindJoinBtn(row.querySelector('.room-join-btn'));
      tbody.appendChild(row);
    }
  });
}

function _diffActiveRows(tbody, rooms) {
  const newCodes = new Set(rooms.map(r => r.roomCode));
  const existingRows = tbody.querySelectorAll('tr[data-code]');
  const existingCodes = new Map();

  // Remove rows no longer present
  existingRows.forEach(row => {
    const code = row.dataset.code;
    if (!newCodes.has(code)) {
      row.remove();
    } else {
      existingCodes.set(code, row);
    }
  });

  // Add/update rows
  rooms.forEach(room => {
    const code = room.roomCode;
    if (existingCodes.has(code)) {
      // Update existing row cells
      const row = existingCodes.get(code);
      const cells = row.querySelectorAll('td');
      cells[0].textContent = room.whiteName || 'Unknown';
      cells[1].textContent = room.blackName || 'Unknown';
      cells[2].textContent = room.spectatorCount || 0;
    } else {
      // Create new row
      const row = document.createElement('tr');
      row.className = 'room-row active-room-row';
      row.dataset.code = code;
      row.innerHTML =
        `<td>${escapeHtml(room.whiteName || 'Unknown')}</td>` +
        `<td>${escapeHtml(room.blackName || 'Unknown')}</td>` +
        `<td>${room.spectatorCount || 0}</td>` +
        `<td><button class="btn-secondary btn-small room-watch-btn" data-code="${escapeHtml(code)}">Watch</button></td>`;
      _bindWatchBtn(row.querySelector('.room-watch-btn'));
      tbody.appendChild(row);
    }
  });
}

// ============================================================================
// CHESS.JS SYNC
// ============================================================================

export function syncChessInstance(fen) {
  if (!fen) return;
  try {
    if (typeof Chess !== 'undefined') {
      state.chessInstance = new Chess(fen);
    }
  } catch (e) {
    console.warn('[chess] Failed to sync Chess instance:', e);
    state.chessInstance = null;
  }
}

// ============================================================================
// PLAYER BARS & TURN INDICATOR
// ============================================================================

export function updatePlayerBars() {
  if (state.isSpectator) {
    if (elements.myNameDisplay) {
      const name = state.whitePlayer?.name || 'White';
      elements.myNameDisplay.textContent = `${name} (White)`;
    }
    if (elements.opponentName) {
      const name = state.blackPlayer?.name || 'Black';
      elements.opponentName.textContent = `${name} (Black)`;
    }
    return;
  }

  const me = state.myColor === 'w' ? state.whitePlayer : state.blackPlayer;
  const opponent = state.myColor === 'w' ? state.blackPlayer : state.whitePlayer;

  if (elements.myNameDisplay) {
    const name = me?.name || state.myName || 'You';
    const color = state.myColor ? COLOR_NAMES[state.myColor] : '';
    elements.myNameDisplay.textContent = `${name} (${color})`;
  }

  if (elements.opponentName) {
    const name = opponent?.name || 'Opponent';
    const opponentColor = state.myColor === 'w' ? 'b' : 'w';
    const color = COLOR_NAMES[opponentColor] || '';
    elements.opponentName.textContent = `${name} (${color})`;
  }
}

export function updateTurnIndicator() {
  const titleCard = document.getElementById('title-card');
  if (!titleCard) return;

  if (!state.isGameActive) {
    return;
  }

  const isBlackTurn = state.currentTurn === 'b';
  if (isBlackTurn) {
    titleCard.classList.add('flip');
  } else {
    titleCard.classList.remove('flip');
  }
}

// ============================================================================
// CAPTURED PIECES DISPLAY
// ============================================================================

export function renderCapturedPieces() {
  if (!state.capturedPieces) return;

  if (state.isSpectator) {
    // Spectator: white on bottom, black on top
    renderCapturedRow(elements.myCaptured, state.capturedPieces.b, 'b');
    renderCapturedRow(elements.opponentCaptured, state.capturedPieces.w, 'w');
    return;
  }

  const opponentColor = state.myColor === 'w' ? 'b' : 'w';
  renderCapturedRow(elements.myCaptured, state.capturedPieces[opponentColor], opponentColor);
  renderCapturedRow(elements.opponentCaptured, state.capturedPieces[state.myColor], state.myColor);
}

const _capturedKeys = new WeakMap();

function renderCapturedRow(container, pieces, pieceColor) {
  if (!container) return;
  const order = { q: 0, r: 1, b: 2, n: 3, p: 4 };
  const sorted = pieces && pieces.length > 0
    ? [...pieces].sort((a, b) => (order[a] ?? 5) - (order[b] ?? 5))
    : [];
  const key = pieceColor + ':' + sorted.join(',');
  if (_capturedKeys.get(container) === key) return;
  _capturedKeys.set(container, key);

  container.innerHTML = '';
  sorted.forEach(type => {
    const img = document.createElement('img');
    const fileName = PIECE_ICONS[pieceColor]?.[type];
    if (fileName) {
      img.src = `${assetBasePath}/icons/${fileName}`;
      img.alt = `${COLOR_NAMES[pieceColor]} ${PIECE_NAMES[type]}`;
      img.className = 'captured-piece-icon';
      container.appendChild(img);
    }
  });
}

// ============================================================================
// STATUS MANAGEMENT
// ============================================================================

let _statusFadeTimeout = null;
let _statusClearTimeout = null;

function showStatusOverlay(message, isFlash) {
  if (!elements.gameStatus) return;
  // Clear any pending timers
  if (_statusFadeTimeout) clearTimeout(_statusFadeTimeout);
  if (_statusClearTimeout) clearTimeout(_statusClearTimeout);
  if (state.flashTimeout) clearTimeout(state.flashTimeout);

  // Show immediately at full opacity
  elements.gameStatus.textContent = message;
  elements.gameStatus.classList.remove('fading');
  if (isFlash) elements.gameStatus.classList.add('flash');
  else elements.gameStatus.classList.remove('flash');

  // Start fading after a brief paint frame
  _statusFadeTimeout = setTimeout(() => {
    elements.gameStatus.classList.add('fading');
    // Clear text after the 1.5s CSS transition completes
    _statusClearTimeout = setTimeout(() => {
      elements.gameStatus.textContent = '';
      elements.gameStatus.classList.remove('fading', 'flash');
    }, 1600);
  }, 50);
}

function cancelStatusFade() {
  if (_statusFadeTimeout) clearTimeout(_statusFadeTimeout);
  if (_statusClearTimeout) clearTimeout(_statusClearTimeout);
  if (elements.gameStatus) elements.gameStatus.classList.remove('fading');
}

export function setBaseStatus(message) {
  // Silently store - no popup. The overlay is only for flash messages.
  state.baseStatus = message;
}

export function flashStatus(message, duration) {
  if (!elements.gameStatus) return;
  cancelStatusFade();

  // Show at full opacity
  elements.gameStatus.textContent = message;
  elements.gameStatus.classList.remove('fading');
  elements.gameStatus.classList.add('flash');

  // Hold for duration, then fade out
  const dur = duration || 3000;
  if (state.flashTimeout) clearTimeout(state.flashTimeout);
  state.flashTimeout = setTimeout(() => {
    // Just fade and clear - don't re-show base status
    elements.gameStatus.classList.add('fading');
    _statusClearTimeout = setTimeout(() => {
      elements.gameStatus.textContent = '';
      elements.gameStatus.classList.remove('fading', 'flash');
    }, 1600);
  }, dur);
}

// ============================================================================
// GAME END
// ============================================================================

export function formatGameEndMessage(payload) {
  const winner = payload?.winner;
  const reason = payload?.reason;

  let resultText;
  if (winner === state.myColor) {
    resultText = 'You Win!';
  } else if (winner && winner !== state.myColor) {
    resultText = 'You Lose';
  } else {
    resultText = 'Draw';
  }

  const reasons = {
    'checkmate': 'by checkmate',
    'resignation': 'by resignation',
    'disconnect': 'by forfeit (disconnect)',
    'king-destroyed': '-- King destroyed!',
    'stalemate': '-- stalemate',
    'insufficient-material': '-- insufficient material',
    'threefold-repetition': '-- threefold repetition',
    'draw': '',
  };

  const reasonText = reasons[reason] || '';
  return `${resultText} ${reasonText}`.trim();
}

export function showGameOverModal(message) {
  if (!elements.gameOverModal || !elements.gameOverText) return;
  elements.gameOverText.textContent = message;
  showModal('game-over-modal');
  elements.gameOverNewGame?.focus();
}

export function handlePlayAgain() {
  hideModal('game-over-modal');
  clearSession();
  showLanding();
}

export function handleQuit() {
  hideModal('game-over-modal');
  clearSession();
  showLanding();
  if (elements.nameInput) {
    elements.nameInput.value = '';
  }
  removeFromStorage(STORAGE_KEYS.name);
}

// ============================================================================
// PRELOADING
// ============================================================================

export function preloadPieceImages() {
  const colors = ['w', 'b'];
  const types = ['k', 'q', 'r', 'b', 'n', 'p'];

  colors.forEach(color => {
    types.forEach(type => {
      const fileName = PIECE_ICONS[color]?.[type];
      if (fileName) {
        const src = `${assetBasePath}/icons/${fileName}`;
        if (!pieceImageCache.has(src)) {
          const img = new Image();
          img.src = src;
          pieceImageCache.set(src, img);
        }
      }
    });
  });
}
