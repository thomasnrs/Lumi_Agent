'use strict';

const { clone } = require('../../../shared/schema');
const { nextTaskRun } = require('./schedule');

function normalizeReminder(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '');
  const at = Number(value.at);
  const message = String(value.message || '').trim().slice(0, 300);
  return /^r\d+$/.test(id) && Number.isFinite(at) && message ? { id, at, message } : null;
}

function normalizeTask(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '');
  const prompt = String(value.prompt || '').trim().slice(0, 20000);
  if (!/^tk\d+$/.test(id) || !prompt) return null;
  const schedule = ['interval', 'daily', 'weekly'].includes(value.schedule) ? value.schedule : 'daily';
  return {
    ...clone(value), id, name: String(value.name || 'Tarefa').trim().slice(0, 120), prompt, schedule,
    enabled: value.enabled !== false,
    everyMin: schedule === 'interval' ? Math.max(5, parseInt(value.everyMin, 10) || 60) : undefined,
    time: schedule !== 'interval' && /^\d{1,2}:\d{2}$/.test(String(value.time || '')) ? String(value.time) : '09:00',
    dow: schedule === 'weekly' ? Math.min(6, Math.max(0, parseInt(value.dow, 10) || 0)) : undefined,
    lastRun: Math.max(0, Number(value.lastRun) || 0), nextRun: Math.max(0, Number(value.nextRun) || 0),
  };
}

class SchedulingRepository {
  constructor(options) {
    const opts = options || {};
    if (!opts.remindersStore || !opts.tasksStore) throw new Error('SchedulingRepository exige remindersStore e tasksStore');
    this.remindersStore = opts.remindersStore; this.tasksStore = opts.tasksStore;
    this.clock = opts.clock || { now: () => Date.now() };
    this.reminders = []; this.tasks = []; this.reminderSeq = 0; this.taskSeq = 0;
  }

  async initialize() {
    const [reminders, tasks] = await Promise.all([this.remindersStore.read(), this.tasksStore.read()]);
    this.reminders = (Array.isArray(reminders.value) ? reminders.value : []).map(normalizeReminder).filter(Boolean);
    this.tasks = (Array.isArray(tasks.value) ? tasks.value : []).map(normalizeTask).filter(Boolean);
    this.reminderSeq = this.reminders.reduce((max, item) => Math.max(max, parseInt(item.id.slice(1), 10) || 0), 0);
    this.taskSeq = this.tasks.reduce((max, item) => Math.max(max, parseInt(item.id.slice(2), 10) || 0), 0);
    return { reminders: this.listReminders(), tasks: this.listTasks() };
  }

  listReminders() { return clone(this.reminders); }
  listTasks() { return clone(this.tasks); }

  async addReminder(input) {
    const item = normalizeReminder({ ...input, id: `r${++this.reminderSeq}` });
    if (!item) throw new Error('lembrete inválido');
    this.reminders.push(item); await this.remindersStore.write(this.reminders); return clone(item);
  }

  async deleteReminder(id) {
    const length = this.reminders.length; this.reminders = this.reminders.filter((item) => item.id !== id);
    if (length === this.reminders.length) return false;
    await this.remindersStore.write(this.reminders); return true;
  }

  async saveTask(input) {
    const existing = input && input.id ? this.tasks.find((item) => item.id === input.id) : null;
    const id = existing ? existing.id : `tk${++this.taskSeq}`;
    const item = normalizeTask({ ...(existing || {}), ...(input || {}), id });
    if (!item) throw new Error('tarefa inválida');
    item.nextRun = item.enabled ? nextTaskRun(item, this.clock.now()) : 0;
    const index = this.tasks.findIndex((entry) => entry.id === id);
    if (index >= 0) this.tasks[index] = item; else this.tasks.push(item);
    await this.tasksStore.write(this.tasks); return clone(item);
  }

  async deleteTask(id) {
    const length = this.tasks.length; this.tasks = this.tasks.filter((item) => item.id !== id);
    if (length === this.tasks.length) return false;
    await this.tasksStore.write(this.tasks); return true;
  }

  due(now) { const at = Number(now) || this.clock.now(); return this.tasks.filter((item) => item.enabled && item.prompt && item.nextRun > 0 && item.nextRun <= at).map(clone); }
  async markRun(id, now) {
    const item = this.tasks.find((entry) => entry.id === id); if (!item) return null;
    item.lastRun = Number(now) || this.clock.now(); item.nextRun = nextTaskRun(item, item.lastRun + 1000);
    await this.tasksStore.write(this.tasks); return clone(item);
  }
}

module.exports = { SchedulingRepository, normalizeReminder, normalizeTask };
