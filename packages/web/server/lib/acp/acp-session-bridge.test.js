import { describe, it, expect, beforeEach } from 'bun:test';
import { AcpSessionBridge } from './acp-session-bridge.js';
import EventEmitter from 'events';

class MockRuntime extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.createCallCount = 0;
  }
  async createSession({ agentId, cwd }) {
    this.createCallCount++;
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
    return { sessionId, modelId };
  }
  async prompt(sessionId, text, onChunk) {
    onChunk({ type: 'thought', delta: 'Thinking about the problem...' });
    if (text.includes('use tool')) {
      onChunk({ type: 'tool', tool: { name: 'read_file', input: { Path: '/test.txt' } } });
    }
    onChunk({ type: 'text', delta: 'Here is the answer.' });
    return { status: 'ok' };
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
});
