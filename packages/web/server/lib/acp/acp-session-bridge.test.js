import { describe, it, expect, beforeEach } from 'bun:test';
import { AcpSessionBridge } from './acp-session-bridge.js';
import EventEmitter from 'events';

class MockRuntime extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }
  async createSession({ agentId, cwd }) {
    const id = `mock_acp_${Math.random().toString(36).slice(2, 6)}`;
    this.sessions.set(id, { agentId, cwd });
    return { sessionId: id, agentId };
  }
  async setModel(sessionId, modelId) {
    return { sessionId, modelId };
  }
  async prompt(sessionId, text, onChunk) {
    onChunk({ type: 'thought', delta: 'Thinking about the problem...' });
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
});
