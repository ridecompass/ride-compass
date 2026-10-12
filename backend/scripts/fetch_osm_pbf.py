r"""OSMの抽出ファイル（`.pbf`）を配布元から手元へ写す（取込とは分ける）。

取込はローカルのファイルを読むだけにする。手で落とすと、置き場所と名前を間違えたまま
「取得済み」に見える。

取得の手順（読めるものは落とし直さない・一時ファイル経由・落とし終えたら開いてみる）は
`app.batch.common.fetch_verified`が持つ。読めないPBFを置いたまま成功を報告すると、
次に落ちるのは何時間もかかる取込の途中になる。

どのファイルを要するかはプロファイルが持つ（wayのソースの`rows.file`）。配布元の
URLの組み立て方だけがここにある。

実行方法（backendディレクトリから）:
    .venv\Scripts\python.exe scripts\fetch_osm_pbf.py
    .venv\Scripts\python.exe scripts\fetch_osm_pbf.py --profile path/to/profile.yaml
"""

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.batch.common import fetch_verified
from app.batch.fetch_cli import run_profile_fetch_cli
from app.batch.source_adapters.osm_pbf import DATA_DIR
from app.batch.source_profile import SourceProfile, SourceSpec

logger = logging.getLogger("ridecompass.fetch_osm_pbf")

#: 配布元。`{name}`は抽出ファイルの名前（`kanto-latest.osm.pbf`等）。
#: Geofabrikの日本の抽出は`asia/japan/`の下に地方ごとに置かれている。
PBF_URL = "https://download.geofabrik.de/asia/japan/{name}"

_READ_TIMEOUT_SECONDS = 60.0


def _readable(path: Path) -> bool:
    """osmiumが開けるか。

    **渡すのは、可能なら現在位置からの相対パス**——pyosmiumは非ASCIIを含む絶対パスの
    ファイルを開けない。絶対パスだけで試すと、中身が正しいファイルを壊れていると
    判定する。
    """
    import osmium

    candidates = [path]
    try:
        candidates.insert(0, path.relative_to(Path.cwd()))
    except ValueError:
        pass
    for candidate in candidates:
        try:
            reader = osmium.io.Reader(str(candidate))
        except (RuntimeError, OSError):
            continue
        reader.close()
        return True
    return False


def _fetch_specs(args: argparse.Namespace, profile: SourceProfile, specs: list[SourceSpec]) -> bool:
    names = sorted({spec.rows.file for spec in specs})
    return all([
        fetch_verified(PBF_URL.format(name=name), DATA_DIR / name, _readable,
                       read_timeout=_READ_TIMEOUT_SECONDS, logger=logger)
        for name in names
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description="OSMの抽出ファイルを手元へ写す")
    # wayのソースが読むファイル。頂点のソースは参照先のwayと同じファイルを読むので数えない。
    return run_profile_fetch_cli(parser, "osm_pbf_way", _fetch_specs, logger=logger)


if __name__ == "__main__":
    from _stdio import use_utf8_stdio

    use_utf8_stdio()
    raise SystemExit(main())
