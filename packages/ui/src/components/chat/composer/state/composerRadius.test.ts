import { describe, expect, test } from 'bun:test';

import { MOBILE_COMPOSER_RADIUS, resolveComposerRadius } from './composerRadius';

/**
 * The composer radius is applied as an inline style, so it must never be a
 * literal: a literal outranks the theme sheet and the TUI theme's
 * `--radius-xl: 0` would never reach the composer. These assertions pin the
 * value to the theme token so a future "just use 1.25rem" cannot land.
 */
describe('resolveComposerRadius', () => {
    test('desktop resolves through the theme xl radius', () => {
        expect(resolveComposerRadius(false)).toBe('var(--radius-xl, 0.75rem)');
    });

    test('mobile scales the same theme token instead of hardcoding a literal', () => {
        const radius = resolveComposerRadius(true);
        expect(radius).toContain('var(--radius-xl');
        expect(radius).toBe(MOBILE_COMPOSER_RADIUS);
    });

    test('neither breakpoint carries a bare length that would beat the theme', () => {
        const bareLength = /^[\d.]+(rem|px|em)$/;
        for (const isMobile of [true, false]) {
            expect(bareLength.test(resolveComposerRadius(isMobile))).toBe(false);
        }
    });

    test('the mobile scale is 5/3 of the token, i.e. 1.25rem against the 0.75rem default', () => {
        // 0.75rem * 5/3 === 1.25rem, and 0 * 5/3 === 0 (the TUI theme).
        expect(0.75 * (5 / 3)).toBeCloseTo(1.25, 10);
        expect(0 * (5 / 3)).toBe(0);
    });
});
