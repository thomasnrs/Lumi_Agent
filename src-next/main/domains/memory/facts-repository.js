'use strict';

const { clone } = require('../../../shared/schema');
const { scopeKey } = require('../workspace/workspace-path');

// Fato sem escopo é legado (anterior à separação por projeto): entra como 'user' para não
// desaparecer da memória de ninguém. Só os novos nascem com escopo explícito.
function normalizeFact(value, clock) {
  if (typeof value === 'string') value = { fact: value };
  if (!value || typeof value !== 'object') return null;
  const fact = String(value.fact || '').trim().slice(0, 2000);
  if (!fact) return null;
  const project = value.scope === 'project' ? String(value.project || '').trim() : '';
  const item = { fact, at: value.at || clock.date().toISOString(), scope: project ? 'project' : 'user' };
  if (project) item.project = project;
  return item;
}

class FactsRepository {
  constructor(options) {
    const opts = options || {};
    if (!opts.store) throw new Error('FactsRepository exige store');
    this.store = opts.store;
    this.clock = opts.clock || { date: () => new Date() };
    this.limit = Math.max(1, Number(opts.limit) || 100);
    this.projectLimit = Math.max(1, Number(opts.projectLimit) || 60);
    this.items = [];
  }

  async initialize() {
    const loaded = await this.store.read();
    const source = Array.isArray(loaded.value) ? loaded.value : Array.isArray(loaded.value && loaded.value.items) ? loaded.value.items : [];
    this.items = this.trim(source.map((item) => normalizeFact(item, this.clock)).filter(Boolean));
    if (loaded.source !== 'primary' || !Array.isArray(loaded.value)) await this.persist();
    return this.list();
  }

  // Retenção POR ESCOPO: um teto global faria o projeto mais movimentado expulsar os fatos
  // do usuário e os dos outros projetos por pura ordem de chegada.
  trim(list) {
    const user = [];
    const byProject = new Map();
    for (const item of list || []) {
      if (!item) continue;
      if (item.scope === 'project') {
        const key = scopeKey(item.project);
        if (!byProject.has(key)) byProject.set(key, []);
        byProject.get(key).push(item);
      } else user.push(item);
    }
    const kept = new Set([...user.slice(-this.limit), ...[...byProject.values()].flatMap((v) => v.slice(-this.projectLimit))]);
    return (list || []).filter((item) => kept.has(item)); // mantém a ordem cronológica original
  }

  list() { return clone(this.items); }

  // O que pode entrar no contexto AQUI: fatos do usuário sempre; fatos de projeto só dentro
  // do projeto em que foram aprendidos. É isto que impede um projeto de vazar no outro.
  listForScope(workspace) {
    const here = scopeKey(workspace);
    return clone(this.items.filter((item) => item.scope !== 'project' || (!!here && scopeKey(item.project) === here)));
  }

  async add(fact) {
    const item = normalizeFact(fact, this.clock);
    if (!item) throw new Error('fato vazio');
    this.items = this.trim([...this.items, item]);
    await this.persist();
    return clone(item);
  }

  async set(index, fact) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.items.length) return false;
    // objeto parcial não pode apagar o escopo já gravado: mescla sobre o item existente
    const patch = fact && typeof fact === 'object' ? { ...this.items[i], ...fact } : { ...this.items[i], fact };
    const item = normalizeFact(patch, this.clock);
    if (!item) throw new Error('fato vazio');
    this.items[i] = item;
    await this.persist();
    return true;
  }

  async delete(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.items.length) return false;
    this.items.splice(i, 1);
    await this.persist();
    return true;
  }

  async clear() { this.items = []; await this.persist(); }
  persist() { return this.store.write(this.items); }
}

module.exports = { FactsRepository, normalizeFact };
