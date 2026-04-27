const { serializeBoardForClient, getPublicPlayer } = require('../gameController');
const { scheduleRoomDeletion, emitGameEnded } = require('../utils/gameLifecycle');
const { serializeMutatorState } = require('../mutators/mutatorEngine');

const WAITING_DISCONNECT_TIMEOUT_MS = 30 * 1000; // 30 seconds
const ACTIVE_DISCONNECT_TIMEOUT_MS = 60 * 1000; // 60 seconds

/**
 * Handle player disconnection.
 *
 * @param {Object} io - Socket.IO server
 * @param {Object} socket - Disconnected socket
 * @param {Object} gameManager - GameManager instance
 * @param {Function} broadcastRoomUpdate - Callback to broadcast room list updates
 */
function handleDisconnect(io, socket, gameManager, broadcastRoomUpdate) {
  const room = gameManager.getRoomForSocket(socket.id);
  if (!room) return;

  const player = room.getPlayerBySocket(socket.id);
  if (!player) return;

  const playerColor = player.color;

  // Mark player as disconnected
  player.socketId = null;
  player.active = false;

  // Remove socket mapping (but keep token mapping for reconnection)
  gameManager.removeSocket(socket.id);

  if (room.status === 'waiting') {
    // In waiting room: schedule room destruction after 30s
    const timer = setTimeout(() => {
      // Check if player is still disconnected
      const currentPlayer = room.getPlayer(playerColor);
      if (currentPlayer && !currentPlayer.active) {
        console.log(`[playerHandlers] Destroying waiting room ${room.roomCode} after disconnect timeout`);
        gameManager.deleteRoom(room.roomCode);
        broadcastRoomUpdate();
      }
    }, WAITING_DISCONNECT_TIMEOUT_MS);

    room.disconnectTimers.set(playerColor, timer);
    broadcastRoomUpdate();
    return;
  }

  if (room.status === 'active') {
    const opponent = room.getOpponent(playerColor);

    // Notify opponent
    if (opponent && opponent.socketId) {
      const opponentSocket = io.sockets.sockets.get(opponent.socketId);
      if (opponentSocket) {
        opponentSocket.emit('opponentDisconnected', {
          timeout: ACTIVE_DISCONNECT_TIMEOUT_MS / 1000,
        });
      }
    }

    // Start reconnect timer
    const timer = setTimeout(() => {
      // Check if player is still disconnected
      const currentPlayer = room.getPlayer(playerColor);
      if (!currentPlayer || currentPlayer.active) return;
      if (room.status !== 'active') return;

      // Player didn't reconnect -- opponent wins by forfeit
      const winnerColor = playerColor === 'w' ? 'b' : 'w';
      room.endGame('disconnect', winnerColor);

      emitGameEnded(io, room, 'disconnect', winnerColor);
      scheduleRoomDeletion(gameManager, room.roomCode);
      broadcastRoomUpdate();
    }, ACTIVE_DISCONNECT_TIMEOUT_MS);

    room.disconnectTimers.set(playerColor, timer);
    broadcastRoomUpdate();
    return;
  }
}

/**
 * Handle player resignation.
 *
 * @param {Object} io - Socket.IO server
 * @param {Object} socket - Player's socket
 * @param {Object} gameManager - GameManager instance
 * @param {Function} broadcastRoomUpdate - Callback to broadcast room list updates
 */
function handleResign(io, socket, gameManager, broadcastRoomUpdate) {
  const room = gameManager.getRoomForSocket(socket.id);
  if (!room) {
    socket.emit('resignError', 'You are not in a room.');
    return;
  }

  const player = room.getPlayerBySocket(socket.id);
  if (!player) {
    socket.emit('resignError', 'Player not found.');
    return;
  }

  if (room.status !== 'active') {
    socket.emit('resignError', 'You can only resign during an active game.');
    return;
  }

  const loserColor = player.color;
  const winnerColor = loserColor === 'w' ? 'b' : 'w';

  room.endGame('resignation', winnerColor);

  emitGameEnded(io, room, 'resignation', winnerColor);
  scheduleRoomDeletion(gameManager, room.roomCode);
  broadcastRoomUpdate();
}

/**
 * Handle player reconnection/resume.
 *
 * @param {Object} io - Socket.IO server
 * @param {Object} socket - New socket connection
 * @param {Object} gameManager - GameManager instance
 * @param {Object} data - {token}
 */
function handleResume(io, socket, gameManager, data) {
  const { token } = data || {};

  if (!token || typeof token !== 'string') {
    socket.emit('resumeRejected', 'Invalid resume token.');
    return;
  }

  // Find room by token
  const room = gameManager.getRoomForToken(token);
  if (!room) {
    socket.emit('resumeRejected', 'Session not found.');
    return;
  }

  // Find player by token
  const player = room.getPlayerByToken(token);
  if (!player) {
    socket.emit('resumeRejected', 'Player not found in room.');
    return;
  }

  // Reject if game has ended
  if (room.status === 'ended') {
    socket.emit('resumeRejected', 'Game has ended.');
    return;
  }

  // Clear disconnect timer for this player
  const existingTimer = room.disconnectTimers.get(player.color);
  if (existingTimer) {
    clearTimeout(existingTimer);
    room.disconnectTimers.delete(player.color);
  }

  // Reconnect: update socket, mark active, update mappings
  const oldSocketId = player.socketId;
  if (oldSocketId) {
    gameManager.removeSocket(oldSocketId);
  }

  player.socketId = socket.id;
  player.active = true;

  gameManager.setSocketRoom(socket.id, room.roomCode);
  // Token mapping should already exist, but ensure it
  gameManager.setTokenRoom(token, room.roomCode);

  // Leave lobby, join the game room channel
  socket.leave('lobby');
  socket.join(room.roomCode);

  socket.emit('resumeSuccess', {
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
    mutatorState: room.mutatorState ? serializeMutatorState(room.mutatorState) : null,
  });

  // Notify opponent
  const opponent = room.getOpponent(player.color);
  if (opponent && opponent.socketId) {
    const opponentSocket = io.sockets.sockets.get(opponent.socketId);
    if (opponentSocket) {
      opponentSocket.emit('opponentReconnected', {
        color: player.color,
        name: player.name,
      });
    }
  }

  console.log(`[playerHandlers] Player ${player.name} (${player.color}) resumed in room ${room.roomCode}`);
}

module.exports = {
  handleDisconnect,
  handleResign,
  handleResume,
};
