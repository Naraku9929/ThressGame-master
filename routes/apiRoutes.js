const express = require('express');
const { RULES, RULE_CATEGORIES } = require('../mutators/mutatorDefs');

const router = express.Router();

/**
 * Setup public API routes
 */
function setupApiRoutes() {
  // Health check endpoint
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Return all rules grouped by category for room-creation UI
  router.get('/rules', (_req, res) => {
    const rules = RULES.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      category: r.category,
    }));
    const categories = Object.values(RULE_CATEGORIES);
    res.json({ rules, categories });
  });

  return router;
}

module.exports = { setupApiRoutes };
