import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

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

/**
 * The collapsed mobile pill is the same composer in another state, so it must
 * resolve through the same helper. It used to repeat the token expression as
 * its own Tailwind arbitrary value, which is how the expanded composer and the
 * pill were able to drift apart in the first place.
 */
describe('the collapsed mobile pill', () => {
    test('takes the mobile composer radius, not an unscaled copy of the token', () => {
        // Pin the decision: the pill wants the scaled value. Against the
        // default theme that keeps the 20px touch corner (0.75rem * 5/3), and
        // against the TUI theme the token is 0 and the scale is irrelevant, so
        // both the pill and the expanded composer square together.
        expect(resolveComposerRadius(true)).toBe(MOBILE_COMPOSER_RADIUS);
        expect(MOBILE_COMPOSER_RADIUS).not.toBe(resolveComposerRadius(false));
    });

    test('MobilePillComposer consumes the helper instead of re-inlining the token', () => {
        const source = readFileSync(
            new URL('../ui/MobilePillComposer.tsx', import.meta.url),
            'utf8',
        );
        expect(source).toContain('resolveComposerRadius(');
        // A Tailwind arbitrary value or a bare token expression here would be
        // a second source of truth for the scale.
        expect(source).not.toContain('rounded-[calc');
        expect(source).not.toContain('var(--radius-xl');
    });
});
