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

from .store import valid_group

#: What a token is computed over, so a token for one purpose never doubles as another.
_TOKEN_CONTEXT = "annoquest/content-origin/v1"
_GROUP_CONTEXT = "annoquest/review-group/v1"


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


def group_scope(request: dict) -> str | None:
    """What a review group's token is bound to: a content request's site, so one group can review
    several pages of it. Because of that, a group name is the group's on the whole site: reuse a
    name only for the same people. Requests that are not content requests have no groups (None)."""
    content = request.get("content")
    if isinstance(content, dict) and isinstance(content.get("url"), str):
        return origin_of(content["url"])
    return None


def group_token(secret: bytes, scope: str, group: str) -> str:
    """The token that lets a link join review group ``group`` of ``scope`` (see :func:`group_scope`)."""
    return _b64(hmac.new(secret, f"{_GROUP_CONTEXT}\n{scope}\n{group}".encode("utf-8"), hashlib.sha256).digest()[:16])


def group_allows(secret: bytes, token: str | None, request: dict, group: str | None) -> bool:
    """Whether ``token`` is the server's token for review group ``group`` of ``request``."""
    scope = group_scope(request)
    if not token or not group or scope is None:
        return False
    return hmac.compare_digest(group_token(secret, scope, group), token)


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


#: Languages the viewer has a catalogue for (the TypeScript ``LANGS`` in ``src/lang.ts``; a test keeps them equal).
VIEWER_LANGS = ("en", "fr")


def content_link(
    secret: bytes, url: str, *, viewer: str, reader: str | None = None, lang: str | None = None, group: str | None = None
) -> str:
    """The link to send: ``viewer`` with the page, its site's token, and optionally a reader id and
    the viewer's language (``lang``, e.g. ``"fr"``; without it the viewer follows the page's
    ``<html lang>``, then the reader's browser). An unsupported ``lang`` raises ``ValueError``.

    With ``group``, the link joins that review group (``g=`` and its token ``gt=``): everyone
    holding a link of the group sees, answers and resolves the group's comments. Without it a
    reader sees only their own comments."""
    if lang and lang.strip().lower().replace("_", "-").split("-")[0] not in VIEWER_LANGS:
        raise ValueError(f"lang {lang!r}: the viewer speaks {', '.join(VIEWER_LANGS)}")
    params = {"content": url, "t": site_token(secret, url)}
    if reader:
        params["reader"] = reader
    if lang:
        params["lang"] = lang
    if group:
        if not valid_group(group):
            raise ValueError(f"group {group!r}: use letters, digits, '_', '.' or '-' (at most 64)")
        scope = origin_of(url)
        if scope is None:
            raise ValueError(f"Not an http(s) URL: {url!r}")
        params["g"] = group
        params["gt"] = group_token(secret, scope, group)
    return f"{viewer}{'&' if '?' in viewer else '?'}{urlencode(params)}"
