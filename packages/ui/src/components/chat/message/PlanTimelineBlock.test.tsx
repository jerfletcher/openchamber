import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { PlanTimelineBlock } from './PlanTimelineBlock';

describe('PlanTimelineBlock', () => {
    let win: Window;
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        win = new Window();
        Object.assign(globalThis, {
            window: win,
            document: win.document,
            HTMLElement: win.HTMLElement,
            Element: win.Element,
            Node: win.Node,
            IS_REACT_ACT_ENVIRONMENT: true,
        });
        const div = win.document.createElement('div');
        win.document.body.appendChild(div);
        container = div as unknown as HTMLDivElement;
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        win.close();
    });

    test('renders ordered ACP plan entries with completion count and toggles collapse', async () => {
        await act(async () => {
            root.render(
                <PlanTimelineBlock
                    blockId="ses_acp_1"
                    entries={[
                        { content: 'Audit ACP bridge', priority: 'high', status: 'completed' },
                        { content: 'Build UI controls', priority: 'medium', status: 'in_progress' },
                        { content: 'Run verification', priority: 'low', status: 'pending' },
                    ]}
                />,
            );
        });

        const block = container.querySelector('[data-testid="acp-plan-timeline-block"]');
        expect(block).not.toBeNull();
        expect(block?.textContent).toContain('1/3');
        expect(container.querySelector('[data-testid="acp-plan-entry-0"]')?.textContent).toContain('Audit ACP bridge');
        expect(container.querySelector('[data-testid="acp-plan-entry-1"]')?.textContent).toContain('Build UI controls');
        expect(container.querySelector('[data-testid="acp-plan-entry-2"]')?.textContent).toContain('Run verification');

        const toggleButton = block?.querySelector('button');
        expect(toggleButton).not.toBeNull();
        await act(async () => {
            toggleButton?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as MouseEvent);
        });
        expect(container.querySelector('[data-testid="acp-plan-entry-0"]')).toBeNull();
    });
});
