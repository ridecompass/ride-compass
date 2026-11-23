"""止まる出来事（停止要因と曲がる所）の種類の宣言。

種類ごとに、置き場（停止要因＝区間の数で数える・曲がる所＝遷移で数える）・名前・止まるか減速するだけか・待ちの較正値の
説明と、曲がる所の待ちの表の鍵を、ここ1か所に持つ（止まる出来事の正本）。

曲がる所の時間は、2つの和で決める。
- 曲がりの減速の層: 曲がり方（左・右）だけで決まる、曲がるために速さを落とす分。
- 待ちの表: 制御（`CONTROLS`）× 立場（`STANDINGS`）× 動き（`MOVEMENTS`）の升ごとの、待つ分。升は3つの鍵の組み合わせから導き、
  基準の通り方（`REFERENCE_PASSAGES`）だけは升を持たない。
"""
from dataclasses import dataclass
from itertools import product
from typing import Literal

#: 置き場。`stop`は停止要因（区間に付く点の数 × 区間の長さで数える）、`turn`は曲がる所（遷移ごとに数える）。
EventGroup = Literal["stop", "turn"]


def event_seconds_parameter_id(group: EventGroup, name: str) -> str:
    """止まる出来事の、止まった（減速した）ときの待ちの較正値のid（綴りを組み立てる場所を1つにする）。"""
    return f"{group}.{name}_seconds"


def event_share_parameter_id(group: EventGroup, name: str) -> str:
    """止まる出来事の、止まる割合の較正値のid。"""
    return f"{group}.{name}_share"


@dataclass(frozen=True)
class StopEventKind:
    """止まる出来事の種類1つ。"""

    group: EventGroup
    #: 種類の名前（較正値のidの一部。停止要因は数える種別のキーで、区間の数の列`poi_<名前>`になる）。
    name: str
    #: 利用者・管理者へ見せる名前。
    label: str
    #: 止まらず減速するだけか（漕ぎ出しの体力を、止まる出来事の（1 − 残る速さの割合²）倍に数える）。
    slowing: bool
    #: 待ちの較正値の説明。
    description: str


@dataclass(frozen=True)
class Control:
    """待ちの表の制御1つ。"""

    label: str
    #: 升の値（基準より増える分）を、実走で測った通り方の全体から求めるときに引くもの。
    subtracted: str


_SIGNAL_ID = event_seconds_parameter_id("stop", "signal")
#: 待ちの表の鍵（キー → 中身）。制御: 交差点の待ちを決める仕組み。信号は、集まる道の最大の階級が県道クラス以上の信号の
#: 交差点（それ未満の信号の交差点は、待ちの表では信号なしとして引く。信号の基本の待ちは道の側が数える）。
CONTROLS: dict[str, Control] = {
    "signal": Control("信号", f"信号の基本の待ち（{_SIGNAL_ID}。道の側で数える）と曲がりの減速"),
    "unsignalized": Control("信号なし", "曲がりの減速"),
}
#: 立場: その動きで、入る道より上位の、待ちの要る階級の道を渡る・入るか。
STANDINGS: dict[str, str] = {"priority": "上位の道を渡らない", "yield": "上位の道を渡る・入る"}
#: 動き。キーは曲がる所の曲がり方（`domain/turn_structure.py: TurnKind`）の名前の小文字。
MOVEMENTS: dict[str, str] = {"straight": "直進", "left": "左折", "right": "右折"}
#: 升を持たない基準の通り方。信号の主の直進は、どう通っても掛かる分として道の側の信号（`stop.signal`）が数え、信号なしの
#: 主の直進は何も起きない通り方。
REFERENCE_PASSAGES: frozenset[tuple[str, str, str]] = frozenset({
    ("signal", "priority", "straight"), ("unsignalized", "priority", "straight")})

#: 待ちの表の升（制御, 立場, 動き）。宣言の順に並ぶ。
WAIT_PASSAGES: tuple[tuple[str, str, str], ...] = tuple(
    key for key in product(CONTROLS, STANDINGS, MOVEMENTS) if key not in REFERENCE_PASSAGES)


def wait_event_name(passage: tuple[str, str, str]) -> str:
    """待ちの表の升（制御, 立場, 動き）の出来事の名前（較正値のidの一部）。"""
    return "wait_" + "_".join(passage)


_SLOWING = "曲がるために速さを落として失う時間（止まらず減速する出来事）。信号の有無によらず、曲がった所で数える。"


def _wait_kind(passage: tuple[str, str, str]) -> StopEventKind:
    control, standing, movement = CONTROLS[passage[0]], STANDINGS[passage[1]], MOVEMENTS[passage[2]]
    return StopEventKind(
        "turn", wait_event_name(passage), f"{control.label}・{standing}・{movement}", False,
        f"{control.label}の交差点を{movement}で通り、{standing}ときの待ちのうち、{control.subtracted}に足す分。"
        f"実走で測ったこの通り方の全体から、{control.subtracted}を引いて求める（止まる割合も、全体から引いた増える分を入れる）。")


#: 止まる出来事の種類。曲がる所の並びは較正値の管理画面の並びになる。停止要因の並びは数える種別の並び
#: （材料・区間の数の列・地図の凡例）になる。
STOP_EVENT_KINDS: tuple[StopEventKind, ...] = (
    StopEventKind("turn", "slow_left", "左折の減速", True, _SLOWING),
    StopEventKind("turn", "slow_right", "右折の減速", True, _SLOWING),
    StopEventKind(
        "turn", "uturn", "Uターン", False,
        "折り返し1回の罰。実際に失う時間ではなく、行き止まりのほかで選ばせないための大きな値なので、予想の所要時間には入れず、"
        "探索の費用（所要時間だけで選ぶ経路の重みも）にだけ足す。"),
    *(_wait_kind(passage) for passage in WAIT_PASSAGES),
    StopEventKind(
        "stop", "signal", "信号", False,
        "信号のある交差点（と横断歩道の信号）を通るたびに、どう通っても失う時間（止まる前後の減速と加速を含む）。止まる割合は"
        "赤の割合。"),
    StopEventKind("stop", "crossing", "横断歩道(信号なし)", False, "歩行者に譲って止まったときの待ち。"),
    StopEventKind("stop", "stop", "一時停止・徐行", False, "標識・標示で止まる（減速する）時間。"),
    StopEventKind("stop", "level_crossing", "踏切", False,
                  "踏切の直前で止まって（道路交通法第33条）、遮断機が上がるまで待つ時間。"),
    StopEventKind("stop", "barrier", "車止め・減速構造", True, "ボラード等で減速して失う時間（止まらず減速する出来事）。"),
)

#: (置き場, 名前) → 種類。
STOP_EVENT_KIND_OF: dict[tuple[EventGroup, str], StopEventKind] = {(k.group, k.name): k for k in STOP_EVENT_KINDS}
if len(STOP_EVENT_KIND_OF) != len(STOP_EVENT_KINDS):
    raise ValueError("止まる出来事の種類が重複している")
