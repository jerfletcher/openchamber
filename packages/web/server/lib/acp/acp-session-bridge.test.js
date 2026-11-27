import { describe, it, expect, beforeEach } from 'bun:test';
import { AcpSessionBridge, buildPromptBlocks, buildPromptPayload } from './acp-session-bridge.js';
import EventEmitter from 'events';

class MockRuntime extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.createCallCount = 0;
  }
  async createSession({ agentId, cwd, resumeSessionId }) {
    this.createCallCount++;
    this.lastAgentId = agentId;
    this.lastResume = resumeSessionId;
    this.models = [];
    const id = `mock_acp_${Math.random().toString(36).slice(2, 6)}`;
    this.sessions.set(id, { agentId, cwd });
    return { sessionId: id, agentId };
  }
  isSessionAlive(sessionId) {
    return this.sessions.has(sessionId);
  }
  getSession(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? { sessionId, ...s } : null;
  }
  async cancel(sessionId) {}
  async setModel(sessionId, modelId) {
    (this.models ||= []).push(modelId);
    return { sessionId, modelId };
  }
  async prompt(sessionId, blocks, onChunk) {
    this.lastBlocks = blocks;
    const text = blocks.map((b) => b.text || '').join('');
    onChunk({ type: 'thought', delta: 'Thinking about the problem...' });
    if (text.includes('use tool')) {
      onChunk({ type: 'tool', tool: { name: 'read_file', input: { Path: '/test.txt' } } });
    }
    onChunk({ type: 'text', delta: 'Here is the answer.' });
    return { status: 'ok', usage: { inputTokens: 100, outputTokens: 7, thoughtTokens: 3, cachedReadTokens: 50, cachedWriteTokens: 0 } };
  }
  closeSession(sessionId) {
    this.sessions.delete(sessionId);
  }
}

describe('AcpSessionBridge', () => {
  let bridge;
  let mockRuntime;

  beforeEach(() => {
    mockRuntime = new MockRuntime();
    bridge = new AcpSessionBridge({
      runtime: mockRuntime,
      dataDir: `/tmp/acp-test-${Date.now()}`,
    });
  });

  it('creates an ACP session with expected fields and emits session.created', () => {
    const events = [];
    bridge.on('event', (ev) => events.push(ev));

    const session = bridge.createSession({
      title: 'Test Session',
      directory: '/tmp/test',
    });

    expect(session.id.startsWith('ses_agy_')).toBe(true);
    expect(session.title).toBe('Test Session');
    expect(session.agent).toBe('antigravity');
    expect(bridge.isAcpSession(session.id)).toBe(true);

    const createdEvent = events.find((e) => e.type === 'session.created');
    expect(createdEvent).toBeDefined();
    expect(createdEvent.properties.info.id).toBe(session.id);
  });

  it('starts a turn, creates messages, and streams parts to event stream', async () => {
    const events = [];
    bridge.on('event', (ev) => events.push(ev));

    const session = bridge.createSession({ title: 'Stream Test' });
    const userMsg = await bridge.startTurn(session.id, { text: 'Hello ACP' });

    expect(userMsg).toBeDefined();
    expect(userMsg.text).toBe('Hello ACP');
    expect(userMsg.sessionID).toBe(session.id);

    // Give background turn a moment to process
    await new Promise((r) => setTimeout(r, 100));

    // Verify events were emitted
    const types = events.map((e) => e.type);
    expect(types).toContain('session.execution.started');
    expect(types).toContain('session.step.started');
    expect(types).toContain('session.text.started');
    expect(types).toContain('session.text.delta');
    expect(types).toContain('session.execution.succeeded');

    // Verify message list retrieval
    const messages = bridge.getMessages(session.id);
    expect(messages.data.length).toBeGreaterThanOrEqual(2);
  });

  it('aborts an active turn cleanly', async () => {
    const events = [];
    bridge.on('event', (ev) => events.push(ev));

    const session = bridge.createSession({ title: 'Abort Test' });
    // Replace prompt with a slow promise
    mockRuntime.prompt = () => new Promise((resolve) => setTimeout(resolve, 5000));

    await bridge.startTurn(session.id, { text: 'Long running task' });
    expect(bridge.activeTurns.has(session.id)).toBe(true);

    const aborted = bridge.abortTurn(session.id);
    expect(aborted).toBe(true);
    expect(bridge.activeTurns.has(session.id)).toBe(false);

    const idleEvent = events.find((e) => e.type === 'session.idle' && e.properties.outcome === 'interrupted');
    expect(idleEvent).toBeDefined();
  });

  it('deletes a session and emits session.deleted', () => {
    const events = [];
    bridge.on('event', (ev) => events.push(ev));

    const session = bridge.createSession({ title: 'Delete Test' });
    expect(bridge.getSession(session.id)).toBeDefined();

    const ok = bridge.deleteSession(session.id);
    expect(ok).toBe(true);
    expect(bridge.getSession(session.id)).toBeNull();

    const deletedEvent = events.find((e) => e.type === 'session.deleted');
    expect(deletedEvent).toBeDefined();
    expect(deletedEvent.properties.sessionID).toBe(session.id);
  });

  it('reuses the same ACP process across Turn 1 and Turn 2', async () => {
    const session = bridge.createSession({ title: 'Multi-turn Test' });

    // Turn 1
    await bridge.startTurn(session.id, { text: 'Turn 1 prompt' });
    await new Promise((r) => setTimeout(r, 80));
    expect(mockRuntime.createCallCount).toBe(1);
    const acpId1 = session.acpSessionId;
    expect(acpId1).toBeDefined();

    // Turn 2
    await bridge.startTurn(session.id, { text: 'Turn 2 prompt' });
    await new Promise((r) => setTimeout(r, 80));
    // Verify no new ACP session was created
    expect(mockRuntime.createCallCount).toBe(1);
    expect(session.acpSessionId).toBe(acpId1);
  });

  it('properly formats tool parts with name, time, and completed status', async () => {
    const session = bridge.createSession({ title: 'Tool Test' });
    await bridge.startTurn(session.id, { text: 'Please use tool now' });
    await new Promise((r) => setTimeout(r, 80));

    const messages = bridge.getMessages(session.id, { order: 'asc' });
    const assistantMsg = messages.data.find((m) => m.type === 'assistant');
    expect(assistantMsg).toBeDefined();

    const toolPart = assistantMsg.content.find((p) => p.type === 'tool');
    expect(toolPart).toBeDefined();
    expect(toolPart.name).toBe('read_file');
    expect(toolPart.tool).toBe('read_file');
    expect(toolPart.executed).toBe(true);
    expect(toolPart.time.created).toBeDefined();
    expect(toolPart.time.completed).toBeDefined();
    expect(toolPart.state.status).toBe('completed');
  });

  it('respects order asc and desc in getMessages', () => {
    const session = bridge.createSession({ title: 'Order Test' });
    session.messages = [
      { id: 'msg_1', time: { created: 100 } },
      { id: 'msg_2', time: { created: 200 } },
      { id: 'msg_3', time: { created: 300 } },
    ];

    const desc = bridge.getMessages(session.id, { order: 'desc' });
    expect(desc.data.map((m) => m.id)).toEqual(['msg_3', 'msg_2', 'msg_1']);

    const asc = bridge.getMessages(session.id, { order: 'asc' });
    expect(asc.data.map((m) => m.id)).toEqual(['msg_1', 'msg_2', 'msg_3']);
  });

  it('sanitizes legacy tool parts missing time or name so projection does not crash', () => {
    const session = bridge.createSession({ title: 'Sanitize Test' });
    session.messages = [
      {
        id: 'msg_legacy_a',
        type: 'assistant',
        time: { created: 100, completed: 200 },
        content: [
          {
            id: 'call_1',
            type: 'tool',
            tool: 'read_file',
            state: { status: 'running', input: { path: 'a.txt' } },
            // missing time, missing name, missing executed
          },
        ],
      },
    ];

    const res = bridge.getMessages(session.id, { order: 'asc' });
    const part = res.data[0].content[0];
    expect(part.name).toBe('read_file');
    expect(part.tool).toBe('read_file');
    expect(part.time).toBeDefined();
    expect(part.time.ran).toBeDefined();
    expect(part.time.completed).toBeDefined();
    expect(part.executed).toBe(true);
    expect(part.state.status).toBe('completed');
  });

  it('loads and lists historical Gemini CLI sessions from conversation_summaries.db', () => {
    const historical = bridge.getGeminiHistorySessions();
    expect(Array.isArray(historical)).toBe(true);
    expect(historical.length).toBeGreaterThan(0);

    const first = historical[0];
    expect(first.id.startsWith('ses_agy_')).toBe(true);
    expect(first.agent).toBe('antigravity');
    expect(first.model.providerID).toBe('antigravity');

    expect(bridge.isAcpSession(first.id)).toBe(true);
  });

  it('lazy-loads transcript messages for historical Gemini session', () => {
    const convId = '2f243661-e209-4f76-beaa-86d65bf0683a';
    const sessionId = `ses_agy_${convId}`;
    const session = bridge.getSession(sessionId);

    expect(session).toBeDefined();
    expect(session.id).toBe(sessionId);
    expect(session.agent).toBe('antigravity');
    expect(Array.isArray(session.messages)).toBe(true);
    expect(session.messages.length).toBeGreaterThan(0);

    const firstMsg = session.messages[0];
    expect(firstMsg.type).toBe('user');
    expect(firstMsg.content[0].type).toBe('text');

    const asstMsg = session.messages.find((m) => m.type === 'assistant');
    if (asstMsg) {
      expect(asstMsg.role).toBe('assistant');
      expect(asstMsg.model).toBeDefined();
      expect(asstMsg.model.providerID).toBe('antigravity');
      expect(asstMsg.model.id).toBe('gemini-3.8-flash');
    }
  });

  it('guarantees historical messages project cleanly with projection.projectMessages', async () => {
    const { projectMessages } = await import('../../../../ui/src/lib/opencode/projection.ts');
    const convId = '2f243661-e209-4f76-beaa-86d65bf0683a';
    const sessionId = `ses_agy_${convId}`;
    const session = bridge.getSession(sessionId);
    expect(session).toBeDefined();

    const projected = projectMessages(session.messages, session.id);
    expect(Array.isArray(projected)).toBe(true);
    expect(projected.length).toBe(session.messages.length);
    for (const item of projected) {
      expect(item.message.id).toBeDefined();
      expect(Array.isArray(item.parts)).toBe(true);
    }
  });

  it('records real token usage from the prompt result', async () => {
    const session = bridge.createSession({ title: 'Usage' });
    await bridge.startTurn(session.id, { text: 'hi' });
    await new Promise((r) => setTimeout(r, 80));
    const asst = session.messages.find((m) => m.type === 'assistant');
    expect(asst.tokens).toEqual({ input: 100, output: 7, reasoning: 3, cache: { read: 50, write: 0 } });
    expect(session.tokens.input).toBe(100);
  });

  it('maps the reasoning variant to the agy model tier', async () => {
    const session = bridge.createSession({ title: 'Variant' });
    bridge.switchModel(session.id, { id: 'gemini-4-argon', providerID: 'antigravity', variant: 'high' });
    await bridge.startTurn(session.id, { text: 'hi' });
    await new Promise((r) => setTimeout(r, 80));
    expect(mockRuntime.models).toContain('gemini-4-argon-high');
  });

  it('resumes historical sessions natively via the conversation id', async () => {
    const session = bridge.createSession({ title: 'Resume' });
    session.geminiConvId = 'conv-123';
    await bridge.startTurn(session.id, { text: 'hi' });
    await new Promise((r) => setTimeout(r, 80));
    expect(mockRuntime.lastResume).toBe('conv-123');
  });

  it('builds ACP blocks for image and text attachments when the agent advertises them', () => {
    const blocks = buildPromptBlocks('see', [
      { mime: 'image/png', url: 'data:image/png;base64,AAAA' },
      { mime: 'text/plain', filename: 'a.txt', url: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}` },
    ], { image: true, embeddedContext: true });
    expect(blocks[0]).toEqual({ type: 'text', text: 'see' });
    expect(blocks[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect(blocks[2].resource.text).toBe('hello');
  });

  it('never sends an image block to an agent that did not advertise image support', () => {
    // ACP treats an omitted prompt capability as UNSUPPORTED, so this agent may
    // only receive text and resource_link blocks.
    const { blocks, notices } = buildPromptPayload('see', [
      { mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAAA' },
    ], {});
    expect(blocks).toEqual([
      { type: 'text', text: 'see' },
      { type: 'text', text: '[Image attachment "shot.png" omitted: the agent did not advertise the "image" prompt capability.]' },
    ]);
    expect(blocks.some((block) => block.type === 'image')).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ capability: 'image', name: 'shot.png' });
  });

  it('degrades an embedded resource to a text reference without embeddedContext', () => {
    const { blocks, notices } = buildPromptPayload('see', [
      { mime: 'text/plain', filename: 'a.txt', url: `data:text/plain;base64,${Buffer.from('hello').toString('base64')}` },
    ], { image: true });
    expect(blocks.some((block) => block.type === 'resource')).toBe(false);
    expect(notices[0]).toMatchObject({ capability: 'embeddedContext', kind: 'File' });
    expect(blocks[1].text).toContain('"embeddedContext" prompt capability');
  });

  it('gates audio on its own capability and keeps resource_link as the baseline', () => {
    const withoutAudio = buildPromptPayload('see', [
      { mime: 'audio/wav', filename: 'clip.wav', url: 'data:audio/wav;base64,AAAA' },
      { uri: 'file:///repo/notes.md', name: 'notes.md' },
    ], { image: true, embeddedContext: true });
    expect(withoutAudio.blocks.some((block) => block.type === 'audio')).toBe(false);
    expect(withoutAudio.notices[0]).toMatchObject({ capability: 'audio' });
    // URL-only attachments need no capability at all.
    expect(withoutAudio.blocks).toContainEqual({ type: 'resource_link', uri: 'file:///repo/notes.md', name: 'notes.md' });

    const withAudio = buildPromptPayload('see', [
      { mime: 'audio/wav', filename: 'clip.wav', url: 'data:audio/wav;base64,AAAA' },
    ], { audio: true });
    expect(withAudio.blocks).toContainEqual({ type: 'audio', data: 'AAAA', mimeType: 'audio/wav' });
    expect(withAudio.notices).toHaveLength(0);
  });

  it('supports general multi-agent ACP configurations (e.g. claude-code) and catalog augmentation', async () => {
    expect(bridge.isAcpAgent('antigravity')).toBe(true);
    expect(bridge.isAcpAgent('claude-code')).toBe(true);
    expect(bridge.isAcpProvider('claude-code')).toBe(true);
    expect(bridge.resolveAcpAgent({ agent: 'claude-code' })?.id).toBe('claude-code');

    const session = bridge.createSession({ agent: 'claude-code' });
    expect(session.id.startsWith('ses_acp_claude-code_')).toBe(true);
    expect(session.agent).toBe('claude-code');
    expect(session.model).toEqual({ id: 'claude-sonnet-4-6', providerID: 'claude-code' });

    await bridge.startTurn(session.id, { text: 'Hello Claude ACP' });
    await new Promise((r) => setTimeout(r, 80));

    expect(mockRuntime.lastAgentId).toBe('claude-code');
    const asst = session.messages.find((m) => m.type === 'assistant');
    expect(asst.agent).toBe('claude-code');
    expect(asst.model.providerID).toBe('claude-code');

    const aug = bridge.getCatalogAugmentation();
    expect(aug.agents.some((a) => a.id === 'antigravity')).toBe(true);
    expect(aug.providers.some((p) => p.id === 'antigravity')).toBe(true);
    expect(aug.models.some((m) => m.id === 'antigravity/gemini-3.8-flash' && m.variants.length === 3)).toBe(true);
  });

  it('emits wire events with id, created, and location that pass the UI event-pipeline wireEventSchema', async () => {
    const { classifyStreamPayload } = await import('../../../../ui/src/sync/event-pipeline.ts');
    const captured = [];
    const injected = [];
    bridge.setEventHub({
      injectEvent(evt) {
        injected.push(evt);
      },
    });
    bridge.subscribeEvent((evt) => captured.push(evt));

    const session = bridge.createSession({ title: 'Live Wire Test', directory: '/repo/test' });
    await bridge.startTurn(session.id, { text: 'use tool please', directory: '/repo/test' });
    await new Promise((r) => setTimeout(r, 90));

    expect(injected.length).toBeGreaterThan(0);
    expect(injected.every((e) => e.spaceId === 'acp')).toBe(true);

    const syncEvents = [];
    for (const wire of captured) {
      expect(typeof wire.id).toBe('string');
      expect(wire.id.startsWith('evt_')).toBe(true);
      const classified = classifyStreamPayload(wire, '/repo/test');
      if (classified.kind === 'events') {
        syncEvents.push(...classified.events.map((e) => e.event));
      }
    }

    const syncTypes = syncEvents.map((e) => e.type);
    expect(syncTypes).toContain('session.created');
    expect(syncTypes).toContain('session.status');
    expect(syncTypes).toContain('message.updated');
    expect(syncTypes).toContain('message.part.updated');
    expect(syncTypes).toContain('message.part.delta');
    expect(syncTypes).toContain('message.tool.transition');
    expect(syncTypes).toContain('message.patched');
    expect(syncTypes).toContain('session.idle');
  });
});

describe('AcpSessionBridge permission prompts', () => {
  let bridge;
  let runtime;
  let broadcasts;

  const permissionRequest = (overrides = {}) => ({
    requestId: 'perm_1',
    sessionId: 'mock_acp_child',
    toolCall: { toolCallId: 'call_1', title: 'Run the tests', kind: 'execute' },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', consent: true },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once', consent: false },
    ],
    createdAt: 1,
    settle: () => true,
    ...overrides,
  });

  beforeEach(() => {
    runtime = new MockRuntime();
    const answers = [];
    runtime.answers = answers;
    runtime.respondToPermission = (acpSessionId, requestId, optionId) => {
      answers.push({ acpSessionId, requestId, optionId });
      return { requestId, outcome: optionId === null ? 'cancelled' : 'selected', ...(optionId === null ? {} : { optionId }) };
    };
    const cancellations = [];
    runtime.cancellations = cancellations;
    runtime.cancelPendingPermissions = (acpSessionId) => { cancellations.push(acpSessionId); return 1; };

    bridge = new AcpSessionBridge({ runtime, dataDir: `/tmp/acp-perm-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
    broadcasts = [];
    bridge.setUiBroadcaster((payload) => broadcasts.push(payload));
  });

  const seedSession = () => {
    const session = bridge.createSession({ id: 'ses_ui_1', directory: '/repo', agent: 'antigravity' });
    session.acpSessionId = 'mock_acp_child';
    return session;
  };

  it('announces the request to the UI and keeps it bound to the OpenChamber session', () => {
    seedSession();
    runtime.emit('permission_request', permissionRequest());

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      type: 'openchamber:acp-permission-asked',
      properties: {
        sessionID: 'ses_ui_1',
        requestId: 'perm_1',
        directory: '/repo',
        toolCall: { toolCallId: 'call_1', title: 'Run the tests' },
      },
    });
    expect(broadcasts[0].properties.options[0]).toMatchObject({ optionId: 'allow-once', consent: true });
    expect(bridge.listPendingPermissions('ses_ui_1')).toHaveLength(1);
  });

  it('answers through the ACP session id the runtime knows, not the UI session id', () => {
    seedSession();
    runtime.emit('permission_request', permissionRequest());

    const result = bridge.respondToPermission('ses_ui_1', 'perm_1', 'allow-once');
    expect(result).toMatchObject({ outcome: 'selected', optionId: 'allow-once' });
    expect(runtime.answers).toEqual([{ acpSessionId: 'mock_acp_child', requestId: 'perm_1', optionId: 'allow-once' }]);
  });

  it('dismissing sends the cancelled answer', () => {
    seedSession();
    runtime.emit('permission_request', permissionRequest());

    expect(bridge.respondToPermission('ses_ui_1', 'perm_1', null)).toMatchObject({ outcome: 'cancelled' });
    expect(runtime.answers).toEqual([{ acpSessionId: 'mock_acp_child', requestId: 'perm_1', optionId: null }]);
  });

  it('rejects a reply bound to another session or an unknown request', () => {
    seedSession();
    runtime.emit('permission_request', permissionRequest());

    expect(() => bridge.respondToPermission('ses_other', 'perm_1', 'allow-once')).toThrow(/not pending/);
    expect(() => bridge.respondToPermission('ses_ui_1', 'perm_404', 'allow-once')).toThrow(/not pending/);
    expect(runtime.answers).toEqual([]);
  });

  it('settling clears the prompt and announces how it ended', () => {
    seedSession();
    runtime.emit('permission_request', permissionRequest());
    runtime.emit('permission_settled', {
      requestId: 'perm_1',
      sessionId: 'mock_acp_child',
      outcome: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
    });

    expect(bridge.listPendingPermissions('ses_ui_1')).toEqual([]);
    expect(broadcasts.at(-1)).toEqual({
      type: 'openchamber:acp-permission-settled',
      properties: {
        sessionID: 'ses_ui_1',
        requestId: 'perm_1',
        acpSessionId: 'mock_acp_child',
        outcome: 'selected',
        optionId: 'allow-once',
      },
    });
  });

  it('cancels a request that has no UI session rather than leaving the agent blocked', () => {
    runtime.emit('permission_request', permissionRequest({ sessionId: 'acp_headless' }));

    expect(runtime.cancellations).toEqual(['acp_headless']);
    expect(bridge.pendingPermissions.size).toBe(0);
    expect(broadcasts).toEqual([]);
  });
});

describe('AcpSessionBridge P0/P1 fixes', () => {
  const makeTestDir = () => `/tmp/acp-p0p1-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  it('finalizes reasoning and text parts and sets session.outcome on failure and abort', async () => {
    const events = [];
    const failRuntime = {
      getRegisteredAgents: () => [{ id: 'antigravity', providerId: 'antigravity', defaultModel: 'gemini-3.8-flash' }],
      createSession: async () => ({ sessionId: 'acp_fail_1', promptCapabilities: {} }),
      isSessionAlive: () => true,
      getSession: () => ({ sessionId: 'acp_fail_1', promptCapabilities: {} }),
      setModel: async () => ({}),
      cancel: async () => ({}),
      prompt: async (_id, _blocks, onChunk) => {
        onChunk({ type: 'thought', delta: 'thinking before crash' });
        throw new Error('Upstream exploded');
      },
    };
    const bridge = new AcpSessionBridge({ runtime: failRuntime, dataDir: makeTestDir() });
    bridge.subscribeEvent((e) => events.push(e));
    const ses = bridge.createSession({ id: 'ses_fail', directory: '/repo', agent: 'antigravity' });
    await bridge.startTurn(ses.id, { text: 'crash' });
    await new Promise((r) => setTimeout(r, 40));

    expect(ses.outcome).toBe('failed');
    expect(ses.error?.message).toBe('Upstream exploded');
    const aMsg = ses.messages.find((m) => m.type === 'assistant');
    const rPart = aMsg.content.find((p) => p.type === 'reasoning');
    expect(typeof rPart.time.end).toBe('number');
    expect(events.some((e) => e.type === 'session.reasoning.ended' && e.data?.ordinal === 0)).toBe(true);
    expect(events.some((e) => e.type === 'session.idle' && e.properties?.outcome === 'failed')).toBe(true);

    // Abort case while streaming both reasoning and text
    events.length = 0;
    let triggerChunk;
    const abortRuntime = {
      getRegisteredAgents: () => [{ id: 'antigravity', providerId: 'antigravity', defaultModel: 'gemini-3.8-flash' }],
      createSession: async () => ({ sessionId: 'acp_abort_1', promptCapabilities: {} }),
      isSessionAlive: () => true,
      getSession: () => ({ sessionId: 'acp_abort_1', promptCapabilities: {} }),
      setModel: async () => ({}),
      cancel: async () => ({}),
      prompt: (_id, _blocks, onChunk) => new Promise((resolve) => {
        triggerChunk = () => {
          onChunk({ type: 'text', delta: 'partial answer' });
        };
        setTimeout(() => resolve({ usage: {} }), 500);
      }),
    };
    const bridge2 = new AcpSessionBridge({ runtime: abortRuntime, dataDir: makeTestDir() });
    bridge2.subscribeEvent((e) => events.push(e));
    const ses2 = bridge2.createSession({ id: 'ses_abort', directory: '/repo', agent: 'antigravity' });
    await bridge2.startTurn(ses2.id, { text: 'abort me' });
    await new Promise((r) => setTimeout(r, 20));
    triggerChunk();
    expect(bridge2.abortTurn(ses2.id)).toBe(true);

    expect(ses2.outcome).toBe('interrupted');
    const aMsg2 = ses2.messages.find((m) => m.type === 'assistant');
    const tPart2 = aMsg2.content.find((p) => p.type === 'text');
    expect(typeof tPart2.time.end).toBe('number');
    expect(events.some((e) => e.type === 'session.text.ended' && e.data?.ordinal === 0 && e.data?.text === 'partial answer')).toBe(true);
  });

  it('does not clobber session.model in switchAgent when providerID already matches', () => {
    const bridge = new AcpSessionBridge({
      runtime: { getRegisteredAgents: () => [{ id: 'antigravity', providerId: 'antigravity', defaultModel: 'gemini-3.8-flash' }] },
      dataDir: makeTestDir(),
    });
    const ses = bridge.createSession({ id: 'ses_sw', directory: '/repo', agent: 'antigravity' });
    bridge.switchModel(ses.id, { id: 'gemini-4-argon', providerID: 'antigravity', variant: 'high' });
    bridge.switchAgent(ses.id, 'antigravity');
    expect(ses.model).toEqual({ id: 'gemini-4-argon', providerID: 'antigravity', variant: 'high' });
  });

  it('preserves ACP tool identity, handles in_progress updates, and serializes diff blocks', async () => {
    const events = [];
    const runtime = {
      getRegisteredAgents: () => [{ id: 'antigravity', providerId: 'antigravity', defaultModel: 'gemini-3.8-flash' }],
      createSession: async () => ({ sessionId: 'acp_tool_1', promptCapabilities: {} }),
      isSessionAlive: () => true,
      getSession: () => ({ sessionId: 'acp_tool_1', promptCapabilities: {} }),
      setModel: async () => ({}),
      prompt: async (_id, _blocks, onChunk) => {
        onChunk({
          type: 'tool',
          tool: {
            toolCallId: 'call_edit_1',
            kind: 'edit',
            title: 'Edit src/app.ts',
            locations: [{ path: 'src/app.ts', line: 10 }],
            rawInput: { path: 'src/app.ts' },
          },
        });
        onChunk({
          type: 'tool_update',
          update: {
            toolCallId: 'call_edit_1',
            status: 'in_progress',
            title: 'Editing src/app.ts...',
          },
        });
        onChunk({
          type: 'tool_update',
          update: {
            toolCallId: 'call_edit_1',
            status: 'completed',
            content: [{ type: 'diff', path: 'src/app.ts', oldText: 'const a = 1;', newText: 'const a = 2;' }],
          },
        });
        return { usage: {} };
      },
    };
    const bridge = new AcpSessionBridge({ runtime, dataDir: makeTestDir() });
    bridge.subscribeEvent((e) => events.push(e));
    const ses = bridge.createSession({ id: 'ses_tool', directory: '/repo', agent: 'antigravity' });
    await bridge.startTurn(ses.id, { text: 'edit file' });
    await new Promise((r) => setTimeout(r, 40));

    const aMsg = ses.messages.find((m) => m.type === 'assistant');
    const toolPart = aMsg.content.find((p) => p.type === 'tool');
    expect(toolPart.name).toBe('edit');
    expect(toolPart.kind).toBe('edit');
    expect(toolPart.title).toBe('Editing src/app.ts...');
    expect(toolPart.locations).toEqual([{ path: 'src/app.ts', line: 10 }]);
    expect(toolPart.rawInput).toEqual({ path: 'src/app.ts' });
    expect(toolPart.state.output).toContain('--- a/src/app.ts');
    expect(toolPart.state.output).toContain('-const a = 1;');
    expect(toolPart.state.output).toContain('+const a = 2;');
    expect(toolPart.state.metadata.filediff).toEqual({
      file: 'src/app.ts',
      before: 'const a = 1;',
      after: 'const a = 2;',
    });
    expect(events.some((e) => e.type === 'session.tool.updated' && e.data?.status === 'in_progress')).toBe(true);
  });

  it('tracks dynamic reasoningOrdinal and textOrdinal across tool calls', async () => {
    const events = [];
    const runtime = {
      getRegisteredAgents: () => [{ id: 'antigravity', providerId: 'antigravity', defaultModel: 'gemini-3.8-flash' }],
      createSession: async () => ({ sessionId: 'acp_ord_1', promptCapabilities: {} }),
      isSessionAlive: () => true,
      getSession: () => ({ sessionId: 'acp_ord_1', promptCapabilities: {} }),
      setModel: async () => ({}),
      prompt: async (_id, _blocks, onChunk) => {
        onChunk({ type: 'thought', delta: 'think 0' });
        onChunk({ type: 'text', delta: 'text 0' });
        onChunk({ type: 'tool', tool: { toolCallId: 'c1', kind: 'read', title: 'Read' } });
        onChunk({ type: 'tool_update', update: { toolCallId: 'c1', status: 'completed', content: ['ok'] } });
        onChunk({ type: 'thought', delta: 'think 1' });
        onChunk({ type: 'text', delta: 'text 1' });
        return { usage: {} };
      },
    };
    const bridge = new AcpSessionBridge({ runtime, dataDir: makeTestDir() });
    bridge.subscribeEvent((e) => events.push(e));
    const ses = bridge.createSession({ id: 'ses_ord', directory: '/repo', agent: 'antigravity' });
    await bridge.startTurn(ses.id, { text: 'multi-step' });
    await new Promise((r) => setTimeout(r, 40));

    const aMsg = ses.messages.find((m) => m.type === 'assistant');
    const reasonings = aMsg.content.filter((p) => p.type === 'reasoning');
    const texts = aMsg.content.filter((p) => p.type === 'text');
    expect(reasonings.map((r) => r.id)).toEqual([`${aMsg.id}:reasoning:0`, `${aMsg.id}:reasoning:1`]);
    expect(texts.map((t) => t.id)).toEqual([`${aMsg.id}:text:0`, `${aMsg.id}:text:1`]);
    expect(events.filter((e) => e.type === 'session.reasoning.started').map((e) => e.data.ordinal)).toEqual([0, 1]);
    expect(events.filter((e) => e.type === 'session.text.started').map((e) => e.data.ordinal)).toEqual([0, 1]);
  });

  it('wires setConfigOption for model/thought_level/mode, forwards openchamber:acp-* chunks, and prepends synthetic context', async () => {
    const events = [];
    const configCalls = [];
    let capturedPromptBlocks = null;
    const runtime = {
      getRegisteredAgents: () => [{ id: 'antigravity', providerId: 'antigravity', defaultModel: 'gemini-3.8-flash' }],
      createSession: async () => ({
        sessionId: 'acp_cfg_1',
        promptCapabilities: {},
        configOptions: [{ id: 'mode', currentValue: 'code', options: [{ value: 'code', name: 'Code' }] }],
      }),
      isSessionAlive: () => true,
      getSession: () => ({ sessionId: 'acp_cfg_1', promptCapabilities: {} }),
      setConfigOption: async (sid, cid, val) => {
        configCalls.push({ sid, cid, val });
        return { success: true, configOptions: [{ id: cid, currentValue: val }] };
      },
      setModel: async () => ({}),
      prompt: async (_id, blocks, onChunk) => {
        capturedPromptBlocks = blocks;
        onChunk({ type: 'plan', entries: [{ content: 'Step 1', priority: 'high', status: 'in_progress' }] });
        onChunk({ type: 'mode', modeId: 'architect' });
        onChunk({ type: 'config_options', configOptions: [{ id: 'thought_level', currentValue: 'high' }] });
        onChunk({ type: 'commands', availableCommands: [{ name: 'plan', description: 'Create plan' }] });
        onChunk({ type: 'text', delta: 'done' });
        return { usage: {} };
      },
    };
    const bridge = new AcpSessionBridge({ runtime, dataDir: makeTestDir() });
    bridge.subscribeEvent((e) => events.push(e));
    const ses = bridge.createSession({ id: 'ses_cfg', directory: '/repo', agent: 'antigravity' });
    bridge.switchModel(ses.id, { id: 'gemini-4-argon', providerID: 'antigravity', variant: 'high' });
    const syn = bridge.addSyntheticContext(ses.id, { id: 'syn_1', text: 'System reminder: follow rules.' });
    expect(syn).toEqual({ ok: true, id: 'syn_1', sessionID: ses.id });

    await bridge.startTurn(ses.id, { text: 'hello' });
    await new Promise((r) => setTimeout(r, 40));

    expect(configCalls).toContainEqual({ sid: 'acp_cfg_1', cid: 'model', val: 'gemini-4-argon' });
    expect(configCalls).toContainEqual({ sid: 'acp_cfg_1', cid: 'thought_level', val: 'high' });
    expect(capturedPromptBlocks[0]).toEqual({ type: 'text', text: 'System reminder: follow rules.' });
    expect(capturedPromptBlocks[1]).toEqual({ type: 'text', text: 'hello' });
    expect(ses.pendingSyntheticContext).toEqual([]);
    expect(ses.acpPlan).toEqual([{ content: 'Step 1', priority: 'high', status: 'in_progress' }]);
    expect(ses.currentModeId).toBe('architect');
    expect(ses.availableCommands).toEqual([{ name: 'plan', description: 'Create plan' }]);
    expect(events.some((e) => e.type === 'openchamber:acp-plan' && e.properties?.sessionID === ses.id)).toBe(true);
    expect(events.some((e) => e.type === 'openchamber:acp-mode' && e.properties?.modeId === 'architect')).toBe(true);
    expect(events.some((e) => e.type === 'openchamber:acp-config-options')).toBe(true);
    expect(events.some((e) => e.type === 'openchamber:acp-commands')).toBe(true);
  });
});

describe('AcpSessionBridge interactive ask_question -> form.created/settled', () => {
  const makeTestDir = () => `/tmp/acp-q-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const questionRequest = (overrides = {}) => ({
    requestId: 'qst_1',
    sessionId: 'mock_acp_q',
    method: 'elicitation/create',
    title: 'Confirm environment',
    fields: [
      {
        key: 'env',
        type: 'string',
        title: 'Environment',
        required: true,
        options: [{ value: 'staging', label: 'Staging' }, { value: 'prod', label: 'Prod' }],
      },
    ],
    rawParams: {},
    createdAt: 1,
    settle: () => true,
    ...overrides,
  });

  it('emits form.created and form.replied wire events that pass UI classifyStreamPayload', async () => {
    const { classifyStreamPayload } = await import('../../../../ui/src/sync/event-pipeline.ts');
    const runtime = new MockRuntime();
    const answers = [];
    runtime.respondToQuestion = (acpSessionId, requestId, answer) => {
      answers.push({ acpSessionId, requestId, answer });
      return { requestId, outcome: answer === null ? 'cancelled' : 'accepted', ...(answer ? { answer } : {}) };
    };
    runtime.cancelPendingQuestions = () => 1;

    const bridge = new AcpSessionBridge({ runtime, dataDir: makeTestDir() });
    const captured = [];
    bridge.subscribeEvent((evt) => captured.push(evt));

    const ses = bridge.createSession({ id: 'ses_ui_q', directory: '/repo/q', agent: 'antigravity' });
    ses.acpSessionId = 'mock_acp_q';

    runtime.emit('question_request', questionRequest());
    expect(bridge.listPendingForms('ses_ui_q')).toHaveLength(1);
    const form = bridge.listPendingForms('ses_ui_q')[0];
    expect(form.id.startsWith('frm_')).toBe(true);
    expect(form.sessionID).toBe('ses_ui_q');

    const createdWire = captured.find((e) => e.type === 'form.created');
    expect(createdWire).toBeDefined();
    const classifiedCreated = classifyStreamPayload(createdWire, '/repo/q');
    expect(classifiedCreated.kind).toBe('events');
    expect(classifiedCreated.events[0].event.type).toBe('form.created');

    const replyRes = bridge.respondToQuestion('ses_ui_q', form.id, { env: 'staging' });
    expect(replyRes).toMatchObject({ outcome: 'accepted', answer: { env: 'staging' } });
    expect(answers).toEqual([{ acpSessionId: 'mock_acp_q', requestId: 'qst_1', answer: { env: 'staging' } }]);

    runtime.emit('question_settled', {
      requestId: 'qst_1',
      sessionId: 'mock_acp_q',
      outcome: { action: 'accept', content: { env: 'staging' } },
    });
    expect(bridge.listPendingForms('ses_ui_q')).toEqual([]);

    const repliedWire = captured.find((e) => e.type === 'form.replied');
    expect(repliedWire).toBeDefined();
    const classifiedSettled = classifyStreamPayload(repliedWire, '/repo/q');
    expect(classifiedSettled.events[0].event).toEqual({
      type: 'form.settled',
      properties: { sessionID: 'ses_ui_q', formID: form.id, disposition: 'replied' },
    });
  });

  it('emits form.cancelled on dismissal and cancels orphaned requests with no UI session', () => {
    const runtime = new MockRuntime();
    const cancellations = [];
    runtime.cancelPendingQuestions = (acpId) => { cancellations.push(acpId); return 1; };
    runtime.respondToQuestion = (acpSessionId, requestId, answer) => ({
      requestId,
      outcome: answer === null ? 'cancelled' : 'accepted',
    });

    const bridge = new AcpSessionBridge({ runtime, dataDir: makeTestDir() });
    const captured = [];
    bridge.subscribeEvent((evt) => captured.push(evt));

    runtime.emit('question_request', questionRequest({ sessionId: 'acp_unknown' }));
    expect(cancellations).toEqual(['acp_unknown']);
    expect(bridge.pendingQuestions.size).toBe(0);

    const ses = bridge.createSession({ id: 'ses_ui_q2', directory: '/repo/q2', agent: 'antigravity' });
    ses.acpSessionId = 'mock_acp_q';
    runtime.emit('question_request', questionRequest({ requestId: 'qst_2' }));
    const form = bridge.listPendingForms('ses_ui_q2')[0];

    expect(bridge.respondToQuestion('ses_ui_q2', form.id, null)).toMatchObject({ outcome: 'cancelled' });
    runtime.emit('question_settled', {
      requestId: 'qst_2',
      sessionId: 'mock_acp_q',
      outcome: { action: 'cancel' },
    });
    expect(captured.some((e) => e.type === 'form.cancelled' && e.data?.id === form.id)).toBe(true);
  });
});
