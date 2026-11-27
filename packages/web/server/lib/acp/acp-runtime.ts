import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import EventEmitter from 'node:events';
import { AcpConnection } from './acp-connection.js';
import {
  ACP_ERROR,
  ACP_EXTENSION_NOTIFICATION,
  ACP_PROTOCOL_VERSION,
  AcpError,
  AcpProtocolVersionMismatchError,
  buildPermissionCancelledOutcome,
  buildPermissionSelectedOutcome,
  buildQuestionAcceptedOutcome,
  buildQuestionCancelledOutcome,
  configOptionValue,
  isMethodNotFoundError,
  normalizeAgentCapabilities,
  normalizeConfigOptions,
  normalizeNotification,
  normalizePermissionRequest,
  normalizeQuestionRequest,
  normalizeSessionConfig,
  normalizeSessionUpdate,
  type AcpCommandNormalized,
  type AcpConfigOptionNormalized,
  type AcpPermissionOptionNormalized,
  type AcpPlanEntryNormalized,
  type AcpQuestionFieldNormalized,
  type AcpQuestionRequestMethod,
} from './acp-protocol.js';

export interface AcpAgentModelSpec {
  id: string;
  name: string;
  context: number;
  output: number;
  variants?: string[];
}

export interface AcpAgentConfig {
  id: string;
  name: string;
  folderName: string;
  providerId: string;
  providerName: string;
  defaultModel: string;
  sessionPrefix: string;
  description: string;
  command: string;
  args: string[];
  skipPermissions?: boolean;
  models: AcpAgentModelSpec[];
}

export interface AcpRuntimeOptions {
  agents?: AcpAgentConfig[];
  idleTtlMs?: number;
  resolveSalContext?: (cwd: string) => string | null;
}

export interface AcpPendingPermissionRecord {
  requestId: string;
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: AcpPermissionOptionNormalized[];
  createdAt: number;
  settle: (outcome: unknown) => boolean;
}

export interface AcpPendingQuestionRecord {
  requestId: string;
  sessionId: string;
  method: AcpQuestionRequestMethod;
  elicitationId?: string;
  title: string;
  message?: string;
  fields: AcpQuestionFieldNormalized[];
  rawParams: Record<string, unknown>;
  createdAt: number;
  settle: (outcome: unknown) => boolean;
}

export interface AcpPromptChunk {
  type: 'text' | 'thought' | 'tool' | 'tool_update' | 'plan' | 'mode' | 'config_options' | 'commands';
  delta?: string;
  tool?: Record<string, unknown>;
  update?: unknown;
  entries?: AcpPlanEntryNormalized[];
  modeId?: string | null;
  configOptions?: AcpConfigOptionNormalized[];
  availableCommands?: AcpCommandNormalized[];
}

export interface AcpPromptBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AcpSessionRecord {
  sessionId: string;
  agentId: string;
  agentInfo: { name?: string; [key: string]: unknown } | undefined;
  agentCapabilities: Record<string, unknown>;
  capabilities: ReturnType<typeof normalizeAgentCapabilities>;
  promptCapabilities: ReturnType<typeof normalizeAgentCapabilities>['promptCapabilities'];
  authMethods: unknown[];
  cwd: string;
  conn: AcpConnection;
  availableModels: Array<{ modelId: string; name: string }>;
  currentModelId: string;
  plan: AcpPlanEntryNormalized[];
  currentModeId: string | null;
  availableModes: Array<{ id: string; name: string; description: string }>;
  configOptions: AcpConfigOptionNormalized[];
  availableCommands: AcpCommandNormalized[];
  usage: Record<string, unknown> | null;
  title: string;
  tier?: unknown;
  lastUsedAt: number;
  createdAt: number;
  updatedAt: number;
  busy?: boolean;
  messages: Array<Record<string, unknown>>;
  pendingPermissions: Map<string, AcpPendingPermissionRecord>;
  pendingQuestions: Map<string, AcpPendingQuestionRecord>;
  unregisterPermissionHandler?: () => void;
  poolKey?: string;
  poolRef?: symbol;
  emitter: EventEmitter;
}

interface InitializedAcpMetadata {
  capabilities: ReturnType<typeof normalizeAgentCapabilities>;
  agentCapabilities: Record<string, unknown>;
  agentInfo: { name?: string; [key: string]: unknown } | undefined;
  authMethods: unknown[];
}

interface PooledAcpConnection {
  key: string | null;
  conn: AcpConnection;
  initPromise: Promise<InitializedAcpMetadata>;
  refs: Set<symbol>;
  sessionsById: Map<string, AcpSessionRecord>;
  inFlightSessions: Set<AcpSessionRecord>;
}

/**
 * The flag an agent needs to run without asking for permission. It is appended
 * only when the agent's own setting turns it on — see `buildAgentArgs`.
 */
export const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * The exact argv an agent is launched with.
 */
export function buildAgentArgs(agent?: { args?: string[]; skipPermissions?: boolean } | null): string[] {
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

export function resolveBinaryPath(command: string): string {
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
  } catch { /* ignore */ }
  return command;
}

export function checkBinaryExists(command: string): boolean {
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
 * Resolve SAL session-start context for agents (such as `agy acp`) that do not
 * execute workspace `SessionStart` hooks directly.
 */
export function resolveSalContext(cwd: string, command = 'sal'): string | null {
  for (const subcommand of ['context', 'self']) {
    try {
      const output = execFileSync(command, [subcommand, 'render', '--target', 'gemini'], {
        cwd,
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const trimmed = output.trim();
      if (trimmed.length > 0) return trimmed;
    } catch {
      // Try next fallback
    }
  }
  return null;
}

/**
 * Standard registry of well-known ACP agent commands.
 */
export const DEFAULT_ACP_AGENTS: AcpAgentConfig[] = [
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
  customAgents: AcpAgentConfig[];
  activeSessions: Map<string, AcpSessionRecord>;
  connectionPool: Map<string, PooledAcpConnection>;
  idleTtlMs: number;
  nextPermissionId: number;
  nextQuestionId: number;
  salContextResolver: (cwd: string) => string | null;
  reaper?: ReturnType<typeof setInterval>;

  constructor(options: AcpRuntimeOptions = {}) {
    super();
    this.customAgents = options.agents || [];
    this.activeSessions = new Map(); // sessionId -> { conn, agentId, cwd, models, currentModelId }
    this.connectionPool = new Map(); // `${agentId}:${effectiveCwd}` -> PooledAcpConnection
    this.idleTtlMs = options.idleTtlMs ?? 20 * 60 * 1000;
    this.salContextResolver = options.resolveSalContext ?? resolveSalContext;
    // Permission and question ids are ours, not the agent's JSON-RPC id: they
    // travel through a URL and must stay opaque and URL-safe.
    this.nextPermissionId = 1;
    this.nextQuestionId = 1;
    if (this.idleTtlMs > 0) {
      this.reaper = setInterval(() => this.reapIdle(), Math.min(60_000, this.idleTtlMs));
      this.reaper.unref?.();
    }
  }

  getRegisteredAgents(): AcpAgentConfig[] {
    return [...this.customAgents, ...DEFAULT_ACP_AGENTS];
  }

  getAgentConfig(agentOrProviderId: string | null | undefined): AcpAgentConfig | null {
    if (!agentOrProviderId) return null;
    return this.getRegisteredAgents().find((a) => a.id === agentOrProviderId || a.providerId === agentOrProviderId) || null;
  }

  getAvailableAgents(): AcpAgentConfig[] {
    return this.getRegisteredAgents().filter((a) => checkBinaryExists(a.command));
  }

  private applySessionUpdate(
    sessionData: AcpSessionRecord,
    normalized: NonNullable<ReturnType<typeof normalizeSessionUpdate>>,
    rawUpdate: unknown,
  ): void {
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
  }

  private resolveNotificationTarget(entry: PooledAcpConnection, params: unknown): AcpSessionRecord | null {
    const sid = params && typeof params === 'object' ? (params as { sessionId?: unknown }).sessionId : undefined;
    if (typeof sid === 'string' && sid) {
      const matched = entry.sessionsById.get(sid);
      if (matched) return matched;
      if (entry.inFlightSessions.size === 1) return Array.from(entry.inFlightSessions)[0] || null;
      return null;
    }
    if (entry.sessionsById.size === 1 && entry.inFlightSessions.size === 0) {
      return Array.from(entry.sessionsById.values())[0] || null;
    }
    if (entry.sessionsById.size === 0 && entry.inFlightSessions.size === 1) {
      return Array.from(entry.inFlightSessions)[0] || null;
    }
    return null;
  }

  private resolveRequestTarget(entry: PooledAcpConnection, method: string, params: unknown): AcpSessionRecord {
    const sid = params && typeof params === 'object' ? (params as { sessionId?: unknown }).sessionId : undefined;
    if (typeof sid === 'string' && sid) {
      const matched = entry.sessionsById.get(sid);
      if (matched) return matched;
      if (entry.sessionsById.size === 1) {
        return Array.from(entry.sessionsById.values())[0]!;
      }
      throw new AcpError({
        code: ACP_ERROR.INVALID_PARAMS,
        message: `${method} named unknown session '${sid}' for this connection`,
      });
    }
    if (entry.sessionsById.size === 1) {
      return Array.from(entry.sessionsById.values())[0]!;
    }
    throw new AcpError({
      code: ACP_ERROR.INVALID_PARAMS,
      message: `${method} requires a sessionId`,
    });
  }

  private createConnectionEntry(agent: AcpAgentConfig, effectiveCwd: string, poolKey: string | null): PooledAcpConnection {
    const resolvedCommand = resolveBinaryPath(agent.command);
    const conn = new AcpConnection(resolvedCommand, buildAgentArgs(agent), { cwd: effectiveCwd });
    const entry: PooledAcpConnection = {
      key: poolKey,
      conn,
      initPromise: null as unknown as Promise<InitializedAcpMetadata>,
      refs: new Set(),
      sessionsById: new Map(),
      inFlightSessions: new Set(),
    };

    conn.on('error', (err: Error) => {
      console.error(`[AcpRuntime] Connection error for ${agent.id}:`, err.message);
      if (poolKey && this.connectionPool.get(poolKey) === entry) {
        this.connectionPool.delete(poolKey);
      }
    });

    conn.on('close', () => {
      if (poolKey && this.connectionPool.get(poolKey) === entry) {
        this.connectionPool.delete(poolKey);
      }
      for (const sessionData of Array.from(entry.sessionsById.values())) {
        this.cancelPendingPermissions(sessionData.sessionId);
        this.cancelPendingQuestions(sessionData.sessionId);
      }
    });

    conn.on('session/update', (params: unknown) => {
      const p = params && typeof params === 'object' ? (params as { update?: unknown }) : undefined;
      if (!p?.update) return;
      const target = this.resolveNotificationTarget(entry, params);
      if (!target) return;
      const normalized = normalizeSessionUpdate(p.update);
      if (!normalized) return;
      this.applySessionUpdate(target, normalized, p.update);
    });

    for (const method of Object.values(ACP_EXTENSION_NOTIFICATION)) {
      conn.on(method, (params: unknown) => {
        const target = this.resolveNotificationTarget(entry, params);
        if (!target) return;
        const normalized = normalizeNotification(method, params);
        if (!normalized) return;
        this.applySessionUpdate(target, normalized, params);
      });
    }

    conn.registerRequestHandler('session/request_permission', (params) => {
      const target = this.resolveRequestTarget(entry, 'session/request_permission', params);
      return this.handlePermissionRequest(target, params);
    });

    conn.registerRequestHandler('elicitation/create', (params) => {
      const target = this.resolveRequestTarget(entry, 'elicitation/create', params);
      return this.handleQuestionRequest(target, params, 'elicitation/create');
    });

    conn.registerRequestHandler('ask_question', (params) => {
      const target = this.resolveRequestTarget(entry, 'ask_question', params);
      return this.handleQuestionRequest(target, params, 'ask_question');
    });

    conn.start();

    entry.initPromise = (async () => {
      const initResult = (await conn.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          elicitation: { form: {} },
        },
        clientInfo: { name: 'openchamber', title: 'OpenChamber', version: '2.6.1' },
      })) as Record<string, unknown> | null;

      if (initResult?.protocolVersion !== ACP_PROTOCOL_VERSION) {
        const received = initResult?.protocolVersion as number | string | null | undefined;
        conn.close();
        throw new AcpProtocolVersionMismatchError({
          requested: ACP_PROTOCOL_VERSION,
          ...(received !== undefined ? { received } : {}),
        });
      }

      const capabilities = normalizeAgentCapabilities(initResult.agentCapabilities);
      const agentCapabilities = initResult.agentCapabilities && typeof initResult.agentCapabilities === 'object'
        ? (initResult.agentCapabilities as Record<string, unknown>)
        : {};
      const agentInfo = initResult.agentInfo && typeof initResult.agentInfo === 'object'
        ? (initResult.agentInfo as { name?: string; [key: string]: unknown })
        : undefined;
      const authMethods = Array.isArray(initResult.authMethods) ? initResult.authMethods : [];

      return { capabilities, agentCapabilities, agentInfo, authMethods };
    })().catch((err) => {
      if (poolKey && this.connectionPool.get(poolKey) === entry) {
        this.connectionPool.delete(poolKey);
      }
      try {
        conn.close();
      } catch { /* ignore */ }
      throw err;
    });

    if (poolKey) {
      this.connectionPool.set(poolKey, entry);
    }
    return entry;
  }

  private async acquireConnection(agent: AcpAgentConfig, effectiveCwd: string): Promise<{
    entry: PooledAcpConnection;
    poolKey: string | undefined;
    poolRef: symbol;
    init: InitializedAcpMetadata;
  }> {
    const poolKey = agent.id === 'antigravity' ? `${agent.id}:${effectiveCwd}` : null;
    let entry = poolKey ? this.connectionPool.get(poolKey) : undefined;
    if (entry && (entry.conn.closed || !entry.conn.isAlive())) {
      this.connectionPool.delete(poolKey!);
      entry = undefined;
    }
    if (!entry) {
      entry = this.createConnectionEntry(agent, effectiveCwd, poolKey);
    }
    const poolRef = Symbol(poolKey || agent.id);
    entry.refs.add(poolRef);
    try {
      const init = await entry.initPromise;
      return { entry, poolKey: poolKey ?? undefined, poolRef, init };
    } catch (err) {
      entry.refs.delete(poolRef);
      if (poolKey && this.connectionPool.get(poolKey) === entry && entry.refs.size === 0) {
        this.connectionPool.delete(poolKey);
      }
      throw err;
    }
  }

  private releaseConnectionRef(entry: PooledAcpConnection, poolKey: string | undefined, poolRef: symbol): void {
    entry.refs.delete(poolRef);
    if (!poolKey || entry.refs.size === 0) {
      if (poolKey && this.connectionPool.get(poolKey) === entry) {
        this.connectionPool.delete(poolKey);
      }
      try {
        entry.conn.close();
      } catch { /* ignore */ }
    }
  }

  async createSession({ agentId = 'antigravity', cwd = process.cwd(), resumeSessionId = null }: { agentId?: string; cwd?: string; resumeSessionId?: string | null } = {}) {
    const agent = this.getAvailableAgents().find((a) => a.id === agentId);
    if (!agent) {
      throw new Error(`ACP agent '${agentId}' is not installed or available on this machine.`);
    }

    let effectiveCwd = cwd;
    if (!effectiveCwd || !fs.existsSync(effectiveCwd)) {
      effectiveCwd = process.env.HOME || '/home/jeremy';
    }

    const { entry, poolKey, poolRef, init } = await this.acquireConnection(agent, effectiveCwd);
    const { conn } = entry;
    const { capabilities, agentCapabilities, agentInfo, authMethods } = init;

    const sessionData: AcpSessionRecord = {
      sessionId: '',
      agentId,
      agentInfo,
      agentCapabilities,
      capabilities,
      promptCapabilities: capabilities.promptCapabilities,
      authMethods,
      cwd,
      conn,
      availableModels: [],
      currentModelId: '',
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
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      ...(poolKey ? { poolKey, poolRef } : {}),
      emitter: new EventEmitter(),
    };

    entry.inFlightSessions.add(sessionData);
    let sessionResult: Record<string, unknown> | null = null;
    try {
      if (resumeSessionId && capabilities.loadSession) {
        try {
          sessionResult = (await conn.request('session/load', { sessionId: resumeSessionId, cwd: effectiveCwd })) as Record<string, unknown> | null;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[AcpRuntime] session/load failed for ${resumeSessionId}, starting fresh:`, message);
        }
      }
      if (!sessionResult && resumeSessionId && capabilities.resume) {
        try {
          sessionResult = (await conn.request('session/resume', { sessionId: resumeSessionId, cwd: effectiveCwd })) as Record<string, unknown> | null;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[AcpRuntime] session/resume failed for ${resumeSessionId}, starting fresh:`, message);
        }
      }
      if (!sessionResult) {
        const sessionNewParams: Record<string, unknown> = { cwd: effectiveCwd };
        if (agentId === 'antigravity') {
          const salContext = this.salContextResolver(effectiveCwd);
          if (salContext) {
            sessionNewParams._meta = {
              antigravity: {
                systemPrompt: {
                  append: salContext,
                },
              },
            };
          }
        }
        sessionResult = (await conn.request('session/new', sessionNewParams)) as Record<string, unknown> | null;
      }
    } catch (err) {
      entry.inFlightSessions.delete(sessionData);
      this.releaseConnectionRef(entry, poolKey, poolRef);
      throw err;
    }

    entry.inFlightSessions.delete(sessionData);
    const sessionId = (typeof sessionResult?.sessionId === 'string' && sessionResult.sessionId) || resumeSessionId;
    if (!sessionId) {
      this.releaseConnectionRef(entry, poolKey, poolRef);
      throw new AcpError({
        code: ACP_ERROR.INTERNAL_ERROR,
        message: 'ACP agent did not return a session id for session/new',
      });
    }
    sessionData.sessionId = sessionId;

    const config = normalizeSessionConfig(sessionResult);
    sessionData.availableModels = config.availableModels;
    sessionData.currentModelId = config.currentModelId;
    sessionData.availableModes = config.availableModes;
    sessionData.currentModeId = config.currentModeId;
    sessionData.configOptions = config.configOptions;

    entry.sessionsById.set(sessionId, sessionData);
    const meta = sessionResult?._meta && typeof sessionResult._meta === 'object'
      ? (sessionResult._meta as { antigravity?: { tier?: unknown } })
      : undefined;

    this.activeSessions.set(sessionId, sessionData);
    return {
      sessionId,
      agentId,
      agentName: agent.name,
      availableModels: sessionData.availableModels,
      currentModelId: sessionData.currentModelId,
      tier: meta?.antigravity?.tier,
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
  requireSession(sessionId: string): AcpSessionRecord {
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

  applyConfigResult(session: AcpSessionRecord, result: unknown): AcpConfigOptionNormalized[] {
    const resObj = result && typeof result === 'object' ? (result as { configOptions?: unknown }) : undefined;
    if (Array.isArray(resObj?.configOptions)) {
      session.configOptions = normalizeConfigOptions(resObj.configOptions);
    }
    const mode = configOptionValue(session.configOptions, 'mode');
    if (typeof mode === 'string' && mode) session.currentModeId = mode;
    const model = configOptionValue(session.configOptions, 'model');
    if (typeof model === 'string' && model) session.currentModelId = model;
    session.updatedAt = Date.now();
    session.emitter.emit('config_options', session.configOptions);
    return session.configOptions;
  }

  async setConfigOption(sessionId: string, configId: string, value: string) {
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

  async applyConfigWithAlias(
    sessionId: string,
    { configId, value, aliasMethod, aliasKey }: { configId: string; value: string; aliasMethod: string; aliasKey: string },
  ) {
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

  async setModel(sessionId: string, modelId: string) {
    const result = await this.applyConfigWithAlias(sessionId, {
      configId: 'model', value: modelId, aliasMethod: 'session/set_model', aliasKey: 'modelId',
    });
    const session = this.requireSession(sessionId);
    session.currentModelId = modelId;
    return { success: true, modelId, method: result.method };
  }

  async setMode(sessionId: string, modeId: string) {
    const result = await this.applyConfigWithAlias(sessionId, {
      configId: 'mode', value: modeId, aliasMethod: 'session/set_mode', aliasKey: 'modeId',
    });
    const session = this.requireSession(sessionId);
    session.currentModeId = modeId;
    return { success: true, modeId, method: result.method };
  }

  async setModelLegacy(sessionId: string, modelId: string) {
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

  async setModeLegacy(sessionId: string, modeId: string) {
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

  async listRemoteSessions(sessionId: string, { cwd }: { cwd?: string } = {}) {
    const session = this.requireSession(sessionId);
    if (!session.capabilities?.list) return { supported: false, sessions: [] as unknown[] };
    const result = (await session.conn.request('session/list', cwd ? { cwd } : {})) as { sessions?: unknown } | null;
    return { supported: true, sessions: Array.isArray(result?.sessions) ? result.sessions : [] };
  }

  async resumeSession(sessionId: string, { cwd }: { cwd?: string } = {}) {
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

  async deleteSession(sessionId: string) {
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

  getSession(sessionId: string) {
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

  async prompt(sessionId: string, text: string | AcpPromptBlock[], onChunk: ((chunk: AcpPromptChunk) => void) | null = null) {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found.`);

    const plainText = Array.isArray(text) ? (text.find((b) => b.type === 'text')?.text || '') : text;
    if (!session.title || session.title === 'New Session') {
      session.title = plainText.trim().slice(0, 40) || 'New Session';
    }
    session.updatedAt = Date.now();
    session.lastUsedAt = Date.now();
    session.busy = true;

    const userMsg = { id: `msg_${Date.now()}_u`, role: 'user', text: plainText, createdAt: Date.now() };
    session.messages.push(userMsg);

    let assistantText = '';
    let assistantThought = '';
    const assistantTools: Array<Record<string, unknown>> = [];

    let unsub: (() => void) | null = null;
    if (onChunk) {
      const handler = (delta: string) => {
        assistantText += delta;
        onChunk({ type: 'text', delta });
      };
      const thoughtHandler = (delta: string) => {
        assistantThought += delta;
        onChunk({ type: 'thought', delta });
      };
      const toolHandler = (tool: Record<string, unknown>) => {
        assistantTools.push(tool);
        onChunk({ type: 'tool', tool });
      };
      const toolUpdateHandler = (update: unknown) => {
        onChunk({ type: 'tool_update', update });
      };
      const planHandler = (entries: AcpPlanEntryNormalized[]) => onChunk({ type: 'plan', entries });
      const modeHandler = (modeId: string | null) => onChunk({ type: 'mode', modeId });
      const configHandler = (configOptions: AcpConfigOptionNormalized[]) => onChunk({ type: 'config_options', configOptions });
      const commandsHandler = (availableCommands: AcpCommandNormalized[]) => onChunk({ type: 'commands', availableCommands });

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

      return result as { text?: string; usage?: Record<string, number> };
    } finally {
      session.busy = false;
      session.lastUsedAt = Date.now();
      if (unsub) unsub();
    }
  }

  isSessionAlive(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    return Boolean(session && session.conn && session.conn.isAlive());
  }

  handlePermissionRequest(sessionData: AcpSessionRecord, params: unknown): Promise<unknown> {
    const normalized = normalizePermissionRequest(params);
    if (normalized.sessionId !== sessionData.sessionId) {
      throw new AcpError({
        code: ACP_ERROR.INVALID_PARAMS,
        message: `session/request_permission named session '${normalized.sessionId}', but this connection is bound to '${sessionData.sessionId}'`,
      });
    }

    const requestId = `perm_${this.nextPermissionId++}`;
    return new Promise((resolve) => {
      const settle = (outcome: unknown) => {
        if (!sessionData.pendingPermissions.has(requestId)) return false;
        sessionData.pendingPermissions.delete(requestId);
        resolve(outcome);
        const settled = { requestId, sessionId: sessionData.sessionId, outcome };
        this.emit('permission_settled', settled);
        sessionData.emitter.emit('permission_settled', settled);
        return true;
      };

      const record: AcpPendingPermissionRecord = {
        requestId,
        sessionId: sessionData.sessionId,
        toolCall: normalized.toolCall,
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

  getPendingPermissions(sessionId: string) {
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

  respondToPermission(sessionId: string, requestId: string, optionId: string | null | undefined) {
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
      return { requestId, outcome: 'cancelled' as const };
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
    return { requestId, outcome: 'selected' as const, optionId, kind: option.kind };
  }

  cancelPendingPermissions(sessionId: string): number {
    const session = this.activeSessions.get(sessionId);
    if (!session?.pendingPermissions) return 0;
    let answered = 0;
    for (const request of Array.from(session.pendingPermissions.values())) {
      if (request.settle(buildPermissionCancelledOutcome())) answered += 1;
    }
    return answered;
  }

  handleQuestionRequest(
    sessionData: AcpSessionRecord,
    params: unknown,
    method: AcpQuestionRequestMethod = 'elicitation/create',
  ): Promise<unknown> {
    const normalized = normalizeQuestionRequest(params, method);
    if (normalized.sessionId !== sessionData.sessionId) {
      throw new AcpError({
        code: ACP_ERROR.INVALID_PARAMS,
        message: `${method} named session '${normalized.sessionId}', but this connection is bound to '${sessionData.sessionId}'`,
      });
    }

    const requestId = `qst_${this.nextQuestionId++}`;
    return new Promise((resolve) => {
      const settle = (outcome: unknown) => {
        if (!sessionData.pendingQuestions.has(requestId)) return false;
        sessionData.pendingQuestions.delete(requestId);
        resolve(outcome);
        const settled = { requestId, sessionId: sessionData.sessionId, method, outcome };
        this.emit('question_settled', settled);
        sessionData.emitter.emit('question_settled', settled);
        return true;
      };

      const record: AcpPendingQuestionRecord = {
        requestId,
        sessionId: sessionData.sessionId,
        method: normalized.method,
        ...(normalized.elicitationId ? { elicitationId: normalized.elicitationId } : {}),
        title: normalized.title,
        ...(normalized.message ? { message: normalized.message } : {}),
        fields: normalized.fields,
        rawParams: normalized.rawParams,
        createdAt: Date.now(),
        settle,
      };
      sessionData.pendingQuestions.set(requestId, record);
      sessionData.updatedAt = Date.now();
      this.emit('question_request', record);
      sessionData.emitter.emit('question_request', record);
    });
  }

  getPendingQuestions(sessionId: string) {
    const session = this.activeSessions.get(sessionId);
    if (!session?.pendingQuestions) return [];
    return Array.from(session.pendingQuestions.values()).map((request) => ({
      requestId: request.requestId,
      sessionId: request.sessionId,
      method: request.method,
      ...(request.elicitationId ? { elicitationId: request.elicitationId } : {}),
      title: request.title,
      ...(request.message ? { message: request.message } : {}),
      fields: request.fields,
      createdAt: request.createdAt,
    }));
  }

  respondToQuestion(
    sessionId: string,
    requestId: string,
    answer: Record<string, unknown> | null | undefined,
  ) {
    const session = this.activeSessions.get(sessionId);
    const pending = session?.pendingQuestions?.get(requestId);
    if (!pending) {
      throw new AcpError({
        code: ACP_ERROR.RESOURCE_NOT_FOUND,
        message: `Question request '${requestId}' is not pending for session '${sessionId}'`,
        data: { sessionId, requestId },
      });
    }

    if (answer === null || answer === undefined) {
      pending.settle(buildQuestionCancelledOutcome(pending.method));
      return { requestId, outcome: 'cancelled' as const };
    }

    if (typeof answer !== 'object' || Array.isArray(answer)) {
      throw new AcpError({
        code: ACP_ERROR.INVALID_PARAMS,
        message: `Question answer for '${requestId}' must be an object`,
        data: { sessionId, requestId },
      });
    }

    pending.settle(buildQuestionAcceptedOutcome(pending.method, answer));
    return { requestId, outcome: 'accepted' as const, answer };
  }

  cancelPendingQuestions(sessionId: string): number {
    const session = this.activeSessions.get(sessionId);
    if (!session?.pendingQuestions) return 0;
    let answered = 0;
    for (const request of Array.from(session.pendingQuestions.values())) {
      if (request.settle(buildQuestionCancelledOutcome(request.method))) answered += 1;
    }
    return answered;
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.conn) return;
    this.cancelPendingPermissions(sessionId);
    this.cancelPendingQuestions(sessionId);
    try {
      session.conn.notify('session/cancel', { sessionId });
    } catch { /* ignore */ }
  }

  closeSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    this.cancelPendingPermissions(sessionId);
    this.cancelPendingQuestions(sessionId);
    try {
      session.unregisterPermissionHandler?.();
    } catch { /* ignore */ }
    this.activeSessions.delete(sessionId);

    const { conn, poolKey, poolRef } = session;
    const poolEntry = poolKey ? this.connectionPool.get(poolKey) : undefined;
    if (poolEntry) {
      poolEntry.sessionsById.delete(sessionId);
      if (poolRef) poolEntry.refs.delete(poolRef);
    }

    const shouldCloseConn = !poolKey || !poolEntry || poolEntry.refs.size === 0;
    if (shouldCloseConn && poolKey && this.connectionPool.get(poolKey) === poolEntry) {
      this.connectionPool.delete(poolKey);
    }

    const finish = () => {
      if (!shouldCloseConn) return;
      try {
        conn.close();
      } catch { /* ignore */ }
    };
    const remoteClose = session.capabilities?.close === true
      && typeof conn?.isAlive === 'function'
      && conn.isAlive();
    if (remoteClose) {
      conn.request('session/close', { sessionId }, 2000).then(finish, finish);
    } else if (shouldCloseConn) {
      setTimeout(finish, 0);
    }
  }

  reapIdle(now = Date.now()): void {
    for (const [id, s] of this.activeSessions.entries()) {
      if (!s.busy && now - (s.lastUsedAt || s.createdAt || now) > this.idleTtlMs) {
        this.closeSession(id);
      }
    }
  }

  closeAll(): void {
    for (const [id] of Array.from(this.activeSessions.entries())) {
      this.closeSession(id);
    }
    for (const [key, entry] of Array.from(this.connectionPool.entries())) {
      this.connectionPool.delete(key);
      try {
        entry.conn.close();
      } catch { /* ignore */ }
    }
    if (this.reaper) {
      clearInterval(this.reaper);
      delete this.reaper;
    }
  }
}
