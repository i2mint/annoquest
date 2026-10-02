"""The server adapter: identity, write-once requests, append-only responses, access rules."""

import json

import pytest
from starlette.testclient import TestClient

from annoquest_server import Store, mk_app

RID = "req-test-0001"
REQUEST = {
    "schema": "annoquest/request",
    "version": 1,
    "id": RID,
    "title": "T",
    "requester": {"name": "Ada", "email": "ada@example.org"},
    "readers": [{"id": "sam", "email": "sam@example.org"}],
    "documents": [{"id": "d", "source": {"kind": "url", "url": "/doc/x.html"}}],
    "items": [{"id": "a", "prompt": "?"}],
}


def responses(answers, at="2026-10-02T10:00:00Z"):
    return {"schema": "annoquest/responses", "version": 1, "request": RID, "reader": {"id": "sam"}, "answers": answers, "extras": [], "updatedAt": at}


@pytest.fixture
def client(tmp_path):
    viewer = tmp_path / "viewer.html"
    viewer.write_text("<html>viewer</html>")
    app = mk_app(identity_header="X-Test-User", data_dir=tmp_path / "data", viewer=viewer)
    return TestClient(app), tmp_path / "data"


def as_(user):
    return {"X-Test-User": user, "Accept": "application/json"}


def test_viewer_whoami_and_unknown_api(client):
    c, _ = client
    assert c.get("/").text == "<html>viewer</html>"
    assert c.get("/api/whoami", headers=as_("sam@example.org")).json() == {"user": "sam@example.org"}
    assert c.get("/api/whoami").json() == {"user": None}
    assert c.get("/api/nope").status_code == 404


def test_requests_are_write_once(client):
    c, _ = client
    assert c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("ada@example.org")).status_code == 201
    other = {**REQUEST, "title": "hijacked"}
    assert c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("ADA@example.org")).json() == {"id": RID, "created": False}
    assert c.put(f"/api/requests/{RID}", json=other, headers=as_("ada@example.org")).status_code == 409
    assert c.get(f"/api/requests/{RID}", headers=as_("sam@example.org")).json()["title"] == "T"
    assert c.put("/api/requests/other-id-99", json=REQUEST, headers=as_("ada@example.org")).status_code == 400


def test_a_reader_cannot_register_or_take_over(client):
    c, _ = client
    # The sender registers before sending the link (the viewer does it when they preview it).
    assert c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("ada@example.org")).status_code == 201
    # A reader cannot register it, nor replace it by naming himself as its sender.
    forged = {**REQUEST, "requester": {"email": "sam@example.org"}}
    assert c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("sam@example.org")).json()["created"] is False
    assert c.put("/api/requests/unregistered-01", json={**REQUEST, "id": "unregistered-01"}, headers=as_("sam@example.org")).status_code == 403
    assert c.put(f"/api/requests/{RID}", json=forged, headers=as_("sam@example.org")).status_code == 409
    assert c.get(f"/api/requests/{RID}/responses", headers=as_("sam@example.org")).status_code == 403
    assert c.put(f"/api/requests/{RID}", json=REQUEST).status_code == 401


def test_two_tabs_do_not_erase_each_other(client):
    c, _ = client
    c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("ada@example.org"))
    tab_a = responses({"a": {"value": "agree", "at": "2026-10-02T10:00:00Z", "rev": 3}}, at="2026-10-02T10:00:00Z")
    tab_b = responses({"b": {"value": "discuss", "at": "2026-10-02T10:01:00Z", "rev": 1}}, at="2026-10-02T10:01:00Z")
    for body in (tab_a, tab_b):
        c.post(f"/api/requests/{RID}/responses", json=body, headers=as_("Sam@Example.org"))
    mine = c.get(f"/api/requests/{RID}/responses/mine", headers=as_("sam@example.org")).json()
    assert set(mine["answers"]) == {"a", "b"}


def test_only_listed_readers_and_owners(client):
    c, _ = client
    c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("ada@example.org"))
    assert c.get(f"/api/requests/{RID}", headers=as_("eve@example.org")).status_code == 403
    assert c.post(f"/api/requests/{RID}/responses", json=responses({}), headers=as_("eve@example.org")).status_code == 403


def test_responses_append_and_identity_is_stamped(client):
    c, data = client
    c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("ada@example.org"))
    body = responses({"a": {"value": "agree", "at": "t", "rev": 1}})
    body["by"] = "forged@example.org"
    assert c.post(f"/api/requests/{RID}/responses", json=body, headers=as_("sam@example.org")).status_code == 201
    later = responses({"a": {"value": "discuss", "at": "t2", "rev": 2}}, at="2026-10-02T11:00:00Z")
    assert c.post(f"/api/requests/{RID}/responses", json=later, headers=as_("sam@example.org")).status_code == 201
    files = list((data / "responses" / RID).rglob("*.json"))
    assert len(files) == 2 and all("@" not in str(f) for f in files)
    mine = c.get(f"/api/requests/{RID}/responses/mine", headers=as_("sam@example.org")).json()
    assert mine["answers"]["a"]["value"] == "discuss" and mine["by"] == "sam@example.org"
    # A reader cannot read everyone's; the requester can.
    assert c.get(f"/api/requests/{RID}/responses", headers=as_("sam@example.org")).status_code == 403
    allr = c.get(f"/api/requests/{RID}/responses", headers=as_("ada@example.org")).json()["responses"]
    assert [r["by"] for r in allr] == ["sam@example.org"]


def test_rejects_bad_bodies(client):
    c, _ = client
    c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("ada@example.org"))
    assert c.post(f"/api/requests/{RID}/responses", content=b"not json", headers=as_("sam@example.org")).status_code == 400
    wrong = {**responses({}), "request": "someone-else"}
    assert c.post(f"/api/requests/{RID}/responses", json=wrong, headers=as_("sam@example.org")).status_code == 400
    assert c.get("/api/requests/..%2Fetc", headers=as_("sam@example.org")).status_code in (400, 404)


def test_store_never_rewrites(tmp_path):
    s = Store(tmp_path)
    assert s.put_request(REQUEST, by=None) is True
    before = (tmp_path / "requests" / f"{RID}.json").read_text()
    assert s.put_request({**REQUEST, "title": "x"}, by=None) is False
    assert (tmp_path / "requests" / f"{RID}.json").read_text() == before
    assert json.loads(before)["request"]["title"] == "T"


def test_docs_dir_is_served_without_escaping(tmp_path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "a.html").write_text("<p>doc</p>")
    (tmp_path / "docs" / ".git").mkdir()
    (tmp_path / "docs" / ".git" / "config").write_text("secret")
    (tmp_path / "outside.txt").write_text("no")
    c = TestClient(mk_app(data_dir=tmp_path / "data", docs_dir=tmp_path / "docs"))
    r = c.get("/doc/a.html")
    assert r.text == "<p>doc</p>" and r.headers["content-security-policy"].startswith("sandbox")
    assert c.get("/doc/.git/config").status_code == 404
    assert c.get("/doc/../outside.txt").status_code == 404
    assert c.get("/doc/%2e%2e/outside.txt").status_code == 404


def test_a_forged_first_registration_is_loud(client):
    c, _ = client
    forged = {**REQUEST, "requester": {"email": "sam@example.org"}}
    assert c.put(f"/api/requests/{RID}", json=forged, headers=as_("sam@example.org")).status_code == 201
    # The real sender's preview now gets a conflict, not a quiet "already there", and so does any reader with the real link.
    assert c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("ada@example.org")).status_code == 409
    assert c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("bob@example.org")).status_code == 409


def test_bad_saves_are_refused_and_never_break_collection(client):
    c, data = client
    c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("ada@example.org"))
    bad = {**responses({}), "answers": "zz"}
    assert c.post(f"/api/requests/{RID}/responses", json=bad, headers=as_("sam@example.org")).status_code == 400
    good = responses({"a": {"value": "agree", "at": "t", "rev": 1}})
    c.post(f"/api/requests/{RID}/responses", json=good, headers=as_("sam@example.org"))
    # A damaged file on disk (however it got there) is skipped.
    d = next((data / "responses" / RID).iterdir())
    (d / "0000000000000-bad.json").write_text("{not json")
    (d / "0000000000001-bad.json").write_text(json.dumps({"responses": {"answers": "zz"}}))
    r = c.get(f"/api/requests/{RID}/responses", headers=as_("ada@example.org"))
    assert r.status_code == 200 and r.json()["responses"][0]["answers"]["a"]["value"] == "agree"


def test_removed_comments_stay_removed(client):
    c, _ = client
    c.put(f"/api/requests/{RID}", json=REQUEST, headers=as_("ada@example.org"))
    x = {"id": "x1", "doc": "d", "target": {}, "comment": "c", "at": "t"}
    c.post(f"/api/requests/{RID}/responses", json={**responses({}), "extras": [x]}, headers=as_("sam@example.org"))
    later = {**responses({}, at="2026-10-02T11:00:00Z"), "extras": [], "removed": ["x1"]}
    c.post(f"/api/requests/{RID}/responses", json=later, headers=as_("sam@example.org"))
    assert c.get(f"/api/requests/{RID}/responses/mine", headers=as_("sam@example.org")).json()["extras"] == []
