const ADJECTIVES = [
  'BOLD', 'SWIFT', 'DARK', 'IRON', 'GOLD', 'FIRE', 'STORM', 'FROST',
  'WILD', 'BRAVE', 'KEEN', 'GRIM', 'PALE', 'DIRE', 'DUSK', 'DAWN'
];

const NOUNS = [
  'KING', 'QUEEN', 'ROOK', 'KNIGHT', 'BISHOP', 'PAWN',
  'CASTLE', 'THRONE', 'CROWN', 'BLADE', 'SHIELD', 'TOWER'
];

/**
 * Generate a human-readable room code like "BOLD-KNIGHT-7X"
 */
function generateRoomCode() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = Math.floor(Math.random() * 9 + 1).toString()
    + String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${adj}-${noun}-${suffix}`;
}

/**
 * Validate a room code format.
 */
function isValidRoomCode(code) {
  return typeof code === 'string' && /^[A-Z]+-[A-Z]+-[0-9][A-Z]$/.test(code.toUpperCase());
}

module.exports = { generateRoomCode, isValidRoomCode };
