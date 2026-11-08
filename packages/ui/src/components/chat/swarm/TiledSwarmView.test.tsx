import { describe, expect, mock, test } from 'bun:test';
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
};
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
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <R,>(selector: (state: { currentSessionId: string | null; setCurrentSession: () => void }) => R): R => (
    selector({ currentSessionId, setCurrentSession: () => undefined })
  ),
}));
mock.module('@/sync/session-actions', () => ({ abortCurrentOperation: () => Promise.resolve() }));
mock.module('@/sync/sync-context', () => ({
  useAllLiveSessions: () => liveSessions,
  useAllSessionStatuses: () => ({}),
  useSessionMessages: () => [],
  useDirectorySync: (selector: (state: { permission: Record<string, unknown>; form: Record<string, unknown> }) => unknown) => (
    selector({ permission: {}, form: {} })
  ),
}));
mock.module('@/sync/global-session-status', () => ({
  useGlobalSessionStatusStore: (selector: (state: { statusById: Map<string, unknown>; observedById: Map<string, unknown> }) => unknown) => (
    selector({ statusById: new Map(), observedById: new Map() })
  ),
}));
mock.module('@/lib/workflows/store', () => ({ useSessionWorkflowRuns: () => [] }));
mock.module('@/hooks/useContextWindowLimits', () => ({ useContextWindowLimits: () => ({ context: 0 }) }));
mock.module('@/components/chat/work-status/useSubagentCostRollup', () => ({
  useSubagentCostRollup: () => ({ totalCost: 0, ownCost: 0, subagentCost: 0 }),
}));
mock.module('@/stores/useGitStore', () => ({
  useGitStore: (selector: (state: { directories: Map<string, unknown> }) => unknown) => selector({ directories: new Map() }),
}));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/project' }));
mock.module('@/stores/useUIStore', () => ({ useUIStore }));
mock.module('@/hooks/useDurationTicker', () => ({ useWaitingBlink: () => '' }));
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: (selector: (state: { providers: unknown[] }) => unknown) => selector({ providers: [] }),
}));
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

  test('hands over an empty list when no session owns the deck', () => {
    currentSessionId = null;
    liveSessions = [session('child', 'lead')];

    expect(renderPreset().sessionIds).toEqual([]);
    currentSessionId = 'lead';
  });
});
