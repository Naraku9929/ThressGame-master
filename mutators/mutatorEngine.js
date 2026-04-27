/**
 * Mutator Engine -- manages rule lifecycle for a game room.
 *
 * Responsibilities:
 * - Track total move count
 * - Trigger rule choice every 3 moves
 * - Manage active rules and their durations
 * - Dispatch hooks (onActivate, onAfterMove, onCapture, onTurnEnd, onExpire)
 * - Manage board modifiers (mines, portals, blocked squares, etc.)
 * - Handle pending choices and actions
 */

const { getEligibleRules, selectWeightedRandom, getRuleById } = require('./mutatorDefs');

const CHOICE_INTERVAL = 3; // every 3 moves

/**
 * Create a fresh mutator state for a new game.
 */
function createMutatorState() {
  return {
    moveCount: 0,
    activeRules: [],
    boardModifiers: {
      blockedSquares: [],   // [{square, permanent}]
      mines: [],            // [{square}]
      portals: [],          // [{square1, square2, expiresAtMove}]
      treasureSquares: [],  // [{square, active}]
      frozenSquares: [],    // [{square, expiresAtMove}]
      frozenColumns: [],    // [{column, expiresAtMove, immune}]
      deathSquares: [],     // [{square, expiresAtMove}]
      bottomlessPits: [],   // [{square}]
      livingBombs: [],      // [{square, piece, expiresAtMove}]
      invulnerable: [],     // [{square, color, expiresAtMove}]
      tornadoSquare: null,  // {square, expiresAtMove}
    },
    pendingChoice: null,
    pendingAction: null,
    pendingSecondAction: null,
    pendingRPS: null,
    coinFlipResult: null,   // for All on Red
    pendingCoinFlip: null,
    completedMutators: [],  // history of all activated/expired mutators for resume replay
  };
}

/**
 * Check if a mutator choice should be triggered for the current move.
 * Called BEFORE the player makes their move.
 * Returns true if the player needs to choose a rule before moving.
 */
function shouldTriggerChoice(mutatorState) {
  // Choice triggers when moveCount is 2, 5, 8, 11, ...
  // i.e., when (moveCount + 1) % CHOICE_INTERVAL === 0
  // This means the 3rd move (index 2), 6th move (index 5), etc.
  return (mutatorState.moveCount + 1) % CHOICE_INTERVAL === 0;
}

/**
 * Randomize a duration range within the base [min, max].
 * Picks a random sub-range: min gets 0-2 added, max gets 0-3 subtracted,
 * but always keeps at least 1 turn spread and respects the original bounds.
 * Max spread is 4 turns.
 */
function randomizeDuration(duration) {
  if (!duration) return null;
  if (!Array.isArray(duration)) return duration;
  const [baseMin, baseMax] = duration;
  const range = baseMax - baseMin;
  if (range <= 2) return [baseMin, baseMax]; // already tight, don't shrink further

  // Pick a random min between baseMin and baseMin+2 (capped at baseMax-1)
  const minBump = Math.floor(Math.random() * Math.min(3, range));
  const newMin = baseMin + minBump;

  // Pick a random max between newMin+1 and baseMax, capped so spread <= 4
  const maxCeil = Math.min(baseMax, newMin + 4);
  const maxFloor = newMin + 1;
  const newMax = maxFloor + Math.floor(Math.random() * (maxCeil - maxFloor + 1));

  return [newMin, newMax];
}

/**
 * Generate 3 rule options for the choosing player.
 * Each option gets a randomized duration sub-range.
 */
function generateRuleOptions(mutatorState, disabledMutators) {
  const activeIds = mutatorState.activeRules.map(r => r.rule.id);
  const eligible = getEligibleRules(activeIds, disabledMutators);
  if (eligible.length === 0) return [];
  const selected = selectWeightedRandom(eligible, Math.min(3, eligible.length));
  // Randomize duration on shallow copies so we don't mutate the definitions
  return selected.map(rule => ({
    ...rule,
    duration: randomizeDuration(rule.duration),
  }));
}

/**
 * Activate a chosen rule.
 * Returns the active rule instance that was created.
 */
// Instant rules that leave persistent board state (shown in sidebar until consumed/cleared)
// Instant rules that leave persistent board state (shown in sidebar until consumed/cleared)
const PERSISTENT_INSTANT_RULES = new Set([
  'minefield',       // mines stay until triggered
  'scorched_earth',  // blocked squares are permanent
  'bottomless_pit',  // pits are permanent
  'treasure_chest',  // treasure stays until collected
]);

function activateRule(mutatorState, ruleId, chooserColor, choiceData, secondChoiceData, overrideDuration) {
  const rule = getRuleById(ruleId);
  if (!rule) return null;

  const duration = overrideDuration || rule.duration;
  const activeRule = {
    rule,
    activatedAtMove: mutatorState.moveCount,
    expiresAtMove: duration
      ? mutatorState.moveCount + duration[0] + Math.floor(Math.random() * (duration[1] - duration[0] + 1))
      : null,
    chooser: chooserColor,
    choiceData: choiceData || null,
    secondChoiceData: secondChoiceData || null,
    persistent: !duration && PERSISTENT_INSTANT_RULES.has(ruleId),
  };

  if (rule.duration || activeRule.persistent) {
    mutatorState.activeRules.push(activeRule);
  } else {
    // Instant rule -- record in history immediately
    mutatorState.completedMutators.push({
      id: rule.id,
      name: rule.name,
      description: rule.description || '',
      type: 'instant',
      activatedAtMove: activeRule.activatedAtMove,
      chooser: chooserColor,
    });
  }

  // Clear pending state
  mutatorState.pendingChoice = null;
  mutatorState.pendingAction = null;
  mutatorState.pendingSecondAction = null;

  return activeRule;
}

/**
 * Check for and remove expired rules.
 * Returns array of expired active rule instances.
 */
function checkExpiredRules(mutatorState) {
  const expired = [];
  const stillActive = [];

  for (const ar of mutatorState.activeRules) {
    if (ar.expiresAtMove !== null && mutatorState.moveCount >= ar.expiresAtMove) {
      expired.push(ar);
      // Record in history
      mutatorState.completedMutators.push({
        id: ar.rule.id,
        name: ar.rule.name,
        description: ar.rule.description || '',
        type: 'expired',
        activatedAtMove: ar.activatedAtMove,
        chooser: ar.chooser,
      });
    } else {
      stillActive.push(ar);
    }
  }

  mutatorState.activeRules = stillActive;
  return expired;
}

/**
 * Remove a persistent instant rule from activeRules (when its board state is fully consumed).
 */
function removePersistentRule(mutatorState, ruleId) {
  const removed = mutatorState.activeRules.find(ar => ar.persistent && ar.rule.id === ruleId);
  mutatorState.activeRules = mutatorState.activeRules.filter(
    ar => !(ar.persistent && ar.rule.id === ruleId)
  );
  if (removed) {
    mutatorState.completedMutators.push({
      id: removed.rule.id,
      name: removed.rule.name,
      description: removed.rule.description || '',
      type: 'expired',
      activatedAtMove: removed.activatedAtMove,
      chooser: removed.chooser,
    });
  }
}

/**
 * Increment the move counter.
 */
function incrementMoveCount(mutatorState) {
  mutatorState.moveCount++;
}

/**
 * Check if any active rule has a specific tag.
 */
function hasActiveRuleWithTag(mutatorState, tag) {
  return mutatorState.activeRules.some(ar => ar.rule.tags.includes(tag));
}

/**
 * Check if any active rule has a specific ID.
 */
function isRuleActive(mutatorState, ruleId) {
  return mutatorState.activeRules.some(ar => ar.rule.id === ruleId);
}

/**
 * Get all active rules of a specific category.
 */
function getActiveRulesByCategory(mutatorState, category) {
  return mutatorState.activeRules.filter(ar => ar.rule.category === category);
}

/**
 * Get the serializable state for sending to clients.
 */
function serializeMutatorState(mutatorState) {
  return {
    moveCount: mutatorState.moveCount,
    activeRules: mutatorState.activeRules.map(ar => ({
      id: ar.rule.id,
      name: ar.rule.name,
      description: ar.rule.description,
      flavor: ar.rule.flavor,
      expiresAtMove: ar.expiresAtMove,
      activatedAtMove: ar.activatedAtMove,
      chooser: ar.chooser,
      choiceData: ar.choiceData,
      persistent: ar.persistent || false,
    })),
    boardModifiers: mutatorState.boardModifiers,
    pendingChoice: mutatorState.pendingChoice ? {
      options: mutatorState.pendingChoice.options.map(r => ({
        id: r.id, name: r.name, description: r.description, flavor: r.flavor, duration: r.duration,
      })),
      chooser: mutatorState.pendingChoice.chooser,
    } : null,
    pendingAction: mutatorState.pendingAction ? {
      ruleId: mutatorState.pendingAction.ruleId,
      actionType: mutatorState.pendingAction.actionType,
      forPlayer: mutatorState.pendingAction.forPlayer,
      prompt: mutatorState.pendingAction.prompt,
      sophieOptions: mutatorState.pendingAction.sophieOptions,
    } : null,
    pendingSecondAction: mutatorState.pendingSecondAction ? {
      ruleId: mutatorState.pendingSecondAction.ruleId,
      actionType: mutatorState.pendingSecondAction.actionType,
      forPlayer: mutatorState.pendingSecondAction.forPlayer,
      firstChoiceData: mutatorState.pendingSecondAction.firstChoiceData,
    } : null,
    pendingRPS: mutatorState.pendingRPS,
    coinFlipResult: mutatorState.coinFlipResult,
    pendingCoinFlip: mutatorState.pendingCoinFlip,
    completedMutators: mutatorState.completedMutators || [],
  };
}

module.exports = {
  createMutatorState,
  shouldTriggerChoice,
  generateRuleOptions,
  activateRule,
  checkExpiredRules,
  removePersistentRule,
  incrementMoveCount,
  hasActiveRuleWithTag,
  isRuleActive,
  getActiveRulesByCategory,
  serializeMutatorState,
};
