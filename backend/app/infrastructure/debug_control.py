"""debug_modeのランタイム切替・直近ログの保持。

切替は`.env`を書き換えない。プロセス再起動・再デプロイのたびに安全側
（`settings.debug_mode`の環境変数値、既定false）へ戻り、「戻し忘れ」が起きない。
"""

import logging
from collections import deque

from app.config import settings
from app.infrastructure.request_log import format_log_lines

# メモリに持つ直近のログの件数。1レコードは数百バイト程度で、プロセス再起動で消える。
RING_BUFFER_MAX_SIZE = 1000


class _LogRingBufferHandler(logging.Handler):
    """整形済みのログ行を、数値のレベルと組でメモリ上に持つ（`min_level`で絞るときに整形済みの文字列を解かない）。"""

    def __init__(self, maxlen: int) -> None:
        super().__init__()
        self._buffer: deque[tuple[int, str]] = deque(maxlen=maxlen)

    def emit(self, record: logging.LogRecord) -> None:
        self._buffer.append((record.levelno, self.format(record)))


_ring_buffer_handler = _LogRingBufferHandler(RING_BUFFER_MAX_SIZE)
format_log_lines(_ring_buffer_handler)


def install_ring_buffer_handler() -> None:
    """ルートロガーへリングバッファハンドラを追加する（main.py起動時に1回呼ぶ）。"""
    root_logger = logging.getLogger()
    if _ring_buffer_handler not in root_logger.handlers:
        root_logger.addHandler(_ring_buffer_handler)


def set_debug_mode(enabled: bool) -> bool:
    """debug_modeをランタイムで切り替え、切り替え後の状態を返す。"""
    settings.debug_mode = enabled
    logging.getLogger().setLevel(logging.DEBUG if enabled else logging.INFO)
    return settings.debug_mode


def get_recent_logs(limit: int | None, contains: str | None, min_level: int | None) -> list[str]:
    """リングバッファから直近ログを取得する（古い順のまま、末尾が最新）。

    `min_level`はPython標準の`logging`と同じ「このレベル以上」、`contains`は部分一致。
    併用するとAND条件になり、`limit`は絞り込んだ後の末尾N件を指す。
    """
    lines = [
        line
        for levelno, line in list(_ring_buffer_handler._buffer)
        if (min_level is None or levelno >= min_level) and (not contains or contains in line)
    ]
    if limit is not None:
        lines = lines[-limit:]
    return lines
