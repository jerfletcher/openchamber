import { spawn } from 'child_process';
import EventEmitter from 'events';
import { ACP_ERROR, AcpError } from './acp-protocol.js';

/**
 * Standard Agent Client Protocol (ACP) stdio JSON-RPC connection.
 * Handles line-buffered messaging, bi-directional request/response matching,
 * and agent notifications.
 *
 * ACP is symmetric: the client sends requests (`initialize`, `session/prompt`)
 * and the agent sends requests too (`session/request_permission` is the one
 * this client answers). So three inbound shapes must be told apart, and the
 * `id` is what distinguishes them: a response carries an id we are waiting on,
 * an agent-initiated REQUEST carries an id we are not waiting on plus a
 * `method`, and a notification carries a `method` without an id.
 */
export class AcpConnection extends EventEmitter {
  constructor(command, args = [], options = {}) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    // method -> handler(params, { id, method }). Registered by whoever owns the
    // capability; an unhandled request is answered -32601, never left hanging.
    this.requestHandlers = new Map();
    this.buffer = '';
    this.closed = false;
  }

  /**
   * Register the handler for an agent-initiated request method. The handler may
   * return a value or a promise; its result becomes the JSON-RPC `result`, and a
   * thrown `AcpError` becomes the `error` with that code.
   */
  registerRequestHandler(method, handler) {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
    };
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      cwd: this.options.cwd || process.cwd(),
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      this.flushBuffer();
    });

    this.proc.stderr.on('data', (chunk) => {
      this.emit('stderr', chunk.toString('utf8'));
    });

    this.proc.on('error', (err) => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      } else {
        console.error('[AcpConnection] Unhandled process error:', err.message);
      }
    });

    this.proc.on('close', (code, signal) => {
      this.closed = true;
      for (const [id, { reject }] of this.pending.entries()) {
        reject(new Error(`ACP process closed with code ${code} (${signal}) while request ${id} pending`));
      }
      this.pending.clear();
      this.emit('close', { code, signal });
    });
  }

  flushBuffer() {
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const message = JSON.parse(line);
          this.handleIncoming(message);
        } catch {
          this.emit('parseError', {
            line,
            error: new AcpError({
              code: ACP_ERROR.PARSE_ERROR,
              message: 'ACP peer sent a line that is not valid JSON',
              data: { line },
            }),
          });
        }
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  handleIncoming(msg) {
    if (!msg || typeof msg !== 'object') return;

    // 1. A response to a request we sent.
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, method } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        // JSON-RPC error object (spec: /protocol/v1/error). The code is what
        // callers branch on: -32800 means cancelled, never "something broke".
        reject(new AcpError({
          code: msg.error.code,
          message: msg.error.message || `ACP request '${method}' failed`,
          data: msg.error.data,
          method,
        }));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // 2. An agent-initiated request: it has both an id and a method, and the id
    // is the agent's own (never one of ours — those are matched above).
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.handleAgentRequest(msg);
      return;
    }

    // 3. A notification.
    if (msg.method) {
      this.emit('notification', { method: msg.method, params: msg.params });
      this.emit(msg.method, msg.params);
    }
  }

  /**
   * Answer an agent-initiated request. This is the other half of the symmetry:
   * without it the agent waits forever, which is exactly what happened before
   * `session/request_permission` had a handler.
   */
  handleAgentRequest(msg) {
    const { id, method, params } = msg;
    this.emit('request', { id, method, params });

    const handler = this.requestHandlers.get(method);
    if (!handler) {
      // The spec lets a peer answer -32601; hanging would be a hang, not a refusal.
      this.respondError(id, {
        code: ACP_ERROR.METHOD_NOT_FOUND,
        message: `ACP client does not implement request '${method}'`,
      });
      return;
    }

    let outcome;
    try {
      outcome = handler(params, { id, method });
    } catch (err) {
      this.respondError(id, errorForResponse(err, method));
      return;
    }

    Promise.resolve(outcome).then(
      (result) => this.respond(id, result ?? {}),
      (err) => this.respondError(id, errorForResponse(err, method)),
    );
  }

  /** Send a successful JSON-RPC response for an agent-initiated request. */
  respond(id, result) {
    return this.write(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${JSON.stringify(result ?? {})}}`);
  }

  /** Send a JSON-RPC error response for an agent-initiated request. */
  respondError(id, error) {
    const code = typeof error?.code === 'number' ? error.code : ACP_ERROR.INTERNAL_ERROR;
    const message = error?.message || 'ACP client failed to handle the request';
    const payload = { jsonrpc: '2.0', id, error: { code, message } };
    if (error?.data !== undefined) payload.error.data = error.data;
    return this.write(JSON.stringify(payload));
  }

  write(payload) {
    // A closed peer cannot receive the reply; the caller's pending promise is
    // already rejected by the close handler, so there is nothing to salvage.
    if (this.closed || !this.proc) return false;
    try {
      this.proc.stdin.write(payload + '\n', 'utf8');
      return true;
    } catch (err) {
      this.emit('writeError', err);
      return false;
    }
  }

  request(method, params = {}, timeoutMs = 60000) {
    if (this.closed || !this.proc) {
      return Promise.reject(new Error(`Cannot send request '${method}': ACP process not running`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
      this.pending.set(id, {
        method,
        resolve: (val) => {
          if (timer) clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.proc.stdin.write(payload, 'utf8', (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method, params = {}) {
    if (this.closed || !this.proc) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.proc.stdin.write(payload, 'utf8');
  }

  isAlive() {
    return !this.closed && Boolean(this.proc && !this.proc.killed);
  }

  close() {
    this.closed = true;
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {}
      this.proc = null;
    }
  }
}

/**
 * Shape a thrown failure into a JSON-RPC error object. An `AcpError` keeps its
 * own code, so a rejected parameter answers -32602 rather than a generic
 * internal error; anything else is an internal error carrying its message.
 * Transport-level sentinels (a string code) have no JSON-RPC number, so they
 * fall back to the internal error code.
 */
function errorForResponse(err, method) {
  const message = (err && err.message) || `ACP client failed to handle '${method}'`;
  if (err instanceof AcpError && typeof err.code === 'number') {
    return { code: err.code, message, data: err.data };
  }
  return { code: ACP_ERROR.INTERNAL_ERROR, message };
}

