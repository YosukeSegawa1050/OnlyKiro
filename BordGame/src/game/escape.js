'use strict';

const ROUTES = {
  underground: { label: '地下通路', category: 'route', defense: 'blockUnderground' },
  delivery: { label: '配給搬入口', category: 'tool', defense: 'restoreLock' },
  medical: { label: '医療搬送口', category: 'timing', defense: 'watchMedical' }
};

const DEFENSES = {
  blockUnderground: '地下通路を封鎖',
  restoreLock: '電子錠を復旧',
  watchMedical: '医療搬送口を監視',
  wait: '待機'
};

function calculateEscapePower({ progress, route, finalCardUsed = false }) {
  const achieved = ['route', 'tool', 'timing'].filter((key) => progress[key]).length;
  return 1
    + Math.floor(achieved / 2)
    + (ROUTES[route] && progress[ROUTES[route].category] ? 1 : 0)
    + (progress.reinforcement ? 1 : 0)
    + (finalCardUsed ? 1 : 0);
}

function calculateDefensePower({ route, defenses, order }) {
  const matching = ROUTES[route] ? ROUTES[route].defense : null;
  return defenses.filter((choice) => choice === matching).length
    + (order >= 60 ? 1 : 0)
    + (order >= 80 ? 1 : 0);
}

function resolveEscape({ progress, route, defenses, order, finalCardUsed = false }) {
  const escapePower = calculateEscapePower({ progress, route, finalCardUsed });
  const defensePower = calculateDefensePower({ route, defenses, order });
  return { escapePower, defensePower, success: escapePower > defensePower };
}

module.exports = { ROUTES, DEFENSES, calculateEscapePower, calculateDefensePower, resolveEscape };
