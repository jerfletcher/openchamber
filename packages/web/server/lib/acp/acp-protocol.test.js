import { describe, it, expect } from 'vitest';
import {
  ACP_ERROR,
  ACP_EXTENSION_NOTIFICATION,
  ACP_PROTOCOL_VERSION,
  ACP_TRANSPORT_ERROR,
  AcpError,
  AcpProtocolVersionMismatchError,
  acpErrorKind,
  buildPermissionCancelledOutcome,
  buildPermissionSelectedOutcome,
  configOptionValue,
  httpStatusForAcpError,
  isAcpCancelledError,
  isConsentOptionKind,
  isMethodNotFoundError,
  isPermissionOptionKind,
  normalizeAgentCapabilities,
  normalizeConfigOptions,
  normalizeNotification,
  normalizePermissionRequest,
  normalizePromptCapabilities,
  normalizeSessionConfig,
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

  describe('session/request_permission (spec: /protocol/v1/tool-calls)', () => {
    const params = {
      sessionId: 'sess_1',
      toolCall: { toolCallId: 'call_1', title: 'Run tests', kind: 'execute', rawInput: { command: 'bun test' } },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
      ],
    };

    it('normalizes the request and marks only the allow kinds as consent', () => {
      const normalized = normalizePermissionRequest(params);
      expect(normalized.sessionId).toBe('sess_1');
      expect(normalized.toolCall).toEqual(params.toolCall);
      expect(normalized.options.map((option) => option.consent)).toEqual([true, true, false, false]);
      expect(normalized.options.map((option) => option.kind)).toEqual([
        'allow_once', 'allow_always', 'reject_once', 'reject_always',
      ]);
    });

    it('never treats an unrecognized kind as consent', () => {
      const normalized = normalizePermissionRequest({
        sessionId: 'sess_1',
        options: [
          { optionId: 'maybe', name: 'Maybe', kind: 'allow_sometimes' },
          { optionId: 'missing-kind', name: 'No kind' },
        ],
      });
      expect(normalized.options).toEqual([
        { optionId: 'maybe', name: 'Maybe', kind: 'allow_sometimes', consent: false },
        { optionId: 'missing-kind', name: 'No kind', kind: 'unknown', consent: false },
      ]);
      expect(isConsentOptionKind('allow_sometimes')).toBe(false);
      expect(isConsentOptionKind(undefined)).toBe(false);
      expect(isConsentOptionKind('allow_once')).toBe(true);
      expect(isPermissionOptionKind('reject_always')).toBe(true);
      expect(isPermissionOptionKind('allow_sometimes')).toBe(false);
    });

    it('drops an option that cannot be selected instead of inventing an id', () => {
      const normalized = normalizePermissionRequest({
        sessionId: 'sess_1',
        options: [{ name: 'No id', kind: 'allow_once' }, null, 'nonsense'],
      });
      expect(normalized.options).toEqual([]);
    });

    it('rejects params without a session id', () => {
      expect(() => normalizePermissionRequest({ options: [] })).toThrow(AcpError);
      expect(() => normalizePermissionRequest(null)).toThrow(AcpError);
      try {
        normalizePermissionRequest({ options: [] });
      } catch (err) {
        expect(err.code).toBe(ACP_ERROR.INVALID_PARAMS);
      }
    });

    it('builds the exact outcome shapes the spec shows', () => {
      expect(buildPermissionSelectedOutcome('allow-once'))
        .toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
      expect(buildPermissionCancelledOutcome()).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });
});

describe('Antigravity extension normalizers', () => {
  // Shape copied from a live `agy acp --stdio` (1.5.1) session/new response.
  const LIVE_SESSION = {
    sessionId: 'sess_live',
    models: {
      availableModels: [
        { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
        { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
      ],
      currentModelId: 'gemini-4-argon-medium',
    },
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default', description: 'Ask before edits' },
        { id: 'plan', name: 'Plan' },
      ],
    },
    configOptions: [
      {
        id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-argon',
        options: [{ value: 'gemini-4-argon', name: 'Gemini 4 Argon' }, { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
      },
      { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: 'medium', options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })) },
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] },
    ],
  };

  it('parses the live session/new shape', () => {
    const config = normalizeSessionConfig(LIVE_SESSION);
    expect(config.availableModels).toEqual([
      { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
      { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
    ]);
    expect(config.currentModelId).toBe('gemini-4-argon-medium');
    expect(config.availableModes).toEqual([
      { id: 'default', name: 'Default', description: 'Ask before edits' },
      { id: 'plan', name: 'Plan', description: '' },
    ]);
    expect(config.currentModeId).toBe('default');
    expect(config.configOptions).toHaveLength(3);
    expect(configOptionValue(config.configOptions, 'model')).toBe('gemini-4-argon');
    expect(config.configOptions[0].options).toHaveLength(2);
  });

  it('accepts snake_case and top-level alternative keys', () => {
    const config = normalizeSessionConfig({
      sessionId: 'sess_alt',
      available_models: [{ id: 'alt-model' }],
      current_model_id: 'alt-model',
      available_modes: [{ id: 'alt-mode' }],
      current_mode_id: 'alt-mode',
      config_options: [{ configId: 'model', name: 'Model', type: 'select', current_value: 'alt-model', options: [{ id: 'alt-model' }] }],
    });
    expect(config.availableModels).toEqual([{ modelId: 'alt-model', name: 'alt-model' }]);
    expect(config.currentModelId).toBe('alt-model');
    expect(config.availableModes).toEqual([{ id: 'alt-mode', name: 'alt-mode', description: '' }]);
    expect(config.currentModeId).toBe('alt-mode');
    expect(config.configOptions).toEqual([{
      id: 'model', name: 'Model', type: 'select', currentValue: 'alt-model',
      options: [{ value: 'alt-model', name: 'alt-model' }],
    }]);
  });

  it('returns an empty config for a malformed or missing result', () => {
    expect(normalizeSessionConfig(null)).toEqual({
      availableModels: [], currentModelId: '', availableModes: [], currentModeId: null, configOptions: [],
    });
  });

  it('reads capabilities from both camelCase and snake_case, defaulting to unsupported', () => {
    expect(normalizeAgentCapabilities({
      loadSession: true,
      promptCapabilities: { image: true },
      sessionCapabilities: { resume: {}, close: {}, list: {}, additionalDirectories: {} },
    })).toMatchObject({
      loadSession: true, resume: true, close: true, list: true, delete: false, additionalDirectories: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
    });

    expect(normalizeAgentCapabilities({
      session_capabilities: { load: {}, resume: {}, additional_directories: {} },
    })).toMatchObject({ loadSession: true, resume: true, close: false, list: false, delete: false, additionalDirectories: true });

    expect(normalizeAgentCapabilities(undefined)).toMatchObject({
      loadSession: false, resume: false, close: false, list: false, delete: false,
    });
  });

  it('drops config options without an id instead of inventing one', () => {
    expect(normalizeConfigOptions([])).toEqual([]);
    expect(normalizeConfigOptions([{ name: 'No id' }, null, 'nonsense'])).toEqual([]);
  });

  it('recognizes only -32601 as method-not-found', () => {
    expect(isMethodNotFoundError({ code: ACP_ERROR.METHOD_NOT_FOUND })).toBe(true);
    expect(isMethodNotFoundError({ code: ACP_ERROR.INVALID_PARAMS })).toBe(false);
    expect(isMethodNotFoundError(new Error('timeout'))).toBe(false);
    expect(isMethodNotFoundError(undefined)).toBe(false);
  });

  it('dispatches the two extension notifications and ignores everything else', () => {
    expect(normalizeNotification(ACP_EXTENSION_NOTIFICATION.AVAILABLE_COMMANDS_UPDATE, {
      availableCommands: [{ name: 'top' }],
    })).toEqual({ type: 'available_commands', availableCommands: [{ name: 'top', description: '' }] });

    expect(normalizeNotification(ACP_EXTENSION_NOTIFICATION.CONFIG_OPTION_UPDATE, {
      update: { configOptions: [{ id: 'model', currentValue: 'x' }] },
    })).toEqual({
      type: 'config_options',
      configOptions: [{ id: 'model', name: 'model', type: 'select', currentValue: 'x' }],
    });

    expect(normalizeNotification('session/unknown_update', {})).toBeNull();
    expect(normalizeNotification('session/prompt', {})).toBeNull();
  });

  it('normalizes config_option_update and available_commands_update inside session/update', () => {
    expect(normalizeSessionUpdate({
      sessionUpdate: 'config_option_update',
      config_options: [{ id: 'mode', current_value: 'plan' }],
    })).toEqual({
      type: 'config_options',
      configOptions: [{ id: 'mode', name: 'mode', type: 'select', currentValue: 'plan' }],
    });

    expect(normalizeSessionUpdate({
      sessionUpdate: 'available_commands_update',
      available_commands: [{ name: 'goal', description: 'Run until done' }],
    })).toEqual({
      type: 'available_commands',
      availableCommands: [{ name: 'goal', description: 'Run until done' }],
    });
  });
});
