"""区間インスペクタ（地図上の道路クリックで出す「一次属性→二次軸スコア→合成」の内訳）。

軸の得点は、呼び出し側が地図の配信と同じ評価から求めて渡す。

合成スコアはここでサーバー側が計算する。タイルへ焼き込む値に課される「解釈は
クライアントに」の制約（全ユーザー共有のキャッシュへ個別の解釈を載せられない）は、
この経路には当てはまらない——クリックのたびに1回計算する参照用途で、共有キャッシュに
乗らないため。
"""


from app.domain.difficulty import composite_difficulty
from app.domain.landcover import LandcoverPercentages
from app.domain.route_preference import RoutePreference
from app.domain.strict_model import StrictModel


class AxisInspectorAxis(StrictModel):
    axis_id: str
    #: 材料が足りず評価できなければNone。
    difficulty: float | None
    # この軸が合成スコアへ持ち込んでいる量（`composite_difficulty`の重み付き寄与度）。
    contribution: float | None


class InspectorComposite(StrictModel):
    """取得できた軸だけの加重平均（`composite_difficulty`）と、それが公開軸全体の重み合計のうち何割の軸から
    出たか（0-1）。"""

    value: float
    covered_weight_fraction: float


class InspectorValues(StrictModel):
    """押したフィーチャー（その倍率で地図が塗る単位。区間か道1本）の軸ごとの得点と合成。"""

    axes: list[AxisInspectorAxis]
    #: 1つも取得できなければNone。
    composite_difficulty: InspectorComposite | None
    # 道路周囲リングの土地被覆の内訳。軸の材料に使うのは一部のクラスだけだが、
    # 「この道が何で覆われているか」は軸の点数からは読み取れないため全クラスを返す。
    # 行が無い・割合がNULL（そのラスタ構成では値なし）ならNone。
    landcover: LandcoverPercentages | None


class AxisInspectorResult(StrictModel):
    highway: str
    tags: dict[str, str]
    #: 押したフィーチャー（区間で塗る倍率なら区間、道1本で塗る倍率なら道1本）。値はその倍率で地図が塗る色と同じ。
    values: InspectorValues


def inspector_values(
    scores: dict[str, float | None],
    landcover: LandcoverPercentages | None,
    preference: RoutePreference,
) -> InspectorValues:
    """軸ごとの得点（評価できない軸はNone）を、重みで合成した内訳にする。

    重みは呼び出し側が渡す。ここで既定を組み立てると、呼び出し側が渡し忘れた重みが
    画面へ出たまま誰も気づかない。
    """
    weights = preference.weights
    composite, contributions = composite_difficulty(scores, weights)
    return InspectorValues(
        axes=[
            AxisInspectorAxis(axis_id=axis_id, difficulty=score, contribution=contributions[axis_id])
            for axis_id, score in scores.items()
        ],
        composite_difficulty=None if composite is None else _composite(composite, scores, weights),
        landcover=landcover,
    )


def _composite(value: float, scores: dict[str, float | None], weights: dict[str, float]) -> InspectorComposite:
    # 合成が求まるのは得点のある軸の重みの合計が正のときだけなので、全体の重みの合計も正。
    covered_weight = sum(weights.get(axis_id, 0.0) for axis_id, score in scores.items() if score is not None)
    return InspectorComposite(
        value=value, covered_weight_fraction=round(covered_weight / sum(weights.values()), 3)
    )
