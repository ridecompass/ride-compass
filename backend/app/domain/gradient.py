import math

from app.domain.tuning import tuning_value
from app.domain.way_value_formula import (
    Binary,
    FormulaNode,
    Unary,
    WayValueFormula,
    add,
    all_of,
    case,
    condition,
    const,
    feature,
    mul,
    sub,
)

# gradient_percentは道路自身の始点→終点方向を基準にした符号付き値（登り=正、下り=負）。
#
# **走行方位が決めるのは符号だけで、坂の急さは変えない。** 道路は道路に沿ってしか走れず、
# 辿る以上は坂の急さをそのまま受けるためである。角度差を係数に掛ける（cos投影）と、同じ坂が
# 方位次第で緩く見える。風（wind.py: wind_drag_ratio）は風向が進行方向と独立に決まるため
# 角度差が実際に抗力を変えるが、勾配では道路の向きが進行方向そのもののため同じ扱いはできない。
#
# 直角に近い範囲は符号が決まらない（どちら向きにも辿れる）。そこは値を持たないものとして
# 扱う——0%として配ると、その道は地図の凡例で「平坦」の段へ入り、
# 実際には急な坂である道が平坦な道と同じ色で塗られる。言えるのは「この向きでの勾配は
# 示せない」であって「平坦だ」ではない。
#
# 同じ道路の逆方向のroad_edges行（forward/backward）を使っても値は変わらない——逆方向は
# road_bearing_deg±180度・gradient_percentの符号反転の両方が起きるため、符号が2回反転して
# 元に戻る。


#: 地図へ配る勾配（%）を丸める小数の桁。
GRADIENT_VALUE_DECIMALS = 1

#: 道ごとの材料の名前: 道の向き（度）。向きを持たない道（始点と終点が同じ）は値が無い。
ROAD_BEARING_LEAF = "road_bearing_deg"


def travel_direction_formula(forward: FormulaNode, backward: FormulaNode) -> WayValueFormula:
    """要求の走行方位で道を辿るとき、道の向き寄りなら`forward`、逆向き寄りなら`backward`になる値。道の向きが走行方位に
    直角に近い道（直角からの幅は較正値`gradient.perpendicular_band_deg`で、呼ばれた時点で読む）は、どちらとも決まらない
    （`undetermined`）。向きを持たない道は`backward`になる。

    示せるかの判定と値の算出を1つの木に持つ——別々の口にすると、判定を読まない呼び出し側が符号の決まらない値を
    受け取れてしまう。
    """
    diff = sub(feature(ROAD_BEARING_LEAF), condition("bearing_deg"))
    along_road = Binary(op="ge", left=Unary(op="cos", arg=mul(diff, const(math.pi / 180))), right=const(0.0))
    # 角度そのもので比べる（cosの大小で比べると、直角の左右で浮動小数の差だけ判定が食い違う）。180度で畳むのは、
    # 逆走（符号が反転するだけ）を同じ扱いにするため。剰余は割られる数の符号に従うので、負の余りは180を足して戻す。
    remainder = Binary(op="mod", left=diff, right=const(180.0))
    folded = case(Binary(op="lt", left=remainder, right=const(0.0)), add(remainder, const(180.0)), remainder)
    band_deg = const(tuning_value("gradient.perpendicular_band_deg"))
    near_perpendicular = Binary(op="le", left=Unary(op="abs", arg=sub(folded, const(90.0))), right=band_deg)
    has_bearing = Unary(op="not", arg=Unary(op="is_missing", arg=feature(ROAD_BEARING_LEAF)))
    return WayValueFormula(
        value=case(along_road, forward, backward),
        undetermined=all_of([has_bearing, near_perpendicular]),
    )


def gradient_by_direction(gradient_percent: FormulaNode) -> tuple[FormulaNode, FormulaNode]:
    """道路自身の勾配（`gradient_percent`）を、道の向き寄り・逆向き寄りに辿ったときの勾配（%）。符号だけが入れ替わる。
    要求の走行方位でどちらを選ぶかは`travel_direction_formula`が決める。"""
    return gradient_percent, Unary(op="neg", arg=gradient_percent)
