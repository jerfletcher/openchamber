import React from 'react';
import { ChatView } from '@/components/views/ChatView';
import type { TiledLayoutVariant } from '@/components/chat/swarm/tiledLayout';
import { resolveTiledLayout } from '@/components/chat/swarm/tiledLayout';

export interface TiledPaneContext {
  /** The session this pane shows. Never null. */
  sessionId: string;
  /** Position in the grid, matching the order of `sessionIds`. */
  index: number;
  /** The ids actually on screen, after the slot cap was applied. */
  visibleIds: readonly string[];
  /** Number of cells the grid draws (`maxSlots`). */
  slotCount: number;
}

export interface TiledEmptySlotContext {
  index: number;
  visibleIds: readonly string[];
  slotCount: number;
}

export interface TiledSessionsViewProps {
  /**
   * The sessions to tile, in display order. The view knows nothing about how
   * the list was produced — children, tabs, pinned sessions, anything.
   */
  sessionIds: readonly string[];
  layout: TiledLayoutVariant;
  /** Hard cap on grid cells. The caller owns the preset's slot budget. */
  maxSlots: number;
  /** Activity count `auto` resolves against. Defaults to the id count. */
  activeCount?: number;
  /** Directory for a session; the default pane falls back to `null`. */
  directoryForSession?: (sessionId: string) => string | null;
  /** Render a pane for an occupied cell instead of the default chat pane. */
  renderPane?: (pane: TiledPaneContext) => React.ReactNode;
  /** Render a cell with no session. Without it, empty cells stay empty. */
  renderEmptySlot?: (slot: TiledEmptySlotContext) => React.ReactNode;
}

/**
 * A default pane: the session's chat, pinned and read-only. Tile surfaces that
 * need chrome (status, controls) supply `renderPane`.
 */
const DefaultTiledPane: React.FC<{ sessionId: string; directory: string | null }> = ({ sessionId, directory }) => (
  <div
    data-tiled-session={sessionId}
    className="relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border/80 bg-background shadow-2xs"
  >
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
      <ChatView pinnedSession={{ sessionId, directory }} readOnly hideReadOnlyBanner />
    </div>
  </div>
);

/**
 * Generic tiled session deck: it renders whatever session ids it is handed,
 * with no notion of subagents, parentage or workflow runs. The swarm view is a
 * preset over this; a future session picker is another.
 *
 * An empty id list renders nothing unless a caller supplies `renderEmptySlot`
 * (the swarm preset does, because its empty cells are telemetry cards).
 */
export const TiledSessionsView: React.FC<TiledSessionsViewProps> = ({
  sessionIds,
  layout,
  maxSlots,
  activeCount,
  directoryForSession,
  renderPane,
  renderEmptySlot,
}) => {
  const slotCount = Math.max(0, Math.floor(maxSlots));
  const visibleIds = React.useMemo(() => sessionIds.slice(0, slotCount), [sessionIds, slotCount]);

  if (visibleIds.length === 0 && !renderEmptySlot) return null;
  if (slotCount === 0) return null;

  const { gridClassName, effectiveLayout } = resolveTiledLayout(layout, activeCount ?? sessionIds.length);

  return (
    <div className={gridClassName} data-tiled-sessions="true" data-tiled-layout={effectiveLayout}>
      {Array.from({ length: slotCount }).map((_, index) => {
        const sessionId = visibleIds[index];
        if (!sessionId) {
          return <React.Fragment key={`empty-${index}`}>{renderEmptySlot?.({ index, visibleIds, slotCount }) ?? null}</React.Fragment>;
        }
        if (renderPane) {
          return <React.Fragment key={sessionId}>{renderPane({ sessionId, index, visibleIds, slotCount })}</React.Fragment>;
        }
        return (
          <DefaultTiledPane
            key={sessionId}
            sessionId={sessionId}
            directory={directoryForSession?.(sessionId) ?? null}
          />
        );
      })}
    </div>
  );
};
