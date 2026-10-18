"""The content proxy: another site's page, served from the viewer's origin so it can be annotated.

A frame from another origin is closed to the viewer (no highlighting, no selection,
no navigation tracking). So for a content link to a page elsewhere, the server
fetches the page and serves it itself, rewritten:

- subresources (images, styles, fonts, media) are made absolute to the original
  site, so they load from there;
- links on the same site come back through the proxy (``proxy?u=…&t=…``, relative,
  so it works wherever the app is mounted), so following them stays annotatable;
  links elsewhere open a new tab;
- scripts, ``<base>`` and meta refreshes are dropped, event-handler attributes too;
- the response carries a CSP ``sandbox`` without ``allow-scripts`` and no
  ``script-src``: nothing runs in it, framed or visited directly.

It is not an open proxy: ``token_allows`` (see ``content``) decides which sites
may be fetched, and :func:`safe_fetch` refuses anything but http(s) on default
ports to public addresses (checked on the address it then connects to, and on
every redirect), caps the size and time, and only returns HTML.
"""

from __future__ import annotations

import html
import http.client
import ipaddress
import re
import socket
import ssl
from collections.abc import Callable
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import quote, urljoin, urlsplit

MAX_PAGE_BYTES = 5 * 1024 * 1024
TIMEOUT_S = 10.0
MAX_REDIRECTS = 5
USER_AGENT = "annoquest-proxy/0.2 (+https://github.com/i2mint/annoquest)"
HTML_TYPES = ("text/html", "application/xhtml+xml")

#: Served with every proxied page: no script, no form, no plugin; same-origin only so the viewer can read it.
PROXY_CSP = (
    "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox; "
    "default-src 'none'; img-src * data: blob:; media-src *; style-src * 'unsafe-inline'; font-src * data:; frame-src *"
)
PROXY_HEADERS = {
    "Content-Security-Policy": PROXY_CSP,
    "X-Content-Type-Options": "nosniff",
    # The proxy URL carries the token: never send it on to the sites the page loads from.
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, max-age=300",
}


class ProxyRefused(Exception):
    """The page cannot be fetched (a reason a reader can read is in ``args[0]``)."""

    def __init__(self, message: str, status: int = 403):
        super().__init__(message)
        self.status = status


@dataclass
class Fetched:
    url: str
    status: int
    content_type: str
    charset: str | None
    body: bytes


def public_ips(host: str, port: int) -> list[str]:
    """The host's addresses, if every one of them is public; refuses private, loopback, link-local, reserved."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise ProxyRefused(f"{host} could not be found.", 502) from e
    ips = sorted({i[4][0] for i in infos})
    for ip in ips:
        a = ipaddress.ip_address(ip.split("%")[0])
        if not a.is_global or a.is_multicast:
            raise ProxyRefused(f"{host} is not a public address.")
    if not ips:
        raise ProxyRefused(f"{host} could not be found.", 502)
    return ips


class _PinnedHTTP(http.client.HTTPConnection):
    """Connects to the address that was checked, not to whatever the name resolves to next (DNS rebinding)."""

    def __init__(self, host, ip, **kw):
        super().__init__(host, **kw)
        self._ip = ip

    def connect(self):
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, ip, **kw):
        super().__init__(host, context=ssl.create_default_context(), **kw)
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def safe_fetch(
    url: str,
    *,
    allowed: Callable[[str], bool],
    resolve: Callable[[str, int], list[str]] = public_ips,
    max_bytes: int = MAX_PAGE_BYTES,
    timeout: float = TIMEOUT_S,
    max_redirects: int = MAX_REDIRECTS,
) -> Fetched:
    """GET ``url`` as a browser would, within the limits above; every hop must pass ``allowed``."""
    for _ in range(max_redirects + 1):
        u = urlsplit(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise ProxyRefused("Only web pages (http and https) can be opened here.")
        if u.port not in (None, 80, 443):
            raise ProxyRefused("Only pages on the standard web ports can be opened here.")
        if not allowed(url):
            raise ProxyRefused("This link leads to another site, which this link does not open here.")
        port = u.port or (443 if u.scheme == "https" else 80)
        ip = resolve(u.hostname, port)[0]
        conn_cls = _PinnedHTTPS if u.scheme == "https" else _PinnedHTTP
        conn = conn_cls(u.hostname, ip, port=port, timeout=timeout)
        try:
            path = (u.path or "/") + (f"?{u.query}" if u.query else "")
            conn.request("GET", path, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Encoding": "identity", "Accept-Language": "en,*;q=0.5"})
            res = conn.getresponse()
            if res.status in (301, 302, 303, 307, 308) and res.getheader("Location"):
                url = urljoin(url, res.getheader("Location"))
                continue
            ctype = (res.getheader("Content-Type") or "").split(";")[0].strip().lower()
            m = re.search(r"charset=([\w.:-]+)", res.getheader("Content-Type") or "", re.I)
            if ctype and ctype not in HTML_TYPES:
                return Fetched(url, res.status, ctype, None, b"")
            body = res.read(max_bytes + 1)
            if len(body) > max_bytes:
                raise ProxyRefused("This page is too large to open here.", 502)
            return Fetched(url, res.status, ctype or "text/html", m.group(1) if m else None, body)
        except (OSError, http.client.HTTPException) as e:
            raise ProxyRefused(f"{u.hostname} did not answer ({type(e).__name__}).", 502) from e
        finally:
            conn.close()
    raise ProxyRefused("Too many redirects.", 502)


def decode(body: bytes, charset: str | None) -> str:
    """The page's text: the declared charset, else a `<meta charset>` near the top, else UTF-8."""
    if not charset:
        m = re.search(rb"""<meta[^>]+charset=["']?([\w.:-]+)""", body[:4096], re.I)
        charset = m.group(1).decode("ascii", "ignore") if m else "utf-8"
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


# ---- rewriting ---------------------------------------------------------------

_URL_ATTRS = {"src", "href", "poster", "background", "data", "action", "formaction", "cite", "longdesc", "xlink:href", "manifest", "icon"}
_LINK_TAGS = {"a", "area"}
_CSS_URL = re.compile(r"""url\(\s*(['"]?)([^'")]+)\1\s*\)""", re.I)
_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


def _absolute(base: str, value: str) -> str:
    v = value.strip()
    if not v or v.startswith(("#", "data:", "blob:", "mailto:", "tel:")):
        return v
    if v.lower().startswith(("javascript:", "vbscript:")):
        return ""
    return urljoin(base, v)


def _css(base: str, css: str) -> str:
    return _CSS_URL.sub(lambda m: f"url({m.group(1)}{_absolute(base, m.group(2))}{m.group(1)})", css)


class _Rewriter(HTMLParser):
    def __init__(self, base: str, link: Callable[[str], str | None]):
        super().__init__(convert_charrefs=False)
        self.base = base
        self.link = link
        self.out: list[str] = []
        self.skip = 0  # inside <script>
        self.in_style = False
        self.based = False

    def _attrs(self, tag: str, attrs: list[tuple[str, str | None]]) -> list[tuple[str, str | None]] | None:
        names = {k for k, _ in attrs}
        if tag == "base":
            if not self.based and (h := dict(attrs).get("href")):
                self.base, self.based = urljoin(self.base, h), True
            return None
        if tag == "meta" and (dict(attrs).get("http-equiv") or "").lower() in ("refresh", "content-security-policy", "set-cookie"):
            return None
        out: list[tuple[str, str | None]] = []
        external = False
        for k, v in attrs:
            k = k.lower()
            if k.startswith("on") or k in ("srcdoc", "ping", "nonce", "integrity", "target"):
                continue
            if v is not None and tag in _LINK_TAGS and k == "href":
                v = v.strip()
                if v.startswith("#"):
                    out.append((k, v))
                    continue
                absolute = _absolute(self.base, v)
                if not absolute:
                    continue
                proxied = self.link(absolute) if absolute.startswith(("http://", "https://")) else None
                external = proxied is None and absolute.startswith(("http://", "https://"))
                out.append((k, proxied or absolute))
            elif v is not None and k in _URL_ATTRS:
                if absolute := _absolute(self.base, v):
                    out.append((k, absolute))
            elif v is not None and k in ("srcset", "imagesrcset"):
                out.append((k, ", ".join(" ".join([_absolute(self.base, p.strip().split(" ")[0]), *p.strip().split(" ")[1:]]) for p in v.split(",") if p.strip())))
            elif v is not None and k == "style":
                out.append((k, _css(self.base, v)))
            else:
                out.append((k, v))
        if external and "rel" not in names:
            out += [("target", "_blank"), ("rel", "noopener noreferrer")]
        elif external:
            out.append(("target", "_blank"))
        return out

    @staticmethod
    def _tag(tag: str, attrs: list[tuple[str, str | None]], close: bool = False) -> str:
        parts = "".join(f" {k}" if v is None else f' {k}="{html.escape(v, quote=True)}"' for k, v in attrs)
        return f"<{tag}{parts}{' /' if close else ''}>"

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self.skip += 1
            return
        if self.skip:
            return
        a = self._attrs(tag, attrs)
        if a is None:
            return
        self.in_style = tag == "style"
        self.out.append(self._tag(tag, a))

    def handle_startendtag(self, tag, attrs):
        if self.skip or tag == "script":
            return
        a = self._attrs(tag, attrs)
        if a is not None:
            self.out.append(self._tag(tag, a, close=tag not in _VOID))

    def handle_endtag(self, tag):
        if tag == "script":
            self.skip = max(0, self.skip - 1)
            return
        if self.skip or tag == "base":
            return
        if tag == "style":
            self.in_style = False
        self.out.append(f"</{tag}>")

    def handle_data(self, data):
        if self.skip:
            return
        self.out.append(_css(self.base, data) if self.in_style else data)

    def handle_entityref(self, name):
        if not self.skip:
            self.out.append(f"&{name};")

    def handle_charref(self, name):
        if not self.skip:
            self.out.append(f"&#{name};")

    def handle_comment(self, data):
        if not self.skip:
            self.out.append(f"<!--{data}-->")

    def handle_decl(self, decl):
        self.out.append(f"<!{decl}>")

    def handle_pi(self, data):
        self.out.append(f"<?{data}>")

    def unknown_decl(self, data):
        self.out.append(f"<![{data}]>")


def rewrite(page: str, *, url: str, link: Callable[[str], str | None]) -> str:
    """The page with subresources absolute to ``url``, links through ``link`` (None: open in a new tab), no scripts."""
    r = _Rewriter(url, link)
    r.feed(page)
    r.close()
    return "".join(r.out)


def proxy_link(token: str, *, allowed: Callable[[str], bool]) -> Callable[[str], str | None]:
    """Links back through the proxy (relative to it) for allowed pages; None for the rest."""

    def link(absolute: str) -> str | None:
        if not allowed(absolute):
            return None
        page, _, frag = absolute.partition("#")
        return f"proxy?u={quote(page, safe='')}&t={quote(token, safe='')}" + (f"#{frag}" if frag else "")

    return link


def notice_page(message: str, *, url: str | None = None) -> str:
    """A small page shown in the frame instead of one that cannot be proxied."""
    link = f'<p><a href="{html.escape(url, quote=True)}" target="_blank" rel="noopener noreferrer">Open it in a new tab ↗</a></p>' if url else ""
    return f'<!doctype html><html><head><meta charset="utf-8"><title>Not shown here</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:36em;margin:3em auto;padding:0 1em"><p>{html.escape(message)}</p>{link}</body></html>'
