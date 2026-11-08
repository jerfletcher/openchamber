import { runtimeFetch } from '@/lib/runtime-fetch';
import type { AcpPermissionRequest } from './types';

/**
 * The two calls the permission prompt makes against the server
 * (`packages/web/server/lib/acp/acp-routes.js`).
 *
 * A reply is bound to one request id: the agent is blocked on it, so a failure
 * must reach the caller (the panel keeps the prompt open) instead of reading as
 * an answer. Dismissing the prompt sends the `cancelled` outcome — never a
 * fabricated option, and never a default approval.
 */

const permissionsPath = (sessionID: string, requestID?: string): string => {
    const base = `/api/acp/v1/sessions/${encodeURIComponent(sessionID)}/permissions`;
    return requestID === undefined ? base : `${base}/${encodeURIComponent(requestID)}`;
};

export class AcpPermissionRequestError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'AcpPermissionRequestError';
        this.status = status;
    }
}

const readFailure = async (response: Response): Promise<string> => {
    try {
        const body = await response.json() as { error?: unknown; acpError?: { message?: unknown } };
        if (typeof body?.acpError?.message === 'string') return body.acpError.message;
        if (typeof body?.error === 'string') return body.error;
    } catch {
        // A non-JSON failure still needs a message; the status says enough.
    }
    return `Permission request failed (HTTP ${response.status})`;
};

/** Pending prompts of one session, for a client that just (re)connected. */
export const listAcpPermissions = async (sessionID: string): Promise<AcpPermissionRequest[]> => {
    const response = await runtimeFetch(permissionsPath(sessionID), { headers: { accept: 'application/json' } });
    if (!response.ok) throw new AcpPermissionRequestError(await readFailure(response), response.status);
    const body = await response.json() as { permissions?: AcpPermissionRequest[] };
    return Array.isArray(body?.permissions) ? body.permissions : [];
};

/**
 * Answer one prompt. `optionId` null means the user dismissed it, which the
 * agent receives as `{"outcome":{"outcome":"cancelled"}}`.
 */
export const respondToAcpPermission = async (
    sessionID: string,
    requestID: string,
    optionId: string | null,
): Promise<{ outcome: 'selected' | 'cancelled'; optionId?: string }> => {
    const response = await runtimeFetch(permissionsPath(sessionID, requestID), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(optionId === null ? { outcome: 'cancelled' } : { optionId }),
    });
    if (!response.ok) throw new AcpPermissionRequestError(await readFailure(response), response.status);
    const body = await response.json() as { outcome?: 'selected' | 'cancelled'; optionId?: string };
    return { outcome: body?.outcome === 'selected' ? 'selected' : 'cancelled', ...(body?.optionId ? { optionId: body.optionId } : {}) };
};
