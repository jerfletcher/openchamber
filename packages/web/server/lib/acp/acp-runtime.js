import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import EventEmitter from 'events';
import { AcpConnection } from './acp-connection.js';
import {
  ACP_PROTOCOL_VERSION,
  AcpProtocolVersionMismatchError,
  normalizeSessionUpdate,
  normalizePromptCapabilities,
} from './acp-protocol.js';

export function resolveBinaryPath(command) {
  if (path.isAbsolute(command) && fs.existsSync(command)) return command;
  const commonPaths = [
    path.join(process.env.HOME || '/home/jeremy', '.local', 'bin', command),
    path.join('/usr/local/bin', command),
    path.join('/usr/bin', command),
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const stdout = execFileSync('which', [command], { encoding: 'utf8' }).trim();
    if (stdout && fs.existsSync(stdout)) return stdout;
  } catch {}
  return command;
}

export function checkBinaryExists(command) {
  const resolved = resolveBinaryPath(command);
  if (fs.existsSync(resolved)) return true;
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Standard registry of well-known ACP agent commands.
 */
export const DEFAULT_ACP_AGENTS = [
  {
    id: 'antigravity',
    name: 'Google Antigravity (AGY)',
    folderName: 'Antigravity',
    providerId: 'antigravity',
    providerName: 'Google Antigravity (ACP)',
    defaultModel: 'gemini-3.8-flash',
    sessionPrefix: 'ses_agy_',
    description: 'Autonomous coding agent powered by Google Gemini, Claude, and your Google AI Pro subscription.',
    command: 'agy',
    args: ['acp', '--stdio', '--dangerously-skip-permissions'],
    models: [
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', context: 1000000, output: 64000, variants: ['low', 'medium', 'high'] },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', context: 1000000, output: 64000, variants: ['low', 'medium', 'high'] },
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', context: 200000, output: 16000, variants: ['low', 'medium', 'high'] },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context: 200000, output: 16000, variants: ['low', 'medium', 'high'] },
    ],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    folderName: 'Claude Code',
    providerId: 'claude-code',
    providerName: 'Claude Code (ACP)',
    defaultModel: 'claude-sonnet-4-6',
    sessionPrefix: 'ses_acp_claude-code_',
    description: 'Anthropic agent running in ACP mode.',
    command: 'claude',
    args: ['acp'],
    models: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', context: 200000, output: 16000, variants: ['low', 'medium', 'high'] },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context: 200000, output: 16000, variants: ['low', 'medium', 'high'] },
    ],
  },
  {
    id: 'opencode-headless',
    name: 'OpenCode ACP',
    folderName: 'OpenCode ACP',
    providerId: 'opencode-headless',
    providerName: 'OpenCode (ACP)',
    defaultModel: 'default',
    sessionPrefix: 'ses_acp_opencode-headless_',
    description: 'OpenCode running in headless ACP mode.',
    command: 'opencode',
    args: ['acp'],
    models: [],
  },
];

export class AcpRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.customAgents = options.agents || [];
    this.activeSessions = new Map(); // sessionId -> { conn, agentId, cwd, models, currentModelId }
    this.idleTtlMs = options.idleTtlMs ?? 20 * 60 * 1000;
    if (this.idleTtlMs > 0) {
      this.reaper = setInterval(() => this.reapIdle(), Math.min(60_000, this.idleTtlMs));
      this.reaper.unref?.();
    }
  }

  getRegisteredAgents() {
    return [...this.customAgents, ...DEFAULT_ACP_AGENTS];
  }

  getAgentConfig(agentOrProviderId) {
    if (!agentOrProviderId) return null;
    return this.getRegisteredAgents().find((a) => a.id === agentOrProviderId || a.providerId === agentOrProviderId) || null;
  }

  getAvailableAgents() {
    return this.getRegisteredAgents().filter((a) => checkBinaryExists(a.command));
  }

  async createSession({ agentId = 'antigravity', cwd = process.cwd(), resumeSessionId = null } = {}) {
    const agent = this.getAvailableAgents().find((a) => a.id === agentId);
    if (!agent) {
      throw new Error(`ACP agent '${agentId}' is not installed or available on this machine.`);
    }

    let effectiveCwd = cwd;
    if (!effectiveCwd || !fs.existsSync(effectiveCwd)) {
      effectiveCwd = process.env.HOME || '/home/jeremy';
    }
    const resolvedCommand = resolveBinaryPath(agent.command);
    const conn = new AcpConnection(resolvedCommand, agent.args, { cwd: effectiveCwd });
    conn.on('error', (err) => {
      console.error(`[AcpRuntime] Connection error for ${agentId}:`, err.message);
    });
    conn.start();

    // 1. Initialize (spec: /protocol/v1/initialization).
    //
    // `protocolVersion` is REQUIRED and must be the latest version this client
    // supports. `clientCapabilities` is deliberately empty: ACP treats every
    // omitted capability as UNSUPPORTED, and this client implements neither
    // `fs/*`, `terminal/*`, nor `elicitation/create`. Advertising them would
    // invite method calls we cannot answer.
    const initResult = await conn.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'openchamber', title: 'OpenChamber', version: '2.6.1' },
    });

    // The agent MUST answer with the version it chose. If it is not the version
    // we asked for, the spec says to close the connection and tell the user —
    // proceeding would silently interpret one protocol as another.
    if (initResult?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      const received = initResult?.protocolVersion;
      conn.close();
      throw new AcpProtocolVersionMismatchError({ requested: ACP_PROTOCOL_VERSION, received });
    }

    // 2. session/new
    let sessionResult;
    if (resumeSessionId && initResult?.agentCapabilities?.loadSession) {
      try {
        sessionResult = await conn.request('session/load', { sessionId: resumeSessionId, cwd: effectiveCwd });
      } catch (err) {
        console.warn(`[AcpRuntime] session/load failed for ${resumeSessionId}, starting fresh:`, err.message);
      }
    }
    if (!sessionResult) sessionResult = await conn.request('session/new', { cwd: effectiveCwd });
    const sessionId = sessionResult.sessionId || resumeSessionId;

    const availableModels = sessionResult.models?.availableModels || [];
    const currentModelId = sessionResult.models?.currentModelId || availableModels[0]?.modelId || '';

    const sessionData = {
      sessionId,
      agentId,
      agentInfo: initResult.agentInfo,
      agentCapabilities: initResult.agentCapabilities || {},
      // The agent's prompt capabilities decide which content blocks we may
      // send; anything omitted means "text and resource_link only".
      promptCapabilities: normalizePromptCapabilities(initResult.agentCapabilities),
      // Authentication methods the agent advertised during initialize, if any.
      authMethods: Array.isArray(initResult.authMethods) ? initResult.authMethods : [],
      cwd,
      conn,
      availableModels,
      currentModelId,
      // Session state surfaced by `session/update` variants.
      plan: [],
      currentModeId: sessionResult.modes?.currentModeId || null,
      availableModes: Array.isArray(sessionResult.modes?.availableModes) ? sessionResult.modes.availableModes : [],
      configOptions: Array.isArray(sessionResult.configOptions) ? sessionResult.configOptions : [],
      availableCommands: [],
      usage: null,
      title: 'New Session',
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      emitter: new EventEmitter(),
    };

    // Forward session notifications. Every variant the v1 SessionUpdate schema
    // defines is normalized before it reaches a consumer (spec:
    // /protocol/v1/prompt-turn#session-updates); a variant we do not understand
    // is still passed through as `unknown` instead of vanishing.
    conn.on('session/update', (params) => {
      const update = params?.update;
      if (!update) return;
      const normalized = normalizeSessionUpdate(update);
      if (!normalized) return;

      switch (normalized.type) {
        case 'text_delta':
          sessionData.emitter.emit('text_delta', normalized.text);
          break;
        case 'thought_delta':
          sessionData.emitter.emit('thought_delta', normalized.text);
          break;
        case 'user_message_chunk':
          sessionData.emitter.emit('user_message_chunk', normalized.text);
          break;
        case 'tool_call':
          sessionData.emitter.emit('tool_call', normalized.toolCall);
          break;
        case 'tool_call_update':
          sessionData.emitter.emit('tool_update', update);
          break;
        case 'plan':
          // The agent MUST send the complete plan each time, so replace, never merge.
          sessionData.plan = normalized.entries;
          sessionData.emitter.emit('plan', normalized.entries);
          break;
        case 'current_mode':
          sessionData.currentModeId = normalized.modeId || sessionData.currentModeId;
          sessionData.emitter.emit('mode', sessionData.currentModeId);
          break;
        case 'config_options':
          sessionData.configOptions = normalized.configOptions;
          sessionData.emitter.emit('config_options', normalized.configOptions);
          break;
        case 'available_commands':
          sessionData.availableCommands = normalized.availableCommands;
          sessionData.emitter.emit('commands', normalized.availableCommands);
          break;
        case 'session_info':
          if (normalized.title) {
            sessionData.title = normalized.title;
            sessionData.emitter.emit('title', normalized.title);
          }
          break;
        case 'usage':
          sessionData.usage = normalized.usage;
          sessionData.emitter.emit('usage', normalized.usage);
          break;
        default:
          break;
      }

      sessionData.updatedAt = Date.now();
      sessionData.emitter.emit('update', update);
    });

    this.activeSessions.set(sessionId, sessionData);
    return {
      sessionId,
      agentId,
      agentName: agent.name,
      availableModels,
      currentModelId,
      tier: sessionResult._meta?.antigravity?.tier,
      agentCapabilities: sessionData.agentCapabilities,
      promptCapabilities: sessionData.promptCapabilities,
      authMethods: sessionData.authMethods,
      plan: sessionData.plan,
      currentModeId: sessionData.currentModeId,
      availableModes: sessionData.availableModes,
      configOptions: sessionData.configOptions,
      availableCommands: sessionData.availableCommands,
    };
  }

  async setModel(sessionId, modelId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found.`);

    // `session/set_model` is NOT part of ACP v1 — it is an agent-specific
    // extension (Antigravity). The spec-conformant path is
    // `session/set_config_option` with `configId` (spec:
    // /protocol/v1/session-config-options#setting-a-config-option), so try the
    // extension first and fall back to the standard method when the agent
    // answers -32601.
    try {
      await session.conn.request('session/set_model', { sessionId, modelId });
      session.currentModelId = modelId;
      return { success: true, modelId, method: 'session/set_model' };
    } catch {
      const result = await session.conn.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: modelId,
      });
      session.currentModelId = modelId;
      if (Array.isArray(result?.configOptions)) session.configOptions = result.configOptions;
      return { success: true, modelId, method: 'session/set_config_option' };
    }
  }

  listSessions() {
    return Array.from(this.activeSessions.values()).map((s) => ({
      sessionId: s.sessionId,
      agentId: s.agentId,
      agentName: s.agentInfo?.name || s.agentId,
      title: s.title || 'New Session',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      currentModelId: s.currentModelId,
      availableModels: s.availableModels,
      messageCount: s.messages?.length || 0,
      tier: s.tier,
    }));
  }

  getSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      agentId: session.agentId,
      agentName: session.agentInfo?.name || session.agentId,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      currentModelId: session.currentModelId,
      availableModels: session.availableModels,
      messages: session.messages,
      tier: session.tier,
      agentCapabilities: session.agentCapabilities,
      promptCapabilities: session.promptCapabilities,
      authMethods: session.authMethods,
      plan: session.plan,
      currentModeId: session.currentModeId,
      availableModes: session.availableModes,
      configOptions: session.configOptions,
      availableCommands: session.availableCommands,
      usage: session.usage,
    };
  }

  async prompt(sessionId, text, onChunk = null) {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found.`);

    if (!session.title || session.title === 'New Session') {
      const t = Array.isArray(text) ? (text.find((b) => b.type === 'text')?.text || '') : text;
      session.title = t.trim().slice(0, 40) || 'New Session';
    }
    session.updatedAt = Date.now();
    session.lastUsedAt = Date.now();
    session.busy = true;

    const userMsg = { id: `msg_${Date.now()}_u`, role: 'user', text: Array.isArray(text) ? (text.find((b) => b.type === 'text')?.text || '') : text, createdAt: Date.now() };
    session.messages.push(userMsg);

    let assistantText = '';
    let assistantThought = '';
    const assistantTools = [];

    let unsub = null;
    if (onChunk) {
      const handler = (delta) => {
        assistantText += delta;
        onChunk({ type: 'text', delta });
      };
      const thoughtHandler = (delta) => {
        assistantThought += delta;
        onChunk({ type: 'thought', delta });
      };
      const toolHandler = (tool) => {
        assistantTools.push(tool);
        onChunk({ type: 'tool', tool });
      };
      const toolUpdateHandler = (update) => {
        onChunk({ type: 'tool_update', update });
      };
      // Session-state variants are surfaced inline during the turn as well as
      // on the session record, so a streaming consumer never misses them.
      const planHandler = (entries) => onChunk({ type: 'plan', entries });
      const modeHandler = (modeId) => onChunk({ type: 'mode', modeId });
      const configHandler = (configOptions) => onChunk({ type: 'config_options', configOptions });
      const commandsHandler = (availableCommands) => onChunk({ type: 'commands', availableCommands });

      session.emitter.on('text_delta', handler);
      session.emitter.on('thought_delta', thoughtHandler);
      session.emitter.on('tool_call', toolHandler);
      session.emitter.on('tool_update', toolUpdateHandler);
      session.emitter.on('plan', planHandler);
      session.emitter.on('mode', modeHandler);
      session.emitter.on('config_options', configHandler);
      session.emitter.on('commands', commandsHandler);

      unsub = () => {
        session.emitter.off('text_delta', handler);
        session.emitter.off('thought_delta', thoughtHandler);
        session.emitter.off('tool_call', toolHandler);
        session.emitter.off('tool_update', toolUpdateHandler);
        session.emitter.off('plan', planHandler);
        session.emitter.off('mode', modeHandler);
        session.emitter.off('config_options', configHandler);
        session.emitter.off('commands', commandsHandler);
      };
    }

    try {
      const result = await session.conn.request('session/prompt', {
        sessionId,
        prompt: Array.isArray(text) ? text : [{ type: 'text', text }],
      }, 0);

      const assistantMsg = {
        id: `msg_${Date.now()}_a`,
        role: 'assistant',
        text: assistantText,
        thought: assistantThought,
        tools: assistantTools,
        createdAt: Date.now(),
      };
      session.messages.push(assistantMsg);

      return result;
    } finally {
      session.busy = false;
      session.lastUsedAt = Date.now();
      if (unsub) unsub();
    }
  }

  isSessionAlive(sessionId) {
    const session = this.activeSessions.get(sessionId);
    return Boolean(session && session.conn && session.conn.isAlive());
  }

  async cancel(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.conn) return;
    try {
      session.conn.notify('session/cancel', { sessionId });
    } catch {}
  }

  closeSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.conn.close();
      this.activeSessions.delete(sessionId);
    }
  }

  /** Close agent processes idle past the TTL; the bridge resumes them via session/load on the next turn. */
  reapIdle(now = Date.now()) {
    for (const [id, s] of this.activeSessions.entries()) {
      if (!s.busy && now - (s.lastUsedAt || s.createdAt || now) > this.idleTtlMs) {
        this.closeSession(id);
      }
    }
  }

  closeAll() {
    for (const [id] of this.activeSessions.entries()) {
      this.closeSession(id);
    }
  }
}
