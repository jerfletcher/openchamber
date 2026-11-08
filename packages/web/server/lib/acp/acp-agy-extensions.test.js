import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpRuntime } from './acp-runtime.js';

/**
 * A deterministic stand-in for the Antigravity ACP server. Every client line is
 * appended to `capturePath`, so assertions are on the actual wire traffic (which
 * methods were sent, with which params, and whether a notification was wrongly
 * answered) rather than on our own bookkeeping.
 */
const MOCK_EXT_AGENT_SCRIPT = `
const fs = require('node:fs');
const readline = require('node:readline');
const capturePath = process.argv[1];
const scenario = process.argv[2] || 'full';
const send = (message) => console.log(JSON.stringify(message));
const rl = readline.createInterface({ input: process.stdin });
const record = (message) => { if (capturePath) fs.appendFileSync(capturePath, JSON.stringify(message) + '\\n'); };

const capabilities = scenario === 'gated'
  ? { promptCapabilities: { image: false }, sessionCapabilities: { resume: {} } }
  : {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { load: {}, resume: {}, close: {}, list: {}, delete: {} },
    };

const configFor = (params) => ([
  { id: 'model', name: 'Model', category: 'model', type: 'select',
    currentValue: params && params.configId === 'model' ? params.value : 'ext-model',
    options: [{ value: 'ext-model', name: 'Ext Model' }, { value: 'alt-model', name: 'Alt Model' }] },
  { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select',
    currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select',
    currentValue: params && params.configId === 'mode' ? params.value : 'default',
    options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }] },
]);

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  record(msg);

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: 1,
      agentCapabilities: capabilities,
      agentInfo: { name: 'Ext Mock', version: '1.0.0' },
    } });
    return;
  }

  if (msg.method === 'session/new' || msg.method === 'session/load' || msg.method === 'session/resume') {
    const sessionId = scenario === 'snake' ? 'sess_snake' : 'sess_ext';
    // Replay emitted BEFORE the response: proves the runtime subscribes first.
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId,
      update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'replay', description: 'replayed command' }] },
    } });
    if (scenario === 'snake') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        sessionId,
        available_models: [{ id: 'snake-model', name: 'Snake Model' }],
        current_model_id: 'snake-model',
        available_modes: [{ id: 'snake-mode', name: 'Snake Mode' }],
        current_mode_id: 'snake-mode',
        config_options: [{ configId: 'model', name: 'Model', type: 'select', current_value: 'snake-model', options: [{ id: 'snake-model', name: 'Snake' }] }],
      } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: {
      sessionId,
      models: { availableModels: [{ modelId: 'ext-model', name: 'Ext Model' }], currentModelId: 'ext-model' },
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default', description: 'ask' }] },
      configOptions: configFor(null),
    } });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    if (scenario === 'legacy-only') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: session/set_config_option' } });
      return;
    }
    if (scenario === 'invalid-value') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid value' } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: configFor(msg.params) } });
    return;
  }

  if (msg.method === 'session/set_model' || msg.method === 'session/set_mode') {
    if (scenario === 'no-legacy') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessions: [{ sessionId: 'sess_remote', title: 'Remote' }] } });
    return;
  }

  if (msg.method === 'session/close' || msg.method === 'session/delete') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/prompt') {
    // Standalone extension notifications: no id means they must never be answered.
    send({ jsonrpc: '2.0', method: 'session/available_commands_update', params: {
      sessionId: 'sess_ext', availableCommands: [{ name: 'top', description: 'top level' }],
    } });
    send({ jsonrpc: '2.0', method: 'session/config_option_update', params: {
      sessionId: 'sess_ext', configOptions: configFor({ configId: 'model', value: 'top-model' }),
    } });
    send({ jsonrpc: '2.0', method: 'session/unknown_update', params: { sessionId: 'sess_ext', weird: true } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    return;
  }
});
`;

function mockAgent(script, args = []) {
  return {
    id: 'mock-acp',
    providerId: 'mock-acp',
    name: 'Mock ACP',
    command: process.execPath,
    args: ['-e', script, ...args],
    models: [],
  };
}

const tempDirs = [];
const runtimes = [];

const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-agy-ext-'));
  tempDirs.push(dir);
  return dir;
};

const makeRuntime = ({ scenario = 'full' } = {}) => {
  const capturePath = path.join(tempDir(), 'calls.jsonl');
  const runtime = new AcpRuntime({ agents: [mockAgent(MOCK_EXT_AGENT_SCRIPT, [capturePath, scenario])], idleTtlMs: 0 });
  runtimes.push(runtime);
  return { runtime, capturePath };
};

const readCalls = (capturePath) => {
  if (!fs.existsSync(capturePath)) return [];
  return fs.readFileSync(capturePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const methodsSent = (capturePath) => readCalls(capturePath)
  .map((message) => message.method)
  .filter(Boolean);

const waitFor = async (predicate, timeoutMs = 5000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the expected ACP traffic');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

afterAll(() => {
  for (const runtime of runtimes) runtime.closeAll();
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Antigravity session/new parsing', () => {
  it('normalizes models, modes, and config options from the live camelCase shape', async () => {
    const { runtime } = makeRuntime();
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    expect(session.availableModels).toEqual([{ modelId: 'ext-model', name: 'Ext Model' }]);
    expect(session.currentModelId).toBe('ext-model');
    expect(session.availableModes).toEqual([{ id: 'default', name: 'Default', description: 'ask' }]);
    expect(session.currentModeId).toBe('default');
    expect(session.configOptions.map((option) => option.id)).toEqual(['model', 'thought_level', 'mode']);

    runtime.closeSession(session.sessionId);
  });

  it('accepts snake_case and top-level spellings instead of silently dropping them', async () => {
    const { runtime } = makeRuntime({ scenario: 'snake' });
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    expect(session.availableModels).toEqual([{ modelId: 'snake-model', name: 'Snake Model' }]);
    expect(session.currentModelId).toBe('snake-model');
    expect(session.availableModes).toEqual([{ id: 'snake-mode', name: 'Snake Mode', description: '' }]);
    expect(session.currentModeId).toBe('snake-mode');
    expect(session.configOptions).toHaveLength(1);
    expect(session.configOptions[0]).toMatchObject({ id: 'model', currentValue: 'snake-model' });
    expect(session.configOptions[0].options).toEqual([{ value: 'snake-model', name: 'Snake' }]);

    runtime.closeSession(session.sessionId);
  });

  it('captures the replay sent before session/new resolves', async () => {
    const { runtime } = makeRuntime();
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    // The mock emits available_commands_update BEFORE the session/new response.
    expect(session.availableCommands).toEqual([{ name: 'replay', description: 'replayed command' }]);

    runtime.closeSession(session.sessionId);
  });
});

describe('session/set_config_option and legacy aliases', () => {
  it('setModel sends session/set_config_option as the primary call', async () => {
    const { runtime, capturePath } = makeRuntime();
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    const result = await runtime.setModel(session.sessionId, 'alt-model');
    expect(result).toMatchObject({ success: true, modelId: 'alt-model', method: 'session/set_config_option' });

    const call = readCalls(capturePath).find((message) => message.method === 'session/set_config_option');
    expect(call.params).toEqual({ sessionId: 'sess_ext', configId: 'model', value: 'alt-model' });
    expect(methodsSent(capturePath)).not.toContain('session/set_model');

    runtime.closeSession(session.sessionId);
  });

  it('setMode sends session/set_config_option with configId "mode"', async () => {
    const { runtime, capturePath } = makeRuntime();
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    const result = await runtime.setMode(session.sessionId, 'plan');
    expect(result).toMatchObject({ success: true, modeId: 'plan', method: 'session/set_config_option' });

    const call = readCalls(capturePath).find((message) => message.method === 'session/set_config_option');
    expect(call.params).toEqual({ sessionId: 'sess_ext', configId: 'mode', value: 'plan' });
    expect(methodsSent(capturePath)).not.toContain('session/set_mode');

    runtime.closeSession(session.sessionId);
  });

  it('falls back to session/set_model only on -32601', async () => {
    const { runtime, capturePath } = makeRuntime({ scenario: 'legacy-only' });
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    const result = await runtime.setModel(session.sessionId, 'alt-model');
    expect(result.method).toBe('session/set_model');

    const sent = methodsSent(capturePath);
    expect(sent).toContain('session/set_config_option');
    expect(sent).toContain('session/set_model');

    runtime.closeSession(session.sessionId);
  });

  it('falls back to session/set_mode only on -32601', async () => {
    const { runtime, capturePath } = makeRuntime({ scenario: 'legacy-only' });
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    const result = await runtime.setMode(session.sessionId, 'plan');
    expect(result.method).toBe('session/set_mode');
    expect(methodsSent(capturePath)).toContain('session/set_mode');

    runtime.closeSession(session.sessionId);
  });

  it('legacy-first path falls back to session/set_config_option on -32601', async () => {
    const { runtime, capturePath } = makeRuntime({ scenario: 'no-legacy' });
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    const modelResult = await runtime.setModelLegacy(session.sessionId, 'alt-model');
    expect(modelResult.method).toBe('session/set_config_option');

    const modeResult = await runtime.setModeLegacy(session.sessionId, 'plan');
    expect(modeResult.method).toBe('session/set_config_option');

    const sent = methodsSent(capturePath);
    expect(sent).toContain('session/set_model');
    expect(sent).toContain('session/set_mode');

    runtime.closeSession(session.sessionId);
  });

  it('does not retry a mutation the agent rejected with any other error', async () => {
    const { runtime, capturePath } = makeRuntime({ scenario: 'invalid-value' });
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    await expect(runtime.setModel(session.sessionId, 'nope')).rejects.toMatchObject({ code: -32602 });
    // The alias must not have been attempted: retrying could apply a change the
    // agent refused.
    expect(methodsSent(capturePath)).not.toContain('session/set_model');

    runtime.closeSession(session.sessionId);
  });

  it('reflects the returned configOptions and current mode on the session', async () => {
    const { runtime } = makeRuntime();
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    await runtime.setMode(session.sessionId, 'plan');
    const state = runtime.getSession(session.sessionId);
    expect(state.currentModeId).toBe('plan');
    expect(state.configOptions.find((option) => option.id === 'mode').currentValue).toBe('plan');

    runtime.closeSession(session.sessionId);
  });
});

describe('Antigravity capability gating', () => {
  it('never sends unadvertised session/list, session/close, or session/delete', async () => {
    const { runtime, capturePath } = makeRuntime({ scenario: 'gated' });
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    expect(session.capabilities).toMatchObject({ loadSession: false, resume: true, close: false, list: false, delete: false });

    const list = await runtime.listRemoteSessions(session.sessionId);
    expect(list).toEqual({ supported: false, sessions: [] });

    const deleted = await runtime.deleteSession(session.sessionId);
    expect(deleted.remoteDelete).toBe(false);

    const sent = methodsSent(capturePath);
    expect(sent).not.toContain('session/list');
    expect(sent).not.toContain('session/delete');
    expect(sent).not.toContain('session/close');
  });

  it('resumes through session/resume when session/load is unadvertised', async () => {
    const { runtime, capturePath } = makeRuntime({ scenario: 'gated' });
    const session = await runtime.createSession({
      agentId: 'mock-acp',
      cwd: process.cwd(),
      resumeSessionId: 'sess_previous',
    });

    const sent = methodsSent(capturePath);
    expect(sent).toContain('session/resume');
    expect(sent).not.toContain('session/load');

    runtime.closeSession(session.sessionId);
  });

  it('calls session/list, session/close, and session/delete when advertised', async () => {
    const { runtime, capturePath } = makeRuntime();
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    const list = await runtime.listRemoteSessions(session.sessionId);
    expect(list).toEqual({ supported: true, sessions: [{ sessionId: 'sess_remote', title: 'Remote' }] });

    const deleted = await runtime.deleteSession(session.sessionId);
    expect(deleted.remoteDelete).toBe(true);

    const sent = methodsSent(capturePath);
    expect(sent).toContain('session/list');
    expect(sent).toContain('session/delete');
    await waitFor(() => methodsSent(capturePath).includes('session/close'));
    expect(methodsSent(capturePath)).toContain('session/close');
  });
});

describe('Antigravity extension notifications', () => {
  it('applies standalone available_commands_update and config_option_update and never answers them', async () => {
    const { runtime, capturePath } = makeRuntime();
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    await runtime.prompt(session.sessionId, 'go');
    const state = runtime.getSession(session.sessionId);

    expect(state.availableCommands).toEqual([{ name: 'top', description: 'top level' }]);
    expect(state.configOptions.find((option) => option.id === 'model').currentValue).toBe('top-model');

    // Every line the client wrote must be a request (has a method). A response
    // to an id-less notification would appear as a line with result/error and no
    // method, which the JSON-RPC spec forbids.
    for (const message of readCalls(capturePath)) {
      expect(typeof message.method).toBe('string');
    }

    runtime.closeSession(session.sessionId);
  });
});
