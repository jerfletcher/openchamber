import express from 'express';
import type { Application, RequestHandler } from '../shared/http-contracts.js';
import { AcpRuntime, type AcpRuntimeOptions } from './acp-runtime.js';
import { ACP_ERROR, httpStatusForAcpError, serializeAcpError, isAcpCancelledError } from './acp-protocol.js';
import type { AcpSessionBridge } from './acp-session-bridge.js';

const ACP_MODEL_MAP: Record<string, string> = {
  'gemini-4-argon': 'gemini-4-argon-medium',
  'gemini-4-argon-medium': 'gemini-4-argon-medium',
  'gemini-4-argon-high': 'gemini-4-argon-high',
  'gemini-4-argon-low': 'gemini-4-argon-low',
  'gemini-3.8-flash': 'gemini-3.8-flash-medium',
  'gemini-3.8-flash-medium': 'gemini-3.8-flash-medium',
  'gemini-3.8-flash-high': 'gemini-3.8-flash-high',
  'gemini-3.8-flash-low': 'gemini-3.8-flash-low',
  'claude-opus-5-5': 'claude-opus-5-5-medium',
  'claude-opus-5-5-medium': 'claude-opus-5-5-medium',
  'claude-opus-5-5-high': 'claude-opus-5-5-high',
  'claude-sonnet-5-5': 'claude-sonnet-5-5-medium',
  'claude-sonnet-5-5-medium': 'claude-sonnet-5-5-medium',
  'claude-sonnet-5-5-high': 'claude-sonnet-5-5-high',
  'gpt-oss-120b': 'gpt-oss-120b-medium',
};

export interface RegisterAcpRoutesOptions extends AcpRuntimeOptions {
  bridge?: AcpSessionBridge | null;
  runtime?: AcpRuntime;
}

export function registerAcpRoutes(app: Application, options: RegisterAcpRoutesOptions = {}): AcpRuntime {
  const bridge = options.bridge || null;
  const runtime = options.runtime || bridge?.runtime || new AcpRuntime(options);

  const respondToPermission = (sessionId: string, requestId: string, optionId: string | null | undefined) => {
    if (bridge) {
      try {
        return bridge.respondToPermission(sessionId, requestId, optionId);
      } catch (err) {
        if ((err as { code?: unknown })?.code !== ACP_ERROR.RESOURCE_NOT_FOUND) throw err;
      }
    }
    return runtime.respondToPermission(sessionId, requestId, optionId);
  };

  const listPendingPermissions = (sessionId: string) => {
    if (bridge) {
      const pending = bridge.listPendingPermissions(sessionId);
      if (pending.length > 0) return pending;
    }
    return runtime.getPendingPermissions(sessionId);
  };

  const respondToQuestion = (
    sessionId: string,
    requestId: string,
    answer: Record<string, unknown> | null | undefined,
  ) => {
    if (bridge) {
      try {
        return bridge.respondToQuestion(sessionId, requestId, answer);
      } catch (err) {
        if ((err as { code?: unknown })?.code !== ACP_ERROR.RESOURCE_NOT_FOUND) throw err;
      }
    }
    return runtime.respondToQuestion(sessionId, requestId, answer);
  };

  const listPendingQuestions = (sessionId: string) => {
    if (bridge) {
      const pending = bridge.listPendingQuestions(sessionId);
      if (pending.length > 0) return pending;
    }
    return runtime.getPendingQuestions(sessionId);
  };

  const sendAcpError = (res: Parameters<RequestHandler>[1], err: unknown) => {
    if (res.headersSent) return;
    res.status(httpStatusForAcpError(err)).json(serializeAcpError(err));
  };

  app.use('/api/acp', express.json() as unknown as RequestHandler);

  app.get('/api/acp/v1/models', (_req, res) => {
    res.json({
      object: 'list',
      data: Object.keys(ACP_MODEL_MAP).map((id) => ({
        id,
        object: 'model',
        created: 1793910000,
        owned_by: 'google-antigravity',
      })),
    });
  });

  app.post('/api/acp/v1/chat/completions', async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      model?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      stream?: boolean;
    };
    const { model = 'gemini-4-argon', messages = [], stream = true } = body;
    const acpModelId = ACP_MODEL_MAP[model] || model;

    let promptText = '';
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (messages.length === 1 && lastMsg) {
        promptText = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
      } else {
        promptText = messages
          .map((m) => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System'}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
          .join('\n\n') + '\n\nAssistant:';
      }
    }

    if (!promptText.trim()) {
      return res.status(400).json({ error: { message: 'Missing prompt content' } });
    }

    let session: Awaited<ReturnType<AcpRuntime['createSession']>> | null = null;

    try {
      session = await runtime.createSession({ agentId: 'antigravity', cwd: process.cwd() });
      await runtime.setModel(session.sessionId, acpModelId).catch(() => {});

      if (!stream) {
        const result = await runtime.prompt(session.sessionId, promptText);
        runtime.closeSession(session.sessionId);
        return res.json({
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: result.text || '' },
            finish_reason: 'stop',
          }],
        });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

      const completionId = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);

      req.on('close', () => {
        if (session) runtime.closeSession(session.sessionId);
      });

      await runtime.prompt(session.sessionId, promptText, (chunk) => {
        if (chunk.type === 'thought' && chunk.delta) {
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: { reasoning_content: chunk.delta },
              finish_reason: null,
            }],
          })}\n\n`);
        } else if (chunk.type === 'text' && chunk.delta) {
          res.write(`data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: { content: chunk.delta },
              finish_reason: null,
            }],
          })}\n\n`);
        }
      });

      res.write(`data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      runtime.closeSession(session.sessionId);
    } catch (err) {
      if (session) runtime.closeSession(session.sessionId);
      if (!res.headersSent) {
        sendAcpError(res, err);
      } else {
        res.write(`data: ${JSON.stringify(serializeAcpError(err))}\n\n`);
        res.end();
      }
    }
  });

  app.get('/api/acp/agents', (_req, res) => {
    try {
      const agents = runtime.getAvailableAgents();
      res.json({ agents });
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.get('/api/acp/sessions', (_req, res) => {
    try {
      const sessions = runtime.listSessions();
      res.json({ sessions });
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.get('/api/acp/sessions/:sessionId', (req, res) => {
    try {
      const session = runtime.getSession(req.params.sessionId ?? '');
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.post('/api/acp/sessions', async (req, res) => {
    try {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { agentId?: string; cwd?: string };
      const { agentId = 'antigravity', cwd } = body;
      const session = await runtime.createSession(cwd ? { agentId, cwd } : { agentId });
      res.json(session);
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.post('/api/acp/sessions/:sessionId/model', async (req, res) => {
    try {
      const sessionId = req.params.sessionId ?? '';
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { modelId?: string };
      const { modelId } = body;
      if (!modelId) {
        return res.status(400).json({ error: 'modelId is required' });
      }
      const result = await runtime.setModel(sessionId, modelId);
      res.json(result);
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.post('/api/acp/sessions/:sessionId/mode', async (req, res) => {
    try {
      const sessionId = req.params.sessionId ?? '';
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { modeId?: string };
      const { modeId } = body;
      if (!modeId) {
        return res.status(400).json({ error: 'modeId is required' });
      }
      const result = await runtime.setMode(sessionId, modeId);
      res.json(result);
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.post('/api/acp/sessions/:sessionId/config', async (req, res) => {
    try {
      const sessionId = req.params.sessionId ?? '';
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { configId?: unknown; value?: unknown };
      const { configId, value } = body;
      if (typeof configId !== 'string' || !configId) {
        return res.status(400).json({ error: 'configId is required' });
      }
      if (typeof value !== 'string' || value === '') {
        return res.status(400).json({ error: 'value is required' });
      }
      const result = await runtime.setConfigOption(sessionId, configId, value);
      res.json(result);
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.get('/api/acp/sessions/:sessionId/config', (req, res) => {
    try {
      const session = runtime.getSession(req.params.sessionId ?? '');
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json({
        configOptions: session.configOptions,
        availableModes: session.availableModes,
        currentModeId: session.currentModeId,
        availableModels: session.availableModels,
        currentModelId: session.currentModelId,
        capabilities: session.capabilities,
      });
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.post('/api/acp/sessions/:sessionId/prompt', async (req, res) => {
    const sessionId = req.params.sessionId ?? '';
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { prompt?: string; stream?: boolean };
    const { prompt, stream = true } = body;

    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    if (!stream) {
      try {
        const result = await runtime.prompt(sessionId, prompt);
        return res.json(result);
      } catch (err) {
        return sendAcpError(res, err);
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

    const sendSse = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await runtime.prompt(sessionId, prompt, (chunk) => {
        if (chunk.type === 'text') {
          sendSse('text_delta', { text: chunk.delta });
        } else if (chunk.type === 'thought') {
          sendSse('thought_delta', { thought: chunk.delta });
        } else if (chunk.type === 'tool') {
          sendSse('tool_call', { tool: chunk.tool });
        } else if (chunk.type === 'tool_update') {
          sendSse('tool_call_update', { update: chunk.update });
        } else if (chunk.type === 'plan') {
          sendSse('plan', { entries: chunk.entries });
        } else if (chunk.type === 'mode') {
          sendSse('current_mode_update', { currentModeId: chunk.modeId });
        } else if (chunk.type === 'config_options') {
          sendSse('config_option_update', { configOptions: chunk.configOptions });
        } else if (chunk.type === 'commands') {
          sendSse('available_commands_update', { availableCommands: chunk.availableCommands });
        }
      });

      sendSse('done', result);
      res.end();
    } catch (err) {
      sendSse(isAcpCancelledError(err) ? 'cancelled' : 'error', serializeAcpError(err));
      res.end();
    }
  });

  app.get('/api/acp/v1/sessions/:sessionId/permissions', (req, res) => {
    try {
      const permissions = listPendingPermissions(req.params.sessionId ?? '');
      res.json({ permissions });
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.post('/api/acp/v1/sessions/:sessionId/permissions/:requestId', (req, res) => {
    const sessionId = req.params.sessionId ?? '';
    const requestId = req.params.requestId ?? '';
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { outcome?: unknown; optionId?: unknown };
    const dismissed = body.outcome === 'cancelled' || body.optionId === null;
    const optionId = dismissed ? null : body.optionId;
    if (!dismissed && (typeof optionId !== 'string' || optionId === '')) {
      return res.status(400).json({ error: 'optionId is required (or outcome: "cancelled")' });
    }
    try {
      const result = respondToPermission(sessionId, requestId, dismissed ? null : (optionId as string));
      res.json({ success: true, ...result });
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.get('/api/acp/v1/sessions/:sessionId/questions', (req, res) => {
    try {
      const questions = listPendingQuestions(req.params.sessionId ?? '');
      res.json({ questions });
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.post('/api/acp/v1/sessions/:sessionId/questions/:requestId', (req, res) => {
    const sessionId = req.params.sessionId ?? '';
    const requestId = req.params.requestId ?? '';
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      outcome?: unknown;
      action?: unknown;
      answer?: unknown;
      content?: unknown;
    };
    const dismissed = body.outcome === 'cancelled'
      || body.action === 'cancel'
      || body.action === 'decline'
      || body.answer === null;
    const answer = dismissed ? null : (body.answer ?? body.content);
    if (!dismissed && (!answer || typeof answer !== 'object' || Array.isArray(answer))) {
      return res.status(400).json({ error: 'answer object is required (or outcome: "cancelled")' });
    }
    try {
      const result = respondToQuestion(sessionId, requestId, dismissed ? null : (answer as Record<string, unknown>));
      res.json({ success: true, ...result });
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.delete('/api/acp/sessions/:sessionId', async (req, res) => {
    try {
      const sessionId = req.params.sessionId ?? '';
      const result = await runtime.deleteSession(sessionId);
      res.json(result);
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  return runtime;
}
