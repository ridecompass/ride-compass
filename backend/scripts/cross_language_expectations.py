"""backendと画面が同じ計算を持つところの「入力→答え」の表。

入力はここに並べ、答えはbackendの関数が出す（手で書かない）。`export_openapi.py`が
`EXPECTATIONS`の組ごとに`frontend/src/types/generated/<組>-expectations.json`へ書き出し、画面の
テストが全行を画面の関数へ当てる。backendの答えが変わると生成物のドリフト検査が落ち、生成し直すと
画面のテストが落ちる。backendの関数そのものの正しさは、手で書いたあるべき値のpytestが見る。
"""

import math
from collections.abc import Callable

from datetime import UTC, datetime

from app.domain.gradient import ROAD_BEARING_LEAF, travel_direction_formula
from app.domain.geo import COMPASS_LABELS, LatLonPoint, compass_label, haversine_distance_km
from app.domain.jma_tile_specs import (
    JMA_ELEMENTS,
    JmaFrame,
    JmaTile,
    TargetTimesReader,
    jma_tile_path,
    read_target_times,
)
from app.domain.region import BoundingBox, tile_bounds_lonlat, tile_position, tiles_covering_bbox
from app.domain.route import RouteSegmentDetail, merge_route_values
from app.domain.time_zone import jst_local_text
from app.domain.way_value_formula import (
    FALSE,
    Binary,
    Case,
    Interpolate,
    Missing,
    Round,
    Unary,
    WayValueFormula,
    add,
    const,
    evaluate_formula,
    feature,
)
from app.domain.weather_elements import stage_first_frames
from app.domain.wind import WIND_DRAG_RATIO_WAY_FORMULA
from app.infrastructure.jma_tile_client import parse_target_times
from app.infrastructure.jma_tile_paths import read_jma_tile_path

# 距離は生成物がどの機械で書いてもバイト単位で同じになる桁へ丸める（numpyの三角関数は
# CPUの命令セットで最下位の桁が変わりうる）。1mmの桁で、式の違いは十分に見分けられる。
_DISTANCE_DECIMALS = 6

# 区分の境界のすぐ手前。境界ちょうどとの違いで丸めの向きが分かれる。
_JUST_BEFORE_DEG = 1e-6

_DISTANCE_PAIRS: list[tuple[LatLonPoint, LatLonPoint]] = [
    (LatLonPoint(35.68, 139.77), LatLonPoint(35.68, 139.77)),  # 同じ地点
    (LatLonPoint(0.0, 139.0), LatLonPoint(0.0, 140.0)),  # 赤道を東西に
    (LatLonPoint(35.0, 139.0), LatLonPoint(35.0, 139.1)),  # 中緯度を東西に
    (LatLonPoint(35.0, 139.0), LatLonPoint(35.1, 139.0)),  # 南北に
    (LatLonPoint(35.68, 139.77), LatLonPoint(34.69, 135.50)),  # 日本の範囲の斜め（東京→大阪）
    (LatLonPoint(43.06, 141.35), LatLonPoint(26.21, 127.68)),  # 日本の範囲の斜め（札幌→那覇）
    (LatLonPoint(10.0, 179.5), LatLonPoint(10.5, -179.5)),  # 経度180度をまたぐ
]


def _bearings() -> list[float]:
    """方位の区分（北が中心）の境界ちょうどとその少し手前、負の角度・一周を超える角度。"""
    count = len(COMPASS_LABELS)
    width = 360 / count
    boundaries = [i * width + width / 2 for i in range(count)]
    edges = [angle for boundary in boundaries for angle in (boundary, boundary - _JUST_BEFORE_DEG)]
    return [0.0, *edges, -width, -width / 2, 360.0, 360.0 + width / 2, 720.0 + width]


def geo_expectations() -> dict[str, list[dict]]:
    return {
        "compass_label": [
            {"bearing_deg": bearing, "label": compass_label(bearing)} for bearing in _bearings()
        ],
        "distance_km": [
            {
                "from": a._asdict(),
                "to": b._asdict(),
                "km": round(haversine_distance_km(a, b), _DISTANCE_DECIMALS),
            }
            for a, b in _DISTANCE_PAIRS
        ],
    }


def _row(basetime: str, validtime: str, elements: list[str], member: str | None = None) -> dict:
    """時刻一覧の1行（配信元のJSONの形。系列を持たない系統の行には`member`が無い）。"""
    row: dict = {"basetime": basetime, "validtime": validtime, "elements": elements}
    if member is not None:
        row["member"] = member
    return row


def _t(hhmm: str) -> str:
    return f"20260924{hhmm}00"


# 読み方ごとの場面: （場面, 読み方, 要素id, 時刻一覧の行）。行は並べ替えずに渡る順のまま。
_READER_SCENES: list[tuple[str, TargetTimesReader, str, list[dict]]] = [
    (
        "別の要素の行が混ざる",
        "nowcast",
        "thns",
        [
            _row(_t("0010"), _t("0020"), ["thns", "liden"]),
            _row(_t("0010"), _t("0010"), ["thns", "liden"]),
            _row(_t("0015"), _t("0015"), ["liden"]),
            _row(_t("0010"), _t("0030"), ["thns"]),
        ],
    ),
    (
        "実況が無い",
        "nowcast",
        "hrpns",
        [
            _row(_t("0010"), _t("0030"), ["hrpns"]),
            _row(_t("0010"), _t("0020"), ["hrpns"]),
        ],
    ),
    (
        "実況が複数",
        "nowcast",
        "hrpns",
        [
            _row(_t("0000"), _t("0000"), ["hrpns"]),
            _row(_t("0010"), _t("0020"), ["hrpns"]),
            _row(_t("0010"), _t("0010"), ["hrpns"]),
            _row(_t("0005"), _t("0005"), ["hrpns"]),
        ],
    ),
    (
        "実況と予測のファイルのbasetimeがずれる",
        "nowcast",
        "hrpns",
        [
            _row(_t("0005"), _t("0005"), ["hrpns"]),
            _row(_t("0010"), _t("0010"), ["hrpns"]),
            _row(_t("0005"), _t("0010"), ["hrpns"]),
            _row(_t("0005"), _t("0015"), ["hrpns"]),
            _row(_t("0010"), _t("0015"), ["hrpns"]),
            _row(_t("0010"), _t("0020"), ["hrpns"]),
        ],
    ),
    ("その要素の行が0件", "nowcast", "thns", [_row(_t("0015"), _t("0015"), ["liden"])]),
    (
        "中間ランの単発の行",
        "latestFullRun",
        "rasrf",
        [
            _row(_t("0000"), _t("0100"), ["rasrf"], "immed"),
            _row(_t("0000"), _t("0200"), ["rasrf"], "immed"),
            _row(_t("0010"), _t("0010"), ["rasrf"], "immed"),
            _row("20260923230000", _t("0000"), ["rasrf"], "immed"),
            _row("20260923230000", _t("0100"), ["rasrf"], "immed"),
        ],
    ),
    (
        "系列が2つで有効時刻が重なる",
        "latestFullRun",
        "rasrf",
        [
            _row(_t("0000"), _t("0800"), ["rasrf"], "none"),
            _row(_t("0000"), _t("0600"), ["rasrf"], "none"),
            _row(_t("0010"), _t("0500"), ["rasrf"], "immed"),
            _row(_t("0010"), _t("0600"), ["rasrf"], "immed"),
        ],
    ),
    (
        "別の要素の行が混ざる",
        "latestFullRun",
        "rasrf",
        [
            _row(_t("0000"), _t("0100"), ["rasrf", "sjfcstmap"], "immed"),
            _row(_t("0000"), _t("0200"), ["rasrf"], "immed"),
            _row(_t("0020"), _t("0110"), ["sjfcstmap"], "immed"),
            _row(_t("0020"), _t("0210"), ["sjfcstmap"], "immed"),
        ],
    ),
    ("その要素の行が0件", "latestFullRun", "rasrf", [_row(_t("0020"), _t("0110"), ["sjfcstmap"], "immed")]),
    (
        "別の要素の行が混ざる",
        "latest",
        "land",
        [
            _row(_t("0000"), _t("0000"), ["land", "inund"], "none"),
            _row(_t("0010"), _t("0010"), ["land"], "immed"),
            _row(_t("0020"), _t("0020"), ["inund"], "none"),
        ],
    ),
    ("その要素の行が0件", "latest", "land", [_row(_t("0020"), _t("0020"), ["inund"], "none")]),
]


def _frame(hhmm: str) -> JmaFrame:
    return JmaFrame(_t(hhmm), "none", _t(hhmm))


# 段をつなぐ場面: （場面, 段ごとのコマ（近い時刻の段から、段の中は`validtime`の順））。
_STAGE_SCENES: list[tuple[str, list[list[JmaFrame]]]] = [
    (
        "段が重なる",
        [
            [_frame("0000"), _frame("0100")],
            [_frame("0100"), _frame("0200"), _frame("0300")],
            [_frame("0200"), _frame("0400")],
        ],
    ),
    ("後の段が前の段にすべて含まれる", [[_frame("0000"), _frame("0100"), _frame("0200")], [_frame("0100"), _frame("0200")]]),
    ("途中の段が空", [[_frame("0000")], [], [_frame("0000"), _frame("0100")]]),
    ("先頭の段が空", [[], [_frame("0100"), _frame("0200")]]),
    ("全段が空", [[], []]),
]

# タイルで配る要素すべての、同じコマ・同じタイル座標のタイル。
_TILES = [
    JmaTile(element_id, JmaFrame(_t("0000"), "immed", _t("0100")), 9, 454, 201)
    for element_id, element in JMA_ELEMENTS.items()
    if element.tile is not None
]


def _tile_row(tile: JmaTile) -> dict:
    return {"element_id": tile.element_id, "frame": tile.frame._asdict(), "z": tile.z, "x": tile.x, "y": tile.y}


def _not_number(path: str) -> str:
    """タイルのパスの最後のタイル座標（y）を数字でない区切りにしたもの。"""
    head, _, tail = path.rpartition("/")
    return f"{head}/y{tail}"


# 読み戻すパス: タイルで配る要素すべてのタイルのパスと、タイル座標が数字でないパス・要素の無いパス。
_READ_PATHS = [
    *(jma_tile_path(tile) for tile in _TILES),
    _not_number(jma_tile_path(_TILES[0])),
    "bosai/jmatile/data/unknown/20260924000000/none/20260924010000/surf/unknown/9/454/201.png",
]


def jma_expectations() -> dict[str, list[dict]]:
    return {
        "read_target_times": [
            {
                "scene": scene,
                "reader": reader,
                "element_id": element_id,
                "rows": rows,
                "frames": [
                    frame._asdict() for frame in read_target_times(reader, parse_target_times(rows) or [], element_id)
                ],
            }
            for scene, reader, element_id, rows in _READER_SCENES
        ],
        "stage_first_frames": [
            {
                "scene": scene,
                "stages": [[frame._asdict() for frame in frames] for frames in stages],
                "first_frames": [None if frame is None else frame._asdict() for frame in stage_first_frames(stages)],
            }
            for scene, stages in _STAGE_SCENES
        ],
        "tile_path": [
            {
                "element_id": tile.element_id,
                "frame": tile.frame._asdict(),
                "z": tile.z,
                "x": tile.x,
                "y": tile.y,
                "path": jma_tile_path(tile),
            }
            for tile in _TILES
        ],
        "read_tile_path": [
            {"path": path, "tile": None if (tile := read_jma_tile_path(path)) is None else _tile_row(tile)}
            for path in _READ_PATHS
        ],
    }


# タイル座標の小数部の桁。タイルの中の位置として十分に細かく、CPUで変わりうる最下位の桁を落とす。
_TILE_DECIMALS = 9

# 緯度経度→タイル座標の場面: （場面, 経度, 緯度, ズーム）。
_TILE_POINTS: list[tuple[str, float, float, int]] = [
    ("東京駅", 139.7671, 35.6812, 14),
    ("経度0度・赤道（タイルの境目ちょうど）", 0.0, 0.0, 1),
    ("西の端", -180.0, 10.0, 3),
    ("東の端", 180.0, -10.0, 3),
    ("Web Mercatorの限界より北", 100.0, 89.9, 3),
    ("Web Mercatorの限界より南", -100.0, -89.9, 3),
]

# 範囲→覆うタイルの場面: （場面, 範囲, ズーム）。
_TILE_AREAS: list[tuple[str, BoundingBox, int]] = [
    (
        "東京駅の辺り（1枚）",
        BoundingBox(min_latitude=35.6811, min_longitude=139.7670, max_latitude=35.6813, max_longitude=139.7672),
        14,
    ),
    (
        "東京の辺り（東西南北に複数枚）",
        BoundingBox(min_latitude=35.5, min_longitude=139.5, max_latitude=35.8, max_longitude=139.9),
        12,
    ),
    (
        "東端・南端がタイルの境目ちょうど",
        BoundingBox(min_latitude=0.0, min_longitude=-90.0, max_latitude=10.0, max_longitude=0.0),
        1,
    ),
    (
        "東端と北端が世界の端（端のタイルへ寄せる）",
        BoundingBox(min_latitude=89.0, min_longitude=179.0, max_latitude=89.9, max_longitude=180.0),
        3,
    ),
    (
        "西端と南端が世界の端（端のタイルへ寄せる）",
        BoundingBox(min_latitude=-89.9, min_longitude=-180.0, max_latitude=-89.0, max_longitude=-179.0),
        3,
    ),
]

# タイル→範囲の場面: （場面, ズーム, x, y）。
_TILE_INDICES: list[tuple[str, int, int, int]] = [
    ("世界全体", 0, 0, 0),
    ("東京駅", 14, 14552, 6451),
    ("南東の端", 3, 7, 7),
    ("北東", 1, 1, 0),
]


def _span(values: list[int]) -> list[int]:
    return [min(values), max(values)]


def region_expectations() -> dict[str, list[dict]]:
    """XYZタイル（Web Mercator）の座標の式。"""
    rows_position = []
    for scene, lon, lat, z in _TILE_POINTS:
        x, y = tile_position(lon, lat, z)
        rows_position.append(
            {
                "scene": scene,
                "lon": lon,
                "lat": lat,
                "z": z,
                "x": round(x, _TILE_DECIMALS) + 0.0,
                "y": round(y, _TILE_DECIMALS) + 0.0,
            }
        )
    rows_covering = []
    for scene, bbox, z in _TILE_AREAS:
        tiles = tiles_covering_bbox(bbox, z)
        rows_covering.append(
            {
                "scene": scene,
                "bbox": bbox.model_dump(),
                "z": z,
                "x_range": _span([x for x, _ in tiles]),
                "y_range": _span([y for _, y in tiles]),
            }
        )
    rows_bounds = []
    for scene, z, x, y in _TILE_INDICES:
        bounds = tile_bounds_lonlat(z, x, y)
        rows_bounds.append(
            {
                "scene": scene,
                "z": z,
                "x": x,
                "y": y,
                "bounds": {key: round(value, _TILE_DECIMALS) for key, value in bounds.model_dump().items()},
            }
        )
    return {"tile_position": rows_position, "tiles_covering_bbox": rows_covering, "tile_bounds_lonlat": rows_bounds}


# 時刻の場面: （場面, 時点）。日本時間で日付・月・年・うるう日が変わる所を選ぶ。
_INSTANTS: list[tuple[str, datetime]] = [
    ("協定世界時の0時（日本時間の9時）", datetime(2026, 8, 30, 0, 0, tzinfo=UTC)),
    ("日本時間の日付が変わる直前", datetime(2026, 8, 30, 14, 59, tzinfo=UTC)),
    ("日本時間の日付が変わる", datetime(2026, 8, 30, 15, 0, tzinfo=UTC)),
    ("日本時間の年が変わる", datetime(2026, 12, 31, 15, 0, tzinfo=UTC)),
    ("日本時間のうるう日", datetime(2028, 2, 28, 15, 30, tzinfo=UTC)),
]


def time_expectations() -> dict[str, list[dict]]:
    """応答へ書くタイムゾーンの無い時刻（JSTのローカル時刻）。"""
    return {
        "jst_local_text": [
            {"scene": scene, "instant": instant.isoformat().replace("+00:00", "Z"), "text": jst_local_text(instant)}
            for scene, instant in _INSTANTS
        ],
    }


def _segment(distance_km: float, contributions: dict[str, float] | None) -> RouteSegmentDetail:
    """区間1本。寄与度の和が区間の難易度で、`None`は値の無い区間。"""
    return RouteSegmentDetail(
        start_latitude=35.0,
        start_longitude=139.0,
        end_latitude=35.0,
        end_longitude=139.0,
        cumulative_distance_km=0.0,
        distance_km=distance_km,
        edge_start=0,
        edge_end=1,
        elevations=[],
        road_classes={},
        axis_contributions=contributions or {},
        difficulty=None if contributions is None else sum(contributions.values()),
    )


# ルート全体の難易度の場面: （場面, 区間（距離km, 軸ごとの寄与度。値の無い区間はNone））。平均が丸めで動かない値を選ぶ。
_ROUTES: list[tuple[str, list[tuple[float, dict[str, float] | None]]]] = [
    ("どの区間にも値がある", [(1.0, {"a": 10.0, "b": 10.0}), (1.0, {"a": 40.0})]),
    ("値の無い区間がある", [(1.0, {"a": 10.0, "b": 10.0}), (2.0, None), (1.0, {"a": 40.0})]),
    ("どの区間にも値が無い", [(1.0, None), (2.0, None)]),
]


def difficulty_expectations() -> dict[str, list[dict]]:
    """ルート全体の難易度（平均と総量）。値の無い区間の数え方が分かれる場面を並べる。"""
    rows = []
    for scene, parts in _ROUTES:
        segments = [_segment(distance_km, contributions) for distance_km, contributions in parts]
        overall = merge_route_values(segments).overall_difficulty
        rows.append(
            {
                "scene": scene,
                "segments": [
                    {
                        "distance_km": segment.distance_km,
                        "difficulty": segment.difficulty,
                        "axis_contributions": segment.axis_contributions,
                    }
                    for segment in segments
                ],
                "overall_difficulty": None if overall is None else overall.model_dump(),
            }
        )
    return {"overall_difficulty": rows}


def _values_only(value: object) -> WayValueFormula:
    return WayValueFormula(value=value, undetermined=FALSE)


_X = feature("x")
_Y = feature("y")

#: 場面 → 木と、木へ入れる道ごとの材料（値の無い材料は載せない）と条件の組。
_WAY_VALUE_FORMULAS: list[tuple[str, WayValueFormula, list[tuple[dict[str, float], dict[str, float]]]]] = [
    (
        "丸め1桁（2進で中点ちょうど・中点のすぐ上下・負）",
        _values_only(Round(arg=_X, decimals=1)),
        [({"x": x}, {}) for x in (0.25, 0.35, 0.45, 1.15, 1.25, 1.35, 11.55, -0.25, -0.35, -1.25, 0.04, 99.95)]
        + [({}, {})],
    ),
    (
        "丸め3桁と0桁",
        _values_only(add(Round(arg=_X, decimals=3), Round(arg=_Y, decimals=0))),
        [({"x": x, "y": y}, {}) for x, y in ((2.675, 0.5), (0.0005, 1.5), (-0.0015, 2.5), (1.0005, -0.5), (0.1235, 3.49))],
    ),
    (
        "勾配の割合を足した折れ線（中点に乗る和・両端の外・値の無い材料）",
        _values_only(Round(arg=Interpolate(input=add(_X, _Y), stops=[(0.0, 0.0), (4.0, 30.0), (10.0, 100.0)]),
                           decimals=1)),
        [*(({"x": x, "y": y}, {}) for x, y in ((1.0, 0.1), (2.3, 0.0), (0.7, 0.33), (-1.0, 0.0), (11.0, 2.0), (4.0, 0.0))),
         ({"x": 1.0}, {})],
    ),
    (
        "折れ点1つ",
        _values_only(Interpolate(input=_X, stops=[(3.0, 7.0)])),
        [({"x": -5.0}, {}), ({"x": 3.0}, {}), ({"x": 8.0}, {}), ({}, {})],
    ),
    (
        "剰余・比べ・論理・否定・欠け",
        _values_only(Case(
            when=Binary(op="and", left=Unary(op="not", arg=Unary(op="is_missing", arg=_X)),
                        right=Binary(op="or", left=Binary(op="lt", left=_Y, right=const(0.0)),
                                     right=Binary(op="ge", left=_Y, right=const(10.0)))),
            then=Binary(op="mod", left=_X, right=const(3.0)),
            otherwise=Case(when=Binary(op="le", left=_X, right=_Y), then=Unary(op="abs", arg=_Y),
                           otherwise=Missing()),
        )),
        [({"x": -7.0, "y": -1.0}, {}), ({"x": 7.5, "y": 12.0}, {}), ({"x": 2.0, "y": 5.0}, {}),
         ({"x": 6.0, "y": 5.0}, {}), ({"y": -1.0}, {}), ({"x": 1.0}, {}), ({"x": 0.0, "y": 0.0}, {})],
    ),
    (
        "平方根・符号・割り算",
        _values_only(Binary(op="div", left=Unary(op="sqrt", arg=_X), right=Unary(op="neg", arg=_Y))),
        [({"x": 2.0, "y": 4.0}, {}), ({"x": -1.0, "y": 1.0}, {}), ({"x": 9.0, "y": -3.0}, {})],
    ),
    (
        "走る向きで選ぶ勾配（道の向き寄り・逆向き寄り・直角の付近・向きの無い道）",
        travel_direction_formula(feature("forward"), feature("backward")),
        [({ROAD_BEARING_LEAF: road, "forward": 3.0, "backward": -3.0}, {"bearing_deg": bearing})
         for road, bearing in ((10.0, 0.0), (10.0, 200.0), (350.0, 5.0), (0.0, 104.0), (0.0, 105.0), (0.0, 106.0),
                               (0.0, 255.5), (180.0, 359.75))]
        + [({"forward": 3.0, "backward": -3.0}, {"bearing_deg": 90.0}), ({ROAD_BEARING_LEAF: 0.0}, {"bearing_deg": 0.0})],
    ),
    (
        "風の追加負荷（向かい風・追い風・横風・風の無い道）",
        WIND_DRAG_RATIO_WAY_FORMULA,
        [({"wind_speed_ms": speed, "wind_direction_deg": direction}, {"bearing_deg": bearing, "speed_kmh": kmh})
         for speed, direction, bearing, kmh in ((5.0, 0.0, 0.0, 20.0), (5.0, 180.0, 0.0, 20.0), (8.0, 90.0, 0.0, 25.0),
                                                (3.2, 47.0, 312.5, 18.0), (12.0, 200.0, 20.0, 40.0))]
        + [({}, {"bearing_deg": 0.0, "speed_kmh": 20.0})],
    ),
]


def _formula_row(formula: WayValueFormula, features: dict[str, float], conditions: dict[str, float]) -> dict:
    value = float(evaluate_formula(formula.value, features, conditions))
    undetermined = float(evaluate_formula(formula.undetermined, features, conditions))
    return {
        "features": features,
        "conditions": conditions,
        "value": None if math.isnan(value) else value,
        "undetermined": not math.isnan(undetermined) and undetermined != 0,
    }


def way_value_expectations() -> dict[str, list[dict]]:
    """地図が塗る値の木を、道ごとの材料と条件で評価した値（値の無い道はnull）と、向きで決まらないか。丸めの中点・
    折れ線の端・値の無い材料のように、地図の式と食い違いうる場面を並べる。"""
    return {
        "way_value_formula": [
            {"scene": scene, "formula": formula.model_dump(mode="json"),
             "rows": [_formula_row(formula, features, conditions) for features, conditions in inputs]}
            for scene, formula, inputs in _WAY_VALUE_FORMULAS
        ]
    }


#: 組の名前 → 表を作る関数。組を足すときはここに1行足す（書き出しと置き場の名前はこれから決まる）。
EXPECTATIONS: dict[str, Callable[[], dict[str, list[dict]]]] = {
    "geo": geo_expectations,
    "region": region_expectations,
    "time": time_expectations,
    "difficulty": difficulty_expectations,
    "jma": jma_expectations,
    "way-value": way_value_expectations,
}
