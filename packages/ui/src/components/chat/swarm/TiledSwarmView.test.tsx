import { describe, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

import type { Session } from '@/lib/opencode/model';

/**
 * The preset must hand the generic deck exactly the list the old inline filter
 * produced: direct children of the active session, workflow agents excluded.
 * Everything the deck does not need to compute that list is stubbed, and the
 * generic view is captured rather than rendered.
 */
let currentSessionId: string | null = 'lead';
let liveSessions: Session[] = [];
type CapturedProps = {
  sessionIds: readonly string[];
  layout: string;
  maxSlots: number;
  activeCount?: number;
  renderPane?: (args: { index: number; sessionId: string }) => React.ReactElement;
};
const setCurrentSessionSpy = mock((..._args: unknown[]) => undefined);
let captured: CapturedProps | null = null;

type UIState = {
  tiledSwarmLayout: 'auto' | 'grid-4' | 'columns-3' | 'split-2';
  setTiledSwarmLayout: (value: UIState['tiledSwarmLayout']) => void;
  toggleTiledSwarmView: () => void;
  tiledSwarmPinnedId: string | null;
  setTiledSwarmPinnedId: (id: string | null) => void;
  isSidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  closeContextPanel: (directory: string) => void;
};
const uiState: UIState = {
  tiledSwarmLayout: 'grid-4',
  setTiledSwarmLayout: () => undefined,
  toggleTiledSwarmView: () => undefined,
  tiledSwarmPinnedId: null,
  setTiledSwarmPinnedId: () => undefined,
  isSidebarOpen: true,
  setSidebarOpen: () => undefined,
  closeContextPanel: () => undefined,
};
const useUIStore = Object.assign(
  <R,>(selector: (state: UIState) => R): R => selector(uiState),
  { getState: () => uiState },
);


/**
 * bun's mock.module outlives this file and replaces the module for every file
 * that runs after it in the same process. Keep the real exports (and the real
 * store methods on stubbed hooks) so later test files are unaffected.
 */
const mockPartial = async (specifier: string, load: () => Promise<Record<string, unknown>>, overrides: Record<string, unknown>) => {
  const real = await load();
  const merged: Record<string, unknown> = { ...real };
  for (const [key, value] of Object.entries(overrides)) {
    const original = real[key];
    merged[key] = typeof value === 'function' && original && (typeof original === 'function' || typeof original === 'object')
      ? Object.assign(value, original)
      : value;
  }
  mock.module(specifier, () => merged);
};

mock.module('@/components/views/ChatView', () => ({ ChatView: () => null }));
mock.module('@/components/chat/swarm/TiledSessionsView', () => ({
  TiledSessionsView: (props: CapturedProps) => {
    captured = props;
    return null;
  },
}));
mock.module('@/components/chat/swarm/tiledLayout', () => ({
  resolveTiledLayout: (layout: UIState['tiledSwarmLayout']) => ({
    effectiveLayout: layout === 'auto' ? 'grid-4' : layout,
    gridClassName: '',
    slotCap: layout === 'split-2' ? 1 : layout === 'columns-3' ? 2 : 3,
  }),
}));
await mockPartial('@/sync/session-ui-store', () => import('@/sync/session-ui-store'), {
  useSessionUIStore: <R,>(selector: (state: { currentSessionId: string | null; setCurrentSession: (...args: unknown[]) => void }) => R): R => (
    selector({ currentSessionId, setCurrentSession: setCurrentSessionSpy })
  ),
});
mock.module('@/sync/session-actions', () => ({ abortCurrentOperation: () => Promise.resolve() }));
await mockPartial('@/sync/sync-context', () => import('@/sync/sync-context'), {
  useAllLiveSessions: () => liveSessions,
  useAllSessionStatuses: () => ({}),
  useSessionMessages: () => [],
  useSessionMessageRecords: () => [],
  useDirectorySync: (selector: (state: { permission: Record<string, unknown>; form: Record<string, unknown> }) => unknown) => (
    selector({ permission: {}, form: {} })
  ),
});
await mockPartial('@/sync/global-session-status', () => import('@/sync/global-session-status'), {
  useGlobalSessionStatusStore: (selector: (state: { statusById: Map<string, unknown>; observedById: Map<string, unknown> }) => unknown) => (
    selector({ statusById: new Map(), observedById: new Map() })
  ),
});
await mockPartial('@/lib/workflows/store', () => import('@/lib/workflows/store'), { useSessionWorkflowRuns: () => [] });
mock.module('@/hooks/useContextWindowLimits', () => ({ useContextWindowLimits: () => ({ context: 0 }) }));
mock.module('@/components/chat/work-status/useSubagentCostRollup', () => ({
  useSubagentCostRollup: () => ({ totalCost: 0, ownCost: 0, subagentCost: 0 }),
}));
await mockPartial('@/stores/useGitStore', () => import('@/stores/useGitStore'), {
  useGitStore: (selector: (state: { directories: Map<string, unknown> }) => unknown) => selector({ directories: new Map() }),
});
await mockPartial('@/hooks/useEffectiveDirectory', () => import('@/hooks/useEffectiveDirectory'), { useEffectiveDirectory: () => '/project' });
await mockPartial('@/stores/useUIStore', () => import('@/stores/useUIStore'), { useUIStore });
await mockPartial('@/hooks/useDurationTicker', () => import('@/hooks/useDurationTicker'), { useWaitingBlink: () => '' });
const realConfig = await import('@/stores/useConfigStore');
await mockPartial('@/stores/useConfigStore', () => import('@/stores/useConfigStore'), {
  useConfigStore: (selector: (state: unknown) => unknown) => selector({ ...realConfig.useConfigStore.getState(), providers: [] }),
});
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));
mock.module('@/components/session/SessionActivityDuration', () => ({ SessionActivityDuration: () => null }));

const { TiledSwarmView } = await import('./TiledSwarmView');

const session = (id: string, parentID?: string, workflowAgent = false): Session => ({
  id,
  parentID,
  projectID: 'project',
  directory: '/project',
  title: id,
  cost: 0,
  tokens: {},
  time: { created: 0, updated: 0 },
  ...(workflowAgent ? { metadata: { openchamber: { kind: 'workflow-agent' } } } : {}),
}) as Session;

const renderPreset = (): CapturedProps => {
  captured = null;
  renderToStaticMarkup(<TiledSwarmView />);
  if (!captured) throw new Error('TiledSwarmView did not render TiledSessionsView');
  return captured;
};

describe('TiledSwarmView preset', () => {
  test('passes the lead plus its non-workflow children to the generic deck', () => {
    currentSessionId = 'lead';
    liveSessions = [
      session('lead'),
      session('child-a', 'lead'),
      session('workflow-agent', 'lead', true),
      session('grandchild', 'child-a'),
      session('stranger'),
      session('child-b', 'lead'),
    ];

    const props = renderPreset();

    expect(props.sessionIds).toEqual(['lead', 'child-a', 'child-b']);
  });

  test('keeps the 3-pane swarm cap as the grid cap, and per-layout caps', () => {
    currentSessionId = 'lead';
    liveSessions = [session('lead'), session('a', 'lead'), session('b', 'lead'), session('c', 'lead'), session('d', 'lead')];

    expect(renderPreset().maxSlots).toBe(4);

    uiState.tiledSwarmLayout = 'columns-3';
    expect(renderPreset().maxSlots).toBe(3);

    uiState.tiledSwarmLayout = 'split-2';
    expect(renderPreset().maxSlots).toBe(2);

    uiState.tiledSwarmLayout = 'grid-4';
  });

  test('Plan pin reserves slot 1 even with 3+ subagents', () => {
    currentSessionId = 'lead';
    liveSessions = [session('lead'), session('a', 'lead'), session('b', 'lead'), session('c', 'lead'), session('d', 'lead')];
    uiState.tiledSwarmPinnedId = '__plan__';
    const ids = renderPreset().sessionIds;
    uiState.tiledSwarmPinnedId = null;
    expect(ids.slice(0, 2)).toEqual(['lead', '__plan__']);
    expect(ids).toHaveLength(4);
  });

  test('hands over an empty list when no session owns the deck', () => {
    currentSessionId = null;
    liveSessions = [session('child', 'lead')];

    expect(renderPreset().sessionIds).toEqual([]);
    currentSessionId = 'lead';
  });

  test('pinned Plan tile: grandchild click focuses it without clearing the Plan pin', () => {
    currentSessionId = 'lead';
    liveSessions = [session('lead'), session('child-a', 'lead'), session('leaf-1', 'child-a')];
    uiState.tiledSwarmPinnedId = '__plan__';
    const pinSpy = mock((_id: string | null) => undefined);
    uiState.setTiledSwarmPinnedId = pinSpy;
    setCurrentSessionSpy.mockClear();
    const props = renderPreset();
    const pane = props.renderPane!({ index: 1, sessionId: '__plan__' });
    let tree: React.ReactNode = null;
    const Expand = () => {
      tree = (pane.type as (p: unknown) => React.ReactNode)(pane.props);
      return null;
    };
    renderToStaticMarkup(<Expand />);
    const buttons: Array<{ props: { title?: string; onClick?: () => void } }> = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!React.isValidElement(node)) return;
      const el = node as unknown as { type: unknown; props: { children?: unknown; title?: string; onClick?: () => void } };
      if (el.type === 'button') buttons.push(el as never);
      walk(el.props.children);
    };
    walk(tree);
    const leaf = buttons.find((b) => b.props.title === 'Focus this nested subagent session');
    expect(leaf).toBeDefined();
    leaf!.props.onClick!();
    expect(setCurrentSessionSpy.mock.calls[0]?.[0]).toBe('leaf-1');
    expect(pinSpy).not.toHaveBeenCalled();
    expect(uiState.tiledSwarmPinnedId).toBe('__plan__');
    uiState.tiledSwarmPinnedId = null;
    uiState.setTiledSwarmPinnedId = () => undefined;
  });
});
