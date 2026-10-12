"""本番へつなぐ道具が共有する、手元の接続情報の読み方。

接続情報は`backend/.env.oracle.local`（リポジトリに入れないため各自が置く）に置く。worktreeから実行したときは
本体のチェックアウト側を見る——gitignore対象のファイルはworktreeへコピーされないため。

接続情報を渡す前に、このチェックアウトが origin/master に追いついているかを確かめ、遅れていれば止まる
（`scripts/checkout_freshness.py`）。本番へ流すのはこのチェックアウトのコードだからである。
"""

import functools
import pathlib
import sys

from dotenv import dotenv_values

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
_FILE_NAME = ".env.oracle.local"

sys.path.insert(0, str(BACKEND_DIR.parent / "scripts"))

from checkout_freshness import require_current  # noqa: E402
from repo_git import main_checkout  # noqa: E402

require_current_checkout = functools.cache(require_current)


def prod_env_file() -> pathlib.Path:
    """`.env.oracle.local`の在処。worktreeに無ければ本体のチェックアウトを見る。"""
    here = BACKEND_DIR / _FILE_NAME
    if here.exists():
        return here
    candidate = main_checkout(BACKEND_DIR) / "backend" / _FILE_NAME
    return candidate if candidate.exists() else here


def read_prod_env(key: str) -> str:
    """鍵の値。ファイルか鍵が無ければ、どこに何を足せばよいかを言って止まる（値は出さない）。"""
    require_current_checkout()
    path = prod_env_file()
    if not path.exists():
        raise SystemExit(f"{path} がない。本番への接続情報が要る")
    value = dotenv_values(path, encoding="utf-8").get(key)
    if not value:
        raise SystemExit(f"{path} に {key} が無い")
    return value
