"""道具のテストが読んだ`scripts/`の外のファイルが、CI の道具のテストを走らせる置き場に入っていることの検査。

CI は変わったファイルが`.github/workflows/ci.yml`の`scripts=$(area '…')`に当たるときだけ道具のテストを走らせるので、
当たらないファイルを読むと、そのファイルを変えた Pull Request で道具のテストが走らずに壊れる。読んだファイルは、
このプロセスの`open`の監査の出来事（組み込みの`open`と import の両方が起こす）で集める。

ここで見ないもの: テストが別のプロセスで打った道具（フック等）が読むファイルと、git が読むファイル（追跡しているファイルの一覧）。
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_OWN = REPO / "scripts"
_AREA = re.compile(r"scripts=\$\(area '([^']+)'\)")
_read: set[Path] = set()


def _record(event: str, args: tuple) -> None:
    if event == "open" and isinstance(args[0], (str, bytes, os.PathLike)):
        _read.add(Path(os.fsdecode(args[0])).resolve())


sys.addaudithook(_record)


def pytest_sessionfinish(session):
    area = re.compile(_AREA.search((REPO / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")).group(1))
    outside = sorted(
        path.relative_to(REPO).as_posix()
        for path in _read
        if path.is_file() and path.is_relative_to(REPO) and not path.is_relative_to(_OWN)
    )
    missing = [path for path in outside if not area.search(path)]
    if missing:
        session.exitstatus = 1
        print(f"\n道具のテストが読むのに ci.yml の道具の置き場（scripts=$(area …)）に当たらないファイル: {missing}", file=sys.stderr)
