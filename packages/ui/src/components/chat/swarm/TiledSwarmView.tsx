import React from 'react';
import { ChatView } from '@/components/views/ChatView';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { abortCurrentOperation } from '@/sync/session-actions';
import { useAllLiveSessions, useAllSessionStatuses, useDirectorySync, useSessionMessages } from '@/sync/sync-context';
import { isWorkflowAgentSession } from '@/lib/sessionWorkflowMetadata';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useSessionWorkflowRuns } from '@/lib/workflows/store';
import { useContextWindowLimits } from '@/hooks/useContextWindowLimits';
import { computeContextUsage } from '@/components/chat/work-status/contextUsage';
import { useSubagentCostRollup } from '@/components/chat/work-status/useSubagentCostRollup';
import { formatCost } from '@/components/chat/work-status/subagentCost';
import { useGitStore } from '@/stores/useGitStore';
import type { State } from '@/sync/types';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useConfigStore } from '@/stores/useConfigStore';
import type { Session as SessionInfo } from '@/lib/opencode/model';

type SwarmRow = {
  child: SessionInfo;
  blocked: boolean;
  asked: boolean;
  busy: boolean;
  finished: boolean;
  failed: boolean;
  rank: number;
};

interface StatsCardProps {
  slotNumber: number;
  sessionId: string | null;
  directory: string | null;
  rows: SwarmRow[];
  full: boolean;
  onPin: (id: string) => void;
}

const SwarmStatsCard: React.FC<StatsCardProps> = ({ slotNumber, sessionId, directory, rows, full, onPin }) => {
  const messages = useSessionMessages(sessionId ?? '', directory ?? undefined);
  const { context: contextLimit } = useContextWindowLimits(sessionId, directory ?? undefined);
  const usage = React.useMemo(() => computeContextUsage(messages, contextLimit), [messages, contextLimit]);
  const rollup = useSubagentCostRollup(sessionId);
  const gitStatus = useGitStore((state) => (directory ? state.directories.get(directory)?.status ?? null : null));

  const percent = usage?.state === 'measured' ? Math.min(100, usage.percent) : 0;
  const changed = gitStatus?.files?.length ?? 0;
  const sumStats = (key: 'insertions' | 'deletions') => {
    const stats = gitStatus?.diffStats;
    if (!stats) return 0;
    return [stats.staged, stats.working].reduce(
      (total, group) => total + Object.values(group ?? {}).reduce((sum: number, d: { insertions: number; deletions: number }) => sum + d[key], 0), 0);
  };
  const additions = sumStats('insertions');
  const deletions = sumStats('deletions');

  return (
    <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-dashed border-border/50 bg-muted/15 shadow-2xs">
      <div className="flex h-8 shrink-0 select-none items-center justify-between border-b border-border/30 bg-muted/20 px-2.5">
        <span className="font-mono text-xs font-medium text-muted-foreground/70">
          {full ? 'Session telemetry' : `Slot #${slotNumber} · idle`}
        </span>
        <span className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/60">IDLE</span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-xs">
        <div>
          <div className="mb-1 flex items-center justify-between text-muted-foreground">
            <span>Context</span>
            <span className="font-mono">
              {usage?.state === 'measured'
                ? `${percent.toFixed(0)}% · ${usage.totalTokens.toLocaleString()} / ${usage.limit.toLocaleString()}`
                : usage?.state === 'compacted' ? 'compacted' : 'no data'}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className={`h-full ${percent > 85 ? 'bg-destructive' : percent > 60 ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: `${percent}%` }} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 font-mono">
          <div><div className="text-[10px] text-muted-foreground">Total</div>{formatCost(rollup.totalCost ?? 0)}</div>
          <div><div className="text-[10px] text-muted-foreground">Primary</div>{formatCost(rollup.ownCost ?? 0)}</div>
          <div><div className="text-[10px] text-muted-foreground">Subagents</div>{formatCost(rollup.subagentCost ?? 0)}</div>
        </div>
        {full ? (
          <>
            <div className="font-mono text-muted-foreground">
              {gitStatus ? (
                <>
                  <span className="text-foreground">{gitStatus.current ?? 'detached'}</span>
                  {gitStatus.ahead ? ` ↑${gitStatus.ahead}` : ''}{gitStatus.behind ? ` ↓${gitStatus.behind}` : ''}
                  {' · '}{changed} changed <span className="text-emerald-500">+{additions}</span> <span className="text-red-500">-{deletions}</span>
                </>
              ) : 'No git status'}
            </div>
            {rows.length > 0 ? (
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Subagents</div>
                {rows.map((row) => (
                  <button
                    key={row.child.id}
                    type="button"
                    onClick={() => onPin(row.child.id)}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-muted/50"
                  >
                    <span className={`size-1.5 shrink-0 rounded-full ${row.blocked || row.asked ? 'bg-amber-500' : row.busy ? 'animate-pulse bg-emerald-500' : row.failed ? 'bg-red-500' : 'bg-muted-foreground/50'}`} />
                    <span className="truncate">{row.child.title?.trim() || 'Subagent'}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
};

interface SubagentSlotProps {
  row?: SwarmRow;
  rows: SwarmRow[];
  slotNumber: number;
  directory: string | null;
  sessionId: string | null;
  fullStats: boolean;
  showSwitcher: boolean;
  pinnedId: string | null;
  onPin: (id: string | null) => void;
  onSelectSession: (id: string) => void;
}

const SubagentSlot: React.FC<SubagentSlotProps> = ({ row, rows, slotNumber, directory, sessionId, fullStats, showSwitcher, pinnedId, onPin, onSelectSession }) => {
  const providers = useConfigStore((state) => state.providers);

  if (!row) {
    return (
      <SwarmStatsCard
        slotNumber={slotNumber}
        sessionId={sessionId}
        directory={directory}
        rows={rows}
        full={fullStats}
        onPin={onPin}
      />
    );
  }

  const child = row.child;
  const isBusy = row.busy || row.blocked || row.asked;
  const modelName = getProviderModelDisplayName(
    providers.find((provider) => provider.id === child.model?.providerID),
    child.model?.id,
  );

  return (
    <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border/80 bg-background shadow-2xs">
      <div className="flex h-8 shrink-0 select-none items-center justify-between border-b border-border/60 bg-muted/30 px-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`size-2 shrink-0 rounded-full ${
              row.blocked || row.asked ? 'bg-amber-500' : row.busy ? 'animate-pulse bg-emerald-500' : row.failed ? 'bg-red-500' : 'bg-muted-foreground/50'
            }`}
          />
          <h4 className="truncate font-mono text-xs font-semibold text-foreground" title={child.title}>
            {child.title?.trim() || `Subagent #${slotNumber}`}
          </h4>
          {modelName ? (
            <span className="hidden truncate rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
              {modelName}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {showSwitcher ? (
            <select
              className="h-6 max-w-32 rounded border border-border/50 bg-background px-1 text-[11px] text-muted-foreground"
              value={pinnedId ?? ''}
              onChange={(event) => onPin(event.target.value || null)}
              title="Choose which subagent this slot shows"
            >
              <option value="">Auto (Active first)</option>
              {rows.map((candidate) => (
                <option key={candidate.child.id} value={candidate.child.id}>
                  {candidate.child.title?.trim() || candidate.child.id.slice(0, 8)}
                </option>
              ))}
            </select>
          ) : null}
          <SessionActivityDuration sessionId={child.id} running={isBusy} />
          {isBusy ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-6 px-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => void abortCurrentOperation(child.id)}
              title="Stop this subagent"
            >
              <Icon name="stop" className="size-3" />
            </Button>
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => onSelectSession(child.id)}
            title="Focus this session as primary"
          >
            <Icon name="fullscreen" className="size-3" />
            <span className="hidden lg:inline">Focus</span>
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <ChatView
          pinnedSession={{
            sessionId: child.id,
            directory: child.directory ?? directory,
          }}
          readOnly
          hideReadOnlyBanner
        />
      </div>
    </div>
  );
};

export const TiledSwarmView: React.FC<{ active?: boolean }> = ({ active = true }) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const effectiveDirectory = useEffectiveDirectory();
  const liveSessions = useAllLiveSessions();
  const statuses = useAllSessionStatuses();

  const tiledLayout = useUIStore((state) => state.tiledSwarmLayout);
  const setTiledLayout = useUIStore((state) => state.setTiledSwarmLayout);
  const toggleTiledSwarm = useUIStore((state) => state.toggleTiledSwarmView);
  const pinnedId = useUIStore((state) => state.tiledSwarmPinnedId);
  const setPinnedId = useUIStore((state) => state.setTiledSwarmPinnedId);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const setSidebarOpen = useUIStore((state) => state.setSidebarOpen);

  const workflowRuns = useSessionWorkflowRuns(currentSessionId);
  const workflowAgentIds = React.useMemo(
    () => new Set(workflowRuns.flatMap((run) => run.agents.flatMap((agent) => (agent.sessionId ? [agent.sessionId] : [])))),
    [workflowRuns],
  );
  const children = React.useMemo(
    () => (currentSessionId ? liveSessions.filter((candidate) => (
      candidate.parentID === currentSessionId && !workflowAgentIds.has(candidate.id) && !isWorkflowAgentSession(candidate)
    )) : []),
    [liveSessions, currentSessionId, workflowAgentIds],
  );

  const permissions = useDirectorySync(React.useCallback((state: State) => state.permission, []));
  const forms = useDirectorySync(React.useCallback((state: State) => state.form, []));
  const observedChildren = useGlobalSessionStatusStore(React.useCallback((state) => children
    .flatMap((child) => {
      if (state.statusById.has(child.id)) return [`${child.id}\tbusy`];
      const observed = state.observedById.get(child.id);
      return observed ? [`${child.id}\t${observed.outcome === 'failed' ? 'failed' : 'settled'}`] : [];
    })
    .join('\n'), [children]));

  const rows = React.useMemo(() => {
    const observedById = new Map<string, string>();
    for (const line of observedChildren.split('\n')) {
      const [id, observed] = line.split('\t');
      if (id && observed) observedById.set(id, observed);
    }
    const built: SwarmRow[] = children.map((child) => {
      const blocked = (permissions[child.id]?.length ?? 0) > 0;
      const asked = (forms[child.id]?.length ?? 0) > 0;
      const statusType = statuses[child.id]?.type;
      const observed = observedById.get(child.id);
      const busy = statusType === 'busy' || statusType === 'retry' || (!statusType && observed === 'busy');
      const failed = !busy && observed === 'failed';
      const done = !failed && !busy && (statusType === 'idle' || (!statusType && observed === 'settled'));
      const finished = !blocked && !asked && (done || failed);
      const rank = blocked || asked ? 0 : busy ? 1 : finished ? 3 : 2;
      return { child, blocked, asked, busy, failed, finished, rank };
    });
    built.sort((left, right) => (left.rank - right.rank)
      || ((right.child.time?.created ?? 0) - (left.child.time?.created ?? 0)));
    return built;
  }, [children, permissions, forms, statuses, observedChildren]);

  const activeCount = rows.filter((row) => row.busy || row.blocked || row.asked).length;

  const handleSelectSession = React.useCallback(
    (sessionId: string) => {
      setCurrentSession(sessionId, effectiveDirectory || null);
    },
    [effectiveDirectory, setCurrentSession],
  );

  const effectiveLayout = tiledLayout === 'auto'
    ? (activeCount <= 1 ? 'split-2' : activeCount === 2 ? 'columns-3' : 'grid-4')
    : tiledLayout;

  const gridClass =
    effectiveLayout === 'columns-3'
      ? 'grid min-h-0 flex-1 w-full grid-cols-1 md:grid-cols-3 gap-1.5'
      : effectiveLayout === 'split-2'
        ? 'grid min-h-0 flex-1 w-full grid-cols-1 md:grid-cols-2 gap-1.5'
        : 'grid min-h-0 flex-1 w-full grid-cols-1 auto-rows-fr md:grid-cols-2 md:grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5';

  const maxSlots = effectiveLayout === 'split-2' ? 1 : effectiveLayout === 'columns-3' ? 2 : 3;

  // A pinned subagent takes the first slot; the rest fill by priority rank.
  const visible = React.useMemo(() => {
    const pinned = pinnedId ? rows.find((row) => row.child.id === pinnedId) : undefined;
    const rest = rows.filter((row) => row !== pinned);
    return (pinned ? [pinned, ...rest] : rest).slice(0, maxSlots);
  }, [rows, pinnedId, maxSlots]);

  const countLabel = rows.length === 0
    ? '0 active agents'
    : activeCount > 0 ? `${activeCount} active · ${rows.length} total` : `0 active · ${rows.length} finished`;

  const layoutButton = (value: typeof tiledLayout, label: string, title: string) => (
    <Button
      type="button"
      size="xs"
      variant={tiledLayout === value ? 'secondary' : 'ghost'}
      className="h-5 px-1.5 font-mono text-[10px]"
      onClick={() => setTiledLayout(value)}
      title={title}
    >
      {label}
    </Button>
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background/50 p-1.5">
      <div className="mb-1.5 flex h-8 shrink-0 items-center justify-between rounded-md border border-border/40 bg-muted/20 px-2.5">
        <div className="flex items-center gap-2">
          <Icon name="layout" className="size-4 text-primary" />
          <span className="font-mono text-xs font-semibold text-foreground">Tiled Swarm Deck</span>
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{countLabel}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded-md border border-border/40 bg-background/50 p-0.5">
            {layoutButton('auto', 'Auto', 'Pick the layout from the number of active agents')}
            {layoutButton('grid-4', '2x2', '4-Way Split Grid (2x2)')}
            {layoutButton('columns-3', '3-Col', '3 Columns Side-by-Side')}
            {layoutButton('split-2', '1:1', '1:1 Split Screen')}
          </div>

          <Button
            type="button"
            size="xs"
            variant={isSidebarOpen ? 'ghost' : 'secondary'}
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => {
              if (isSidebarOpen && effectiveDirectory) {
                useUIStore.getState().closeContextPanel(effectiveDirectory);
              }
              setSidebarOpen(!isSidebarOpen);
            }}
            title={isSidebarOpen ? 'Full-bleed: hide the sidebar' : 'Show the sidebar'}
          >
            <Icon name="fullscreen" className="size-3" />
            <span className="hidden sm:inline">{isSidebarOpen ? 'Zen' : 'Sidebar'}</span>
          </Button>

          <Button
            type="button"
            size="xs"
            variant="outline"
            className="h-6 gap-1 px-2 text-xs"
            onClick={toggleTiledSwarm}
            title="Exit Tiled Mode (Return to single chat)"
          >
            <Icon name="close" className="size-3" />
            <span className="hidden sm:inline">Single View</span>
          </Button>
        </div>
      </div>

      <div className={gridClass}>
        <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-primary/30 bg-background shadow-xs">
          <div className="flex h-8 shrink-0 select-none items-center justify-between border-b border-border/60 bg-primary/5 px-2.5">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-primary" />
              <span className="font-mono text-xs font-bold text-primary">Primary Agent (Lead)</span>
            </div>
          </div>
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            <ChatView active={active} />
          </div>
        </div>

        {Array.from({ length: maxSlots }).map((_, index) => (
          <SubagentSlot
            key={visible[index]?.child.id ?? `slot-${index + 1}`}
            row={visible[index]}
            rows={rows}
            slotNumber={index + 1}
            directory={effectiveDirectory || null}
            sessionId={currentSessionId}
            fullStats={index === visible.length}
            showSwitcher={rows.length > maxSlots && index === 0}
            pinnedId={pinnedId}
            onPin={setPinnedId}
            onSelectSession={handleSelectSession}
          />
        ))}
      </div>
    </div>
  );
};
