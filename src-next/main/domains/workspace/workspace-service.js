'use strict';

const { WorkspacePath } = require('./workspace-path');
const { WorkspaceTurnState } = require('./turn-state');
const { decodeText, dominantEol, normalizeEol, restoreEol, containsNul } = require('./encoding');

const HEAVY_NAMES = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', '.cache', 'vendor', 'target', '__pycache__', '.venv', 'venv']);
const IGNORE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

function clamp(value, minimum, maximum, fallback) { const parsed = Number.parseInt(value, 10); return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback)); }
function replaceTextSmart(source, oldText, newText, all) {
  const before = String(source), oldValue = String(oldText), nextValue = String(newText);
  if (!oldValue) return { error: 'old_text vazio' };
  if (oldValue === nextValue) return { error: 'old_text e new_text são iguais — nada a fazer' };
  const count = before.split(oldValue).length - 1;
  if (count) {
    if (count > 1 && !all) return { error: `old_text aparece ${count} vezes — inclua mais contexto ou use all=true` };
    return { text: all ? before.split(oldValue).join(nextValue) : before.replace(oldValue, nextValue), count: all ? count : 1, mode: 'exact' };
  }
  const normalizedBefore = normalizeEol(before), normalizedOld = normalizeEol(oldValue), normalizedNext = normalizeEol(nextValue);
  const normalizedCount = normalizedBefore.split(normalizedOld).length - 1;
  if (!normalizedCount) return { error: 'old_text NÃO encontrado no arquivo (inclusive após normalizar CRLF/LF)' };
  if (normalizedCount > 1 && !all) return { error: `old_text aparece ${normalizedCount} vezes após normalizar CRLF/LF — inclua mais contexto ou use all=true` };
  const replaced = all ? normalizedBefore.split(normalizedOld).join(normalizedNext) : normalizedBefore.replace(normalizedOld, normalizedNext);
  return { text: restoreEol(replaced, dominantEol(before)), count: all ? normalizedCount : 1, mode: 'eol-normalized' };
}
function diffSummary(before, after) {
  const a = String(before || '').split('\n'), b = String(after || '').split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  return { added: Math.max(0, b.length - prefix - suffix), removed: Math.max(0, a.length - prefix - suffix), big: a.length + b.length > 6000 };
}

class WorkspaceService {
  constructor(options) {
    const opts = options || {};
    if (!opts.filesystem) throw new Error('WorkspaceService exige filesystem');
    this.fs = opts.filesystem;
    this.paths = new WorkspacePath(opts.root, this.fs);
    this.turnState = opts.turnState || new WorkspaceTurnState();
    this.onMutation = opts.onMutation || (() => {});
    this.isProtected = opts.isProtected || (() => false);
  }

  async listDir(input) {
    const absolute = this.paths.resolve(input && input.path || '.');
    const entries = await this.fs.readDir(absolute, { withFileTypes: true });
    return { dir: this.paths.relative(absolute), entries: entries.slice(0, 300).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })) };
  }

  async readFile(input) {
    const args = input || {}, absolute = this.paths.resolve(args.path);
    let decoded;
    try { decoded = decodeText(await this.fs.readFile(absolute)); } catch (error) { return { error: `não consegui ler "${args.path}" (${String(error && error.code || error && error.message || error)})` }; }
    if (containsNul(decoded.text)) return { error: 'arquivo parece binário (contém bytes nulos)' };
    this.turnState.markRead(absolute);
    const lines = decoded.text.split('\n'), total = lines.length;
    const start = clamp(args.offset, 1, total || 1, 1), limit = clamp(args.limit, 1, 2000, 800);
    let content = lines.slice(start - 1, start - 1 + limit).join('\n');
    let capped = false;
    if (content.length > 48000) { content = content.slice(0, 48000); capped = true; }
    const shown = content ? content.split('\n').length : 0, end = Math.min(total, start + Math.max(0, shown - 1));
    const result = { content, totalLines: total, showing: `linhas ${start}-${end} de ${total}` + (capped ? ' (janela cortada por tamanho)' : '') };
    if (decoded.encoding !== 'utf-8') result.encoding = decoded.encoding;
    if (end < total) result.note = `o arquivo continua: chame read_file com offset=${end + 1}`;
    return result;
  }

  async writeFile(input) {
    const args = input || {}, absolute = this.paths.resolve(args.path);
    if (this.isProtected(absolute)) return { error: `arquivo protegido: "${args.path}"`, blocked: true };
    let previous = '', existed = false;
    try { previous = decodeText(await this.fs.readFile(absolute)).text; existed = true; } catch (_) {}
    if (existed && previous.trim() && !this.turnState.wasRead(absolute)) return { error: `"${args.path}" já existe e não foi lido neste turno; leia antes de sobrescrever.` };
    const next = args.content == null ? '' : String(args.content);
    await this.fs.writeFile(absolute, next);
    return this.mutated('write_file', args.path, previous, next, { written: this.paths.relative(absolute) });
  }

  async editFile(input) {
    const args = input || {}, absolute = this.paths.resolve(args.path);
    if (this.isProtected(absolute)) return { error: `arquivo protegido: "${args.path}"`, blocked: true };
    let previous;
    try { previous = decodeText(await this.fs.readFile(absolute)).text; } catch (_) { return { error: `arquivo "${args.path}" não encontrado` }; }
    if (!this.turnState.wasRead(absolute)) return { error: `você ainda não leu "${args.path}" neste turno — use read_file antes de editar.` };
    const replacement = replaceTextSmart(previous, args.old_text, args.new_text, args.all);
    if (replacement.error) return { error: replacement.error };
    await this.fs.writeFile(absolute, replacement.text);
    return this.mutated('edit_file', args.path, previous, replacement.text, { ok: true, replaced: replacement.count, ...(replacement.mode === 'eol-normalized' ? { note: 'substituição aplicada normalizando CRLF/LF e preservando o line ending dominante' } : {}) });
  }

  async appendFile(input) {
    const args = input || {}, absolute = this.paths.resolve(args.path);
    if (this.isProtected(absolute)) return { error: `arquivo protegido: "${args.path}"`, blocked: true };
    let previous = ''; try { previous = decodeText(await this.fs.readFile(absolute)).text; } catch (_) {}
    const addition = String(args.content || ''); await this.fs.appendFile(absolute, addition);
    return this.mutated('append_file', args.path, previous, previous + addition, { ok: true });
  }

  async makeDir(input) { const absolute = this.paths.resolve(input && input.path); await this.fs.mkdir(absolute); return this.mutated('make_dir', input.path, '', '', { ok: true }); }
  async deleteFile(input) {
    const absolute = this.paths.resolve(input && input.path);
    if (this.isProtected(absolute)) return { error: `arquivo protegido: "${input.path}"`, blocked: true };
    await this.fs.remove(absolute); return this.mutated('delete_file', input.path, '', '', { deleted: this.paths.relative(absolute) });
  }

  async findInCode(input) { return this.search(input, { find: true }); }
  async grepFiles(input) { return this.search(input, { find: false }); }

  async search(input, options) {
    const args = input || {}, opts = options || {}, query = String(opts.find ? args.query : args.pattern || '').trim().slice(0, 200);
    if (!query) return { error: opts.find ? 'consulta vazia' : 'pattern vazio' };
    let regex = null;
    if (!opts.find && args.regex) { try { regex = new RegExp(query, 'i'); } catch (error) { return { error: `regex inválida: ${error.message}` }; } }
    const start = this.paths.resolve(opts.find ? '.' : args.path || '.');
    const matches = [], names = [], deadline = Date.now() + (opts.find ? 3500 : 6000);
    const caps = { files: opts.find ? 350 : 1200, bytes: opts.find ? 6 * 1024 * 1024 : 32 * 1024 * 1024, hits: opts.find ? 35 : 120 };
    let files = 0, bytes = 0, limited = false;
    const visit = async (directory, depth) => {
      if (depth > (opts.find ? 8 : 12) || Date.now() > deadline || files >= caps.files || bytes >= caps.bytes || matches.length >= caps.hits) { limited = true; return; }
      let entries; try { entries = await this.fs.readDir(directory, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (Date.now() > deadline || files >= caps.files || bytes >= caps.bytes || matches.length >= caps.hits) { limited = true; return; }
        if (HEAVY_NAMES.has(entry.name) || IGNORE_NAMES.has(entry.name)) continue;
        const absolute = this.fs.join(directory, entry.name);
        if (entry.isDirectory()) { await visit(absolute, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const relative = this.paths.relative(absolute);
        if (opts.find && names.length < 30 && relative.toLowerCase().includes(query.toLowerCase())) names.push(relative);
        let stat; try { stat = await this.fs.stat(absolute); } catch (_) { continue; }
        if (stat.size > 800000) continue;
        files++; bytes += stat.size;
        let text; try { text = decodeText(await this.fs.readFile(absolute)).text; } catch (_) { continue; }
        if (containsNul(text)) continue;
        const lines = text.split('\n'); let perFile = 0;
        for (let index = 0; index < lines.length && perFile < (opts.find ? 20 : 20) && matches.length < caps.hits; index++) {
          const hit = regex ? regex.test(lines[index]) : lines[index].toLowerCase().includes(query.toLowerCase());
          if (hit) { perFile++; matches.push({ file: relative, line: index + 1, text: lines[index].trim().slice(0, opts.find ? 160 : 240) }); }
        }
      }
    };
    try {
      const rootStat = await this.fs.stat(start);
      if (rootStat.isDirectory()) await visit(start, 0);
      else if (rootStat.isFile()) {
        const relative = this.paths.relative(start), text = decodeText(await this.fs.readFile(start)).text;
        if (!containsNul(text)) for (const [index, line] of text.split('\n').entries()) {
          const hit = regex ? regex.test(line) : line.toLowerCase().includes(query.toLowerCase());
          if (hit && matches.length < caps.hits) matches.push({ file: relative, line: index + 1, text: line.trim().slice(0, opts.find ? 160 : 240) });
        }
      }
    }
    catch (_) { return { error: `caminho não encontrado: ${opts.find ? '.' : args.path || '.'}` }; }
    return opts.find ? { query, files_matching_name: names, content_matches: matches, ...(limited ? { truncated: 'busca limitada para proteger memória/tempo; refine a consulta' } : {}) } : { matches, total: matches.length, ...(limited ? { truncated: 'há mais resultados — refine o pattern ou limite o path' } : {}) };
  }

  mutated(kind, path, before, after, result) {
    const event = { kind, path: this.paths.relative(path), diff: diffSummary(before, after) };
    this.onMutation(event); return { ...result, mutation: event };
  }
}

module.exports = { WorkspaceService, HEAVY_NAMES, replaceTextSmart, diffSummary };
