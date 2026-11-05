import express from 'express';
import { AcpRuntime } from './acp-runtime.js';

export function registerAcpRoutes(app, options = {}) {
  const runtime = options.runtime || new AcpRuntime(options);

  // Ensure JSON body parsing is enabled for all /api/acp endpoints
  app.use('/api/acp', express.json());

  // List all detected and configured ACP agents
  app.get('/api/acp/agents', (req, res) => {
    try {
      const agents = runtime.getAvailableAgents();
      res.json({ agents });
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
