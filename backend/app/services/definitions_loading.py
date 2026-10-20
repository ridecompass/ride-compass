"""DBにある定義（道の区分・軸定義・較正値）を、プロセス内へ読み込む1つの入口。

**読む順の判断はここだけが持つ**。起動時（`main.py`の`lifespan`）と、起動を通らずに生成・評価を回す道具（ベンチ・
`scripts/`）がここを呼ぶ。管理APIの書き込みの直後の読み直しは、区分が読み込み済みのプロセスで、書いた定義だけを読み直す。
"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.axis_definition_repository import AxisDefinitionRepository
from app.services.axis_registry_service import refresh_axis_definitions
from app.services.road_class_service import refresh_road_classes
from app.services.tuning_service import refresh_tuning_values


async def refresh_definitions(session: AsyncSession, axes: AxisDefinitionRepository) -> None:
    """区分 → 軸定義 → 較正値の順に読み込む。軸定義を読めなければ例外のまま止める。`axes`は`session`の上に組んだもの。"""
    # 軸は区分から作る材料（`class:<分け方>`）を指せるので、区分を先に読む。
    await refresh_road_classes(session)
    await refresh_axis_definitions(axes)
    # 較正値は行が1つも無ければ宣言どおりの既定値のまま動く（壊れた値の行だけが止める）。
    await refresh_tuning_values(session)
