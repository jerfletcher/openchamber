import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import EventEmitter from 'events';
import { AcpConnection } from './acp-connection.js';

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

    // 1. Initialize
    const initResult = await conn.request('initialize', {
      clientInfo: { name: 'openchamber', version: '2.6.1' },
      capabilities: {},
    });

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
      cwd,
      conn,
      availableModels,
      currentModelId,
      title: 'New Session',
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      emitter: new EventEmitter(),
    };

    // Forward session notifications
    conn.on('session/update', (params) => {
      const update = params?.update;
      if (!update) return;

      if (update.sessionUpdate === 'agent_message_chunk') {
        sessionData.emitter.emit('text_delta', update.content?.text || '');
      } else if (update.sessionUpdate === 'thought' || update.thought) {
        sessionData.emitter.emit('thought_delta', update.thought || update.content?.text || '');
      } else if (update.sessionUpdate === 'tool_call' || update.toolCall) {
        sessionData.emitter.emit('tool_call', update.toolCall || update);
      } else if (update.sessionUpdate === 'tool_call_update') {
        sessionData.emitter.emit('tool_update', update);
      } else if (update.sessionUpdate === 'session_info_update' && update.title) {
        sessionData.title = update.title;
        sessionData.emitter.emit('title', update.title);
      }

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
    };
  }

  async setModel(sessionId, modelId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found.`);

    try {
      await session.conn.request('session/set_model', { sessionId, modelId });
      session.currentModelId = modelId;
      return { success: true, modelId };
    } catch {
      // Fallback to set_config_option if set_model not recognized
      await session.conn.request('session/set_config_option', { sessionId, key: 'model', value: modelId });
      session.currentModelId = modelId;
      return { success: true, modelId };
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

      session.emitter.on('text_delta', handler);
      session.emitter.on('thought_delta', thoughtHandler);
      session.emitter.on('tool_call', toolHandler);
      session.emitter.on('tool_update', toolUpdateHandler);

      unsub = () => {
        session.emitter.off('text_delta', handler);
        session.emitter.off('thought_delta', thoughtHandler);
        session.emitter.off('tool_call', toolHandler);
        session.emitter.off('tool_update', toolUpdateHandler);
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
