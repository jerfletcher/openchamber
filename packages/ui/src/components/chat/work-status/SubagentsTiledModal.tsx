import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useSessionMessages, useSessionPartsForMessages } from '@/sync/sync-context';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useConfigStore } from '@/stores/useConfigStore';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { useUIStore } from '@/stores/useUIStore';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import type { Session as SessionInfo, ToolPart, Part as MessagePart } from '@/lib/opencode/model';

interface SubagentTileProps {
  child: SessionInfo;
  status: 'busy' | 'blocked' | 'done' | 'failed' | 'idle';
  directory: string | null;
  onOpen: () => void;
  onOpenSplit?: () => void;
}

const SubagentTile: React.FC<SubagentTileProps> = ({ child, status, directory, onOpen, onOpenSplit }) => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const messages = useSessionMessages(child.id, child.directory ?? directory ?? undefined);

  const modelName = getProviderModelDisplayName(
    providers.find((provider) => provider.id === child.model?.providerID),
    child.model?.id,
  );

  // Extract latest active tools, thoughts, or responses from the child session
  const lastAssistantId = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  }, [messages]);
  const partsByMessage = useSessionPartsForMessages(
    React.useMemo(() => (lastAssistantId ? [lastAssistantId] : []), [lastAssistantId]),
    child.directory ?? directory ?? undefined,
  );
  const latestInfo = React.useMemo(() => {
    if (lastAssistantId) {
      {
        const parts = partsByMessage[lastAssistantId] || [];
        // Look for running or latest tool
        for (let j = parts.length - 1; j >= 0; j--) {
          const part = parts[j] as MessagePart;
          if (part.type === 'tool') {
            const toolPart = part as ToolPart;
            const toolState = toolPart.state;
            const command = (toolState?.input as Record<string, unknown>)?.command as string | undefined;
            const toolName = toolPart.tool || 'tool';
            return {
              type: 'tool',
              name: toolName,
              command: command || JSON.stringify(toolState?.input || {}).slice(0, 100),
              status: toolState?.status,
            };
          }
          if (part.type === 'reasoning') {
            return {
              type: 'reasoning',
              text: (part as { text?: string }).text?.slice(-150) || 'Thinking...',
            };
          }
          if (part.type === 'text') {
            return {
              type: 'text',
              text: (part as { text?: string }).text?.slice(-150) || '',
            };
          }
        }
      }
    }
    return null;
  }, [lastAssistantId, partsByMessage]);

  const isWorking = status === 'busy';
  // Blink on the shared waiting clock rather than an infinite CSS pulse: see
  // the animation contract in `lib/infiniteAnimations.test.ts`.
  const workingBlink = useWaitingBlink(isWorking);

  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-3 shadow-xs transition-colors hover:border-border/80">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-border/50 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`size-2 shrink-0 rounded-full ${
                isWorking
                  ? `bg-emerald-500 ${workingBlink ?? ''}`
                  : status === 'done'
                    ? 'bg-emerald-500'
                    : status === 'failed'
                      ? 'bg-rose-500'
                      : status === 'blocked'
                        ? 'bg-amber-500'
                        : 'bg-muted-foreground'
              }`}
            />
            <h4 className="truncate font-medium text-sm text-foreground" title={child.title}>
              {child.title?.trim() || t('chat.workStatus.subagent.untitled')}
            </h4>
          </div>
          {modelName ? (
            <span className="truncate text-xs text-muted-foreground">{modelName}</span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <SessionActivityDuration sessionId={child.id} running={isWorking} />
        </div>
      </div>

      {/* Body: Live stream feed / latest activity */}
      <div className="my-2.5 flex-1 rounded bg-muted/40 p-2 font-mono text-xs">
        {latestInfo?.type === 'tool' ? (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 font-semibold text-primary">
              <Icon name="terminal" className="size-3.5" />
              <span>{latestInfo.name}</span>
              {latestInfo.status ? (
                <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                  {latestInfo.status}
                </span>
              ) : null}
            </div>
            <div className="max-h-24 overflow-y-auto break-all text-muted-foreground">
              {latestInfo.command}
            </div>
          </div>
        ) : latestInfo?.type === 'reasoning' ? (
          <div className="space-y-1 text-muted-foreground">
            <div className="flex items-center gap-1 text-[11px] font-semibold text-foreground/80">
              <Icon name="ai-agent" className="size-3.5" />
              <span>Reasoning...</span>
            </div>
            <div className="max-h-24 overflow-y-auto italic">
              {latestInfo.text}
            </div>
          </div>
        ) : latestInfo?.type === 'text' ? (
          <div className="max-h-24 overflow-y-auto text-foreground/90">
            {latestInfo.text}
          </div>
        ) : (
          <div className="text-muted-foreground italic">
            {isWorking ? 'Initializing subagent...' : 'Idle'}
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] capitalize text-muted-foreground">
          {status}
        </span>
        <div className="flex items-center gap-1">
        {onOpenSplit ? (
          <Button type="button" size="xs" variant="outline" className="h-6 gap-1 px-2 text-xs" onClick={onOpenSplit}>
            <Icon name="layout" className="size-3" />
            <span>Split View</span>
          </Button>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="h-6 gap-1 px-2 text-xs"
          onClick={onOpen}
        >
          <Icon name="layout-right" className="size-3" />
          <span>Open Tab</span>
        </Button>
        </div>
      </div>
    </div>
  );
};

interface SubagentsTiledModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  childrenSessions: SessionInfo[];
  statuses: Record<string, { type?: string }>;
  observedById: Map<string, string>;
  permissions: Record<string, unknown[]>;
  forms: Record<string, unknown[]>;
  directory: string | null;
  onOpenChild: (childId: string, label: string) => void;
}

export const SubagentsTiledModal: React.FC<SubagentsTiledModalProps> = ({
  open,
  onOpenChange,
  childrenSessions,
  statuses,
  observedById,
  permissions,
  forms,
  directory,
  onOpenChild,
}) => {
  const activeCount = childrenSessions.filter((c) => {
    const status = statuses[c.id]?.type;
    const observed = observedById.get(c.id);
    return status === 'busy' || status === 'retry' || (!status && observed === 'busy');
  }).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[95vw] sm:max-w-5xl">
        <DialogHeader className="border-b border-border/60 pb-3">
          <div className="flex items-center justify-between pr-6">
            <div className="flex items-center gap-2">
              <Icon name="layout" className="size-5 text-primary" />
              <DialogTitle className="text-base font-semibold">
                Subagent Swarm Deck ({childrenSessions.length} total, {activeCount} running)
              </DialogTitle>
            </div>
          </div>
        </DialogHeader>

        <div className="grid max-h-[75vh] grid-cols-1 gap-3 overflow-y-auto p-1 sm:grid-cols-2 lg:grid-cols-3">
          {childrenSessions.map((child) => {
            const blocked = (permissions[child.id]?.length ?? 0) > 0;
            const asked = (forms[child.id]?.length ?? 0) > 0;
            const statusType = statuses[child.id]?.type;
            const observed = observedById.get(child.id);
            const busy = statusType === 'busy' || statusType === 'retry' || (!statusType && observed === 'busy');
            const failed = !busy && observed === 'failed';
            const done = !failed && !busy && (statusType === 'idle' || observed === 'settled');

            const status: 'busy' | 'blocked' | 'done' | 'failed' | 'idle' =
              blocked || asked ? 'blocked' : busy ? 'busy' : failed ? 'failed' : done ? 'done' : 'idle';

            return (
              <SubagentTile
                key={child.id}
                child={child}
                status={status}
                directory={directory}
                onOpenSplit={() => {
                  useUIStore.getState().openTiledSwarmWithPin(child.id);
                  onOpenChange(false);
                }}
                onOpen={() => {
                  onOpenChild(child.id, child.title || 'Subagent');
                  onOpenChange(false);
                }}
              />
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
};
