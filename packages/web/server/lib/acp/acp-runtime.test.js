import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpRuntime } from './acp-runtime.js';
import { AcpProtocolVersionMismatchError } from './acp-protocol.js';

describe('AcpRuntime', () => {
  const runtime = new AcpRuntime();

  afterAll(() => {
    runtime.closeAll();
  });

  it('detects available ACP agents on this system', () => {
    const agents = runtime.getAvailableAgents();
    expect(agents.length).toBeGreaterThan(0);
    const agyAgent = agents.find((a) => a.id === 'antigravity');
    expect(agyAgent).toBeDefined();
    expect(agyAgent.command).toBe('agy');
  });

  it('creates an ACP session and retrieves models', async () => {
    const session = await runtime.createSession({
      agentId: 'antigravity',
      cwd: '/home/jeremy/develop/oc-workspace',
    });

    expect(session.sessionId).toBeDefined();
    expect(session.agentName).toBe('Google Antigravity (AGY)');
    expect(session.availableModels.length).toBeGreaterThan(0);

    // Verify model switching
    const setModelRes = await runtime.setModel(session.sessionId, 'gemini-3.8-flash-medium');
    expect(setModelRes.success).toBe(true);

    runtime.closeSession(session.sessionId);
  });

  it('reaps idle sessions but not busy ones', () => {
    const rt = new AcpRuntime({ idleTtlMs: 1000 });
    const closed = [];
    const mk = (busy, last) => ({ busy, lastUsedAt: last, createdAt: last, conn: { close: () => closed.push(1) } });
    rt.activeSessions.set('idle', mk(false, 1));
    rt.activeSessions.set('busy', mk(true, 1));
    rt.reapIdle(10_000);
    expect(rt.activeSessions.has('idle')).toBe(false);
    expect(rt.activeSessions.has('busy')).toBe(true);
    clearInterval(rt.reaper);
  });

  it('resumes an existing agy conversation through session/load', async () => {
    const runtime = new AcpRuntime();
    if (!runtime.getAvailableAgents().find((a) => a.id === 'antigravity')) return;
    const first = await runtime.createSession({ agentId: 'antigravity', cwd: process.cwd() });
    runtime.closeSession(first.sessionId);
    const resumed = await runtime.createSession({ agentId: 'antigravity', cwd: process.cwd(), resumeSessionId: first.sessionId });
    expect(resumed.sessionId).toBe(first.sessionId);
    runtime.closeSession(resumed.sessionId);
    clearInterval(runtime.reaper);
  });
});

/**
 * A minimal, deterministic ACP agent for handshake/update coverage. It speaks
 * newline-delimited JSON-RPC on stdio exactly like a real agent, so the runtime
 * exercises its real connection path.
 */
const MOCK_AGENT_SCRIPT = `
const fs = require('node:fs');
const readline = require('node:readline');
const capturePath = process.argv[1];
const send = (message) => console.log(JSON.stringify(message));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(msg.params));
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } },
        authMethods: [{ id: 'oauth', name: 'OAuth' }],
        agentInfo: { name: 'Mock ACP', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'session/new' || msg.method === 'session/load') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'sess_mock',
        models: { availableModels: [{ modelId: 'mock-model' }], currentModelId: 'mock-model' },
        modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] },
        configOptions: [{ id: 'model', name: 'Model', currentValue: 'mock-model', type: 'select' }],
      },
    });
    return;
  }
  if (msg.method === 'session/prompt') {
    const update = (payload) => send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'sess_mock', update: payload },
    });
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } });
    update({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Investigate', priority: 'high', status: 'in_progress' },
        { content: 'Fix', priority: 'medium', status: 'pending' },
      ],
    });
    update({ sessionUpdate: 'current_mode_update', currentModeId: 'code' });
    update({ sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', name: 'Model', currentValue: 'mock-model-2', type: 'select' }] });
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'web', description: 'Search' }] });
    update({ sessionUpdate: 'tool_call', toolCall: { toolCallId: 'call_1', name: 'read', rawInput: { path: '/x' } } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' });
    update({ sessionUpdate: 'session_info_update', title: 'Mock Title' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`;

const MOCK_VERSION_2_SCRIPT = `
const readline = require('node:readline');
const send = (message) => console.log(JSON.stringify(message));
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 2, agentInfo: { name: 'Future ACP', version: '9' } } });
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

describe('AcpRuntime protocol conformance', () => {
  const tempDirs = [];
  const runtimes = [];

  const makeRuntime = (agent) => {
    const runtime = new AcpRuntime({ agents: [agent], idleTtlMs: 0 });
    runtimes.push(runtime);
    return runtime;
  };

  const tempFile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-conformance-'));
    tempDirs.push(dir);
    return path.join(dir, 'initialize.json');
  };

  afterAll(() => {
    for (const runtime of runtimes) runtime.closeAll();
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends protocolVersion 1 and honest client capabilities in initialize', async () => {
    const capturePath = tempFile();
    const runtime = makeRuntime(mockAgent(MOCK_AGENT_SCRIPT, [capturePath]));
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    const params = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    expect(params.protocolVersion).toBe(1);
    // Empty means "no fs/*, no terminal/*, no elicitation" — never over-advertise.
    expect(params.clientCapabilities).toEqual({});
    // The pre-spec field name must not be sent.
    expect(params).not.toHaveProperty('capabilities');
    expect(params.clientInfo).toMatchObject({ name: 'openchamber' });

    runtime.closeSession(session.sessionId);
  });

  it('records the agent capabilities and auth methods from initialize', async () => {
    const runtime = makeRuntime(mockAgent(MOCK_AGENT_SCRIPT));
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    expect(session.promptCapabilities).toEqual({ image: true, audio: false, embeddedContext: true });
    expect(session.authMethods).toEqual([{ id: 'oauth', name: 'OAuth' }]);
    expect(runtime.getSession(session.sessionId).availableCommands).toEqual([]);

    runtime.closeSession(session.sessionId);
  });

  it('closes the connection and reports a typed error when the agent picks another version', async () => {
    const runtime = makeRuntime(mockAgent(MOCK_VERSION_2_SCRIPT));
    await expect(runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() }))
      .rejects.toBeInstanceOf(AcpProtocolVersionMismatchError);

    await expect(runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() }))
      .rejects.toMatchObject({ kind: 'protocol-version-mismatch', data: { requested: 1, received: 2 } });
  });

  it('handles every spec session/update variant and stores session state', async () => {
    const runtime = makeRuntime(mockAgent(MOCK_AGENT_SCRIPT));
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    const chunks = [];
    await runtime.prompt(session.sessionId, 'go', (chunk) => chunks.push(chunk));

    const state = runtime.getSession(session.sessionId);
    expect(state.plan).toEqual([
      { content: 'Investigate', priority: 'high', status: 'in_progress' },
      { content: 'Fix', priority: 'medium', status: 'pending' },
    ]);
    expect(state.currentModeId).toBe('code');
    expect(state.configOptions).toEqual([{ id: 'model', name: 'Model', currentValue: 'mock-model-2', type: 'select' }]);
    expect(state.availableCommands).toEqual([{ name: 'web', description: 'Search' }]);

    expect(state.title).toBe('Mock Title');

    const types = chunks.map((chunk) => chunk.type);
    expect(types).toContain('thought');
    expect(types).toContain('tool');
    expect(types).toContain('tool_update');
    expect(types).toContain('text');
    expect(types).toContain('plan');
    expect(types).toContain('mode');
    expect(types).toContain('config_options');
    expect(types).toContain('commands');
    expect(chunks.find((chunk) => chunk.type === 'tool')?.tool).toMatchObject({ toolCallId: 'call_1' });
    expect(chunks.find((chunk) => chunk.type === 'text')?.delta).toBe('done');

    runtime.closeSession(session.sessionId);
  });
});
