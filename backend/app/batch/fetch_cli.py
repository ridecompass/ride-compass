"""取得の入口。`source_profile.yaml`が挙げるソースの入力を、宣言の並び順に上流から取って手元へ置く。

    .venv\\Scripts\\python.exe -m app.batch.fetch_cli --all
    .venv\\Scripts\\python.exe -m app.batch.fetch_cli --source accident
    .venv\\Scripts\\python.exe -m app.batch.fetch_cli --all --profile path/to/profile.yaml

ソースごとの取り方は、取込と同じアダプタの登録（`ingest.py: Fetcher`）が持つ。ソースを足しても、この入口は書き換えない。

**取る前に、取るソースの置き場を消す。** 手元に前のファイルがあっても、毎回上流から取り直す。消すのは並べたソースの
置き場だけで、`backend/data`の下のほかのもの（地図のタイルのキャッシュ・道路網の配列等）には触らない。
ほかのソースの置いたものを読む取得（住所の代表点から範囲の都道府県を決める等）は、宣言で読む元より後に並べる。
並べたソースが読む元を並べなければ、手元にある元を読む。

`common.py`と分けて置くのは、プロファイルを読むとアダプタ全部が`import`でたどれるようになるため——`common.py`を読む
派生の段にまで、段が読まないアダプタを読み込ませない。
"""

import argparse
import logging
import shutil
from collections.abc import Callable
from pathlib import Path

import httpx

from app.batch.common import FetchError, configure_cli_logging
from app.batch.ingest import ADAPTERS
from app.batch.source_profile import SourceProfile, load_source_profile

logger = logging.getLogger("ridecompass.fetch_cli")


def run_fetch_cli(fetch: Callable[[], bool], *, logger: logging.Logger) -> int:
    """取得の道具の入口の骨格。ログを整え、取得を流し、終了コードにする。

    全部を置けたら（`fetch`がTrue）0、置けないものがあったか通信に失敗したら1。失敗は理由の1行にして返す
    （どこへ取りに行ったかは、その前の行が出している）。
    """
    configure_cli_logging()
    try:
        return 0 if fetch() else 1
    except (httpx.HTTPError, FetchError) as exc:
        logger.error("取得に失敗しました error=%r", exc)
        return 1


def _clear(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def fetch_sources(profile: SourceProfile, source_names: list[str]) -> None:
    """`source_names`のソースの置き場を消してから、宣言の並び順に取る。取得を持たないアダプタのソースは飛ばす。"""
    names = set(source_names)
    for name in names:
        profile.source(name)  # 無い名前はここで断る
    specs = [spec for spec in profile.sources if spec.name in names]
    fetchers = [(spec, ADAPTERS[spec.adapter].fetcher) for spec in specs]
    # 同じアダプタのソースは置き場を分け合うので、取る前にまとめて消す（1つ取ってから消すと、取ったものを消す）。
    for store in dict.fromkeys(path for _, fetcher in fetchers if fetcher for path in fetcher.store()):
        logger.info("置き場を消す %s", store)
        _clear(store)
    for spec, fetcher in fetchers:
        if fetcher is None:
            logger.info("取得を持たないソース source=%s", spec.name)
            continue
        logger.info("取得 source=%s", spec.name)
        fetcher.fetch(spec, profile)


def main() -> int:
    parser = argparse.ArgumentParser(description="外部ソースの入力を上流から取り直す")
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--profile", default=None, type=Path)
    args = parser.parse_args()
    if not args.all and not args.source:
        parser.error("--all か --source を渡す")

    def start() -> bool:
        profile = load_source_profile(args.profile)
        fetch_sources(profile, [spec.name for spec in profile.sources] if args.all else args.source)
        return True

    return run_fetch_cli(start, logger=logger)


if __name__ == "__main__":
    raise SystemExit(main())
