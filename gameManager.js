const { Chess } = require('chess.js');
const { generateRoomCode } = require('./utils/roomCodes');
const { createMutatorState } = require('./mutators/mutatorEngine');

class GameRoom {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.chess = new Chess();
    this.status = 'waiting'; // 'waiting' | 'active' | 'ended'
    this.white = null;  // player object or null
    this.black = null;  // player object or null
    this.isPrivate = false;
    this.createdAt = Date.now();
    this.endedAt = null;
    this.moveHistory = []; // array of {from, to, san, color, captured, flags}
    this.disconnectTimers = new Map(); // color -> timeout ID
    this.mutatorState = null; // initialized on game start
    this.spectators = new Set();      // spectator socket IDs
    this.spectatingDisabled = false;   // one-way kill switch
  }

  addPlayer(player) {
    if (player.color === 'w') {
      this.white = player;
    } else {
      this.black = player;
    }
  }

  removePlayer(color) {
    if (color === 'w') {
      this.white = null;
    } else {
      this.black = null;
    }
  }

  getPlayer(color) {
    return color === 'w' ? this.white : this.black;
  }

  getPlayerBySocket(socketId) {
    if (this.white && this.white.socketId === socketId) return this.white;
    if (this.black && this.black.socketId === socketId) return this.black;
    return null;
  }

  getPlayerByToken(token) {
    if (this.white && this.white.token === token) return this.white;
    if (this.black && this.black.token === token) return this.black;
    return null;
  }

  getOpponent(color) {
    return color === 'w' ? this.black : this.white;
  }

  getPlayerCount() {
    return (this.white ? 1 : 0) + (this.black ? 1 : 0);
  }

  getHumanCount() {
    let count = 0;
    if (this.white && !this.white.isBot) count++;
    if (this.black && !this.black.isBot) count++;
    return count;
  }

  isFull() {
    return this.white !== null && this.black !== null;
  }

  isJoinable() {
    return this.status === 'waiting' && !this.isFull();
  }

  getOpenColor() {
    if (!this.white) return 'w';
    if (!this.black) return 'b';
    return null;
  }

  startGame() {
    this.status = 'active';
    try {
      this.mutatorState = createMutatorState();
    } catch (err) {
      console.error('[GameRoom] createMutatorState failed:', err);
      this.mutatorState = null;
    }
  }

  endGame(reason, winner) {
    this.status = 'ended';
    this.endedAt = Date.now();
    this.endReason = reason;
    this.winner = winner; // 'w', 'b', or null (draw)
    // Clear any disconnect timers
    for (const timer of this.disconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.disconnectTimers.clear();
  }

  getSummary() {
    const creator = this.white || this.black;
    return {
      roomCode: this.roomCode,
      status: this.status,
      playerCount: this.getPlayerCount(),
      creatorName: creator ? creator.name : 'Unknown',
      openColor: this.getOpenColor(),
      isPrivate: this.isPrivate,
      createdAt: this.createdAt,
      spectatorCount: this.spectators.size,
    };
  }

  getCapturedPieces() {
    const captured = { w: [], b: [] };
    for (const move of this.moveHistory) {
      if (move.captured) {
        // Captured piece belongs to the opposite color of the mover
        const capturedColor = move.color === 'w' ? 'b' : 'w';
        captured[capturedColor].push(move.captured);
      }
    }
    return captured;
  }

  hasBot() {
    return !!(this.white && this.white.isBot) || !!(this.black && this.black.isBot);
  }

  isSpectatable() {
    return this.status === 'active' && !this.spectatingDisabled && !this.hasBot();
  }
}

class GameManager {
  constructor() {
    this.rooms = new Map();       // roomCode -> GameRoom
    this.socketToRoom = new Map(); // socket.id -> roomCode
    this.tokenToRoom = new Map();  // token -> roomCode
  }

  createRoom(isPrivate = false) {
    let roomCode;
    do {
      roomCode = generateRoomCode();
    } while (this.rooms.has(roomCode));

    const room = new GameRoom(roomCode);
    room.isPrivate = isPrivate;
    this.rooms.set(roomCode, room);
    return room;
  }

  getRoom(roomCode) {
    return this.rooms.get(roomCode) || null;
  }

  getRoomForSocket(socketId) {
    const roomCode = this.socketToRoom.get(socketId);
    return roomCode ? this.rooms.get(roomCode) || null : null;
  }

  getRoomForToken(token) {
    const roomCode = this.tokenToRoom.get(token);
    return roomCode ? this.rooms.get(roomCode) || null : null;
  }

  setSocketRoom(socketId, roomCode) {
    this.socketToRoom.set(socketId, roomCode);
  }

  setTokenRoom(token, roomCode) {
    this.tokenToRoom.set(token, roomCode);
  }

  removeSocket(socketId) {
    this.socketToRoom.delete(socketId);
  }

  removeToken(token) {
    this.tokenToRoom.delete(token);
  }

  getPublicWaitingRooms() {
    const rooms = [];
    for (const room of this.rooms.values()) {
      if (room.isJoinable() && !room.isPrivate) {
        rooms.push(room.getSummary());
      }
    }
    return rooms;
  }

  getSpectatableRooms() {
    const rooms = [];
    for (const room of this.rooms.values()) {
      if (room.isSpectatable() && !room.isPrivate) {
        rooms.push({
          roomCode: room.roomCode,
          whiteName: room.white?.name || 'Unknown',
          blackName: room.black?.name || 'Unknown',
          spectatorCount: room.spectators.size,
        });
      }
    }
    return rooms;
  }

  getAllRooms() {
    return Array.from(this.rooms.values());
  }

  getActiveRooms() {
    return Array.from(this.rooms.values())
      .filter(r => r.status === 'waiting' || r.status === 'active');
  }

  deleteRoom(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    // Cleanup socket/token mappings -- only delete if they still point to this room
    // (prevents a completed game's cleanup from wiping the mapping of a new game
    // joined by the same socket/token without an intervening disconnect)
    for (const player of [room.white, room.black]) {
      if (player) {
        if (player.socketId && this.socketToRoom.get(player.socketId) === roomCode) {
          this.socketToRoom.delete(player.socketId);
        }
        if (player.token && this.tokenToRoom.get(player.token) === roomCode) {
          this.tokenToRoom.delete(player.token);
        }
      }
    }

    // Clear disconnect timers
    for (const timer of room.disconnectTimers.values()) {
      clearTimeout(timer);
    }

    this.rooms.delete(roomCode);
  }

  cleanupOldRooms() {
    const now = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;
    const toDelete = [];
    for (const [roomCode, room] of this.rooms) {
      if (room.status === 'ended' && room.endedAt && (now - room.endedAt > FIVE_MINUTES)) {
        toDelete.push(roomCode);
      }
    }
    for (const roomCode of toDelete) {
      this.deleteRoom(roomCode);
    }
  }

  getStats() {
    let waiting = 0, active = 0, ended = 0, players = 0;
    for (const room of this.rooms.values()) {
      if (room.status === 'waiting') waiting++;
      else if (room.status === 'active') active++;
      else ended++;
      players += room.getPlayerCount();
    }
    return { totalRooms: this.rooms.size, waiting, active, ended, players };
  }
}

module.exports = { GameRoom, GameManager };
