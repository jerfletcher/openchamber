import express from 'express';
import { AcpRuntime } from './acp-runtime.js';

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
  const runtime = options.runtime || new AcpRuntime(options);

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
        res.status(500).json({ error: { message: err.message } });
      } else {
        res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
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
      res.status(500).json({ error: err.message });
    }
  });

  // List all active ACP sessions
  app.get('/api/acp/sessions', (req, res) => {
    try {
      const sessions = runtime.listSessions();
      res.json({ sessions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get specific ACP session details and messages
  app.get('/api/acp/sessions/:sessionId', (req, res) => {
    try {
      const session = runtime.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create a new ACP session
  app.post('/api/acp/sessions', async (req, res) => {
    try {
      const { agentId = 'antigravity', cwd } = req.body || {};
      const session = await runtime.createSession({ agentId, cwd });
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Change model on active session
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
      res.status(500).json({ error: err.message });
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
        return res.status(500).json({ error: err.message });
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
        }
      });

      sendSse('done', result);
      res.end();
    } catch (err) {
      sendSse('error', { message: err.message });
      res.end();
    }
  });

  // Close session
  app.delete('/api/acp/sessions/:sessionId', (req, res) => {
    try {
      const { sessionId } = req.params;
      runtime.closeSession(sessionId);
      res.json({ success: true, sessionId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return runtime;
}
