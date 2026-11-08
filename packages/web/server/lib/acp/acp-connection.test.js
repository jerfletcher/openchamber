import { describe, it, expect } from 'vitest';
import { AcpConnection } from './acp-connection.js';
import { AcpError, isAcpCancelledError } from './acp-protocol.js';

describe('AcpConnection', () => {
  it('handles request and response over mock stdio process', async () => {
    // Run a small node/bun script that echoes a JSON-RPC response
    const conn = new AcpConnection(process.execPath, [
      '-e',
      `
      process.stdin.on('data', chunk => {
        const msg = JSON.parse(chunk.toString().trim());
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { server: 'test-acp', version: '1.0' } }) + '\\n');
        }
      });
      `
    ]);

    conn.start();
    const result = await conn.request('initialize', { client: 'openchamber' });
    expect(result).toEqual({ server: 'test-acp', version: '1.0' });
    conn.close();
  });

  it('receives and emits notifications', async () => {
    const conn = new AcpConnection(process.execPath, [
      '-e',
      `
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { text: 'hello chunk' } }) + '\\n');
      `
    ]);

    const received = [];
    conn.on('session/update', (params) => {
      received.push(params);
    });

    conn.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toEqual([{ text: 'hello chunk' }]);
    conn.close();
  });

  it('connects to real agy acp if present on host', async () => {
    const conn = new AcpConnection('agy', ['acp', '--stdio', '--dangerously-skip-permissions']);
    conn.start();
    const init = await conn.request('initialize', {
      clientInfo: { name: 'openchamber-test', version: '1.0' },
      capabilities: {}
    });
    expect(init.agentInfo.name).toBe('Antigravity ACP Server');
    conn.close();
  });
});

describe('AcpConnection error mapping', () => {
  const respondWithError = (error) => new AcpConnection(process.execPath, [
    '-e',
    `
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: ${JSON.stringify(error)} }));
    });
    `,
  ]);

  it('maps the cancellation code to a typed cancelled error', async () => {
    const conn = respondWithError({ code: -32800, message: 'Request cancelled' });
    conn.start();
    const err = await conn.request('session/prompt', {}).catch((e) => e);
    expect(err.code).toBe(-32800);
    expect(err.kind).toBe('cancelled');
    expect(err.method).toBe('session/prompt');
    expect(isAcpCancelledError(err)).toBe(true);
    conn.close();
  });

  it('maps a resource-not-found code without losing its data', async () => {
    const conn = respondWithError({ code: -32002, message: 'Resource not found', data: { sessionId: 'sess_x' } });
    conn.start();
    const err = await conn.request('session/load', {}).catch((e) => e);
    expect(err).toBeInstanceOf(AcpError);
    expect(err.kind).toBe('resource-not-found');
    expect(err.data).toEqual({ sessionId: 'sess_x' });
    conn.close();
  });

  it('treats an unrecognized code as a generic failure carrying the raw code', async () => {
    const conn = respondWithError({ code: -31999, message: 'Vendor failure' });
    conn.start();
    const err = await conn.request('session/prompt', {}).catch((e) => e);
    expect(err.kind).toBe('unknown');
    expect(err.code).toBe(-31999);
    expect(isAcpCancelledError(err)).toBe(false);
    conn.close();
  });
});

/**
 * An agent-initiated request is the half of ACP the client used to be deaf to:
 * a JSON-RPC message with an id we never sent, plus a method. The fixture agent
 * asks, then echoes whatever the client replied as a notification, so the test
 * asserts the exact wire shape (same id, result vs error) without guessing.
 */
const askingAgent = (request) => `
const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
send(${JSON.stringify(request)});
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  // The client's answer to our request: same id, no method.
  if (msg.id === ${JSON.stringify(request.id)} && msg.method === undefined) {
    send({ jsonrpc: '2.0', method: 'test/reply', params: msg });
  }
});
`;

describe('AcpConnection agent-initiated requests', () => {
  const nextReply = (conn) => new Promise((resolve) => conn.once('test/reply', resolve));

  it('dispatches a request to its registered handler and replies with the same id', async () => {
    const conn = new AcpConnection(process.execPath, ['-e', askingAgent({
      jsonrpc: '2.0',
      id: 9,
      method: 'session/request_permission',
      params: { sessionId: 'sess_1', options: [] },
    })]);
    conn.registerRequestHandler('session/request_permission', (params, meta) => ({
      outcome: { outcome: 'cancelled' },
      echoedSession: params.sessionId,
      echoedId: meta.id,
    }));
    conn.start();
    const reply = await nextReply(conn);
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { outcome: { outcome: 'cancelled' }, echoedSession: 'sess_1', echoedId: 9 },
    });
    conn.close();
  });

  it('answers an unhandled request with -32601 instead of hanging', async () => {
    const conn = new AcpConnection(process.execPath, ['-e', askingAgent({
      jsonrpc: '2.0',
      id: 12,
      method: 'fs/read_text_file',
      params: { path: '/etc/hosts' },
    })]);
    conn.start();
    const reply = await nextReply(conn);
    expect(reply.id).toBe(12);
    expect(reply.result).toBeUndefined();
    expect(reply.error.code).toBe(-32601);
    conn.close();
  });

  it('turns a thrown AcpError into an error response with its own code', async () => {
    const conn = new AcpConnection(process.execPath, ['-e', askingAgent({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/request_permission',
      params: {},
    })]);
    conn.registerRequestHandler('session/request_permission', () => {
      throw new AcpError({ code: -32602, message: 'sessionId is required' });
    });
    conn.start();
    const reply = await nextReply(conn);
    expect(reply.id).toBe(3);
    expect(reply.error).toEqual({ code: -32602, message: 'sessionId is required' });
    conn.close();
  });

  it('still treats an id-less method as a notification, never as a request', async () => {
    const conn = new AcpConnection(process.execPath, ['-e', `
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'plan', entries: [] } } }) + '\\n');
    `]);
    const requests = [];
    const notifications = [];
    conn.on('request', (request) => requests.push(request));
    conn.on('notification', (notification) => notifications.push(notification));
    conn.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(requests).toEqual([]);
    expect(notifications).toEqual([{
      method: 'session/update',
      params: { update: { sessionUpdate: 'plan', entries: [] } },
    }]);
    conn.close();
  });
});
