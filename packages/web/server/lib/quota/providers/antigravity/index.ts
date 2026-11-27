import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildResult, toTimestamp, toUsageWindow } from '../../utils/index.js';
import type { UsageWindow } from '../../utils/contracts.js';
import { resolveAntigravityAuth } from './auth.js';

export { isConfigured } from './auth.js';

export const providerId = 'antigravity';
export const providerName = 'Antigravity';

const execFileAsync = promisify(execFile);
const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEKLY_SECONDS = 7 * 24 * 60 * 60;

interface AgyUsageBucket {
  id?: string;
  window?: string;
  remaining_fraction?: number;
  reset_time?: string;
}

interface AgyUsageGroup {
  name?: string;
  buckets?: AgyUsageBucket[];
}

interface AgyUsagePayload {
  command?: {
    data?: {
      groups?: AgyUsageGroup[];
    };
  };
}

export const transformAgyUsagePayload = (payload: unknown): Record<string, UsageWindow> => {
  const groups = (payload as AgyUsagePayload | null)?.command?.data?.groups;
  if (!Array.isArray(groups)) return {};

  const windows: Record<string, UsageWindow> = {};
  for (const group of groups) {
    const groupName = typeof group?.name === 'string' && group.name.trim() ? group.name.trim() : null;
    if (!groupName || !Array.isArray(group.buckets)) continue;

    for (const bucket of group.buckets) {
      const win = typeof bucket?.window === 'string' && bucket.window.trim() ? bucket.window.trim() : null;
      if (!win) continue;

      const remaining = typeof bucket.remaining_fraction === 'number' && Number.isFinite(bucket.remaining_fraction)
        ? bucket.remaining_fraction
        : null;
      const usedPercent = remaining !== null
        ? Math.max(0, Math.min(100, Math.round((1 - remaining) * 100)))
        : null;

      const parsedReset = toTimestamp(bucket.reset_time);
      const resetAt = parsedReset !== null && parsedReset > 0 ? parsedReset : null;
      const windowSeconds = win === 'weekly' ? WEEKLY_SECONDS : FIVE_HOUR_SECONDS;

      windows[`${groupName} (${win})`] = toUsageWindow({
        usedPercent,
        windowSeconds,
        resetAt
      });
    }
  }

  return windows;
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

  try {
    const { stdout } = await execFileAsync('agy', ['--print=/usage', '--output-format=json'], {
      cwd: '/tmp',
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    const payload = JSON.parse(stdout);
    const windows = transformAgyUsagePayload(payload);

    if (!Object.keys(windows).length) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'Failed to parse Antigravity usage groups'
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Failed to fetch Antigravity quota'
    });
  }
};
