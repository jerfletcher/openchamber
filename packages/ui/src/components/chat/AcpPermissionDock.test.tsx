import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { AcpPermissionRequest } from '@/lib/acp/types';

/**
 * The ACP approval prompt is the only place a user can answer an agent that is
 * blocked on `session/request_permission`, so these tests pin the two things
 * that matter: every option the agent offered is a distinct action, and nothing
 * is answered without a click (no default, no timeout, unknown kind ≠ consent).
 */

const replies: Array<{ sessionID: string; requestID: string; optionId: string | null }> = [];

mock.module('@/lib/acp/permissions-api', () => ({
    listAcpPermissions: async () => [],
    respondToAcpPermission: async (sessionID: string, requestID: string, optionId: string | null) => {
        replies.push({ sessionID, requestID, optionId });
        return optionId === null ? { outcome: 'cancelled' as const } : { outcome: 'selected' as const, optionId };
    },
}));

const request: AcpPermissionRequest = {
    requestId: 'perm_1',
    sessionID: 'ses_agy_1',
    title: 'Refactor the parser',
    agent: 'antigravity',
    toolCall: {
        toolCallId: 'call_1',
        title: 'Run the test suite',
        kind: 'execute',
        rawInput: { command: 'bun test' },
        locations: [{ path: '/repo/packages/web/server/lib/acp' }],
    },
    options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', consent: true },
        { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always', consent: true },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once', consent: false },
        { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always', consent: false },
        // A kind this client does not know: shown, selectable, but never consent.
        { optionId: 'maybe', name: 'Maybe later', kind: 'allow_sometimes', consent: false },
    ],
};

describe('ACP permission prompt', () => {
    let win: Window;
    let root: Root | null = null;
    let container: HTMLElement;
    let restore: () => void;

    const render = async (sessionId: string | null) => {
        const { I18nProvider } = await import('@/lib/i18n');
        const { AcpPermissionDock } = await import('./AcpPermissionDock');
        container = win.document.body.appendChild(win.document.createElement('div')) as unknown as HTMLElement;
        root = createRoot(container);
        await act(async () => root!.render(<I18nProvider><AcpPermissionDock sessionId={sessionId} /></I18nProvider>));
        // The seed read settles a tick later; let it land inside act.
        await act(async () => { await Promise.resolve(); });
    };

    const buttonByText = (text: string): HTMLButtonElement | undefined => (
        Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text))
    );

    beforeEach(() => {
        replies.length = 0;
        win = new Window({ url: 'http://localhost' });
        const originals = new Map<string, PropertyDescriptor | undefined>();
        const globals: Record<string, unknown> = {
            window: win,
            document: win.document,
            navigator: win.navigator,
            Element: win.Element,
            HTMLElement: win.HTMLElement,
            Node: win.Node,
            Event: win.Event,
            CustomEvent: win.CustomEvent,
            requestAnimationFrame: win.requestAnimationFrame.bind(win),
            cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
            getComputedStyle: win.getComputedStyle.bind(win),
            ResizeObserver: class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        for (const [name, value] of Object.entries(globals)) {
            originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        }
        restore = () => {
            for (const [name, descriptor] of originals) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else delete (globalThis as Record<string, unknown>)[name];
            }
        };
    });

    afterEach(async () => {
        if (root) await act(async () => root!.unmount());
        root = null;
        const { resetAcpPermissions } = await import('@/sync/acp-permissions');
        resetAcpPermissions();
        restore();
    });

    test('shows the tool call, its session, and every offered option kind', async () => {
        const { setAcpPermissions } = await import('@/sync/acp-permissions');
        setAcpPermissions(request.sessionID, [request]);
        await render(request.sessionID);

        expect(container.textContent).toContain('Permission required');
        // The session the agent is blocked in is named, not implied.
        expect(container.textContent).toContain('Refactor the parser');
        expect(container.textContent).toContain('Run the test suite');
        expect(container.textContent).toContain('/repo/packages/web/server/lib/acp');
        expect(container.textContent).toContain('bun test');
        for (const option of request.options ?? []) {
            expect(container.textContent).toContain(option.name);
            expect(container.textContent).toContain(option.kind);
        }
        // Four ACP kinds plus the unrecognized one are all distinct actions.
        expect(container.querySelectorAll('button').length).toBeGreaterThanOrEqual(5);
        // Nothing is answered until the user clicks.
        expect(replies).toHaveLength(0);
    });

    test('an option click replies with its optionId for that request', async () => {
        const { setAcpPermissions } = await import('@/sync/acp-permissions');
        setAcpPermissions(request.sessionID, [request]);
        await render(request.sessionID);

        await act(async () => buttonByText('Allow once')!.click());
        expect(replies).toEqual([{ sessionID: request.sessionID, requestID: 'perm_1', optionId: 'allow-once' }]);
    });

    test('the fourth kind is its own action and replies with its own id', async () => {
        const { setAcpPermissions } = await import('@/sync/acp-permissions');
        setAcpPermissions(request.sessionID, [request]);
        await render(request.sessionID);

        await act(async () => buttonByText('Always reject')!.click());
        expect(replies).toEqual([{ sessionID: request.sessionID, requestID: 'perm_1', optionId: 'reject-always' }]);
    });

    test('dismissing answers cancelled instead of a selection', async () => {
        const { setAcpPermissions } = await import('@/sync/acp-permissions');
        setAcpPermissions(request.sessionID, [request]);
        await render(request.sessionID);

        await act(async () => buttonByText('Dismiss')!.click());
        expect(replies).toEqual([{ sessionID: request.sessionID, requestID: 'perm_1', optionId: null }]);
    });

    test('an unrecognized kind is styled as neither consent nor refusal, and never auto-answered', async () => {
        const { setAcpPermissions } = await import('@/sync/acp-permissions');
        const unknown: AcpPermissionRequest = {
            ...request,
            options: [{ optionId: 'maybe', name: 'Maybe later', kind: 'allow_sometimes' }],
        };
        setAcpPermissions(unknown.sessionID, [unknown]);
        await render(unknown.sessionID);

        const button = buttonByText('Maybe later')!;
        // Consent buttons are the primary variant; this one is not.
        expect(button.className).not.toContain('bg-primary');
        expect(replies).toHaveLength(0);
    });

    test('settling the prompt removes it, and a request for another session is not shown', async () => {
        const { setAcpPermissions, applyAcpPermissionEvents } = await import('@/sync/acp-permissions');
        setAcpPermissions('ses_other', [request]);
        await render(request.sessionID);
        expect(container.textContent).not.toContain('Run the test suite');

        await act(async () => setAcpPermissions(request.sessionID, [request]));
        await act(async () => applyAcpPermissionEvents([{
            type: 'openchamber.acp-permission-settled',
            properties: { sessionID: request.sessionID, requestId: 'perm_1', acpSessionId: 'acp_1', outcome: 'cancelled' },
        }]));
        // AnimatePresence keeps the panel mounted until its exit animation
        // finishes (rAF/timer driven), so wait for it rather than one tick.
        for (let i = 0; i < 40 && container.textContent?.includes('Run the test suite'); i += 1) {
            await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
        }
        expect(container.textContent).not.toContain('Run the test suite');
    });
});
