(function (root) {
  'use strict';
  function create({
    list,
    onReorder,
    onEdit = () => {},
    onModeChange = () => {},
    onError = () => {},
    holdDelay = 1500,
    moveThreshold = 8,
    doubleTapDelay = 300,
    tapDistance = 24,
    scrollEdge = 48,
    scrollSpeed = 600,
    now = () => root.performance?.now?.() ?? Date.now(),
    setTimeout: later = root.setTimeout.bind(root),
    clearTimeout: clearLater = root.clearTimeout.bind(root),
    requestAnimationFrame: nextFrame = root.requestAnimationFrame?.bind(root) ||
      ((callback) => later(() => callback(now()), 16)),
    cancelAnimationFrame: cancelFrame = root.cancelAnimationFrame?.bind(root) || clearLater,
  } = {}) {
    if (!list?.ownerDocument || typeof onReorder !== 'function')
      throw new Error('カテゴリー一覧と onReorder を指定してください');
    const document = list.ownerDocument;
    const view = document.defaultView || root;
    const originalTouchAction = new WeakMap();
    const listeners = [];
    let active = false,
      busy = false,
      destroyed = false,
      gesture = null,
      holdTimer = null,
      lastTap = null,
      lastEdit = null,
      selectedId = null;
    const rows = () =>
      [...list.querySelectorAll('[data-category-id]')].filter((row) => row.parentElement === list);
    const ids = () => rows().map((row) => row.dataset.categoryId);
    const find = (id) => rows().find((row) => row.dataset.categoryId === id);
    function rowOf(target) {
      const row = target?.closest?.('[data-category-id]');
      return row?.parentElement === list ? row : null;
    }
    function listen(target, name, handler, options) {
      target.addEventListener(name, handler, options);
      listeners.push(() => target.removeEventListener(name, handler, options));
    }
    function report(error) {
      if (destroyed) return;
      try {
        onError(error);
      } catch {
        /* Reporting must not strand the drag state. */
      }
    }
    function clearHold() {
      if (holdTimer !== null) clearLater(holdTimer);
      holdTimer = null;
      gesture?.row.classList.remove('category-pressing');
    }
    function paintMode() {
      list.classList.toggle('category-reorder-mode', active);
      list.classList.toggle('category-reorder-busy', busy);
      for (const row of rows()) {
        if (!originalTouchAction.has(row))
          originalTouchAction.set(row, row.style.touchAction || '');
        row.style.touchAction = active ? 'none' : originalTouchAction.get(row);
        row.classList.toggle(
          'category-reorder-selected',
          active && row.dataset.categoryId === selectedId
        );
      }
    }
    function setMode(enabled) {
      if (active === enabled) return;
      active = enabled;
      lastTap = null;
      paintMode();
      try {
        onModeChange(enabled);
      } catch (error) {
        report(error);
      }
    }
    function restoreOrder(order) {
      const current = rows();
      const lookup = new Map(current.map((row) => [row.dataset.categoryId, row]));
      // Preserve categories added by a render while a save was awaiting its result.
      for (const id of [
        ...order,
        ...current.map((row) => row.dataset.categoryId).filter((id) => !order.includes(id)),
      ]) {
        const row = lookup.get(id);
        if (row) list.appendChild(row);
      }
    }
    function releaseCapture(current) {
      try {
        if (current?.row.hasPointerCapture?.(current.pointerId))
          current.row.releasePointerCapture(current.pointerId);
      } catch {
        /* The browser may already have released a cancelled pointer. */
      }
    }
    function capture(current) {
      try {
        current.row.setPointerCapture?.(current.pointerId);
      } catch {
        /* Unsupported devices keep document listeners. */
      }
    }
    function scrollParent() {
      for (let node = list; node && node !== document.documentElement; node = node.parentElement) {
        const overflow = view.getComputedStyle?.(node)?.overflowY || node.style?.overflowY || '';
        if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll|overlay/.test(overflow))
          return node;
        // A short modal must never scroll the page underneath it.
        if (node.tagName === 'DIALOG') return null;
      }
      const page = document.scrollingElement;
      return page?.scrollHeight > page?.clientHeight + 1 ? page : null;
    }
    function stopAutoScroll(current) {
      if (!current) return;
      if (current.scrollFrame !== undefined && current.scrollFrame !== null)
        cancelFrame(current.scrollFrame);
      current.scrollFrame = null;
      if (current.scrollStyles && current.scrollParent) {
        Object.assign(current.scrollParent.style, current.scrollStyles);
        current.scrollStyles = null;
      }
    }
    function scrollVelocity(current) {
      const container = current.scrollParent;
      if (!container) return 0;
      const viewportHeight = view.innerHeight || document.documentElement.clientHeight;
      const rect =
        container === document.scrollingElement
          ? {
              top: 0,
              bottom: viewportHeight || container.clientHeight,
              left: 0,
              right: view.innerWidth || container.clientWidth,
            }
          : container.getBoundingClientRect();
      const top = Math.max(0, rect.top),
        bottom = Math.min(rect.bottom, viewportHeight || rect.bottom);
      if (
        bottom <= top ||
        current.lastX < rect.left - scrollEdge ||
        current.lastX > rect.right + scrollEdge
      )
        return 0;
      const edge = Math.min(scrollEdge, (bottom - top) / 3);
      if (edge <= 0) return 0;
      if (current.lastY < top + edge && container.scrollTop > 0)
        return -scrollSpeed * Math.min(1, (top + edge - current.lastY) / edge);
      if (
        current.lastY > bottom - edge &&
        container.scrollTop < container.scrollHeight - container.clientHeight
      )
        return scrollSpeed * Math.min(1, (current.lastY - bottom + edge) / edge);
      return 0;
    }
    function queueAutoScroll(current) {
      if (!current.scrollParent || current.scrollFrame != null || !scrollVelocity(current)) return;
      current.scrollFrame = nextFrame((timestamp) => {
        current.scrollFrame = null;
        if (gesture !== current || !current.drag || destroyed || !active) return;
        if (current.row.parentElement !== list) {
          cancelDrag();
          return;
        }
        const speed = scrollVelocity(current);
        if (!speed) {
          current.lastFrameAt = null;
          return;
        }
        const elapsed =
          current.lastFrameAt == null
            ? 16
            : Math.min(48, Math.max(1, timestamp - current.lastFrameAt));
        current.lastFrameAt = timestamp;
        const container = current.scrollParent;
        const next = Math.max(
          0,
          Math.min(
            container.scrollHeight - container.clientHeight,
            container.scrollTop + (speed * elapsed) / 1000
          )
        );
        current.writingScroll = true;
        try {
          container.scrollTop = next;
        } finally {
          current.writingScroll = false;
        }
        current.ownScroll = { top: container.scrollTop, left: container.scrollLeft || 0 };
        moveDrag(current, current.lastY);
        queueAutoScroll(current);
      });
    }
    function onScroll(event) {
      const current = gesture;
      const isOwnContainer =
        current?.drag &&
        (event.target === current.scrollParent ||
          (event.target === document && current.scrollParent === document.scrollingElement));
      if (
        isOwnContainer &&
        (current.writingScroll ||
          (current.ownScroll &&
            current.scrollParent.scrollTop === current.ownScroll.top &&
            (current.scrollParent.scrollLeft || 0) === current.ownScroll.left))
      )
        return;
      cancelDrag();
    }
    function removeDrag(current, restore = false) {
      if (!current?.drag) return false;
      stopAutoScroll(current);
      const attached =
        current.placeholder.parentElement === list && current.row.parentElement === list;
      if (attached) current.placeholder.replaceWith(current.row);
      else current.placeholder.remove();
      current.row.classList.remove('category-dragging');
      current.row.removeAttribute('aria-grabbed');
      if (current.previousStyle === null) current.row.removeAttribute('style');
      else current.row.setAttribute('style', current.previousStyle);
      if (restore && attached) restoreOrder(current.originalIds);
      return attached;
    }
    function cancelDrag() {
      const current = gesture;
      clearHold();
      gesture = null;
      lastTap = null;
      removeDrag(current, true);
      releaseCapture(current);
      if (!destroyed) paintMode();
    }
    function exit() {
      cancelDrag();
      selectedId = null;
      setMode(false);
    }
    function edit(id) {
      if (destroyed || active || busy) return;
      const instant = now();
      // Pointer-based double taps also produce native dblclick on many browsers.
      if (lastEdit?.id === id && instant - lastEdit.time < doubleTapDelay + 100) return;
      lastEdit = { id, time: instant };
      lastTap = null;
      try {
        Promise.resolve(onEdit(id)).catch(report);
      } catch (error) {
        report(error);
      }
    }
    async function persist(originalIds, focusId = null) {
      const order = ids();
      if (
        order.length === originalIds.length &&
        order.every((id, index) => id === originalIds[index])
      )
        return;
      busy = true;
      paintMode();
      try {
        await onReorder([...order], [...originalIds]);
      } catch (error) {
        if (!destroyed) {
          restoreOrder(originalIds);
          report(error);
        }
      } finally {
        busy = false;
        if (!destroyed) {
          paintMode();
          if (focusId) find(focusId)?.focus?.({ preventScroll: true });
        }
      }
    }
    function startDrag(current) {
      if (current.row.parentElement !== list) return false;
      current.originalIds = ids();
      current.previousStyle = current.row.getAttribute('style');
      current.rect = current.row.getBoundingClientRect();
      current.offsetY = current.y - current.rect.top;
      const placeholder = document.createElement('div');
      placeholder.className = 'category-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.style.height = `${current.rect.height}px`;
      placeholder.style.width = `${current.rect.width}px`;
      list.insertBefore(placeholder, current.row);
      current.placeholder = placeholder;
      current.drag = true;
      current.row.classList.add('category-dragging');
      current.row.setAttribute('aria-grabbed', 'true');
      Object.assign(current.row.style, {
        position: 'fixed',
        left: `${current.rect.left}px`,
        top: `${current.rect.top}px`,
        width: `${current.rect.width}px`,
        height: `${current.rect.height}px`,
        zIndex: '1000',
        pointerEvents: 'none',
        margin: '0',
        transform: 'none',
        animation: 'none',
      });
      current.scrollParent = scrollParent();
      if (current.scrollParent) {
        current.scrollStyles = {
          overflowAnchor: current.scrollParent.style.overflowAnchor || '',
          scrollBehavior: current.scrollParent.style.scrollBehavior || '',
        };
        current.scrollParent.style.overflowAnchor = 'none';
        current.scrollParent.style.scrollBehavior = 'auto';
      }
      capture(current);
      return true;
    }
    function moveDrag(current, y) {
      current.row.style.top = `${y - current.offsetY}px`;
      const next = rows().find((row) => {
        if (row === current.row) return false;
        const rect = row.getBoundingClientRect();
        return y < rect.top + rect.height / 2;
      });
      list.insertBefore(current.placeholder, next || null);
    }
    function pointerDown(event) {
      if (destroyed || busy) return;
      if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) {
        if (event.isPrimary === false) cancelDrag();
        return;
      }
      const row = rowOf(event.target);
      if (!row) return;
      if (gesture) cancelDrag();
      const current = {
        row,
        id: row.dataset.categoryId,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startedAt: now(),
        moved: false,
        drag: false,
        held: false,
      };
      gesture = current;
      if (active) {
        selectedId = current.id;
        paintMode();
        capture(current);
      } else {
        row.classList.add('category-pressing');
        holdTimer = later(() => {
          holdTimer = null;
          if (
            destroyed ||
            busy ||
            gesture !== current ||
            current.moved ||
            row.parentElement !== list
          )
            return;
          row.classList.remove('category-pressing');
          current.held = true;
          selectedId = current.id;
          setMode(true);
          capture(current);
        }, holdDelay);
      }
    }
    function pointerMove(event) {
      const current = gesture;
      if (!current || current.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - current.x, event.clientY - current.y);
      if (distance > moveThreshold) {
        current.moved = true;
        lastTap = null;
        clearHold();
      }
      if (!active || !current.moved) return;
      if (current.row.parentElement !== list) {
        cancelDrag();
        return;
      }
      if (event.cancelable) event.preventDefault();
      if (!current.drag && !startDrag(current)) return;
      current.lastX = event.clientX;
      current.lastY = event.clientY;
      moveDrag(current, event.clientY);
      queueAutoScroll(current);
    }
    function pointerUp(event) {
      const current = gesture;
      if (!current || current.pointerId !== event.pointerId) return;
      clearHold();
      gesture = null;
      releaseCapture(current);
      if (current.drag) {
        const attached = removeDrag(current);
        paintMode();
        if (attached) void persist(current.originalIds);
        return;
      }
      if (
        active ||
        current.held ||
        current.moved ||
        current.row.parentElement !== list ||
        Math.hypot(event.clientX - current.x, event.clientY - current.y) > moveThreshold ||
        now() - current.startedAt >= holdDelay
      ) {
        lastTap = null;
        return;
      }
      const instant = now();
      if (
        lastTap?.id === current.id &&
        instant - lastTap.time <= doubleTapDelay &&
        Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= tapDistance
      ) {
        edit(current.id);
      } else lastTap = { id: current.id, time: instant, x: event.clientX, y: event.clientY };
    }
    function pointerCancel(event) {
      if (gesture && (event.pointerId === undefined || event.pointerId === gesture.pointerId))
        cancelDrag();
    }
    function keyDown(event) {
      if (event.key === 'Escape') {
        if (active || gesture) {
          event.preventDefault();
          exit();
        }
        return;
      }
      const row = rowOf(event.target);
      if (!row || destroyed || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.repeat && [' ', 'Enter', 'F2'].includes(event.key)) {
        event.preventDefault();
        return;
      }
      if (busy) {
        if ([' ', 'Enter', 'ArrowUp', 'ArrowDown', 'F2'].includes(event.key))
          event.preventDefault();
        return;
      }
      if (!active) {
        if (event.key === ' ') {
          event.preventDefault();
          cancelDrag();
          selectedId = row.dataset.categoryId;
          setMode(true);
        } else if (event.key === 'Enter' || event.key === 'F2') {
          event.preventDefault();
          edit(row.dataset.categoryId);
        }
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        exit();
        return;
      }
      if (event.key === ' ' || event.key === 'F2') {
        event.preventDefault();
        return;
      }
      if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      cancelDrag();
      const currentRows = rows(),
        index = currentRows.indexOf(row),
        direction = event.key === 'ArrowUp' ? -1 : 1;
      if (index + direction < 0 || index + direction >= currentRows.length) return;
      const originalIds = ids();
      selectedId = row.dataset.categoryId;
      if (direction < 0) list.insertBefore(row, currentRows[index - 1]);
      else list.insertBefore(row, currentRows[index + 1].nextSibling);
      void persist(originalIds, selectedId);
    }
    listen(list, 'pointerdown', pointerDown);
    listen(document, 'pointermove', pointerMove, { passive: false });
    listen(document, 'pointerup', pointerUp);
    listen(document, 'pointercancel', pointerCancel);
    listen(list, 'lostpointercapture', pointerCancel);
    listen(document, 'scroll', onScroll, true);
    listen(document, 'keydown', keyDown);
    listen(
      document,
      'pointerdown',
      (event) => {
        if (active && !rowOf(event.target)) exit();
      },
      true
    );
    listen(
      list,
      'touchmove',
      (event) => {
        // touch-action is evaluated at touch start. This also supports a continued
        // drag immediately after a stationary long press where the browser permits it.
        if (active && gesture && event.cancelable) event.preventDefault();
      },
      { passive: false }
    );
    listen(list, 'dblclick', (event) => {
      const row = rowOf(event.target);
      if (!row) return;
      event.preventDefault();
      edit(row.dataset.categoryId);
    });
    for (const name of ['click', 'contextmenu', 'dragstart'])
      listen(list, name, (event) => {
        if (rowOf(event.target)) event.preventDefault();
      });
    paintMode();
    return {
      exit,
      cancelDrag,
      refresh() {
        if (gesture && gesture.row.parentElement !== list) cancelDrag();
        if (!destroyed) paintMode();
      },
      destroy() {
        if (destroyed) return;
        exit();
        destroyed = true;
        for (const remove of listeners) remove();
        list.classList.remove('category-reorder-busy');
      },
      get active() {
        return active;
      },
      get busy() {
        return busy;
      },
    };
  }
  const API = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.ScheduleCategoryInteractions = API;
})(globalThis);
