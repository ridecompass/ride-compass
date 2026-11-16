"""走りの記録（端末が走行モードの間に溜め、走り終えに送るもの）の形。

端末は欄の名前を毎点くり返さない詰めた形で送る。点の値は端末が出したままで、止まり・外れ等の解釈は足さない。
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, JsonValue

from app.domain.strict_model import StrictModel

#: 1点: 走り始めからのミリ秒・緯度と経度の100万倍・標高の10倍（m）・位置の誤差の10倍（m）・速さの100倍（m/s）・進む向き（度）・
#: 標高の誤差の10倍（m）。端末が出さなかった値は null。
RidePoint = tuple[int, int, int, int | None, int | None, int | None, int | None, int | None]

RideEventKind = Literal["start", "rest", "resume", "reload", "route", "end"]

#: 走りの出来事: 走り始めからのミリ秒・種類・付け足し（`route`のときの替えた先のルートの鍵。ほかは null）。
RideEvent = tuple[Annotated[int, Field(ge=0)], RideEventKind, str | None]


class RideUpload(StrictModel):
    """端末が走り終えに送る、走り1回。`id`は端末が走りを始めたときに作り、送り直しても変わらない。"""

    id: UUID
    started_at: AwareDatetime
    #: 走りを記録した画面の版（frontend のコミット。分からなければ null）。
    app_version: str | None
    device: str
    points: list[RidePoint]
    events: list[RideEvent]
    #: 走りの間に推したルート（鍵 → 候補を受けたまま）。
    routes: dict[str, JsonValue]
    #: 推したルートの鍵ごとの、サーバーが返した生成の条件（受けたまま）。生成した候補だけ（乗り換えで作った・読み込み直して戻した候補には無い）。
    conditions: dict[str, JsonValue]
    #: アプリがそのとき見せた予報（受けたまま）。
    forecasts: list[JsonValue]
