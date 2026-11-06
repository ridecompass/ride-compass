"""`infrastructure/tile_persistent_cache.py`——呼び出し元が設計したタプルの鍵でPythonオブジェクトを置くディスク。

ここで見ないもの:
- 鍵をどう組み立てるか・いつ失効させるか → 呼び出し元（`test_feature_materials.py`等）
- 違う鍵が別のエントリになること・同じ鍵の上書き・`expire`での失効・書いていない鍵の外れ → `diskcache`へ鍵と`expire`を
  そのまま渡すだけで、自前の判断が無い
- 生バイトの置き場 → `test_tile_cache.py`

置き場は`conftest.py`のautouseフィクスチャがテストごとの一時ディレクトリへ差し替える。
"""

import sqlite3

from app.infrastructure import tile_persistent_cache

KEY = ("way_values", 7, "material_a", 12, 3630, 1612, "09", None, None)
TTL = 3600


def _boom(*_args, **_kwargs):
    raise sqlite3.OperationalError("disk I/O error")


class TestWhenTheDiskRefuses:
    def test_a_read_that_blows_up_is_a_miss(self, monkeypatch):
        """壊れたエントリ・SQLiteの障害で止めると、キャッシュの不調がそのまま機能停止になる。"""
        tile_persistent_cache.set_by_key(KEY, "value", expire=TTL)
        monkeypatch.setattr(tile_persistent_cache, "cache", _boom)

        assert tile_persistent_cache.get_by_key(KEY) is None
