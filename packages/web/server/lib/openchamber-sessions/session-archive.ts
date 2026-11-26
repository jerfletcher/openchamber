import { hasMessage, hasTag } from './contracts.js';
import type { createArchiveStore } from './archive-store.js';
import type { SessionClient } from './opencode-client-contract.js';
import { getAcpSessionBridge } from '../acp/acp-session-bridge.js';

export interface AcpArchiveBridge {
  isAcpSession?: (sessionID: string) => boolean;
  getSession: (sessionID: string) => { archived?: boolean; time?: { archived?: number | null; updated?: number } } | null;
  updateSession: (sessionID: string, updates: { archived?: boolean }) => unknown;
}

const CONCURRENCY = 6;

const isArchiveTimestamp = (value: unknown): value is number => typeof value === 'number';

const mapLimited = async <Item, Result>(items: Item[], limit: number, work: (item: Item) => Promise<Result>) => {
  const results = new Array<Result>(items.length);
  const values = items.values();
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = values.next();
      if (item.done) return;
      results[index] = await work(item.value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
};

export interface ArchiveReadOptions {
  signal?: AbortSignal | undefined;
}

export interface OpenCodeSessionArchive {
  setArchived: (sessionID: string, archived: boolean) => Promise<unknown>;
  readArchivedAt: (sessionID: string, options?: ArchiveReadOptions) => Promise<number | null | undefined>;
}

export const createOpenCodeSessionArchive = ({ clientFor, acpBridge }: { clientFor: () => SessionClient; acpBridge?: AcpArchiveBridge }): OpenCodeSessionArchive => ({
  setArchived: async (sessionID, archived) => {
    const bridge = acpBridge ?? getAcpSessionBridge();
    if (bridge?.isAcpSession?.(sessionID)) {
      const updated = bridge.updateSession(sessionID, { archived });
      if (!updated) {
        const err = new Error(`ACP session not found: ${sessionID}`) as Error & { _tag?: string };
        err._tag = 'SessionNotFoundError';
        throw err;
      }
      return 'acp';
    }
    return clientFor().session.update({ sessionID, archived });
  },
  readArchivedAt: async (sessionID, { signal } = {}) => {
    const bridge = acpBridge ?? getAcpSessionBridge();
    if (bridge?.isAcpSession?.(sessionID)) {
      const session = bridge.getSession(sessionID);
      if (!session) return undefined;
      return session.time?.archived ?? (session.archived ? (session.time?.updated ?? 1) : null);
    }
    try {
      const session = await clientFor().session.get({ sessionID }, { signal });
      return session.time?.archived ?? null;
    } catch (error) {
      if (hasTag(error) && error._tag === 'SessionNotFoundError') return undefined;
      throw error;
    }
  },
});

interface SessionArchiveOptions {
  store: ReturnType<typeof createArchiveStore>;
  openCode: OpenCodeSessionArchive;
  announce?: (sessionID: string, archivedAt: number | null) => void;
}

export const createSessionArchive = ({ store, openCode, announce = () => {} }: SessionArchiveOptions) => {
  const sessionChains = new Map<string, Promise<void>>();
  const runForSession = <Result>(id: string, work: () => Promise<Result>) => {
    const previous = sessionChains.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    sessionChains.set(id, settled);
    void settled.then(() => {
      if (sessionChains.get(id) === settled) sessionChains.delete(id);
    });
    return next;
  };

  const pushToOpenCode = async (id: string, archived: boolean) => {
    try {
      const result = await openCode.setArchived(id, archived);
      return result === 'acp' ? 'acp' : 'opencode';
    } catch (error) {
      if (hasTag(error) && error._tag === 'SessionNotFoundError') return 'unknown-session';
      console.warn(`[openchamber-sessions] could not ${archived ? 'archive' : 'unarchive'} ${id}:`, (hasMessage(error) ? error.message : undefined) ?? error);
      return 'failed';
    }
  };

  const apply = (id: string, archivedAt: number | null) => runForSession(id, async () => {
    const pushed = await pushToOpenCode(id, archivedAt !== null);
    if (pushed !== 'opencode' && pushed !== 'acp') return false;
    const hadEntry = (await store.entry(id)) !== undefined;
    const { failedIds } = await store.forget([id]);
    if (failedIds.length > 0) return false;
    if (hadEntry || pushed === 'acp') announce(id, archivedAt);
    return true;
  });

  const applyBatch = async (ids: string[], archivedAt: number | null) => {
    const held = await mapLimited(ids, CONCURRENCY, (id) => apply(id, archivedAt));
    return {
      applied: ids.filter((_, index) => held[index]),
      failedIds: ids.filter((_, index) => !held[index]),
    };
  };

  const archivedAt = async (sessionID: string) => {
    const entry = await store.entry(sessionID);
    if (entry !== undefined) return entry;
    try {
      return (await openCode.readArchivedAt(sessionID)) ?? null;
    } catch (error) {
      console.warn(`[openchamber-sessions] could not read the archive state of ${sessionID}:`, (hasMessage(error) ? error.message : undefined) ?? error);
      return null;
    }
  };

  const archiveState = async (sessionID: string, { signal }: ArchiveReadOptions = {}) => {
    try {
      const entry = await store.entry(sessionID);
      const at = entry !== undefined ? entry : await openCode.readArchivedAt(sessionID, { signal });
      return Number.isFinite(at) ? 'archived' : 'active';
    } catch {
      return 'unknown';
    }
  };

  const migrateEntry = (id: string) => runForSession(id, async () => {
    const entry = await store.entry(id);
    if (entry === undefined) return;
    if (await pushToOpenCode(id, entry !== null) === 'failed') return;
    await store.forget([id]);
  });

  const migrateLegacy = async () => {
    const pending = Object.keys(await store.getAll());
    if (pending.length === 0) return 0;
    await mapLimited(pending, CONCURRENCY, migrateEntry);
    return Object.keys(await store.getAll()).length;
  };

  return {
    archive: async (ids: string[], stamp: number) => {
      const { applied, failedIds } = await applyBatch(ids, stamp);
      return { archived: applied.map((id) => ({ id, archivedAt: stamp })), failedIds };
    },
    unarchive: async (ids: string[]) => {
      const { applied, failedIds } = await applyBatch(ids, null);
      return { restored: applied.map((id) => ({ id, archivedAt: null })), failedIds };
    },
    archivedAt,
    isArchived: async (sessionID: string) => isArchiveTimestamp(await archivedAt(sessionID)),
    archiveState,
    migrateLegacy,
  };
};
