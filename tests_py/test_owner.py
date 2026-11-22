"""v0.3: the owner's app over the public app's data directory."""

from urllib.parse import parse_qs, urlsplit

import pytest
from starlette.testclient import TestClient

from annoquest_server import load_secret, mk_app, mk_owner_app, site_token

from test_freeform import PAGE, batch, content_request, ev

VIEWER = "https://example.org/annoquest/"


@pytest.fixture
def apps(tmp_path):
    data = tmp_path / "data"
    public = TestClient(mk_app(public=True, api_prefix="", data_dir=data, viewer=tmp_path / "none.html"))
    owner = TestClient(mk_owner_app(data_dir=data, viewer_url=VIEWER, api_prefix=""))
    return public, owner, data


def test_owner_lists_requests_and_reads_every_reader(apps):
    public, owner, data = apps
    assert owner.get("/requests").json() == {"requests": []}
    req = content_request(load_secret(data))
    rid = req["id"]
    assert public.put(f"/requests/{rid}", json=req).status_code == 201
    public.post(f"/requests/{rid}/events", json=batch(rid, [ev(1, "open"), ev(2, "view", url=PAGE)]))
    public.post(f"/requests/{rid}/events", json=batch(rid, [ev(1, "open")], reader="ann", device="dev-0000000002"))
    (row,) = owner.get("/requests").json()["requests"]
    assert row["id"] == rid and row["kind"] == "content" and row["content"] == PAGE
    assert (row["readers"], row["devices"], row["events"]) == (2, 2, 3) and row["lastAt"]
    assert owner.get(f"/requests/{rid}").json()["content"]["url"] == PAGE
    assert len(owner.get(f"/requests/{rid}/events").json()["batches"]) == 2
    assert owner.get("/requests/nope").status_code == 404
    assert owner.get("/requests/no-such-id-at-all/events").status_code == 404


def test_owner_makes_links_signed_for_the_page(apps):
    _, owner, data = apps
    got = owner.post("/links", json={"url": PAGE, "reader": "ann"}).json()
    q = parse_qs(urlsplit(got["link"]).query)
    assert got["link"].startswith(VIEWER)
    assert q == {"content": [PAGE], "t": [site_token(load_secret(data), PAGE)], "reader": ["ann"]}
    assert owner.post("/links", json={"url": "javascript:alert(1)"}).status_code == 400
    assert owner.post("/links", content=b"not json").status_code == 400


def test_owner_app_fails_closed_for_anyone_else_when_owners_are_given(tmp_path):
    def identity(req):
        return req.headers.get("x-test-user")

    app = TestClient(mk_owner_app(data_dir=tmp_path, viewer_url=VIEWER, owners=["Owner@example.org"], identity=identity, api_prefix=""))
    assert app.get("/requests").status_code == 403
    assert app.get("/requests", headers={"x-test-user": "someone@example.org"}).status_code == 403
    assert app.post("/links", json={"url": PAGE}, headers={"x-test-user": "someone@example.org"}).status_code == 403
    assert app.get("/requests", headers={"x-test-user": "owner@example.org"}).status_code == 200


def test_public_app_still_has_no_owner_routes(apps):
    public, _, _ = apps
    assert public.get("/requests").status_code == 404
    assert public.post("/links", json={"url": PAGE}).status_code == 404


def _sent_batches(tmp_path, **app_kw):
    data = tmp_path / "data"
    public = TestClient(mk_app(public=True, api_prefix="", data_dir=data, viewer=tmp_path / "none.html", **app_kw))
    owner = TestClient(mk_owner_app(data_dir=data, viewer_url=VIEWER, api_prefix=""))
    req = content_request(load_secret(data))
    rid = req["id"]
    public.put(f"/requests/{rid}", json=req)
    forged = {**batch(rid, [ev(1, "open")]), "client_ip": "6.6.6.6", "user_agent": "forged"}
    assert public.post(f"/requests/{rid}/events", json=forged, headers={"User-Agent": "UA/1", "X-Forwarded-For": "9.9.9.9, 10.0.0.1"}).status_code == 201
    return owner.get(f"/requests/{rid}/events").json()["batches"]


def test_client_details_off_by_default_and_never_from_the_body(tmp_path):
    (b,) = _sent_batches(tmp_path)
    assert "client_ip" not in b and "user_agent" not in b


def test_record_client_stores_peer_and_user_agent(tmp_path):
    (b,) = _sent_batches(tmp_path, record_client=True)
    assert b["user_agent"] == "UA/1" and b["client_ip"] == "testclient"


def test_record_client_behind_a_trusted_proxy_uses_forwarded_for(tmp_path):
    (b,) = _sent_batches(tmp_path, record_client=True, trust_forwarded_for=True)
    assert b["client_ip"] == "9.9.9.9"


def test_doc_csp_has_the_popup_escape_flag_like_the_iframe():
    from annoquest_server.web import DOC_CSP

    assert "allow-popups-to-escape-sandbox" in DOC_CSP
