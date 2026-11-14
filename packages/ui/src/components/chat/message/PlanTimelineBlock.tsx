import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import type { AcpPlanEntry } from '@/lib/acp/types';
import { cn } from '@/lib/utils';
import { useAcpPlan } from '@/sync/acp-config';

type PlanTimelineBlockProps = {
    entries: readonly AcpPlanEntry[];
    blockId?: string;
    defaultExpanded?: boolean;
};

const statusIcon = (status: string | undefined) => {
    if (status === 'completed') {
        return <Icon name="checkbox-circle" className="h-3.5 w-3.5 shrink-0 text-[var(--status-success)]" />;
    }
    if (status === 'in_progress') {
        return <Spinner className="h-3.5 w-3.5 shrink-0 text-primary" />;
    }
    return <Icon name="checkbox-blank-circle" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />;
};

export const PlanTimelineBlock: React.FC<PlanTimelineBlockProps> = ({
    entries,
    blockId,
    defaultExpanded = true,
}) => {
    const [expanded, setExpanded] = React.useState(defaultExpanded);

    if (!entries || entries.length === 0) return null;

    const completedCount = entries.filter((e) => e.status === 'completed').length;

    return (
        <div
            data-testid="acp-plan-timeline-block"
            data-block-id={blockId}
            className="w-full py-1"
        >
            <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2">
                <button
                    type="button"
                    onClick={() => setExpanded((prev) => !prev)}
                    className="flex w-full items-center justify-between gap-2 text-start focus-visible:outline-none"
                    aria-expanded={expanded}
                >
                    <span className="flex items-center gap-1.5 min-w-0">
                        <Icon
                            name="list-check-2"
                            className="h-3.5 w-3.5 shrink-0"
                            style={{ color: 'var(--tools-icon)' }}
                        />
                        <span className="typography-meta font-medium text-foreground">
                            Plan
                        </span>
                        <span
                            className="typography-meta tabular-nums"
                            style={{ color: 'var(--tools-description)' }}
                        >
                            {completedCount}/{entries.length}
                        </span>
                    </span>
                    <Icon
                        name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                </button>
                {expanded ? (
                    <ol className="mt-2 space-y-1.5">
                        {entries.map((entry, idx) => (
                            <li
                                key={`${idx}-${entry.content}`}
                                data-testid={`acp-plan-entry-${idx}`}
                                className="flex items-start gap-2 typography-meta"
                            >
                                <span className="mt-0.5">{statusIcon(entry.status)}</span>
                                <span
                                    className={cn(
                                        'min-w-0 flex-1 break-words',
                                        entry.status === 'completed'
                                            ? 'text-muted-foreground line-through'
                                            : 'text-foreground/90',
                                    )}
                                >
                                    {entry.content}
                                </span>
                                {entry.priority === 'high' ? (
                                    <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 typography-micro text-destructive">
                                        high
                                    </span>
                                ) : null}
                            </li>
                        ))}
                    </ol>
                ) : null}
            </div>
        </div>
    );
};

export const SessionPlanTimelineBlock: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
    const entries = useAcpPlan(sessionId);
    if (entries.length === 0) return null;
    return (
        <div className="w-full pb-2">
            <div className="chat-message-column">
                <PlanTimelineBlock entries={entries} blockId={sessionId ?? undefined} />
            </div>
        </div>
    );
};
