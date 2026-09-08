(function () {
  'use strict';
  const status = document.getElementById('update-status');
  const retry = document.getElementById('retry-update');
  const updater = ScheduleUpdates.create({
    baseURL: location.href,
    onProgress: (message) => {
      status.textContent = message;
    },
  });
  async function update() {
    retry.hidden = true;
    try {
      await updater.check();
      status.textContent = '更新しました';
      location.replace(new URL('./RoundSchedule.html', location.href).href);
    } catch (error) {
      status.textContent = error.message;
      retry.hidden = false;
    }
  }
  retry.addEventListener('click', update);
  update();
})();
