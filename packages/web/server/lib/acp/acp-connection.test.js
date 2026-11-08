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
