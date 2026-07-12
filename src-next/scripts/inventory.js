'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..', '..');
const mainPath = path.join(root, 'src', 'main', 'main.js');
const preloadPath = path.join(root, 'src', 'main', 'preload.js');
const outputDir = path.join(root, 'src-next', 'architecture', 'inventories');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function matches(content, regex, map) {
  const result = [];
  let match;
  while ((match = regex.exec(content))) result.push(map(match, lineAt(content, match.index)));
  return result;
}

function duplicates(items, key) {
  const grouped = new Map();
  for (const item of items) {
    const id = item[key];
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(item);
  }
  return [...grouped.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([id, entries]) => ({ id, entries }));
}

function objectRegion(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  if (start < 0) throw new Error(`marcador ausente: ${startMarker}`);
  const end = content.indexOf(endMarker, start);
  if (end < 0) throw new Error(`marcador final ausente: ${endMarker}`);
  return { text: content.slice(start, end), offset: start };
}

function writeJson(name, value) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function inventory() {
  const main = read(mainPath);
  const preload = read(preloadPath);
  const source = {
    main: { path: 'src/main/main.js', lines: main.split('\n').length, sha256: hash(main) },
    preload: { path: 'src/main/preload.js', lines: preload.split('\n').length, sha256: hash(preload) },
  };

  const registrations = matches(main, /ipcMain\.(handle|on)\(\s*['"]([^'"]+)['"]/g, (match, line) => ({
    channel: match[2],
    registration: match[1],
    line,
  })).sort((a, b) => a.channel.localeCompare(b.channel) || a.line - b.line);
  const preloadCalls = matches(preload, /ipcRenderer\.(invoke|send)\(\s*['"]([^'"]+)['"]/g, (match, line) => ({
    channel: match[2],
    transport: match[1],
    line,
  })).sort((a, b) => a.channel.localeCompare(b.channel) || a.line - b.line);
  const registeredNames = new Set(registrations.map((item) => item.channel));
  const preloadNames = new Set(preloadCalls.map((item) => item.channel));
  const ipc = {
    schemaVersion: 1,
    source,
    summary: {
      mainRegistrations: registrations.length,
      uniqueMainChannels: registeredNames.size,
      preloadCalls: preloadCalls.length,
      uniquePreloadChannels: preloadNames.size,
    },
    duplicates: duplicates(registrations, 'channel'),
    preloadWithoutMainRegistration: [...preloadNames].filter((channel) => !registeredNames.has(channel)).sort(),
    mainWithoutPreloadCall: [...registeredNames].filter((channel) => !preloadNames.has(channel)).sort(),
    registrations,
    preloadCalls,
  };

  const toolsRegion = objectRegion(main, 'const TOOLS = {', '// ---- MCP');
  const tools = matches(toolsRegion.text, /^  ([a-zA-Z][\w]*):\s*\{/gm, (match, localLine) => ({
    name: match[1],
    line: lineAt(main, toolsRegion.offset) + localLine - 1,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const toolsetsRegion = objectRegion(main, 'const TOOLSETS = {', 'const TOOLSET_NAMES');
  const toolsets = matches(toolsetsRegion.text, /^  ([a-zA-Z][\w]*):/gm, (match, localLine) => ({
    name: match[1],
    line: lineAt(main, toolsetsRegion.offset) + localLine - 1,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const toolInventory = {
    schemaVersion: 1,
    source: source.main,
    summary: { tools: tools.length, toolsets: toolsets.length },
    duplicates: duplicates(tools, 'name'),
    tools,
    toolsets,
  };

  const pathFunctions = matches(main, /function\s+([a-zA-Z][\w]*Path)\s*\([^)]*\)\s*\{([\s\S]{0,500}?)\n\}/g, (match, line) => {
    const expression = (match[2].match(/return\s+([^;]+);/) || [])[1];
    return expression ? { name: match[1], line, expression: expression.replace(/\s+/g, ' ').trim() } : null;
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const persistence = {
    schemaVersion: 1,
    source: source.main,
    summary: { pathFactories: pathFunctions.length },
    pathFactories: pathFunctions,
  };

  const turns = matches(main, /async function\s+([a-zA-Z][\w]*Turn)\s*\(/g, (match, line) => ({ name: match[1], line }));
  const engines = [
    { id: 'claude-code', marker: "ipcMain.handle('claude-code:status'" },
    { id: 'codex', marker: "ipcMain.handle('codex:status'" },
    { id: 'glm-code', marker: "ipcMain.handle('glm-code:status'" },
  ].filter((engine) => main.includes(engine.marker)).map(({ id }) => ({ id, kind: 'code-engine' }));
  const providers = {
    schemaVersion: 1,
    source: source.main,
    protocols: ['openai-compatible', 'anthropic', 'opencode-routing'],
    detectedTurnFunctions: turns,
    specialRoutes: [
      { id: 'nvidia-nim', detected: main.includes('integrate.api.nvidia.com') },
      { id: 'hugging-face-inference', detected: main.includes('router.huggingface.co') },
      { id: 'opencode', detected: main.includes("cfg.provider === 'opencode'") },
    ],
    engines,
  };

  writeJson('ipc.json', ipc);
  writeJson('tools.json', toolInventory);
  writeJson('persistence.json', persistence);
  writeJson('providers.json', providers);
  return { ipc: ipc.summary, tools: toolInventory.summary, persistence: persistence.summary, providers: { turns: turns.length, engines: engines.length } };
}

if (require.main === module) console.log(JSON.stringify(inventory(), null, 2));

module.exports = { inventory, duplicates, objectRegion };
