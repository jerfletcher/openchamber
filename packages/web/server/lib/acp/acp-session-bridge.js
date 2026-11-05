import fs from 'node:fs';
import path from 'node:path';
import EventEmitter from 'events';
import { AcpRuntime } from './acp-runtime.js';

export class AcpSessionBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.runtime = options.runtime || new AcpRuntime(options);
    this.dataDir = options.dataDir || path.join(process.env.HOME || '/home/jeremy', '.config', 'openchamber');
    this.storageFile = path.join(this.dataDir, 'acp-sessions.json');
    this.sessions = new Map();
    this.activeTurns = new Map();
    this.loadFromDisk();
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const s of data) {
            if (s && s.id) this.sessions.set(s.id, s);
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
    return this.sessions.get(sessionId) || null;
  }

  getMessages(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return { data: [] };
    const msgs = session.messages || [];
    return { data: msgs.slice().reverse() };
  }

  createSession({ id = null, title, directory = process.cwd(), agent = 'antigravity', model = 'gemini-4-argon' } = {}) {
    const sessionId = id || `ses_agy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const session = {
      id: sessionId,
      title: title || 'New Antigravity Session',
      location: { directory },
      agent: 'antigravity',
      model: { id: model, providerID: 'antigravity' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now, idle: now },
      messages: [],
    };
    this.sessions.set(sessionId, session);
    this.saveToDisk();

    this.emitEvent({
      type: 'session.created',
      properties: { info: session, session },
    });

    return session;
  }

  deleteSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      this.abortTurn(sessionId);
      this.sessions.delete(sessionId);
      this.saveToDisk();
      this.emitEvent({
        type: 'session.deleted',
        properties: { sessionID: sessionId },
      });
      return true;
    }
    return false;
  }

  abortTurn(sessionId) {
    const abortCtrl = this.activeTurns.get(sessionId);
    if (abortCtrl) {
      abortCtrl.abort();
      this.activeTurns.delete(sessionId);
      const session = this.sessions.get(sessionId);
      if (session) {
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
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'idle' } },
      });
      this.emitEvent({
        type: 'session.idle',
        properties: { sessionID: sessionId, outcome: 'interrupted' },
      });
      return true;
    }
    return false;
  }

  async startTurn(sessionId, promptData) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.createSession({
        id: sessionId,
        title: 'Antigravity Session',
        directory: promptData.directory || process.cwd(),
      });
      sessionId = session.id;
    }

    const text = promptData.text || promptData.prompt || promptData.content || '';
    if (!text.trim()) return null;

    if (session.messages.length === 0 || session.title === 'New Antigravity Session') {
      session.title = text.trim().slice(0, 36);
      this.emitEvent({
        type: 'session.renamed',
        properties: { sessionID: sessionId, title: session.title },
      });
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

    this.emitEvent({
      type: 'message.updated',
      properties: { info: userMsg },
    });

    this.emitEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: sessionId,
        part: { id: `${userMsgId}:text:0`, sessionID: sessionId, messageID: userMsgId, type: 'text', text },
      },
    });

    this.emitEvent({
      type: 'session.status',
      properties: { sessionID: sessionId, status: { type: 'busy' } },
    });

    // 2. Assistant Message
    const assistantMsgId = `msg_${(now + 1).toString(36)}_a`;
    const parts = [];

    const assistantMsg = {
      id: assistantMsgId,
      sessionID: sessionId,
      time: { created: now + 1, streamed: now + 1 },
      type: 'assistant',
      role: 'assistant',
      agent: 'antigravity',
      providerID: 'antigravity',
      modelID: session.model?.id || 'gemini-4-argon',
      model: session.model,
      content: parts,
    };
    session.messages.push(assistantMsg);

    this.emitEvent({
      type: 'message.updated',
      properties: { info: assistantMsg },
    });

    const abortCtrl = new AbortController();
    this.activeTurns.set(sessionId, abortCtrl);

    // Launch background turn execution
    void this.executeTurn(sessionId, session, assistantMsg, text, abortCtrl);

    return userMsg;
  }

  async executeTurn(sessionId, session, assistantMsg, text, abortCtrl) {
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
      acpSession = await this.runtime.createSession({
        agentId: 'antigravity',
        cwd: session.location?.directory || process.cwd(),
      });

      if (abortCtrl.signal.aborted) return;

      const modelId = session.model?.id || 'gemini-4-argon-medium';
      await this.runtime.setModel(acpSession.sessionId, modelId).catch(() => {});

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
              type: 'message.part.updated',
              properties: { sessionID: sessionId, part: rPart },
            });
          }
          accumulatedThought += chunk.delta;
          const r = parts.find((p) => p.id === reasoningPartId);
          if (r) r.text = accumulatedThought;

          this.emitEvent({
            type: 'message.part.delta',
            properties: {
              sessionID: sessionId,
              messageID: assistantMsgId,
              partID: reasoningPartId,
              field: 'text',
              delta: chunk.delta,
            },
          });
        } else if (chunk.type === 'tool' && chunk.tool) {
          const callID = chunk.tool.callID || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const toolName = chunk.tool.name || chunk.tool.tool || 'bash';
          const toolArgs = chunk.tool.args || chunk.tool.input || {};
          const toolPart = {
            id: callID,
            sessionID: sessionId,
            messageID: assistantMsgId,
            callID,
            type: 'tool',
            tool: toolName,
            state: { status: 'running', input: toolArgs, time: { start: Date.now() } },
          };
          parts.push(toolPart);
          this.emitEvent({
            type: 'message.part.updated',
            properties: { sessionID: sessionId, part: toolPart },
          });
        } else if (chunk.type === 'text' && chunk.delta) {
          if (!hasTextPart) {
            hasTextPart = true;
            if (hasThoughtPart) {
              const r = parts.find((p) => p.id === reasoningPartId);
              if (r && !r.time?.end) {
                r.time = { ...r.time, end: Date.now() };
                this.emitEvent({
                  type: 'message.part.updated',
                  properties: { sessionID: sessionId, part: r },
                });
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
              type: 'message.part.updated',
              properties: { sessionID: sessionId, part: tPart },
            });
          }
          accumulatedText += chunk.delta;
          const t = parts.find((p) => p.id === textPartId);
          if (t) t.text = accumulatedText;

          this.emitEvent({
            type: 'message.part.delta',
            properties: {
              sessionID: sessionId,
              messageID: assistantMsgId,
              partID: textPartId,
              field: 'text',
              delta: chunk.delta,
            },
          });
        }
      });

      if (abortCtrl.signal.aborted) return;

      const t = parts.find((p) => p.id === textPartId);
      if (t && !t.time?.end) {
        t.time = { ...t.time, end: Date.now() };
      }
      assistantMsg.time.completed = Date.now();
      assistantMsg.finish = 'stop';
      session.time.idle = Date.now();

      const idleMsg = {
        id: `msg_${Date.now().toString(36)}_idle`,
        sessionID: sessionId,
        time: { created: Date.now() },
        type: 'idle',
        role: 'idle',
        outcome: 'succeeded',
      };
      session.messages.push(idleMsg);

      this.saveToDisk();

      this.emitEvent({
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'idle' } },
      });
      this.emitEvent({
        type: 'session.idle',
        properties: { sessionID: sessionId, outcome: 'succeeded' },
      });
    } catch (err) {
      if (abortCtrl.signal.aborted) return;
      assistantMsg.time.completed = Date.now();
      assistantMsg.finish = 'error';
      session.time.idle = Date.now();

      const idleMsg = {
        id: `msg_${Date.now().toString(36)}_idle`,
        sessionID: sessionId,
        time: { created: Date.now() },
        type: 'idle',
        role: 'idle',
        outcome: 'failed',
        error: { message: err.message },
      };
      session.messages.push(idleMsg);

      this.saveToDisk();

      this.emitEvent({
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'idle' } },
      });
      this.emitEvent({
        type: 'session.error',
        properties: { sessionID: sessionId, error: { message: err.message } },
      });
      this.emitEvent({
        type: 'session.idle',
        properties: { sessionID: sessionId, outcome: 'failed' },
      });
    } finally {
      this.activeTurns.delete(sessionId);
      if (acpSession) {
        this.runtime.closeSession(acpSession.sessionId);
      }
    }
  }

  subscribeEvent(listener) {
    this.on('event', listener);
    return () => {
      this.off('event', listener);
    };
  }

  emitEvent(payload) {
    this.emit('event', payload);
  }
}

let defaultBridge = null;

export function getAcpSessionBridge(options = {}) {
  if (!defaultBridge) {
    defaultBridge = new AcpSessionBridge(options);
  }
  return defaultBridge;
}
