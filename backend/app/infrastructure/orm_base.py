"""ORMモデルが共有する宣言の基点。

**表の形の宣言はORMモデル1か所に置く**（正本は実DBで、この宣言は「あるべき姿」）。
実DBとの一致は`backend/scripts/schema_gap.py`が測る。
"""

import importlib

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

#: 表の`info`に付ける印（`__table_args__`の最後に`{"info": DERIVED}`）。生データから作り直す派生の表であることを
#: 宣言する。派生の表の一覧（`derived_tables`）はこの印から導く。
DERIVED_KEY = "derived"
DERIVED = {DERIVED_KEY: True}


class Base(DeclarativeBase):
    pass


#: 表を宣言するモジュールの全部（`Base.metadata`の中身は同じ実行でほかに誰がimportしたかで変わるので、`declared_metadata`が全部をimportする）。
TABLE_MODULES = (
    "app.infrastructure.account_models",
    "app.infrastructure.cost_axis_models",
    "app.infrastructure.derived_data_meta",
    "app.infrastructure.derived_models",
    "app.infrastructure.ride_track_models",
    "app.infrastructure.road_class_models",
    "app.infrastructure.source_models",
    "app.infrastructure.tuning_overrides",
)


def declared_metadata() -> MetaData:
    """ORMが宣言する全表を載せた`Base.metadata`。

    `Base.metadata`には**importしたモジュールの表しか載らない**。全表を見る側（スキーマの作成・
    実DBとの突き合わせ・バックアップ・テストの片付け）は、呼び出し側のimport次第で表が静かに欠けないよう、ここを通す。
    """
    for module in TABLE_MODULES:
        importlib.import_module(module)
    return Base.metadata


def derived_tables() -> list:
    """表の印（`DERIVED`）を持つ表（＝派生データ）。"""
    return [table for table in declared_metadata().sorted_tables
            if table.info.get(DERIVED_KEY)]
