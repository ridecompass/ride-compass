"""本番の公開の口を外から1回引き、所要と応答を返す（所要の上限を見る確かめが使う）。標準ライブラリだけで読む。"""

from __future__ import annotations

import time
import urllib.error
import urllib.request
from dataclasses import dataclass

#: 1回の要求の上限（秒）。確かめの上限を超えた遅さを、時間切れでなく所要として測れる長さにする。
REQUEST_TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class TimedResponse:
    seconds: float
    #: HTTPの状態の番号。応答が無ければ、要求が失敗した理由の文。
    status: int | str
    body: bytes = b""


def timed_get(url: str) -> TimedResponse:
    """`url`をGETで引く。200以外の応答と、つながらない・時間切れも例外にせず、状態に入れて返す。"""
    started = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            body = response.read()
            status: int | str = response.status
    except urllib.error.HTTPError as error:
        body, status = b"", error.code
    except OSError as error:
        body, status = b"", repr(error)
    return TimedResponse(time.monotonic() - started, status, body)
