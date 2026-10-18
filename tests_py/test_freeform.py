"""v0.2: content links, the public mode, the event log, and the proxy."""

import json

import pytest
from starlette.testclient import TestClient

from annoquest_server import content_link, content_request_id, load_secret, mk_app, site_token, token_allows
from annoquest_server.__main__ import main as cli
from annoquest_server.content import is_content_request, origin_of
from annoquest_server.proxy import Fetched, ProxyRefused, public_ips, rewrite, proxy_link, safe_fetch

PAGE = "https://example.org/essays/one.html"


def content_request(secret, url=PAGE):
    token = site_token(secret, url)
    return {
        "schema": "annoquest/request",
        "version": 1,
        "id": content_request_id(url, token),
        "title": "example.org/essays/one.html",
        "documents": [{"id": "page", "href": url, "source": {"kind": "url", "url": f"/api/annoquest/proxy?u={url}&t={token}"}}],
        "items": [],
        "allowExtra": True,
        "track": True,
        "sink": {"kind": "http", "url": "/api/annoquest"},
        "content": {"url": url, "token": token},
    }


def batch(rid, events, *, reader="d-abc", device="dev-0000000001"):
    return {"schema": "annoquest/events", "request": rid, "reader": reader, "device": device, "events": events}


def ev(i, type_, **kw):
    return {"id": f"e{i}", "session": "s1", "seq": i, "at": f"2026-10-19T10:00:{i:02d}Z", "type": type_, **kw}


class FakeFetch:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def __call__(self, url, *, allowed):
        self.calls.append(url)
        if not allowed(url):
            raise ProxyRefused("another site")
        body, ctype = self.pages[url]
        return Fetched(url, 200, ctype, "utf-8", body.encode())


@pytest.fixture
def public(tmp_path):
    pages = {PAGE: ('<html><head><base href="/essays/"><script>alert(1)</script><link rel="stylesheet" href="s.css"></head><body><p onclick="x()">Hello <a href="two.html">next</a> <a href="https://elsewhere.net/x">out</a> <img src="i.png" srcset="i.png 1x, i2.png 2x"></p></body></html>', "text/html"), "https://example.org/f.pdf": ("", "application/pdf")}
    fetch = FakeFetch(pages)
    app = mk_app(public=True, api_prefix="", data_dir=tmp_path / "data", viewer=tmp_path / "none.html", fetch=fetch)
    return TestClient(app), tmp_path / "data", fetch


# ---- tokens and content requests ---------------------------------------------------------


def test_tokens_are_per_site(tmp_path):
    secret = load_secret(tmp_path)
    assert load_secret(tmp_path) == secret  # made once, then kept
    t = site_token(secret, PAGE)
    assert token_allows(secret, t, "https://EXAMPLE.org:443/other/page?q=1")
    assert not token_allows(secret, t, "https://example.org.evil.net/")
    assert not token_allows(secret, t, "http://example.org/")  # another scheme is another origin
    assert not token_allows(secret, "x" + t[1:], PAGE)
    assert not token_allows(secret, t, "file:///etc/passwd")
    assert origin_of("https://[::1]:8443/x") == "https://[::1]:8443"


def test_content_request_id_matches_the_viewer():
    # The viewer computes the same in src/content.ts (tests/core.test.ts checks this value too).
    assert content_request_id("https://example.org/a", "tok") == "c-x8Tyt-0v08NNPHh33Ffl-a"


def test_content_link(tmp_path):
    secret = load_secret(tmp_path)
    link = content_link(secret, PAGE, viewer="https://site.test/annoquest/", reader="ann")
    assert link.startswith("https://site.test/annoquest/?content=https%3A%2F%2Fexample.org") and "&reader=ann" in link
    assert is_content_request(secret, content_request(secret))
    forged = {**content_request(secret), "items": [{"id": "a", "prompt": "?"}]}
    assert not is_content_request(secret, forged)


# ---- the public mode ---------------------------------------------------------------------


def test_public_mode_registers_only_content_requests(public):
    c, data, _ = public
    secret = load_secret(data)
    req = content_request(secret)
    assert c.put(f"/requests/{req['id']}", json=req).status_code == 201
    assert c.put(f"/requests/{req['id']}", json=req).json()["created"] is False
    other = {"schema": "annoquest/request", "id": "guided-0001", "title": "T", "documents": [{"id": "d", "source": {"kind": "url", "url": "/x"}}], "items": [{"id": "a", "prompt": "?"}]}
    assert c.put("/requests/guided-0001", json=other).status_code == 403
    bad = {**req, "content": {**req["content"], "token": "nope"}}
    assert c.put(f"/requests/{req['id']}", json=bad).status_code == 409  # differs from the stored one
    assert c.get(f"/requests/{req['id']}").json()["id"] == req["id"]
    # Nobody reads everyone's answers, nor posts whole documents, over HTTP here.
    assert c.get(f"/requests/{req['id']}/responses").status_code == 403
    assert c.post(f"/requests/{req['id']}/responses", json={}).status_code == 403
    assert c.get(f"/requests/{req['id']}/events").status_code == 403


def test_events_append_and_read_back_by_device_only(public):
    c, data, _ = public
    req = content_request(load_secret(data))
    rid = req["id"]
    assert c.post(f"/requests/{rid}/events", json=batch(rid, [ev(0, "open")])).status_code == 404  # not registered
    c.put(f"/requests/{rid}", json=req)
    extra = {"id": "x1", "doc": "page", "url": PAGE, "target": {"quote": {"exact": "Hello", "occurrence": 1}}, "comment": "first", "at": "2026-10-19T10:00:01Z", "rev": 0}
    r = c.post(f"/requests/{rid}/events", json=batch(rid, [ev(0, "view", url=PAGE), ev(1, "extra", extra=extra)]))
    assert r.status_code == 201 and r.json()["saved"]
    c.post(f"/requests/{rid}/events", json=batch(rid, [ev(2, "beat", url=PAGE, active=True)], device="dev-other-0002"))
    mine = c.get(f"/requests/{rid}/events/mine", params={"device": "dev-0000000001"}).json()["batches"]
    assert len(mine) == 1 and mine[0]["events"][1]["extra"]["comment"] == "first" and "by" not in mine[0]
    assert c.get(f"/requests/{rid}/events/mine").status_code == 400
    assert c.post(f"/requests/{rid}/events", json=batch(rid, [{"type": "beat"}])).status_code == 400
    assert c.post(f"/requests/{rid}/events", json=batch("c-other", [ev(0, "open")])).status_code == 400
    # The owner reads everything from the data directory.
    files = sorted((data / "events" / rid).rglob("*.json"))
    assert len(files) == 2 and all(json.loads(f.read_text())["schema"] == "annoquest/events" for f in files)


def test_owner_cli(public, tmp_path, capsys):
    c, data, _ = public
    assert cli(["--data-dir", str(data), "link", PAGE, "--viewer", "https://site.test/annoquest/"]) == 0
    link = json.loads(capsys.readouterr().out)["link"]
    assert "t=" in link
    req = {"schema": "annoquest/request", "id": "guided-0001", "title": "T", "documents": [{"id": "d", "source": {"kind": "url", "url": "/x"}}], "items": [{"id": "a", "prompt": "?"}]}
    f = tmp_path / "r.json"
    f.write_text(json.dumps(req))
    assert cli(["--data-dir", str(data), "put-request", str(f)]) == 0
    assert json.loads(capsys.readouterr().out) == {"id": "guided-0001", "created": True, "revision": 1}
    assert c.get("/requests/guided-0001").json()["title"] == "T"
    f.write_text(json.dumps({**req, "title": "T2"}))
    cli(["--data-dir", str(data), "put-request", str(f)])
    assert json.loads(capsys.readouterr().out)["revision"] == 2
    c.post("/requests/guided-0001/events", json=batch("guided-0001", [ev(0, "open")]))
    assert cli(["--data-dir", str(data), "events", "guided-0001"]) == 0
    assert len(json.loads(capsys.readouterr().out)["batches"]) == 1


# ---- the proxy ---------------------------------------------------------------------------


def test_proxy_needs_the_sites_token(public):
    c, data, fetch = public
    t = site_token(load_secret(data), PAGE)
    assert c.get("/proxy", params={"u": PAGE, "t": "forged"}).status_code == 403
    assert c.get("/proxy", params={"u": "https://elsewhere.net/", "t": t}).status_code == 403
    assert fetch.calls == []
    r = c.get("/proxy", params={"u": PAGE, "t": t})
    assert r.status_code == 200
    assert "sandbox" in r.headers["content-security-policy"] and "allow-scripts" not in r.headers["content-security-policy"]
    assert r.headers["referrer-policy"] == "no-referrer"
    body = r.text
    assert "<script" not in body and "alert" not in body and "onclick" not in body and "<base" not in body
    assert 'href="https://example.org/essays/s.css"' in body  # subresources load from the site
    assert 'srcset="https://example.org/essays/i.png 1x, https://example.org/essays/i2.png 2x"' in body
    assert 'href="proxy?u=https%3A%2F%2Fexample.org%2Fessays%2Ftwo.html&amp;t=' in body  # same site: through the proxy
    assert 'href="https://elsewhere.net/x" target="_blank" rel="noopener noreferrer"' in body
    pdf = c.get("/proxy", params={"u": "https://example.org/f.pdf", "t": t})
    assert "file, not a page" in pdf.text and "https://example.org/f.pdf" in pdf.text


def test_rewrite_keeps_text_and_entities():
    out = rewrite('<p title="a &amp; b">x &lt; y &#169; <!-- c --></p><style>p{background:url(bg.png)}</style>', url="https://e.org/d/p.html", link=lambda u: None)
    assert out == '<p title="a &amp; b">x &lt; y &#169; <!-- c --></p><style>p{background:url(https://e.org/d/bg.png)}</style>'
    link = proxy_link("tok", allowed=lambda u: u.startswith("https://e.org/"))
    assert link("https://e.org/a#sec") == "proxy?u=https%3A%2F%2Fe.org%2Fa&t=tok#sec" and link("https://x.org/") is None
    assert 'href=""' not in rewrite('<a href="javascript:alert(1)">x</a>', url="https://e.org/", link=link)


def test_safe_fetch_refuses_private_addresses_and_odd_ports():
    allow = lambda u: True  # noqa: E731
    with pytest.raises(ProxyRefused, match="public address"):
        public_ips("127.0.0.1", 80)
    with pytest.raises(ProxyRefused, match="public address"):
        safe_fetch("http://internal.test/", allowed=allow, resolve=lambda h, p: public_ips("10.0.0.1", p))
    with pytest.raises(ProxyRefused, match="standard web ports"):
        safe_fetch("http://example.org:8080/", allowed=allow)
    with pytest.raises(ProxyRefused, match="http and https"):
        safe_fetch("ftp://example.org/", allowed=allow)
    with pytest.raises(ProxyRefused, match="another site"):
        safe_fetch("https://example.org/", allowed=lambda u: False)


# ---- the gateway mode keeps working, with events ---------------------------------------


def test_gateway_mode_events_are_attributed(tmp_path):
    app = mk_app(identity_header="X-Test-User", data_dir=tmp_path / "data", viewer=tmp_path / "none.html")
    c = TestClient(app)
    req = {"schema": "annoquest/request", "id": "req-test-0001", "title": "T", "requester": {"email": "ada@example.org"}, "documents": [{"id": "d", "source": {"kind": "url", "url": "/x"}}], "items": [{"id": "a", "prompt": "?"}]}
    assert c.put("/api/requests/req-test-0001", json=req, headers={"X-Test-User": "ada@example.org"}).status_code == 201
    b = batch("req-test-0001", [ev(0, "answer", item="a", answer={"value": "agree", "at": "2026-10-19T10:00:00Z", "rev": 1})])
    assert c.post("/api/requests/req-test-0001/events", json=b).status_code == 401
    assert c.post("/api/requests/req-test-0001/events", json={**b, "by": "forged"}, headers={"X-Test-User": "sam@example.org"}).status_code == 201
    mine = c.get("/api/requests/req-test-0001/events/mine", headers={"X-Test-User": "sam@example.org"}).json()["batches"]
    assert len(mine) == 1 and mine[0]["by"] == "sam@example.org"
    assert c.get("/api/requests/req-test-0001/events/mine", headers={"X-Test-User": "bo@example.org"}).json()["batches"] == []
    assert len(c.get("/api/requests/req-test-0001/events", headers={"X-Test-User": "ada@example.org"}).json()["batches"]) == 1
    assert c.get("/api/requests/req-test-0001/events", headers={"X-Test-User": "sam@example.org"}).status_code == 403
