(function (root) {
  'use strict';
  const C =
    typeof module !== 'undefined' && module.exports ? require('./core.js') : root.ScheduleCore;
  class NotificationManager {
    constructor(
      repo,
      {
        clock = () => Date.now(),
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        permission = () => root.Notification?.permission,
        show = null,
        onError = () => {},
      } = {}
    ) {
      this.repo = repo;
      this.clock = clock;
      this.setTimer = setTimer;
      this.clearTimer = clearTimer;
      this.permission = permission;
      this.show = show || this.showNative.bind(this);
      this.onError = onError;
      this.timers = [];
      this.generation = 0;
    }
    stop() {
      this.generation++;
      this.timers.forEach((t) => this.clearTimer(t));
      this.timers = [];
    }
    refresh(state) {
      this.stop();
      if (this.permission() !== 'granted') return;
      const generation = this.generation;
      for (const event of C.notificationCandidates(state, this.clock()))
        this.timers.push(
          this.setTimer(
            () => {
              if (generation === this.generation) this.deliver(event).catch(this.onError);
            },
            Math.max(0, event.due - this.clock())
          )
        );
    }
    async deliver(event) {
      if (this.permission() !== 'granted') return false;
      const state = await this.repo.read(),
        now = this.clock();
      const current = C.notificationCandidates(state, now).find((n) => n.key === event.key);
      if (!current || current.due > now + 1000) return false;
      if (!(await this.repo.claimNotice(event.key, now))) return false;
      try {
        await this.show('予定のお知らせ', {
          body: `「${current.task.name}」 ${current.task.date} ${C.time(current.task.startMin)}開始`,
          tag: event.key,
          icon: './icon-192.png',
          badge: './icon-192.png',
          data: { date: current.task.date, taskId: current.task.taskId },
        });
        return true;
      } catch (e) {
        await this.repo.releaseNotice(event.key);
        throw new Error(`通知を表示できませんでした。${e.message || ''}`);
      }
    }
    async showNative(title, options) {
      if (root.navigator?.serviceWorker) {
        const registration = await root.navigator.serviceWorker.getRegistration();
        if (registration?.active && registration.showNotification) {
          await registration.showNotification(title, options);
          return;
        }
      }
      if (!root.Notification) throw new Error('このブラウザーは通知に対応していません');
      const n = new root.Notification(title, options);
      n.onclick = () => {
        root.focus();
        const url = new URL('./RoundSchedule.html', root.location.href);
        url.searchParams.set('date', options.data.date);
        if (options.data.taskId) url.searchParams.set('task', options.data.taskId);
        root.location.href = url.href;
        n.close();
      };
    }
    test() {
      return this.show('Daily Schedule', {
        body: '通知のテストです。',
        tag: 'daily-schedule-test',
        icon: './icon-192.png',
        data: { date: C.dateKey() },
      });
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { NotificationManager };
  else root.ScheduleNotifications = { NotificationManager };
})(globalThis);
