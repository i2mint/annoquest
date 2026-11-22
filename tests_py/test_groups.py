"""v0.4: review groups — replies, comments shared within a group, and resolve."""

from urllib.parse import parse_qs, urlsplit

import pytest
from starlette.testclient import TestClient

from annoquest_server import content_link, load_secret, mk_app, mk_owner_app
from annoquest_server.content import group_allows, group_scope, group_token

from test_freeform import PAGE, batch, content_request, ev

VIEWER = "https://example.org/annoquest/"


@pytest.fixture
def apps(tmp_path):
    data = tmp_path / "data"
    public = TestClient(mk_app(public=True, api_prefix="", data_dir=data, viewer=tmp_path / "none.html"))
    owner = TestClient(mk_owner_app(data_dir=data, viewer_url=VIEWER, api_prefix=""))
    req = content_request(load_secret(data))
    assert public.put(f"/requests/{req['id']}", json=req).status_code == 201
    return public, owner, data, req


def extra(id_, comment, *, parent=None, at="2026-10-19T10:00:01Z"):
    x = {"id": id_, "doc": "page", "url": PAGE, "target": {"quote": {"exact": "Hello", "occurrence": 1}}, "comment": comment, "at": at, "rev": 0}
    return {**x, "parent": parent} if parent else x


def grouped(rid, events, token, *, group="team", reader="ann", device="dev-0000000001"):
    return {**batch(rid, events, reader=reader, device=device), "group": group, "groupToken": token}


def test_group_link_carries_a_token_bound_to_the_site_and_group(tmp_path):
    secret = load_secret(tmp_path)
    q = parse_qs(urlsplit(content_link(secret, PAGE, viewer=VIEWER, group="team")).query)
    assert q["g"] == ["team"] and q["gt"] == [group_token(secret, "https://example.org", "team")]
    req = content_request(secret)
    assert group_scope(req) == "https://example.org"
    assert group_allows(secret, q["gt"][0], req, "team")
    assert not group_allows(secret, q["gt"][0], req, "other")
    assert not group_allows(secret, None, req, "team")
    assert "g=" not in content_link(secret, PAGE, viewer=VIEWER)


def test_group_members_read_comments_and_resolves_but_not_reading_times(apps):
    public, owner, data, req = apps
    rid, secret = req["id"], load_secret(data)
    gt = group_token(secret, group_scope(req), "team")
    # Ann comments (and reads); Bo replies; a reader outside the group comments too.
    assert public.post(f"/requests/{rid}/events", json=grouped(rid, [ev(0, "view", url=PAGE), ev(1, "extra", extra=extra("x1", "unclear"))], gt)).status_code == 201
    r = grouped(rid, [ev(2, "extra", extra=extra("x2", "agreed", parent="x1", at="2026-10-19T10:00:02Z"))], gt, reader="bo", device="dev-0000000002")
    assert public.post(f"/requests/{rid}/events", json=r).status_code == 201
    public.post(f"/requests/{rid}/events", json=batch(rid, [ev(3, "extra", extra=extra("x3", "private"))], reader="cy", device="dev-0000000003"))
    # The owner resolves Ann's comment.
    assert owner.post(f"/requests/{rid}/resolve", json={"extra": "x1", "resolved": True}).status_code == 201

    got = public.get(f"/requests/{rid}/groups/team", params={"t": gt})
    assert got.status_code == 200
    batches = got.json()["batches"]
    readers = {b["reader"] for b in batches}
    assert readers == {"ann", "bo", "owner"}  # not cy, who is not in the group
    types = {e["type"] for b in batches for e in b["events"]}
    assert types == {"extra", "resolve"}  # no view, beat or open
    assert all("client_ip" not in b and "receivedAt" not in b and "groupToken" not in b for b in batches)
    owner_batch = next(b for b in batches if b["reader"] == "owner")
    assert owner_batch["role"] == "owner" and owner_batch["events"][0]["extra"] == "x1"


def test_group_reads_and_writes_need_the_groups_token(apps):
    public, _, data, req = apps
    rid = req["id"]
    gt = group_token(load_secret(data), group_scope(req), "team")
    assert public.get(f"/requests/{rid}/groups/team").status_code == 403
    assert public.get(f"/requests/{rid}/groups/team", params={"t": "forged"}).status_code == 403
    assert public.get(f"/requests/{rid}/groups/other", params={"t": gt}).status_code == 403
    # A batch claiming the group without its token is refused; a client cannot claim to be the owner.
    assert public.post(f"/requests/{rid}/events", json=grouped(rid, [ev(1, "extra", extra=extra("x1", "hi"))], "forged")).status_code == 403
    spoof = {**grouped(rid, [ev(1, "resolve", extra="x1", resolved=True)], gt), "role": "owner"}
    assert public.post(f"/requests/{rid}/events", json=spoof).status_code == 201
    stored = public.get(f"/requests/{rid}/groups/team", params={"t": gt}).json()["batches"]
    assert all("role" not in b for b in stored)


def test_owner_resolve_validates_its_body(apps):
    _, owner, _, req = apps
    assert owner.post(f"/requests/{req['id']}/resolve", json={"resolved": True}).status_code == 400
    assert owner.post(f"/requests/{req['id']}/resolve", json={"extra": "x1", "resolved": "yes"}).status_code == 400
    assert owner.post("/requests/no-such-id-at-all/resolve", json={"extra": "x1"}).status_code == 404


def test_owner_links_can_join_a_group(apps):
    _, owner, _, _ = apps
    out = owner.post("/links", json={"url": PAGE, "group": "team"}).json()
    assert out["group"] == "team" and "g=team" in out["link"] and "gt=" in out["link"]
    assert owner.post("/links", json={"url": PAGE, "group": "x" * 65}).status_code == 400
