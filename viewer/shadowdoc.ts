/**
 * Rendering an inline document into the viewer's own DOM, in a shadow root.
 *
 * Used only when the viewer itself runs in an opaque origin (a sandboxed host without
 * `allow-same-origin`, an email attachment): there, a nested frame gets an opaque
 * origin of its own and the guide cannot reach into it. Because the document then
 * shares the viewer's DOM, it is sanitised as untrusted HTML: DOMPurify (the
 * maintained sanitiser, with its URL rules that see through entity and control
 * character tricks), no forms, no SVG animation (which can set `href` after the
 * fact), and a final allow-list on every URL attribute. Its styles are kept but
 * scoped to the shadow root: `html` and `:root` rules are re-aimed at a root
 * stand-in, `body` rules at a body stand-in. The host contains painting, so nothing
 * in the document can draw over the guide.
 */
import DOMPurify from 'dompurify';

const URL_ATTRS = ['href', 'xlink:href', 'src', 'poster', 'background', 'action', 'formaction', 'data', 'cite', 'longdesc'];
const LINKS = 'a, area';

/** Whether a URL may stay on an element: http(s), mailto, an in-page fragment, or (for media) a data image. */
function allowedUrl(value: string, base: string | undefined, { media = false } = {}): string | null {
  const v = value.trim();
  if (v.startsWith('#')) return v;
  let u: URL;
  try {
    u = new URL(v, base ?? location.href);
  } catch {
    return null;
  }
  if (u.protocol === 'http:' || u.protocol === 'https:' || (!media && u.protocol === 'mailto:')) return u.href;
  if (media && u.protocol === 'data:' && /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(v)) return v;
  return null;
}

/** Sanitise a document's body markup into a fragment of the current document. */
export function sanitizeBody(html: string, { baseUrl }: { baseUrl?: string } = {}): DocumentFragment {
  let base: string | undefined;
  try {
    base = baseUrl ? new URL(baseUrl, location.href).href : undefined;
  } catch {
    base = undefined;
  }
  const purify = DOMPurify(window);
  const frag = purify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'option', 'style', 'link', 'meta', 'base', 'animate', 'set', 'animateMotion', 'animateTransform', 'discard', 'foreignObject'],
    FORBID_ATTR: ['action', 'formaction', 'srcdoc', 'ping', 'target'],
  }) as DocumentFragment;
  // Defence in depth: every URL-bearing attribute must parse to an allowed URL.
  const XLINK = 'http://www.w3.org/1999/xlink';
  for (const el of Array.from(frag.querySelectorAll('*'))) {
    el.removeAttribute('srcset'); // a list of URLs: not worth parsing, the plain src remains
    for (const name of URL_ATTRS) {
      const ns = name === 'xlink:href' ? XLINK : null;
      const v = ns ? el.getAttributeNS(ns, 'href') : el.getAttribute(name);
      if (v == null) continue;
      const ok = allowedUrl(v, base, { media: name === 'src' || name === 'poster' || name === 'background' });
      if (ok === null) ns ? el.removeAttributeNS(ns, 'href') : el.removeAttribute(name);
      else ns ? el.setAttributeNS(ns, 'xlink:href', ok) : el.setAttribute(name, ok);
    }
  }
  // Links never navigate the viewer: external ones open a new tab; in-page ones are handled on click.
  for (const a of Array.from(frag.querySelectorAll(`${LINKS}, svg a`))) {
    const href = a.getAttribute('href') ?? a.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (href && !href.startsWith('#')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return frag;
}

/**
 * Re-aim a stylesheet's document-level selectors at the stand-ins: `html` / `:root` at the root
 * stand-in, `body` at the body stand-in (so `html.dark body` still means what it meant).
 */
export function scopeCss(css: string, { root = '.aq-root', body = '.aq-body' } = {}): string {
  return css.replace(/(^|[{},\s>+~(])(html|body|:root)(?=[\s,{.:#[>+~)])/g, (_m, pre: string, sel: string) => `${pre}${sel === 'body' ? body : root}`);
}

const BASE = `
:host { all: initial; display: block; }
.aq-root { display: block; min-height: 100%; background: #fff; color: #111; font: 16px/1.5 Georgia, serif; }
.aq-body { display: block; padding: 8px 16px 40vh; box-sizing: border-box; }
`;

const copyAttrs = (from: Element, to: Element, keep = ['class', 'id', 'lang', 'dir']) => {
  for (const name of keep) {
    const v = from.getAttribute(name);
    if (v) to.setAttribute(name, name === 'class' ? `${to.getAttribute('class') ?? ''} ${v}`.trim() : v);
  }
  for (const a of Array.from(from.attributes)) if (a.name.startsWith('data-')) to.setAttribute(a.name, a.value);
};

/**
 * Render `html` into a new shadow root on `host`; returns the root and the body stand-in.
 * In-document `#id` links scroll inside the shadow root instead of changing the viewer's URL.
 */
export function mountShadowDocument(host: HTMLElement, html: string, { baseUrl }: { baseUrl?: string } = {}) {
  // Parsed inertly (DOMParser runs nothing) only to find the styles and the body markup.
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const styles = Array.from(parsed.querySelectorAll('style')).map((s) => s.textContent ?? '');
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.replaceChildren();
  for (const css of [BASE, ...styles.map((c) => scopeCss(c))]) {
    const st = document.createElement('style');
    st.textContent = css;
    shadow.append(st);
  }
  const root = document.createElement('div');
  root.className = 'aq-root';
  copyAttrs(parsed.documentElement, root, ['class', 'lang', 'dir']);
  const body = document.createElement('div');
  body.className = 'aq-body';
  copyAttrs(parsed.body, body);
  body.append(sanitizeBody(parsed.body.innerHTML, { baseUrl }));
  root.append(body);
  shadow.append(root);
  body.addEventListener('click', (e) => {
    const a = (e.composedPath()[0] as Element | null)?.closest?.('a[href], area[href]');
    if (!a) return;
    const href = a.getAttribute('href')!;
    if (!href.startsWith('#')) return; // external: target=_blank, opens a new tab
    e.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const el = id ? shadow.getElementById(id) : body;
    for (let d = el?.closest('details'); d; d = d.parentElement?.closest('details') ?? null) (d as HTMLDetailsElement).open = true;
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  // No form can be submitted from here, even one the sanitiser missed.
  body.addEventListener('submit', (e) => e.preventDefault(), true);
  return { shadow, body };
}
