import math

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
# 方位次第で緩く見える。風（wind.py: wind_components）は風向が進行方向と独立に決まるため
# 角度差が実際に抗力を変えるが、勾配では道路の向きが進行方向そのもののため同じ扱いはできない。
#
# 走行方位が無い（ルートの前は、どの道もどちら向きに走るか決まらない）か、直角に近い範囲では符号が決まらない。そこは両向きの
# うちきつい向きの値にする——0%や両向きの平均にすると、実際には急な坂である道が平坦・緩い道と同じ色で塗られる。
# きつい向きなら「どちら向きに走ってもこれ以下」と読める。


#: 地図へ配る勾配（%）を丸める小数の桁。
GRADIENT_VALUE_DECIMALS = 1

#: 道ごとの材料の名前: 道の向き（度）。向きを持たない道（始点と終点が同じ）は値が無い。
ROAD_BEARING_LEAF = "road_bearing_deg"


def travel_direction_formula(forward: FormulaNode, backward: FormulaNode, perpendicular_band_deg: float) -> WayValueFormula:
    """走行方位（条件`bearing_deg`）で道を辿るとき、道の向き寄りなら`forward`、逆向き寄りなら`backward`になる値。走行方位が
    無い（値の無い条件）・道が向きを持たない・道の向きが走行方位に直角に近い（直角からの幅`perpendicular_band_deg`は較正値
    `gradient.perpendicular_band_deg`）道は、どちら向きに辿るか決まらないので、大きい方（辿れる向きが1つならその向き）になる。
    """
    diff = sub(feature(ROAD_BEARING_LEAF), condition("bearing_deg"))
    along_road = Binary(op="ge", left=Unary(op="cos", arg=mul(diff, const(math.pi / 180))), right=const(0.0))
    # 角度そのもので比べる（cosの大小で比べると、直角の左右で浮動小数の差だけ判定が食い違う）。180度で畳むのは、
    # 逆走（符号が反転するだけ）を同じ扱いにするため。剰余は割られる数の符号に従うので、負の余りは180を足して戻す。
    remainder = Binary(op="mod", left=diff, right=const(180.0))
    folded = case(Binary(op="lt", left=remainder, right=const(0.0)), add(remainder, const(180.0)), remainder)
    band_deg = const(perpendicular_band_deg)
    near_perpendicular = Binary(op="le", left=Unary(op="abs", arg=sub(folded, const(90.0))), right=band_deg)
    directed = all_of([Unary(op="not", arg=Unary(op="is_missing", arg=condition("bearing_deg"))),
                       Unary(op="not", arg=Unary(op="is_missing", arg=feature(ROAD_BEARING_LEAF))),
                       Unary(op="not", arg=near_perpendicular)])
    # 辿れない向き（値が無い）は選ばない。
    harder = case(Unary(op="is_missing", arg=forward), backward,
                  case(Unary(op="is_missing", arg=backward), forward,
                       case(Binary(op="ge", left=forward, right=backward), forward, backward)))
    return WayValueFormula(value=case(directed, case(along_road, forward, backward), harder))
