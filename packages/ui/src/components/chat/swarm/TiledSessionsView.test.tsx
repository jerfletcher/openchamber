import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// The pane is the chat; the deck's own contract is which sessions get a cell.
mock.module('@/components/views/ChatView', () => ({
  ChatView: ({ pinnedSession }: { pinnedSession?: { sessionId: string; directory: string | null } }) => (
    <div data-chat-view={pinnedSession?.sessionId ?? 'primary'} data-directory={pinnedSession?.directory ?? ''} />
  ),
}));

const { TiledSessionsView } = await import('./TiledSessionsView');
const { resolveTiledLayout } = await import('./tiledLayout');

const paneIds = (markup: string): string[] => Array.from(markup.matchAll(/data-tiled-session="([^"]+)"/g)).map((match) => match[1] ?? '');

describe('TiledSessionsView', () => {
  test('tiles an arbitrary id list, with no notion of parentage', () => {
    const markup = renderToStaticMarkup(
      <TiledSessionsView sessionIds={['lead-session', 'tab-one', 'tab-two']} layout="grid-4" maxSlots={4} />,
    );

    expect(paneIds(markup)).toEqual(['lead-session', 'tab-one', 'tab-two']);
    // Every pane is a pinned chat for the id it was handed, and nothing else.
    expect(markup.match(/data-chat-view=/g)).toHaveLength(3);
    expect(markup).toContain('data-tiled-layout="grid-4"');
  });

  test('passes each session its directory', () => {
    const markup = renderToStaticMarkup(
      <TiledSessionsView
        sessionIds={['a', 'b']}
        layout="split-2"
        maxSlots={2}
        directoryForSession={(id) => (id === 'a' ? '/one' : null)}
      />,
    );

    expect(markup).toContain('data-directory="/one"');
    expect(markup).toContain('data-directory=""');
  });

  test('renders nothing for an empty list', () => {
    expect(renderToStaticMarkup(<TiledSessionsView sessionIds={[]} layout="grid-4" maxSlots={4} />)).toBe('');
  });

  test('caps the panes at maxSlots and keeps the given order', () => {
    const markup = renderToStaticMarkup(
      <TiledSessionsView sessionIds={['one', 'two', 'three', 'four', 'five']} layout="split-2" maxSlots={2} />,
    );

    expect(paneIds(markup)).toEqual(['one', 'two']);
    expect(markup).not.toContain('three');
  });

  test('lets a caller render its own panes and empty cells', () => {
    const markup = renderToStaticMarkup(
      <TiledSessionsView
        sessionIds={['one']}
        layout="split-2"
        maxSlots={2}
        renderPane={({ sessionId, index, slotCount }) => <div data-pane={sessionId} data-index={index} data-slots={slotCount} />}
        renderEmptySlot={({ index }) => <div data-empty={index} />}
      />,
    );

    expect(markup).toContain('data-pane="one"');
    expect(markup).toContain('data-index="0"');
    expect(markup).toContain('data-slots="2"');
    expect(markup).toContain('data-empty="1"');
  });

  test('an empty list still draws the cells a caller asked to fill', () => {
    const markup = renderToStaticMarkup(
      <TiledSessionsView sessionIds={[]} layout="split-2" maxSlots={2} renderEmptySlot={({ index }) => <div data-empty={index} />} />,
    );

    expect(markup).toContain('data-empty="0"');
    expect(markup).toContain('data-empty="1"');
  });
});

describe('resolveTiledLayout', () => {
  test('auto resolves from the activity count, as the swarm deck always did', () => {
    expect(resolveTiledLayout('auto', 0).effectiveLayout).toBe('split-2');
    expect(resolveTiledLayout('auto', 1).effectiveLayout).toBe('split-2');
    expect(resolveTiledLayout('auto', 2).effectiveLayout).toBe('columns-3');
    expect(resolveTiledLayout('auto', 3).effectiveLayout).toBe('grid-4');
  });

  test('each preset keeps its grid classes and slot cap', () => {
    expect(resolveTiledLayout('split-2', 9)).toEqual({
      effectiveLayout: 'split-2',
      gridClassName: 'grid min-h-0 flex-1 w-full grid-cols-1 md:grid-cols-2 gap-1.5',
      slotCap: 1,
    });
    expect(resolveTiledLayout('columns-3', 9)).toEqual({
      effectiveLayout: 'columns-3',
      gridClassName: 'grid min-h-0 flex-1 w-full grid-cols-1 md:grid-cols-3 gap-1.5',
      slotCap: 2,
    });
    expect(resolveTiledLayout('grid-4', 9)).toEqual({
      effectiveLayout: 'grid-4',
      gridClassName: 'grid min-h-0 flex-1 w-full grid-cols-1 auto-rows-fr md:grid-cols-2 md:grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5',
      slotCap: 3,
    });
  });
});
