'use strict';

const { inferToolsets } = require('../tools/toolsets');

function taskContractFor(goal, config) {
  const text = String(goal || '').trim();
  const toolsets = inferToolsets(text, config);
  const mutating = /\b(fa[cç]a|altere|adicione|implemente|corrija|conserte|remova|refatore|melhore|crie|atualize|continue|manda ver|resolve)\b/i.test(text);
  return { goal: text.slice(0, 500), toolsets, requiresCodeEvidence: toolsets.has('code_write') && mutating };
}

function taskContractPrompt(contract) {
  if (!contract || !contract.goal) return '';
  return '# Contrato deste turno\n' + `Objetivo: ${contract.goal}\n` + (contract.requiresCodeEvidence
    ? 'Critério de conclusão: não finalize após apenas editar. Revise o diff e obtenha evidência proporcional por teste, sintaxe, problemas ou build.'
    : 'Critério de conclusão: resolva o objetivo diretamente e não execute trabalho fora do escopo.');
}

class CompletionEvidenceGate {
  constructor() { this.used = false; }
  reset() { this.used = false; }
  evaluate(contract, ledger) {
    if (this.used || !contract || !contract.requiresCodeEvidence) return null;
    const files = ledger.changedCodeFiles();
    if (!files.length || ledger.hasSuccessfulVerification()) return null;
    this.used = true;
    return { role: 'user', content: `[gate de conclusão] Você alterou código, mas ainda não há verificação bem-sucedida. Arquivos: ${files.slice(0, 12).join(', ')}. Revise o diff e rode a menor verificação pertinente. Se não for possível, explique o bloqueio e não afirme que passou.` };
  }
}

module.exports = { taskContractFor, taskContractPrompt, CompletionEvidenceGate };
