/**
 * The chat composer's corner radius, as a CSS value.
 *
 * The composer applies its radius through an inline `style`, and an inline
 * style outranks every stylesheet rule. That makes a literal radius a theme
 * trap: a theme that shapes the UI by setting `--radius-xl` (including to `0`
 * for square corners) can never reach the composer, because the inline
 * declaration wins. The radius must therefore always resolve through the theme
 * token, with the token's own default as the fallback for contexts that load
 * no theme sheet.
 *
 * Mobile keeps the softer touch corner it has always had — 1.25rem against the
 * default 0.75rem token — by scaling the token rather than hardcoding the
 * literal. 5/3 of 0.75rem is exactly 1.25rem, so the default theme renders
 * pixel-identically, and 5/3 of 0 is 0, so a squared theme squares the phone
 * composer too.
 */
const COMPOSER_RADIUS_TOKEN = 'var(--radius-xl, 0.75rem)';

/** Mobile composer corner: the theme's xl radius, a third rounder. */
export const MOBILE_COMPOSER_RADIUS = `calc(${COMPOSER_RADIUS_TOKEN} * 5 / 3)`;

export function resolveComposerRadius(isMobile: boolean): string {
    return isMobile ? MOBILE_COMPOSER_RADIUS : COMPOSER_RADIUS_TOKEN;
}
