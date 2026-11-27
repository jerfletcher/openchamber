
import { buildResult } from '../../utils/index.js';
import { resolveAntigravityAuth, DEFAULT_PROJECT_ID, type AntigravityAuth } from './auth.js';
import {
  refreshAntigravityToken,
  fetchAntigravityModels,
  fetchAntigravityQuotaSummary
} from './api.js';
import { transformSummary, transformModels } from './transforms.js';
import { warnIfGeminiGroupMissing } from './client.js';

export { isConfigured } from './auth.js';

export const providerId = 'antigravity';
export const providerName = 'Antigravity';

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60_000;

const hasValidAccessToken = (auth: AntigravityAuth): auth is AntigravityAuth & { accessToken: string } => {
  if (!auth.accessToken) return false;
  if (!auth.accessTokenExpiry) return !auth.refreshToken;
  const expiryMs = Date.parse(auth.accessTokenExpiry);
  return Number.isFinite(expiryMs) && expiryMs > Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
};

const fetchModelsWithToken = async (accessToken: string, projectId: string) => {
  const [summaryPayload, modelsPayload] = await Promise.all([
    fetchAntigravityQuotaSummary(accessToken, projectId),
    fetchAntigravityModels(accessToken, projectId)
  ]);

  warnIfGeminiGroupMissing(summaryPayload);
  const { modelGroupWindows } = transformSummary(summaryPayload);
  return transformModels(modelsPayload, modelGroupWindows);
};

export const fetchQuota = async () => {
  const auth = resolveAntigravityAuth();
  if (!auth) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const projectId = auth.projectId ?? DEFAULT_PROJECT_ID;
  let models: ReturnType<typeof transformModels> | null = null;
  let usedDirectToken = false;

  if (hasValidAccessToken(auth)) {
    usedDirectToken = true;
    models = await fetchModelsWithToken(auth.accessToken, projectId);
  }

  if (!models || !Object.keys(models).length) {
    if (!usedDirectToken || auth.refreshToken) {
      const accessToken = await refreshAntigravityToken(auth.refreshToken);
      if (!accessToken) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: 'Failed to refresh Antigravity token'
        });
      }
      models = await fetchModelsWithToken(accessToken, projectId);
    }
  }

  if (!models || !Object.keys(models).length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: 'Failed to fetch Antigravity quota'
    });
  }

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: {
      windows: {},
      models: Object.keys(models).length ? models : undefined
    }
  });
};
