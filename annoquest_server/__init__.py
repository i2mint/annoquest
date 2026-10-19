"""annoquest server adapter: autosubmit and collection for guided annotation requests.

``mk_app`` makes a Starlette app that serves the annoquest viewer and keeps
requests (write-once) and responses (append-only) on disk, attributing every
save to the identity a forward-auth gateway asserts, or (``public=True``) to the reader the
events name. ``content`` makes and checks content links; ``proxy`` serves other sites' pages
for annotation. ``mk_owner_app`` is the owner's page and API over the same data, for behind a
sign-in. See ``web``, ``owner`` and ``store``.
"""

from .content import content_link, content_request_id, load_secret, site_token, token_allows
from .owner import enlace_identity, mk_owner_app
from .store import Store, reader_key, valid_id
from .web import mk_app, mk_public_app, mk_x_iq_user_app, serve

__all__ = ["mk_app", "mk_owner_app", "enlace_identity", "mk_public_app", "mk_x_iq_user_app", "serve", "Store", "reader_key", "valid_id", "content_link", "content_request_id", "load_secret", "site_token", "token_allows"]
