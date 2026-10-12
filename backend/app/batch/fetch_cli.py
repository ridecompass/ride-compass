"""取得の道具（`scripts/fetch_*.py`）の入口の骨格。

`common.py`と分けて置くのは、プロファイルを読むとアダプタ全部が`import`でたどれるようになるため——`common.py`を読む
派生の段のコードの指紋（`code_fingerprint.py: code_fingerprint`）に、段が読まないアダプタまで入ってしまう。
"""

import argparse
import logging
from collections.abc import Callable
from pathlib import Path

import httpx

from app.batch.common import configure_cli_logging
from app.batch.source_profile import SourceProfile, SourceSpec, load_source_profile


def run_fetch_cli(fetch: Callable[[], bool], *, logger: logging.Logger) -> int:
    """取得の道具の入口の骨格。ログを整え、取得を流し、終了コードにする。

    全部を置けたら（`fetch`がTrue）0、置けないものがあったか通信に失敗したら1。通信の失敗は理由の1行にして返す
    （どこへ取りに行ったかは、その前の行が出している）。
    """
    configure_cli_logging()
    try:
        return 0 if fetch() else 1
    except httpx.HTTPError as exc:
        logger.error("取得に失敗しました error=%r", exc)
        return 1


def run_profile_fetch_cli(
    parser: argparse.ArgumentParser,
    adapter: str,
    fetch: Callable[[argparse.Namespace, SourceProfile, list[SourceSpec]], bool],
    *,
    logger: logging.Logger,
) -> int:
    """プロファイルが挙げたソースを取る、取得の道具の入口の骨格（`run_fetch_cli`の上に乗る）。

    `--profile`はここで足す（省けば既定のプロファイル）。`fetch`は読んだ引数・プロファイルと、アダプタが`adapter`の
    ソースを受ける。そのソースが無ければ取るものが無いので、`fetch`を呼ばずに成功で終える。
    """
    parser.add_argument("--profile", default=None, type=Path)
    args = parser.parse_args()

    def start() -> bool:
        profile = load_source_profile(args.profile)
        specs = [spec for spec in profile.sources if spec.adapter == adapter]
        if not specs:
            logger.info("プロファイルにアダプタ %s のソースがありません", adapter)
            return True
        return fetch(args, profile, specs)

    return run_fetch_cli(start, logger=logger)
