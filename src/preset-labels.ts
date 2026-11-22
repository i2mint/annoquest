/**
 * Built-in presets' labels per language (#25), keyed by preset name, then option value.
 *
 * English lives on the presets themselves (`presets.ts`); this table holds the other languages.
 * `resolveResponseType(item, request, { lang })` applies it to a built-in preset only: a
 * request's own `responseTypes` and an item's `labels` always win, and option `value`s never
 * change, so answers and exports compare across readers. A language or an entry missing here
 * falls back to the English label.
 */
import type { Lang } from './lang';

export interface PresetLabels {
  label?: string;
  options?: Readonly<Record<string, string>>;
}

export const presetLabels: Readonly<Partial<Record<Lang, Readonly<Record<string, PresetLabels>>>>> = Object.freeze({
  fr: {
    read: { label: 'Lu', options: { read: "J'ai lu" } },
    noted: { label: 'Pris note', options: { noted: 'Pris note', question: "J'ai une question" } },
    agree: {
      label: "D'accord ?",
      options: {
        agree: "D'accord",
        reservations: "D'accord, avec réserves",
        discuss: 'Discutons-en',
        disagree: "Pas d'accord",
        na: 'Pas mon domaine',
      },
    },
    consent: {
      label: 'Consentement ?',
      options: {
        consent: 'Assez bien pour l’instant',
        concern: 'Une inquiétude, mais allez-y',
        object: 'Objection',
        'stand-aside': 'Je me retire',
      },
    },
    implement: {
      label: 'Mise en œuvre',
      options: {
        done: 'Déjà fait',
        will: 'Sera fait',
        discuss: 'Discutons-en',
        wont: 'Ne sera pas fait',
        na: 'Pas mon domaine',
      },
    },
    approve: {
      label: 'Validation',
      options: {
        approve: 'Approuver',
        'approve-with-changes': 'Approuver avec modifications',
        changes: 'Modifications requises',
        'not-relevant': 'Ne me concerne pas',
      },
    },
    gradient: {
      label: "Degrés d'accord",
      options: {
        '1': "J'aime ça",
        '2': "J'aime plutôt ça",
        '3': "Je peux m'en accommoder",
        '4': "Je n'ai pas d'avis",
        '5': "Je n'aime pas, mais je ne bloquerai pas",
        '6': 'Je ne suis pas d’accord, mais je suivrai le groupe',
        '7': 'Je ne suis pas d’accord et ne veux pas participer à la mise en œuvre',
        '8': 'Je mets mon veto',
      },
    },
    'fist-to-five': {
      label: 'Du poing aux cinq doigts',
      options: {
        '0': '0 — non, je bloque',
        '1': '1 — de sérieuses inquiétudes',
        '2': '2 — quelques inquiétudes',
        '3': '3 — je peux m’en accommoder',
        '4': '4 — bien',
        '5': '5 — excellent',
      },
    },
    moscow: {
      label: 'Quelle importance ?',
      options: {
        must: 'Indispensable',
        should: 'Devrait avoir',
        could: 'Pourrait avoir',
        wont: 'Pas cette fois',
      },
    },
    comment: { label: 'Commentaire' },
    label: { label: 'Étiquette' },
  },
});
