import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpRuntime, DEFAULT_ACP_AGENTS, buildAgentArgs } from './acp-runtime.js';
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

/**
 * An agent that asks for permission mid-turn and reports the client's answer
 * back through a file, so the assertion is on the exact JSON-RPC response the
 * agent received (same id, selected vs cancelled) and not on our own objects.
 */
const PERMISSION_AGENT_SCRIPT = `
const fs = require('node:fs');
const readline = require('node:readline');
const capturePath = process.argv[1];
const send = (message) => console.log(JSON.stringify(message));
const rl = readline.createInterface({ input: process.stdin });
let promptId = null;
let permissionId = null;
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'Permission ACP', version: '1' } } });
    return;
  }
  if (msg.method === 'session/new' || msg.method === 'session/load') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_perm' } });
    return;
  }
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    permissionId = 100;
    send({
      jsonrpc: '2.0',
      id: permissionId,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess_perm',
        toolCall: { toolCallId: 'call_1', title: 'Run the tests', kind: 'execute', rawInput: { command: 'bun test' } },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
          { optionId: 'maybe', name: 'Maybe', kind: 'allow_sometimes' },
        ],
      },
    });
    return;
  }
  // The client's answer to our request: same id, no method.
  if (permissionId !== null && msg.id === permissionId && msg.method === undefined) {
    if (capturePath) fs.writeFileSync(capturePath, JSON.stringify(msg));
    const cancelled = msg.result && msg.result.outcome && msg.result.outcome.outcome === 'cancelled';
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } });
    promptId = null;
    permissionId = null;
  }
});
`;

describe('AcpRuntime permission requests', () => {
  const tempDirs = [];
  const runtimes = [];

  const makeRuntime = (agent) => {
    const runtime = new AcpRuntime({ agents: [agent], idleTtlMs: 0 });
    runtimes.push(runtime);
    return runtime;
  };
  const tempFile = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-permission-'));
    tempDirs.push(dir);
    return path.join(dir, 'permission-reply.json');
  };
  const waitFor = async (predicate, timeoutMs = 5000) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the permission request');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const readReply = async (capturePath) => {
    await waitFor(() => fs.existsSync(capturePath));
    return JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  };

  afterAll(() => {
    for (const runtime of runtimes) runtime.closeAll();
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dispatches the request and returns the selected option with the agent\'s own id', async () => {
    const capturePath = tempFile();
    const runtime = makeRuntime(mockAgent(PERMISSION_AGENT_SCRIPT, [capturePath]));
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });
    const requests = [];
    runtime.on('permission_request', (request) => requests.push(request));

    const turn = runtime.prompt(session.sessionId, 'go');
    await waitFor(() => requests.length === 1);
    expect(requests[0].sessionId).toBe('sess_perm');
    expect(requests[0].toolCall).toMatchObject({ toolCallId: 'call_1', title: 'Run the tests' });
    expect(requests[0].options).toHaveLength(5);
    expect(requests[0].options.find((option) => option.optionId === 'maybe').consent).toBe(false);
    expect(runtime.getPendingPermissions(session.sessionId)).toHaveLength(1);

    runtime.respondToPermission(session.sessionId, requests[0].requestId, 'allow-once');

    const reply = await readReply(capturePath);
    expect(reply.id).toBe(100);
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    expect(runtime.getPendingPermissions(session.sessionId)).toEqual([]);
    await turn;

    runtime.closeSession(session.sessionId);
  });

  it('answers every pending request with cancelled when the turn is cancelled', async () => {
    const capturePath = tempFile();
    const runtime = makeRuntime(mockAgent(PERMISSION_AGENT_SCRIPT, [capturePath]));
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });
    const settled = [];
    runtime.on('permission_settled', (event) => settled.push(event));

    const turn = runtime.prompt(session.sessionId, 'go');
    await waitFor(() => runtime.getPendingPermissions(session.sessionId).length === 1);

    await runtime.cancel(session.sessionId);

    const reply = await readReply(capturePath);
    expect(reply.result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(settled).toHaveLength(1);
    expect(settled[0].outcome).toEqual({ outcome: { outcome: 'cancelled' } });
    await turn;

    runtime.closeSession(session.sessionId);
  });

  it('cancels pending requests when the session closes', async () => {
    const capturePath = tempFile();
    const runtime = makeRuntime(mockAgent(PERMISSION_AGENT_SCRIPT, [capturePath]));
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    void runtime.prompt(session.sessionId, 'go').catch(() => undefined);
    await waitFor(() => runtime.getPendingPermissions(session.sessionId).length === 1);

    runtime.closeSession(session.sessionId);

    const reply = await readReply(capturePath);
    expect(reply.result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('refuses a reply to a stale request id and an option the agent never offered', async () => {
    const capturePath = tempFile();
    const runtime = makeRuntime(mockAgent(PERMISSION_AGENT_SCRIPT, [capturePath]));
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    const turn = runtime.prompt(session.sessionId, 'go');
    await waitFor(() => runtime.getPendingPermissions(session.sessionId).length === 1);
    const requestId = runtime.getPendingPermissions(session.sessionId)[0].requestId;

    expect(() => runtime.respondToPermission(session.sessionId, 'perm_999', 'allow-once'))
      .toThrow(/not pending/);
    try {
      runtime.respondToPermission(session.sessionId, requestId, 'not-an-option');
    } catch (err) {
      expect(err.code).toBe(-32602);
    }
    // Neither attempt answered the agent: the prompt is still open.
    expect(runtime.getPendingPermissions(session.sessionId)).toHaveLength(1);

    runtime.respondToPermission(session.sessionId, requestId, 'reject-once');
    const reply = await readReply(capturePath);
    expect(reply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    await turn;

    runtime.closeSession(session.sessionId);
  });

  it('never approves on its own, even when an option kind is unrecognized', async () => {
    const capturePath = tempFile();
    const runtime = makeRuntime(mockAgent(PERMISSION_AGENT_SCRIPT, [capturePath]));
    const session = await runtime.createSession({ agentId: 'mock-acp', cwd: process.cwd() });

    const turn = runtime.prompt(session.sessionId, 'go');
    await waitFor(() => runtime.getPendingPermissions(session.sessionId).length === 1);
    // No timer, no default: nothing has been sent to the agent yet.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fs.existsSync(capturePath)).toBe(false);

    runtime.cancelPendingPermissions(session.sessionId);
    const reply = await readReply(capturePath);
    expect(reply.result).toEqual({ outcome: { outcome: 'cancelled' } });
    await turn;

    runtime.closeSession(session.sessionId);
  });
});

describe('AcpRuntime launch arguments', () => {
  it('launches the agent WITHOUT the skip-permissions flag by default', () => {
    const antigravity = DEFAULT_ACP_AGENTS.find((agent) => agent.id === 'antigravity');
    expect(antigravity.skipPermissions).toBe(false);
    expect(buildAgentArgs(antigravity)).toEqual(['acp', '--stdio']);
    expect(buildAgentArgs(antigravity)).not.toContain('--dangerously-skip-permissions');
  });

  it('appends the flag only when that agent opted in, and strips it when it did not', () => {
    expect(buildAgentArgs({ args: ['acp'], skipPermissions: true }))
      .toEqual(['acp', '--dangerously-skip-permissions']);
    // A config that still carries the flag but not the setting must not bypass the prompt.
    expect(buildAgentArgs({ args: ['acp', '--stdio', '--dangerously-skip-permissions'], skipPermissions: false }))
      .toEqual(['acp', '--stdio']);
  });
});
