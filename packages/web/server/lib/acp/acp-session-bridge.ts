import fs from 'node:fs';
import path from 'node:path';
import EventEmitter from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import {
  AcpRuntime,
  DEFAULT_ACP_AGENTS,
  type AcpAgentConfig,
  type AcpPendingPermissionRecord,
  type AcpPendingQuestionRecord,
  type AcpPromptBlock,
  type AcpRuntimeOptions,
} from './acp-runtime.js';
import {
  ACP_ERROR,
  AcpError,
} from './acp-protocol.js';
import type { JsonValue } from '../event-stream/contracts.js';

const ACP_MODEL_NORM: Record<string, string> = {
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

export interface AcpBridgeNotice {
  capability: string;
  kind: string;
  name: string;
  message: string;
}

export interface AcpBridgeEventHub {
  injectEvent?: (event: { payload: JsonValue; directory: string; spaceId: string | null }) => void;
}

export interface AcpSessionBridgeOptions extends AcpRuntimeOptions {
  runtime?: AcpRuntime;
  dataDir?: string;
  eventHub?: AcpBridgeEventHub | null;
  broadcastUiEvent?: ((payload: unknown) => void) | null;
}

interface TurnAbortController extends AbortController {
  finalizeOpenParts?: (endTime?: number) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bridge session objects carry dynamic OpenChamber/ACP wire shapes.
type DynamicRecord = Record<string, any>;

export function buildPromptPayload(
  text: string,
  files?: unknown[],
  promptCapabilities: { image?: boolean; audio?: boolean; embeddedContext?: boolean } = {},
): { blocks: AcpPromptBlock[]; notices: AcpBridgeNotice[] } {
  const caps = promptCapabilities || {};
  const blocks: AcpPromptBlock[] = [{ type: 'text', text }];
  const notices: AcpBridgeNotice[] = [];

  const degrade = (capability: string, kind: string, name: string) => {
    const message = `[${kind} attachment "${name}" omitted: the agent did not advertise the "${capability}" prompt capability.]`;
    notices.push({ capability, kind, name, message });
    blocks.push({ type: 'text', text: message });
  };

  for (const rawFile of Array.isArray(files) ? files : []) {
    const file = rawFile && typeof rawFile === 'object' ? (rawFile as DynamicRecord) : undefined;
    const url = typeof file?.url === 'string' ? file.url : (typeof file?.uri === 'string' ? file.uri : '');
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    const mime = (typeof file?.mime === 'string' ? file.mime : undefined)
      || (typeof file?.mimeType === 'string' ? file.mimeType : undefined)
      || m?.[1]
      || '';
    const data = file?.data || m?.[2];
    const name = String(file?.filename || file?.name || 'file');

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
      try { body = Buffer.from(String(data), 'base64').toString('utf8'); } catch { continue; }
      blocks.push({ type: 'resource', resource: { uri: `attachment://${name}`, mimeType: mime, text: body } });
    } else {
      degrade('embeddedContext', 'File', name);
    }
  }

  return { blocks, notices };
}

export function buildPromptBlocks(
  text: string,
  files?: unknown[],
  promptCapabilities: { image?: boolean; audio?: boolean; embeddedContext?: boolean } = {},
): AcpPromptBlock[] {
  return buildPromptPayload(text, files, promptCapabilities).blocks;
}

export function formatUnifiedDiff(filePath: unknown, oldText: unknown, newText: unknown): string {
  const target = typeof filePath === 'string' && filePath ? filePath : 'file';
  const before = typeof oldText === 'string' ? oldText : '';
  const after = typeof newText === 'string' ? newText : '';
  const oldLines = before === '' ? [] : before.replace(/\r\n/g, '\n').split('\n');
  const newLines = after === '' ? [] : after.replace(/\r\n/g, '\n').split('\n');
  const headerOld = before === '' ? '/dev/null' : `a/${target}`;
  const headerNew = after === '' ? '/dev/null' : `b/${target}`;
  const lines = [
    `--- ${headerOld}`,
    `+++ ${headerNew}`,
    `@@ -${oldLines.length > 0 ? 1 : 0},${oldLines.length} +${newLines.length > 0 ? 1 : 0},${newLines.length} @@`,
  ];
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const contextStart = Math.max(0, prefix - 3);
  for (let i = contextStart; i < prefix; i++) lines.push(` ${oldLines[i] ?? ''}`);
  for (let i = prefix; i < oldLines.length - suffix; i++) lines.push(`-${oldLines[i] ?? ''}`);
  for (let i = prefix; i < newLines.length - suffix; i++) lines.push(`+${newLines[i] ?? ''}`);
  const suffixStart = oldLines.length - suffix;
  const contextEnd = Math.min(oldLines.length, suffixStart + 3);
  for (let i = suffixStart; i < contextEnd; i++) lines.push(` ${oldLines[i] ?? ''}`);
  return lines.join('\n');
}

function extractToolUpdateContent(update: DynamicRecord) {
  const textParts: string[] = [];
  const diffs: Array<{ path: string; oldText: string; newText: string; unified: string }> = [];
  if (Array.isArray(update?.content)) {
    for (const c of update.content) {
      if (typeof c === 'string') {
        if (c) textParts.push(c);
      } else if (c?.type === 'diff') {
        const unified = formatUnifiedDiff(c.path, c.oldText, c.newText);
        diffs.push({
          path: c.path || '',
          oldText: c.oldText ?? '',
          newText: c.newText ?? '',
          unified,
        });
        textParts.push(unified);
      } else if (c?.content?.text) {
        textParts.push(String(c.content.text));
      } else if (c?.text) {
        textParts.push(String(c.text));
      }
    }
  } else if (typeof update?.content === 'string' && update.content) {
    textParts.push(update.content);
  }
  if (textParts.length === 0 && update?.rawOutput?.output) {
    textParts.push(String(update.rawOutput.output));
  }
  const outputText = textParts.filter(Boolean).join('\n');
  const unifiedDiff = diffs.map((d) => d.unified).join('\n\n');
  return { outputText, diffs, unifiedDiff };
}

export class AcpSessionBridge extends EventEmitter {
  runtime: AcpRuntime;
  dataDir: string;
  storageFile: string;
  deletedHistoricalFile: string;
  deletedHistoricalIds: Set<string>;
  sessions: Map<string, DynamicRecord>;
  activeTurns: Map<string, TurnAbortController>;
  pendingPermissions: Map<string, { sessionID: string; acpSessionId: string; request: AcpPendingPermissionRecord }>;
  pendingQuestions: Map<string, { sessionID: string; acpSessionId: string; formId: string; form: DynamicRecord; request: AcpPendingQuestionRecord }>;
  eventHub: AcpBridgeEventHub | null;
  uiBroadcaster: ((payload: unknown) => void) | null;
  _eventSeq: number;
  _geminiDb?: DatabaseSync | null;

  constructor(options: AcpSessionBridgeOptions = {}) {
    super();
    this.runtime = options.runtime || new AcpRuntime(options);
    this.dataDir = options.dataDir || path.join(process.env.HOME || '/home/jeremy', '.config', 'openchamber');
    this.storageFile = path.join(this.dataDir, 'acp-sessions.json');
    this.deletedHistoricalFile = path.join(this.dataDir, 'deleted-gemini-sessions.json');
    this.deletedHistoricalIds = new Set();
    this.sessions = new Map();
    this.activeTurns = new Map();
    this.pendingPermissions = new Map();
    this.pendingQuestions = new Map();
    this.eventHub = options.eventHub || null;
    this.uiBroadcaster = typeof options.broadcastUiEvent === 'function' ? options.broadcastUiEvent : null;
    this._eventSeq = 0;
    this.loadFromDisk();
    this.loadDeletedHistorical();

    if (typeof this.runtime.on === 'function') {
      this.runtime.on('permission_request', (request: AcpPendingPermissionRecord) => this.handlePermissionRequest(request));
      this.runtime.on('permission_settled', (settled: { requestId: string; sessionId: string; outcome: DynamicRecord }) => this.handlePermissionSettled(settled));
      this.runtime.on('question_request', (request: AcpPendingQuestionRecord) => this.handleQuestionRequest(request));
      this.runtime.on('question_settled', (settled: { requestId: string; sessionId: string; outcome: DynamicRecord }) => this.handleQuestionSettled(settled));
    }
  }

  setUiBroadcaster(broadcast: ((payload: unknown) => void) | null): void {
    this.uiBroadcaster = typeof broadcast === 'function' ? broadcast : null;
  }

  broadcastUiEvent(payload: unknown): boolean {
    if (!this.uiBroadcaster) return false;
    try {
      this.uiBroadcaster(payload);
      return true;
    } catch (err) {
      console.warn('[acp-bridge] Failed to broadcast the permission event:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  findSessionByAcpId(acpSessionId: string): DynamicRecord | null {
    for (const session of this.sessions.values()) {
      if (session.acpSessionId === acpSessionId) return session;
    }
    return null;
  }

  handlePermissionRequest(request: AcpPendingPermissionRecord): void {
    const session = this.findSessionByAcpId(request.sessionId);
    if (!session) {
      this.runtime.cancelPendingPermissions?.(request.sessionId);
      return;
    }
    const directory = session.location?.directory || 'global';
    this.pendingPermissions.set(request.requestId, {
      sessionID: session.id,
      acpSessionId: request.sessionId,
      request,
    });
    this.broadcastUiEvent({
      type: 'openchamber:acp-permission-asked',
      properties: {
        sessionID: session.id,
        requestId: request.requestId,
        directory: directory === 'global' ? null : directory,
        title: session.title || '',
        agent: session.agent || 'antigravity',
        toolCall: request.toolCall,
        options: request.options,
      },
    });
  }

  handlePermissionSettled({ requestId, sessionId, outcome }: { requestId: string; sessionId: string; outcome: DynamicRecord }): void {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    this.pendingPermissions.delete(requestId);
    this.broadcastUiEvent({
      type: 'openchamber:acp-permission-settled',
      properties: {
        sessionID: entry.sessionID,
        requestId,
        acpSessionId: sessionId,
        outcome: outcome?.outcome?.outcome || 'cancelled',
        ...(outcome?.outcome?.optionId ? { optionId: outcome.outcome.optionId } : {}),
      },
    });
  }

  listPendingPermissions(sessionID: string) {
    return Array.from(this.pendingPermissions.values())
      .filter((entry) => entry.sessionID === sessionID)
      .map((entry) => ({
        requestId: entry.request.requestId,
        sessionID: entry.sessionID,
        title: this.sessions.get(entry.sessionID)?.title || '',
        toolCall: entry.request.toolCall,
        options: entry.request.options,
        createdAt: entry.request.createdAt,
      }));
  }

  respondToPermission(sessionID: string, requestId: string, optionId: string | null | undefined) {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry || entry.sessionID !== sessionID) {
      throw new AcpError({
        code: ACP_ERROR.RESOURCE_NOT_FOUND,
        message: `Permission request '${requestId}' is not pending for session '${sessionID}'`,
        data: { sessionID, requestId },
      });
    }
    return this.runtime.respondToPermission(entry.acpSessionId, requestId, optionId);
  }

  cancelPermissions(sessionID: string): number {
    const acpSessionId = this.sessions.get(sessionID)?.acpSessionId;
    if (!acpSessionId) return 0;
    return this.runtime.cancelPendingPermissions?.(acpSessionId) || 0;
  }

  _findPendingQuestionEntry(requestOrFormId: string) {
    const direct = this.pendingQuestions.get(requestOrFormId);
    if (direct) return direct;
    for (const entry of this.pendingQuestions.values()) {
      if (entry.request.requestId === requestOrFormId) return entry;
    }
    return null;
  }

  handleQuestionRequest(request: AcpPendingQuestionRecord): void {
    const session = this.findSessionByAcpId(request.sessionId);
    if (!session) {
      this.runtime.cancelPendingQuestions?.(request.sessionId);
      return;
    }
    const directory = session.location?.directory || 'global';
    const formId = request.requestId.startsWith('frm_') ? request.requestId : `frm_${request.requestId}`;
    const form: DynamicRecord = {
      id: formId,
      sessionID: session.id,
      title: request.title || 'Question',
      metadata: {
        acp: true,
        requestId: request.requestId,
        method: request.method,
        ...(request.elicitationId ? { elicitationId: request.elicitationId } : {}),
        ...(request.message ? { message: request.message } : {}),
      },
      fields: request.fields,
    };
    this.pendingQuestions.set(formId, {
      sessionID: session.id,
      acpSessionId: request.sessionId,
      formId,
      form,
      request,
    });
    this.emitEvent({
      type: 'form.created',
      data: { form },
    }, directory);
  }

  handleQuestionSettled({ requestId, outcome }: { requestId: string; sessionId: string; outcome: DynamicRecord }): void {
    const entry = this._findPendingQuestionEntry(requestId);
    if (!entry) return;
    this.pendingQuestions.delete(entry.formId);
    const directory = this.sessions.get(entry.sessionID)?.location?.directory || 'global';
    if (outcome?.action === 'accept') {
      this.emitEvent({
        type: 'form.replied',
        data: {
          id: entry.formId,
          sessionID: entry.sessionID,
          answer: outcome.content && typeof outcome.content === 'object' ? outcome.content : {},
        },
      }, directory);
      return;
    }
    this.emitEvent({
      type: 'form.cancelled',
      data: {
        id: entry.formId,
        sessionID: entry.sessionID,
      },
    }, directory);
  }

  listPendingForms(sessionID?: string, directory?: string | null): DynamicRecord[] {
    return Array.from(this.pendingQuestions.values())
      .filter((entry) => {
        if (sessionID && entry.sessionID !== sessionID) return false;
        if (directory) {
          const sessionDir = this.sessions.get(entry.sessionID)?.location?.directory;
          if (sessionDir && sessionDir !== directory) return false;
        }
        return true;
      })
      .map((entry) => entry.form);
  }

  getPendingForm(sessionID: string, formID: string): DynamicRecord | null {
    const entry = this._findPendingQuestionEntry(formID);
    if (!entry || entry.sessionID !== sessionID) return null;
    return entry.form;
  }

  listPendingQuestions(sessionID: string) {
    return Array.from(this.pendingQuestions.values())
      .filter((entry) => entry.sessionID === sessionID)
      .map((entry) => ({
        requestId: entry.request.requestId,
        formId: entry.formId,
        sessionID: entry.sessionID,
        title: entry.form.title,
        fields: entry.form.fields,
        createdAt: entry.request.createdAt,
      }));
  }

  respondToQuestion(
    sessionID: string,
    requestOrFormId: string,
    answer: Record<string, unknown> | null | undefined,
  ) {
    const entry = this._findPendingQuestionEntry(requestOrFormId);
    if (!entry || entry.sessionID !== sessionID) {
      throw new AcpError({
        code: ACP_ERROR.RESOURCE_NOT_FOUND,
        message: `Question request '${requestOrFormId}' is not pending for session '${sessionID}'`,
        data: { sessionID, requestId: requestOrFormId },
      });
    }
    return this.runtime.respondToQuestion(entry.acpSessionId, entry.request.requestId, answer);
  }

  cancelQuestions(sessionID: string): number {
    const acpSessionId = this.sessions.get(sessionID)?.acpSessionId;
    if (!acpSessionId) return 0;
    return this.runtime.cancelPendingQuestions?.(acpSessionId) || 0;
  }

  setEventHub(hub: AcpBridgeEventHub | null): void {
    this.eventHub = hub;
  }

  _allAgentConfigs(): AcpAgentConfig[] {
    if (typeof this.runtime?.getRegisteredAgents === 'function') {
      return this.runtime.getRegisteredAgents();
    }
    return DEFAULT_ACP_AGENTS;
  }

  getAgentConfig(agentOrProviderId: unknown): AcpAgentConfig | null {
    if (typeof agentOrProviderId !== 'string' || !agentOrProviderId) return null;
    return this._allAgentConfigs().find((a) => a.id === agentOrProviderId || a.providerId === agentOrProviderId) || null;
  }

  isAcpAgent(agentId: unknown): boolean {
    return Boolean(agentId && this.getAgentConfig(agentId));
  }

  isAcpProvider(providerId: unknown): boolean {
    return Boolean(providerId && this.getAgentConfig(providerId));
  }

  resolveAcpAgent({ agent, providerID, engine, agents }: { agent?: unknown; providerID?: unknown; engine?: unknown; agents?: unknown } = {}): AcpAgentConfig | null {
    if (agent && this.isAcpAgent(agent)) return this.getAgentConfig(agent);
    if (providerID && this.isAcpProvider(providerID)) return this.getAgentConfig(providerID);
    if (Array.isArray(agents)) {
      for (const entry of agents) {
        const name = typeof entry === 'string' ? entry : (entry as DynamicRecord | null)?.name || (entry as DynamicRecord | null)?.id;
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
    const agents: Array<DynamicRecord & { id: string }> = [];
    const providers: Array<DynamicRecord & { id: string }> = [];
    const models: Array<DynamicRecord & { id: string; variants?: unknown[] }> = [];
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

  loadDeletedHistorical(): void {
    try {
      if (fs.existsSync(this.deletedHistoricalFile)) {
        const raw = fs.readFileSync(this.deletedHistoricalFile, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.deletedHistoricalIds = new Set(list.filter((id): id is string => typeof id === 'string'));
        }
      }
    } catch (e) {
      console.warn('[acp-bridge] Error loading deleted historical IDs:', e instanceof Error ? e.message : e);
    }
  }

  saveDeletedHistorical(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      fs.writeFileSync(this.deletedHistoricalFile, JSON.stringify(Array.from(this.deletedHistoricalIds), null, 2), 'utf8');
    } catch (e) {
      console.warn('[acp-bridge] Error saving deleted historical IDs:', e instanceof Error ? e.message : String(e));
    }
  }

  _getGeminiDb(): DatabaseSync | null {
    if (this._geminiDb !== undefined) return this._geminiDb;
    const geminiDbPath = path.join(process.env.HOME || '/home/jeremy', '.gemini', 'antigravity-cli', 'conversation_summaries.db');
    if (!fs.existsSync(geminiDbPath)) {
      this._geminiDb = null;
      return null;
    }
    try {
      this._geminiDb = new DatabaseSync(geminiDbPath, { readOnly: true });
    } catch (e) {
      console.warn('[acp-bridge] Error opening conversation_summaries.db:', e instanceof Error ? e.message : String(e));
      this._geminiDb = null;
    }
    return this._geminiDb;
  }

  getGeminiHistorySessions(): DynamicRecord[] {
    const db = this._getGeminiDb();
    if (!db) return [];
    try {
      const rows = db.prepare(`
        SELECT conversation_id, title, preview, last_modified_time, workspace_uris, step_count
        FROM conversation_summaries
        WHERE step_count > 0
        ORDER BY last_modified_time DESC
      `).all() as Array<{
        conversation_id?: string | null;
        title?: string | null;
        preview?: string | null;
        last_modified_time?: string | number | null;
        workspace_uris?: string | null;
        step_count?: number | null;
      }>;

      const results: DynamicRecord[] = [];
      for (const row of rows) {
        const convId = String(row.conversation_id || '');
        if (!convId) continue;
        const sessionId = `ses_agy_${convId}`;
        if (this.deletedHistoricalIds.has(sessionId) || this.deletedHistoricalIds.has(convId)) {
          continue;
        }
        if (this.sessions.has(sessionId)) {
          continue;
        }

        let directory: string | null = null;
        try {
          const uris = row.workspace_uris ? JSON.parse(String(row.workspace_uris)) : null;
          if (Array.isArray(uris) && typeof uris[0] === 'string' && uris[0]) {
            directory = uris[0].replace(/^file:\/\//, '');
          }
        } catch { /* ignore */ }

        const lastMod = row.last_modified_time ? new Date(String(row.last_modified_time)).getTime() : Date.now();
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
      console.warn('[acp-bridge] Error listing historical Gemini sessions:', e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  loadTranscriptMessages(convId: string, sessionId: string): DynamicRecord[] {
    const cleanConvId = (convId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanConvId) return [];
    const transcriptPath = path.join(process.env.HOME || '/home/jeremy', '.gemini', 'antigravity-cli', 'brain', cleanConvId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) return [];

    try {
      const raw = fs.readFileSync(transcriptPath, 'utf8');
      const lines = raw.split('\n');
      const messages: DynamicRecord[] = [];
      let currentAssistantMsg: DynamicRecord | null = null;
      const pendingTools: DynamicRecord[] = [];

      const extractUserPrompt = (text: unknown): string => {
        if (typeof text !== 'string' || !text) return '';
        const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        if (match && typeof match[1] === 'string') return match[1].trim();
        let clean = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '');
        clean = clean.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '');
        clean = clean.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/g, '');
        return clean.trim();
      };

      for (const line of lines) {
        if (!line.trim()) continue;
        let item: DynamicRecord;
        try { item = JSON.parse(line) as DynamicRecord; } catch { continue; }
        const ts = item.created_at ? new Date(String(item.created_at)).getTime() : Date.now();

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
              const tc = item.tool_calls[i] as DynamicRecord;
              const callID = `call_${item.step_index}_${i}`;
              const toolPart: DynamicRecord = {
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
              if (toolPart) {
                toolPart.state.output = item.content;
                toolPart.state.content = [{ type: 'text', text: item.content }];
                toolPart.time.completed = ts;
              }
            } else if (!item.content.startsWith('Created At:') && !item.content.includes('Tool is running as a background task')) {
              currentAssistantMsg.content.push({ type: 'text', text: item.content });
            }
          }
        }
      }
      return messages;
    } catch (e) {
      console.warn(`[acp-bridge] Error loading transcript for ${cleanConvId}:`, e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  loadHistoricalSession(sessionId: string): DynamicRecord | null {
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
      `).get(convId) as {
        conversation_id?: string | null;
        title?: string | null;
        preview?: string | null;
        last_modified_time?: string | number | null;
        workspace_uris?: string | null;
      } | undefined;

      if (!row) return null;

      let directory: string | null = null;
      try {
        const uris = row.workspace_uris ? JSON.parse(String(row.workspace_uris)) : null;
        if (Array.isArray(uris) && typeof uris[0] === 'string' && uris[0]) {
          directory = uris[0].replace(/^file:\/\//, '');
        }
      } catch { /* ignore */ }

      const lastMod = row.last_modified_time ? new Date(String(row.last_modified_time)).getTime() : Date.now();
      const title = row.title || row.preview || 'Antigravity Session';
      const messages = this.loadTranscriptMessages(convId, sessionId);
      const resolvedDir = directory || (process.env.HOME || '/home/jeremy');

      const session: DynamicRecord = {
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
      console.warn(`[acp-bridge] Error loading historical session ${sessionId}:`, e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  isHistoricalGeminiId(sessionId: unknown): boolean {
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

  _sanitizeSession(session: DynamicRecord | null): DynamicRecord | null {
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

  loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, 'utf8');
        const data = JSON.parse(raw) as unknown;
        if (Array.isArray(data)) {
          for (const s of data) {
            if (s && typeof s === 'object' && typeof (s as DynamicRecord).id === 'string') {
              const record = s as DynamicRecord;
              this._sanitizeSession(record);
              this.sessions.set(record.id, record);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[acp-bridge] Failed to load sessions from disk:', err instanceof Error ? err.message : String(err));
    }
  }

  saveToDisk(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      const data = Array.from(this.sessions.values()).filter(s => !s.isHistoricalGemini);
      fs.writeFileSync(this.storageFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[acp-bridge] Failed to save sessions to disk:', err instanceof Error ? err.message : String(err));
    }
  }

  isAcpSession(sessionId: unknown): boolean {
    return typeof sessionId === 'string' && (
      sessionId.startsWith('ses_agy_') ||
      sessionId.startsWith('ses_acp_') ||
      this.sessions.has(sessionId) ||
      this.isHistoricalGeminiId(sessionId)
    );
  }

  listSessions(directory: string | null = null): DynamicRecord[] {
    const activeList = Array.from(this.sessions.values());
    const historical = this.getGeminiHistorySessions();
    const all = [...activeList, ...historical];
    if (directory) {
      return all.filter((s) => !s.location?.directory || s.location.directory === directory);
    }
    return all;
  }

  getSession(sessionId: string): DynamicRecord | null {
    let session: DynamicRecord | null | undefined = this.sessions.get(sessionId);
    if (!session && typeof sessionId === 'string' && (sessionId.startsWith('ses_agy_') || sessionId.startsWith('ses_acp_') || this.isHistoricalGeminiId(sessionId))) {
      session = this.loadHistoricalSession(sessionId);
    }
    return session ? this._sanitizeSession(session) : null;
  }

  getMessages(sessionId: string, query: unknown = {}): { data: DynamicRecord[]; cursor: DynamicRecord } {
    const session = this.getSession(sessionId);
    if (!session) return { data: [], cursor: {} };
    this._sanitizeSession(session);
    const queryObj = query && typeof query === 'object' ? (query as DynamicRecord) : {};
    let msgs: DynamicRecord[] = Array.isArray(session.messages) ? session.messages.slice() : [];
    const order = queryObj.order || 'desc';
    if (order === 'desc') {
      msgs.reverse();
    }
    const limit = queryObj.limit !== undefined && queryObj.limit !== null ? parseInt(String(queryObj.limit), 10) : null;
    if (limit && limit > 0 && msgs.length > limit) {
      msgs = msgs.slice(0, limit);
    }
    return { data: msgs, cursor: {} };
  }

  getMessage(sessionId: string, messageId: string): DynamicRecord | null {
    const session = this.getSession(sessionId);
    if (!session || !Array.isArray(session.messages)) return null;
    this._sanitizeSession(session);
    return session.messages.find((m: DynamicRecord) => m.id === messageId) || null;
  }

  createSession({
    id = null,
    title,
    directory = process.cwd(),
    agent = 'antigravity',
    model = null,
  }: {
    id?: unknown;
    title?: unknown;
    directory?: string | undefined;
    agent?: string | undefined;
    model?: unknown;
  } = {}): DynamicRecord {
    const cfg = this.getAgentConfig(agent) || this.getAgentConfig('antigravity');
    const agentId = cfg?.id || agent || 'antigravity';
    const providerID = cfg?.providerId || agentId;
    const defaultModel = cfg?.defaultModel || 'gemini-3.8-flash';
    const prefix = cfg?.sessionPrefix || (agentId === 'antigravity' ? 'ses_agy_' : `ses_acp_${agentId}_`);
    const folderLabel = cfg?.folderName || cfg?.name || 'ACP';
    const explicitId = typeof id === 'string' && id ? id : null;
    const sessionId = explicitId || `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const explicitTitle = typeof title === 'string' && title ? title : null;
    const now = Date.now();
    const rawModel = typeof model === 'object' && model !== null
      ? String((model as DynamicRecord).id || '')
      : typeof model === 'string'
        ? model
        : '';
    const resolvedModel = ACP_MODEL_NORM[rawModel] || rawModel || defaultModel;
    const session: DynamicRecord = {
      id: sessionId,
      title: explicitTitle || `New ${folderLabel} Session`,
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

  deleteSession(sessionId: string): boolean {
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

  _syncAcpSessionState(session: DynamicRecord | null, acpSession: DynamicRecord | null, directory = 'global'): void {
    if (!session || !acpSession) return;
    let changed = false;
    if (Array.isArray(acpSession.configOptions)) {
      session.configOptions = acpSession.configOptions;
      changed = true;
    }
    if (Array.isArray(acpSession.availableModels)) {
      session.availableModels = acpSession.availableModels;
    }
    if (Array.isArray(acpSession.availableModes)) {
      session.availableModes = acpSession.availableModes;
    }
    if (typeof acpSession.currentModeId === 'string' && acpSession.currentModeId) {
      session.currentModeId = acpSession.currentModeId;
    }
    if (typeof acpSession.currentModelId === 'string' && acpSession.currentModelId) {
      session.currentModelId = acpSession.currentModelId;
    }
    if (Array.isArray(acpSession.availableCommands) && acpSession.availableCommands.length > 0) {
      session.availableCommands = acpSession.availableCommands;
      this.emitEvent({
        type: 'openchamber:acp-commands',
        properties: { sessionID: session.id, availableCommands: acpSession.availableCommands },
      }, directory);
    }
    if (changed) {
      this.saveToDisk();
      this.emitEvent({
        type: 'openchamber:acp-config-options',
        properties: {
          sessionID: session.id,
          configOptions: session.configOptions || [],
          currentModeId: session.currentModeId ?? null,
          currentModelId: session.currentModelId ?? null,
          availableModels: session.availableModels || [],
          availableModes: session.availableModes || [],
        },
      }, directory);
    }
  }

  _applyAcpChunk(session: DynamicRecord | null, chunk: DynamicRecord | null, directory = 'global'): boolean {
    if (!session || !chunk) return false;
    if (chunk.type === 'plan') {
      const entries = Array.isArray(chunk.entries) ? chunk.entries : [];
      session.acpPlan = entries;
      this.saveToDisk();
      this.emitEvent({
        type: 'openchamber:acp-plan',
        properties: { sessionID: session.id, entries },
      }, directory);
      return true;
    }
    if (chunk.type === 'mode') {
      const modeId = typeof chunk.modeId === 'string' ? chunk.modeId : '';
      session.currentModeId = modeId;
      this.saveToDisk();
      this.emitEvent({
        type: 'openchamber:acp-mode',
        properties: { sessionID: session.id, modeId },
      }, directory);
      return true;
    }
    if (chunk.type === 'config_options') {
      const configOptions = Array.isArray(chunk.configOptions) ? (chunk.configOptions as DynamicRecord[]) : [];
      session.configOptions = configOptions;
      const modeOpt = configOptions.find((o) => o?.id === 'mode');
      if (typeof modeOpt?.currentValue === 'string' && modeOpt.currentValue) {
        session.currentModeId = modeOpt.currentValue;
      }
      const modelOpt = configOptions.find((o) => o?.id === 'model');
      if (typeof modelOpt?.currentValue === 'string' && modelOpt.currentValue) {
        session.currentModelId = modelOpt.currentValue;
      }
      this.saveToDisk();
      this.emitEvent({
        type: 'openchamber:acp-config-options',
        properties: {
          sessionID: session.id,
          configOptions,
          currentModeId: session.currentModeId ?? null,
          currentModelId: session.currentModelId ?? null,
          availableModels: session.availableModels || [],
          availableModes: session.availableModes || [],
        },
      }, directory);
      return true;
    }
    if (chunk.type === 'commands') {
      const availableCommands = Array.isArray(chunk.availableCommands) ? chunk.availableCommands : [];
      session.availableCommands = availableCommands;
      this.saveToDisk();
      this.emitEvent({
        type: 'openchamber:acp-commands',
        properties: { sessionID: session.id, availableCommands },
      }, directory);
      return true;
    }
    return false;
  }

  async _applyRuntimeModelAndVariant(
    acpSessionId: string,
    baseModelId: string,
    variant: string | null,
    session: DynamicRecord | null = null,
    directory = 'global',
  ): Promise<void> {
    if (!acpSessionId) return;
    let modelApplied = false;
    if (typeof this.runtime.setConfigOption === 'function') {
      try {
        const res = await this.runtime.setConfigOption(acpSessionId, 'model', baseModelId) as DynamicRecord | undefined;
        modelApplied = true;
        if (session && Array.isArray(res?.configOptions)) {
          this._applyAcpChunk(session, { type: 'config_options', configOptions: res.configOptions }, directory);
        }
      } catch {
        // Fall back to setModel below
      }
    }
    if (!modelApplied && typeof this.runtime.setModel === 'function') {
      await this.runtime.setModel(acpSessionId, baseModelId).catch(() => {});
    }

    if (variant) {
      let thoughtApplied = false;
      if (typeof this.runtime.setConfigOption === 'function') {
        try {
          const res = await this.runtime.setConfigOption(acpSessionId, 'thought_level', variant) as DynamicRecord | undefined;
          thoughtApplied = true;
          if (session && Array.isArray(res?.configOptions)) {
            this._applyAcpChunk(session, { type: 'config_options', configOptions: res.configOptions }, directory);
          }
        } catch {
          // Agent may only accept `${baseModelId}-${variant}` via setModel
        }
      }
      if (!thoughtApplied && typeof this.runtime.setModel === 'function') {
        await this.runtime.setModel(acpSessionId, `${baseModelId}-${variant}`).catch(() => {});
      }
    }
  }

  switchModel(sessionId: string, model: unknown): boolean {
    const session = this.sessions.get(sessionId) || this.getSession(sessionId);
    if (!session) return false;
    const cfg = this.getAgentConfig(session.agent);
    const defaultModel = cfg?.defaultModel || 'gemini-3.8-flash';
    const modelObj = typeof model === 'object' && model !== null ? (model as DynamicRecord) : null;
    const modelId = typeof model === 'string' ? model : (typeof modelObj?.id === 'string' && modelObj.id ? modelObj.id : defaultModel);
    const resolvedModel = ACP_MODEL_NORM[modelId] || modelId;
    const providerID = (typeof modelObj?.providerID === 'string' && modelObj.providerID)
      || session.model?.providerID
      || cfg?.providerId
      || session.agent
      || 'antigravity';
    const rawVariant = typeof modelObj?.variant === 'string' ? modelObj.variant : null;
    const variant = rawVariant && ACP_VARIANTS.has(rawVariant) ? rawVariant : null;
    session.model = { id: resolvedModel, providerID, ...(variant ? { variant } : {}) };
    session.time = session.time || {};
    session.time.updated = Date.now();
    this.saveToDisk();

    const directory = session.location?.directory || 'global';
    const isAlive = session.acpSessionId && (
      typeof this.runtime.isSessionAlive === 'function'
        ? this.runtime.isSessionAlive(session.acpSessionId)
        : Boolean(this.runtime.getSession?.(session.acpSessionId))
    );
    if (isAlive) {
      void this._applyRuntimeModelAndVariant(session.acpSessionId, resolvedModel, variant, session, directory);
    }

    this.emitEvent({
      type: 'session.model.selected',
      data: { sessionID: sessionId, model: session.model },
      properties: { sessionID: sessionId, model: session.model },
    }, directory);
    return true;
  }

  switchAgent(sessionId: string, agent: unknown): boolean {
    const session = this.sessions.get(sessionId) || this.getSession(sessionId);
    if (!session) return false;
    const nextAgent = (typeof agent === 'string' && agent ? agent : null) || session.agent || 'antigravity';
    session.agent = nextAgent;
    const cfg = this.getAgentConfig(nextAgent);
    const matchesProvider = !session.model?.providerID
      || session.model.providerID === cfg?.providerId
      || session.model.providerID === cfg?.id
      || session.model.providerID === nextAgent;
    if (cfg && session.model && !matchesProvider) {
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

  addSyntheticContext(
    sessionId: string,
    payload: DynamicRecord = {},
  ): { ok: true; id: string; sessionID: string } | null {
    const session = this.sessions.get(sessionId) || this.getSession(sessionId);
    if (!session) return null;
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (!text.trim()) return null;
    const entry = {
      id: payload.id || `syn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      text,
      ...(payload.description ? { description: payload.description } : {}),
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
      created: Date.now(),
    };
    if (!Array.isArray(session.pendingSyntheticContext)) {
      session.pendingSyntheticContext = [];
    }
    session.pendingSyntheticContext.push(entry);
    session.time = session.time || {};
    session.time.updated = Date.now();
    this.saveToDisk();
    return { ok: true, id: entry.id, sessionID: sessionId };
  }

  updateSession(
    sessionId: string,
    updates: DynamicRecord = {},
  ): boolean {
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

  abortTurn(sessionId: string): boolean {
    const abortCtrl = this.activeTurns.get(sessionId);
    if (abortCtrl) {
      const abortTime = Date.now();
      abortCtrl.abort();
      this.activeTurns.delete(sessionId);
      if (typeof abortCtrl.finalizeOpenParts === 'function') {
        abortCtrl.finalizeOpenParts(abortTime);
      }
      const session = this.sessions.get(sessionId);
      const directory = session?.location?.directory || 'global';
      if (session) {
        this.cancelPermissions(sessionId);
        this.cancelQuestions(sessionId);
        if (session.acpSessionId && typeof this.runtime.cancel === 'function') {
          this.runtime.cancel(session.acpSessionId).catch(() => {});
        }
        session.outcome = 'interrupted';
        if (session.time) delete session.time.busy;
        session.time.idle = abortTime;
        const idleMsg = {
          id: `msg_${abortTime.toString(36)}_idle`,
          sessionID: sessionId,
          time: { created: abortTime },
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
        created: abortTime,
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

  async startTurn(sessionId: string, promptData: DynamicRecord): Promise<DynamicRecord | null> {
    if (this.activeTurns.has(sessionId)) {
      throw new Error('Session is currently busy processing a turn.');
    }

    let session: DynamicRecord | null | undefined = this.sessions.get(sessionId);
    const directory = typeof promptData.directory === 'string' && promptData.directory
      ? promptData.directory
      : (session?.location?.directory || process.cwd());
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

    const text = String(promptData.text || promptData.prompt || promptData.content || '');
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
    delete session.outcome;
    delete session.error;
    session.time.busy = now;
    session.time.updated = now;

    // 1. User Message
    const userMsgId = promptData.id || `msg_${now.toString(36)}_u`;
    const userMsg: DynamicRecord = {
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
    const parts: DynamicRecord[] = [];

    const assistantMsg: DynamicRecord = {
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

    const abortCtrl: TurnAbortController = new AbortController();
    this.activeTurns.set(sessionId, abortCtrl);

    // Launch background turn execution
    void this.executeTurn(sessionId, session, assistantMsg, text, abortCtrl, directory, Array.isArray(promptData.files) ? promptData.files : []);

    return userMsg;
  }

  async executeTurn(
    sessionId: string,
    session: DynamicRecord,
    assistantMsg: DynamicRecord,
    text: string,
    abortCtrl: TurnAbortController,
    directory: string,
    files: unknown[] = [],
  ): Promise<void> {
    let acpSession: DynamicRecord | null = null;
    const assistantMsgId = assistantMsg.id;
    let nextReasoningOrdinal = 0;
    let nextTextOrdinal = 0;
    let activeReasoning: { id: string; ordinal: number; part: DynamicRecord; text: string } | null = null;
    let activeText: { id: string; ordinal: number; part: DynamicRecord; text: string } | null = null;
    const parts: DynamicRecord[] = assistantMsg.content;

    const closeActiveReasoning = (endTime = Date.now()): void => {
      if (!activeReasoning) return;
      const { part, ordinal, text: rText } = activeReasoning;
      activeReasoning = null;
      if (!part.time?.end) {
        part.time = { ...part.time, end: endTime };
        this.emitEvent({
          type: 'session.reasoning.ended',
          data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal, text: rText },
          created: endTime,
        }, directory);
      }
    };

    const closeActiveText = (endTime = Date.now()): void => {
      if (!activeText) return;
      const { part, ordinal, text: tText } = activeText;
      activeText = null;
      if (!part.time?.end) {
        part.time = { ...part.time, end: endTime };
        this.emitEvent({
          type: 'session.text.ended',
          data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal, text: tText },
          created: endTime,
        }, directory);
      }
    };

    const finalizeOpenParts = (endTime = Date.now()): void => {
      closeActiveReasoning(endTime);
      closeActiveText(endTime);
    };
    abortCtrl.finalizeOpenParts = finalizeOpenParts;

    try {
      const existingAcpId = session.acpSessionId;
      const isAlive = existingAcpId && typeof this.runtime.isSessionAlive === 'function'
        ? this.runtime.isSessionAlive(existingAcpId)
        : Boolean(existingAcpId && this.runtime.getSession(existingAcpId));

      if (isAlive) {
        acpSession = (this.runtime.getSession(existingAcpId) as DynamicRecord | undefined) || { sessionId: existingAcpId };
      } else {
        // Resume natively when the ACP agent already knows this conversation (history or restart).
        const resumeId = session.geminiConvId || existingAcpId || null;
        acpSession = (await this.runtime.createSession({
          agentId: session.agent || 'antigravity',
          cwd: directory || session.location?.directory || process.cwd(),
          resumeSessionId: resumeId,
        })) as DynamicRecord;
        session.acpSessionId = acpSession.sessionId;
        this.saveToDisk();
      }

      this._syncAcpSessionState(session, acpSession, directory);

      if (abortCtrl.signal.aborted) return;

      const rawModelId = session.model?.id || 'gemini-3.8-flash';
      const baseModelId = ACP_MODEL_NORM[rawModelId] || rawModelId;
      const variant = ACP_VARIANTS.has(session.model?.variant) ? session.model.variant : null;
      await this._applyRuntimeModelAndVariant(acpSession.sessionId, baseModelId, variant, session, directory);

      if (session.currentModeId) {
        let modeApplied = false;
        if (typeof this.runtime.setConfigOption === 'function') {
          try {
            const res = await this.runtime.setConfigOption(acpSession.sessionId, 'mode', session.currentModeId) as DynamicRecord | undefined;
            modeApplied = true;
            if (Array.isArray(res?.configOptions)) {
              this._applyAcpChunk(session, { type: 'config_options', configOptions: res.configOptions }, directory);
            }
          } catch {
            // Fall back to setMode below
          }
        }
        if (!modeApplied && typeof this.runtime.setMode === 'function') {
          await this.runtime.setMode(acpSession.sessionId, session.currentModeId).catch(() => {});
        }
      }

      const onAbort = (): void => {
        if (acpSession?.sessionId && typeof this.runtime.cancel === 'function') {
          this.runtime.cancel(acpSession.sessionId).catch(() => {});
        }
      };
      abortCtrl.signal.addEventListener('abort', onAbort, { once: true });

      // Only send content blocks the agent advertised it can accept.
      const { blocks: baseBlocks, notices } = buildPromptPayload(
        text,
        files,
        acpSession.promptCapabilities || {},
      );
      const promptBlocks = [...baseBlocks];
      if (Array.isArray(session.pendingSyntheticContext) && session.pendingSyntheticContext.length > 0) {
        const syntheticBlocks = session.pendingSyntheticContext
          .filter((entry: DynamicRecord) => typeof entry?.text === 'string' && entry.text.trim())
          .map((entry: DynamicRecord) => ({ type: 'text', text: String(entry.text) }));
        promptBlocks.unshift(...syntheticBlocks);
        session.pendingSyntheticContext = [];
        this.saveToDisk();
      }
      if (notices.length > 0) {
        assistantMsg.acpNotices = notices;
        for (const notice of notices) this.emit('notice', { sessionID: sessionId, ...notice });
      }

      const promptResult = await this.runtime.prompt(acpSession.sessionId, promptBlocks, (chunk: DynamicRecord) => {
        if (abortCtrl.signal.aborted) return;

        if (this._applyAcpChunk(session, chunk, directory)) {
          return;
        }

        if (chunk.type === 'thought' && chunk.delta) {
          closeActiveText(Date.now());
          if (!activeReasoning) {
            const ordinal = nextReasoningOrdinal++;
            const reasoningPartId = `${assistantMsgId}:reasoning:${ordinal}`;
            const startTime = Date.now();
            const rPart: DynamicRecord = {
              id: reasoningPartId,
              sessionID: sessionId,
              messageID: assistantMsgId,
              type: 'reasoning',
              text: '',
              time: { start: startTime },
            };
            parts.push(rPart);
            activeReasoning = { id: reasoningPartId, ordinal, part: rPart, text: '' };
            this.emitEvent({
              type: 'session.reasoning.started',
              data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal },
              created: startTime,
            }, directory);
          }
          activeReasoning.text += chunk.delta;
          activeReasoning.part.text = activeReasoning.text;

          this.emitEvent({
            type: 'session.reasoning.delta',
            data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal: activeReasoning.ordinal, delta: chunk.delta },
            created: Date.now(),
          }, directory);
        } else if (chunk.type === 'tool' && chunk.tool) {
          const now = Date.now();
          finalizeOpenParts(now);
          const callID = chunk.tool.toolCallId || chunk.tool.callID || chunk.tool.id || `call_${now}_${Math.random().toString(36).slice(2, 6)}`;
          const kind = typeof chunk.tool.kind === 'string' ? chunk.tool.kind : undefined;
          const title = typeof chunk.tool.title === 'string' ? chunk.tool.title : undefined;
          const locations = Array.isArray(chunk.tool.locations) ? chunk.tool.locations : undefined;
          const rawInput = chunk.tool.rawInput && typeof chunk.tool.rawInput === 'object' ? chunk.tool.rawInput : undefined;
          const toolName = chunk.tool.name || chunk.tool.tool || kind || 'bash';
          const toolArgs = chunk.tool.args || rawInput || chunk.tool.input || {};
          const metadata = {
            ...(kind ? { kind } : {}),
            ...(title ? { title } : {}),
            ...(locations ? { locations } : {}),
            ...(rawInput ? { rawInput } : {}),
          };
          const toolPart: DynamicRecord = {
            id: callID,
            sessionID: sessionId,
            messageID: assistantMsgId,
            callID,
            type: 'tool',
            name: toolName,
            tool: toolName,
            ...(kind ? { kind } : {}),
            ...(title ? { title } : {}),
            ...(locations ? { locations } : {}),
            ...(rawInput ? { rawInput } : {}),
            executed: true,
            time: { created: now, ran: now },
            state: {
              status: 'running',
              input: toolArgs,
              time: { start: now },
              ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            },
          };
          parts.push(toolPart);
          this.emitEvent({
            type: 'session.tool.input.started',
            data: {
              sessionID: sessionId,
              assistantMessageID: assistantMsgId,
              id: callID,
              name: toolName,
              ...(kind ? { kind } : {}),
              ...(title ? { title } : {}),
              ...(locations ? { locations } : {}),
              ...(rawInput ? { rawInput } : {}),
            },
            created: now,
          }, directory);
          this.emitEvent({
            type: 'session.tool.called',
            data: {
              sessionID: sessionId,
              assistantMessageID: assistantMsgId,
              id: callID,
              name: toolName,
              input: toolArgs,
              executed: true,
              ...(kind ? { kind } : {}),
              ...(title ? { title } : {}),
              ...(locations ? { locations } : {}),
              ...(rawInput ? { rawInput } : {}),
              ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            },
            created: now,
          }, directory);
        } else if (chunk.type === 'tool_update' && chunk.update) {
          const update = chunk.update as DynamicRecord;
          const callID = update.toolCallId || update.callID || update.id;
          const toolPart = parts.find((p) => p.type === 'tool' && (p.callID === callID || p.id === callID));
          if (toolPart) {
            if (typeof update.kind === 'string' && update.kind) toolPart.kind = update.kind;
            if (typeof update.title === 'string' && update.title) toolPart.title = update.title;
            if (Array.isArray(update.locations)) toolPart.locations = update.locations;
            if (update.rawInput && typeof update.rawInput === 'object') {
              toolPart.rawInput = update.rawInput;
              if (!toolPart.state.input || Object.keys(toolPart.state.input).length === 0) {
                toolPart.state.input = update.rawInput;
              }
            }

            const { outputText, diffs, unifiedDiff } = extractToolUpdateContent(update);
            const firstDiff = diffs[0];
            const nextMetadata = {
              ...(toolPart.state.metadata || {}),
              ...(toolPart.kind ? { kind: toolPart.kind } : {}),
              ...(toolPart.title ? { title: toolPart.title } : {}),
              ...(toolPart.locations ? { locations: toolPart.locations } : {}),
              ...(toolPart.rawInput ? { rawInput: toolPart.rawInput } : {}),
              ...(firstDiff ? {
                diffs,
                diff: unifiedDiff,
                filediff: {
                  file: firstDiff.path,
                  before: firstDiff.oldText,
                  after: firstDiff.newText,
                },
              } : {}),
            };
            if (Object.keys(nextMetadata).length > 0) {
              toolPart.state.metadata = nextMetadata;
            }

            const now = Date.now();
            if (update.status === 'in_progress' || update.status === 'pending') {
              toolPart.state.status = 'running';
              toolPart.state.acpStatus = update.status;
              if (outputText) {
                toolPart.state.output = outputText;
                toolPart.state.content = [{ type: 'text', text: outputText }];
              }
              this.emitEvent({
                type: 'session.tool.updated',
                data: {
                  sessionID: sessionId,
                  assistantMessageID: assistantMsgId,
                  id: toolPart.callID || toolPart.id,
                  name: toolPart.name,
                  status: update.status,
                  ...(toolPart.kind ? { kind: toolPart.kind } : {}),
                  ...(toolPart.title ? { title: toolPart.title } : {}),
                  ...(toolPart.locations ? { locations: toolPart.locations } : {}),
                  ...(toolPart.rawInput ? { rawInput: toolPart.rawInput } : {}),
                  ...(outputText ? { content: toolPart.state.content } : {}),
                  ...(toolPart.state.metadata ? { metadata: toolPart.state.metadata } : {}),
                },
                created: now,
              }, directory);
            } else if (update.status === 'completed') {
              toolPart.time.completed = now;
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
                  ...(toolPart.state.metadata ? { metadata: toolPart.state.metadata } : {}),
                  executed: true,
                },
                created: now,
              }, directory);
            } else if (update.status === 'error' || update.status === 'failed') {
              toolPart.time.completed = now;
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
                  ...(toolPart.state.metadata ? { metadata: toolPart.state.metadata } : {}),
                  executed: true,
                },
                created: now,
              }, directory);
            }
          }
        } else if (chunk.type === 'text' && chunk.delta) {
          closeActiveReasoning(Date.now());
          if (!activeText) {
            const ordinal = nextTextOrdinal++;
            const textPartId = `${assistantMsgId}:text:${ordinal}`;
            const startTime = Date.now();
            const tPart: DynamicRecord = {
              id: textPartId,
              sessionID: sessionId,
              messageID: assistantMsgId,
              type: 'text',
              text: '',
              time: { start: startTime },
            };
            parts.push(tPart);
            activeText = { id: textPartId, ordinal, part: tPart, text: '' };
            this.emitEvent({
              type: 'session.text.started',
              data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal },
              created: startTime,
            }, directory);
          }
          activeText.text += chunk.delta;
          activeText.part.text = activeText.text;

          this.emitEvent({
            type: 'session.text.delta',
            data: { sessionID: sessionId, assistantMessageID: assistantMsgId, ordinal: activeText.ordinal, delta: chunk.delta },
            created: Date.now(),
          }, directory);
        }
      }) as DynamicRecord | undefined;

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
              ...(p.state.metadata ? { metadata: p.state.metadata } : {}),
              executed: true,
            },
            created: completedTime,
          }, directory);
        }
      }

      finalizeOpenParts(completedTime);
      assistantMsg.time.completed = completedTime;
      assistantMsg.finish = 'stop';
      const usage = promptResult?.usage as DynamicRecord | undefined;
      if (usage) {
        const tokens = {
          input: Number(usage.inputTokens || 0),
          output: Number(usage.outputTokens || 0),
          reasoning: Number(usage.thoughtTokens || 0),
          cache: { read: Number(usage.cachedReadTokens || 0), write: Number(usage.cachedWriteTokens || 0) },
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
      session.outcome = 'succeeded';
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
      const structuredError = { type: 'Error', message: err instanceof Error ? err.message : String(err) };
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
      finalizeOpenParts(failedTime);
      assistantMsg.time.completed = failedTime;
      assistantMsg.finish = 'error';
      assistantMsg.error = structuredError;
      session.outcome = 'failed';
      session.error = structuredError;
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
      // A finished turn cannot still be waiting on the user: a prompt left over
      // would show forever and then 404 when answered. `cancelled` is the only
      // honest answer for a request nobody can act on any more.
      this.cancelPermissions(sessionId);
      this.cancelQuestions(sessionId);
      // Do NOT close acpSession! Keep ACP session alive across turns for conversation memory!
    }
  }

  subscribeEvent(listener: (payload: unknown) => void): () => void {
    this.on('event', listener);
    return () => {
      this.off('event', listener);
    };
  }

  emitEvent(payload: DynamicRecord, directory = 'global'): void {
    const now = Number.isFinite(payload?.created) ? Number(payload.created) : Date.now();
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
          payload: wirePayload as JsonValue,
          directory: directory || 'global',
          spaceId: 'acp',
        });
      } catch (err) {
        console.warn('[acp-bridge] Failed to inject event into globalHub:', err instanceof Error ? err.message : String(err));
      }
    }
  }
}

let defaultBridge: AcpSessionBridge | null = null;

export function getAcpSessionBridge(options: AcpSessionBridgeOptions = {}): AcpSessionBridge {
  if (!defaultBridge) {
    defaultBridge = new AcpSessionBridge(options);
  }
  return defaultBridge;
}
