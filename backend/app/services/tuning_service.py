"""較正値の読み込みと書き込み（管理APIのサービス層）。

**トランザクション境界はここが持つ**（[design-principles.md](../../../docs/architecture/design-principles.md)
構造仕様7）。ルーターが`commit()`/`rollback()`を直接呼ぶと、1リクエストで2つ以上の書き込みを
まとめたくなったときに「どこまでが1つの取引か」を決める場所が無くなる。

**プロセス内の`TUNING_VALUES`へ書くのはここだけ**（起動時の読み込みと、管理APIの書き込みの確定の直後）。
DBへ書いただけでは次のリクエストが古い値を読むため、書き込みと反映を離さない（`services/cost_axis_service.py: refresh_cost_axes`が
費用の軸の定義で採っているのと同じ、同一プロセス内で完結させポーリングしない形）。
"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.tuning import TUNING_VALUES
from app.infrastructure.tuning_overrides import TuningOverrideStore, load_tuning_values


async def refresh_tuning_values(session: AsyncSession) -> None:
    """DBの表を読み、プロセス内の`TUNING_VALUES`へ反映する（起動時の読み込み）。

    **中身だけを差し替える**（辞書そのものを作り直すと、import済みの参照が古い辞書を指したままになる）。`clear()`を
    挟まない——探索は別スレッドから読むため、消してから足すまでの間に読むと宣言にあるidでも`KeyError`になる。
    """
    TUNING_VALUES.update(await load_tuning_values(session))


class TuningService:
    """管理画面の較正値の書き込み。`session`はタイル配信と同じ工場のもので、`overrides`は同じセッションの上の
    値の行の読み書き（`api/dependencies.py: get_tuning_service`）。"""

    def __init__(self, session: AsyncSession, overrides: TuningOverrideStore):
        self._session = session
        self._overrides = overrides

    async def save_value(self, param_id: str, value: float) -> None:
        """1件を書き、確定したらプロセスの値を差し替える（確定の前に失敗すれば、セッションを閉じるときに巻き戻る）。"""
        await self._overrides.set_value(param_id, value)
        await self._session.commit()
        TUNING_VALUES[param_id] = value
