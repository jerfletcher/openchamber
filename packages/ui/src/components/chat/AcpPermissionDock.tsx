import React from 'react';
import { AnimatePresence } from 'motion/react';
import { ComposerFloatingPanel } from './composer/ui/ComposerFloatingPanel';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { listAcpPermissions, respondToAcpPermission } from '@/lib/acp/permissions-api';
import { isAcpConsentOptionKind, isAcpRejectOptionKind } from '@/lib/acp/types';
import type { AcpPermissionOption, AcpPermissionRequest } from '@/lib/acp/types';
import { seedAcpPermissions, useAcpPermissions } from '@/sync/acp-permissions';

/**
 * The approval prompt for an ACP agent's `session/request_permission`.
 *
 * An ACP agent blocks on this answer, so the panel is a dock above the composer
 * in the same frame the OpenCode permission dock and the form dock use — the
 * rest of the chat stays visible, scrollable and usable while it waits. It is
 * not a modal: nothing is focused or trapped.
 *
 * Every option the agent offered is its own action, up to the four ACP kinds.
 * The client never preselects one, never answers on a timeout, and never reads a
 * kind it does not recognize as consent — dismissing, or the turn being stopped,
 * answers `cancelled` (spec: /protocol/v1/prompt-turn#cancellation).
 */

interface AcpPermissionDockProps {
    sessionId: string | null;
    /** Another floating panel already owns the composer slot. */
    hidden?: boolean;
}

/** A kind we have no name for still renders honestly, labelled by its own id. */
const KIND_LABEL_KEYS: Record<string, I18nKey> = {
    allow_once: 'chat.permissionCard.allowOnce',
    allow_always: 'chat.permissionCard.alwaysAllow',
    reject_once: 'chat.permissionCard.deny',
    reject_always: 'chat.acpPermission.rejectAlways',
};

const optionLabel = (option: AcpPermissionOption): string => option.name || option.optionId;

/** The tool call, as the prompt shows it: what the agent wants to do. */
const ToolCallSummary: React.FC<{ request: AcpPermissionRequest }> = ({ request }) => {
    const { t } = useI18n();
    const toolCall = request.toolCall ?? {};
    const input = toolCall.rawInput;
    const inputText = typeof input === 'undefined' || input === null
        ? ''
        : typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    const locations = (toolCall.locations ?? []).map((entry) => entry.path).filter((path): path is string => Boolean(path));

    return (
        <div className="px-1.5 pb-1">
            <div className="typography-meta font-medium text-foreground">{toolCall.title || toolCall.name || t('chat.acpPermission.unknownTool')}</div>
            {toolCall.kind ? (
                <span className="typography-micro mt-1 inline-block rounded bg-foreground/5 px-1.5 py-0.5 text-muted-foreground">{toolCall.kind}</span>
            ) : null}
            {locations.length > 0 ? (
                <ul className="mt-1.5 flex flex-col gap-0.5">
                    {locations.map((path) => (
                        <li key={path} className="typography-micro truncate font-mono text-muted-foreground" title={path}>{path}</li>
                    ))}
                </ul>
            ) : null}
            {inputText ? (
                <ScrollableOverlay outerClassName="mt-1.5 max-h-[160px]" className="tool-output-surface rounded-lg border border-edge-muted p-1.5" disableHorizontal>
                    <pre className="whitespace-pre-wrap break-words typography-micro text-muted-foreground">{inputText}</pre>
                </ScrollableOverlay>
            ) : null}
        </div>
    );
};

const AcpPermissionPanel: React.FC<{ request: AcpPermissionRequest }> = ({ request }) => {
    const { t } = useI18n();
    const [pendingOptionId, setPendingOptionId] = React.useState<string | null>(null);
    const [dismissing, setDismissing] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const busy = pendingOptionId !== null || dismissing;

    const answer = async (optionId: string | null) => {
        setError(null);
        if (optionId === null) setDismissing(true);
        else setPendingOptionId(optionId);
        try {
            await respondToAcpPermission(request.sessionID, request.requestId, optionId);
            // The settled event removes the prompt; nothing local to undo.
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : t('chat.acpPermission.replyFailed'));
        } finally {
            setPendingOptionId(null);
            setDismissing(false);
        }
    };

    const options = request.options ?? [];

    return (
        <ComposerFloatingPanel
            role="dialog"
            ariaLabel={t('chat.permissionCard.title')}
            header={<>
                <Icon name="question" className="size-3.5 shrink-0 text-[var(--status-warning)]" />
                <span className="typography-ui-label min-w-0 truncate text-foreground">{t('chat.permissionCard.title')}</span>
                {/* Which session is asking: the agent may be blocked in one the user is not reading. */}
                <span className="typography-micro min-w-0 truncate rounded bg-foreground/5 px-1.5 py-0.5 text-muted-foreground" title={request.title}>
                    {t('chat.permissionToast.labels.session')} {request.title || request.sessionID}
                </span>
                <div className="min-w-0 flex-1" />
                <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    aria-label={t('chat.acpPermission.dismiss')}
                    onClick={() => void answer(null)}
                    className="text-muted-foreground"
                >
                    <Icon name="close" className="size-3.5" />
                    {t('chat.acpPermission.dismiss')}
                </Button>
            </>}
        >
            <ToolCallSummary request={request} />
            <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2 pt-1">
                {options.map((option) => {
                    const consent = isAcpConsentOptionKind(option.kind);
                    const reject = isAcpRejectOptionKind(option.kind);
                    const kindKey = KIND_LABEL_KEYS[option.kind];
                    return (
                        <Button
                            key={option.optionId}
                            size="xs"
                            variant={consent ? 'default' : 'outline'}
                            disabled={busy}
                            title={kindKey ? t(kindKey) : option.kind}
                            onClick={() => void answer(option.optionId)}
                            className={cn(reject && 'text-[var(--status-error)]', !consent && !reject && 'text-muted-foreground')}
                        >
                            {pendingOptionId === option.optionId
                                ? <Icon name="loader-4" className="size-3.5 animate-spin" />
                                : <Icon name={consent ? 'check' : 'close'} className="size-3.5" />}
                            {optionLabel(option)}
                            {/* The kind stays visible: it is the only field that says what the answer grants. */}
                            <span className="typography-micro opacity-60">{option.kind}</span>
                        </Button>
                    );
                })}
            </div>
            {error ? (
                <div className="px-3 pb-2 typography-micro text-[var(--status-error)]" role="alert">{error}</div>
            ) : null}
        </ComposerFloatingPanel>
    );
};

const AcpPermissionDockView: React.FC<AcpPermissionDockProps> = ({ sessionId, hidden }) => {
    const requests = useAcpPermissions(sessionId);

    // The control stream does not replay, so a prompt raised while this client
    // was away would be invisible while the agent blocks on it. One read on the
    // session covers that; it never overwrites a live event.
    React.useEffect(() => {
        if (!sessionId) return;
        let cancelled = false;
        void listAcpPermissions(sessionId)
            .then((pending) => {
                if (!cancelled) seedAcpPermissions(sessionId, pending);
            })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [sessionId]);

    // One prompt at a time, oldest first: answering it surfaces the next.
    const current = requests[0];
    return (
        <AnimatePresence>
            {hidden || !current ? null : <AcpPermissionPanel key={current.requestId} request={current} />}
        </AnimatePresence>
    );
};

export const AcpPermissionDock = React.memo(AcpPermissionDockView);
