import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerAcpRoutes } from './acp-routes.js';
import { AcpRuntime } from './acp-runtime.js';
import { ACP_ERROR, AcpError } from './acp-protocol.js';

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

describe('ACP permission endpoints', () => {
  const app = express();
  app.use(express.json());
  const runtime = new AcpRuntime({ idleTtlMs: 0 });
  const answers = [];
  // A stand-in for the bridge: the endpoints only need its session mapping.
  const bridge = {
    respondToPermission(sessionID, requestId, optionId) {
      if (sessionID !== 'ses_ui_1' || requestId !== 'perm_1') {
        throw new AcpError({ code: ACP_ERROR.RESOURCE_NOT_FOUND, message: `Permission request '${requestId}' is not pending` });
      }
      answers.push({ sessionID, requestId, optionId });
      return { requestId, outcome: optionId === null ? 'cancelled' : 'selected', ...(optionId === null ? {} : { optionId }) };
    },
    listPendingPermissions(sessionID) {
      if (sessionID !== 'ses_ui_1') return [];
      return [{
        requestId: 'perm_1',
        sessionID,
        toolCall: { toolCallId: 'call_1', title: 'Run the tests' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', consent: true }],
      }];
    },
  };
  registerAcpRoutes(app, { runtime, bridge });

  afterAll(() => {
    runtime.closeAll();
  });

  it('lists the pending prompts of a session', async () => {
    const res = await request(app).get('/api/acp/v1/sessions/ses_ui_1/permissions');
    expect(res.status).toBe(200);
    expect(res.body.permissions).toHaveLength(1);
    expect(res.body.permissions[0].requestId).toBe('perm_1');
  });

  it('answers with the chosen optionId', async () => {
    const res = await request(app)
      .post('/api/acp/v1/sessions/ses_ui_1/permissions/perm_1')
      .send({ optionId: 'allow-once' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, requestId: 'perm_1', outcome: 'selected', optionId: 'allow-once' });
    expect(answers).toEqual([{ sessionID: 'ses_ui_1', requestId: 'perm_1', optionId: 'allow-once' }]);
  });

  it('dismissing answers cancelled, never a selection', async () => {
    const res = await request(app)
      .post('/api/acp/v1/sessions/ses_ui_1/permissions/perm_1')
      .send({ outcome: 'cancelled' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, outcome: 'cancelled' });
    expect(answers.at(-1)).toEqual({ sessionID: 'ses_ui_1', requestId: 'perm_1', optionId: null });
  });

  it('rejects a reply for an unknown or stale request id with 404', async () => {
    const res = await request(app)
      .post('/api/acp/v1/sessions/ses_ui_1/permissions/perm_404')
      .send({ optionId: 'allow-once' });

    expect(res.status).toBe(404);
    expect(res.body.acpError).toMatchObject({ code: ACP_ERROR.RESOURCE_NOT_FOUND, kind: 'resource-not-found' });
  });

  it('requires an optionId or an explicit cancel', async () => {
    const res = await request(app)
      .post('/api/acp/v1/sessions/ses_ui_1/permissions/perm_1')
      .send({});

    expect(res.status).toBe(400);
  });
});
