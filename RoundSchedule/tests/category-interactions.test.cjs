'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { create } = require('../category-interactions.js');
function fixture(t, callbacks = {}) {
  const { document, window } = parseHTML(
    '<html><body><div id="list"></div><input id="outside"></body></html>'
  );
  const list = document.getElementById('list');
  let instant = 0,
    sequence = 0;
  const timers = new Map(),
    moves = [],
    edits = [],
    modes = [],
    errors = [];
  for (const id of ['a', 'b', 'c']) {
    const row = document.createElement('button');
    row.type = 'button';
    row.dataset.categoryId = id;
    row.textContent = id;
    row.className = 'category-item';
    row.getBoundingClientRect = () => {
      const flow = [...list.children].filter(
        (element) => !element.classList.contains('category-dragging')
      );
      const index = Math.max(0, flow.indexOf(row));
      const scroll = list.parentElement?.scrollTop || 0;
      return {
        top: index * 40 - scroll,
        bottom: index * 40 + 40 - scroll,
        left: 0,
        right: 200,
        height: 40,
        width: 200,
      };
    };
    row.setPointerCapture = () => {};
    row.hasPointerCapture = () => false;
    list.appendChild(row);
  }
  const controller = create({
    list,
    onReorder: async (...args) => {
      moves.push(args);
      return callbacks.onReorder?.(...args);
    },
    onEdit: (id) => {
      edits.push(id);
      return callbacks.onEdit?.(id);
    },
    onModeChange: (mode) => modes.push(mode),
    onError: (error) => errors.push(error),
    now: () => instant,
    setTimeout: (handler, delay) => {
      timers.set(++sequence, { handler, due: instant + delay });
      return sequence;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  t.after(() => controller.destroy());
  function advance(ms) {
    instant += ms;
    for (const [id, timer] of [...timers])
      if (timer.due <= instant) {
        timers.delete(id);
        timer.handler();
      }
  }
  const row = (id) => [...list.children].find((element) => element.dataset?.categoryId === id);
  function event(target, type, extra = {}) {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, {
      pointerId: 1,
      clientX: 10,
      clientY: 20,
      isPrimary: true,
      button: 0,
      ...extra,
    });
    target.dispatchEvent(e);
    return e;
  }
  const order = () =>
    [...list.querySelectorAll('[data-category-id]')].map((element) => element.dataset.categoryId);
  const tick = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  function tap(id, type = 'touch', xy = {}) {
    event(row(id), 'pointerdown', { pointerType: type, ...xy });
    advance(30);
    event(row(id), 'pointerup', { pointerType: type, ...xy });
  }
  return {
    document,
    window,
    list,
    row,
    controller,
    event,
    advance,
    order,
    tick,
    tap,
    moves,
    edits,
    modes,
    errors,
  };
}
function scrollContainer(f) {
  const container = f.document.createElement('div');
  container.style.overflowY = 'auto';
  container.style.overflowAnchor = 'auto';
  container.style.scrollBehavior = 'smooth';
  f.list.parentElement.insertBefore(container, f.list);
  container.appendChild(f.list);
  container.getBoundingClientRect = () => ({
    top: 0,
    bottom: 60,
    left: 0,
    right: 200,
    width: 200,
    height: 60,
  });
  let top = 0;
  Object.defineProperties(container, {
    clientHeight: { value: 60 },
    scrollHeight: {
      get: () =>
        [...f.list.children].filter((row) => !row.classList.contains('category-dragging')).length *
        40,
    },
    scrollTop: {
      get: () => top,
      set: (value) => {
        top = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, value));
        f.event(container, 'scroll');
      },
    },
    scrollLeft: { value: 0 },
  });
  return container;
}
test('a short tap does nothing; two taps edit once even if a native dblclick follows', (t) => {
  const f = fixture(t);
  f.tap('a');
  assert.deepEqual(f.edits, []);
  f.advance(100);
  f.tap('a');
  f.event(f.row('a'), 'dblclick');
  assert.deepEqual(f.edits, ['a']);
  assert.deepEqual(f.moves, []);
  assert.equal(f.controller.active, false);
});
test('double taps must target the same category, within time and distance limits', (t) => {
  const f = fixture(t);
  f.tap('a');
  f.advance(100);
  f.tap('b');
  f.advance(350);
  f.tap('b');
  f.advance(100);
  f.tap('b', 'touch', { clientX: 150 });
  assert.deepEqual(f.edits, []);
});
test('desktop dblclick and keyboard Enter/F2 edit without requiring a long press', (t) => {
  const f = fixture(t);
  f.event(f.row('a'), 'dblclick');
  f.event(f.row('b'), 'keydown', { key: 'Enter' });
  f.event(f.row('c'), 'keydown', { key: 'F2' });
  assert.deepEqual(f.edits, ['a', 'b', 'c']);
});
test('long press enters mode at 1500ms, release keeps mode, and doubletap cannot edit in mode', (t) => {
  const f = fixture(t);
  f.event(f.row('a'), 'pointerdown', { pointerType: 'touch' });
  f.advance(1499);
  assert.equal(f.controller.active, false);
  f.advance(1);
  assert.equal(f.controller.active, true);
  assert.deepEqual(f.modes, [true]);
  assert.equal(f.row('a').style.touchAction, 'none');
  f.event(f.row('a'), 'pointerup');
  f.tap('a');
  f.advance(100);
  f.tap('a');
  f.event(f.row('a'), 'dblclick');
  assert.deepEqual(f.edits, []);
  assert.deepEqual(f.moves, []);
});
test('normal scrolling, pointer cancellation and release cancel pending long presses', (t) => {
  const f = fixture(t);
  f.event(f.row('a'), 'pointerdown');
  const movement = f.event(f.row('a'), 'pointermove', { clientY: 29 });
  assert.equal(movement.defaultPrevented, false);
  f.advance(2000);
  assert.equal(f.controller.active, false);
  f.event(f.row('a'), 'pointerup');
  f.event(f.row('a'), 'pointerdown');
  f.advance(300);
  f.event(f.document, 'scroll');
  f.advance(1500);
  assert.equal(f.controller.active, false);
  f.event(f.row('a'), 'pointerdown');
  f.event(f.document, 'pointercancel');
  f.advance(1500);
  assert.equal(f.controller.active, false);
  f.event(f.row('a'), 'pointerdown');
  f.advance(100);
  f.event(f.row('a'), 'pointerup');
  f.advance(1500);
  assert.equal(f.controller.active, false);
  assert.deepEqual(f.moves, []);
});
test('a swipe between taps breaks the double-tap sequence', (t) => {
  const f = fixture(t);
  f.tap('a');
  f.advance(10);
  f.event(f.row('a'), 'pointerdown');
  f.event(f.row('a'), 'pointermove', { clientY: 31 });
  f.event(f.row('a'), 'pointerup', { clientY: 31 });
  f.tap('a');
  assert.deepEqual(f.edits, []);
});
test('holding and continuing to drag reorders once at drop with original IDs', async (t) => {
  const f = fixture(t);
  f.event(f.row('a'), 'pointerdown', { pointerType: 'touch' });
  f.advance(1500);
  const move = f.event(f.row('a'), 'pointermove', { pointerType: 'touch', clientY: 150 });
  assert.equal(move.defaultPrevented, true);
  assert.ok(f.list.querySelector('.category-placeholder'));
  assert.ok(f.row('a').classList.contains('category-dragging'));
  assert.equal(f.moves.length, 0);
  f.event(f.row('a'), 'pointerup', { pointerType: 'touch', clientY: 150 });
  await f.tick();
  assert.deepEqual(f.order(), ['b', 'c', 'a']);
  assert.deepEqual(f.moves, [
    [
      ['b', 'c', 'a'],
      ['a', 'b', 'c'],
    ],
  ]);
  assert.equal(f.list.querySelector('.category-placeholder'), null);
  assert.equal(f.row('a').classList.contains('category-dragging'), false);
  assert.equal(f.controller.active, true);
});
test('a browser cancellation after the first hold leaves mode ready for a second touch drag', async (t) => {
  const f = fixture(t);
  f.event(f.row('a'), 'pointerdown');
  f.advance(1500);
  f.event(f.document, 'pointercancel');
  assert.equal(f.controller.active, true);
  f.event(f.row('c'), 'pointerdown', { pointerId: 2, clientY: 100 });
  f.event(f.row('c'), 'pointermove', { pointerId: 2, clientY: 5 });
  f.event(f.row('c'), 'pointerup', { pointerId: 2, clientY: 5 });
  await f.tick();
  assert.deepEqual(f.order(), ['c', 'a', 'b']);
  assert.equal(f.moves.length, 1);
});
test('cancelled drags restore DOM, clean placeholders, and never save', (t) => {
  const f = fixture(t);
  f.event(f.row('a'), 'keydown', { key: ' ' });
  f.event(f.row('a'), 'pointerdown');
  f.event(f.row('a'), 'pointermove', { clientY: 150 });
  f.event(f.document, 'pointercancel');
  assert.deepEqual(f.order(), ['a', 'b', 'c']);
  assert.equal(f.list.querySelector('.category-placeholder'), null);
  assert.deepEqual(f.moves, []);
  assert.equal(f.controller.active, true);
});
test('save rejection restores the previous order and reports the failure', async (t) => {
  const failure = new Error('保存できません');
  const f = fixture(t, { onReorder: () => Promise.reject(failure) });
  f.event(f.row('a'), 'keydown', { key: ' ' });
  f.event(f.row('a'), 'pointerdown');
  f.event(f.row('a'), 'pointermove', { clientY: 150 });
  f.event(f.row('a'), 'pointerup', { clientY: 150 });
  await f.tick();
  assert.deepEqual(f.order(), ['a', 'b', 'c']);
  assert.deepEqual(f.errors, [failure]);
  assert.equal(f.controller.busy, false);
  assert.equal(f.controller.active, true);
});
test('pending saves block additional reorder operations and recover after completion', async (t) => {
  let finish;
  const f = fixture(t, {
    onReorder: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  f.event(f.row('b'), 'keydown', { key: ' ' });
  f.event(f.row('b'), 'keydown', { key: 'ArrowUp' });
  assert.equal(f.controller.busy, true);
  f.event(f.row('b'), 'keydown', { key: 'ArrowDown' });
  f.event(f.row('a'), 'pointerdown');
  f.advance(1500);
  assert.equal(f.moves.length, 1);
  assert.deepEqual(f.order(), ['b', 'a', 'c']);
  finish();
  await f.tick();
  assert.equal(f.controller.busy, false);
});
test('keyboard arrows reorder, boundary movement does nothing, Enter and Escape exit', async (t) => {
  const f = fixture(t);
  f.event(f.row('a'), 'keydown', { key: ' ' });
  f.event(f.row('a'), 'keydown', { key: 'ArrowUp' });
  assert.equal(f.moves.length, 0);
  f.event(f.row('a'), 'keydown', { key: 'ArrowDown' });
  await f.tick();
  assert.deepEqual(f.order(), ['b', 'a', 'c']);
  assert.equal(f.moves.length, 1);
  f.event(f.row('a'), 'keydown', { key: 'Enter' });
  assert.equal(f.controller.active, false);
  assert.deepEqual(f.edits, []);
  f.event(f.row('b'), 'keydown', { key: ' ' });
  f.event(f.document, 'keydown', { key: 'Escape' });
  assert.equal(f.controller.active, false);
  assert.deepEqual(f.modes, [true, false, true, false]);
});
test('outside input interactions exit mode without preventing the input action', (t) => {
  const f = fixture(t);
  f.event(f.row('a'), 'keydown', { key: ' ' });
  const outside = f.event(f.document.getElementById('outside'), 'pointerdown');
  assert.equal(outside.defaultPrevented, false);
  assert.equal(f.controller.active, false);
  assert.equal(f.row('a').style.touchAction, '');
});
test('refresh supports replaced rows and destroy removes timers and delegated listeners', (t) => {
  const f = fixture(t);
  f.event(f.row('a'), 'pointerdown');
  const replacement = f.row('a').cloneNode(true);
  f.row('a').replaceWith(replacement);
  f.controller.refresh();
  f.advance(1500);
  assert.equal(f.controller.active, false);
  f.event(replacement, 'keydown', { key: ' ' });
  assert.equal(replacement.style.touchAction, 'none');
  f.controller.destroy();
  f.event(replacement, 'pointerdown');
  f.advance(2000);
  f.event(replacement, 'dblclick');
  assert.equal(f.controller.active, false);
  assert.deepEqual(f.edits, []);
  assert.equal(f.list.classList.contains('category-reorder-mode'), false);
});
test('edge auto-scroll reveals lower rows, preserves the drag through its own scroll events, and saves once', async (t) => {
  const f = fixture(t),
    container = scrollContainer(f);
  f.event(f.row('a'), 'keydown', { key: ' ' });
  f.event(f.row('a'), 'pointerdown', { clientY: 20 });
  f.event(f.row('a'), 'pointermove', { clientY: 58 });
  for (let frame = 0; frame < 15; frame++) {
    f.advance(16);
    f.event(container, 'scroll');
  }
  assert.equal(container.scrollTop, 60);
  assert.ok(f.list.querySelector('.category-placeholder'));
  assert.equal(f.moves.length, 0);
  f.event(f.row('a'), 'pointerup', { clientY: 58 });
  await f.tick();
  assert.deepEqual(f.order(), ['b', 'c', 'a']);
  assert.equal(f.moves.length, 1);
  assert.equal(container.style.overflowAnchor, 'auto');
  assert.equal(container.style.scrollBehavior, 'smooth');
  f.advance(1000);
  assert.equal(container.scrollTop, 60);
});
test('top-edge auto-scroll reaches earlier rows and stops after drop', async (t) => {
  const f = fixture(t),
    container = scrollContainer(f);
  container.scrollTop = 60;
  f.event(f.row('c'), 'keydown', { key: ' ' });
  f.event(f.row('c'), 'pointerdown', { clientY: 40 });
  f.event(f.row('c'), 'pointermove', { clientY: 1 });
  for (let frame = 0; frame < 15; frame++) f.advance(16);
  assert.equal(container.scrollTop, 0);
  f.event(f.row('c'), 'pointerup', { clientY: 1 });
  await f.tick();
  assert.deepEqual(f.order(), ['c', 'a', 'b']);
  assert.equal(f.moves.length, 1);
  f.advance(1000);
  assert.equal(container.scrollTop, 0);
  assert.equal(f.list.querySelector('.category-placeholder'), null);
});
test('an independent manual scroll cancels an auto-scrolling drag and its queued frame', (t) => {
  const f = fixture(t),
    container = scrollContainer(f);
  f.event(f.row('a'), 'keydown', { key: ' ' });
  f.event(f.row('a'), 'pointerdown', { clientY: 20 });
  f.event(f.row('a'), 'pointermove', { clientY: 58 });
  f.advance(16);
  assert.ok(container.scrollTop > 0);
  container.scrollTop -= 1;
  const stopped = container.scrollTop;
  assert.deepEqual(f.order(), ['a', 'b', 'c']);
  assert.equal(f.list.querySelector('.category-placeholder'), null);
  f.advance(1000);
  assert.equal(container.scrollTop, stopped);
  assert.equal(f.moves.length, 0);
  assert.equal(f.controller.active, true);
  assert.equal(container.style.overflowAnchor, 'auto');
});
test('a non-overflowing dialog never auto-scrolls its background page', (t) => {
  const f = fixture(t);
  const dialog = f.document.createElement('dialog');
  dialog.style.overflowY = 'auto';
  Object.defineProperties(dialog, { clientHeight: { value: 160 }, scrollHeight: { value: 120 } });
  f.list.parentElement.insertBefore(dialog, f.list);
  dialog.appendChild(f.list);
  const page = f.document.documentElement;
  Object.defineProperty(f.document, 'scrollingElement', { value: page });
  Object.defineProperties(page, {
    clientHeight: { value: 160 },
    scrollHeight: { value: 900 },
    clientWidth: { value: 200 },
    scrollTop: { value: 0, writable: true },
  });
  f.event(f.row('a'), 'keydown', { key: ' ' });
  f.event(f.row('a'), 'pointerdown', { clientY: 20 });
  f.event(f.row('a'), 'pointermove', { clientY: 155 });
  for (let frame = 0; frame < 15; frame++) f.advance(16);
  assert.equal(page.scrollTop, 0);
  assert.ok(f.list.querySelector('.category-placeholder'));
});
