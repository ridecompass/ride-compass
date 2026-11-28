"""DBにある定義（道の区分・費用の軸・ひな形・較正値）を、プロセス内へ読み込む1つの入口。

**読む順の判断はここだけが持つ**。起動時（`main.py: lifespan`）がここを呼ぶ。管理APIの書き込みの直後の読み直しは、区分が読み込み済みのプロセスで、書いた定義だけを読み直す。
"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.cost_axis_service import refresh_cost_axes
from app.services.road_class_service import refresh_road_classes
from app.services.route_profile_service import refresh_route_profiles
from app.services.tuning_service import refresh_tuning_values


async def refresh_definitions(session: AsyncSession) -> None:
    """区分 → 費用の軸の定義 → ひな形 → 較正値の順に読み込む。費用の軸の定義・較正値が無いか、どれかが読めなければ例外のまま止める。"""
    # 費用の軸は区分から作る材料（`class:<分け方>`）を指せるので、区分を先に読む。
    await refresh_road_classes(session)
    await refresh_cost_axes(session)
    # ひな形は費用の軸と道の段の行を名指すので、両方の後に読む。
    await refresh_route_profiles(session)
    await refresh_tuning_values(session)
