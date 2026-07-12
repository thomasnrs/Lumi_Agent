'use strict';

class AutoVerificationPolicy {
  constructor(options) {
    const opts = options || {};
    if (typeof opts.run !== 'function') throw new Error('AutoVerificationPolicy exige run');
    this.run = opts.run;
    this.resolveCommand = opts.resolveCommand || ((config) => config.verifyCommand || '');
    this.maxAttempts = Math.max(1, Math.min(Number(opts.maxAttempts) || 3, 5));
    this.attempts = 0;
  }
  async evaluate(context) {
    const { config, ledger } = context;
    if (config.autoVerify !== true || !ledger.changedCodeFiles().length || ledger.hasSuccessfulVerification() || this.attempts >= this.maxAttempts) return null;
    const command = String(await this.resolveCommand(config, context) || '').trim();
    if (!command) return null;
    this.attempts++;
    let result;
    try { result = await this.run(command, context); } catch (error) { result = { ok: false, output: String(error && error.message || error) }; }
    const ok = result && result.ok === true;
    ledger.verification.push({ command, ok, summary: String(result && (result.output || result.error) || '').slice(0, 300) });
    context.emit({ type: 'agent.auto-verify', command, ok, attempt: this.attempts });
    if (ok) return null;
    return { role: 'user', content: `[verificação automática] O comando \`${command}\` falhou. Saída:\n${String(result && (result.output || result.error) || '').slice(0, 8000)}\n\nCorrija a causa raiz e verifique novamente.` };
  }
}

class AutoReviewPolicy {
  constructor(options) {
    const opts = options || {};
    if (typeof opts.review !== 'function') throw new Error('AutoReviewPolicy exige review');
    this.review = opts.review;
    this.used = false;
  }
  async evaluate(context) {
    if (this.used || context.config.autoReview !== true || !context.ledger.changedCodeFiles().length) return null;
    this.used = true;
    let review;
    try { review = String(await this.review(context) || '').trim(); } catch (error) { context.emit({ type: 'agent.auto-review-error', error }); return null; }
    const ok = !review || /^ok\b/i.test(review) || review.length < 6;
    context.emit({ type: 'agent.auto-review', ok, review: review.slice(0, 500) });
    if (ok) return null;
    return { role: 'user', content: `[auto-revisão do diff] Foram apontados possíveis problemas:\n${review.slice(0, 8000)}\n\nCorrija os que forem reais; para falso positivo, explique brevemente. Depois finalize.` };
  }
}

module.exports = { AutoVerificationPolicy, AutoReviewPolicy };
