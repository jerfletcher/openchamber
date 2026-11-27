import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANTIGRAVITY_ACCOUNTS_PATHS, ANTIGRAVITY_CLI_TOKEN_PATHS } from '../../utils/index.js';
import { fetchQuota } from './index.js';

const originalPaths = [...ANTIGRAVITY_ACCOUNTS_PATHS];
const originalCliPaths = [...ANTIGRAVITY_CLI_TOKEN_PATHS];
let directory;
let accountPath;
let cliTokenPath;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'antigravity-provider-'));
  accountPath = join(directory, 'accounts.json');
  cliTokenPath = join(directory, 'antigravity-oauth-token');
  ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length, accountPath);
  ANTIGRAVITY_CLI_TOKEN_PATHS.splice(0, ANTIGRAVITY_CLI_TOKEN_PATHS.length, cliTokenPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
  ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length, ...originalPaths);
  ANTIGRAVITY_CLI_TOKEN_PATHS.splice(0, ANTIGRAVITY_CLI_TOKEN_PATHS.length, ...originalCliPaths);
  rmSync(directory, { recursive: true, force: true });
});

const account = (refreshToken = 'test-refresh') => {
  writeFileSync(accountPath, JSON.stringify({ accounts: [{ refreshToken }] }));
};

describe('Antigravity provider composition', () => {
  it('reports an unconfigured account without making requests', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await fetchQuota()).toMatchObject({
      providerId: 'antigravity', ok: false, configured: false,
      error: 'Not configured', usage: null
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the null refresh token forwarded to OAuth', async () => {
    account(42);
    const fetch = vi.fn(async (_url, options) => {
      expect(new URLSearchParams(options.body).get('refresh_token')).toBe('null');
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await fetchQuota()).toMatchObject({
      ok: false, configured: true,
      error: 'Failed to refresh Antigravity token', usage: null
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports empty model results after a successful refresh', async () => {
    account();
    vi.stubGlobal('fetch', async (url) => Response.json(
      url === 'https://oauth2.googleapis.com/token' ? { access_token: 'test-access' } : {}
    ));
    expect(await fetchQuota()).toMatchObject({
      ok: false, configured: true,
      error: 'Failed to fetch Antigravity quota', usage: null
    });
  });

  it('returns model windows using the default project', async () => {
    account();
    vi.stubGlobal('fetch', async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'test-access' });
      }
      expect(JSON.parse(options.body)).toEqual({ project: 'rising-fact-p41fc' });
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-access');
      return Response.json(url.endsWith(':retrieveUserQuotaSummary') ? {} : {
        models: { 'gemini-test': { quotaInfo: { remainingFraction: 0.75 } } }
      });
    });
    expect(await fetchQuota()).toMatchObject({
      ok: true, configured: true,
      usage: { windows: {}, models: { 'gemini-test': { windows: {
        '5h': { usedPercent: 25, remainingPercent: 75 }
      } } } }
    });
  });

  it('uses fresh access_token from antigravity-oauth-token without calling OAuth refresh', async () => {
    const futureExpiry = new Date(Date.now() + 30 * 60_000).toISOString();
    writeFileSync(cliTokenPath, JSON.stringify({
      id_token_email: 'cli@example.com',
      token: { access_token: 'cli-access-fresh', refresh_token: 'cli-refresh', expiry: futureExpiry },
    }));
    const fetch = vi.fn(async (url, options) => {
      expect(url).not.toBe('https://oauth2.googleapis.com/token');
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer cli-access-fresh');
      return Response.json(url.endsWith(':retrieveUserQuotaSummary') ? {} : {
        models: { 'gemini-test': { quotaInfo: { remainingFraction: 0.5 } } }
      });
    });
    vi.stubGlobal('fetch', fetch);

    expect(await fetchQuota()).toMatchObject({
      ok: true, configured: true,
      usage: { windows: {}, models: { 'gemini-test': { windows: {
        '5h': { usedPercent: 50, remainingPercent: 50 }
      } } } }
    });
  });

  it('refreshes when antigravity-oauth-token access_token is expired or rejected', async () => {
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(cliTokenPath, JSON.stringify({
      token: { access_token: 'cli-access-stale', refresh_token: 'cli-refresh', expiry: pastExpiry },
    }));
    const fetch = vi.fn(async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        expect(new URLSearchParams(options.body).get('refresh_token')).toBe('cli-refresh');
        return Response.json({ access_token: 'cli-access-refreshed' });
      }
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer cli-access-refreshed');
      return Response.json(url.endsWith(':retrieveUserQuotaSummary') ? {} : {
        models: { 'gemini-test': { quotaInfo: { remainingFraction: 0.8 } } }
      });
    });
    vi.stubGlobal('fetch', fetch);

    expect(await fetchQuota()).toMatchObject({
      ok: true, configured: true,
      usage: { windows: {}, models: { 'gemini-test': { windows: {
        '5h': { usedPercent: 20, remainingPercent: 80 }
      } } } }
    });
  });

  it('falls back to refresh when fresh antigravity-oauth-token access_token fails quota fetch', async () => {
    const futureExpiry = new Date(Date.now() + 30 * 60_000).toISOString();
    writeFileSync(cliTokenPath, JSON.stringify({
      token: { access_token: 'cli-access-revoked', refresh_token: 'cli-refresh', expiry: futureExpiry },
    }));
    const fetch = vi.fn(async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        expect(new URLSearchParams(options.body).get('refresh_token')).toBe('cli-refresh');
        return Response.json({ access_token: 'cli-access-fallback' });
      }
      const authHeader = new Headers(options.headers).get('Authorization');
      if (authHeader === 'Bearer cli-access-revoked') {
        return new Response('unauthorized', { status: 401 });
      }
      expect(authHeader).toBe('Bearer cli-access-fallback');
      return Response.json(url.endsWith(':retrieveUserQuotaSummary') ? {} : {
        models: { 'gemini-test': { quotaInfo: { remainingFraction: 0.9 } } }
      });
    });
    vi.stubGlobal('fetch', fetch);

    expect(await fetchQuota()).toMatchObject({
      ok: true, configured: true,
      usage: { windows: {}, models: { 'gemini-test': { windows: {
        '5h': { usedPercent: 10, remainingPercent: 90 }
      } } } }
    });
  });
});
