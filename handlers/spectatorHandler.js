const { serializeBoardForClient, getPublicPlayer } = require('../gameController');
const { serializeMutatorState } = require('../mutators/mutatorEngine');

/**
 * Handle a socket requesting to spectate a room.
 *
 * @param {Object} io - Socket.IO server
 * @param {Object} socket - Spectator's socket
 * @param {Object} gameManager - GameManager instance
 * @param {Object} data - { roomCode }
 */
function handleSpectateRoom(io, socket, gameManager, data) {
  const roomCode = data && data.roomCode;
  if (!roomCode || typeof roomCode !== 'string') {
    socket.emit('spectateError', 'Invalid room code.');
    return;
  }

  const room = gameManager.getRoom(roomCode);
  if (!room) {
    socket.emit('spectateError', 'Room not found.');
    return;
  }

  if (!room.isSpectatable()) {
    socket.emit('spectateError', 'This room is not available for spectating.');
    return;
  }

  // Leave lobby, join the game room channel and track as spectator
  socket.leave('lobby');
  socket.join(roomCode);
  room.spectators.add(socket.id);

  // Send current game state to the spectator
  socket.emit('spectateSuccess', {
    roomCode,
    board: serializeBoardForClient(room.chess),
    white: getPublicPlayer(room.white),
    black: getPublicPlayer(room.black),
    moveHistory: room.moveHistory,
    capturedPieces: room.getCapturedPieces(),
    mutatorState: room.mutatorState ? serializeMutatorState(room.mutatorState) : null,
    spectatorCount: room.spectators.size,
  });

  // Broadcast updated spectator count to everyone in the room
  io.to(roomCode).emit('spectatorCount', { count: room.spectators.size });
}

/**
 * Handle a player disabling spectating for their private room.
 * Only players in private rooms can disable spectating.
 *
 * @param {Object} io - Socket.IO server
 * @param {Object} socket - Player's socket
 * @param {Object} gameManager - GameManager instance
 */
function handleDisableSpectating(io, socket, gameManager) {
  const room = gameManager.getRoomForSocket(socket.id);
  if (!room) return;

  const player = room.getPlayerBySocket(socket.id);
  if (!player) return;

  // Only private rooms can disable spectating
  if (!room.isPrivate) return;

  room.spectatingDisabled = true;

  // Kick all current spectators
  for (const specId of room.spectators) {
    const specSocket = io.sockets.sockets.get(specId);
    if (specSocket) {
      specSocket.emit('spectateKicked');
      specSocket.leave(room.roomCode);
      specSocket.join('lobby');
    }
  }
  room.spectators.clear();
}

/**
 * Handle a spectator disconnecting. Removes them from whichever room
 * they were spectating and broadcasts the updated count.
 *
 * @param {Object} io - Socket.IO server
 * @param {string} socketId - Disconnected socket ID
 * @param {Object} gameManager - GameManager instance
 */
function handleSpectatorDisconnect(io, socketId, gameManager) {
  for (const room of gameManager.getAllRooms()) {
    if (room.spectators.has(socketId)) {
      room.spectators.delete(socketId);
      io.to(room.roomCode).emit('spectatorCount', { count: room.spectators.size });
      return;
    }
  }
}

module.exports = {
  handleSpectateRoom,
  handleDisableSpectating,
  handleSpectatorDisconnect,
};
