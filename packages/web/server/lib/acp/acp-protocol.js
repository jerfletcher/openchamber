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
const KIND_BY_CODE = Object.freeze({
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
export function isMethodNotFoundError(err) {
  return Boolean(err) && err.code === ACP_ERROR.METHOD_NOT_FOUND;
}

export function acpErrorKind(code) {
  return KIND_BY_CODE[code] || 'unknown';
}

/**
 * Typed error for every protocol-level failure.
 *
 * `code` is the numeric JSON-RPC code when the peer sent one, or a string
 * sentinel for transport-level failures such as a version mismatch.
 */
export class AcpError extends Error {
  constructor({ code, message, data, method, kind } = {}) {
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
  constructor({ requested, received } = {}) {
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

export function isAcpError(err) {
  return err instanceof AcpError || (Boolean(err) && typeof err === 'object' && typeof err.code !== 'undefined' && typeof err.kind === 'string');
}

/** True only for the ACP cancellation code — never for a generic failure. */
export function isAcpCancelledError(err) {
  return Boolean(err) && err.code === ACP_ERROR.REQUEST_CANCELLED;
}

/**
 * HTTP status for an ACP failure surfaced through the REST/SSE routes.
 * Cancellation is 499 (the conventional "client closed request"), which keeps
 * it out of the 5xx family so it is not mistaken for a server fault.
 */
export function httpStatusForAcpError(err) {
  switch (err?.code) {
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
      return err?.kind === ACP_TRANSPORT_ERROR.PROTOCOL_VERSION_MISMATCH ? 502 : 500;
  }
}

/**
 * Machine-readable error body. `error` stays a string so existing clients keep
 * working; the typed detail rides alongside it.
 */
export function serializeAcpError(err) {
  const message = err?.message || 'ACP request failed';
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
export function isConsentOptionKind(kind) {
  return kind === 'allow_once' || kind === 'allow_always';
}

/** True for the reject kinds; used only to label the action, never to auto-answer. */
export function isRejectOptionKind(kind) {
  return kind === 'reject_once' || kind === 'reject_always';
}

export function isPermissionOptionKind(kind) {
  return PERMISSION_OPTION_KINDS.includes(kind);
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
export function normalizePermissionRequest(params) {
  if (!params || typeof params !== 'object') {
    throw new AcpError({
      code: ACP_ERROR.INVALID_PARAMS,
      message: 'session/request_permission requires a params object',
    });
  }
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  if (!sessionId) {
    throw new AcpError({
      code: ACP_ERROR.INVALID_PARAMS,
      message: 'session/request_permission requires a sessionId',
    });
  }

  const rawOptions = Array.isArray(params.options) ? params.options : [];
  const options = [];
  for (const option of rawOptions) {
    if (!option || typeof option !== 'object') continue;
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
    toolCall: params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : {},
    options,
  };
}

/** The `selected` outcome a client returns when the user picks an option. */
export function buildPermissionSelectedOutcome(optionId) {
  return { outcome: { outcome: 'selected', optionId } };
}

/**
 * The `cancelled` outcome. The spec REQUIRES this answer for every pending
 * request when the prompt turn is cancelled, so it is never optional.
 */
export function buildPermissionCancelledOutcome() {
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * Plan entries as an ordered todo list (spec: /protocol/v1/agent-plan).
 * Malformed entries are dropped rather than crashing the turn, and the array
 * order is preserved because the agent's order is the intended reading order.
 */
export function normalizePlanEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const normalized = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (!content) continue;
    normalized.push({
      content,
      priority: PLAN_PRIORITIES.includes(entry.priority) ? entry.priority : 'medium',
      status: PLAN_STATUSES.includes(entry.status) ? entry.status : 'pending',
    });
  }
  return normalized;
}

export function normalizeAvailableCommands(commands) {
  if (!Array.isArray(commands)) return [];
  const normalized = [];
  for (const command of commands) {
    if (!command || typeof command !== 'object') continue;
    const name = typeof command.name === 'string' ? command.name : '';
    if (!name) continue;
    normalized.push({
      name,
      description: typeof command.description === 'string' ? command.description : '',
      ...(command.input && typeof command.input === 'object' ? { input: command.input } : {}),
    });
  }
  return normalized;
}

/**
 * Normalize one config option value list (`configOptions[].options`). Both the
 * spec shape ({ value, name }) and the extension shape ({ id, name }) are
 * accepted; a string entry is its own value and label.
 */
function normalizeConfigOptionValues(values) {
  if (!Array.isArray(values)) return [];
  const normalized = [];
  for (const entry of values) {
    if (typeof entry === 'string') {
      if (!entry) continue;
      normalized.push({ value: entry, name: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
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
export function normalizeConfigOptions(options) {
  if (!Array.isArray(options)) return [];
  const normalized = [];
  for (const option of options) {
    if (!option || typeof option !== 'object') continue;
    const id = firstString(option.id, option.configId, option.config_id);
    if (!id) continue;
    const entry = {
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
export function configOptionValue(configOptions, configId) {
  if (!Array.isArray(configOptions)) return undefined;
  const match = configOptions.find((option) => option && option.id === configId);
  return match ? match.currentValue : undefined;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function chunkText(content) {
  if (!content || typeof content !== 'object') return '';
  return typeof content.text === 'string' ? content.text : '';
}

/**
 * Normalize one `session/update` payload into a typed event.
 *
 * The spec names are authoritative (`agent_thought_chunk`, `tool_call`), but
 * two legacy spellings from earlier integrations (`thought`, `toolCall`) may
 * still arrive from a live agent; both are accepted and normalized to the spec
 * name so no caller has to know which spelling it got.
 */
export function normalizeSessionUpdate(update) {
  if (!update || typeof update !== 'object') return null;
  const name = update.sessionUpdate;

  switch (name) {
    case 'agent_message_chunk':
      return { type: 'text_delta', text: chunkText(update.content) };
    case 'agent_thought_chunk':
      return { type: 'thought_delta', text: chunkText(update.content) };
    case 'thought': // legacy spelling — not a spec name
      return { type: 'thought_delta', text: update.thought || chunkText(update.content) };
    case 'user_message_chunk':
      return { type: 'user_message_chunk', text: chunkText(update.content) };
    case 'tool_call':
    case 'toolCall': // legacy spelling — not a spec name
      return { type: 'tool_call', toolCall: update.toolCall || update.tool || update };
    case 'tool_call_update':
      return { type: 'tool_call_update', update };
    case 'plan':
      return { type: 'plan', entries: normalizePlanEntries(update.entries) };
    case 'current_mode_update':
      return { type: 'current_mode', modeId: typeof update.currentModeId === 'string' ? update.currentModeId : '' };
    case 'config_option_update':
      return {
        type: 'config_options',
        configOptions: normalizeConfigOptions(update.configOptions ?? update.config_options),
      };
    case 'available_commands_update':
      return {
        type: 'available_commands',
        availableCommands: normalizeAvailableCommands(update.availableCommands ?? update.available_commands),
      };
    case 'session_info_update':
      return { type: 'session_info', title: typeof update.title === 'string' ? update.title : null };
    case 'usage_update':
      return { type: 'usage', usage: update.usage && typeof update.usage === 'object' ? update.usage : null };
    default:
      if (name) return { type: 'unknown', sessionUpdate: name };
      // Payloads without a discriminator: only the legacy tool-call shape can be
      // recovered, because its marker field is unambiguous.
      if (update.toolCall) return { type: 'tool_call', toolCall: update.toolCall };
      return { type: 'unknown', sessionUpdate: null };
  }
}

/**
 * Prompt capabilities are what the AGENT advertised in `initialize`
 * (spec: /protocol/v1/initialization#prompt-capabilities). Anything omitted is
 * UNSUPPORTED, so callers must treat a missing object as "text and
 * resource_link only".
 */
export function normalizePromptCapabilities(agentCapabilities) {
  const caps = agentCapabilities?.promptCapabilities;
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
export function normalizeAgentCapabilities(agentCapabilities) {
  const caps = agentCapabilities && typeof agentCapabilities === 'object' ? agentCapabilities : {};
  const sessionCaps = caps.sessionCapabilities ?? caps.session_capabilities ?? {};
  const has = (key) => {
    if (!sessionCaps || typeof sessionCaps !== 'object') return false;
    return Boolean(sessionCaps[key]) || Boolean(sessionCaps[snakeKey(key)]);
  };
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

function snakeKey(key) {
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
function normalizeModelList(list) {
  if (!Array.isArray(list)) return [];
  const normalized = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (!entry) continue;
      normalized.push({ modelId: entry, name: entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const modelId = firstString(entry.modelId, entry.model_id, entry.id, entry.value);
    if (!modelId) continue;
    normalized.push({ modelId, name: firstString(entry.name) || modelId });
  }
  return normalized;
}

/** Modes use `id` in the live response; `modeId`/`value` are accepted too. */
function normalizeModeList(list) {
  if (!Array.isArray(list)) return [];
  const normalized = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (!entry) continue;
      normalized.push({ id: entry, name: entry, description: '' });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
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
 *
 * Probe of the live `agy` binary (1.5.1) returned:
 *   { sessionId,
 *     models: { availableModels: [{ modelId, name }], currentModelId },
 *     modes: { currentModeId, availableModes: [{ id, name, description }] },
 *     configOptions: [{ id, name, category, type, currentValue, options }] }
 * The unknown-key fallbacks (`available_models`, top-level `availableModels`,
 * `config_options`) exist because there is NO official Antigravity ACP spec —
 * only the community README and PR #14 — so both shapes are handled rather than
 * assuming the probe's exact spelling is stable.
 */
export function normalizeSessionConfig(result) {
  const source = result && typeof result === 'object' ? result : {};
  const modelsBlock = source.models && typeof source.models === 'object' ? source.models : {};
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

  const modesBlock = source.modes && typeof source.modes === 'object' ? source.modes : {};
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
export function normalizeNotification(method, params) {
  const source = params && typeof params === 'object' ? params : {};
  const payload = source.update && typeof source.update === 'object' ? source.update : source;
  if (method === ACP_EXTENSION_NOTIFICATION.AVAILABLE_COMMANDS_UPDATE) {
    return {
      type: 'available_commands',
      availableCommands: normalizeAvailableCommands(payload.availableCommands ?? payload.available_commands),
    };
  }
  if (method === ACP_EXTENSION_NOTIFICATION.CONFIG_OPTION_UPDATE) {
    return {
      type: 'config_options',
      configOptions: normalizeConfigOptions(payload.configOptions ?? payload.config_options),
    };
  }
  return null;
}
