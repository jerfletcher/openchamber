import { spawn } from 'child_process';
import EventEmitter from 'events';

/**
 * Standard Agent Client Protocol (ACP) stdio JSON-RPC connection.
 * Handles line-buffered messaging, bi-directional request/response matching,
 * and agent notifications.
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
    this.buffer = '';
    this.closed = false;
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
        } catch (err) {
          this.emit('parseError', { line, error: err });
        }
      }
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  handleIncoming(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      this.emit('notification', { method: msg.method, params: msg.params });
      this.emit(msg.method, msg.params);
    }
  }

  request(method, params = {}) {
    if (this.closed || !this.proc) {
      return Promise.reject(new Error(`Cannot send request '${method}': ACP process not running`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.proc.stdin.write(payload, 'utf8', (err) => {
        if (err) {
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
