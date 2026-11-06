import fs from 'node:fs';
import path from 'node:path';
import EventEmitter from 'events';
import { AcpRuntime } from './acp-runtime.js';

const ACP_MODEL_NORM = {
  'gemini-3.8-flash': 'gemini-3.8-flash',
  'gemini-3.8-flash-medium': 'gemini-3.8-flash',
  'gemini-3.8-flash-high': 'gemini-3.8-flash',
  'gemini-3.8-flash-low': 'gemini-3.8-flash',
  'gemini-4-argon': 'gemini-4-argon',
  'gemini-4-argon-medium': 'gemini-4-argon',
  'gemini-4-argon-high': 'gemini-4-argon',
  'gemini-4-argon-low': 'gemini-4-argon',
  'claude-opus-5-5': 'claude-opus-5-5',
  'claude-sonnet-5-5': 'claude-sonnet-5-5',
};

export class AcpSessionBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.runtime = options.runtime || new AcpRuntime(options);
    this.dataDir = options.dataDir || path.join(process.env.HOME || '/home/jeremy', '.config', 'openchamber');
    this.storageFile = path.join(this.dataDir, 'acp-sessions.json');
    this.sessions = new Map();
    this.activeTurns = new Map();
    this.eventHub = options.eventHub || null;
    this.loadFromDisk();
  }

  setEventHub(hub) {
    this.eventHub = hub;
  }

  _sanitizeSession(session) {
    if (!session || !Array.isArray(session.messages)) return session;
    for (const msg of session.messages) {
      if (msg && msg.type === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && part.type === 'tool') {
            if (!part.name && part.tool) part.name = part.tool;
            if (!part.tool && part.name) part.tool = part.name;
            if (!part.time) {
              const start = part.state?.time?.start || msg.time?.created || Date.now();
              part.time = { created: start, ran: start, completed: msg.time?.completed || start };
            }
            if (part.executed === undefined) part.executed = true;
            if (part.state && part.state.status === 'running' && msg.time?.completed) {
              part.state.status = 'completed';
              if (!part.state.content) part.state.content = [{ type: 'text', text: '' }];
            }
          }
        }
      }
    }
    return session;
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const s of data) {
            if (s && s.id) {
              this._sanitizeSession(s);
              this.sessions.set(s.id, s);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[acp-bridge] Failed to load sessions from disk:', err.message);
    }
  }

  saveToDisk() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const data = Array.from(this.sessions.values());
      fs.writeFileSync(this.storageFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[acp-bridge] Failed to save sessions to disk:', err.message);
    }
  }

  isAcpSession(sessionId) {
    return typeof sessionId === 'string' && (sessionId.startsWith('ses_agy_') || sessionId.startsWith('ses_acp_') || this.sessions.has(sessionId));
  }

  listSessions(directory = null) {
    const list = Array.from(this.sessions.values());
    if (directory) {
      return list.filter((s) => !s.location?.directory || s.location.directory === directory);
    }
    return list;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? this._sanitizeSession(session) : null;
  }

  getMessages(sessionId, query = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return { data: [], cursor: {} };
    this._sanitizeSession(session);
    let msgs = session.messages ? session.messages.slice() : [];
    const order = query?.order || 'desc';
    if (order === 'desc') {
      msgs.reverse();
    }
    const limit = query?.limit ? parseInt(query.limit, 10) : null;
    if (limit && limit > 0 && msgs.length > limit) {
      msgs = msgs.slice(0, limit);
    }
    return { data: msgs, cursor: {} };
  }

  getMessage(sessionId, messageId) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.messages) return null;
    this._sanitizeSession(session);
    return session.messages.find((m) => m.id === messageId) || null;
  }

  createSession({ id = null, title, directory = process.cwd(), agent = 'antigravity', model = 'gemini-3.8-flash' } = {}) {
    const sessionId = id || `ses_agy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const resolvedModel = ACP_MODEL_NORM[model] || model || 'gemini-3.8-flash';
    const session = {
      id: sessionId,
      title: title || 'New Antigravity Session',
      location: { directory },
      agent: 'antigravity',
      model: { id: resolvedModel, providerID: 'antigravity' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now, idle: now },
      messages: [],
    };
    this.sessions.set(sessionId, session);
    this.saveToDisk();

    this.emitEvent({
      type: 'session.created',
      data: session,
      properties: { info: session, session },
    }, directory);

    return session;
  }

  deleteSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId);
      const directory = session?.location?.directory || 'global';
      this.abortTurn(sessionId);
      if (session?.acpSessionId) {
        this.runtime.closeSession(session.acpSessionId);
      }
      this.sessions.delete(sessionId);
      this.saveToDisk();
      this.emitEvent({
        type: 'session.deleted',
        data: { sessionID: sessionId },
        properties: { sessionID: sessionId },
      }, directory);
      return true;
    }
    return false;
  }

  switchModel(sessionId, model) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const modelId = typeof model === 'string' ? model : (model?.id || 'gemini-3.8-flash');
    const resolvedModel = ACP_MODEL_NORM[modelId] || modelId;
    session.model = { id: resolvedModel, providerID: 'antigravity' };
    session.time = session.time || {};
    session.time.updated = Date.now();
    this.saveToDisk();
    return true;
  }

  switchAgent(sessionId, agent) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.agent = agent || 'antigravity';
    session.time = session.time || {};
    session.time.updated = Date.now();
    this.saveToDisk();
    return true;
  }

  updateSession(sessionId, updates = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (updates.title !== undefined) session.title = updates.title;
    if (updates.metadata !== undefined) session.metadata = updates.metadata;
    if (updates.permissions !== undefined) session.permissions = updates.permissions;
    if (updates.archived !== undefined) session.archived = updates.archived;
    session.time = session.time || {};
    session.time.updated = Date.now();
    this.saveToDisk();
    return true;
  }

  abortTurn(sessionId) {
    const abortCtrl = this.activeTurns.get(sessionId);
    if (abortCtrl) {
      abortCtrl.abort();
      this.activeTurns.delete(sessionId);
      const session = this.sessions.get(sessionId);
      const directory = session?.location?.directory || 'global';
      if (session) {
        if (session.acpSessionId && typeof this.runtime.cancel === 'function') {
          this.runtime.cancel(session.acpSessionId).catch(() => {});
        }
        if (session.time) delete session.time.busy;
        session.time.idle = Date.now();
        const idleMsg = {
          id: `msg_${Date.now().toString(36)}_idle`,
          sessionID: sessionId,
          time: { created: Date.now() },
          type: 'idle',
          role: 'idle',
          outcome: 'interrupted',
        };
        session.messages.push(idleMsg);
        this.saveToDisk();
      }
      this.emitEvent({
        type: 'session.execution.interrupted',
        data: { sessionID: sessionId, reason: 'user' },
        properties: { sessionID: sessionId, outcome: 'interrupted' },
        created: Date.now(),
      }, directory);
      this.emitEvent({
        type: 'session.idle',
        data: { sessionID: sessionId },
        properties: { sessionID: sessionId, outcome: 'interrupted' },
      }, directory);
      return true;
    }
    return false;
  }

  async startTurn(sessionId, promptData) {
    let session = this.sessions.get(sessionId);
    const directory = promptData.directory || session?.location?.directory || process.cwd();
    if (!session) {
      session = this.createSession({
        id: sessionId,
        title: 'Antigravity Session',
        directory,
      });
      sessionId = session.id;
    }

    const text = promptData.text || promptData.prompt || promptData.content || '';
    if (!text.trim()) return null;

    if (session.messages.length === 0 || session.title === 'New Antigravity Session') {
      session.title = text.trim().slice(0, 36);
      this.emitEvent({
        type: 'session.renamed',
        data: { sessionID: sessionId, title: session.title },
        properties: { sessionID: sessionId, title: session.title },
      }, directory);
    }

    const now = Date.now();
    session.time.busy = now;
    session.time.updated = now;

    // 1. User Message
    const userMsgId = promptData.id || `msg_${now.toString(36)}_u`;
    const userMsg = {
      id: userMsgId,
      sessionID: sessionId,
      time: { created: now },
      type: 'user',
      role: 'user',
      text,
      content: [{ id: `${userMsgId}:text:0`, sessionID: sessionId, messageID: userMsgId, type: 'text', text }],
    };
    session.messages.push(userMsg);

    // 2. Assistant Message
    const assistantMsgId = `msg_${(now + 1).toString(36)}_a`;
    const rawModelId = session.model?.id || 'gemini-3.8-flash-medium';
    const modelId = ACP_MODEL_NORM[rawModelId] || rawModelId;
    const parts = [];

    const assistantMsg = {
      id: assistantMsgId,
      sessionID: sessionId,
      time: { created: now + 1, streamed: now + 1 },
      type: 'assistant',
      role: 'assistant',
      agent: 'antigravity',
      providerID: 'antigravity',
      modelID: modelId,
      model: { id: modelId, providerID: 'antigravity' },
      content: parts,
    };
    session.messages.push(assistantMsg);

    // Emit wire events for UI start
    this.emitEvent({
      type: 'session.execution.started',
      data: { sessionID: sessionId },
      created: now,
    }, directory);

    this.emitEvent({
      type: 'session.step.started',
      data: {
        sessionID: sessionId,
        assistantMessageID: assistantMsgId,
        agent: 'antigravity',
        model: { id: modelId, providerID: 'antigravity' },
      },
      created: now,
    }, directory);

    // Also emit v1 fallback properties for any direct consumers
    this.emitEvent({
      type: 'message.updated',
      properties: { info: userMsg },
    }, directory);
    this.emitEvent({
      type: 'message.updated',
      properties: { info: assistantMsg },
    }, directory);

    const abortCtrl = new AbortController();
    this.activeTurns.set(sessionId, abortCtrl);

    // Launch background turn execution
    void this.executeTurn(sessionId, session, assistantMsg, text, abortCtrl, directory);

    return userMsg;
  }

  async executeTurn(sessionId, session, assistantMsg, text, abortCtrl, directory) {
    let acpSession = null;
    const assistantMsgId = assistantMsg.id;
    const reasoningPartId = `${assistantMsgId}:reasoning:0`;
    const textPartId = `${assistantMsgId}:text:0`;
    let hasThoughtPart = false;
    let hasTextPart = false;
    let accumulatedThought = '';
    let accumulatedText = '';
    const parts = assistantMsg.content;

    try {
      const existingAcpId = session.acpSessionId;
      const isAlive = existingAcpId && typeof this.runtime.isSessionAlive === 'function'
        ? this.runtime.isSessionAlive(existingAcpId)
        : Boolean(existingAcpId && this.runtime.getSession(existingAcpId));

      if (isAlive) {
        acpSession = this.runtime.getSession(existingAcpId) || { sessionId: existingAcpId };
      } else {
        acpSession = await this.runtime.createSession({
          agentId: 'antigravity',
          cwd: directory || session.location?.directory || process.cwd(),
        });
        session.acpSessionId = acpSession.sessionId;
        this.saveToDisk();
      }

      if (abortCtrl.signal.aborted) return;

      const rawModelId = session.model?.id || 'gemini-3.8-flash';
      const baseModelId = ACP_MODEL_NORM[rawModelId] || rawModelId;
      const acpTargetModel = `${baseModelId}-medium`;
      await this.runtime.setModel(acpSession.sessionId, acpTargetModel).catch(async () => {
        await this.runtime.setModel(acpSession.sessionId, baseModelId).catch(() => {});
      });

      const onAbort = () => {
        if (acpSession?.sessionId && typeof this.runtime.cancel === 'function') {
          this.runtime.cancel(acpSession.sessionId).catch(() => {});
        }
      };
      abortCtrl.signal.addEventListener('abort', onAbort, { once: true });

      await this.runtime.prompt(acpSession.sessionId, text, (chunk) => {
        if (abortCtrl.signal.aborted) return;

        if (chunk.type === 'thought' && chunk.delta) {
          if (!hasThoughtPart) {
            hasThoughtPart = true;
            const rPart = {
              id: reasoningPartId,
              sessionID: sessionId,
              messageID: assistantMsgId,
              type: 'reasoning',
              text: '',
              time: { start: Date.now() },
            };
            parts.push(rPart);
            this.emitEvent({
              type: 'session.reasoning.started',
              data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal: 0 },
              created: Date.now(),
            }, directory);
          }
          accumulatedThought += chunk.delta;
          const r = parts.find((p) => p.id === reasoningPartId);
          if (r) r.text = accumulatedThought;

          this.emitEvent({
            type: 'session.reasoning.delta',
            data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal: 0, delta: chunk.delta },
            created: Date.now(),
          }, directory);
        } else if (chunk.type === 'tool' && chunk.tool) {
          const callID = chunk.tool.callID || chunk.tool.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const toolName = chunk.tool.name || chunk.tool.tool || 'bash';
          const toolArgs = chunk.tool.args || chunk.tool.input || {};
          const now = Date.now();
          const toolPart = {
            id: callID,
            sessionID: sessionId,
            messageID: assistantMsgId,
            callID,
            type: 'tool',
            name: toolName,
            tool: toolName,
            executed: true,
            time: { created: now, ran: now },
            state: { status: 'running', input: toolArgs, time: { start: now } },
          };
          parts.push(toolPart);
          this.emitEvent({
            type: 'session.tool.called',
            data: { sessionID: sessionId, assistantMessageID: assistantMsgId, id: callID, name: toolName, input: toolArgs, executed: true },
            created: now,
          }, directory);
        } else if (chunk.type === 'text' && chunk.delta) {
          if (!hasTextPart) {
            hasTextPart = true;
            if (hasThoughtPart) {
              const r = parts.find((p) => p.id === reasoningPartId);
              if (r && !r.time?.end) {
                r.time = { ...r.time, end: Date.now() };
                this.emitEvent({
                  type: 'session.reasoning.ended',
                  data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal: 0, text: accumulatedThought },
                  created: Date.now(),
                }, directory);
              }
            }
            const tPart = {
              id: textPartId,
              sessionID: sessionId,
              messageID: assistantMsgId,
              type: 'text',
              text: '',
              time: { start: Date.now() },
            };
            parts.push(tPart);
            this.emitEvent({
              type: 'session.text.started',
              data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal: 0 },
              created: Date.now(),
            }, directory);
          }
          accumulatedText += chunk.delta;
          const t = parts.find((p) => p.id === textPartId);
          if (t) t.text = accumulatedText;

          this.emitEvent({
            type: 'session.text.delta',
            data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal: 0, delta: chunk.delta },
            created: Date.now(),
          }, directory);
        }
      });

      if (abortCtrl.signal.aborted) return;

      const completedTime = Date.now();
      for (const p of parts) {
        if (p.type === 'tool' && p.state && p.state.status === 'running') {
          p.state.status = 'completed';
          if (!p.state.content) p.state.content = [{ type: 'text', text: '' }];
          p.time = p.time || { created: completedTime, ran: completedTime };
          p.time.completed = completedTime;
          this.emitEvent({
            type: 'session.tool.success',
            data: {
              sessionID: sessionId,
              assistantMessageID: assistantMsgId,
              id: p.callID || p.id,
              content: p.state.content,
              executed: true,
            },
            created: completedTime,
          }, directory);
        }
      }

      const t = parts.find((p) => p.id === textPartId);
      if (t && !t.time?.end) {
        t.time = { ...t.time, end: completedTime };
        this.emitEvent({
          type: 'session.text.ended',
          data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal: 0, text: accumulatedText },
          created: completedTime,
        }, directory);
      }
      assistantMsg.time.completed = completedTime;
      assistantMsg.finish = 'stop';
      session.time.idle = completedTime;
      if (session.time) delete session.time.busy;

      const idleMsg = {
        id: `msg_${completedTime.toString(36)}_idle`,
        sessionID: sessionId,
        time: { created: completedTime },
        type: 'idle',
        role: 'idle',
        outcome: 'succeeded',
      };
      session.messages.push(idleMsg);

      this.saveToDisk();

      this.emitEvent({
        type: 'session.step.ended',
        data: { sessionID: sessionId, assistantMessageID: assistantMsgId, finish: 'stop' },
        created: completedTime,
      }, directory);

      this.emitEvent({
        type: 'session.execution.succeeded',
        data: { sessionID: sessionId },
        created: completedTime,
      }, directory);

      this.emitEvent({
        type: 'session.idle',
        data: { sessionID: sessionId },
        properties: { sessionID: sessionId, outcome: 'succeeded' },
      }, directory);
    } catch (err) {
      if (abortCtrl.signal.aborted) return;
      const failedTime = Date.now();
      for (const p of parts) {
        if (p.type === 'tool' && p.state && p.state.status === 'running') {
          p.state.status = 'error';
          p.state.error = { message: err.message };
          p.time = p.time || { created: failedTime, ran: failedTime };
          p.time.completed = failedTime;
          this.emitEvent({
            type: 'session.tool.failed',
            data: {
              sessionID: sessionId,
              assistantMessageID: assistantMsgId,
              id: p.callID || p.id,
              error: { message: err.message },
              executed: true,
            },
            created: failedTime,
          }, directory);
        }
      }
      assistantMsg.time.completed = failedTime;
      assistantMsg.finish = 'error';
      session.time.idle = failedTime;
      if (session.time) delete session.time.busy;

      const idleMsg = {
        id: `msg_${failedTime.toString(36)}_idle`,
        sessionID: sessionId,
        time: { created: failedTime },
        type: 'idle',
        role: 'idle',
        outcome: 'failed',
        error: { message: err.message },
      };
      session.messages.push(idleMsg);

      this.saveToDisk();

      this.emitEvent({
        type: 'session.execution.failed',
        data: { sessionID: sessionId, error: { message: err.message } },
        created: failedTime,
      }, directory);

      this.emitEvent({
        type: 'session.idle',
        data: { sessionID: sessionId },
        properties: { sessionID: sessionId, outcome: 'failed' },
      }, directory);
    } finally {
      this.activeTurns.delete(sessionId);
      if (session?.time) delete session.time.busy;
      // Do NOT close acpSession! Keep ACP session alive across turns for conversation memory!
    }
  }

  subscribeEvent(listener) {
    this.on('event', listener);
    return () => {
      this.off('event', listener);
    };
  }

  emitEvent(payload, directory = 'global') {
    this.emit('event', payload);
    if (this.eventHub && typeof this.eventHub.injectEvent === 'function') {
      try {
        this.eventHub.injectEvent({
          payload,
          directory: directory || 'global',
        });
      } catch (err) {
        console.warn('[acp-bridge] Failed to inject event into globalHub:', err.message);
      }
    }
  }
}

let defaultBridge = null;

export function getAcpSessionBridge(options = {}) {
  if (!defaultBridge) {
    defaultBridge = new AcpSessionBridge(options);
  }
  return defaultBridge;
}
