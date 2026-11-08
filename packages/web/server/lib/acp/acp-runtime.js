import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import EventEmitter from 'events';
import { AcpConnection } from './acp-connection.js';
import {
  ACP_ERROR,
  ACP_EXTENSION_NOTIFICATION,
  ACP_PROTOCOL_VERSION,
  AcpError,
  AcpProtocolVersionMismatchError,
  buildPermissionCancelledOutcome,
  buildPermissionSelectedOutcome,
  configOptionValue,
  isMethodNotFoundError,
  normalizeAgentCapabilities,
  normalizeConfigOptions,
  normalizeNotification,
  normalizePermissionRequest,
  normalizeSessionConfig,
  normalizeSessionUpdate,
} from './acp-protocol.js';

/**
 * The flag an agent needs to run without asking for permission. It is appended
 * only when the agent's own setting turns it on — see `buildAgentArgs`.
 */
export const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * The exact argv an agent is launched with.
 *
 * `skipPermissions` is a per-agent setting that defaults to OFF: the permission
 * prompt is the default experience, and running without it is an explicit opt-in
 * the user makes per agent. The flag used to be hardcoded here, which meant the
 * client's whole permission flow could never fire.
 */
export function buildAgentArgs(agent) {
  const args = Array.isArray(agent?.args) ? [...agent.args] : [];
  if (agent?.skipPermissions === true && !args.includes(SKIP_PERMISSIONS_FLAG)) {
    args.push(SKIP_PERMISSIONS_FLAG);
  }
  if (agent?.skipPermissions !== true && args.includes(SKIP_PERMISSIONS_FLAG)) {
    // A stale agent config must not keep bypassing the prompt; the setting, not
    // the argv, is the source of truth.
    return args.filter((arg) => arg !== SKIP_PERMISSIONS_FLAG);
  }
  return args;
}

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
    args: ['acp', '--stdio'],
    // Off by default: the permission prompt is the default experience. A user
    // turns this on per agent (custom agent config) only when the agent cannot
    // function otherwise; the client never turns it on by itself.
    skipPermissions: false,
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
    // Permission ids are ours, not the agent's JSON-RPC id: they travel through
    // a URL and must stay opaque and URL-safe.
    this.nextPermissionId = 1;
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
    const conn = new AcpConnection(resolvedCommand, buildAgentArgs(agent), { cwd: effectiveCwd });
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

    const capabilities = normalizeAgentCapabilities(initResult.agentCapabilities);

    // 2. Build the session record BEFORE the handshake so the notification
    // handlers can capture the replay a `session/load` / `session/resume` emits.
    // Those updates arrive BEFORE the request resolves; registering the
    // listeners afterwards (the previous shape) silently dropped the entire
    // replayed command/config/mode state.
    const sessionData = {
      sessionId: '',
      agentId,
      agentInfo: initResult.agentInfo,
      agentCapabilities: initResult.agentCapabilities || {},
      // Gating flags normalized across the camelCase and snake_case shapes the
      // agent advertises. Every session method below consults these; calling an
      // unadvertised method answers -32601 on the live binary.
      capabilities,
      // The agent's prompt capabilities decide which content blocks we may
      // send; anything omitted means "text and resource_link only".
      promptCapabilities: capabilities.promptCapabilities,
      // Authentication methods the agent advertised during initialize, if any.
      authMethods: Array.isArray(initResult.authMethods) ? initResult.authMethods : [],
      cwd,
      conn,
      availableModels: [],
      currentModelId: '',
      // Session state surfaced by `session/update` variants.
      plan: [],
      currentModeId: null,
      availableModes: [],
      configOptions: [],
      availableCommands: [],
      usage: null,
      title: 'New Session',
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      // requestId -> { requestId, jsonRpcId, sessionId, acpSessionId, toolCall,
      // options, createdAt, settle(outcome) }. Answered by `respondToPermission`,
      // or with `cancelled` by `cancel` / `closeSession` — never left dangling.
      pendingPermissions: new Map(),
      emitter: new EventEmitter(),
    };

    // One place applies a normalized update to the session record and forwards it
    // to consumers. Both `session/update` and the top-level Antigravity extension
    // notifications go through it so the two shapes cannot drift.
    const applyUpdate = (normalized, rawUpdate) => {
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
          sessionData.emitter.emit('tool_update', rawUpdate);
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
      sessionData.emitter.emit('update', rawUpdate);
    };

    // A connection speaks for exactly one session, so an update naming a
    // different session is ignored. During the handshake `sessionData.sessionId`
    // is still empty and every replayed update is for this session.
    const matchesSession = (params) => !params?.sessionId
      || !sessionData.sessionId
      || params.sessionId === sessionData.sessionId;

    // Forward session notifications. Every variant the v1 SessionUpdate schema
    // defines is normalized before it reaches a consumer (spec:
    // /protocol/v1/prompt-turn#session-updates); a variant we do not understand
    // is still passed through as `unknown` instead of vanishing.
    conn.on('session/update', (params) => {
      if (!params?.update || !matchesSession(params)) return;
      const normalized = normalizeSessionUpdate(params.update);
      if (!normalized) return;
      applyUpdate(normalized, params.update);
    });

    // Antigravity also permits `session/available_commands_update` and
    // `session/config_option_update` as standalone notifications. Both are
    // id-less, so they are consumed and never answered.
    for (const method of Object.values(ACP_EXTENSION_NOTIFICATION)) {
      conn.on(method, (params) => {
        if (!matchesSession(params)) return;
        const normalized = normalizeNotification(method, params);
        if (!normalized) return;
        applyUpdate(normalized, params);
      });
    }

    // 3. Open or resume the session. Each method is capability-gated because
    // calling an unadvertised one is exactly the -32601 failure PR #14 shows.
    let sessionResult = null;
    if (resumeSessionId && capabilities.loadSession) {
      try {
        sessionResult = await conn.request('session/load', { sessionId: resumeSessionId, cwd: effectiveCwd });
      } catch (err) {
        console.warn(`[AcpRuntime] session/load failed for ${resumeSessionId}, starting fresh:`, err.message);
      }
    }
    if (!sessionResult && resumeSessionId && capabilities.resume) {
      try {
        sessionResult = await conn.request('session/resume', { sessionId: resumeSessionId, cwd: effectiveCwd });
      } catch (err) {
        console.warn(`[AcpRuntime] session/resume failed for ${resumeSessionId}, starting fresh:`, err.message);
      }
    }
    if (!sessionResult) sessionResult = await conn.request('session/new', { cwd: effectiveCwd });
    const sessionId = sessionResult.sessionId || resumeSessionId;
    if (!sessionId) {
      conn.close();
      throw new AcpError({
        code: ACP_ERROR.INTERNAL_ERROR,
        message: 'ACP agent did not return a session id for session/new',
      });
    }
    sessionData.sessionId = sessionId;

    // `session/new` / `session/resume` carry the configurable surface (models,
    // modes, config options). The exact key names are not specified anywhere, so
    // normalizeSessionConfig accepts both the live shape and the alternatives.
    const config = normalizeSessionConfig(sessionResult);
    sessionData.availableModels = config.availableModels;
    sessionData.currentModelId = config.currentModelId;
    sessionData.availableModes = config.availableModes;
    sessionData.currentModeId = config.currentModeId;
    sessionData.configOptions = config.configOptions;

    // `session/request_permission` is the first agent-initiated request this
    // client answers. It is registered before the first prompt so a request can
    // never arrive without a handler (which would answer -32601 and fail the
    // tool call for a reason the user cannot see).
    sessionData.unregisterPermissionHandler = conn.registerRequestHandler(
      'session/request_permission',
      (params) => this.handlePermissionRequest(sessionData, params),
    );

    this.activeSessions.set(sessionId, sessionData);
    return {
      sessionId,
      agentId,
      agentName: agent.name,
      availableModels: sessionData.availableModels,
      currentModelId: sessionData.currentModelId,
      tier: sessionResult._meta?.antigravity?.tier,
      agentCapabilities: sessionData.agentCapabilities,
      capabilities: sessionData.capabilities,
      promptCapabilities: sessionData.promptCapabilities,
      authMethods: sessionData.authMethods,
      plan: sessionData.plan,
      currentModeId: sessionData.currentModeId,
      availableModes: sessionData.availableModes,
      configOptions: sessionData.configOptions,
      availableCommands: sessionData.availableCommands,
    };
  }

  /** A missing session is a 404, not a 500; ACP errors keep their own code. */
  requireSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new AcpError({
        code: ACP_ERROR.RESOURCE_NOT_FOUND,
        message: `Session '${sessionId}' not found.`,
        data: { sessionId },
      });
    }
    return session;
  }

  /**
   * Apply the config options a `session/set_config_option` (or legacy alias)
   * response returned. The agent sends the complete list, so replace never
   * merge, and keep the mirrored current mode/model in step with it.
   */
  applyConfigResult(session, result) {
    if (Array.isArray(result?.configOptions)) {
      session.configOptions = normalizeConfigOptions(result.configOptions);
    }
    const mode = configOptionValue(session.configOptions, 'mode');
    if (typeof mode === 'string' && mode) session.currentModeId = mode;
    const model = configOptionValue(session.configOptions, 'model');
    if (typeof model === 'string' && model) session.currentModelId = model;
    session.updatedAt = Date.now();
    session.emitter.emit('config_options', session.configOptions);
    return session.configOptions;
  }

  /**
   * PRIMARY outbound configuration call.
   *
   * `session/set_config_option` is the ACP v1 method (spec:
   * /protocol/v1/session-config-options#setting-a-config-option) and the live
   * `agy` 1.5.1 binary accepts `configId` values `model`, `mode`, and
   * `thought_level`. New code should call this, not the aliases below.
   */
  async setConfigOption(sessionId, configId, value) {
    const session = this.requireSession(sessionId);
    if (typeof configId !== 'string' || !configId) {
      throw new AcpError({ code: ACP_ERROR.INVALID_PARAMS, message: 'configId is required' });
    }
    if (typeof value !== 'string' || value === '') {
      throw new AcpError({ code: ACP_ERROR.INVALID_PARAMS, message: 'value is required' });
    }
    const result = await session.conn.request('session/set_config_option', { sessionId, configId, value });
    const configOptions = this.applyConfigResult(session, result);
    return { success: true, configId, value, method: 'session/set_config_option', configOptions };
  }

  /**
   * Alias helper: try `session/set_config_option` first, then the agent's
   * legacy alias ONLY when the primary answers -32601. Any other failure (a
   * timeout, an invalid value) is rethrown — retrying a rejected mutation could
   * apply a change the agent refused.
   */
  async applyConfigWithAlias(sessionId, { configId, value, aliasMethod, aliasKey }) {
    try {
      return await this.setConfigOption(sessionId, configId, value);
    } catch (err) {
      if (!isMethodNotFoundError(err)) throw err;
      const session = this.requireSession(sessionId);
      const result = await session.conn.request(aliasMethod, { sessionId, [aliasKey]: value });
      const configOptions = this.applyConfigResult(session, result);
      return { success: true, configId, value, method: aliasMethod, configOptions };
    }
  }

  /**
   * `session/set_model` is NOT part of ACP v1: PR #14 shows it is a legacy alias
   * the agent forwards to `session/set_config_option`. It stays public because
   * callers (and the OpenAI-compat bridge) already use it.
   */
  async setModel(sessionId, modelId) {
    const result = await this.applyConfigWithAlias(sessionId, {
      configId: 'model', value: modelId, aliasMethod: 'session/set_model', aliasKey: 'modelId',
    });
    const session = this.requireSession(sessionId);
    // Keep the requested variant id: the agent normalizes `model` to the base id
    // in configOptions, which would otherwise erase the variant the caller chose.
    session.currentModelId = modelId;
    return { success: true, modelId, method: result.method };
  }

  async setMode(sessionId, modeId) {
    const result = await this.applyConfigWithAlias(sessionId, {
      configId: 'mode', value: modeId, aliasMethod: 'session/set_mode', aliasKey: 'modeId',
    });
    const session = this.requireSession(sessionId);
    session.currentModeId = modeId;
    return { success: true, modeId, method: result.method };
  }

  /**
   * Legacy-first entry point for `session/set_model` — the reverse of the alias
   * fallback above: call the alias, and fall back to `set_config_option` only on
   * -32601. Probe evidence: live `agy` 1.5.1 accepts both directions.
   */
  async setModelLegacy(sessionId, modelId) {
    const session = this.requireSession(sessionId);
    try {
      const result = await session.conn.request('session/set_model', { sessionId, modelId });
      this.applyConfigResult(session, result);
      session.currentModelId = modelId;
      return { success: true, modelId, method: 'session/set_model' };
    } catch (err) {
      if (!isMethodNotFoundError(err)) throw err;
      const result = await this.setConfigOption(sessionId, 'model', modelId);
      session.currentModelId = modelId;
      return { success: true, modelId, method: result.method };
    }
  }

  async setModeLegacy(sessionId, modeId) {
    const session = this.requireSession(sessionId);
    try {
      const result = await session.conn.request('session/set_mode', { sessionId, modeId });
      this.applyConfigResult(session, result);
      session.currentModeId = modeId;
      return { success: true, modeId, method: 'session/set_mode' };
    } catch (err) {
      if (!isMethodNotFoundError(err)) throw err;
      const result = await this.setConfigOption(sessionId, 'mode', modeId);
      session.currentModeId = modeId;
      return { success: true, modeId, method: result.method };
    }
  }

  /**
   * `session/list` is an Antigravity extension. It is called only when the agent
   * advertised `sessionCapabilities.list`; otherwise the caller gets an explicit
   * unsupported result and NO request goes on the wire.
   */
  async listRemoteSessions(sessionId, { cwd } = {}) {
    const session = this.requireSession(sessionId);
    if (!session.capabilities?.list) return { supported: false, sessions: [] };
    const result = await session.conn.request('session/list', cwd ? { cwd } : {});
    return { supported: true, sessions: Array.isArray(result?.sessions) ? result.sessions : [] };
  }

  /** `session/resume` re-attaches and replays config/commands. Capability-gated. */
  async resumeSession(sessionId, { cwd } = {}) {
    const session = this.requireSession(sessionId);
    if (!session.capabilities?.resume) {
      throw new AcpError({
        code: ACP_ERROR.METHOD_NOT_FOUND,
        message: 'Agent did not advertise session/resume',
        data: { sessionId },
      });
    }
    const result = await session.conn.request('session/resume', { sessionId, ...(cwd ? { cwd } : {}) });
    const config = normalizeSessionConfig(result);
    if (config.availableModels.length) session.availableModels = config.availableModels;
    if (config.currentModelId) session.currentModelId = config.currentModelId;
    if (config.availableModes.length) session.availableModes = config.availableModes;
    if (config.currentModeId) session.currentModeId = config.currentModeId;
    if (config.configOptions.length) session.configOptions = config.configOptions;
    session.updatedAt = Date.now();
    return { success: true, sessionId, ...config };
  }

  /**
   * `session/delete` is ONLY sent when advertised. The live agy 1.5.1 does NOT
   * advertise it (and answers -32601), so the local session is still closed.
   */
  async deleteSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return { success: true, sessionId, remoteDelete: false };
    let remoteDelete = false;
    if (session.capabilities?.delete && typeof session.conn?.isAlive === 'function' && session.conn.isAlive()) {
      try {
        await session.conn.request('session/delete', { sessionId }, 5000);
        remoteDelete = true;
      } catch (err) {
        if (!isMethodNotFoundError(err)) throw err;
      }
    }
    this.closeSession(sessionId);
    return { success: true, sessionId, remoteDelete };
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
      capabilities: session.capabilities,
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

  /**
   * Answer `session/request_permission` (spec: /protocol/v1/tool-calls#requesting-permission).
   *
   * The returned promise IS the agent's request: it stays open until the user
   * answers, which is why nothing here may approve on their behalf. There is no
   * default and no timer; the only automatic answer is `cancelled`, and only
   * when the turn is cancelled or the session closes (the spec REQUIRES that).
   */
  handlePermissionRequest(sessionData, params) {
    const normalized = normalizePermissionRequest(params);
    if (normalized.sessionId !== sessionData.sessionId) {
      // A connection speaks for exactly one session, so a request naming another
      // is a protocol violation rather than something to route elsewhere.
      throw new AcpError({
        code: ACP_ERROR.INVALID_PARAMS,
        message: `session/request_permission named session '${normalized.sessionId}', but this connection is bound to '${sessionData.sessionId}'`,
      });
    }

    const requestId = `perm_${this.nextPermissionId++}`;
    return new Promise((resolve) => {
      const settle = (outcome) => {
        if (!sessionData.pendingPermissions.has(requestId)) return false;
        sessionData.pendingPermissions.delete(requestId);
        resolve(outcome);
        const settled = { requestId, sessionId: sessionData.sessionId, outcome };
        this.emit('permission_settled', settled);
        sessionData.emitter.emit('permission_settled', settled);
        return true;
      };

      const record = {
        requestId,
        sessionId: sessionData.sessionId,
        // The agent's own view of the operation: title, kind, locations, input.
        toolCall: normalized.toolCall,
        // Each option carries `consent` (allow_once/allow_always only); a kind
        // this client does not recognize is listed but is never consent.
        options: normalized.options,
        createdAt: Date.now(),
        settle,
      };
      sessionData.pendingPermissions.set(requestId, record);
      sessionData.updatedAt = Date.now();
      this.emit('permission_request', record);
      sessionData.emitter.emit('permission_request', record);
    });
  }

  /** Pending permission requests of one ACP session, as the HTTP layer shows them. */
  getPendingPermissions(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session?.pendingPermissions) return [];
    return Array.from(session.pendingPermissions.values()).map((request) => ({
      requestId: request.requestId,
      sessionId: request.sessionId,
      toolCall: request.toolCall,
      options: request.options,
      createdAt: request.createdAt,
    }));
  }

  /**
   * Answer a pending request with the option the user picked, or with
   * `cancelled` when they dismissed the prompt (`optionId` null/undefined).
   *
   * An unknown option id is refused instead of forwarded: the agent offered a
   * closed set, and inventing an answer would speak for the user.
   */
  respondToPermission(sessionId, requestId, optionId) {
    const session = this.activeSessions.get(sessionId);
    const pending = session?.pendingPermissions?.get(requestId);
    if (!pending) {
      throw new AcpError({
        code: ACP_ERROR.RESOURCE_NOT_FOUND,
        message: `Permission request '${requestId}' is not pending for session '${sessionId}'`,
        data: { sessionId, requestId },
      });
    }

    if (optionId === null || optionId === undefined || optionId === '') {
      pending.settle(buildPermissionCancelledOutcome());
      return { requestId, outcome: 'cancelled' };
    }

    const option = pending.options.find((entry) => entry.optionId === optionId);
    if (!option) {
      throw new AcpError({
        code: ACP_ERROR.INVALID_PARAMS,
        message: `Option '${optionId}' was not offered for permission request '${requestId}'`,
        data: { sessionId, requestId, optionId },
      });
    }

    pending.settle(buildPermissionSelectedOutcome(optionId));
    return { requestId, outcome: 'selected', optionId, kind: option.kind };
  }

  /**
   * Answer every pending request of a session with `cancelled`
   * (spec: /protocol/v1/prompt-turn#cancellation — the client MUST). Returns how
   * many were answered, so a caller can tell whether anything was waiting.
   */
  cancelPendingPermissions(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session?.pendingPermissions) return 0;
    let answered = 0;
    for (const request of Array.from(session.pendingPermissions.values())) {
      if (request.settle(buildPermissionCancelledOutcome())) answered += 1;
    }
    return answered;
  }

  async cancel(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.conn) return;
    // Answer the open prompts first: the agent is blocked on them, and a
    // cancelled turn must never leave one dangling.
    this.cancelPendingPermissions(sessionId);
    try {
      session.conn.notify('session/cancel', { sessionId });
    } catch {}
  }

  closeSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    this.cancelPendingPermissions(sessionId);
    try {
      session.unregisterPermissionHandler?.();
    } catch {}
    this.activeSessions.delete(sessionId);
    // The cancelled answers are written on the promise queue; closing the pipe
    // synchronously would drop them and leave the agent reading a dead stdin.
    const { conn } = session;
    const finish = () => {
      try {
        conn.close();
      } catch {}
    };
    // `session/close` releases the agent-side session. It is an Antigravity
    // extension, so it is sent ONLY when advertised; without it we just drop
    // the pipe (the old behaviour). Waiting for the reply keeps the process from
    // racing its own close, and a bounded timeout ensures a silent agent cannot
    // pin the child process.
    const remoteClose = session.capabilities?.close === true
      && typeof conn?.isAlive === 'function'
      && conn.isAlive();
    if (remoteClose) {
      conn.request('session/close', { sessionId }, 2000).then(finish, finish);
    } else {
      setTimeout(finish, 0);
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
