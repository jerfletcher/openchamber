import fs from 'node:fs';
import path from 'node:path';
import EventEmitter from 'events';
import { DatabaseSync } from 'node:sqlite';
import { AcpRuntime, DEFAULT_ACP_AGENTS } from './acp-runtime.js';

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

const ACP_VARIANTS = new Set(['low', 'medium', 'high']);
const IDLE_PROCESS_TTL_MS = 20 * 60 * 1000;

/**
 * Translate OpenChamber prompt attachments into ACP content blocks.
 *
 * Capability gating (spec: /protocol/v1/content, /protocol/v1/initialization#prompt-capabilities):
 *  - `text` and `resource_link` are baseline — every Agent MUST support them.
 *  - `image`, `audio` and embedded `resource` blocks require the AGENT to have
 *    advertised `promptCapabilities.{image,audio,embeddedContext}` in
 *    `initialize`. Omitted capabilities are UNSUPPORTED, so an unadvertised
 *    attachment is converted into a text reference (dropped honestly, with a
 *    notice the caller can surface) instead of being sent and rejected.
 *
 * Returns `{ blocks, notices }` so callers can show what was degraded.
 */
export function buildPromptPayload(text, files, promptCapabilities = {}) {
  const caps = promptCapabilities || {};
  const blocks = [{ type: 'text', text }];
  const notices = [];

  const degrade = (capability, kind, name) => {
    const message = `[${kind} attachment "${name}" omitted: the agent did not advertise the "${capability}" prompt capability.]`;
    notices.push({ capability, kind, name, message });
    blocks.push({ type: 'text', text: message });
  };

  for (const file of Array.isArray(files) ? files : []) {
    const url = typeof file?.url === 'string' ? file.url : (typeof file?.uri === 'string' ? file.uri : '');
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    const mime = file?.mime || file?.mimeType || m?.[1] || '';
    const data = file?.data || m?.[2];
    const name = file?.filename || file?.name || 'file';

    // No inline payload: a resource link is the baseline way to reference it.
    if (!data) {
      const uri = typeof file?.uri === 'string' ? file.uri : url;
      if (uri && !uri.startsWith('data:')) blocks.push({ type: 'resource_link', uri, name });
      continue;
    }
    if (!mime) continue;

    if (mime.startsWith('image/')) {
      if (caps.image === true) blocks.push({ type: 'image', data, mimeType: mime });
      else degrade('image', 'Image', name);
    } else if (mime.startsWith('audio/')) {
      if (caps.audio === true) blocks.push({ type: 'audio', data, mimeType: mime });
      else degrade('audio', 'Audio', name);
    } else if (caps.embeddedContext === true) {
      let body = '';
      try { body = Buffer.from(data, 'base64').toString('utf8'); } catch { continue; }
      blocks.push({ type: 'resource', resource: { uri: `attachment://${name}`, mimeType: mime, text: body } });
    } else {
      degrade('embeddedContext', 'File', name);
    }
  }

  return { blocks, notices };
}

/** Backwards-compatible block-only view of {@link buildPromptPayload}. */
export function buildPromptBlocks(text, files, promptCapabilities = {}) {
  return buildPromptPayload(text, files, promptCapabilities).blocks;
}

export class AcpSessionBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.runtime = options.runtime || new AcpRuntime(options);
    this.dataDir = options.dataDir || path.join(process.env.HOME || '/home/jeremy', '.config', 'openchamber');
    this.storageFile = path.join(this.dataDir, 'acp-sessions.json');
    this.deletedHistoricalFile = path.join(this.dataDir, 'deleted-gemini-sessions.json');
    this.deletedHistoricalIds = new Set();
    this.sessions = new Map();
    this.activeTurns = new Map();
    this.eventHub = options.eventHub || null;
    this._eventSeq = 0;
    this.loadFromDisk();
    this.loadDeletedHistorical();
  }

  setEventHub(hub) {
    this.eventHub = hub;
  }

  _allAgentConfigs() {
    if (typeof this.runtime?.getRegisteredAgents === 'function') {
      return this.runtime.getRegisteredAgents();
    }
    return DEFAULT_ACP_AGENTS;
  }

  getAgentConfig(agentOrProviderId) {
    if (!agentOrProviderId) return null;
    return this._allAgentConfigs().find((a) => a.id === agentOrProviderId || a.providerId === agentOrProviderId) || null;
  }

  isAcpAgent(agentId) {
    return Boolean(agentId && this.getAgentConfig(agentId));
  }

  isAcpProvider(providerId) {
    return Boolean(providerId && this.getAgentConfig(providerId));
  }

  resolveAcpAgent({ agent, providerID, engine, agents } = {}) {
    if (agent && this.isAcpAgent(agent)) return this.getAgentConfig(agent);
    if (providerID && this.isAcpProvider(providerID)) return this.getAgentConfig(providerID);
    if (Array.isArray(agents)) {
      for (const entry of agents) {
        const name = typeof entry === 'string' ? entry : entry?.name || entry?.id;
        if (name && this.isAcpAgent(name)) return this.getAgentConfig(name);
      }
    }
    if (engine === 'acp') {
      return this.getAgentConfig('antigravity') || this._allAgentConfigs()[0] || null;
    }
    return null;
  }

  getCatalogAugmentation() {
    const available = typeof this.runtime?.getAvailableAgents === 'function'
      ? this.runtime.getAvailableAgents()
      : DEFAULT_ACP_AGENTS;
    const agents = [];
    const providers = [];
    const models = [];
    for (const cfg of available) {
      if (!Array.isArray(cfg.models) || cfg.models.length === 0) continue;
      const providerID = cfg.providerId || cfg.id;
      const defaultModelId = cfg.defaultModel || cfg.models[0]?.id;
      agents.push({
        id: cfg.id,
        name: cfg.id,
        description: cfg.description || cfg.name,
        mode: 'primary',
        model: defaultModelId ? { providerID, modelID: defaultModelId } : undefined,
        hidden: false,
        permissions: [],
        request: { settings: {}, headers: {}, body: {} },
      });
      providers.push({
        id: providerID,
        name: cfg.providerName || cfg.name || cfg.id,
        activation: 'enabled',
      });
      for (const m of cfg.models) {
        const variants = Array.isArray(m.variants)
          ? m.variants.map((v) => ({ id: v, settings: { reasoningEffort: v } }))
          : [];
        models.push({
          id: `${providerID}/${m.id}`,
          modelID: m.id,
          providerID,
          name: m.name || m.id,
          enabled: true,
          variants,
          limit: {
            context: m.context || 200000,
            input: m.context || 200000,
            output: m.output || 16000,
          },
          modalities: { input: ['text', 'image'] },
        });
      }
    }
    return { agents, providers, models };
  }

  loadDeletedHistorical() {
    try {
      if (fs.existsSync(this.deletedHistoricalFile)) {
        const raw = fs.readFileSync(this.deletedHistoricalFile, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.deletedHistoricalIds = new Set(list);
        }
      }
    } catch (e) {
      console.warn('[acp-bridge] Error loading deleted historical IDs:', e.message);
    }
  }

  saveDeletedHistorical() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      fs.writeFileSync(this.deletedHistoricalFile, JSON.stringify(Array.from(this.deletedHistoricalIds), null, 2), 'utf8');
    } catch (e) {
      console.warn('[acp-bridge] Error saving deleted historical IDs:', e.message);
    }
  }

  _getGeminiDb() {
    if (this._geminiDb !== undefined) return this._geminiDb;
    const geminiDbPath = path.join(process.env.HOME || '/home/jeremy', '.gemini', 'antigravity-cli', 'conversation_summaries.db');
    if (!fs.existsSync(geminiDbPath)) {
      this._geminiDb = null;
      return null;
    }
    try {
      this._geminiDb = new DatabaseSync(geminiDbPath, { readOnly: true });
    } catch (e) {
      console.warn('[acp-bridge] Error opening conversation_summaries.db:', e.message);
      this._geminiDb = null;
    }
    return this._geminiDb;
  }

  getGeminiHistorySessions() {
    const db = this._getGeminiDb();
    if (!db) return [];
    try {
      const rows = db.prepare(`
        SELECT conversation_id, title, preview, last_modified_time, workspace_uris, step_count
        FROM conversation_summaries
        WHERE step_count > 0
        ORDER BY last_modified_time DESC
      `).all();

      const results = [];
      for (const row of rows) {
        const convId = row.conversation_id;
        const sessionId = `ses_agy_${convId}`;
        if (this.deletedHistoricalIds.has(sessionId) || this.deletedHistoricalIds.has(convId)) {
          continue;
        }
        if (this.sessions.has(sessionId)) {
          continue;
        }

        let directory = null;
        try {
          const uris = JSON.parse(row.workspace_uris);
          if (Array.isArray(uris) && uris[0]) {
            directory = uris[0].replace(/^file:\/\//, '');
          }
        } catch {}

        const lastMod = row.last_modified_time ? new Date(row.last_modified_time).getTime() : Date.now();
        const title = row.title || row.preview || 'Antigravity Session';

        results.push({
          id: sessionId,
          title,
          location: { directory: directory || (process.env.HOME || '/home/jeremy') },
          agent: 'antigravity',
          model: { id: 'gemini-3.8-flash', providerID: 'antigravity' },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: lastMod, updated: lastMod, idle: lastMod },
          geminiConvId: convId,
          isHistoricalGemini: true,
        });
      }
      return results;
    } catch (e) {
      console.warn('[acp-bridge] Error listing historical Gemini sessions:', e.message);
      return [];
    }
  }

  loadTranscriptMessages(convId, sessionId) {
    const cleanConvId = (convId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanConvId) return [];
    const transcriptPath = path.join(process.env.HOME || '/home/jeremy', '.gemini', 'antigravity-cli', 'brain', cleanConvId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) return [];

    try {
      const raw = fs.readFileSync(transcriptPath, 'utf8');
      const lines = raw.split('\n');
      const messages = [];
      let currentAssistantMsg = null;
      const pendingTools = [];

      const extractUserPrompt = (text) => {
        if (!text) return '';
        const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        if (match) return match[1].trim();
        let clean = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '');
        clean = clean.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '');
        clean = clean.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, '');
        return clean.trim();
      };

      for (const line of lines) {
        if (!line.trim()) continue;
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        const ts = item.created_at ? new Date(item.created_at).getTime() : Date.now();

        if (item.type === 'USER_INPUT') {
          currentAssistantMsg = null;
          pendingTools.length = 0;
          const promptText = extractUserPrompt(item.content);
          if (!promptText) continue;
          messages.push({
            id: `msg_user_${item.step_index}`,
            sessionID: sessionId,
            type: 'user',
            role: 'user',
            text: promptText,
            content: [{ type: 'text', text: promptText }],
            time: { created: ts }
          });
        } else if (item.source === 'MODEL') {
          if (!currentAssistantMsg) {
            currentAssistantMsg = {
              id: `msg_asst_${item.step_index}`,
              sessionID: sessionId,
              type: 'assistant',
              role: 'assistant',
              agent: 'antigravity',
              model: { id: 'gemini-3.8-flash', providerID: 'antigravity' },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              content: [],
              time: { created: ts, completed: ts }
            };
            messages.push(currentAssistantMsg);
          }
          currentAssistantMsg.time.completed = ts;

          if (item.thinking) {
            currentAssistantMsg.content.push({
              type: 'reasoning',
              text: item.thinking,
              time: { created: ts, completed: ts }
            });
          }

          if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
            for (let i = 0; i < item.tool_calls.length; i++) {
              const tc = item.tool_calls[i];
              const callID = `call_${item.step_index}_${i}`;
              const toolPart = {
                type: 'tool',
                id: callID,
                callID,
                name: tc.name || 'tool',
                tool: tc.name || 'tool',
                args: tc.args || {},
                executed: true,
                time: { created: ts, ran: ts, completed: ts },
                state: {
                  status: 'completed',
                  input: tc.args || {},
                  output: '',
                  content: [{ type: 'text', text: '' }]
                }
              };
              currentAssistantMsg.content.push(toolPart);
              pendingTools.push(toolPart);
            }
          } else if (item.content && typeof item.content === 'string') {
            if (pendingTools.length > 0 && item.type === 'GENERIC') {
              const toolPart = pendingTools.shift();
              toolPart.state.output = item.content;
              toolPart.state.content = [{ type: 'text', text: item.content }];
              toolPart.time.completed = ts;
            } else if (!item.content.startsWith('Created At:') && !item.content.includes('Tool is running as a background task')) {
              currentAssistantMsg.content.push({ type: 'text', text: item.content });
            }
          }
        }
      }
      return messages;
    } catch (e) {
      console.warn(`[acp-bridge] Error loading transcript for ${cleanConvId}:`, e.message);
      return [];
    }
  }

  loadHistoricalSession(sessionId) {
    const rawConvId = sessionId.replace(/^ses_agy_/, '');
    const convId = rawConvId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!convId) return null;
    const db = this._getGeminiDb();
    if (!db) return null;

    try {
      const row = db.prepare(`
        SELECT conversation_id, title, preview, last_modified_time, workspace_uris
        FROM conversation_summaries
        WHERE conversation_id = ?
      `).get(convId);

      if (!row) return null;

      let directory = null;
      try {
        const uris = JSON.parse(row.workspace_uris);
        if (Array.isArray(uris) && uris[0]) {
          directory = uris[0].replace(/^file:\/\//, '');
        }
      } catch {}

      const lastMod = row.last_modified_time ? new Date(row.last_modified_time).getTime() : Date.now();
      const title = row.title || row.preview || 'Antigravity Session';
      const messages = this.loadTranscriptMessages(convId, sessionId);
      const resolvedDir = directory || (process.env.HOME || '/home/jeremy');

      const session = {
        id: sessionId,
        title,
        directory: resolvedDir,
        location: { directory: resolvedDir },
        agent: 'antigravity',
        model: { id: 'gemini-3.8-flash', providerID: 'antigravity' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: lastMod, updated: lastMod, idle: lastMod },
        geminiConvId: convId,
        isHistoricalGemini: true,
        messages,
      };

      this._sanitizeSession(session);
      this.sessions.set(sessionId, session);
      return session;
    } catch (e) {
      console.warn(`[acp-bridge] Error loading historical session ${sessionId}:`, e.message);
      return null;
    }
  }

  isHistoricalGeminiId(sessionId) {
    if (typeof sessionId !== 'string') return false;
    const convId = sessionId.replace(/^ses_agy_/, '');
    const db = this._getGeminiDb();
    if (!db) return false;
    try {
      const row = db.prepare('SELECT 1 FROM conversation_summaries WHERE conversation_id = ?').get(convId);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  _sanitizeSession(session) {
    if (!session || !Array.isArray(session.messages)) return session;
    const sessionModel = session.model || { id: 'gemini-3.8-flash', providerID: 'antigravity' };
    const sessionAgent = session.agent || 'antigravity';
    for (const msg of session.messages) {
      if (!msg) continue;
      if (msg.type === 'assistant') {
        if (!msg.role) msg.role = 'assistant';
        if (!msg.agent) msg.agent = sessionAgent;
        if (!msg.model) msg.model = sessionModel;
        if (!msg.providerID && msg.model?.providerID) msg.providerID = msg.model.providerID;
        if (!msg.modelID && msg.model?.id) msg.modelID = msg.model.id;
        if (msg.cost === undefined) msg.cost = 0;
        if (!msg.tokens) msg.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
        if (!msg.time) msg.time = { created: Date.now() };
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (!part) continue;
            if (part.type === 'thought') {
              part.type = 'reasoning';
              if (!part.time) {
                part.time = { created: msg.time.created, completed: msg.time.completed || msg.time.created };
              }
            }
            if (part.type === 'tool') {
              if (!part.id && part.callID) part.id = part.callID;
              if (!part.callID && part.id) part.callID = part.id;
              if (!part.name && part.tool) part.name = part.tool;
              if (!part.tool && part.name) part.tool = part.name;
              if (!part.name) { part.name = 'tool'; part.tool = 'tool'; }
              if (!part.time) {
                const start = part.state?.time?.start || msg.time?.created || Date.now();
                part.time = { created: start, ran: start, completed: msg.time?.completed || start };
              }
              if (part.executed === undefined) part.executed = true;
              if (!part.state) {
                part.state = { status: 'completed', input: part.args || {}, content: [{ type: 'text', text: '' }] };
              }
              if (part.state.status === 'running' && msg.time?.completed) {
                part.state.status = 'completed';
              }
              if (!part.state.content) {
                part.state.content = [{ type: 'text', text: part.state.output || '' }];
              }
            }
          }
        }
      } else if (msg.type === 'user') {
        if (!msg.role) msg.role = 'user';
        if (!msg.text && Array.isArray(msg.content) && msg.content[0]?.text) {
          msg.text = msg.content[0].text;
        }
        if (typeof msg.text !== 'string') msg.text = '';
        if (!msg.time) msg.time = { created: Date.now() };
        if (!Array.isArray(msg.content)) {
          msg.content = [{ type: 'text', text: msg.text }];
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
      const data = Array.from(this.sessions.values()).filter(s => !s.isHistoricalGemini);
      fs.writeFileSync(this.storageFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[acp-bridge] Failed to save sessions to disk:', err.message);
    }
  }

  isAcpSession(sessionId) {
    return typeof sessionId === 'string' && (
      sessionId.startsWith('ses_agy_') ||
      sessionId.startsWith('ses_acp_') ||
      this.sessions.has(sessionId) ||
      this.isHistoricalGeminiId(sessionId)
    );
  }

  listSessions(directory = null) {
    const activeList = Array.from(this.sessions.values());
    const historical = this.getGeminiHistorySessions();
    const all = [...activeList, ...historical];
    if (directory) {
      return all.filter((s) => !s.location?.directory || s.location.directory === directory);
    }
    return all;
  }

  getSession(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session && typeof sessionId === 'string' && (sessionId.startsWith('ses_agy_') || sessionId.startsWith('ses_acp_') || this.isHistoricalGeminiId(sessionId))) {
      session = this.loadHistoricalSession(sessionId);
    }
    return session ? this._sanitizeSession(session) : null;
  }

  getMessages(sessionId, query = {}) {
    const session = this.getSession(sessionId);
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
    const session = this.getSession(sessionId);
    if (!session || !session.messages) return null;
    this._sanitizeSession(session);
    return session.messages.find((m) => m.id === messageId) || null;
  }

  createSession({ id = null, title, directory = process.cwd(), agent = 'antigravity', model = null } = {}) {
    const cfg = this.getAgentConfig(agent) || this.getAgentConfig('antigravity');
    const agentId = cfg?.id || agent || 'antigravity';
    const providerID = cfg?.providerId || agentId;
    const defaultModel = cfg?.defaultModel || 'gemini-3.8-flash';
    const prefix = cfg?.sessionPrefix || (agentId === 'antigravity' ? 'ses_agy_' : `ses_acp_${agentId}_`);
    const folderLabel = cfg?.folderName || cfg?.name || 'ACP';
    const sessionId = id || `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const rawModel = typeof model === 'object' ? model?.id : model;
    const resolvedModel = ACP_MODEL_NORM[rawModel] || rawModel || defaultModel;
    const session = {
      id: sessionId,
      title: title || `New ${folderLabel} Session`,
      directory,
      location: { directory },
      agent: agentId,
      model: { id: resolvedModel, providerID },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: now, updated: now, idle: now },
      messages: [],
    };
    this.sessions.set(sessionId, session);
    this.saveToDisk();

    this.emitEvent({
      type: 'session.created',
      data: {
        ...session,
        sessionID: session.id,
        location: { directory },
      },
      properties: { info: session, session },
    }, directory);

    return session;
  }

  deleteSession(sessionId) {
    if (typeof sessionId === 'string') {
      const convId = sessionId.replace(/^ses_agy_/, '');
      this.deletedHistoricalIds.add(sessionId);
      this.deletedHistoricalIds.add(convId);
      this.saveDeletedHistorical();
    }
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
    if (typeof sessionId === 'string' && this.isHistoricalGeminiId(sessionId)) {
      this.emitEvent({
        type: 'session.deleted',
        data: { sessionID: sessionId },
        properties: { sessionID: sessionId },
      }, 'global');
      return true;
    }
    return false;
  }

  switchModel(sessionId, model) {
    const session = this.sessions.get(sessionId) || this.getSession(sessionId);
    if (!session) return false;
    const cfg = this.getAgentConfig(session.agent);
    const defaultModel = cfg?.defaultModel || 'gemini-3.8-flash';
    const modelId = typeof model === 'string' ? model : (model?.id || defaultModel);
    const resolvedModel = ACP_MODEL_NORM[modelId] || modelId;
    const providerID = (typeof model === 'object' && model?.providerID)
      || session.model?.providerID
      || cfg?.providerId
      || session.agent
      || 'antigravity';
    const rawVariant = typeof model === 'object' ? model?.variant : null;
    const variant = ACP_VARIANTS.has(rawVariant) ? rawVariant : null;
    session.model = { id: resolvedModel, providerID, ...(variant ? { variant } : {}) };
    session.time = session.time || {};
    session.time.updated = Date.now();
    this.saveToDisk();
    return true;
  }

  switchAgent(sessionId, agent) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const nextAgent = agent || session.agent || 'antigravity';
    session.agent = nextAgent;
    const cfg = this.getAgentConfig(nextAgent);
    if (cfg && session.model && session.model.providerID !== cfg.providerId) {
      session.model = {
        id: cfg.defaultModel || session.model.id,
        providerID: cfg.providerId || nextAgent,
      };
    }
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
    if (this.activeTurns.has(sessionId)) {
      throw new Error('Session is currently busy processing a turn.');
    }

    let session = this.sessions.get(sessionId);
    const directory = promptData.directory || session?.location?.directory || process.cwd();
    if (!session) {
      session = this.getSession(sessionId);
    }
    if (!session) {
      session = this.createSession({
        id: sessionId,
        title: 'Antigravity Session',
        directory,
      });
      sessionId = session.id;
    }

    if (session.isHistoricalGemini) {
      session.isHistoricalGemini = false;
      this.saveToDisk();
    }

    const text = promptData.text || promptData.prompt || promptData.content || '';
    if (!text.trim()) return null;

    if (session.messages.length === 0 || /^New .* Session$/.test(session.title || '')) {
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
    const sessionAgent = session.agent || 'antigravity';
    const cfg = this.getAgentConfig(sessionAgent);
    const providerID = session.model?.providerID || cfg?.providerId || sessionAgent;
    const rawModelId = session.model?.id || cfg?.defaultModel || 'gemini-3.8-flash-medium';
    const modelId = ACP_MODEL_NORM[rawModelId] || rawModelId;
    const parts = [];

    const assistantMsg = {
      id: assistantMsgId,
      sessionID: sessionId,
      time: { created: now + 1, streamed: now + 1 },
      type: 'assistant',
      role: 'assistant',
      agent: sessionAgent,
      providerID,
      modelID: modelId,
      model: { id: modelId, providerID },
      content: parts,
    };
    session.messages.push(assistantMsg);

    // Emit v2 wire events for user message and UI step start
    this.emitEvent({
      type: 'session.inbox.enqueued',
      data: {
        sessionID: sessionId,
        inboxID: userMsgId,
        item: {
          type: 'user',
          payload: { text },
        },
      },
      created: now,
    }, directory);

    this.emitEvent({
      type: 'session.inbox.delivered',
      data: {
        sessionID: sessionId,
        inboxID: userMsgId,
      },
      created: now,
    }, directory);

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
        agent: sessionAgent,
        model: { id: modelId, providerID },
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
    void this.executeTurn(sessionId, session, assistantMsg, text, abortCtrl, directory, promptData.files);

    return userMsg;
  }

  async executeTurn(sessionId, session, assistantMsg, text, abortCtrl, directory, files = []) {
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
        // Resume natively when the ACP agent already knows this conversation (history or restart).
        const resumeId = session.geminiConvId || existingAcpId || null;
        acpSession = await this.runtime.createSession({
          agentId: session.agent || 'antigravity',
          cwd: directory || session.location?.directory || process.cwd(),
          resumeSessionId: resumeId,
        });
        session.acpSessionId = acpSession.sessionId;
        this.saveToDisk();
      }

      if (abortCtrl.signal.aborted) return;

      const rawModelId = session.model?.id || 'gemini-3.8-flash';
      const baseModelId = ACP_MODEL_NORM[rawModelId] || rawModelId;
      const variant = ACP_VARIANTS.has(session.model?.variant) ? session.model.variant : 'medium';
      const acpTargetModel = `${baseModelId}-${variant}`;
      await this.runtime.setModel(acpSession.sessionId, acpTargetModel).catch(async () => {
        await this.runtime.setModel(acpSession.sessionId, baseModelId).catch(() => {});
      });

      const onAbort = () => {
        if (acpSession?.sessionId && typeof this.runtime.cancel === 'function') {
          this.runtime.cancel(acpSession.sessionId).catch(() => {});
        }
      };
      abortCtrl.signal.addEventListener('abort', onAbort, { once: true });

      // Only send content blocks the agent advertised it can accept.
      const { blocks: promptBlocks, notices } = buildPromptPayload(
        text,
        files,
        acpSession.promptCapabilities || {},
      );
      if (notices.length > 0) {
        assistantMsg.acpNotices = notices;
        for (const notice of notices) this.emit('notice', { sessionID: sessionId, ...notice });
      }

      const promptResult = await this.runtime.prompt(acpSession.sessionId, promptBlocks, (chunk) => {
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
          const callID = chunk.tool.toolCallId || chunk.tool.callID || chunk.tool.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const toolName = chunk.tool.name || chunk.tool.tool || 'bash';
          const toolArgs = chunk.tool.args || chunk.tool.rawInput || chunk.tool.input || {};
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
            type: 'session.tool.input.started',
            data: { sessionID: sessionId, assistantMessageID: assistantMsgId, id: callID, name: toolName },
            created: now,
          }, directory);
          this.emitEvent({
            type: 'session.tool.called',
            data: { sessionID: sessionId, assistantMessageID: assistantMsgId, id: callID, name: toolName, input: toolArgs, executed: true },
            created: now,
          }, directory);
        } else if (chunk.type === 'tool_update' && chunk.update) {
          const update = chunk.update;
          const callID = update.toolCallId || update.callID || update.id;
          const toolPart = parts.find((p) => p.type === 'tool' && (p.callID === callID || p.id === callID));
          if (toolPart) {
            let outputText = '';
            if (Array.isArray(update.content)) {
              outputText = update.content
                .map((c) => {
                  if (typeof c === 'string') return c;
                  if (c?.content?.text) return c.content.text;
                  if (c?.text) return c.text;
                  return '';
                })
                .filter(Boolean)
                .join('\n');
            } else if (update.rawOutput?.output) {
              outputText = update.rawOutput.output;
            } else if (typeof update.content === 'string') {
              outputText = update.content;
            }

            const now = Date.now();
            toolPart.time.completed = now;

            if (update.status === 'completed') {
              toolPart.state.status = 'completed';
              toolPart.state.output = outputText;
              toolPart.state.content = [{ type: 'text', text: outputText }];
              this.emitEvent({
                type: 'session.tool.success',
                data: {
                  sessionID: sessionId,
                  assistantMessageID: assistantMsgId,
                  id: toolPart.callID || toolPart.id,
                  content: toolPart.state.content,
                  executed: true,
                },
                created: now,
              }, directory);
            } else if (update.status === 'error' || update.status === 'failed') {
              toolPart.state.status = 'error';
              toolPart.state.output = outputText;
              toolPart.state.content = [{ type: 'text', text: outputText }];
              toolPart.state.error = { message: outputText || 'Tool failed' };
              this.emitEvent({
                type: 'session.tool.failed',
                data: {
                  sessionID: sessionId,
                  assistantMessageID: assistantMsgId,
                  id: toolPart.callID || toolPart.id,
                  error: toolPart.state.error,
                  content: toolPart.state.content,
                  executed: true,
                },
                created: now,
              }, directory);
            }
          }
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
      const usage = promptResult?.usage;
      if (usage) {
        const tokens = {
          input: usage.inputTokens || 0,
          output: usage.outputTokens || 0,
          reasoning: usage.thoughtTokens || 0,
          cache: { read: usage.cachedReadTokens || 0, write: usage.cachedWriteTokens || 0 },
        };
        assistantMsg.tokens = tokens;
        session.tokens = {
          input: (session.tokens?.input || 0) + tokens.input,
          output: (session.tokens?.output || 0) + tokens.output,
          reasoning: (session.tokens?.reasoning || 0) + tokens.reasoning,
          cache: {
            read: (session.tokens?.cache?.read || 0) + tokens.cache.read,
            write: (session.tokens?.cache?.write || 0) + tokens.cache.write,
          },
        };
      }
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
        data: {
          sessionID: sessionId,
          assistantMessageID: assistantMsgId,
          finish: 'stop',
          cost: assistantMsg.cost || 0,
          tokens: assistantMsg.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
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
      const structuredError = { type: 'Error', message: err?.message || String(err) };
      for (const p of parts) {
        if (p.type === 'tool' && p.state && p.state.status === 'running') {
          p.state.status = 'error';
          p.state.error = structuredError;
          p.time = p.time || { created: failedTime, ran: failedTime };
          p.time.completed = failedTime;
          this.emitEvent({
            type: 'session.tool.failed',
            data: {
              sessionID: sessionId,
              assistantMessageID: assistantMsgId,
              id: p.callID || p.id,
              error: structuredError,
              executed: true,
            },
            created: failedTime,
          }, directory);
        }
      }
      assistantMsg.time.completed = failedTime;
      assistantMsg.finish = 'error';
      assistantMsg.error = structuredError;
      session.time.idle = failedTime;
      if (session.time) delete session.time.busy;

      const idleMsg = {
        id: `msg_${failedTime.toString(36)}_idle`,
        sessionID: sessionId,
        time: { created: failedTime },
        type: 'idle',
        role: 'idle',
        outcome: 'failed',
        error: structuredError,
      };
      session.messages.push(idleMsg);

      this.saveToDisk();

      this.emitEvent({
        type: 'session.step.failed',
        data: {
          sessionID: sessionId,
          assistantMessageID: assistantMsgId,
          finish: 'error',
          error: structuredError,
        },
        created: failedTime,
      }, directory);

      this.emitEvent({
        type: 'session.execution.failed',
        data: { sessionID: sessionId, error: structuredError },
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
    const now = Number.isFinite(payload?.created) ? payload.created : Date.now();
    const wirePayload = {
      id: payload?.id || `evt_${now.toString(36)}_${(++this._eventSeq).toString(36)}`,
      created: now,
      ...(directory && directory !== 'global' && !payload?.location ? { location: { directory } } : {}),
      ...payload,
    };
    this.emit('event', wirePayload);
    if (this.eventHub && typeof this.eventHub.injectEvent === 'function') {
      try {
        this.eventHub.injectEvent({
          payload: wirePayload,
          directory: directory || 'global',
          spaceId: 'acp',
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
