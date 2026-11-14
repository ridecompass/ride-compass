"""取得の入口。`source_profile.yaml`が挙げるソースの入力を、宣言の並び順に上流から取って手元へ置く。

    .venv\\Scripts\\python.exe -m app.batch.fetch_cli --all
    .venv\\Scripts\\python.exe -m app.batch.fetch_cli --source accident
    .venv\\Scripts\\python.exe -m app.batch.fetch_cli --all --profile path/to/profile.yaml

ソースごとの取り方は、取込と同じアダプタの登録（`ingest.py: Fetcher`）が持つ。ソースを足しても、この入口は書き換えない。

**ソースを取る直前に、その置き場の中身を消す。** 手元に前のファイルがあっても、毎回上流から取り直す。消すのは並べたソースの
置き場の中身だけで、`backend/data`の下のほかのもの（地図のタイルのキャッシュ・道路網の配列等）と置き場そのものには触らない
（本番では土地被覆の置き場がコンテナへつないだ所そのもので、消せない）。全部を先に消さないのは、配信中のbackendが読む
置き場（土地被覆のラスタ）が、ほかのソースを取る間ずっと空になるため。
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


def run_fetch_cli(fetch: Callable[[], None], *, logger: logging.Logger) -> int:
    """取得の道具の入口の骨格。ログを整え、取得を流し、終了コードにする。

    `fetch`が終われば0、取得が断ったか通信に失敗したら1。失敗は理由の1行にして返す
    （どこへ取りに行ったかは、その前の行が出している）。
    """
    configure_cli_logging()
    try:
        fetch()
        return 0
    except (httpx.HTTPError, FetchError) as exc:
        logger.error("取得に失敗しました error=%r", exc)
        return 1


def _empty(store: Path) -> None:
    """置き場の中身を消す。置き場がディレクトリなら、ディレクトリそのものは残す。"""
    if not store.is_dir():
        store.unlink(missing_ok=True)
        return
    for child in store.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()


def fetch_sources(profile: SourceProfile, source_names: list[str]) -> None:
    """`source_names`のソースを、宣言の並び順に、置き場の中身を消してから取る。取得を持たないアダプタのソースは飛ばす。"""
    names = set(source_names)
    for name in names:
        profile.source(name)  # 無い名前はここで断る
    specs = [spec for spec in profile.sources if spec.name in names]
    fetchers = [(spec, ADAPTERS[spec.adapter].fetcher) for spec in specs]
    emptied: set[Path] = set()
    for spec, fetcher in fetchers:
        if fetcher is None:
            logger.info("取得を持たないソース source=%s", spec.name)
            continue
        # 同じアダプタのソースは置き場を分け合うので、最初の1つの前にだけ消す（2つ目の前に消すと、取ったものを消す）。
        for store in fetcher.store():
            if store not in emptied:
                emptied.add(store)
                logger.info("置き場の中身を消す %s", store)
                _empty(store)
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

    def start() -> None:
        profile = load_source_profile(args.profile)
        fetch_sources(profile, [spec.name for spec in profile.sources] if args.all else args.source)

    return run_fetch_cli(start, logger=logger)


if __name__ == "__main__":
    raise SystemExit(main())
