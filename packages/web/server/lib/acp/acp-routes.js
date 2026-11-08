import express from 'express';
import { AcpRuntime } from './acp-runtime.js';
import { ACP_ERROR, httpStatusForAcpError, serializeAcpError, isAcpCancelledError } from './acp-protocol.js';

const ACP_MODEL_MAP = {
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

export function registerAcpRoutes(app, options = {}) {
  // The bridge owns the runtime the UI's sessions live in; when the caller has
  // one, the routes must answer through it or a prompt could never be resolved.
  const bridge = options.bridge || null;
  const runtime = options.runtime || bridge?.runtime || new AcpRuntime(options);

  /**
   * Permission requests are keyed by the session id the caller knows. The UI
   * speaks OpenChamber session ids while a direct `/api/acp` caller speaks ACP
   * session ids, so the bridge is tried first and the runtime is the fallback.
   */
  const respondToPermission = (sessionId, requestId, optionId) => {
    if (bridge) {
      try {
        return bridge.respondToPermission(sessionId, requestId, optionId);
      } catch (err) {
        if (err?.code !== ACP_ERROR.RESOURCE_NOT_FOUND) throw err;
        // Not an OpenChamber session id: fall through to the ACP id.
      }
    }
    return runtime.respondToPermission(sessionId, requestId, optionId);
  };

  const listPendingPermissions = (sessionId) => {
    if (bridge) {
      const pending = bridge.listPendingPermissions(sessionId);
      if (pending.length > 0) return pending;
    }
    return runtime.getPendingPermissions(sessionId);
  };

  /**
   * Surface an ACP failure with the status its spec code implies
   * (spec: /protocol/v1/error). `error` stays a string for existing clients;
   * `acpError` carries the typed code so a cancelled request (HTTP 499) is
   * never reported as a generic server fault.
   */
  const sendAcpError = (res, err) => {
    if (res.headersSent) return;
    res.status(httpStatusForAcpError(err)).json(serializeAcpError(err));
  };

  // Ensure JSON body parsing is enabled for all /api/acp endpoints
  app.use('/api/acp', express.json());

  // -------------------------------------------------------------------------
  // OpenAI-compatible Chat Completions API Bridge for OpenCode & Native UI
  // -------------------------------------------------------------------------
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
    const { model = 'gemini-4-argon', messages = [], stream = true } = req.body || {};
    const acpModelId = ACP_MODEL_MAP[model] || model;

    let promptText = '';
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (messages.length === 1) {
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

    let session = null;

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
      res.flushHeaders?.();

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

  // List all detected and configured ACP agents
  app.get('/api/acp/agents', (req, res) => {
    try {
      const agents = runtime.getAvailableAgents();
      res.json({ agents });
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  // List all active ACP sessions
  app.get('/api/acp/sessions', (req, res) => {
    try {
      const sessions = runtime.listSessions();
      res.json({ sessions });
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  // Get specific ACP session details and messages
  app.get('/api/acp/sessions/:sessionId', (req, res) => {
    try {
      const session = runtime.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  // Create a new ACP session
  app.post('/api/acp/sessions', async (req, res) => {
    try {
      const { agentId = 'antigravity', cwd } = req.body || {};
      const session = await runtime.createSession({ agentId, cwd });
      res.json(session);
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  // Change model on active session. `session/set_config_option` is the primary
  // call; the runtime falls back to the `session/set_model` alias only when the
  // agent answers -32601.
  app.post('/api/acp/sessions/:sessionId/model', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { modelId } = req.body || {};
      if (!modelId) {
        return res.status(400).json({ error: 'modelId is required' });
      }
      const result = await runtime.setModel(sessionId, modelId);
      res.json(result);
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  // Change mode on active session. Antigravity exposes `mode` as one of the
  // `configOptions` returned by session/new; `session/set_mode` is a legacy
  // alias that forwards to `session/set_config_option` (PR #14).
  app.post('/api/acp/sessions/:sessionId/mode', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { modeId } = req.body || {};
      if (!modeId) {
        return res.status(400).json({ error: 'modeId is required' });
      }
      const result = await runtime.setMode(sessionId, modeId);
      res.json(result);
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  // Generic config-option setter. `configId` is the id of a `configOptions`
  // entry (the live agy 1.5.1 binary advertises `model`, `thought_level`, and
  // `mode`). This is the extension-neutral surface: a caller that reads the
  // session's configOptions can set any of them without a bespoke endpoint.
  app.post('/api/acp/sessions/:sessionId/config', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { configId, value } = req.body || {};
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

  // Read back the configurable surface reported by session/new (modes, models,
  // configOptions) so a client can render a picker without a second session/new.
  app.get('/api/acp/sessions/:sessionId/config', (req, res) => {
    try {
      const session = runtime.getSession(req.params.sessionId);
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

  // Prompt the session with live SSE streaming or standard JSON response
  app.post('/api/acp/sessions/:sessionId/prompt', async (req, res) => {
    const { sessionId } = req.params;
    const { prompt, stream = true } = req.body || {};

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

    // Set up Server-Sent Events (SSE) headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendSse = (event, data) => {
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
          // Ordered todo list; the agent sends the complete plan each time.
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
      // Cancelled requests keep their own signal instead of reading as failures.
      sendSse(isAcpCancelledError(err) ? 'cancelled' : 'error', serializeAcpError(err));
      res.end();
    }
  });

  // Permission requests an agent raised (`session/request_permission`). They are
  // listed for a client that (re)connects, and answered here. The agent is
  // blocked on the answer, so an unknown request id is a 404 — never a silent
  // success that would leave the turn waiting.
  app.get('/api/acp/v1/sessions/:sessionId/permissions', (req, res) => {
    try {
      const permissions = listPendingPermissions(req.params.sessionId);
      res.json({ permissions });
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  app.post('/api/acp/v1/sessions/:sessionId/permissions/:requestId', (req, res) => {
    const { sessionId, requestId } = req.params;
    const body = req.body || {};
    // `optionId: null` (or `outcome: 'cancelled'`) is the user dismissing the
    // prompt: the agent must hear `cancelled`, and it is never read as approval.
    const dismissed = body.outcome === 'cancelled' || body.optionId === null;
    const optionId = dismissed ? null : body.optionId;
    if (!dismissed && (typeof optionId !== 'string' || optionId === '')) {
      return res.status(400).json({ error: 'optionId is required (or outcome: "cancelled")' });
    }
    try {
      const result = respondToPermission(sessionId, requestId, optionId);
      res.json({ success: true, ...result });
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  // Close (and, when the agent advertises it, delete) a session. `session/delete`
  // is capability-gated because the live agy binary does not implement it.
  app.delete('/api/acp/sessions/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const result = await runtime.deleteSession(sessionId);
      res.json(result);
    } catch (err) {
      sendAcpError(res, err);
    }
  });

  return runtime;
}
