import { describe, it, expect } from 'vitest';
import {
  ACP_ERROR,
  ACP_PROTOCOL_VERSION,
  ACP_TRANSPORT_ERROR,
  AcpError,
  AcpProtocolVersionMismatchError,
  acpErrorKind,
  httpStatusForAcpError,
  isAcpCancelledError,
  normalizePromptCapabilities,
  normalizeSessionUpdate,
  serializeAcpError,
} from './acp-protocol.js';

describe('acp-protocol', () => {
  it('advertises protocol version 1', () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1);
  });

  it('names every spec error code', () => {
    // https://agentclientprotocol.com/protocol/v1/error#error-codes
    const expected = {
      [ACP_ERROR.PARSE_ERROR]: 'parse-error',
      [ACP_ERROR.INVALID_REQUEST]: 'invalid-request',
      [ACP_ERROR.METHOD_NOT_FOUND]: 'method-not-found',
      [ACP_ERROR.INVALID_PARAMS]: 'invalid-params',
      [ACP_ERROR.INTERNAL_ERROR]: 'internal-error',
      [ACP_ERROR.REQUEST_CANCELLED]: 'cancelled',
      [ACP_ERROR.AUTHENTICATION_REQUIRED]: 'authentication-required',
      [ACP_ERROR.RESOURCE_NOT_FOUND]: 'resource-not-found',
    };
    for (const [code, kind] of Object.entries(expected)) {
      expect(acpErrorKind(Number(code))).toBe(kind);
    }
  });

  it('treats an unrecognized code as a generic failure that keeps the raw code', () => {
    const err = new AcpError({ code: -31999, message: 'vendor specific', data: { detail: 1 } });
    expect(err.kind).toBe('unknown');
    expect(err.code).toBe(-31999);
    expect(serializeAcpError(err)).toEqual({
      error: 'vendor specific',
      acpError: { code: -31999, kind: 'unknown', message: 'vendor specific', data: { detail: 1 } },
    });
  });

  it('keeps cancellation distinguishable from a generic failure', () => {
    const cancelled = new AcpError({ code: ACP_ERROR.REQUEST_CANCELLED, message: 'Request cancelled' });
    const failed = new AcpError({ code: ACP_ERROR.INTERNAL_ERROR, message: 'boom' });
    expect(isAcpCancelledError(cancelled)).toBe(true);
    expect(isAcpCancelledError(failed)).toBe(false);
    expect(isAcpCancelledError(new Error('plain error'))).toBe(false);
    expect(httpStatusForAcpError(cancelled)).toBe(499);
    expect(httpStatusForAcpError(failed)).toBe(500);
  });

  it('maps each spec code to a meaningful HTTP status', () => {
    expect(httpStatusForAcpError(new AcpError({ code: ACP_ERROR.PARSE_ERROR }))).toBe(400);
    expect(httpStatusForAcpError(new AcpError({ code: ACP_ERROR.INVALID_REQUEST }))).toBe(400);
    expect(httpStatusForAcpError(new AcpError({ code: ACP_ERROR.INVALID_PARAMS }))).toBe(400);
    expect(httpStatusForAcpError(new AcpError({ code: ACP_ERROR.METHOD_NOT_FOUND }))).toBe(501);
    expect(httpStatusForAcpError(new AcpError({ code: ACP_ERROR.AUTHENTICATION_REQUIRED }))).toBe(401);
    expect(httpStatusForAcpError(new AcpError({ code: ACP_ERROR.RESOURCE_NOT_FOUND }))).toBe(404);
  });

  it('reports a protocol version mismatch as a typed transport failure', () => {
    const err = new AcpProtocolVersionMismatchError({ requested: 1, received: 2 });
    expect(err).toBeInstanceOf(AcpError);
    expect(err.kind).toBe(ACP_TRANSPORT_ERROR.PROTOCOL_VERSION_MISMATCH);
    expect(err.message).toContain('protocol version 1');
    expect(err.message).toContain('answered 2');
    expect(httpStatusForAcpError(err)).toBe(502);

    const missing = new AcpProtocolVersionMismatchError({ requested: 1, received: undefined });
    expect(missing.message).toContain('answered missing');
  });

  describe('session/update variants', () => {
    it('normalizes agent_message_chunk', () => {
      expect(normalizeSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }))
        .toEqual({ type: 'text_delta', text: 'hi' });
    });

    it('normalizes agent_thought_chunk', () => {
      expect(normalizeSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } }))
        .toEqual({ type: 'thought_delta', text: 'think' });
    });

    it('normalizes user_message_chunk', () => {
      expect(normalizeSessionUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'mine' } }))
        .toEqual({ type: 'user_message_chunk', text: 'mine' });
    });

    it('accepts the legacy thought spelling and still emits the spec shape', () => {
      expect(normalizeSessionUpdate({ sessionUpdate: 'thought', thought: 'legacy' }))
        .toEqual({ type: 'thought_delta', text: 'legacy' });
    });

    it('normalizes tool_call and the legacy toolCall spelling', () => {
      const call = { toolCallId: 'call_1', title: 'Read', kind: 'read' };
      expect(normalizeSessionUpdate({ sessionUpdate: 'tool_call', toolCall: call }))
        .toEqual({ type: 'tool_call', toolCall: call });
      expect(normalizeSessionUpdate({ sessionUpdate: 'toolCall', toolCall: call }))
        .toEqual({ type: 'tool_call', toolCall: call });
      expect(normalizeSessionUpdate({ toolCall: call })).toEqual({ type: 'tool_call', toolCall: call });
    });

    it('normalizes tool_call_update', () => {
      const update = { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' };
      expect(normalizeSessionUpdate(update)).toEqual({ type: 'tool_call_update', update });
    });

    it('normalizes plan into ordered todo entries', () => {
      const normalized = normalizeSessionUpdate({
        sessionUpdate: 'plan',
        entries: [
          { content: 'First', priority: 'high', status: 'completed' },
          { content: 'Second', priority: 'nonsense', status: 'nonsense' },
          { priority: 'low' }, // missing content -> dropped
        ],
      });
      expect(normalized).toEqual({
        type: 'plan',
        entries: [
          { content: 'First', priority: 'high', status: 'completed' },
          { content: 'Second', priority: 'medium', status: 'pending' },
        ],
      });
    });

    it('normalizes current_mode_update', () => {
      expect(normalizeSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'code' }))
        .toEqual({ type: 'current_mode', modeId: 'code' });
    });

    it('normalizes config_option_update', () => {
      const configOptions = [{ id: 'model', name: 'Model', type: 'select', currentValue: 'a' }];
      expect(normalizeSessionUpdate({ sessionUpdate: 'config_option_update', configOptions }))
        .toEqual({ type: 'config_options', configOptions });
    });

    it('normalizes available_commands_update', () => {
      const availableCommands = [{ name: 'web', description: 'Search' }, { description: 'no name' }];
      expect(normalizeSessionUpdate({ sessionUpdate: 'available_commands_update', availableCommands }))
        .toEqual({ type: 'available_commands', availableCommands: [{ name: 'web', description: 'Search' }] });
    });

    it('normalizes session_info_update and ignores a non-string title', () => {
      expect(normalizeSessionUpdate({ sessionUpdate: 'session_info_update', title: 'Renamed' }))
        .toEqual({ type: 'session_info', title: 'Renamed' });
      expect(normalizeSessionUpdate({ sessionUpdate: 'session_info_update', title: 42 }))
        .toEqual({ type: 'session_info', title: null });
    });

    it('keeps an unknown variant instead of dropping it silently', () => {
      expect(normalizeSessionUpdate({ sessionUpdate: 'brand_new_variant', x: 1 }))
        .toEqual({ type: 'unknown', sessionUpdate: 'brand_new_variant' });
      expect(normalizeSessionUpdate(null)).toBeNull();
    });
  });

  it('reads prompt capabilities with the spec default of unsupported', () => {
    expect(normalizePromptCapabilities(undefined)).toEqual({ image: false, audio: false, embeddedContext: false });
    expect(normalizePromptCapabilities({})).toEqual({ image: false, audio: false, embeddedContext: false });
    expect(normalizePromptCapabilities({
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
    })).toEqual({ image: true, audio: false, embeddedContext: true });
  });
});
