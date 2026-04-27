const crypto = require('crypto');

/**
 * Create a player object for a 1v1 game.
 */
function createPlayer(socketId, name, playerHash, color, isBot = false) {
  return {
    socketId,
    name,
    color,        // 'w' or 'b'
    token: crypto.randomUUID(),
    playerHash,
    active: true,
    isBot,
    joinedAt: Date.now()
  };
}

/**
 * Determine which color to assign to a joining player.
 * If preferredColor is specified and available, use it.
 * Otherwise assign randomly from available colors.
 */
function assignColor(room, preferredColor) {
  const available = [];
  if (!room.white) available.push('w');
  if (!room.black) available.push('b');

  if (available.length === 0) return null;

  if (preferredColor && available.includes(preferredColor)) {
    return preferredColor;
  }

  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Serialize the board state for the client.
 */
function serializeBoardForClient(chess) {
  const fen = chess.fen();
  const board = chess.board(); // 8x8 array of {square, type, color} | null
  const pieces = [];

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const piece = board[row][col];
      if (piece) {
        const fileChar = String.fromCharCode(97 + col);
        const rank = 8 - row;
        pieces.push({
          square: `${fileChar}${rank}`,
          type: piece.type,
          color: piece.color
        });
      }
    }
  }

  return { fen, pieces, turn: chess.turn() };
}

/**
 * Get public-safe player info (no token or hash).
 */
function getPublicPlayer(player) {
  if (!player) return null;
  return {
    name: player.name,
    color: player.color,
    active: player.active,
    isBot: player.isBot
  };
}

module.exports = {
  createPlayer,
  assignColor,
  serializeBoardForClient,
  getPublicPlayer
};
