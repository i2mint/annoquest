import { describe, expect, it } from 'vitest';
import { CONTENT_INTRO, contentLink } from '../src/content';
import { presets, resolveResponseType } from '../src/presets';
import { presetLabels } from '../src/preset-labels';
import { catalogues, en, fill, fr, introText, pickLang, supported } from '../viewer/i18n';

describe('viewer language', () => {
  it('maps a tag to a catalogue by its primary subtag', () => {
    expect(supported('fr-CA')).toBe('fr');
    expect(supported('FR')).toBe('fr');
    expect(supported('en_GB')).toBe('en');
    expect(supported('de')).toBeUndefined();
    expect(supported('')).toBeUndefined();
  });

  it('picks the link, then the page, then the browser, then English', () => {
    expect(pickLang({ param: 'fr', page: 'en', browser: ['en-US'] })).toBe('fr');
    expect(pickLang({ param: null, page: 'fr', browser: ['en-US'] })).toBe('fr');
    expect(pickLang({ page: '', browser: ['de-DE', 'fr-FR'] })).toBe('fr');
    expect(pickLang({ param: 'xx', page: 'de', browser: ['ja'] })).toBe('en');
    expect(pickLang({})).toBe('en');
  });

  it('shows the content-link disclosure in the reader language, and anything else as written', () => {
    expect(introText(CONTENT_INTRO, fr)).toBe(fr.contentIntro);
    expect(introText(CONTENT_INTRO, en)).toBe(CONTENT_INTRO);
    expect(introText('Lisez la section 2.', fr)).toBe('Lisez la section 2.');
    expect(introText(undefined, fr)).toBeUndefined();
    // The disclosure keeps its substance: automatic sending, and what is recorded.
    expect(fr.contentIntro).toMatch(/envoyé automatiquement/);
    expect(fr.contentIntro).toMatch(/pages que vous ouvrez et le temps que vous passez/);
  });

  it('has every message in every catalogue, with the same shape', () => {
    for (const [lang, cat] of Object.entries(catalogues)) {
      expect(Object.keys(cat).sort(), lang).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(en)) {
        const w = (cat as Record<string, unknown>)[k];
        expect(typeof w, `${lang}.${k}`).toBe(typeof v);
        if (typeof v === 'function') expect((w as (...a: unknown[]) => unknown).length, `${lang}.${k}`).toBe(v.length);
      }
    }
  });

  it('fills placeholders with any value, keeping order', () => {
    expect(fill('Next up: {tier} items.', { tier: 42 })).toEqual(['Next up: ', 42, ' items.']);
    expect(fill(fr.nextUp, { tier: 'X' }).join('')).toContain('« X »');
  });

  it('puts lang= in a content link only when asked', () => {
    expect(contentLink('https://v.test/', 'https://p.test/a', 'tok')).not.toContain('lang=');
    expect(contentLink('https://v.test/', 'https://p.test/a', 'tok', { lang: 'fr' })).toMatch(/&lang=fr$/);
  });
});

describe('viewer language state', async () => {
  const { useViewer } = await import('../viewer/state');
  it('takes the first page lang, and keeps it when the reader follows a link', () => {
    const v = useViewer.getState();
    v.initLang({ param: null, browser: ['en-US'] });
    expect(useViewer.getState().lang).toBe('en');
    v.setPageLang('fr');
    expect(useViewer.getState().lang).toBe('fr');
    useViewer.getState().setPageLang(undefined); // a later page without lang
    useViewer.getState().setPageLang('en');
    expect(useViewer.getState().lang).toBe('fr');
  });
  it('lets the link lang win over the page', () => {
    useViewer.setState({ langFrom: { browser: [] } });
    useViewer.getState().initLang({ param: 'en', browser: ['fr-FR'] });
    useViewer.getState().setPageLang('fr');
    expect(useViewer.getState().lang).toBe('en');
  });
});

describe('preset labels per language (#25)', () => {
  const item = { id: 'a', response: 'agree' } as never;
  it('translates a built-in preset, keeping option values', () => {
    const en = resolveResponseType(item);
    const fr = resolveResponseType(item, undefined, { lang: 'fr' });
    expect(fr.label).toBe("D'accord ?");
    expect(fr.options.map((o) => o.value)).toEqual(en.options.map((o) => o.value));
    expect(fr.options.map((o) => o.tone)).toEqual(en.options.map((o) => o.tone));
    expect(resolveResponseType(item, undefined, { lang: 'en' })).toEqual(en);
  });
  it('lets item.labels and a request own responseTypes override', () => {
    const labelled = { id: 'a', response: 'agree', labels: { agree: 'Oui' } } as never;
    expect(resolveResponseType(labelled, undefined, { lang: 'fr' }).options[0]!.label).toBe('Oui');
    const own = { agree: { kind: 'choice', label: 'Mine', options: [{ value: 'agree', label: 'Mine', tone: 'positive' }] } } as never;
    expect(resolveResponseType(item, { responseTypes: own }, { lang: 'fr' }).label).toBe('Mine');
  });
  it('covers every option of every built-in preset in French', () => {
    for (const [name, rt] of Object.entries(presets)) {
      const t = presetLabels.fr?.[name];
      expect(t, name).toBeDefined();
      for (const o of rt.options) expect(t?.options?.[o.value], `${name}/${o.value}`).toBeTruthy();
    }
  });
});
