"""本番の宛先の読み方。宛先はリポジトリの根の`production-origins.json`だけが持つ（docs/architecture/tech-stack.md「本番の宛先」）。

`scripts/`の実行口は`if __name__ == "__main__":`か`main`の中で読む（テストはスクリプトを`scripts.<名前>`としてimportする）。
"""

import json
from pathlib import Path

ORIGINS_FILE = Path(__file__).resolve().parents[2] / "production-origins.json"


def production_origin(side: str) -> str:
    """`frontend`か`backend`の本番のオリジン（末尾の`/`無し）。"""
    return json.loads(ORIGINS_FILE.read_text(encoding="utf-8"))[side]
