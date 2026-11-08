/**
 * The tiled layout presets, shared by every tiled surface. `auto` picks a
 * preset from how many sessions are actually doing something; the rest are
 * fixed shapes.
 *
 * Kept out of the component file so the deck module exports components only
 * (the fast-refresh lint rule) and the metrics stay trivially testable.
 */
export type TiledLayoutVariant = 'auto' | 'grid-4' | 'columns-3' | 'split-2';

export interface TiledLayoutMetrics {
  /** The concrete preset `auto` resolved to. */
  effectiveLayout: Exclude<TiledLayoutVariant, 'auto'>;
  /** The grid classes for that preset (kept here so every caller agrees). */
  gridClassName: string;
  /**
   * How many secondary panes the preset shows beside a lead pane. The swarm
   * preset has always capped itself this way (1 / 2 / 3 for 1:1, 3-col and
   * 2x2), so the number lives with the layout instead of each caller.
   */
  slotCap: number;
}

/**
 * Resolve a layout preset (and, for `auto`, the activity count that picks it)
 * into the effective layout, its grid classes, and the secondary-pane cap.
 * Extracted verbatim from the swarm view so a generic tiled surface can lay
 * out the exact same grid.
 */
export function resolveTiledLayout(layout: TiledLayoutVariant, activeCount: number): TiledLayoutMetrics {
  const effectiveLayout: TiledLayoutMetrics['effectiveLayout'] = layout === 'auto'
    ? (activeCount <= 1 ? 'split-2' : activeCount === 2 ? 'columns-3' : 'grid-4')
    : layout;

  const gridClassName = effectiveLayout === 'columns-3'
    ? 'grid min-h-0 flex-1 w-full grid-cols-1 md:grid-cols-3 gap-1.5'
    : effectiveLayout === 'split-2'
      ? 'grid min-h-0 flex-1 w-full grid-cols-1 md:grid-cols-2 gap-1.5'
      : 'grid min-h-0 flex-1 w-full grid-cols-1 auto-rows-fr md:grid-cols-2 md:grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-1.5';

  const slotCap = effectiveLayout === 'split-2' ? 1 : effectiveLayout === 'columns-3' ? 2 : 3;

  return { effectiveLayout, gridClassName, slotCap };
}
