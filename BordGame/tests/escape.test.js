'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateEscapePower, calculateDefensePower, resolveEscape } = require('../src/game/escape');

const baseProgress = { route: true, tool: true, timing: false, reinforcement: 0 };

test('脱獄力が阻止力を上回ると成功', () => {
  const result = resolveEscape({
    progress: baseProgress,
    route: 'underground',
    defenses: ['wait', 'wait', 'restoreLock'],
    order: 40
  });
  assert.equal(result.success, true);
  assert.ok(result.escapePower > result.defensePower);
});

test('同点は脱獄失敗', () => {
  const result = resolveEscape({
    progress: { route: false, tool: false, timing: false, reinforcement: 0 },
    route: 'underground',
    defenses: ['blockUnderground', 'wait', 'wait'],
    order: 40
  });
  assert.deepEqual(result, { escapePower: 1, defensePower: 1, success: false });
});

test('阻止力が上回ると失敗', () => {
  const result = resolveEscape({
    progress: baseProgress,
    route: 'underground',
    defenses: ['blockUnderground', 'blockUnderground', 'blockUnderground'],
    order: 40
  });
  assert.equal(result.success, false);
});

test('監獄秩序60以上と80以上で阻止ボーナス', () => {
  const input = { route: 'medical', defenses: ['wait', 'wait', 'wait'] };
  assert.equal(calculateDefensePower({ ...input, order: 59 }), 0);
  assert.equal(calculateDefensePower({ ...input, order: 60 }), 1);
  assert.equal(calculateDefensePower({ ...input, order: 80 }), 2);
});

test('補強と最終カードが脱獄力へ加算される', () => {
  const normal = calculateEscapePower({ progress: baseProgress, route: 'delivery' });
  const reinforced = calculateEscapePower({
    progress: { ...baseProgress, reinforcement: 1 },
    route: 'delivery',
    finalCardUsed: true
  });
  assert.equal(reinforced, normal + 2);
});
