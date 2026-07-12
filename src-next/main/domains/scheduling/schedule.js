'use strict';

function nextTaskRun(task, fromMs) {
  const from = Number(fromMs) || Date.now();
  if (task.schedule === 'interval') return (Number(task.lastRun) || from) + Math.max(5, parseInt(task.everyMin, 10) || 60) * 60000;
  const [rawHour, rawMinute] = String(task.time || '09:00').split(':');
  const hour = Math.min(23, Math.max(0, parseInt(rawHour, 10) || 0));
  const minute = Math.min(59, Math.max(0, parseInt(rawMinute, 10) || 0));
  const date = new Date(from);
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
  if (task.schedule === 'weekly') {
    const day = Math.min(6, Math.max(0, parseInt(task.dow, 10) || 0));
    while (next.getDay() !== day || next.getTime() <= from) next.setDate(next.getDate() + 1);
  } else if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
}

module.exports = { nextTaskRun };
