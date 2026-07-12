'use strict';
const { clone } = require('../../../shared/schema');

class ChatSession {
  constructor(chat) {
    this.id = chat.id; this.workspace = null; this.workspaceOwner = null; this.running = false; this.deleted = false; this.abort = null;
    this.steerQueue = []; this.editedSinceTurn = false; this.checkpoint = null; this.toolCallLog = []; this.strategyFailures = []; this.stateSeq = 0;
    this.readFilesThisTurn = new Set(); this.activeToolsets = new Set(); this.taskContract = null; this.completionGateUsed = false;
    this.artifacts = new Map(); this.agentSeq = {}; this.currentTurnLog = null; this.pendingTurnTranscript = null;
    this.claudeQuery = null; this.claudeInput = null; this.codexControl = null;
    this.apply(chat);
  }
  apply(chat) {
    this.title = chat.title; this.customTitle = !!chat.customTitle; this.createdAt = chat.createdAt; this.updatedAt = chat.updatedAt;
    this.history = clone(chat.history || []); this.convSummary = chat.summary || ''; this.chatEvents = clone(chat.events || []); this.chatArchive = clone(chat.archive || []);
    this.worklog = clone(chat.worklog || []).slice(-60); this.ledger = clone(chat.ledger || []).slice(-40); this.lastTurnContext = clone(chat.lastTurnContext || null);
    this.claudeSessionId = chat.claudeSessionId || ''; this.claudeSessionWorkspace = chat.claudeSessionWorkspace || '';
    this.glmSessionId = chat.glmSessionId || ''; this.glmSessionWorkspace = chat.glmSessionWorkspace || '';
    this.codexThreadId = chat.codexThreadId || ''; this.codexThreadWorkspace = chat.codexThreadWorkspace || ''; this.chatConfig = clone(chat.chatConfig || null);
  }
  snapshot(clock) {
    return { id: this.id, title: this.title, customTitle: this.customTitle, createdAt: this.createdAt, updatedAt: clock.date().toISOString(), summary: this.convSummary,
      history: clone(this.history), events: clone(this.chatEvents), archive: clone(this.chatArchive), worklog: clone(this.worklog).slice(-60), ledger: clone(this.ledger).slice(-40),
      lastTurnContext: clone(this.lastTurnContext), claudeSessionId: this.claudeSessionId, claudeSessionWorkspace: this.claudeSessionWorkspace,
      glmSessionId: this.glmSessionId, glmSessionWorkspace: this.glmSessionWorkspace, codexThreadId: this.codexThreadId, codexThreadWorkspace: this.codexThreadWorkspace,
      chatConfig: clone(this.chatConfig) };
  }
  stop() {
    try { if (this.codexControl && this.codexControl.interrupt) Promise.resolve(this.codexControl.interrupt()).catch(() => {}); } catch (_) {}
    try { if (this.abort) this.abort.abort(); } catch (_) {}
    try { if (this.claudeQuery && this.claudeQuery.interrupt) Promise.resolve(this.claudeQuery.interrupt()).catch(() => {}); } catch (_) {}
  }
}
module.exports = { ChatSession };
