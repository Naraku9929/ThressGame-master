/**
 * Input validation utilities
 */

const { RegExpMatcher, englishDataset, englishRecommendedTransformers, DataSet, parseRawPattern } = require('obscenity');

// Initialize profanity filter with custom words from environment
const CUSTOM_BANNED_WORDS = process.env.CUSTOM_BANNED_WORDS || '';

const customDataset = new DataSet().addAll(englishDataset);

// Add custom banned words from environment variable (comma-separated)
if (CUSTOM_BANNED_WORDS) {
  const words = CUSTOM_BANNED_WORDS.split(',').map(w => w.trim()).filter(Boolean);
  words.forEach((word) => {
    customDataset.addPhrase((phrase) =>
      phrase
        .setMetadata({ originalWord: word })
        .addPattern(parseRawPattern(word))
    );
  });
}

const profanityMatcher = new RegExpMatcher({
  ...customDataset.build(),
  ...englishRecommendedTransformers,
});

/**
 * Check if name contains profanity
 */
function checkProfanity(name) {
  if (!name || typeof name !== 'string') {
    return false;
  }
  return profanityMatcher.hasMatch(name);
}

/**
 * Check if name contains invalid characters (only alphanumeric + space allowed)
 */
function hasInvalidCharacters(name) {
  if (!name || typeof name !== 'string') {
    return true;
  }
  const validPattern = /^[a-zA-Z0-9 ]+$/;
  return !validPattern.test(name);
}

/**
 * Validate square notation (a1-h8)
 */
function validateSquare(square) {
  return typeof square === 'string' && /^[a-h][1-8]$/.test(square);
}

/**
 * Validate promotion piece
 */
function validatePromotion(pieceAtSquare, targetSquare, requestedPromotion) {
  const PROMOTION_PIECES = ['q', 'r', 'b', 'n'];
  const DEFAULT_PROMOTION = 'q';

  if (!pieceAtSquare || pieceAtSquare.type !== 'p') {
    return null;
  }

  const targetRank = targetSquare[1];
  const isPawnMovingToBackRank =
    (pieceAtSquare.color === 'w' && targetRank === '8') ||
    (pieceAtSquare.color === 'b' && targetRank === '1');

  if (!isPawnMovingToBackRank) {
    return null;
  }

  if (
    requestedPromotion &&
    typeof requestedPromotion === 'string' &&
    PROMOTION_PIECES.includes(requestedPromotion.toLowerCase())
  ) {
    return requestedPromotion.toLowerCase();
  }

  return DEFAULT_PROMOTION;
}

module.exports = {
  checkProfanity,
  hasInvalidCharacters,
  validateSquare,
  validatePromotion,
};
