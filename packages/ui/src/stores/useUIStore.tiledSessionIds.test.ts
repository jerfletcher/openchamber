import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalState = useUIStore.getState();

afterEach(() => {
  useUIStore.setState(originalState, true);
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
