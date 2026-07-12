'use strict';

const CORE_TOOLS = new Set(['ask_user', 'update_plan', 'load_toolset', 'read_artifact', 'get_datetime', 'play_animation', 'remember_fact', 'recall_facts', 'read_clipboard', 'write_clipboard']);
const TOOLSETS = Object.freeze({
  code_read: new Set(['project_overview', 'find_in_code', 'list_dir', 'read_file', 'grep_files', 'git_status', 'git_diff', 'git_log', 'locate_stack', 'get_problems', 'outline', 'find_usages', 'env_info', 'read_project_memory']),
  code_write: new Set(['edit_file', 'apply_patch', 'run_tests', 'generate_project_doc', 'update_project_memory', 'write_file', 'append_file', 'make_dir', 'delete_file', 'run_command']),
  terminal: new Set(['run_command', 'run_in_terminal', 'read_terminal', 'list_terminals', 'kill_terminal']),
  web: new Set(['web_search', 'fetch_url', 'http_request', 'open_url']),
  computer: new Set(['see_screen', 'screen_info', 'move_mouse', 'click', 'scroll', 'type_text', 'press_keys', 'focus_window']),
  system: new Set(['system_logs', 'env_info', 'get_problems', 'locate_stack', 'run_command']),
  data: new Set(['db_schema', 'db_query', 'read_file', 'write_file', 'append_file']),
  media: new Set(['generate_image', 'view_image', 'see_page', 'see_screen', 'open_url']),
  reminders: new Set(['set_reminder', 'list_reminders', 'cancel_reminder', 'schedule_task', 'list_scheduled_tasks', 'cancel_scheduled_task']),
  remote: new Set(['connect_remote', 'list_ssh_hosts', 'run_in_terminal', 'read_terminal', 'list_terminals', 'kill_terminal']),
  agents: new Set(['delegate_to_agent']),
  mcp: new Set(),
});

function selectedToolNames(toolsets, includeDelegate) {
  const output = new Set(CORE_TOOLS);
  const selected = new Set(toolsets || []);
  if (selected.has('code')) { selected.add('code_read'); selected.add('code_write'); }
  if (selected.has('all')) for (const name of Object.keys(TOOLSETS)) selected.add(name);
  for (const name of selected) for (const tool of TOOLSETS[name] || []) output.add(tool);
  if (!includeDelegate) output.delete('delegate_to_agent');
  return output;
}

function inferToolsets(text, config) {
  const query = String(text || '').toLowerCase();
  const output = new Set();
  const add = (name, expression) => { if (expression.test(query)) output.add(name); };
  add('code_read', /\b(c[oó]digo|projeto|workspace|arquivo|m[ée]todo|fun[cç][aã]o|m[oó]dulo|bug|erro|fix|implement|refator|teste|lint|build|git|package|api|frontend|backend|css|html|javascript|typescript|python|electron)\b/i);
  add('terminal', /\b(terminal|comando|shell|powershell|cmd|bash|servidor|processo|porta|npm|pnpm|yarn|pytest|docker)\b/i);
  add('web', /\b(web|internet|pesquis|buscar online|site|url|documenta[cç][aã]o|not[íi]cia|atual)\b/i);
  add('computer', /\b(tela|mouse|clic|digitar|teclado|janela|controlar o pc|screenshot|print)\b/i);
  add('system', /\b(sistema|windows|linux|macos|log|crash|evento|servi[cç]o|cpu|mem[oó]ria)\b/i);
  add('data', /\b(banco|database|sql|tabela|schema|query|consulta)\b/i);
  add('media', /\b(imagem|foto|desenho|mockup|visual|layout|p[áa]gina|screenshot)\b/i);
  add('reminders', /\b(lembrete|lembrar|agenda|agendar|tarefa agendada|daqui a \d+)\b/i);
  add('remote', /\b(ssh|remoto|servidor remoto|vps|sshfs)\b/i);
  add('agents', /\b(agente|subagente|deleg|paralel)\b/i);
  add('mcp', /\b(mcp|model context protocol|ferramenta externa)\b/i);
  const mutating = /\b(fa[cç]a|altere|adicion[ae]|implemente|corrija|conserte|remova|refatore|melhore|crie|atualize|continue|manda ver|resolve)\b/i.test(query);
  if ((output.has('code_read') || config && config.architectMode) && mutating) { output.add('code_read'); output.add('code_write'); }
  return output;
}

module.exports = { CORE_TOOLS, TOOLSETS, selectedToolNames, inferToolsets };
