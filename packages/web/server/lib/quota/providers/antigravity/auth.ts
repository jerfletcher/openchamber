
import {
  ANTIGRAVITY_ACCOUNTS_PATHS,
  ANTIGRAVITY_CLI_TOKEN_PATHS,
  readJsonFile,
  asNonEmptyString,
  toNumber
} from '../../utils/index.js';

const parseGoogleRefreshToken = (rawRefreshToken: unknown) => {
  const refreshToken = asNonEmptyString(rawRefreshToken);
  if (!refreshToken) {
    return { refreshToken: null, projectId: null, managedProjectId: null };
  }
  const [rawToken = '', rawProject = '', rawManagedProject = ''] = refreshToken.split('|');
  return {
    refreshToken: asNonEmptyString(rawToken),
    projectId: asNonEmptyString(rawProject),
    managedProjectId: asNonEmptyString(rawManagedProject)
  };
};

export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export interface AntigravityAuth {
  sourceId: 'antigravity';
  sourceLabel: 'Antigravity';
  refreshToken: string | null;
  accessToken?: string | null;
  accessTokenExpiry?: string | null;
  projectId: string | null;
  email: unknown;
}

interface AccountsFile {
  accounts?: unknown;
  activeIndex?: unknown;
}

interface Account {
  refreshToken?: unknown;
  projectId?: unknown;
  managedProjectId?: unknown;
  email?: unknown;
}

interface CliTokenFile {
  id_token_email?: unknown;
  token?: unknown;
}

interface CliTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expiry?: unknown;
}

const isCliTokenFile = (value: unknown): value is CliTokenFile =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isCliTokenPayload = (value: unknown): value is CliTokenPayload =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isAccountsFile = (value: unknown): value is AccountsFile =>
  value !== null && typeof value === 'object';

const isAccount = (value: unknown): value is Account =>
  value !== null && typeof value === 'object';

export const resolveAntigravityAuth = (): AntigravityAuth | null => {
  for (const filePath of ANTIGRAVITY_ACCOUNTS_PATHS) {
    const input: unknown = readJsonFile(filePath);
    const data = isAccountsFile(input) ? input : null;
    const accounts = data?.accounts;
    if (Array.isArray(accounts) && accounts.length > 0) {
      const parsedIndex = toNumber(data?.activeIndex);
      const index = parsedIndex !== null ? parsedIndex : 0;
      const account: unknown = accounts[index] ?? accounts[0];
      if (isAccount(account) && account.refreshToken) {
        const refreshParts = parseGoogleRefreshToken(account.refreshToken);
        return {
          sourceId: 'antigravity',
          sourceLabel: 'Antigravity',
          refreshToken: refreshParts.refreshToken,
          projectId: asNonEmptyString(account.projectId)
            ?? asNonEmptyString(account.managedProjectId)
            ?? refreshParts.projectId
            ?? refreshParts.managedProjectId,
          email: account.email
        };
      }
    }
  }

  for (const filePath of ANTIGRAVITY_CLI_TOKEN_PATHS) {
    const input: unknown = readJsonFile(filePath);
    const data = isCliTokenFile(input) ? input : null;
    const token = isCliTokenPayload(data?.token) ? data.token : null;
    if (!token) continue;
    const accessToken = asNonEmptyString(token.access_token);
    const refreshToken = asNonEmptyString(token.refresh_token);
    if (!refreshToken && !accessToken) continue;

    return {
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      refreshToken,
      accessToken,
      accessTokenExpiry: asNonEmptyString(token.expiry),
      projectId: null,
      email: asNonEmptyString(data?.id_token_email) ?? data?.id_token_email
    };
  }

  return null;
};

export const isConfigured = () => resolveAntigravityAuth() !== null;
