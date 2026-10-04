/**
 * Rendering an inline document into the viewer's own DOM, in a shadow root.
 *
 * Used when the viewer itself runs in an opaque origin (a sandboxed host without
 * `allow-same-origin`, an email attachment): there, a nested frame gets an opaque
 * origin of its own and the guide cannot reach into it. The snapshot is parsed
 * inertly (DOMParser runs nothing), stripped of everything that could run or
 * navigate, and its styles are kept but scoped to the shadow root, with `html`,
 * `body` and `:root` rules re-aimed at the wrapper that stands in for the body.
 */

/** Elements that run, load other documents, or change how the page is addressed. */
const DROP = 'script, iframe, frame, frameset, object, embed, applet, base, meta, link, title, noscript, portal';
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'srcset'];
const UNSAFE_URL = /^\s*(javascript|vbscript|data:(?!image\/))/i;

/** Remove scripts, event handlers and script-like URLs, in place. */
export function sanitize(doc: Document, { baseUrl }: { baseUrl?: string } = {}): void {
  doc.querySelectorAll(DROP).forEach((el) => el.remove());
  // A snapshot's base may itself be relative (a path on the host it came from): resolve it here.
  let base: string | undefined;
  try {
    base = baseUrl ? new URL(baseUrl, location.href).href : undefined;
  } catch {
    base = undefined;
  }
  const abs = (u: string) => {
    try {
      return base ? new URL(u, base).href : u;
    } catch {
      return u;
    }
  };
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') el.removeAttribute(attr.name);
      else if (URL_ATTRS.includes(name) && UNSAFE_URL.test(attr.value)) el.removeAttribute(attr.name);
      else if (name === 'style' && /expression\s*\(|javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
    if (el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href')!.startsWith('#')) {
      el.setAttribute('href', abs(el.getAttribute('href')!));
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'IMG' && el.getAttribute('src') && !/^(data:|https?:)/.test(el.getAttribute('src')!)) {
      el.setAttribute('src', abs(el.getAttribute('src')!));
    }
    if (el.tagName === 'FORM') el.removeAttribute('action');
  }
}

/** Re-aim a stylesheet's document-level selectors at the shadow root's body stand-in. */
export function scopeCss(css: string, body = '.aq-body'): string {
  return css.replace(/(^|[{},\s>+~(])(html|body|:root)(?=[\s,{.:#[>+~)])/g, (_m, pre: string) => `${pre}${body}`);
}

const BASE = `
:host { all: initial; display: block; }
.aq-body { display: block; min-height: 100%; background: #fff; color: #111; font: 16px/1.5 Georgia, serif; padding: 8px 16px 40vh; box-sizing: border-box; }
`;

/**
 * Render `html` into a new shadow root on `host`; returns the root and the body stand-in.
 * In-document `#id` links scroll inside the shadow root instead of changing the viewer's URL.
 */
export function mountShadowDocument(host: HTMLElement, html: string, { baseUrl }: { baseUrl?: string } = {}) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const styles = Array.from(parsed.querySelectorAll('style')).map((s) => s.textContent ?? '');
  parsed.querySelectorAll('style').forEach((s) => s.remove());
  sanitize(parsed, { baseUrl });
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.replaceChildren();
  for (const css of [BASE, ...styles.map((c) => scopeCss(c))]) {
    const st = document.createElement('style');
    st.textContent = css;
    shadow.append(st);
  }
  const body = document.createElement('div');
  body.className = `aq-body ${parsed.body.className}`.trim();
  if (parsed.body.id) body.id = parsed.body.id;
  body.append(...Array.from(document.importNode(parsed.body, true).childNodes));
  shadow.append(body);
  body.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    const id = decodeURIComponent(a.getAttribute('href')!.slice(1));
    const el = id ? shadow.getElementById(id) : body;
    for (let d = el?.closest('details'); d; d = d.parentElement?.closest('details') ?? null) (d as HTMLDetailsElement).open = true;
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  return { shadow, body };
}
