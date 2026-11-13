import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const originalState = useUIStore.getState();

afterEach(() => {
  useSessionUIStore.setState({ currentSessionId: null });
  useUIStore.setState(originalState, true);
});

describe('per-session tiled state', () => {
  test('each session remembers its own tiled view', () => {
    useSessionUIStore.setState({ currentSessionId: 'session-a' });
    const ui = () => useUIStore.getState();
    ui().setTiledSwarmViewEnabled(true);
    ui().setTiledSwarmLayout('columns-3');
    ui().setTiledSwarmPinnedId('sub-1');
    ui().setTiledSessionIds(['x', 'y']);

    useSessionUIStore.setState({ currentSessionId: 'session-b' });
    expect(ui().tiledSwarmViewEnabled).toBe(false);
    expect(ui().tiledSwarmLayout).toBe('grid-4');
    expect(ui().tiledSwarmPinnedId).toBeNull();
    expect(ui().tiledSessionIds).toEqual([]);
    ui().setTiledSwarmLayout('split-2');

    useSessionUIStore.setState({ currentSessionId: 'session-a' });
    expect(ui().tiledSwarmViewEnabled).toBe(true);
    expect(ui().tiledSwarmLayout).toBe('columns-3');
    expect(ui().tiledSwarmPinnedId).toBe('sub-1');
    expect(ui().tiledSessionIds).toEqual(['x', 'y']);

    useSessionUIStore.setState({ currentSessionId: 'session-b' });
    expect(ui().tiledSwarmLayout).toBe('split-2');
    expect(ui().tiledSwarmViewEnabled).toBe(false);
  });

  test('switching to a null draft resets top-level state but keeps saved session', () => {
    const ui = () => useUIStore.getState();
    useSessionUIStore.setState({ currentSessionId: 'session-a' });
    ui().setTiledSwarmViewEnabled(true);
    ui().setTiledSwarmLayout('columns-3');
    ui().setTiledSwarmPinnedId('sub-1');
    ui().setTiledSessionIds(['x', 'y']);

    useSessionUIStore.setState({ currentSessionId: null });
    expect(ui().tiledSwarmViewEnabled).toBe(false);
    expect(ui().tiledSwarmLayout).toBe('grid-4');
    expect(ui().tiledSwarmPinnedId).toBeNull();
    expect(ui().tiledSessionIds).toEqual([]);
    expect(ui().tiledStateBySession['session-a']).toBeDefined();

    useSessionUIStore.setState({ currentSessionId: 'session-a' });
    expect(ui().tiledSwarmViewEnabled).toBe(true);
    expect(ui().tiledSwarmLayout).toBe('columns-3');
    expect(ui().tiledSwarmPinnedId).toBe('sub-1');
    expect(ui().tiledSessionIds).toEqual(['x', 'y']);
  });

  test('works with a null current session', () => {
    useSessionUIStore.setState({ currentSessionId: null });
    useUIStore.getState().toggleTiledSwarmView();
    useUIStore.getState().openTiledSwarmWithPin('p');
    expect(useUIStore.getState().tiledSwarmViewEnabled).toBe(true);
    expect(useUIStore.getState().tiledSwarmPinnedId).toBe('p');
    expect(useUIStore.getState().tiledStateBySession).toEqual({});
  });

  test('caps stored entries at 200', () => {
    for (let i = 0; i < 205; i++) {
      useSessionUIStore.setState({ currentSessionId: `s${i}` });
      useUIStore.getState().setTiledSwarmLayout('auto');
    }
    expect(Object.keys(useUIStore.getState().tiledStateBySession)).toHaveLength(200);
  });
});

describe('tiledSessionIds', () => {
  test('defaults to empty so the chat layout is untouched', () => {
    expect(useUIStore.getInitialState().tiledSessionIds).toEqual([]);
  });

  test('a picker can hand it an arbitrary list', () => {
    useUIStore.getState().setTiledSessionIds(['session-a', 'session-b']);

    expect(useUIStore.getState().tiledSessionIds).toEqual(['session-a', 'session-b']);
  });

  test('drops blanks and duplicates, since both would draw a bad pane', () => {
    useUIStore.getState().setTiledSessionIds(['a', 'a', ' ', 'b']);

    expect(useUIStore.getState().tiledSessionIds).toEqual(['a', 'b']);
  });

  test('clearing the list restores the default branch', () => {
    useUIStore.getState().setTiledSessionIds(['a']);
    useUIStore.getState().setTiledSessionIds([]);

    expect(useUIStore.getState().tiledSessionIds).toEqual([]);
  });
});
