const { checkProfanity, hasInvalidCharacters } = require('../utils/validation');
const { generatePlayerHash } = require('../utils/playerIdentity');
const { createPlayer, assignColor, serializeBoardForClient, getPublicPlayer } = require('../gameController');
const { handleSpectateRoom } = require('./spectatorHandler');

const MAX_NAME_LENGTH = 20;

/**
 * Validate a player name. Returns an error string or null if valid.
 */
function validateName(name) {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return 'Please choose a non-empty name.';
  }
  if (name.trim().length > MAX_NAME_LENGTH) {
    return `Name must be ${MAX_NAME_LENGTH} characters or fewer.`;
  }
  if (hasInvalidCharacters(name.trim())) {
    return 'Name can only contain letters, numbers, and spaces.';
  }
  if (checkProfanity(name.trim())) {
    return 'That name is not allowed.';
  }
  return null;
}

/**
 * Build the full game state payload for a player.
 */
function buildGameStatePayload(room, player) {
  return {
    roomCode: room.roomCode,
    color: player.color,
    name: player.name,
    token: player.token,
    board: serializeBoardForClient(room.chess),
    white: getPublicPlayer(room.white),
    black: getPublicPlayer(room.black),
    status: room.status,
    moveHistory: room.moveHistory,
    capturedPieces: room.getCapturedPieces(),
    disabledMutatorCount: room.disabledMutators ? room.disabledMutators.size : 0,
    manualCoinFlip: room.manualCoinFlip || false,
  };
}

/**
 * Create a new room and join as the first player.
 *
 * @param {Object} io - Socket.IO server
 * @param {Object} socket - Player's socket
 * @param {Object} gameManager - GameManager instance
 * @param {Object} data - {name, preferredColor?, isPrivate?}
 * @param {Function} broadcastRoomUpdate - Callback to broadcast room list updates
 */
function handleCreateRoom(io, socket, gameManager, data, broadcastRoomUpdate) {
  const name = (data.name || '').trim();
  const nameError = validateName(name);
  if (nameError) {
    socket.emit('joinError', nameError);
    return;
  }

  // Check player isn't already in an active room
  const existingRoom = gameManager.getRoomForSocket(socket.id);
  if (existingRoom) {
    if (existingRoom.status === 'ended') {
      gameManager.removeSocket(socket.id);
    } else {
      socket.emit('joinError', 'You are already in a room.');
      return;
    }
  }

  const isPrivate = Boolean(data.isPrivate);
  const room = gameManager.createRoom(isPrivate);

  // Store mutator settings on the room
  room.disabledMutators = new Set(data.disabledMutators || []);
  room.manualCoinFlip = data.manualCoinFlip || false;

  const playerHash = generatePlayerHash(socket);
  const color = assignColor(room, data.preferredColor || null);
  if (!color) {
    socket.emit('joinError', 'No available color. This should not happen.');
    gameManager.deleteRoom(room.roomCode);
    return;
  }

  const player = createPlayer(socket.id, name, playerHash, color, false);
  room.addPlayer(player);

  // Register socket and token mappings
  gameManager.setSocketRoom(socket.id, room.roomCode);
  gameManager.setTokenRoom(player.token, room.roomCode);

  // Leave lobby, join game room
  socket.leave('lobby');
  socket.join(room.roomCode);

  // Send success payload
  const payload = buildGameStatePayload(room, player);
  socket.emit('joinSuccess', payload);

  broadcastRoomUpdate();
}

/**
 * Join an existing room by room code.
 *
 * @param {Object} io - Socket.IO server
 * @param {Object} socket - Player's socket
 * @param {Object} gameManager - GameManager instance
 * @param {Object} data - {name, roomCode}
 * @param {Function} startGame - Callback to start the game when room is full
 * @param {Function} broadcastRoomUpdate - Callback to broadcast room list updates
 */
function handleJoinRoom(io, socket, gameManager, data, startGame, broadcastRoomUpdate) {
  const name = (data.name || '').trim();
  const nameError = validateName(name);
  if (nameError) {
    socket.emit('joinError', nameError);
    return;
  }

  // Check player isn't already in an active room
  const existingRoom = gameManager.getRoomForSocket(socket.id);
  if (existingRoom) {
    if (existingRoom.status === 'ended') {
      gameManager.removeSocket(socket.id);
    } else {
      socket.emit('joinError', 'You are already in a room.');
      return;
    }
  }

  const roomCode = data.roomCode;
  if (!roomCode || typeof roomCode !== 'string') {
    socket.emit('joinError', 'Invalid room code.');
    return;
  }

  const room = gameManager.getRoom(roomCode);
  if (!room) {
    socket.emit('joinError', 'Room not found.');
    return;
  }

  if (!room.isJoinable()) {
    // Auto-convert to spectate if the room is active and spectatable
    if (room.isSpectatable()) {
      handleSpectateRoom(io, socket, gameManager, { roomCode });
      return;
    }
    socket.emit('joinError', 'Room is not joinable.');
    return;
  }

  const playerHash = generatePlayerHash(socket);
  const color = assignColor(room, data.preferredColor || null);
  if (!color) {
    socket.emit('joinError', 'Room is full.');
    return;
  }

  const player = createPlayer(socket.id, name, playerHash, color, false);
  room.addPlayer(player);

  // Register socket and token mappings
  gameManager.setSocketRoom(socket.id, room.roomCode);
  gameManager.setTokenRoom(player.token, room.roomCode);

  // Leave lobby, join game room
  socket.leave('lobby');
  socket.join(room.roomCode);

  // Send success payload
  const payload = buildGameStatePayload(room, player);
  socket.emit('joinSuccess', payload);

  // If room is now full, start the game
  if (room.isFull()) {
    startGame(room);
  }

  broadcastRoomUpdate();
}

/**
 * Create a room with a bot opponent.
 *
 * @param {Object} io - Socket.IO server
 * @param {Object} socket - Player's socket
 * @param {Object} gameManager - GameManager instance
 * @param {Object} data - {name}
 * @param {Function} startGame - Callback to start the game
 * @param {Function} addBot - Callback: addBot(room, botColor)
 */
function handleJoinBot(io, socket, gameManager, data, startGame, addBot) {
  const name = (data.name || '').trim();
  const nameError = validateName(name);
  if (nameError) {
    socket.emit('joinError', nameError);
    return;
  }

  // Check player isn't already in an active room
  const existingRoom = gameManager.getRoomForSocket(socket.id);
  if (existingRoom) {
    if (existingRoom.status === 'ended') {
      gameManager.removeSocket(socket.id);
    } else {
      socket.emit('joinError', 'You are already in a room.');
      return;
    }
  }

  // Create a private room for bot match
  const room = gameManager.createRoom(true);

  // Store mutator settings on the room
  room.disabledMutators = new Set(data.disabledMutators || []);
  room.manualCoinFlip = data.manualCoinFlip || false;

  const playerHash = generatePlayerHash(socket);

  // Player gets a random color
  const playerColor = Math.random() < 0.5 ? 'w' : 'b';
  const botColor = playerColor === 'w' ? 'b' : 'w';

  const player = createPlayer(socket.id, name, playerHash, playerColor, false);
  room.addPlayer(player);

  // Register socket and token mappings
  gameManager.setSocketRoom(socket.id, room.roomCode);
  gameManager.setTokenRoom(player.token, room.roomCode);

  // Leave lobby, join game room
  socket.leave('lobby');
  socket.join(room.roomCode);

  // Add bot to the room
  addBot(room, botColor);

  // Send success payload
  const payload = buildGameStatePayload(room, player);
  socket.emit('joinSuccess', payload);

  // Start the game immediately
  startGame(room);
}

/**
 * List public waiting rooms.
 *
 * @param {Object} socket - Player's socket
 * @param {Object} gameManager - GameManager instance
 */
function handleListRooms(socket, gameManager) {
  socket.emit('roomsList', {
    waiting: gameManager.getPublicWaitingRooms(),
    active: gameManager.getSpectatableRooms(),
  });
}

module.exports = {
  handleCreateRoom,
  handleJoinRoom,
  handleJoinBot,
  handleListRooms,
};
