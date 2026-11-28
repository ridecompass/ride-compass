"""走りの記録（端末が走行モードの間に溜め、走り終えに送るもの）の形。

端末は欄の名前を毎点くり返さない詰めた形で送る。点の値は端末が出したままで、止まり・外れ等の解釈は足さない。
"""

from collections.abc import Sequence
from typing import Annotated, Any, Literal
from uuid import UUID

import numpy as np
from pydantic import AwareDatetime, Field, JsonValue, WithJsonSchema

from app.domain.geo import haversine_distance_km_pairs
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


# GeoJSONのMultiLineString。走りを休むごとに線を分け、点は RFC 7946 の位置の[経度, 緯度]。
MultiLineStringGeometry = Annotated[
    dict[str, Any],
    WithJsonSchema(
        {
            "type": "object",
            "properties": {
                "type": {"const": "MultiLineString", "type": "string"},
                "coordinates": {
                    "type": "array",
                    "items": {"type": "array", "items": {"type": "array", "items": {"type": "number"}}},
                },
            },
            "required": ["type", "coordinates"],
        }
    ),
]


class RideSummary(StrictModel):
    """自分の走りの一覧の1件。"""

    id: UUID
    started_at: AwareDatetime
    #: 走った線の長さ。休んで途切れた間はつながない。
    distance_m: int
    #: 走り始めから最後の点まで（休んだ時間も含む）。
    duration_s: int


class RideDetail(RideSummary):
    track: MultiLineStringGeometry


def track_distance_m(lines: Sequence[Sequence[tuple[float, float]]]) -> float:
    """線（点は緯度, 経度）ごとの、隣り合う点の間の球面距離の和（m）。線と線の間はつながない。"""
    total_km = 0.0
    for line in lines:
        if len(line) < 2:
            continue
        lat, lon = np.asarray(line, dtype=float).T
        total_km += float(haversine_distance_km_pairs(lat[:-1], lon[:-1], lat[1:], lon[1:]).sum())
    return total_km * 1000
