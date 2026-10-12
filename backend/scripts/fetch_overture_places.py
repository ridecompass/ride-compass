r"""Overture Maps の地点（places）を配布元から手元へ写す（取込とは分ける）。

取込はローカルのファイルを読むだけにする（`source_adapters/overture_places.py`）。

配布は版ごとの GeoParquet で、全世界ぶんを AWS S3 に置いている。DuckDB で取込の範囲（`target.bbox`）の地点だけを
読み、列は全部のまま1つの Parquet へ書く（公式の文書「DuckDB」の読み方。S3 は認証なしで読める）。置く手順
（読めるものは取り直さない・一時ファイル経由・書き終えたら開いてみる）は`app.batch.common.place_verified`が持つ。

どの版を要るかはプロファイルが持つ（`overture_places`ソースの`rows.release`）。

実行方法（backendディレクトリから）:
    .venv\Scripts\python.exe scripts\fetch_overture_places.py
    .venv\Scripts\python.exe scripts\fetch_overture_places.py --profile path/to/profile.yaml
"""

import argparse
import logging
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.common import place_verified, run_profile_fetch_cli
from app.batch.source_adapters.overture_places import places_path
from app.batch.source_profile import SourceProfile, SourceSpec

logger = logging.getLogger("ridecompass.fetch_overture_places")

#: 配布の置き場。版ごとに1つ。
PLACES_URL_TEMPLATE = "s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"
_S3_REGION = "us-west-2"


def _readable(path: Path) -> bool:
    """Parquet として開け、1行以上あるか。"""
    try:
        with duckdb.connect() as conn:
            [(count,)] = conn.execute("SELECT count(*) FROM read_parquet(?)", [str(path)]).fetchall()
            return count > 0
    except duckdb.Error:
        return False


def fetch(release: str, bbox: tuple[float, float, float, float]) -> bool:
    """範囲の地点を書く。範囲に地点が無ければ、書いたものが読めない（1行以上ない）として退ける。"""
    url = PLACES_URL_TEMPLATE.format(release=release)
    min_lat, min_lon, max_lat, max_lon = bbox

    def write(temporary: Path) -> bool:
        with duckdb.connect() as conn:
            conn.execute(f"SET s3_region = '{_S3_REGION}'")
            # 点の`bbox`の最小は点そのもの。`hive_partitioning`は置き場のパスの`theme=`・`type=`を列にする。
            conn.execute(
                "COPY (SELECT * FROM read_parquet(?, hive_partitioning = true)"
                " WHERE bbox.xmin BETWEEN ? AND ? AND bbox.ymin BETWEEN ? AND ?)"
                f" TO '{temporary}' (FORMAT parquet)",
                [url, min_lon, max_lon, min_lat, max_lat])
        return True

    return place_verified(places_path(release), _readable, write, source=url, logger=logger)


def _fetch_specs(args: argparse.Namespace, profile: SourceProfile, specs: list[SourceSpec]) -> bool:
    releases = sorted({spec.rows.release for spec in specs})
    return all([fetch(release, profile.target.bbox) for release in releases])


def main() -> int:
    parser = argparse.ArgumentParser(description="Overture Maps の地点を手元へ写す")
    return run_profile_fetch_cli(parser, "overture_places", _fetch_specs, logger=logger)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
