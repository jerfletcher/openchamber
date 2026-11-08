/**
 * ACP v1 protocol core shared by the connection, runtime, routes and bridge.
 *
 * Everything in this module is derived from the published Agent Client Protocol
 * v1 specification, so the spec citations live next to the code that depends on
 * them:
 *  - https://agentclientprotocol.com/protocol/v1/initialization  (protocolVersion, capabilities)
 *  - https://agentclientprotocol.com/protocol/v1/error           (JSON-RPC error codes)
 *  - https://agentclientprotocol.com/protocol/v1/prompt-turn     (SessionUpdate variants)
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

function normalizeAvailableCommands(commands) {
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
      return { type: 'config_options', configOptions: Array.isArray(update.configOptions) ? update.configOptions : [] };
    case 'available_commands_update':
      return { type: 'available_commands', availableCommands: normalizeAvailableCommands(update.availableCommands) };
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
