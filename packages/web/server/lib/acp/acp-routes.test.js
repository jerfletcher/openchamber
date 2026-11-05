import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerAcpRoutes } from './acp-routes.js';
import { AcpRuntime } from './acp-runtime.js';

describe('ACP Routes', () => {
  const app = express();
  app.use(express.json());

  const runtime = new AcpRuntime();
  registerAcpRoutes(app, { runtime });

  afterAll(() => {
    runtime.closeAll();
  });

  it('GET /api/acp/agents returns detected ACP agents', async () => {
    const res = await request(app).get('/api/acp/agents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.agents)).toBe(true);
    expect(res.body.agents.some((a) => a.id === 'antigravity')).toBe(true);
  });

  it('POST /api/acp/sessions creates an ACP session and changes model', async () => {
    const res = await request(app)
      .post('/api/acp/sessions')
      .send({ agentId: 'antigravity', cwd: '/home/jeremy/develop/oc-workspace' });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeDefined();

    const sessionId = res.body.sessionId;

    const modelRes = await request(app)
      .post(`/api/acp/sessions/${sessionId}/model`)
      .send({ modelId: 'gemini-3.8-flash-medium' });

    expect(modelRes.status).toBe(200);
    expect(modelRes.body.success).toBe(true);

    const deleteRes = await request(app).delete(`/api/acp/sessions/${sessionId}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);
  });
});
