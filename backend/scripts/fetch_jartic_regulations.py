r"""日本道路交通情報センター（JARTIC）の交通規制情報（都道府県ごとの zip）を配布元から手元へ写す（取込とは分ける）。

取込はローカルのファイルを読むだけにする（`source_adapters/jartic_regulation.py`）。

取るのは取込の範囲に掛かる都道府県の zip（1都道府県1つ）。都道府県はアドレス・ベース・レジストリの市区町村の代表点から
決める（`source_adapters/abr.py: range_prefectures`）ので、先に`scripts/fetch_abr.py`を流しておく。都道府県とファイルの対応は
配布元の一覧（`LISTING_URL`）が持ち、手で表を持たない。

配布元は最新の版しか置かないので、一覧の版がプロファイルの版（`jartic_regulation`ソースの`rows.version`）と違えば、
その版のファイルはもう取れない。手元に読めるファイルがあればそれを使い、無ければ版を上げるよう言って止まる。
手元の全部が読めるなら一覧も読まない。取得の手順は`app.batch.common.fetch_verified`が持つ。

実行方法（backendディレクトリから）:
    .venv\Scripts\python.exe scripts\fetch_jartic_regulations.py
    .venv\Scripts\python.exe scripts\fetch_jartic_regulations.py --profile path/to/profile.yaml
"""

import argparse
import logging
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.common import fetch_timeout, fetch_verified, fetched_all
from app.batch.fetch_cli import run_profile_fetch_cli
from app.batch.source_adapters.abr import abr_snapshot, range_prefectures
from app.batch.source_adapters.jartic_regulation import ENCODING, archive_path
from app.batch.source_adapters.zip_csv import zip_csv_readable
from app.batch.source_profile import SourceProfile, SourceSpec

logger = logging.getLogger("ridecompass.fetch_jartic_regulations")

#: 配布の一覧。交通規制情報は`type`が`typeD`の要素で、`targetList`の`id`は`R`＋JIS の都道府県コード2桁、`link`は
#: `/<版>/<ファイル名>`（`FILES_URL`からの道）。
LISTING_URL = "https://www.jartic.or.jp/d/opendata/opendata.json"
FILES_URL = "https://www.jartic.or.jp/d/opendata"
_REGULATIONS_TYPE = "typeD"

_LISTING_READ_TIMEOUT_SECONDS = 30.0
_READ_TIMEOUT_SECONDS = 300.0


def _readable(path: Path) -> bool:
    """見出しにユニークキーがあり、1行以上あるか。"""
    return zip_csv_readable(path, ENCODING, "ユニークキー")


def _listed_links() -> dict[str, str]:
    """一覧の交通規制情報の、都道府県コード（2桁）→ ファイルへの道。"""
    response = httpx.get(LISTING_URL, timeout=fetch_timeout(_LISTING_READ_TIMEOUT_SECONDS), follow_redirects=True)
    response.raise_for_status()
    [entry] = [item for item in response.json() if item["type"] == _REGULATIONS_TYPE]
    return {target["id"].removeprefix("R"): target["link"] for target in entry["targetList"]}


def fetch(version: str, prefectures: list[str]) -> bool:
    """`version`の版の`prefectures`の配布を置く。全部を置けたか（手元にあって読めたか）。"""
    missing = [code for code in prefectures if not _readable(archive_path(version, code))]
    if not missing:
        logger.info("版 %s の配布は全部手元にある", version)
        return True
    links = _listed_links()
    unlisted = [code for code in missing if code not in links]
    if unlisted:
        logger.error("配布の一覧に無い都道府県: %s", ", ".join(unlisted))
        return False
    stale = sorted({links[code] for code in missing if not links[code].startswith(f"/{version}/")})
    if stale:
        logger.error("配布元の版が宣言の版 %s と違い、手元にも読める配布が無い: %s。"
                     "source_profile.yaml の jartic_regulation の rows.version を配布元の版へ上げる", version, ", ".join(stale))
        return False
    return fetched_all(
        fetch_verified(FILES_URL + links[code], archive_path(version, code), _readable,
                       read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)
        for code in missing)


def _fetch_specs(args: argparse.Namespace, profile: SourceProfile, specs: list[SourceSpec]) -> bool:
    prefectures = range_prefectures(abr_snapshot(profile), profile.target)
    logger.info("範囲に掛かる都道府県: %s", ", ".join(prefectures))
    return fetched_all(fetch(version, prefectures) for version in sorted({spec.rows.version for spec in specs}))


def main() -> int:
    parser = argparse.ArgumentParser(description="JARTIC の交通規制情報を手元へ写す")
    return run_profile_fetch_cli(parser, "jartic_regulation", _fetch_specs, logger=logger)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
