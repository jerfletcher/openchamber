/**
 * ACP v1 protocol core shared by the connection, runtime, routes and bridge.
 *
 * Everything in this module is derived from the published Agent Client Protocol
 * v1 specification, so the spec citations live next to the code that depends on
 * them:
 *  - https://agentclientprotocol.com/protocol/v1/initialization  (protocolVersion, capabilities)
 *  - https://agentclientprotocol.com/protocol/v1/error           (JSON-RPC error codes)
 *  - https://agentclientprotocol.com/protocol/v1/prompt-turn     (SessionUpdate variants)
 *  - https://agentclientprotocol.com/protocol/v1/tool-calls      (session/request_permission, PermissionOption)
 *  - https://agentclientprotocol.com/protocol/v1/agent-plan      (plan entries)
 *  - https://agentclientprotocol.com/protocol/v1/session-modes   (current_mode_update)
 *  - https://agentclientprotocol.com/protocol/v1/session-config-options (config_option_update)
 *  - https://agentclientprotocol.com/protocol/v1/slash-commands  (available_commands_update)
 *  - https://agentclientprotocol.com/protocol/v1/content         (prompt capability gating)
 */

/** The single MAJOR protocol version this client implements and MUST advertise. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * JSON-RPC / ACP error codes (spec: /protocol/v1/error).
 *
 * `-32800` is taken from the ACP-reserved range and is NOT an internal failure:
 * a cancelled request must stay distinguishable from a generic error so callers
 * can stop quietly instead of reporting a failure to the user.
 */
export const ACP_ERROR = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  REQUEST_CANCELLED: -32800,
  AUTHENTICATION_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
});

/**
 * Human-readable kind per spec code. The spec requires an unrecognized code to
 * be treated as a generic failure, which is what `acpErrorKind` returns for
 * anything outside this table; the raw numeric code is still preserved.
 */
const KIND_BY_CODE: Record<number, string> = Object.freeze({
  [ACP_ERROR.PARSE_ERROR]: 'parse-error',
  [ACP_ERROR.INVALID_REQUEST]: 'invalid-request',
  [ACP_ERROR.METHOD_NOT_FOUND]: 'method-not-found',
  [ACP_ERROR.INVALID_PARAMS]: 'invalid-params',
  [ACP_ERROR.INTERNAL_ERROR]: 'internal-error',
  [ACP_ERROR.REQUEST_CANCELLED]: 'cancelled',
  [ACP_ERROR.AUTHENTICATION_REQUIRED]: 'authentication-required',
  [ACP_ERROR.RESOURCE_NOT_FOUND]: 'resource-not-found',
});

/**
 * Transport-level failures have no JSON-RPC code. They still need a stable kind
 * so routes can answer with a meaningful status instead of a blanket 500.
 */
export const ACP_TRANSPORT_ERROR = Object.freeze({
  PROTOCOL_VERSION_MISMATCH: 'protocol-version-mismatch',
});

/**
 * Antigravity extension notification methods, accepted at the TOP LEVEL of a
 * JSON-RPC message.
 *
 * This is NOT part of ACP v1: the spec delivers both updates as SessionUpdate
 * variants nested inside `session/update` (and the live `agy` binary does
 * exactly that). The extension surface also permits the standalone
 * notification form, so both shapes are accepted — one normalizer feeds both.
 * A notification carries no `id`, so it is never answered; replying to one would
 * be a JSON-RPC violation.
 */
export const ACP_EXTENSION_NOTIFICATION = Object.freeze({
  AVAILABLE_COMMANDS_UPDATE: 'session/available_commands_update',
  CONFIG_OPTION_UPDATE: 'session/config_option_update',
});

/**
 * True only when the peer rejected a method as unknown (-32601). A legacy alias
 * must fall back to `session/set_config_option` on exactly this signal — not on
 * a timeout or a permission failure, which would double-apply a change.
 */
export function isMethodNotFoundError(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { code?: unknown }).code === ACP_ERROR.METHOD_NOT_FOUND;
}

export function acpErrorKind(code: unknown): string {
  return typeof code === 'number' ? (KIND_BY_CODE[code] || 'unknown') : 'unknown';
}

export interface AcpErrorInit {
  code?: number | string | undefined;
  message?: string | undefined;
  data?: unknown;
  method?: string | undefined;
  kind?: string | undefined;
}

/**
 * Typed error for every protocol-level failure.
 *
 * `code` is the numeric JSON-RPC code when the peer sent one, or a string
 * sentinel for transport-level failures such as a version mismatch.
 */
export class AcpError extends Error {
  code: number | string | undefined;
  data: unknown;
  method: string | undefined;
  kind: string;

  constructor({ code, message, data, method, kind }: AcpErrorInit = {}) {
    super(message || (typeof code === 'number' ? `ACP error ${code}` : 'ACP error'));
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
    this.method = method;
    this.kind = kind || (typeof code === 'number' ? acpErrorKind(code) : 'unknown');
  }
}

/**
 * Raised when the agent picks a protocol version this client cannot speak.
 * The spec says the client SHOULD close the connection and inform the user
 * (https://agentclientprotocol.com/protocol/v1/initialization#version-negotiation),
 * so this error is what the runtime throws after closing the peer.
 */
export class AcpProtocolVersionMismatchError extends AcpError {
  requested: number | string | undefined;
  received: number | string | null;

  constructor({ requested, received }: { requested?: number | string; received?: number | string | null } = {}) {
    const receivedLabel = received === undefined || received === null ? 'missing' : String(received);
    super({
      code: ACP_TRANSPORT_ERROR.PROTOCOL_VERSION_MISMATCH,
      kind: ACP_TRANSPORT_ERROR.PROTOCOL_VERSION_MISMATCH,
      message: `ACP agent does not support protocol version ${requested} (it answered ${receivedLabel}); closing the connection.`,
      data: { requested, received: received ?? null },
    });
    this.name = 'AcpProtocolVersionMismatchError';
    this.requested = requested;
    this.received = received ?? null;
  }
}

export function isAcpError(err: unknown): err is AcpError | { code: number | string; kind: string; message?: string; data?: unknown } {
  return err instanceof AcpError || (
    Boolean(err)
    && typeof err === 'object'
    && typeof (err as { code?: unknown }).code !== 'undefined'
    && typeof (err as { kind?: unknown }).kind === 'string'
  );
}

/** True only for the ACP cancellation code — never for a generic failure. */
export function isAcpCancelledError(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { code?: unknown }).code === ACP_ERROR.REQUEST_CANCELLED;
}

/**
 * HTTP status for an ACP failure surfaced through the REST/SSE routes.
 * Cancellation is 499 (the conventional "client closed request"), which keeps
 * it out of the 5xx family so it is not mistaken for a server fault.
 */
export function httpStatusForAcpError(err: unknown): number {
  const errObj = err && typeof err === 'object' ? (err as { code?: unknown; kind?: unknown }) : null;
  switch (errObj?.code) {
    case ACP_ERROR.PARSE_ERROR:
    case ACP_ERROR.INVALID_REQUEST:
    case ACP_ERROR.INVALID_PARAMS:
      return 400;
    case ACP_ERROR.METHOD_NOT_FOUND:
      return 501;
    case ACP_ERROR.REQUEST_CANCELLED:
      return 499;
    case ACP_ERROR.AUTHENTICATION_REQUIRED:
      return 401;
    case ACP_ERROR.RESOURCE_NOT_FOUND:
      return 404;
    case ACP_ERROR.INTERNAL_ERROR:
      return 500;
    default:
      return errObj?.kind === ACP_TRANSPORT_ERROR.PROTOCOL_VERSION_MISMATCH ? 502 : 500;
  }
}

/**
 * Machine-readable error body. `error` stays a string so existing clients keep
 * working; the typed detail rides alongside it.
 */
export function serializeAcpError(err: unknown) {
  const errObj = err && typeof err === 'object' ? (err as { message?: unknown }) : null;
  const message = (typeof errObj?.message === 'string' && errObj.message) || 'ACP request failed';
  if (!isAcpError(err)) return { error: message };
  return {
    error: message,
    acpError: {
      code: err.code,
      kind: err.kind,
      message,
      ...(typeof err.data === 'undefined' ? {} : { data: err.data }),
    },
  };
}

export const PLAN_PRIORITIES = Object.freeze(['high', 'medium', 'low']);
export const PLAN_STATUSES = Object.freeze(['pending', 'in_progress', 'completed']);

/**
 * Permission option kinds (spec: /protocol/v1/tool-calls#permission-options).
 * `kind` is only a UI hint and the option's `name` describes its scope, but the
 * kind is the one field a client can reason about safely, so it is a closed set.
 */
export const PERMISSION_OPTION_KINDS = Object.freeze([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);

/**
 * True for the two kinds that constitute consent. Everything else — including an
 * unrecognized kind, a missing one, and the reject kinds — is NOT consent. This
 * is the client-side mirror of the spec's rule that an agent must not treat an
 * outcome it does not recognize as approval: a client must not treat an option
 * it does not recognize as a grant either.
 */
export interface AcpPermissionOptionNormalized {
  optionId: string;
  name: string;
  kind: string;
  consent: boolean;
}

export interface AcpNormalizedPermissionRequest {
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: AcpPermissionOptionNormalized[];
}

export interface AcpPlanEntryNormalized {
  content: string;
  priority: string;
  status: string;
}

export interface AcpCommandNormalized {
  name: string;
  description: string;
  input?: Record<string, unknown>;
}

export interface AcpConfigOptionValueNormalized {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOptionNormalized {
  id: string;
  name: string;
  type: string;
  currentValue: unknown;
  category?: string;
  options?: AcpConfigOptionValueNormalized[];
}

export function isConsentOptionKind(kind: unknown): boolean {
  return kind === 'allow_once' || kind === 'allow_always';
}

/** True for the reject kinds; used only to label the action, never to auto-answer. */
export function isRejectOptionKind(kind: unknown): boolean {
  return kind === 'reject_once' || kind === 'reject_always';
}

export function isPermissionOptionKind(kind: unknown): boolean {
  return typeof kind === 'string' && (PERMISSION_OPTION_KINDS as readonly string[]).includes(kind);
}

/**
 * Normalize one `session/request_permission` params object
 * (spec: /protocol/v1/tool-calls#requesting-permission).
 *
 * Malformed options are dropped rather than guessed at: an option without an
 * `optionId` cannot be selected, and inventing one would let the client answer
 * with an id the agent never offered. A recognized-shape option with an unknown
 * `kind` is kept (the user may still pick it and the agent decides), but it is
 * never consent — see `isConsentOptionKind`.
 */
export function normalizePermissionRequest(params: unknown): AcpNormalizedPermissionRequest {
  if (!params || typeof params !== 'object') {
    throw new AcpError({
      code: ACP_ERROR.INVALID_PARAMS,
      message: 'session/request_permission requires a params object',
    });
  }
  const p = params as Record<string, unknown>;
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : '';
  if (!sessionId) {
    throw new AcpError({
      code: ACP_ERROR.INVALID_PARAMS,
      message: 'session/request_permission requires a sessionId',
    });
  }

  const rawOptions = Array.isArray(p.options) ? p.options : [];
  const options: AcpPermissionOptionNormalized[] = [];
  for (const rawOption of rawOptions) {
    if (!rawOption || typeof rawOption !== 'object') continue;
    const option = rawOption as Record<string, unknown>;
    const optionId = typeof option.optionId === 'string' ? option.optionId : '';
    if (!optionId) continue;
    options.push({
      optionId,
      name: typeof option.name === 'string' && option.name ? option.name : optionId,
      // An unknown kind is preserved verbatim so the UI can show it and the
      // agent can interpret its own extension; it is never consent.
      kind: typeof option.kind === 'string' ? option.kind : 'unknown',
      consent: isConsentOptionKind(option.kind),
    });
  }

  return {
    sessionId,
    toolCall: p.toolCall && typeof p.toolCall === 'object' ? (p.toolCall as Record<string, unknown>) : {},
    options,
  };
}

/** The `selected` outcome a client returns when the user picks an option. */
export function buildPermissionSelectedOutcome(optionId: string) {
  return { outcome: { outcome: 'selected' as const, optionId } };
}

/**
 * The `cancelled` outcome. The spec REQUIRES this answer for every pending
 * request when the prompt turn is cancelled, so it is never optional.
 */
export function buildPermissionCancelledOutcome() {
  return { outcome: { outcome: 'cancelled' as const } };
}

/**
 * Plan entries as an ordered todo list (spec: /protocol/v1/agent-plan).
 * Malformed entries are dropped rather than crashing the turn, and the array
 * order is preserved because the agent's order is the intended reading order.
 */
export function normalizePlanEntries(entries: unknown): AcpPlanEntryNormalized[] {
  if (!Array.isArray(entries)) return [];
  const normalized: AcpPlanEntryNormalized[] = [];
  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (!content) continue;
    normalized.push({
      content,
      priority: typeof entry.priority === 'string' && (PLAN_PRIORITIES as readonly string[]).includes(entry.priority) ? entry.priority : 'medium',
      status: typeof entry.status === 'string' && (PLAN_STATUSES as readonly string[]).includes(entry.status) ? entry.status : 'pending',
    });
  }
  return normalized;
}

export function normalizeAvailableCommands(commands: unknown): AcpCommandNormalized[] {
  if (!Array.isArray(commands)) return [];
  const normalized: AcpCommandNormalized[] = [];
  for (const rawCommand of commands) {
    if (!rawCommand || typeof rawCommand !== 'object') continue;
    const command = rawCommand as Record<string, unknown>;
    const name = typeof command.name === 'string' ? command.name : '';
    if (!name) continue;
    normalized.push({
      name,
      description: typeof command.description === 'string' ? command.description : '',
      ...(command.input && typeof command.input === 'object' ? { input: command.input as Record<string, unknown> } : {}),
    });
  }
  return normalized;
}

/**
 * Normalize one config option value list (`configOptions[].options`). Both the
 * spec shape ({ value, name }) and the extension shape ({ id, name }) are
 * accepted; a string entry is its own value and label.
 */
function normalizeConfigOptionValues(values: unknown): AcpConfigOptionValueNormalized[] {
  if (!Array.isArray(values)) return [];
  const normalized: AcpConfigOptionValueNormalized[] = [];
  for (const rawEntry of values) {
    if (typeof rawEntry === 'string') {
      if (!rawEntry) continue;
      normalized.push({ value: rawEntry, name: rawEntry });
      continue;
    }
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;
    const value = firstString(entry.value, entry.id);
    if (!value) continue;
    normalized.push({
      value,
      name: firstString(entry.name) || value,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    });
  }
  return normalized;
}

/**
 * Normalize `configOptions` from `session/new`, `session/resume`, or a
 * `config_option_update`. The live `agy` response uses `{ id, name, category,
 * type, currentValue, options: [{ value, name }] }`; snake_case and `configId`
 * spellings are accepted so an older build does not silently lose the list.
 * An entry without an id cannot be set, so it is dropped rather than guessed.
 */
export function normalizeConfigOptions(options: unknown): AcpConfigOptionNormalized[] {
  if (!Array.isArray(options)) return [];
  const normalized: AcpConfigOptionNormalized[] = [];
  for (const rawOption of options) {
    if (!rawOption || typeof rawOption !== 'object') continue;
    const option = rawOption as Record<string, unknown>;
    const id = firstString(option.id, option.configId, option.config_id);
    if (!id) continue;
    const entry: AcpConfigOptionNormalized = {
      id,
      name: firstString(option.name) || id,
      type: firstString(option.type) || 'select',
      currentValue: typeof option.currentValue !== 'undefined'
        ? option.currentValue
        : (typeof option.current_value !== 'undefined' ? option.current_value : null),
    };
    if (typeof option.category === 'string') entry.category = option.category;
    if (Array.isArray(option.options)) entry.options = normalizeConfigOptionValues(option.options);
    normalized.push(entry);
  }
  return normalized;
}

/** Current value of one config option, or undefined when it is not present. */
export function configOptionValue(configOptions: unknown, configId: string): unknown {
  if (!Array.isArray(configOptions)) return undefined;
  const match = configOptions.find((option) => option && typeof option === 'object' && (option as { id?: unknown }).id === configId) as { currentValue?: unknown } | undefined;
  return match ? match.currentValue : undefined;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function chunkText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as Record<string, unknown>;
  return typeof c.text === 'string' ? c.text : '';
}

/**
 * Normalize one `session/update` payload into a typed event.
 *
 * The spec names are authoritative (`agent_thought_chunk`, `tool_call`), but
 * two legacy spellings from earlier integrations (`thought`, `toolCall`) may
 * still arrive from a live agent; both are accepted and normalized to the spec
 * name so no caller has to know which spelling it got.
 */
export function normalizeSessionUpdate(rawUpdate: unknown) {
  if (!rawUpdate || typeof rawUpdate !== 'object') return null;
  const update = rawUpdate as Record<string, unknown>;
  const name = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : null;

  switch (name) {
    case 'agent_message_chunk':
      return { type: 'text_delta' as const, text: chunkText(update.content) };
    case 'agent_thought_chunk':
      return { type: 'thought_delta' as const, text: chunkText(update.content) };
    case 'thought': // legacy spelling — not a spec name
      return { type: 'thought_delta' as const, text: (typeof update.thought === 'string' ? update.thought : '') || chunkText(update.content) };
    case 'user_message_chunk':
      return { type: 'user_message_chunk' as const, text: chunkText(update.content) };
    case 'tool_call':
    case 'toolCall': // legacy spelling — not a spec name
      return { type: 'tool_call' as const, toolCall: (update.toolCall || update.tool || update) as Record<string, unknown> };
    case 'tool_call_update':
      return { type: 'tool_call_update' as const, update };
    case 'plan':
      return { type: 'plan' as const, entries: normalizePlanEntries(update.entries) };
    case 'current_mode_update':
      return { type: 'current_mode' as const, modeId: typeof update.currentModeId === 'string' ? update.currentModeId : '' };
    case 'config_option_update':
      return {
        type: 'config_options' as const,
        configOptions: normalizeConfigOptions(update.configOptions ?? update.config_options),
      };
    case 'available_commands_update':
      return {
        type: 'available_commands' as const,
        availableCommands: normalizeAvailableCommands(update.availableCommands ?? update.available_commands),
      };
    case 'session_info_update':
      return { type: 'session_info' as const, title: typeof update.title === 'string' ? update.title : null };
    case 'usage_update':
      return { type: 'usage' as const, usage: update.usage && typeof update.usage === 'object' ? (update.usage as Record<string, unknown>) : null };
    default:
      if (name) return { type: 'unknown' as const, sessionUpdate: name };
      // Payloads without a discriminator: only the legacy tool-call shape can be
      // recovered, because its marker field is unambiguous.
      if (update.toolCall) return { type: 'tool_call' as const, toolCall: update.toolCall as Record<string, unknown> };
      return { type: 'unknown' as const, sessionUpdate: null };
  }
}

/**
 * Prompt capabilities are what the AGENT advertised in `initialize`
 * (spec: /protocol/v1/initialization#prompt-capabilities). Anything omitted is
 * UNSUPPORTED, so callers must treat a missing object as "text and
 * resource_link only".
 */
export function normalizePromptCapabilities(agentCapabilities: unknown) {
  const ac = agentCapabilities && typeof agentCapabilities === 'object' ? (agentCapabilities as Record<string, unknown>) : undefined;
  const caps = ac?.promptCapabilities && typeof ac.promptCapabilities === 'object' ? (ac.promptCapabilities as Record<string, unknown>) : undefined;
  return {
    image: caps?.image === true,
    audio: caps?.audio === true,
    embeddedContext: caps?.embeddedContext === true,
  };
}

/**
 * Session-management capabilities advertised in the `initialize` result.
 *
 * The live `agy` binary advertises BOTH spellings and in both places:
 *   agentCapabilities.loadSession === true
 *   agentCapabilities.load_session === true
 *   agentCapabilities.sessionCapabilities.{load,resume,close,list,additionalDirectories}
 *   agentCapabilities.session_capabilities.{...}
 * and it does NOT advertise `delete` (which is why `session/delete` answers
 * -32601). Anything omitted is UNSUPPORTED: the runtime must never send a
 * method whose flag is false here.
 */
export function normalizeAgentCapabilities(agentCapabilities: unknown) {
  const caps = agentCapabilities && typeof agentCapabilities === 'object' ? (agentCapabilities as Record<string, unknown>) : {};
  const rawSessionCaps = caps.sessionCapabilities ?? caps.session_capabilities ?? {};
  const sessionCaps = rawSessionCaps && typeof rawSessionCaps === 'object' ? (rawSessionCaps as Record<string, unknown>) : {};
  const has = (key: string) => Boolean(sessionCaps[key]) || Boolean(sessionCaps[snakeKey(key)]);
  return {
    loadSession: caps.loadSession === true || caps.load_session === true || has('load'),
    resume: has('resume'),
    close: has('close'),
    list: has('list'),
    delete: has('delete'),
    additionalDirectories: has('additionalDirectories'),
    promptCapabilities: normalizePromptCapabilities(caps),
  };
}

function snakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

/**
 * Normalize the model list from `session/new` / `session/resume`.
 *
 * The live shape is `models.availableModels: [{ modelId, name }]`; the
 * extension surface also has `available_models` and a bare top-level
 * `availableModels`. Every spelling is accepted because the exact key names are
 * not part of any published Antigravity spec.
 */
function normalizeModelList(list: unknown): Array<{ modelId: string; name: string }> {
  if (!Array.isArray(list)) return [];
  const normalized: Array<{ modelId: string; name: string }> = [];
  for (const rawEntry of list) {
    if (typeof rawEntry === 'string') {
      if (!rawEntry) continue;
      normalized.push({ modelId: rawEntry, name: rawEntry });
      continue;
    }
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;
    const modelId = firstString(entry.modelId, entry.model_id, entry.id, entry.value);
    if (!modelId) continue;
    normalized.push({ modelId, name: firstString(entry.name) || modelId });
  }
  return normalized;
}

/** Modes use `id` in the live response; `modeId`/`value` are accepted too. */
function normalizeModeList(list: unknown): Array<{ id: string; name: string; description: string }> {
  if (!Array.isArray(list)) return [];
  const normalized: Array<{ id: string; name: string; description: string }> = [];
  for (const rawEntry of list) {
    if (typeof rawEntry === 'string') {
      if (!rawEntry) continue;
      normalized.push({ id: rawEntry, name: rawEntry, description: '' });
      continue;
    }
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;
    const id = firstString(entry.id, entry.modeId, entry.mode_id, entry.value);
    if (!id) continue;
    normalized.push({
      id,
      name: firstString(entry.name) || id,
      description: typeof entry.description === 'string' ? entry.description : '',
    });
  }
  return normalized;
}

/**
 * Normalize the session configuration carried by `session/new`,
 * `session/resume`, and (partially) `session/load`.
 */
export function normalizeSessionConfig(result: unknown) {
  const source = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const modelsBlock = source.models && typeof source.models === 'object' ? (source.models as Record<string, unknown>) : {};
  const availableModels = normalizeModelList(
    modelsBlock.availableModels
      ?? modelsBlock.available_models
      ?? source.availableModels
      ?? source.available_models,
  );
  const currentModelId = firstString(
    modelsBlock.currentModelId,
    modelsBlock.current_model_id,
    source.currentModelId,
    source.current_model_id,
  ) || availableModels[0]?.modelId || '';

  const modesBlock = source.modes && typeof source.modes === 'object' ? (source.modes as Record<string, unknown>) : {};
  const availableModes = normalizeModeList(
    modesBlock.availableModes
      ?? modesBlock.available_modes
      ?? source.availableModes
      ?? source.available_modes,
  );
  const currentModeId = firstString(
    modesBlock.currentModeId,
    modesBlock.current_mode_id,
    source.currentModeId,
    source.current_mode_id,
  ) || availableModes[0]?.id || null;

  return {
    availableModels,
    currentModelId,
    availableModes,
    currentModeId,
    configOptions: normalizeConfigOptions(source.configOptions ?? source.config_options),
  };
}

/**
 * Normalize a top-level Antigravity extension notification. Returns null for
 * any method this client does not consume, so an unknown notification is
 * ignored (never answered).
 */
export function normalizeNotification(method: string, params: unknown) {
  const source = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const payload = source.update && typeof source.update === 'object' ? (source.update as Record<string, unknown>) : source;
  if (method === ACP_EXTENSION_NOTIFICATION.AVAILABLE_COMMANDS_UPDATE) {
    return {
      type: 'available_commands' as const,
      availableCommands: normalizeAvailableCommands(payload.availableCommands ?? payload.available_commands),
    };
  }
  if (method === ACP_EXTENSION_NOTIFICATION.CONFIG_OPTION_UPDATE) {
    return {
      type: 'config_options' as const,
      configOptions: normalizeConfigOptions(payload.configOptions ?? payload.config_options),
    };
  }
  return null;
}
