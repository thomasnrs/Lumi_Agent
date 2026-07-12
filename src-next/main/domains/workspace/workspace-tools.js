'use strict';

function schema(name, description, properties, required) {
  return { name, description, parameters: { type: 'object', properties: properties || {}, ...(required && required.length ? { required } : {}) } };
}

function registerWorkspaceTools(registry, service) {
  const definitions = [
    ['list_dir', 'Lista arquivos e pastas do diretório relativo ao workspace.', { path: { type: 'string' } }, ['path'], 'read', true, 'listDir'],
    ['read_file', 'Lê um arquivo de texto por janela de linhas e informa encoding quando necessário.', { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, ['path'], 'read', true, 'readFile'],
    ['find_in_code', 'Encontra nomes de arquivo e conteúdo no workspace com limites de tempo/memória.', { query: { type: 'string' } }, ['query'], 'read', true, 'findInCode'],
    ['grep_files', 'Procura texto ou regex em arquivos do workspace.', { pattern: { type: 'string' }, path: { type: 'string' }, regex: { type: 'boolean' } }, ['pattern'], 'read', true, 'grepFiles'],
    ['write_file', 'Cria ou sobrescreve um arquivo; arquivo existente deve ter sido lido neste turno.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content'], 'write', false, 'writeFile'],
    ['edit_file', 'Substitui trecho exato, tolerando CRLF/LF e mantendo o EOL dominante.', { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, all: { type: 'boolean' } }, ['path', 'old_text', 'new_text'], 'write', false, 'editFile'],
    ['append_file', 'Acrescenta conteúdo ao final de um arquivo.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content'], 'write', false, 'appendFile'],
    ['make_dir', 'Cria uma pasta e os pais necessários.', { path: { type: 'string' } }, ['path'], 'write', false, 'makeDir'],
    ['delete_file', 'Apaga arquivo ou pasta dentro do workspace.', { path: { type: 'string' } }, ['path'], 'delete', false, 'deleteFile'],
  ];
  for (const [name, description, properties, required, category, readonly, method] of definitions) {
    registry.register(name, {
      category, readonly, exclusive: !readonly,
      summary: (args) => `${description} (${args && (args.path || args.query || args.pattern) || ''})`,
      schema: schema(name, description, properties, required), run: (args) => service[method](args),
    });
  }
  return registry;
}

module.exports = { registerWorkspaceTools };
