'use strict';

/**
 * Resolve a Rock-Paper-Scissors contest.
 * @param {string} a - Attacker's choice ('rock', 'paper', or 'scissors')
 * @param {string} b - Defender's choice ('rock', 'paper', or 'scissors')
 * @returns {'tie'|'attacker'|'defender'}
 */
function resolveRPS(a, b) {
  if (a === b) return 'tie';
  if ((a === 'rock' && b === 'scissors') ||
      (a === 'scissors' && b === 'paper') ||
      (a === 'paper' && b === 'rock')) {
    return 'attacker';
  }
  return 'defender';
}

const VALID_RPS_CHOICES = ['rock', 'paper', 'scissors'];

module.exports = { resolveRPS, VALID_RPS_CHOICES };
