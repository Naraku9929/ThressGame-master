// ============================================================================
// SHARED STATE & CONSTANTS
// All mutable game state lives in the `state` object.
// Every module imports and reads/writes `state.xxx`.
// ============================================================================

const rawBasePath =
  (typeof window !== 'undefined' && window.CHESS_BASE_PATH) || '/';
export const basePath = rawBasePath && rawBasePath !== '' ? rawBasePath : '/';
const rawSocketPath =
  (typeof window !== 'undefined' && window.CHESS_SOCKET_PATH) || '/socket.io';
export const socketPath = rawSocketPath || '/socket.io';
export const assetBasePath = basePath === '/' ? '' : basePath;

export const STORAGE_KEYS = {
  token: 'chess.playerToken',
  name: 'chess.playerName',
};

export const COLOR_NAMES = { w: 'White', b: 'Black' };

export const PIECE_NAMES = {
  k: 'King',
  q: 'Queen',
  r: 'Rook',
  b: 'Bishop',
  n: 'Knight',
  p: 'Pawn',
};

export const PIECE_ICONS = {
  w: {
    k: 'kingwhite.svg',
    q: 'queenwhite.svg',
    r: 'rookwhite.svg',
    b: 'bishopwhite.svg',
    n: 'knightwhite.svg',
    p: 'pawnwhite.svg',
  },
  b: {
    k: 'kingblack.svg',
    q: 'queenblack.svg',
    r: 'rookblack.svg',
    b: 'bishopblack.svg',
    n: 'knightblack.svg',
    p: 'pawnblack.svg',
  },
};

export const PIECE_VARIATION_COUNTS = {
  k: 1, q: 1, b: 2, n: 2, r: 2, p: 8,
};

// --- Mutable State --------------------------------------------------

export const state = {
  socket: null,
  myColor: null,
  myToken: null,
  myName: null,
  roomCode: null,

  isGameActive: false,
  isSpectator: false,
  currentFen: null,
  currentTurn: null,
  moveHistory: [],
  capturedPieces: { w: [], b: [] },

  whitePlayer: null,
  blackPlayer: null,

  selectedSquare: null,
  legalMoves: [],
  lastMove: null,

  chessInstance: null,

  flashTimeout: null,
  baseStatus: '',
  roomsPollingInterval: null,

  pendingPromotion: null,

  // Mutator
  mutatorState: null,
  allRules: [],
  disabledMutators: new Set(),
  manualCoinFlip: false,
  isChoosingRule: false,
  isSelectingTarget: false,
  targetSelectionCallback: null,

  // Mutator panel
  mutatorPanelAnimating: false,
  mutatorHistory: [],

  // Animation
  isAnimating: false,
  animationPromise: null,
  activeAnimations: [],

  // Piece art
  pieceArtVariations: {},

  // Animated background
  currentBgEffect: 1,
};

// --- DOM Caches -----------------------------------------------------

export const boardSquares = new Map();
export const pieceImageCache = new Map();
export const renderedPieces = new Map();

// --- DOM Elements ---------------------------------------------------

export const elements = {
  // Landing
  landingPanel: document.getElementById('landing-panel'),
  nameInput: document.getElementById('name-input'),
  joinError: document.getElementById('join-error'),
  createRoomBtn: document.getElementById('create-room-btn'),
  joinRoomBtn: document.getElementById('join-room-btn'),
  playBotBtn: document.getElementById('play-bot-btn'),
  joinCodeSection: document.getElementById('join-code-section'),
  roomCodeInput: document.getElementById('room-code-input'),
  joinCodeSubmit: document.getElementById('join-code-submit'),
  createOptionsSection: document.getElementById('create-options-section'),
  colorSelect: document.getElementById('color-select'),
  privateCheck: document.getElementById('private-check'),
  createRoomSubmit: document.getElementById('create-room-submit'),
  roomsList: document.getElementById('rooms-list'),

  // Waiting
  waitingPanel: document.getElementById('waiting-panel'),
  roomCodeText: document.getElementById('room-code-text'),
  roomCodeCopy: document.getElementById('room-code-copy'),
  roomCodeToggle: document.getElementById('room-code-toggle'),
  copyFeedback: document.getElementById('copy-feedback'),
  cancelWaitingBtn: document.getElementById('cancel-waiting-btn'),

  // Game
  gamePanel: document.getElementById('game-panel'),
  gameStatus: document.getElementById('game-status'),
  board: document.getElementById('board'),
  opponentName: document.getElementById('opponent-name'),
  opponentCaptured: document.getElementById('opponent-captured'),
  myNameDisplay: document.getElementById('my-name-display'),
  myCaptured: document.getElementById('my-captured'),
  resignButton: document.getElementById('resign-button'),
  sidebarRoomCode: document.getElementById('sidebar-room-code'),
  sidebarCodeToggle: document.getElementById('sidebar-code-toggle'),
  turnIndicator: document.getElementById('turn-indicator'),
  turnText: document.getElementById('turn-text'),
  titleCard: document.getElementById('title-card'),
  mutatorPanel: document.getElementById('mutator-panel'),
  mutatorChoicePanel: document.getElementById('mutator-choice-panel'),
  activeMutatorsRow: document.getElementById('active-mutators-row'),
  infoBar: document.querySelector('.info-bar'),
  sidebarStatus: document.getElementById('sidebar-status'),

  // Spectator
  spectatorBanner: document.getElementById('spectator-banner'),
  spectatorCount: document.getElementById('spectator-count'),
  disableSpectatingBtn: document.getElementById('disable-spectating-btn'),

  // Promotion modal
  promotionModal: document.getElementById('promotion-modal'),
  promotionChoices: document.getElementById('promotion-choices'),

  // Game over modal
  gameOverModal: document.getElementById('game-over-modal'),
  gameOverText: document.getElementById('game-over-text'),
  gameOverNewGame: document.getElementById('game-over-new-game'),
  gameOverQuit: document.getElementById('game-over-quit'),

};

// --- Utilities ------------------------------------------------------

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}
