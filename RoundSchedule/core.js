(function (root) {
  'use strict';
  const VERSION = '2.0.0';
  const SCHEMA = 2;
  const DAY = 1440;
  const DEFAULT_CATEGORIES = [
    { id: 'work', name: '仕事', color: '#2563eb' },
    { id: 'study', name: '学習', color: '#7c3aed' },
    { id: 'sleep', name: '睡眠', color: '#1e3a5a' },
    { id: 'free', name: '自由', color: '#059669' },
    { id: 'meal', name: '食事', color: '#d97706' },
    { id: 'exercise', name: '運動', color: '#dc2626' },
  ];
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const uid = () =>
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  function dateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function validDate(key) {
    if (
      typeof key !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(key) ||
      key < '1900-01-01' ||
      key > '9999-12-31'
    )
      return false;
    const d = new Date(`${key}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === key;
  }
  const dayNumber = (key) => {
    if (!validDate(key)) throw new Error('日付を正しく入力してください');
    return Date.parse(`${key}T00:00:00Z`) / 86400000;
  };
  const addDays = (key, n) => new Date((dayNumber(key) + n) * 86400000).toISOString().slice(0, 10);
  const weekday = (key) => new Date(dayNumber(key) * 86400000).getUTCDay();
  const minutes = (str) =>
    /^([01]\d|2[0-3]):[0-5]\d$/.test(str)
      ? Number(str.slice(0, 2)) * 60 + Number(str.slice(3))
      : NaN;
  const time = (min) =>
    `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  const durationText = (min) =>
    `${Math.floor(min / 60) ? `${Math.floor(min / 60)}時間` : ''}${min % 60 ? `${min % 60}分` : ''}` ||
    '0分';
  const civil = (date, min = 0) => dayNumber(date) * DAY + min;
  function epoch(date, min = 0) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d, Math.floor(min / 60), min % 60).getTime();
  }
  function interval(task) {
    if (task.kind === 'unscheduled') return [civil(task.date), civil(task.date)];
    return [
      civil(task.date, task.kind === 'allDay' ? 0 : task.startMin),
      civil(task.endDate, task.kind === 'allDay' ? DAY : task.endMin),
    ];
  }
  function initialState() {
    return {
      schemaVersion: SCHEMA,
      revision: 0,
      updatedAt: null,
      tasks: [],
      categories: copy(DEFAULT_CATEGORIES),
      templates: [],
      settings: { notifications: false, lead: 5, theme: 'system', fontSize: 'normal', clock: '24' },
    };
  }
  function safeText(v, max, label, optional = false) {
    if (optional && (v === undefined || v === null)) return '';
    if (typeof v !== 'string' || (!optional && !v.trim()) || Array.from(v).length > max)
      throw new Error(`${label}は${max}文字以内で入力してください`);
    return v.trim();
  }
  function taskValue(input, categories, { legacy = false, today = dateKey() } = {}) {
    if (!input || typeof input !== 'object') throw new Error('予定の形式が不正です');
    const kind = input.kind || 'timed';
    if (!['timed', 'allDay', 'unscheduled'].includes(kind)) throw new Error('予定の種類が不正です');
    const date = input.date || (legacy ? today : '');
    if (!validDate(date)) throw new Error('開始日を正しく入力してください');
    let endDate =
      input.endDate ||
      (kind === 'timed' && input.endMin <= input.startMin ? addDays(date, 1) : date);
    if (!validDate(endDate)) throw new Error('終了日を正しく入力してください');
    const startMin = kind === 'timed' ? input.startMin : 0,
      endMin = kind === 'timed' ? input.endMin : 0;
    if (![startMin, endMin].every((n) => Number.isInteger(n) && n >= 0 && n < DAY))
      throw new Error('時刻を正しく入力してください');
    if (!categories.some((c) => c.id === input.categoryId))
      throw new Error('カテゴリーが存在しません');
    const id = safeText(input.id, 150, '予定ID');
    const result = {
      id,
      name: safeText(input.name, 80, '予定名'),
      date,
      endDate,
      startMin,
      endMin,
      categoryId: input.categoryId,
      kind,
      notes: safeText(input.notes, 2000, 'メモ', true),
      location: safeText(input.location, 200, '場所', true),
      url: safeText(input.url, 2000, 'リンク', true),
      status: input.status || 'planned',
      notification: input.notification ?? 'default',
      repeat: null,
    };
    if (!['planned', 'done', 'cancelled'].includes(result.status))
      throw new Error('予定の状態が不正です');
    if (!['default', 'off', 0, 1, 5, 10, 15, 30, 60].includes(result.notification))
      throw new Error('通知設定が不正です');
    if (result.url && !/^https?:\/\//i.test(result.url))
      throw new Error('リンクはhttps://またはhttp://で入力してください');
    if (result.url) {
      try {
        new URL(result.url);
      } catch {
        throw new Error('リンクを正しく入力してください');
      }
    }
    const [start, end] = interval(result);
    if (kind === 'unscheduled') result.endDate = date;
    else if (end <= start || end - start > 7 * DAY)
      throw new Error('終了は開始より後、7日以内にしてください');
    if (input.repeat) {
      const r = input.repeat;
      if (
        !Array.isArray(r.days) ||
        !r.days.length ||
        r.days.some((n) => !Number.isInteger(n) || n < 0 || n > 6) ||
        !validDate(r.until) ||
        r.until < date ||
        dayNumber(r.until) - dayNumber(date) > 366
      )
        throw new Error('繰り返しは曜日と1年以内の終了日を指定してください');
      if (
        r.exceptions !== undefined &&
        (!Array.isArray(r.exceptions) || r.exceptions.some((d) => !validDate(d)))
      )
        throw new Error('繰り返しの除外日が不正です');
      result.repeat = {
        days: [...new Set(r.days)].sort(),
        until: r.until,
        exceptions: [...new Set(r.exceptions || [])],
      };
    }
    return result;
  }
  function normalize(raw, { today = dateKey() } = {}) {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !Array.isArray(raw.tasks) ||
      !Array.isArray(raw.categories) ||
      raw.categories.length === 0
    )
      throw new Error(
        '予定・カテゴリーのデータ形式が不正です。元データを保存して復旧してください。'
      );
    if (raw.schemaVersion && raw.schemaVersion > SCHEMA)
      throw new Error('新しいバージョンのデータです。アプリを更新してください。');
    const legacy = !raw.schemaVersion,
      issues = [],
      state = initialState();
    state.categories = [];
    const collect = (items, make, label) => {
      const result = [],
        seen = new Set();
      for (let i = 0; i < items.length; i++) {
        try {
          const v = make(items[i]);
          if (seen.has(v.id)) throw new Error('IDが重複しています');
          seen.add(v.id);
          result.push(v);
        } catch (e) {
          issues.push(`${label}${i + 1}: ${e.message}`);
        }
      }
      return result;
    };
    state.categories = collect(
      raw.categories,
      (c) => {
        if (!c || !/^#[0-9a-f]{6}$/i.test(c.color)) throw new Error('色が不正です');
        return {
          id: safeText(c.id, 150, 'カテゴリーID'),
          name: safeText(c.name, 40, 'カテゴリー名'),
          color: c.color,
        };
      },
      'カテゴリー'
    );
    if (!state.categories.length) throw new Error('有効なカテゴリーがありません');
    state.tasks = collect(
      raw.tasks,
      (t) => taskValue(t, state.categories, { legacy, today }),
      '予定'
    );
    if (raw.templates !== undefined && !Array.isArray(raw.templates))
      issues.push('テンプレートの形式が不正です');
    state.templates = collect(
      Array.isArray(raw.templates) ? raw.templates : [],
      (t) => {
        if (!t || !Array.isArray(t.tasks) || t.tasks.length > 1000)
          throw new Error('テンプレートの内容が不正です');
        return {
          id: safeText(t.id, 150, 'テンプレートID'),
          name: safeText(t.name, 60, 'テンプレート名'),
          tasks: t.tasks.map((x, i) => {
            const offset = x.endOffset ?? (x.endMin <= x.startMin ? 1 : 0);
            if (!Number.isInteger(offset) || offset < 0 || offset > 7)
              throw new Error('テンプレートの期間が不正です');
            const v = taskValue(
              {
                ...x,
                id: `entry-${i}`,
                date: '2000-01-01',
                endDate: addDays('2000-01-01', offset),
                repeat: null,
              },
              state.categories
            );
            return templateEntry(v);
          }),
        };
      },
      'テンプレート'
    );
    state.revision = Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
    state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
    const s = raw.settings || {};
    state.settings = {
      notifications: s.notifications === true,
      lead: [0, 1, 5, 10, 15, 30, 60].includes(s.lead) ? s.lead : 5,
      theme: ['system', 'light', 'dark'].includes(s.theme) ? s.theme : 'system',
      fontSize: s.fontSize === 'large' ? 'large' : 'normal',
      clock: s.clock === '12' ? '12' : '24',
    };
    return { state, issues, migrated: legacy };
  }
  function strictState(raw) {
    const n = normalize(raw);
    if (n.issues.length) throw new Error(n.issues.join('\n'));
    return n.state;
  }
  function occurrences(tasks, from, to = from) {
    const lo = civil(from),
      hi = civil(addDays(to, 1)),
      result = [];
    for (const task of tasks) {
      const dates = [];
      if (!task.repeat) dates.push(task.date);
      else {
        let d = task.date > addDays(from, -7) ? task.date : addDays(from, -7);
        const last = task.repeat.until < to ? task.repeat.until : to;
        for (; d <= last; d = addDays(d, 1))
          if (task.repeat.days.includes(weekday(d)) && !task.repeat.exceptions.includes(d))
            dates.push(d);
      }
      const offset = dayNumber(task.endDate) - dayNumber(task.date);
      for (const d of dates) {
        const occ = {
          ...task,
          date: d,
          endDate: addDays(d, offset),
          taskId: task.id,
          key: `${task.id}@${d}`,
        };
        const [start, end] = interval(occ);
        if (task.kind === 'unscheduled' ? start >= lo && start < hi : start < hi && lo < end)
          result.push(occ);
      }
    }
    return result.sort(
      (a, b) =>
        civil(a.date, a.startMin) - civil(b.date, b.startMin) || a.name.localeCompare(b.name, 'ja')
    );
  }
  function daySegments(tasks, date) {
    const lo = civil(date),
      hi = lo + DAY;
    return occurrences(tasks, date).map((o) => {
      const [s, e] = interval(o);
      return { ...o, clipStart: Math.max(lo, s) - lo, clipEnd: Math.min(hi, e) - lo };
    });
  }
  function conflicts(tasks, candidate, ignoredId = null) {
    if (candidate.kind !== 'timed' || candidate.status === 'cancelled') return [];
    const from = candidate.date,
      to = candidate.repeat?.until || candidate.endDate;
    const mine = occurrences([candidate], from, addDays(to, 7));
    const others = occurrences(
      tasks.filter((t) => t.id !== ignoredId && t.kind === 'timed' && t.status !== 'cancelled'),
      from,
      addDays(to, 7)
    );
    return others.filter((b) => {
      const [bs, be] = interval(b);
      return mine.some((a) => {
        const [as, ae] = interval(a);
        return as < be && bs < ae;
      });
    });
  }
  function assertAvailable(tasks, candidate, ignoredId = null) {
    const hits = conflicts(tasks, candidate, ignoredId);
    if (hits.length)
      throw new Error(
        `「${hits[0].name}」（${hits[0].date} ${time(hits[0].startMin)}〜${time(hits[0].endMin)}）と重なっています`
      );
  }
  function templateEntry(t) {
    const { id, date, endDate, repeat, taskId, key, clipStart, clipEnd, ...rest } = t;
    return { ...rest, status: 'planned', endOffset: dayNumber(endDate) - dayNumber(date) };
  }
  function applyTemplate(state, template, date, mode) {
    const next = copy(state);
    if (mode === 'replace') {
      // Only starts on this date are replaced. A carry-over belongs to its start date.
      next.tasks = next.tasks
        .filter((t) => t.repeat || t.date !== date)
        .map((t) =>
          t.repeat && occurrences([t], date).some((o) => o.date === date)
            ? {
                ...t,
                repeat: { ...t.repeat, exceptions: [...new Set([...t.repeat.exceptions, date])] },
              }
            : t
        );
    }
    for (const entry of template.tasks) {
      const t = taskValue(
        { ...entry, id: uid(), date, endDate: addDays(date, entry.endOffset), repeat: null },
        next.categories
      );
      assertAvailable(next.tasks, t);
      next.tasks.push(t);
    }
    return next;
  }
  function nextFree(tasks, date, length = 30, start = 0) {
    const busy = daySegments(tasks, date)
      .filter((t) => t.kind === 'timed' && t.status !== 'cancelled')
      .sort((a, b) => a.clipStart - b.clipStart);
    let cursor = start;
    for (const b of busy) {
      if (cursor + length <= b.clipStart) break;
      if (b.clipEnd > cursor) cursor = b.clipEnd;
    }
    return cursor + length <= DAY ? cursor : null;
  }
  function summary(tasks, date) {
    const segments = daySegments(tasks, date).filter(
      (t) => t.status !== 'cancelled' && t.kind === 'timed'
    );
    const byCategory = {};
    for (const t of segments)
      byCategory[t.categoryId] = (byCategory[t.categoryId] || 0) + t.clipEnd - t.clipStart;
    const ranges = segments.map((t) => [t.clipStart, t.clipEnd]).sort((a, b) => a[0] - b[0]);
    let occupied = 0,
      end = 0;
    for (const [s, e] of ranges) {
      occupied += Math.max(0, e - Math.max(s, end));
      end = Math.max(end, e);
    }
    return { occupied, free: DAY - occupied, byCategory };
  }
  function notificationCandidates(state, now, horizon = 3600000) {
    if (!state.settings.notifications) return [];
    const from = dateKey(new Date(now - 86400000)),
      to = dateKey(new Date(now + horizon + 86400000));
    return occurrences(state.tasks, from, to)
      .filter((t) => t.kind === 'timed' && t.status === 'planned' && t.notification !== 'off')
      .map((t) => {
        const lead = t.notification === 'default' ? state.settings.lead : t.notification;
        const start = epoch(t.date, t.startMin),
          due = start - lead * 60000;
        return { task: t, start, due, key: `${t.key}:${start}:${lead}` };
      })
      .filter((n) => n.due <= now + horizon && n.start + 60000 >= now && n.due >= now - 60000);
  }
  const escapeICS = (v) =>
    String(v)
      .replace(/\\/g, '\\\\')
      .replace(/\r?\n/g, '\\n')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,');
  const unescapeICS = (v) => v.replace(/\\([nN,;\\])/g, (_, c) => (/[nN]/.test(c) ? '\n' : c));
  function exportICS(tasks, from, to) {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Daily Schedule//JA',
      'CALSCALE:GREGORIAN',
    ];
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    for (const o of occurrences(tasks, from, to).filter((t) => t.kind !== 'unscheduled')) {
      lines.push('BEGIN:VEVENT', `UID:${escapeICS(o.key)}@daily-schedule`, `DTSTAMP:${stamp}`);
      if (o.kind === 'allDay')
        lines.push(
          `DTSTART;VALUE=DATE:${o.date.replaceAll('-', '')}`,
          `DTEND;VALUE=DATE:${addDays(o.endDate, 1).replaceAll('-', '')}`
        );
      else
        lines.push(
          `DTSTART:${o.date.replaceAll('-', '')}T${time(o.startMin).replace(':', '')}00`,
          `DTEND:${o.endDate.replaceAll('-', '')}T${time(o.endMin).replace(':', '')}00`
        );
      lines.push(
        `SUMMARY:${escapeICS(o.name)}`,
        `DESCRIPTION:${escapeICS(o.notes)}`,
        `LOCATION:${escapeICS(o.location)}`
      );
      if (o.url) lines.push(`URL:${escapeICS(o.url)}`);
      if (o.status === 'cancelled') lines.push('STATUS:CANCELLED');
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    // RFC 5545: fold at 75 octets, including the continuation space.
    return (
      lines
        .map((line) => {
          let out = '',
            part = '',
            bytes = 0;
          for (const c of line) {
            const n = new TextEncoder().encode(c).length;
            if (bytes + n > 75) {
              out += part + '\r\n';
              part = ' ';
              bytes = 1;
            }
            part += c;
            bytes += n;
          }
          return out + part;
        })
        .join('\r\n') + '\r\n'
    );
  }
  function importICS(text, categoryId, categories) {
    const unfolded = text.replace(/\r?\n[ \t]/g, '');
    if (!unfolded.includes('BEGIN:VCALENDAR')) throw new Error('カレンダーファイルではありません');
    const events = [...unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)];
    if (events.length > 3000) throw new Error('一度に取り込めるのは3000件までです');
    return events.map(([_, body]) => {
      const props = {};
      for (const line of body.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const key = line.slice(0, i),
          name = key.split(';')[0];
        props[name] = { key, value: line.slice(i + 1) };
      }
      if (props.RRULE || props.RECURRENCE_ID || props.EXDATE)
        throw new Error('繰り返し付きICSは未対応です。予定を展開して書き出してください。');
      function parse(p) {
        if (!p) throw new Error('開始・終了日時のない予定があります');
        if (p.key.includes('TZID='))
          throw new Error(
            'TZID指定のICSは未対応です。UTCまたは端末の現地時刻で書き出してください。'
          );
        const v = p.value;
        if (/^\d{8}$/.test(v)) {
          if (!validDate(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`))
            throw new Error('日付が不正です');
          return {
            date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`,
            min: 0,
            allDay: true,
          };
        }
        if (!/^\d{8}T\d{6}Z?$/.test(v)) throw new Error('日時形式が未対応です');
        const date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`,
          min = minutes(`${v.slice(9, 11)}:${v.slice(11, 13)}`);
        if (!validDate(date) || !Number.isFinite(min)) throw new Error('日時が不正です');
        if (v.slice(13, 15) !== '00')
          throw new Error('秒単位のICSは未対応です。分単位で書き出してください。');
        if (v.endsWith('Z')) {
          const d = new Date(`${date}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`);
          if (!Number.isFinite(d.getTime())) throw new Error('日時が不正です');
          return { date: dateKey(d), min: d.getHours() * 60 + d.getMinutes(), allDay: false };
        }
        return { date, min, allDay: false };
      }
      const start = parse(props.DTSTART),
        end = parse(props.DTEND);
      if (start.allDay !== end.allDay) throw new Error('開始と終了の日時形式を揃えてください');
      return taskValue(
        {
          id: uid(),
          name: unescapeICS(props.SUMMARY?.value || '予定'),
          date: start.date,
          endDate: start.allDay ? addDays(end.date, -1) : end.date,
          startMin: start.min,
          endMin: end.min,
          kind: start.allDay ? 'allDay' : 'timed',
          categoryId,
          notes: unescapeICS(props.DESCRIPTION?.value || ''),
          location: unescapeICS(props.LOCATION?.value || ''),
          url: unescapeICS(props.URL?.value || ''),
          status: props.STATUS?.value === 'CANCELLED' ? 'cancelled' : 'planned',
        },
        categories
      );
    });
  }
  const API = {
    VERSION,
    SCHEMA,
    DAY,
    copy,
    uid,
    dateKey,
    validDate,
    dayNumber,
    addDays,
    weekday,
    minutes,
    time,
    durationText,
    civil,
    epoch,
    interval,
    initialState,
    taskValue,
    normalize,
    strictState,
    occurrences,
    daySegments,
    conflicts,
    assertAvailable,
    templateEntry,
    applyTemplate,
    nextFree,
    summary,
    notificationCandidates,
    exportICS,
    importICS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.ScheduleCore = API;
})(globalThis);
