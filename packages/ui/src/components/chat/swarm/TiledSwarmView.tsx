import React from 'react';
import { ChatView } from '@/components/views/ChatView';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions, useAllSessionStatuses } from '@/sync/sync-context';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useConfigStore } from '@/stores/useConfigStore';
import type { SessionInfo } from '@/sync/types';

interface SubagentSlotProps {
  child?: SessionInfo;
  slotNumber: number;
  directory: string | null;
  onSelectSession: (id: string) => void;
}

const SubagentSlot: React.FC<SubagentSlotProps> = ({ child, slotNumber, directory, onSelectSession }) => {
  const providers = useConfigStore((state) => state.providers);
  const statuses = useAllSessionStatuses();

  if (!child) {
    return (
      <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-dashed border-border/50 bg-muted/15 shadow-2xs">
        <div className="flex h-9 select-none items-center justify-between border-b border-border/30 bg-muted/20 px-3">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-muted-foreground/30" />
            <span className="font-mono text-xs font-medium text-muted-foreground/70">
              Slot #{slotNumber} · Subagent Worker
            </span>
          </div>
          <span className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/60">
            IDLE
          </span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center select-none">
          <div className="mb-2 rounded-full bg-muted/40 p-3">
            <Icon name="terminal-window" className="size-6 text-muted-foreground/40" />
          </div>
          <p className="font-mono text-xs font-medium text-muted-foreground/70">
            Worker #{slotNumber} Available
          </p>
          <p className="mt-1 max-w-xs text-[11px] text-muted-foreground/50">
            Awaits subagent invocation. Work and commands stream live in this pane upon dispatch.
          </p>
        </div>
      </div>
    );
  }

  const statusType = statuses[child.id]?.type;
  const isBusy = statusType === 'busy';
  const modelName = getProviderModelDisplayName(
    providers.find((provider) => provider.id === child.model?.providerID),
    child.model?.id,
  );

  return (
    <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border/80 bg-background shadow-2xs">
      {/* Pane Titlebar */}
      <div className="flex h-9 shrink-0 select-none items-center justify-between border-b border-border/60 bg-muted/30 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`size-2 shrink-0 rounded-full ${
              isBusy ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/50'
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
          <SessionActivityDuration sessionId={child.id} running={isBusy} />
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

      {/* Pane Chat Container */}
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <ChatView
          pinnedSession={{
            sessionId: child.id,
            directory: child.directory ?? directory,
          }}
          readOnly
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

  const tiledLayout = useUIStore((state) => state.tiledSwarmLayout);
  const setTiledLayout = useUIStore((state) => state.setTiledSwarmLayout);
  const toggleTiledSwarm = useUIStore((state) => state.toggleTiledSwarmView);

  // Subagents belonging to current session
  const children = React.useMemo(() => {
    if (!currentSessionId) return [];
    return liveSessions.filter((candidate) => candidate.parentID === currentSessionId);
  }, [currentSessionId, liveSessions]);

  const handleSelectSession = React.useCallback(
    (sessionId: string) => {
      setCurrentSession(sessionId, effectiveDirectory || null);
    },
    [effectiveDirectory, setCurrentSession],
  );

  // Layout grid classes based on mode
  const gridClass =
    tiledLayout === 'columns-3'
      ? 'grid h-full w-full grid-cols-1 md:grid-cols-3 gap-2'
      : tiledLayout === 'split-2'
        ? 'grid h-full w-full grid-cols-1 md:grid-cols-2 gap-2'
        : 'grid h-full w-full grid-cols-1 md:grid-cols-2 md:grid-rows-2 gap-2';

  const maxSlots = tiledLayout === 'split-2' ? 1 : tiledLayout === 'columns-3' ? 2 : 3;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background/50 p-2">
      {/* Top Controls Strip */}
      <div className="mb-2 flex shrink-0 items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <Icon name="layout" className="size-4 text-primary" />
          <span className="font-mono text-xs font-semibold text-foreground">
            Tiled Swarm Deck
          </span>
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            {children.length} active agent{children.length === 1 ? '' : 's'}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Layout Mode Selector */}
          <div className="flex items-center rounded-md border border-border/40 bg-background/50 p-0.5">
            <Button
              type="button"
              size="xs"
              variant={tiledLayout === 'grid-4' ? 'secondary' : 'ghost'}
              className="h-5 px-1.5 font-mono text-[10px]"
              onClick={() => setTiledLayout('grid-4')}
              title="4-Way Split Grid (2x2)"
            >
              2x2
            </Button>
            <Button
              type="button"
              size="xs"
              variant={tiledLayout === 'columns-3' ? 'secondary' : 'ghost'}
              className="h-5 px-1.5 font-mono text-[10px]"
              onClick={() => setTiledLayout('columns-3')}
              title="3 Columns Side-by-Side"
            >
              3-Col
            </Button>
            <Button
              type="button"
              size="xs"
              variant={tiledLayout === 'split-2' ? 'secondary' : 'ghost'}
              className="h-5 px-1.5 font-mono text-[10px]"
              onClick={() => setTiledLayout('split-2')}
              title="1:1 Split Screen"
            >
              1:1
            </Button>
          </div>

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

      {/* Tiled Grid Panes */}
      <div className={gridClass}>
        {/* Pane 0: Primary Collaborator / Main Agent */}
        <div className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-primary/30 bg-background shadow-xs">
          <div className="flex h-9 shrink-0 select-none items-center justify-between border-b border-border/60 bg-primary/5 px-3">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-primary" />
              <span className="font-mono text-xs font-bold text-primary">
                Primary Agent (Lead)
              </span>
            </div>
          </div>
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            <ChatView active={active} />
          </div>
        </div>

        {/* Panes 1..N: Subagent slots */}
        {Array.from({ length: maxSlots }).map((_, index) => (
          <SubagentSlot
            key={children[index]?.id ?? `slot-${index + 1}`}
            child={children[index]}
            slotNumber={index + 1}
            directory={effectiveDirectory || null}
            onSelectSession={handleSelectSession}
          />
        ))}
      </div>
    </div>
  );
};
