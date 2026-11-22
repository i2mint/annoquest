/**
 * The viewer's own words, per language: one message catalogue each (English is the
 * default and the reference, French first), and the rule that picks one.
 *
 * Language, in order (`pickLang`, in `src/lang.ts`): the link's `lang=` (set by whoever
 * made the link), else the annotated page's `<html lang>` (the first page loaded; following
 * a link does not change it), else the browser's languages, else English. Until the page
 * has loaded, the panel shows the browser's language; a link made with `--lang` never
 * switches. A
 * message missing from a catalogue cannot happen: every catalogue is typed as
 * `Messages`, so the type checker refuses an incomplete one.
 *
 * Only the viewer's chrome is translated. What the requester wrote (titles, items,
 * intros, option labels) is shown as written, with one exception: the default intro
 * of a content link (`CONTENT_INTRO`), which is the disclosure that reading is
 * recorded, is shown in the reader's language with the same meaning. The request
 * itself keeps the English text, so every reader of one link registers the same
 * request whatever their language.
 */
import { CONTENT_INTRO } from '../src/content';
import type { Priority } from '../src/spec';
import { DEFAULT_LANG, pickLang, supported, type Lang } from '../src/lang';

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

export const en = {
  // Opening the request
  cannotOpen: 'This request could not be opened',
  loading: 'Loading…',
  needSignIn: 'You need to sign in to open this request. Reload the page to sign in.',
  notSentToYou: 'This request was not sent to you.',
  loadFailed: (status: number) => `The request could not be loaded (${status}).`,
  missingKey: 'This link is missing its key (the t= part). Ask for the link again.',
  noRequest: 'This page has no request in it. Open the link you were sent.',
  linkMismatch: 'This link does not match the request registered under its id, so answers cannot be sent. Ask its sender for a fresh link.',
  serverRefused: (detail: string) => `Your answers are saved here, but the server refused them (${detail}).`,
  // Landmarks (screen readers)
  documentLabel: 'Document',
  guideLabel: 'Guide',
  progressLabel: 'Progress',
  allItemsLabel: 'All items',
  answerLabel: 'Answer',
  yourCommentsLabel: 'Your comments',
  // Tiers
  tier: { must: 'Most important', should: 'Important', could: 'If you have time' } as Record<Priority, string>,
  /** A tier's name inside a sentence (`nextUp`). */
  tierInline: { must: 'most important', should: 'important', could: 'if you have time' } as Record<Priority, string>,
  // The document
  detachedOtherSite: "This document is on another site, so passages can't be highlighted here. Each item shows its passage, with a link to it in the original.",
  cannotShow: 'This document cannot be shown here. Each item shows its passage.',
  // Saving
  savedOnDevice: 'Saved on this device',
  cannotSaveOnDevice: "Couldn't save on this device — use “Download” when done",
  saving: 'Saving…',
  sendingShortly: 'Saved on this device · sending shortly',
  waitingForSender: 'Saved on this device · will send once the sender has opened this request',
  sentAt: (time: string) => `Saved · sent ${time}`,
  upToDate: 'Up to date',
  offline: 'Saved on this device · will send when back online',
  retry: 'Retry',
  signInAgain: 'Saved on this device · sign in again to send',
  signIn: 'Sign in',
  previewNotice: 'Preview: you sent this request, so nothing you click here is sent',
  publishing: 'Publishing…',
  previewNewVersion: 'Preview of a new version, not published yet. Readers still see the current one.',
  publishRevision: 'Publish as a new revision',
  notPublished: (why: string) => `Not published: ${why}`,
  // Header
  from: (name: string) => `From ${name}`,
  answeringAs: (who: string) => ` · answering as ${who}`,
  dueBy: (due: string) => ` · by ${due}`,
  // Intro (guided)
  itemCount: (n: number) => `${n} ${plural(n, 'item', 'items')}`,
  aboutMinutes: (m: number) => ` · about ${m} min`,
  startHint: (sentAutomatically: boolean) =>
    `Start with the most important ones; you can stop at any point. Every answer is saved as you give it${sentAutomatically ? ' and sent automatically' : ''}.`,
  yourNameForAnswers: 'Your name (so your answers can be told apart)',
  optional: 'Optional',
  continue: 'Continue',
  start: 'Start',
  // Between tiers
  tierDone: 'That tier is done. Thank you.',
  /** `{tier}` is replaced by the next tier's name, in bold. */
  nextUp: 'Next up: {tier} items. Keep going, or stop here; your answers are saved.',
  keepGoing: 'Keep going',
  stopHere: 'Stop here',
  finishForNow: 'Finish for now',
  // An item
  position: (i: number, n: number) => `${i} of ${n}`,
  minutes: (m: number) => `~${m} min`,
  passageMissing: 'This passage is no longer in the document as written; it may have been edited. The text above is what was asked about.',
  openPassage: 'Open this passage in the original ↗',
  passageChanged: 'The passage changed after you answered; please check your answer still holds.',
  itemUpdated: 'This item was updated since you last answered it; please check your answer still holds.',
  yourComment: 'Your comment',
  commentWhy: 'Comment (please say why)',
  commentOptional: 'Comment (optional)',
  aSentenceIsEnough: 'A sentence is enough',
  optionalButHelps: 'Optional, but it helps',
  shortReasonHelps: 'A short reason helps the requester act on this.',
  back: 'Back',
  next: 'Next',
  skipForNow: 'Skip for now',
  readAck: "I've read this",
  // The list of items
  toGo: (n: number) => `${n} to go`,
  allDone: 'all done',
  answered: 'answered',
  notAnswered: 'not answered',
  // Commenting on a selection
  selected: 'Selected:',
  commentOnThis: 'Comment on this',
  notSavedYet: 'Not saved yet',
  restoredAfterReload: ' (restored after a reload)',
  saveComment: 'Save comment',
  cancel: 'Cancel',
  // Done
  nOfTotalAnswered: (n: number, total: number) => `${n} of ${total} answered`,
  allDoneThanks: 'All done. Thank you.',
  comeBack: (left: number) => `You can come back to the ${left} remaining ${plural(left, 'item', 'items')} any time from this page; your answers are kept.`,
  answersSent: 'Your answers have been sent. Nothing else to do.',
  answersWillSend: 'Your answers are saved here and will be sent as soon as possible.',
  shareReplyLink: (who: string) => `Your answers are saved in this browser. To send them back, share this reply link with ${who}:`,
  theRequester: 'the requester',
  copied: 'Copied ✓',
  copyReplyLink: 'Copy reply link',
  emailIt: 'Email it',
  download: 'Download',
  replySubject: (title: string) => `Re: ${title}`,
  // Freeform
  /** The default intro of a content link: also the notice that reading is recorded. Same meaning in every language. */
  contentIntro: CONTENT_INTRO,
  freeformDefaultIntro: 'Select any passage in the page to comment on it.',
  yourNameForComments: 'Your name (optional, so your comments can be told apart)',
  selectHint: 'Select some text in the page, then “Comment on this”.',
  yourComments: (n: number) => `Your comments (${n})`,
  onPage: (where: string) => `On ${where}`,
  save: 'Save',
  delete: 'Delete',
  edit: 'edit',
  // Review groups
  discussion: (n: number) => `Discussion (${n})`,
  discussionLabel: 'Discussion',
  groupHint: 'Everyone with a link of this review group sees these comments, and can reply.',
  you: 'You',
  theOwner: 'The owner',
  reply: 'Reply',
  yourReply: 'Your reply',
  sendReply: 'Send reply',
  resolve: 'Resolve',
  reopen: 'Reopen',
  resolvedBy: (who: string) => `Resolved by ${who}`,
  replies: (n: number) => `${n} ${plural(n, 'reply', 'replies')}`,
};

export type Messages = typeof en;

export const fr: Messages = {
  cannotOpen: "Cette demande n'a pas pu être ouverte",
  loading: 'Chargement…',
  needSignIn: 'Vous devez vous connecter pour ouvrir cette demande. Rechargez la page pour vous connecter.',
  notSentToYou: "Cette demande ne vous a pas été envoyée.",
  loadFailed: (status) => `La demande n'a pas pu être chargée (${status}).`,
  missingKey: 'Il manque la clé de ce lien (la partie t=). Redemandez le lien.',
  noRequest: "Cette page ne contient aucune demande. Ouvrez le lien que l'on vous a envoyé.",
  linkMismatch: "Ce lien ne correspond pas à la demande enregistrée sous son identifiant : les réponses ne peuvent donc pas être envoyées. Demandez un nouveau lien à son expéditeur.",
  serverRefused: (detail) => `Vos réponses sont enregistrées ici, mais le serveur les a refusées (${detail}).`,
  documentLabel: 'Document',
  guideLabel: 'Guide',
  progressLabel: 'Progression',
  allItemsLabel: 'Tous les points',
  answerLabel: 'Réponse',
  yourCommentsLabel: 'Vos commentaires',
  tier: { must: 'Le plus important', should: 'Important', could: 'Si vous avez le temps' },
  tierInline: { must: 'le plus important', should: 'important', could: 'si vous avez le temps' },
  detachedOtherSite: "Ce document est sur un autre site : les passages ne peuvent pas y être surlignés. Chaque point montre son passage, avec un lien vers l'original.",
  cannotShow: 'Ce document ne peut pas être affiché ici. Chaque point montre son passage.',
  savedOnDevice: 'Enregistré sur cet appareil',
  cannotSaveOnDevice: "Impossible d'enregistrer sur cet appareil — utilisez « Télécharger » à la fin",
  saving: 'Enregistrement…',
  sendingShortly: 'Enregistré sur cet appareil · envoi dans un instant',
  waitingForSender: "Enregistré sur cet appareil · sera envoyé dès que l'expéditeur aura ouvert cette demande",
  sentAt: (time) => `Enregistré · envoyé à ${time}`,
  upToDate: 'À jour',
  offline: 'Enregistré sur cet appareil · sera envoyé au retour de la connexion',
  retry: 'Réessayer',
  signInAgain: 'Enregistré sur cet appareil · reconnectez-vous pour envoyer',
  signIn: 'Se connecter',
  previewNotice: "Aperçu : vous avez envoyé cette demande, rien de ce que vous faites ici n'est envoyé",
  publishing: 'Publication…',
  previewNewVersion: "Aperçu d'une nouvelle version, pas encore publiée. Les lecteurs voient toujours la version actuelle.",
  publishRevision: 'Publier comme nouvelle révision',
  notPublished: (why) => `Non publié : ${why}`,
  from: (name) => `De ${name}`,
  answeringAs: (who) => ` · vous répondez en tant que ${who}`,
  dueBy: (due) => ` · échéance : ${due}`,
  itemCount: (n) => `${n} ${plural(n, 'point', 'points')}`,
  aboutMinutes: (m) => ` · environ ${m} min`,
  startHint: (sentAutomatically) =>
    `Commencez par les plus importants ; vous pouvez vous arrêter à tout moment. Chaque réponse est enregistrée dès que vous la donnez${sentAutomatically ? ' et envoyée automatiquement' : ''}.`,
  yourNameForAnswers: 'Votre nom (pour distinguer vos réponses)',
  optional: 'Facultatif',
  continue: 'Continuer',
  start: 'Commencer',
  tierDone: 'Ce niveau est terminé. Merci.',
  nextUp: 'À suivre : les points « {tier} ». Continuez, ou arrêtez-vous ici ; vos réponses sont enregistrées.',
  keepGoing: 'Continuer',
  stopHere: "M'arrêter ici",
  finishForNow: "Terminer pour l'instant",
  position: (i, n) => `${i} sur ${n}`,
  minutes: (m) => `~${m} min`,
  passageMissing: "Ce passage ne figure plus tel quel dans le document ; il a peut-être été modifié. Le texte ci-dessus est celui sur lequel porte la question.",
  openPassage: "Ouvrir ce passage dans l'original ↗",
  passageChanged: 'Le passage a changé depuis votre réponse ; vérifiez que votre réponse tient toujours.',
  itemUpdated: 'Ce point a été modifié depuis votre dernière réponse ; vérifiez que votre réponse tient toujours.',
  yourComment: 'Votre commentaire',
  commentWhy: 'Commentaire (dites pourquoi, s’il vous plaît)',
  commentOptional: 'Commentaire (facultatif)',
  aSentenceIsEnough: 'Une phrase suffit',
  optionalButHelps: 'Facultatif, mais utile',
  shortReasonHelps: 'Une courte explication aide le demandeur à y donner suite.',
  back: 'Retour',
  next: 'Suivant',
  skipForNow: "Passer pour l'instant",
  readAck: "J'ai lu",
  toGo: (n) => `${n} ${plural(n, 'restant', 'restants')}`,
  allDone: 'tout est fait',
  answered: 'avec réponse',
  notAnswered: 'sans réponse',
  selected: 'Sélection :',
  commentOnThis: 'Commenter ce passage',
  notSavedYet: 'Pas encore enregistré',
  restoredAfterReload: ' (restauré après un rechargement)',
  saveComment: 'Enregistrer le commentaire',
  cancel: 'Annuler',
  nOfTotalAnswered: (n, total) => `${n} ${plural(n, 'réponse', 'réponses')} sur ${total}`,
  allDoneThanks: 'Tout est fait. Merci.',
  comeBack: (left) =>
    `Vous pouvez revenir ${plural(left, 'au point restant', `aux ${left} points restants`)} à tout moment depuis cette page ; vos réponses sont conservées.`,
  answersSent: 'Vos réponses ont été envoyées. Vous n’avez rien d’autre à faire.',
  answersWillSend: 'Vos réponses sont enregistrées ici et seront envoyées dès que possible.',
  shareReplyLink: (who) => `Vos réponses sont enregistrées dans ce navigateur. Pour les renvoyer, partagez ce lien de réponse avec ${who} :`,
  theRequester: 'le demandeur',
  copied: 'Copié ✓',
  copyReplyLink: 'Copier le lien de réponse',
  emailIt: "L'envoyer par e-mail",
  download: 'Télécharger',
  replySubject: (title) => `Re : ${title}`,
  contentIntro:
    "Parcourez la page et surlignez n'importe quel passage pour le commenter. Il n'y a rien à enregistrer ni à soumettre : tout ce que vous faites ici est envoyé automatiquement au fur et à mesure, y compris les pages que vous ouvrez et le temps que vous passez sur chacune. Vous pouvez revenir à ce lien et modifier vos commentaires à tout moment.",
  freeformDefaultIntro: "Sélectionnez n'importe quel passage de la page pour le commenter.",
  yourNameForComments: 'Votre nom (facultatif, pour distinguer vos commentaires)',
  selectHint: 'Sélectionnez du texte dans la page, puis « Commenter ce passage ».',
  yourComments: (n) => `Vos commentaires (${n})`,
  onPage: (where) => `Sur ${where}`,
  save: 'Enregistrer',
  delete: 'Supprimer',
  edit: 'modifier',
  discussion: (n) => `Discussion (${n})`,
  discussionLabel: 'Discussion',
  groupHint: 'Toutes les personnes qui ont un lien de ce groupe de relecture voient ces commentaires et peuvent y répondre.',
  you: 'Vous',
  theOwner: 'Le responsable',
  reply: 'Répondre',
  yourReply: 'Votre réponse',
  sendReply: 'Envoyer la réponse',
  resolve: 'Marquer comme traité',
  reopen: 'Rouvrir',
  resolvedBy: (who) => `Traité par ${who}`,
  replies: (n) => `${n} ${plural(n, 'réponse', 'réponses')}`,
};

/** Every catalogue, by language (the list is `LANGS` in `src/lang.ts`; a missing one fails the type check). */
export const catalogues: Record<Lang, Messages> = { en, fr };
export { DEFAULT_LANG, pickLang, supported, type Lang };

/** A request's intro as the reader should see it: the content links' default disclosure in their language, anything else as written. */
export function introText(intro: string | undefined, t: Messages): string | undefined {
  return intro === CONTENT_INTRO ? t.contentIntro : intro;
}

/** Split a message with `{name}` placeholders into text and the given values (e.g. React nodes), in order. */
export function fill<V>(template: string, values: Record<string, V>): Array<string | V> {
  return template.split(/\{(\w+)\}/).map((part, i) => (i % 2 ? (values[part] ?? `{${part}}`) : part));
}
