"""Content links: the server's token for a site, and the request a content link stands for.

A content link (``<viewer>?content=<url>&t=<token>``) opens any page for freeform
annotation. The token is an HMAC, under a secret the server keeps in its data
directory, of the page's *origin*: it lets that one site be proxied (and its links
followed) and lets the viewer register the content request for a page on it. Without
a token for its site, a page is neither proxied nor accepted, so the proxy is not open.

The request id is derived from the token and the URL exactly as the viewer derives it
(``src/content.ts``): ``c-`` + 22 base64url chars of SHA-256(token + "\\n" + url).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from pathlib import Path
from urllib.parse import urlencode, urlsplit

#: What a token is computed over, so a token for one purpose never doubles as another.
_TOKEN_CONTEXT = "annoquest/content-origin/v1"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def origin_of(url: str) -> str | None:
    """``scheme://host[:port]`` of an http(s) URL (lowercase, default ports dropped), else None."""
    try:
        u = urlsplit(url.strip())
        port = u.port
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or not u.hostname:
        return None
    default = {"http": 80, "https": 443}[u.scheme]
    host = u.hostname.lower()
    if ":" in host:  # IPv6 literal
        host = f"[{host}]"
    return f"{u.scheme}://{host}" + (f":{port}" if port and port != default else "")


def load_secret(data_dir: Path) -> bytes:
    """The server's signing secret, made on first use and kept in ``data_dir/secret`` (write-once)."""
    p = Path(data_dir) / "secret"
    if not p.is_file():
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f".secret.{secrets.token_hex(4)}.tmp")
        tmp.write_text(json.dumps({"secret": secrets.token_hex(32)}), encoding="utf-8")
        tmp.chmod(0o600)
        try:
            os.link(tmp, p)  # exclusive: two first uses cannot make two secrets
        except FileExistsError:
            pass
        finally:
            tmp.unlink(missing_ok=True)
    return bytes.fromhex(json.loads(p.read_text(encoding="utf-8"))["secret"])


def site_token(secret: bytes, url: str) -> str:
    """The token for the site (origin) of ``url``."""
    origin = origin_of(url)
    if origin is None:
        raise ValueError(f"Not an http(s) URL: {url!r}")
    return _b64(hmac.new(secret, f"{_TOKEN_CONTEXT}\n{origin}".encode("utf-8"), hashlib.sha256).digest()[:16])


def token_allows(secret: bytes, token: str | None, url: str) -> bool:
    """Whether ``token`` is the server's token for the site of ``url``."""
    if not token or origin_of(url) is None:
        return False
    return hmac.compare_digest(site_token(secret, url), token)


def content_request_id(url: str, token: str) -> str:
    return "c-" + _b64(hashlib.sha256(f"{token}\n{url}".encode("utf-8")).digest())[:22]


def is_content_request(secret: bytes, request: dict) -> bool:
    """Whether ``request`` is the content request a valid token allows: right id, one page, no items."""
    content = request.get("content")
    if not isinstance(content, dict):
        return False
    url, token = content.get("url"), content.get("token")
    if not isinstance(url, str) or not isinstance(token, str) or not token_allows(secret, token, url):
        return False
    docs = request.get("documents") or []
    return request.get("id") == content_request_id(url, token) and not request.get("items") and len(docs) == 1 and (docs[0] or {}).get("href") == url


def content_link(secret: bytes, url: str, *, viewer: str, reader: str | None = None) -> str:
    """The link to send: ``viewer`` with the page, its site's token, and optionally a reader id."""
    params = {"content": url, "t": site_token(secret, url)}
    if reader:
        params["reader"] = reader
    return f"{viewer}{'&' if '?' in viewer else '?'}{urlencode(params)}"
