/**
 * The languages the viewer speaks, and the rule that picks one for a reader.
 *
 * Kept in `src/` (not `viewer/`) because links and the CLI validate `lang` against the same
 * list, and resolving presets per language (#25) will need it too. The messages themselves are
 * the viewer's (`viewer/i18n.ts`); a language is added there and here together, and the
 * Python server's `VIEWER_LANGS` is checked against this list by its tests.
 */

/** Primary language subtags with a viewer catalogue. */
export const LANGS = ['en', 'fr'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'en';

/** The supported language a BCP 47 tag maps to (`fr-CA` → `fr`), or undefined if there is none. */
export function supported(tag: string | null | undefined): Lang | undefined {
  const primary = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return (LANGS as readonly string[]).includes(primary ?? '') ? (primary as Lang) : undefined;
}

/**
 * The reader's language: the link's `lang=`, else the page's `<html lang>`, else the first of
 * the browser's languages there is a catalogue for, else English. An unsupported value at one
 * level falls through to the next.
 */
export function pickLang({ param, page, browser = [] }: { param?: string | null; page?: string | null; browser?: readonly string[] }): Lang {
  return supported(param) ?? supported(page) ?? browser.map(supported).find(Boolean) ?? DEFAULT_LANG;
}
