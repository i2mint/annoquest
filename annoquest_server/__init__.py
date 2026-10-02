"""annoquest server adapter: autosubmit and collection for guided annotation requests.

``mk_app`` makes a Starlette app that serves the annoquest viewer and keeps
requests (write-once) and responses (append-only) on disk, attributing every
save to the identity a forward-auth gateway asserts. See ``web`` and ``store``.
"""

from .store import Store, reader_key, valid_id
from .web import mk_app, mk_x_iq_user_app, serve

__all__ = ["mk_app", "mk_x_iq_user_app", "serve", "Store", "reader_key", "valid_id"]
