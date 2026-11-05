import { describe, it, expect } from 'vitest';
import { AcpConnection } from './acp-connection.js';

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
