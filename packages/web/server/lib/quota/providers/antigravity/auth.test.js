import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANTIGRAVITY_ACCOUNTS_PATHS, ANTIGRAVITY_CLI_TOKEN_PATHS } from '../../utils/index.js';
import { resolveAntigravityAuth } from './auth.js';

const originalPaths = [...ANTIGRAVITY_ACCOUNTS_PATHS];
const originalCliPaths = [...ANTIGRAVITY_CLI_TOKEN_PATHS];
let directory;
let firstPath;
let secondPath;
let cliTokenPath;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'antigravity-auth-'));
  firstPath = join(directory, 'first.json');
  secondPath = join(directory, 'second.json');
  cliTokenPath = join(directory, 'antigravity-oauth-token');
  ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length, firstPath, secondPath);
  ANTIGRAVITY_CLI_TOKEN_PATHS.splice(0, ANTIGRAVITY_CLI_TOKEN_PATHS.length, cliTokenPath);
});

afterEach(() => {
  ANTIGRAVITY_ACCOUNTS_PATHS.splice(0, ANTIGRAVITY_ACCOUNTS_PATHS.length, ...originalPaths);
  ANTIGRAVITY_CLI_TOKEN_PATHS.splice(0, ANTIGRAVITY_CLI_TOKEN_PATHS.length, ...originalCliPaths);
  rmSync(directory, { recursive: true, force: true });
});

describe('Antigravity accounts file boundary', () => {
  it('skips absent, primitive and empty accounts files', () => {
    for (const value of [null, false, 3, 'text', [], {}, { accounts: [] }, { accounts: 'constructor' }]) {
      writeFileSync(firstPath, JSON.stringify(value));
      expect(resolveAntigravityAuth()).toBeNull();
    }
  });

  it('keeps active-account fallback and packed project context', () => {
    writeFileSync(firstPath, JSON.stringify({
      activeIndex: '99',
      accounts: [{ refreshToken: 'token|packed-project|managed-project', email: 42 }],
    }));
    expect(resolveAntigravityAuth()).toEqual({
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken: 'token',
      projectId: 'packed-project',
      email: 42,
    });
  });

  it('keeps a truthy non-string refresh token configured with a null parsed token', () => {
    writeFileSync(firstPath, JSON.stringify({ accounts: [{ refreshToken: 42 }] }));
    expect(resolveAntigravityAuth()).toEqual({
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken: null,
      projectId: null,
      email: undefined,
    });
  });

  it('continues to the next file when the selected account has no token', () => {
    writeFileSync(firstPath, JSON.stringify({ accounts: [null, { refreshToken: 'unused' }] }));
    writeFileSync(secondPath, JSON.stringify({ accounts: [{ refreshToken: 'selected', managedProjectId: 'managed' }] }));
    expect(resolveAntigravityAuth()?.projectId).toBe('managed');
  });

  it('falls back to antigravity-oauth-token when accounts files are absent', () => {
    writeFileSync(cliTokenPath, JSON.stringify({
      auth_method: 'oauth',
      id_token_email: 'user@example.com',
      token: {
        access_token: 'cli-access',
        refresh_token: 'cli-refresh',
        expiry: '2099-01-01T00:00:00Z',
        expires_in: 3600,
        token_type: 'Bearer',
      },
    }));

    expect(resolveAntigravityAuth()).toEqual({
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken: 'cli-refresh',
      accessToken: 'cli-access',
      accessTokenExpiry: '2099-01-01T00:00:00Z',
      projectId: null,
      email: 'user@example.com',
    });
  });

  it('skips malformed antigravity-oauth-token files without tokens', () => {
    for (const payload of [null, {}, { token: null }, { token: {} }, { token: { expiry: '2099-01-01T00:00:00Z' } }]) {
      writeFileSync(cliTokenPath, JSON.stringify(payload));
      expect(resolveAntigravityAuth()).toBeNull();
    }
  });
});
