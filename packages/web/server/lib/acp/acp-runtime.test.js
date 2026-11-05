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
});
