import { create } from 'zustand';
import type { SyncEvent } from '@/lib/opencode/events';
import type { AcpPermissionRequest } from '@/lib/acp/types';

/**
 * Pending ACP permission prompts, keyed by the OpenChamber session they belong
 * to. An ACP agent blocks on `session/request_permission`, so these are the one
 * piece of chat state that must not live only in a directory store: the session
 * may never be opened while the agent waits.
 *
 * The store is fed by the server's control-stream announcements
 * (`openchamber.acp-permission-asked` / `-settled`), never by OpenCode's event
 * stream — the prompt is OpenChamber-owned.
 */

type AcpPermissionsState = {
    bySession: ReadonlyMap<string, readonly AcpPermissionRequest[]>;
};

const EMPTY: readonly AcpPermissionRequest[] = [];

export const useAcpPermissionsStore = create<AcpPermissionsState>(() => ({
    bySession: new Map(),
}));

const upsert = (list: readonly AcpPermissionRequest[], request: AcpPermissionRequest): readonly AcpPermissionRequest[] => {
    const index = list.findIndex((entry) => entry.requestId === request.requestId);
    if (index === -1) return [...list, request];
    const next = [...list];
    next[index] = request;
    return next;
};

/** Apply the two lifecycle events. Returns true when the store changed. */
export const applyAcpPermissionEvents = (payloads: readonly SyncEvent[]): boolean => {
    const state = useAcpPermissionsStore.getState();
    let draft: Map<string, readonly AcpPermissionRequest[]> | null = null;
    const write = (sessionID: string, list: readonly AcpPermissionRequest[]) => {
        draft ??= new Map(state.bySession);
        if (list.length === 0) draft.delete(sessionID);
        else draft.set(sessionID, list);
    };

    for (const payload of payloads) {
        if (payload.type !== 'openchamber.acp-permission-asked' && payload.type !== 'openchamber.acp-permission-settled') continue;
        const event = payload;
        const sessionID = event.properties.sessionID;
        if (!sessionID) continue;
        const current = (draft ?? state.bySession).get(sessionID) ?? EMPTY;
        if (event.type === 'openchamber.acp-permission-asked') {
            const { sessionID: _sessionID, ...rest } = event.properties;
            write(sessionID, upsert(current, { sessionID, ...rest }));
            continue;
        }
        const remaining = current.filter((entry) => entry.requestId !== event.properties.requestId);
        if (remaining.length !== current.length) write(sessionID, remaining);
    }

    if (!draft) return false;
    useAcpPermissionsStore.setState({ bySession: draft });
    return true;
};

/** Replace a session's pending list (a fresh client's seed). */
export const setAcpPermissions = (sessionID: string, requests: readonly AcpPermissionRequest[]): void => {
    const state = useAcpPermissionsStore.getState();
    const next = new Map(state.bySession);
    if (requests.length === 0) next.delete(sessionID);
    else next.set(sessionID, requests);
    useAcpPermissionsStore.setState({ bySession: next });
};

/**
 * Seed from the server only when nothing is known for the session, so a live
 * event that arrived during the read is never overwritten by older state.
 */
export const seedAcpPermissions = (sessionID: string, requests: readonly AcpPermissionRequest[]): void => {
    const state = useAcpPermissionsStore.getState();
    if (state.bySession.has(sessionID) || requests.length === 0) return;
    setAcpPermissions(sessionID, requests);
};

export const resetAcpPermissions = (): void => {
    useAcpPermissionsStore.setState({ bySession: new Map() });
};

/** The prompts waiting on this session, oldest first. */
export const selectAcpPermissions = (
    state: AcpPermissionsState,
    sessionID: string | null | undefined,
): readonly AcpPermissionRequest[] => (sessionID ? state.bySession.get(sessionID) ?? EMPTY : EMPTY);

/** A hook, not a plain selector, so a missing session does not allocate per render. */
export const useAcpPermissions = (sessionID: string | null | undefined): readonly AcpPermissionRequest[] => (
    useAcpPermissionsStore((state) => selectAcpPermissions(state, sessionID))
);
