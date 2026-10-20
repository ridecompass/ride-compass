"""持ち主のファイルが1か所に持つ値（本番の宛先・タスクの置き場の名前）が、ほかの所に違う値で書かれていないことの検査。

本番の宛先はリポジトリの根の`production-origins.json`、置き場の名前は`tools/flow-gate/flow.config.json`の`tasks`が持ち、
ワークフローと道具はそこから読む。そこから読めない所（担当の設定の説明の文・文書）は値を書くしかなく、持ち主だけを
直すと古い値が残る。本番の frontend の宛先が古いまま残ると、担当の判定役が本番を読む操作を断り、文書を読んだ人が
古い宛先を叩く。

母集団は追跡しているファイル全部（持ち主のファイルと、維持しない`docs/records/`を除く）。拾う綴り:
- 本番の宛先: 持ち主のどれかのオリジンと同じ登録ドメイン（ホスト名の末尾の2つのラベル）を持つ URL のオリジン
- 置き場の名前: コードのリポジトリ（同じ設定の`code`）の`<所有者>/<名前>`で始まる綴り

ここで見ないもの: 登録ドメインが変わった（別の提供元へ移った）宛先の古い綴りと、コードのリポジトリの名前で始まらない
置き場の名前の綴り（どちらも拾う綴りの形に当たらない）。
"""

import json
import re
import sys
from functools import cache
from pathlib import Path
from urllib.parse import urlsplit

REPO_ROOT = Path(__file__).resolve().parents[3]
ORIGINS_FILE = "production-origins.json"
FLOW_CONFIG_FILE = "tools/flow-gate/flow.config.json"

sys.path.insert(0, str(REPO_ROOT / "scripts"))

from repo_git import run  # noqa: E402
from repo_population import UNMAINTAINED_PREFIXES  # noqa: E402

ORIGIN = re.compile(r"https?://[A-Za-z0-9.-]+(?::\d+)?")


@cache
def _tracked_texts() -> list[tuple[str, str]]:
    """(リポジトリからのパス, 中身)。UTF-8 で読めないファイル（画像等）と、作業ツリーに無いファイルは読まない。"""
    texts = []
    for name in run("ls-files", "-z", cwd=REPO_ROOT, check=True).stdout.split("\0"):
        if not name or name.startswith(UNMAINTAINED_PREFIXES):
            continue
        try:
            texts.append((name, (REPO_ROOT / name).read_text(encoding="utf-8")))
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
    return texts


def _site(origin: str) -> str:
    return ".".join((urlsplit(origin).hostname or "").split(".")[-2:])


def _owner(file: str) -> dict:
    return json.loads((REPO_ROOT / file).read_text(encoding="utf-8"))


def test_production_origins_are_written_as_the_owner_has_them():
    owned = set(_owner(ORIGINS_FILE).values())
    sites = {_site(origin) for origin in owned}
    written = {
        (name, origin.rstrip(".").lower())
        for name, text in _tracked_texts()
        if name != ORIGINS_FILE
        for origin in ORIGIN.findall(text)
        if _site(origin.rstrip(".").lower()) in sites
    }
    assert written, "本番の宛先を書いた所が1つも無い（拾う綴りの形が外れている）"
    assert sorted(f"{name}: {origin}" for name, origin in written if origin not in owned) == []


def test_tasks_repo_is_written_as_the_owner_has_it():
    config = _owner(FLOW_CONFIG_FILE)
    slug = re.compile(r"(?<![A-Za-z0-9_.-])" + re.escape(config["code"]) + r"[A-Za-z0-9_.-]*")
    written = {
        (name, found.rstrip("."))
        for name, text in _tracked_texts()
        if name != FLOW_CONFIG_FILE
        for found in slug.findall(text)
    }
    assert written, "コードのリポジトリの名前を書いた所が1つも無い（拾う綴りの形が外れている）"
    known = {config["code"], config["tasks"]}
    assert sorted(f"{name}: {found}" for name, found in written if found not in known) == []
