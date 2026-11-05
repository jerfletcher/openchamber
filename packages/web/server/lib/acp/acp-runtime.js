import { execSync } from 'child_process';
import EventEmitter from 'events';
import { AcpConnection } from './acp-connection.js';

export function checkBinaryExists(command) {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
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
    description: 'Autonomous coding agent powered by Google Gemini, Claude, and your Google AI Pro subscription.',
    command: 'agy',
    args: ['acp', '--stdio', '--dangerously-skip-permissions'],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic agent running in ACP mode.',
    command: 'claude',
    args: ['acp'],
  },
  {
    id: 'opencode-headless',
    name: 'OpenCode ACP',
    description: 'OpenCode running in headless ACP mode.',
    command: 'opencode',
    args: ['acp'],
  },
];

export class AcpRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.customAgents = options.agents || [];
    this.activeSessions = new Map(); // sessionId -> { conn, agentId, cwd, models, currentModelId }
  }

  getAvailableAgents() {
    const all = [...this.customAgents, ...DEFAULT_ACP_AGENTS];
    return all.filter((a) => checkBinaryExists(a.command));
  }

  async createSession({ agentId = 'antigravity', cwd = process.cwd() } = {}) {
    const agent = this.getAvailableAgents().find((a) => a.id === agentId);
    if (!agent) {
      throw new Error(`ACP agent '${agentId}' is not installed or available on this machine.`);
    }

    const conn = new AcpConnection(agent.command, agent.args, { cwd });
    conn.start();

    // 1. Initialize
    const initResult = await conn.request('initialize', {
      clientInfo: { name: 'openchamber', version: '2.6.1' },
      capabilities: {},
    });

    // 2. session/new
    const sessionResult = await conn.request('session/new', { cwd });
    const sessionId = sessionResult.sessionId;

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

  async prompt(sessionId, text, onChunk = null) {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found.`);

    let unsub = null;
    if (onChunk) {
      const handler = (delta) => onChunk({ type: 'text', delta });
      const thoughtHandler = (delta) => onChunk({ type: 'thought', delta });
      const toolHandler = (tool) => onChunk({ type: 'tool', tool });

      session.emitter.on('text_delta', handler);
      session.emitter.on('thought_delta', thoughtHandler);
      session.emitter.on('tool_call', toolHandler);

      unsub = () => {
        session.emitter.off('text_delta', handler);
        session.emitter.off('thought_delta', thoughtHandler);
        session.emitter.off('tool_call', toolHandler);
      };
    }

    try {
      const result = await session.conn.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      return result;
    } finally {
      if (unsub) unsub();
    }
  }

  closeSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.conn.close();
      this.activeSessions.delete(sessionId);
    }
  }

  closeAll() {
    for (const [id] of this.activeSessions.entries()) {
      this.closeSession(id);
    }
  }
}
