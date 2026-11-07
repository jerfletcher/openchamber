import { describe, it, expect, afterAll } from 'vitest';
import { AcpRuntime } from './acp-runtime.js';

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
