"""地図が軸について塗るもの——塗る値・単位・段の境界・凡例の目盛り——を軸定義から決める。

ルート確定前の全道路の塗り（専用way値配信）とルート確定後のルート線の色分けは、
どれもここが返す1つの値に従う。同じ軸の色分けは、ルートの有無でスケールも段も変わらない。
"""

from itertools import combinations
from typing import Annotated, Literal, cast

from pydantic import Field, model_validator

from app.domain.axis_definitions import AxisDefinition, BreakpointLinearShape, CategoricalShape
from app.domain.axis_raw_value import raw_value_unit
from app.domain.material_catalog import GRADIENT_PERCENT, material_spec
from app.domain.route import RouteSegmentDetail
from app.domain.strict_model import StrictModel

#: 難易度（0〜100）の段の境界。軸の形から段を導けないときに使う。**値ではなく等分の規則**
#: ——無次元の得点には目盛りの手掛かりが無いので、3等分する。符号付き材料の段は
#: 軸の折れ線から導く（`_signed_thresholds_from_breakpoints`）ので、ここには持たない。
DEFAULT_DIFFICULTY_BOUNDARIES: tuple[float, ...] = tuple(AxisDefinition.check_display_thresholds_ascending([33, 66]))

#: 真偽値の項の部分和は2^N通りある。GUIは材料の天井で超えないが、APIは直接叩ける。
_MAX_BOOLEAN_TERMS = 12

#: 得点の境界を量へ戻すときに試す小数の桁の上限。どの桁でもその得点へ戻らない境界（評価の丸めでは
#: 取らない得点）は、凡例を得点で書く。
_MAX_QUANTITY_DECIMALS = 6


class DifficultyMapValue(StrictModel):
    """地図が軸の難易度（0〜100）を塗る。軸スタジオのbreakpointsで評価済みの値。"""

    kind: Literal["difficulty"] = "difficulty"

    def segment_value(self, axis_id: str, segment: RouteSegmentDetail) -> float | None:
        """ルートの区間をこの軸のレンズで塗る値。値が無ければNone。"""
        return segment.axis_difficulties.get(axis_id)


class SignedMaterialMapValue(StrictModel):
    """地図が材料1つの符号付きの生値を塗る。進行方向で符号の変わる材料（勾配）1つの軸で、難易度へ写すと
    登りか下りかが失われる。"""

    kind: Literal["signed_material"] = "signed_material"
    #: 生値を塗る材料のid。画面は軸の形から読み直さない。
    material: str
    #: ルートの区間をレンズで塗るときに読む区間の欄。`material_values`はその材料の区間の距離加重平均で、勾配の材料だけは
    #: 区間の続く坂の斜度（`sustained_gradient_percent`）を塗る——平均は区間の中の上りと下りが打ち消し合う。
    route_segment_field: Literal["material_values", "sustained_gradient_percent"]

    def segment_value(self, axis_id: str, segment: RouteSegmentDetail) -> float | None:
        """ルートの区間をこの軸のレンズで塗る値。値が無ければNone。"""
        if self.route_segment_field == "sustained_gradient_percent":
            return segment.sustained_gradient_percent
        return segment.material_values.get(self.material)


# 塗る値の種類と、種類によって決まる項目を1つにまとめたもの。材料は`signed_material`のときだけ在る。
MapValue = Annotated[DifficultyMapValue | SignedMaterialMapValue, Field(discriminator="kind")]


class MapLegendScale(StrictModel):
    """地図の凡例が段の境界を書く目盛り。塗る値の目盛りと同じとは限らない——量から得点を作る軸は、
    塗るのは得点でも段は量で書く（「66」だけでは雨の量か得点か読めない）。"""

    #: `MapPaint.thresholds`と同じ件数・同じ順で、各境界をこの目盛りで書いた値。
    boundaries: list[float]
    #: 境界の単位。Noneは、境界が軸の得点（0〜100）であること（単位の無い量の空文字とは別）。
    unit: str | None


class MapPaint(StrictModel):
    """地図がこの軸について塗るもの。段の並び（境界・凡例・ラベル）はどれも同じ段を
    下から数えて並べ、読む側は段の番号で引き合わせる。"""

    value: MapValue
    #: 地図の凡例に添える単位。難易度は無次元（空文字）、符号付き材料は材料カタログの単位。
    unit: str
    #: `value`の種類が示すスケールでの段の境界。境界を宣言していない軸は形から導いた境界か
    #: 既定の境界（`DEFAULT_DIFFICULTY_BOUNDARIES`）——既定をここで解くので、読む側は既定を持たない。
    thresholds: list[float]
    #: 凡例が上の境界を書く目盛り。ルート確定の前と後で同じ段を同じ文字で書く。
    legend: MapLegendScale
    #: 段ごとの体感ラベル（`AxisDefinition.display_band_labels_override`）。上書きの無い軸はNoneで、
    #: 凡例は段の範囲だけを書く。
    band_labels: list[str] | None

    @model_validator(mode="after")
    def _check_bands_line_up(self) -> "MapPaint":
        """段の並びの件数を揃える。1つでも食い違うと、読む側が同じ番号で引いた境界・ラベルが
        別の段のものになる。"""
        bands = len(self.thresholds) + 1
        counts = {"legend boundaries": len(self.legend.boundaries) + 1}
        if self.band_labels is not None:
            counts["band labels"] = len(self.band_labels)
        mismatched = {name: count for name, count in counts.items() if count != bands}
        if mismatched:
            raise ValueError(f"map bands do not line up: {bands} bands from thresholds, but {mismatched}")
        return self


def map_paint(definition: AxisDefinition) -> MapPaint:
    """地図がこの軸について塗るもの。"""
    value = _map_value(definition)
    band_labels = definition.display_band_labels_override
    if isinstance(value, SignedMaterialMapValue):
        # `signed_material`は折れ線の軸にしか付かない。
        line = cast(BreakpointLinearShape, definition.shape)
        override = definition.display_thresholds_override
        thresholds = list(override) if override is not None else _signed_thresholds_from_breakpoints(line)
        unit = spec.unit if (spec := material_spec(value.material)) is not None else ""
        legend = MapLegendScale(boundaries=thresholds, unit=unit)
        return MapPaint(value=value, unit=unit, thresholds=thresholds, legend=legend, band_labels=band_labels)
    thresholds, quantities = _difficulty_thresholds(definition)
    quantity_unit = raw_value_unit(definition)
    if quantities is None or quantity_unit is None:
        legend = MapLegendScale(boundaries=thresholds, unit=None)
    else:
        legend = MapLegendScale(boundaries=quantities, unit=quantity_unit)
    return MapPaint(value=value, unit="", thresholds=thresholds, legend=legend, band_labels=band_labels)


def _map_value(definition: AxisDefinition) -> MapValue:
    """項が材料1つで、その材料が進行方向で符号の変わる値（`MaterialSpec.direction_signed`）なら、その生値を塗る。
    前処理（`abs`で上りも下りも測るか、`identity`で上りだけ測るか）は点数の付け方で、塗り方を変えない。

    **`terms[0].material`は材料idと軸idの2つの名前空間を跨ぐ**（`axis_definitions.py`）。
    材料を指しているときだけ生値を塗れる——軸を指す項の値は参照先の得点で、符号にも単位にも
    材料の意味が無い。0次条件を持つ軸も生値を塗らない——条件の当たる道でも生値は生値のままで、
    評価（条件の値）と食い違う。"""
    shape = definition.shape
    if (
        not definition.priority_overrides
        and isinstance(shape, BreakpointLinearShape)
        and len(shape.terms) == 1
        and (spec := material_spec(shape.terms[0].material)) is not None
        and spec.direction_signed
    ):
        material = shape.terms[0].material
        return SignedMaterialMapValue(
            material=material,
            route_segment_field="sustained_gradient_percent" if material == GRADIENT_PERCENT else "material_values",
        )
    return DifficultyMapValue()


def _signed_thresholds_from_breakpoints(shape: BreakpointLinearShape) -> list[float]:
    """符号付き材料の段の境界を、軸自身の折れ線の正の側の節から作る。

    **段の並びをどこかに固定で持たない。** 折れ線の節は「この材料のどの値から効きが
    変わるか」を軸が宣言したもので、段の境界として意味がある。固定の一覧を別に持つと、
    軸を直しても段が追従せず、しかもその一覧を誰が決めたのかが辿れなくなる。

    段は0対称に開く——材料の符号は走る向きで、同じ坂を逆に走ると符号だけが反転する。上りだけを
    測る軸（`preprocess="identity"`）も、下りの段を正の側の節で切る。負の側の節（下りを0点に
    張り付ける節等）は下りの効きの変わり目を言わないので使わない。
    """
    knots = sorted({x for x, _ in shape.breakpoints if x > 0})
    return [-x for x in reversed(knots)] + knots


def _adjacent_midpoint_thresholds(values: list[float]) -> list[float]:
    ordered = sorted(set(values))
    return [(a + b) / 2 for a, b in zip(ordered, ordered[1:])]


def _drop_thresholds_that_share_a_score(thresholds: list[float], shape: BreakpointLinearShape) -> list[float]:
    """地図に出す段は、評価が区別できる差より細かくしない。

    区別できない差に境界を引くと、色は変わるのに評価は同じという見分けを地図が見せ、
    得点で塗るルート線と段の数が食い違う。折れ線の最も低い得点も、最初の境界の手前の段として
    数える——その得点へ写る境界の下には、得点で入る道が無い（凡例に「0点未満」のような届かない段が出る）。
    """
    kept: list[float] = []
    last_score = min(shape.score_at(x) for x, _ in shape.breakpoints)
    for threshold in thresholds:
        score = shape.score_at(threshold)
        if score <= last_score:
            continue
        last_score = score
        kept.append(threshold)
    return kept


def _boolean_terms_thresholds(weights: list[float], cap: float) -> list[float]:
    """真偽値の項は該当時weight・非該当時0の2値しか取らないため、軸が取りうる合計値は
    部分和に限られる。連続値と違って中間の値が現れないので、境界はその実現値の間に引く。
    """
    sums: set[float] = {0.0}
    for r in range(1, len(weights) + 1):
        for combo in combinations(weights, r):
            sums.add(min(sum(combo), cap))
    return _adjacent_midpoint_thresholds(list(sums))


def _difficulty_thresholds(definition: AxisDefinition) -> tuple[list[float], list[float] | None]:
    """難易度を塗る軸の段の境界（得点）と、凡例が量で書けるならその量の境界。

    上書き（`display_thresholds_override`）は得点の目盛りなのでそのまま使う。無ければ軸の形から導き、
    導けなければ既定の境界。
    """
    override = definition.display_thresholds_override
    if override is not None:
        return list(override), _quantities_of_scores(definition, list(override))
    shape = definition.shape
    if definition.priority_overrides:
        # 条件の当たる道は形と別の得点を取るため、形から段を導かない。
        return list(DEFAULT_DIFFICULTY_BOUNDARIES), None
    if isinstance(shape, CategoricalShape):
        scores = _adjacent_midpoint_thresholds(list(shape.mapping.values()))
        return scores or list(DEFAULT_DIFFICULTY_BOUNDARIES), None
    quantities = _breakpoint_quantities(shape)
    if not quantities:
        return list(DEFAULT_DIFFICULTY_BOUNDARIES), None
    return shape.scores_at(quantities), _legend_quantities(definition, quantities)


def _breakpoint_quantities(shape: BreakpointLinearShape) -> list[float]:
    """折れ線の軸の段の境界を、折れ線を通す前の量で導く。

    符号を畳む折れ線は、量の境界が負の側へ折り返るため導かない（空を返す）。
    """
    if shape.preprocess != "identity":
        return []
    specs = [material_spec(term.material) for term in shape.terms]
    if all(spec is not None and spec.dtype == "boolean" for spec in specs):
        if len(shape.terms) > _MAX_BOOLEAN_TERMS:
            return []
        quantities = _boolean_terms_thresholds([term.weight for term in shape.terms], shape.breakpoints[-1][0])
    else:
        quantities = [x for x, _ in shape.breakpoints[1:]]
    return _drop_thresholds_that_share_a_score(quantities, shape)


def _increasing_line(definition: AxisDefinition) -> BreakpointLinearShape | None:
    """段を得点を作る前の量で書ける軸の折れ線。書けなければNone。

    書けるのは、得点が単位のある量（`raw_value_unit`）から作られ、その量について狭く増えるときだけ。
    そのときに限り「得点 f(a)以上 f(b)未満」の道と「量 a以上 b未満」の道が一致する——平らな区間や
    下りのある折れ線では、量で書いた段が実際と違う道を指す。
    """
    shape = definition.shape
    if (
        raw_value_unit(definition) is None
        or definition.priority_overrides
        or not isinstance(shape, BreakpointLinearShape)
        or shape.preprocess != "identity"
    ):
        return None
    knots = shape.breakpoints
    if any(lower[1] >= upper[1] for lower, upper in zip(knots, knots[1:])):
        return None
    return shape


def _legend_quantities(definition: AxisDefinition, quantities: list[float]) -> list[float] | None:
    """形から導いた量の境界を、凡例が量で書けるならそのまま返す。境界は折れ線の下端より上・上端以下に
    限る——その外では得点が端に張り付き、量の段と得点の段が一致しない。"""
    line = _increasing_line(definition)
    if line is None:
        return None
    low, high = line.breakpoints[0][0], line.breakpoints[-1][0]
    if not all(low < quantity <= high for quantity in quantities):
        return None
    return quantities


def _quantities_of_scores(definition: AxisDefinition, scores: list[float]) -> list[float] | None:
    """得点で刻んだ段の境界を、得点を作る前の量で書けるならその量。書けなければNone。

    量は、評価と同じ丸めでその得点になる値のうち、桁の最も少ないもの——丸めた得点から折れ線を
    逆に辿った値は端数を持ち（73.1点が7.002回/km）、凡例にそのまま書くと読めない。
    """
    line = _increasing_line(definition)
    if line is None:
        return None
    knots = line.breakpoints
    quantities = []
    for score in scores:
        if not knots[0][1] < score <= knots[-1][1]:
            return None
        x0, y0, x1, y1 = next(
            (x0, y0, x1, y1) for (x0, y0), (x1, y1) in zip(knots, knots[1:]) if y0 < score <= y1
        )
        exact = x0 + (score - y0) * (x1 - x0) / (y1 - y0)
        quantity = next(
            (
                rounded
                for digits in range(_MAX_QUANTITY_DECIMALS + 1)
                if line.score_at(rounded := round(exact, digits)) == score
            ),
            None,
        )
        if quantity is None:
            return None
        quantities.append(quantity)
    return quantities
