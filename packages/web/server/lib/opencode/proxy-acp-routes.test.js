import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerOpenCodeProxy } from './proxy.js';

const servers = [];

const closeServer = (server) => new Promise((resolve) => {
  if (!server?.listening) return resolve();
  server.close(() => resolve());
});

afterEach(async () => {
  while (servers.length > 0) {
    await closeServer(servers.pop());
  }
});

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    servers.push(server);
    resolve(server.address().port);
  });
});

const createStubProxyDeps = (baseUrl, extra = {}) => ({
  fs: { promises: { realpath: async (value) => value } },
  os: {},
  path: {},
  OPEN_CODE_READY_GRACE_MS: 0,
  LONG_REQUEST_TIMEOUT_MS: 1_000,
  SESSION_UPSTREAM_TIMEOUT_MS: 500,
  getRuntime: () => ({ openCodePort: baseUrl ? new URL(baseUrl).port : null, openCodeBaseUrl: baseUrl }),
  getOpenCodeAuthHeaders: () => ({}),
  buildOpenCodeUrl: (pathname) => `${baseUrl}${pathname}`,
  ensureOpenCodeApiPrefix: (pathname) => pathname,
  createProxyMiddleware: () => (_req, res) => res.status(502).json({ error: 'unexpected proxy fallback' }),
  ...extra,
});

const createMockBridge = () => {
  const sessions = new Map([
    ['ses_agy_existing', { id: 'ses_agy_existing', agent: 'antigravity', model: { id: 'gemini-3.8-flash', providerID: 'antigravity' } }],
  ]);
  const eventListeners = new Set();
  return {
    sessions,
    setEventHub: vi.fn(),
    subscribeEvent: vi.fn((listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    }),
    emitTestEvent: (payload) => {
      for (const listener of eventListeners) listener(payload);
    },
    resolveAcpAgent: vi.fn(({ agent, providerID }) => {
      if (agent === 'antigravity' || providerID === 'antigravity') {
        return { id: 'antigravity', defaultModel: 'gemini-3.8-flash' };
      }
      return null;
    }),
    isAcpSession: vi.fn((id) => sessions.has(id)),
    createSession: vi.fn(({ id, title, directory, agent, model }) => {
      const session = { id: id || 'ses_agy_new', title, directory, agent, model };
      sessions.set(session.id, session);
      return session;
    }),
    switchModel: vi.fn(() => true),
    startTurn: vi.fn(async (sessionID, promptData) => ({
      id: promptData.id || 'msg_turn_1',
      time: { created: 1000 },
    })),
    addSyntheticContext: vi.fn((sessionID, item) => (
      sessions.has(sessionID) ? { ok: true, id: item.id || 'syn_1', sessionID } : null
    )),
    getCatalogAugmentation: vi.fn(() => ({
      agents: [{ id: 'antigravity', name: 'Antigravity (ACP)' }],
      providers: [{ id: 'antigravity', name: 'Antigravity' }],
      models: [{ id: 'antigravity/gemini-3.8-flash', providerID: 'antigravity', modelID: 'gemini-3.8-flash', variants: ['low', 'high'] }],
    })),
    listPendingForms: vi.fn((sessionID) => (
      sessionID === 'ses_agy_existing' || !sessionID
        ? [{ id: 'frm_qst_1', sessionID: 'ses_agy_existing', title: 'Pick env', fields: [{ key: 'env', type: 'string' }] }]
        : []
    )),
    getPendingForm: vi.fn((sessionID, formID) => (
      sessionID === 'ses_agy_existing' && formID === 'frm_qst_1'
        ? { id: 'frm_qst_1', sessionID: 'ses_agy_existing', title: 'Pick env', fields: [{ key: 'env', type: 'string' }] }
        : null
    )),
    respondToQuestion: vi.fn((sessionID, formID, answer) => ({
      requestId: formID,
      outcome: answer === null ? 'cancelled' : 'accepted',
      sessionID,
    })),
  };
};

describe('proxy ACP routes', () => {
  it('preserves model.variant on POST /api/session and calls switchModel on /prompt even without variant', async () => {
    const bridge = createMockBridge();
    const app = express();
    registerOpenCodeProxy(app, {
      ...createStubProxyDeps('http://127.0.0.1:4096'),
      acpSessionBridge: bridge,
    });

    const createRes = await request(app)
      .post('/api/session')
      .send({
        agent: 'antigravity',
        model: { id: 'claude-sonnet-4-6', providerID: 'antigravity', variant: 'high' },
      });

    expect(createRes.status).toBe(200);
    expect(bridge.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'antigravity',
      model: { id: 'claude-sonnet-4-6', providerID: 'antigravity', variant: 'high' },
    }));

    const promptRes = await request(app)
      .post('/api/session/ses_agy_existing/prompt')
      .send({
        text: 'hello',
        model: { id: 'gemini-3.8-flash', providerID: 'antigravity' },
      });

    expect(promptRes.status).toBe(200);
    expect(bridge.switchModel).toHaveBeenCalledWith('ses_agy_existing', {
      id: 'gemini-3.8-flash',
      providerID: 'antigravity',
    });
    expect(bridge.startTurn).toHaveBeenCalledWith('ses_agy_existing', expect.objectContaining({ text: 'hello' }));
  });

  it('forwards POST /api/session/:sessionID/command for ACP sessions as a slash turn', async () => {
    const bridge = createMockBridge();
    const app = express();
    registerOpenCodeProxy(app, {
      ...createStubProxyDeps('http://127.0.0.1:4096'),
      acpSessionBridge: bridge,
    });

    const res = await request(app)
      .post('/api/session/ses_agy_existing/command')
      .send({
        name: 'plan',
        text: 'fix the bug',
        model: { id: 'gemini-3.8-flash', providerID: 'antigravity' },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.payload.text).toBe('/plan fix the bug');
    expect(bridge.switchModel).toHaveBeenCalledWith('ses_agy_existing', {
      id: 'gemini-3.8-flash',
      providerID: 'antigravity',
    });
    expect(bridge.startTurn).toHaveBeenCalledWith('ses_agy_existing', expect.objectContaining({
      text: '/plan fix the bug',
    }));

    const badRes = await request(app)
      .post('/api/session/ses_agy_existing/command')
      .send({ text: 'missing name' });
    expect(badRes.status).toBe(400);
  });

  it('intercepts POST /api/session/:sessionID/synthetic for ACP sessions', async () => {
    const bridge = createMockBridge();
    const app = express();
    registerOpenCodeProxy(app, {
      ...createStubProxyDeps('http://127.0.0.1:4096'),
      acpSessionBridge: bridge,
    });

    const res = await request(app)
      .post('/api/session/ses_agy_existing/synthetic')
      .send({
        id: 'syn_42',
        text: 'Selected diff context',
        description: 'Selection',
        metadata: { source: 'editor' },
        resume: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true, id: 'syn_42', sessionID: 'ses_agy_existing' });
    expect(bridge.addSyntheticContext).toHaveBeenCalledWith('ses_agy_existing', {
      id: 'syn_42',
      text: 'Selected diff context',
      description: 'Selection',
      metadata: { source: 'editor' },
      resume: false,
    });
  });

  it('serves ACP catalog entries even when OpenCode upstream returns an error or is unreachable', async () => {
    const bridge = createMockBridge();

    // Case 1: upstream returns 503
    const unhealthyUpstream = http.createServer((_req, res) => {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'unhealthy' }));
    });
    const port = await listen(unhealthyUpstream);

    const appUnhealthy = express();
    registerOpenCodeProxy(appUnhealthy, {
      ...createStubProxyDeps(`http://127.0.0.1:${port}`),
      acpSessionBridge: bridge,
    });

    const agentRes = await request(appUnhealthy).get('/api/agent');
    expect(agentRes.status).toBe(200);
    expect(agentRes.body.data).toEqual([{ id: 'antigravity', name: 'Antigravity (ACP)' }]);

    const providerRes = await request(appUnhealthy).get('/api/provider');
    expect(providerRes.status).toBe(200);
    expect(providerRes.body.data).toEqual([{ id: 'antigravity', name: 'Antigravity' }]);

    const modelRes = await request(appUnhealthy).get('/api/model');
    expect(modelRes.status).toBe(200);
    expect(modelRes.body.data).toEqual([
      { id: 'antigravity/gemini-3.8-flash', providerID: 'antigravity', modelID: 'gemini-3.8-flash', variants: ['low', 'high'] },
    ]);

    // Case 2: upstream throws (unreachable port)
    const appDown = express();
    registerOpenCodeProxy(appDown, {
      ...createStubProxyDeps('http://127.0.0.1:1'),
      acpSessionBridge: bridge,
    });

    const downAgentRes = await request(appDown).get('/api/agent');
    expect(downAgentRes.status).toBe(200);
    expect(downAgentRes.body.data).toEqual([{ id: 'antigravity', name: 'Antigravity (ACP)' }]);
  });

  it('deduplicates ACP events on global /api/event SSE by skipping spaceId=acp from spaceEventHub', async () => {
    const bridge = createMockBridge();
    const spaceListeners = new Set();
    const spaceEventHub = {
      subscribeEvent: vi.fn((listener) => {
        spaceListeners.add(listener);
        return () => spaceListeners.delete(listener);
      }),
    };

    const upstreamSse = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"server.connected"}\n\n');
    });
    const upstreamPort = await listen(upstreamSse);

    const app = express();
    registerOpenCodeProxy(app, {
      ...createStubProxyDeps(`http://127.0.0.1:${upstreamPort}`),
      acpSessionBridge: bridge,
      spaceEventHub,
    });

    const frontServer = http.createServer(app);
    const frontPort = await listen(frontServer);

    const received = [];
    const controller = new AbortController();
    const ssePromise = (async () => {
      const response = await fetch(`http://127.0.0.1:${frontPort}/api/event`, { signal: controller.signal });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('space_evt_1')) {
          controller.abort();
          break;
        }
      }
      received.push(buffer);
    })();

    // Wait for both subscriptions to attach after upstream responds
    await vi.waitFor(() => {
      expect(spaceListeners.size).toBe(1);
    });

    const acpPayload = { id: 'acp_evt_1', type: 'message.updated', properties: { sessionID: 'ses_agy_existing' } };
    for (const listener of spaceListeners) {
      listener({ spaceId: 'acp', payload: acpPayload });
    }
    bridge.emitTestEvent(acpPayload);

    const spacePayload = { id: 'space_evt_1', type: 'session.updated' };
    for (const listener of spaceListeners) {
      listener({ spaceId: 'space_1', payload: spacePayload });
    }

    await ssePromise.catch(() => {});
    const fullText = received.join('');
    const acpMatches = fullText.match(/acp_evt_1/g) || [];
    expect(acpMatches).toHaveLength(1);
    expect(fullText).toContain('space_evt_1');
  });

  it('routes ACP session form list, reply, cancel, and /api/form overlay without hitting upstream', async () => {
    const bridge = createMockBridge();
    const app = express();
    registerOpenCodeProxy(app, {
      ...createStubProxyDeps('http://127.0.0.1:1'),
      acpSessionBridge: bridge,
    });

    const listRes = await request(app).get('/api/session/ses_agy_existing/form');
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);
    expect(listRes.body.data[0].id).toBe('frm_qst_1');

    const globalListRes = await request(app).get('/api/form');
    expect(globalListRes.status).toBe(200);
    expect(globalListRes.body.data).toHaveLength(1);

    const getRes = await request(app).get('/api/session/ses_agy_existing/form/frm_qst_1');
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.id).toBe('frm_qst_1');

    const replyRes = await request(app)
      .post('/api/session/ses_agy_existing/form/frm_qst_1/reply')
      .send({ answer: { env: 'staging' } });
    expect(replyRes.status).toBe(204);
    expect(bridge.respondToQuestion).toHaveBeenCalledWith('ses_agy_existing', 'frm_qst_1', { env: 'staging' });

    const cancelRes = await request(app).delete('/api/session/ses_agy_existing/form/frm_qst_1');
    expect(cancelRes.status).toBe(204);
    expect(bridge.respondToQuestion).toHaveBeenCalledWith('ses_agy_existing', 'frm_qst_1', null);
  });
});
