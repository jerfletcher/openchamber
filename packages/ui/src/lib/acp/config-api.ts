import { runtimeFetch } from '@/lib/runtime-fetch';
import type { AcpConfigOption, AcpSessionConfig } from './types';

const sessionConfigPath = (sessionID: string, suffix: 'config' | 'model' | 'mode'): string => (
    `/api/acp/sessions/${encodeURIComponent(sessionID)}/${suffix}`
);

export class AcpConfigRequestError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'AcpConfigRequestError';
        this.status = status;
    }
}

const readFailure = async (response: Response): Promise<string> => {
    try {
        const body = await response.json() as { error?: unknown; acpError?: { message?: unknown } };
        if (typeof body?.acpError?.message === 'string') return body.acpError.message;
        if (typeof body?.error === 'string') return body.error;
    } catch {
        // Non-JSON failure; fall back to status text.
    }
    return `ACP config request failed (HTTP ${response.status})`;
};

export type SetAcpConfigOptionResult = {
    success?: boolean;
    configId?: string;
    value?: string;
    method?: string;
    configOptions?: AcpConfigOption[];
};

export type SetAcpModelOrModeResult = {
    success?: boolean;
    configOptions?: AcpConfigOption[];
    currentModeId?: string;
    currentModelId?: string;
};

/** Read the configurable surface (configOptions, modes, models, capabilities) of an ACP session. */
export const getAcpSessionConfig = async (sessionID: string): Promise<AcpSessionConfig> => {
    const response = await runtimeFetch(sessionConfigPath(sessionID, 'config'), {
        headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new AcpConfigRequestError(await readFailure(response), response.status);
    return await response.json() as AcpSessionConfig;
};

/** Update a single ACP configOption (e.g. `mode`, `model`, `thought_level`). */
export const setAcpConfigOption = async (
    sessionID: string,
    configId: string,
    value: string,
): Promise<SetAcpConfigOptionResult> => {
    const response = await runtimeFetch(sessionConfigPath(sessionID, 'config'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ configId, value }),
    });
    if (!response.ok) throw new AcpConfigRequestError(await readFailure(response), response.status);
    return await response.json() as SetAcpConfigOptionResult;
};

/** Set the active model on an ACP session. */
export const setAcpSessionModel = async (
    sessionID: string,
    modelId: string,
): Promise<SetAcpModelOrModeResult> => {
    const response = await runtimeFetch(sessionConfigPath(sessionID, 'model'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelId }),
    });
    if (!response.ok) throw new AcpConfigRequestError(await readFailure(response), response.status);
    return await response.json() as SetAcpModelOrModeResult;
};

/** Set the active mode on an ACP session. */
export const setAcpSessionMode = async (
    sessionID: string,
    modeId: string,
): Promise<SetAcpModelOrModeResult> => {
    const response = await runtimeFetch(sessionConfigPath(sessionID, 'mode'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modeId }),
    });
    if (!response.ok) throw new AcpConfigRequestError(await readFailure(response), response.status);
    return await response.json() as SetAcpModelOrModeResult;
};
