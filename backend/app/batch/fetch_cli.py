"""取得の入口。`source_profile.yaml`が挙げるソースの入力を、宣言の並び順に上流から取って手元へ置く。

    .venv\\Scripts\\python.exe -m app.batch.fetch_cli --all
    .venv\\Scripts\\python.exe -m app.batch.fetch_cli --source accident
    .venv\\Scripts\\python.exe -m app.batch.fetch_cli --all --profile path/to/profile.yaml

ソースごとの取り方は、取込と同じアダプタの登録（`ingest.py: Fetcher`）が持つ。ソースを足しても、この入口は書き換えない。

**取ってから、今回置かなかった前のものを消す。** 手元に前のファイルがあっても毎回上流から取り直し、置き場は取っている間も
前のもので埋まったままにする（置き場は取っている間も読まれうるので、空にも半分にもしない）。取り終えたら、取る前からあって
置き換わらなかったファイル（前の年の版等）を消す。取ったものの記録（`common.py: FETCH_RECORD_NAME`）だけは取る前に消し、
途中で落ちた置き場を取り込ませない。触るのは並べたソースの置き場の中のファイルだけで、`backend/data`の下のほかのもの
（地図のタイルのキャッシュ・道路網の配列等）と置き場のディレクトリには触らない。
ほかのソースの置いたものを読む取得（住所の代表点から範囲の都道府県を決める等）は、宣言で読む元より後に並べる。
並べたソースが読む元を並べなければ、手元にある元を読む。

`common.py`と分けて置くのは、プロファイルを読むとアダプタ全部が`import`でたどれるようになるため——`common.py`を読む
派生の段にまで、段が読まないアダプタを読み込ませない。
"""

import argparse
import logging
from collections.abc import Callable
from pathlib import Path

import httpx

from app.batch.common import FETCH_RECORD_NAME, FetchError, configure_cli_logging
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


def _identity(path: Path) -> tuple[int, int]:
    """ファイルの同一性。一時ファイルから置き換えると番号が、その場で書き直すと更新時刻が変わる。"""
    status = path.lstat()
    return status.st_ino, status.st_mtime_ns


def _files(store: Path) -> dict[Path, tuple[int, int]]:
    """置き場の中のファイルと、それぞれの同一性。"""
    if not store.is_dir():
        return {}
    return {path: _identity(path) for path in store.rglob("*") if not path.is_dir()}


def _remove_unplaced(before: dict[Path, tuple[int, int]]) -> int:
    """取る前からあって、取ったあとも同じままのファイルを消す。消した数を返す。"""
    unplaced = [path for path, identity in before.items() if path.exists() and _identity(path) == identity]
    for path in unplaced:
        path.unlink()
    return len(unplaced)


def fetch_sources(profile: SourceProfile, source_names: list[str]) -> None:
    """`source_names`のソースを宣言の並び順に取り、置き場ごとに今回置かなかった前のものを消す。取得を持たないアダプタのソースは飛ばす。"""
    names = set(source_names)
    for name in names:
        profile.source(name)  # 無い名前はここで断る
    fetchers = []
    for spec in profile.sources:
        if spec.name not in names:
            continue
        fetcher = ADAPTERS[spec.adapter].fetcher
        if fetcher is None:
            logger.info("取得を持たないソース source=%s", spec.name)
        else:
            fetchers.append((spec, fetcher, fetcher.store()))
    # 同じアダプタのソースは置き場を分け合うので、控えるのは最初の1つの前、消すのは最後の1つのあと
    # （間で消すと、前のソースが置いたものを消す）。
    last = {store: spec.name for spec, _, stores in fetchers for store in stores}
    before: dict[Path, dict[Path, tuple[int, int]]] = {}
    for spec, fetcher, stores in fetchers:
        for store in stores:
            if store not in before:
                (store / FETCH_RECORD_NAME).unlink(missing_ok=True)
                before[store] = _files(store)
        logger.info("取得 source=%s", spec.name)
        fetcher.fetch(spec, profile)
        for store in stores:
            if last[store] == spec.name:
                logger.info("今回置かなかった前のものを消した %s %d件", store, _remove_unplaced(before[store]))


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
