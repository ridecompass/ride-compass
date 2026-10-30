"""コードの指紋（`code_fingerprint.py`）が、モジュールから`import`でたどれる`app`の中のモジュールと、それらが読み込む
ライブラリだけを数えること。

コードの置き場（`code_fingerprint.ROOT`）を一時ディレクトリへ移し、そこに小さな`app`を書いて見る。ライブラリは入っている
本物を読ませ、版を変えたときだけ、配布物の読み出し（`importlib.metadata.distribution`）を差し替える。
"""

import importlib.metadata

import pytest

from app.batch import code_fingerprint


@pytest.fixture
def app_root(monkeypatch, tmp_path):
    files = {
        "app/__init__.py": "",
        "app/batch/__init__.py": "",
        # 関数の中の import・相対の import・`from <パッケージ> import <モジュール>` をたどる
        "app/batch/adapter.py": "import json\nimport numpy\nfrom app.batch import helper\n\ndef read():\n"
                                "    from .lazy import VALUE\n    return VALUE\n",
        "app/batch/helper.py": "from app.domain.rules import LIMIT\n",
        "app/batch/lazy.py": "VALUE = 1\n",
        "app/domain/__init__.py": "",
        "app/domain/rules.py": "from pydantic import BaseModel\n\nLIMIT = 3\n",
        "app/batch/unrelated.py": "import apscheduler\n\nOTHER = 2\n",
    }
    for name, text in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    monkeypatch.setattr(code_fingerprint, "ROOT", tmp_path)
    return tmp_path


def test_modules_reachable_by_import_are_counted(app_root):
    assert sorted(code_fingerprint.reachable_modules("app.batch.adapter")) == [
        "app", "app.batch", "app.batch.adapter", "app.batch.helper", "app.batch.lazy", "app.domain",
        "app.domain.rules"]


class _Bumped:
    """版だけを上げた配布物。"""

    def __init__(self, dist: importlib.metadata.Distribution) -> None:
        self._dist = dist

    @property
    def version(self) -> str:
        return f"{self._dist.version}.post1"

    def __getattr__(self, name: str):
        return getattr(self._dist, name)


def _bump(monkeypatch, bumped: str) -> None:
    """配布物`bumped`の版を上げる。"""
    read = importlib.metadata.distribution

    def distribution(name: str):
        dist = read(name)
        return _Bumped(dist) if dist.metadata["Name"].lower() == bumped else dist

    monkeypatch.setattr(importlib.metadata, "distribution", distribution)


# 段が読み込むライブラリ・それが依存するライブラリの版が変わったら、段を流し直す。読み込まないライブラリの版だけが変われば、
# 流し直さない（変われば、使わないライブラリの更新のたびに派生の作り直しが全段流れる）。
@pytest.mark.parametrize(("bumped", "changes"), [
    ("numpy", True),
    # pydantic が依存する
    ("annotated-types", True),
    ("apscheduler", False),
])
def test_library_versions_change_only_with_libraries_the_module_reads(app_root, monkeypatch, bumped, changes):
    before = code_fingerprint.library_versions("app.batch.adapter")
    _bump(monkeypatch, bumped)
    assert (code_fingerprint.library_versions("app.batch.adapter") != before) is changes
