"""`urllib.request.urlopen`を自分で呼ぶ道具（`backend/scripts/`の本番の見張り等）の網の代役。

`urlopen_answering(本文)`を`monkeypatch.setattr(urllib.request, "urlopen", ...)`へ渡すと、どのURLへも同じ本文を返す。
本文に例外を渡すと、応答の代わりにそれを投げる（`urllib.error.URLError`等の網の失敗）。
"""

import io
import urllib.request

from tests.bound_fake import bound


def urlopen_answering(body: bytes | Exception):
    def urlopen(url, data=None, timeout=None, *, context=None):
        if isinstance(body, Exception):
            raise body
        return io.BytesIO(body)

    return bound(urllib.request.urlopen, urlopen)
