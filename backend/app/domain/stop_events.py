"""止まる出来事（停止要因と曲がる所）の種類の宣言。

種類ごとに、置き場（停止要因＝区間の数で数える・曲がる所＝遷移で数える）・名前・止まるか減速するだけか・待ちの較正値の
説明を、ここ1か所に持つ。種類を足す・消すのは、ここの並びを変えることだけ。
"""
from dataclasses import dataclass
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


_SIGNAL_ID = event_seconds_parameter_id("stop", "signal")
_STOP_ID = event_seconds_parameter_id("stop", "stop")
_RIGHT_ID = event_seconds_parameter_id("turn", "right")
_MAJOR_CROSSING_ID = event_seconds_parameter_id("turn", "major_crossing")
_SIGNAL_RIGHT_ID = event_seconds_parameter_id("turn", "signal_right")
_WHOLE_PASSAGE = (f"この通り方の全体の割合と待ちを入れ、信号の基本の待ち（{_SIGNAL_ID}。区間の信号の数で数える）との差を"
                  "曲がる所で足す。全体の割合か割合 × 待ちが基本より小さい値は計算できない。")

#: 止まる出来事の種類。曲がる所の並びは較正値の管理画面の並びになる。停止要因の並びは数える種別の並び
#: （材料・区間の数の列・地図の凡例）になる。
STOP_EVENT_KINDS: tuple[StopEventKind, ...] = (
    StopEventKind("turn", "left", "左折", True, "左折で減速して失う時間（止まらず減速する出来事）。"),
    StopEventKind(
        "turn", "right", "右折", False,
        f"右折して失う時間。集まる道の最大の階級が県道クラス以上の信号のある交差点の右折は二段階右折（{_SIGNAL_RIGHT_ID}）で数え、"
        "これを足さない。"),
    StopEventKind(
        "turn", "uturn", "Uターン", False,
        "折り返し1回の罰。実際に失う時間ではなく、行き止まりのほかで選ばせないための大きな値なので、予想の所要時間には入れず、"
        "探索の費用（所要時間だけで選ぶ経路の重みも）にだけ足す。"),
    StopEventKind(
        "turn", "major_crossing", "上位の道の横断", False,
        f"信号の無い交差点で、上位の階級の道を直進で渡るときに足す。一時停止で止まる時間（{_STOP_ID}）とは別に、相手の流れが"
        "途切れるのを待つ時間を表す。"),
    StopEventKind("turn", "major_turn", "上位の道への右左折", False,
                  "信号の無い交差点で、上位の階級の道へ右左折で入るときに、曲がる待ちに足す。"),
    StopEventKind(
        "turn", "signal_right", "信号での右折", False,
        "信号のある交差点（集まる道の最大の階級が県道クラス以上）で右折するとき。自転車は交差点の側端に沿って曲がる"
        f"（道路交通法第34条第3項。二段階右折）ので、交差方向の青を待つ。右折の待ち（{_RIGHT_ID}）の代わりに数える。"
        + _WHOLE_PASSAGE + "下の階級の道から上下線の分かれた上位の道へ右折するときは、上位の道の横断"
        f"（{event_seconds_parameter_id('turn', 'minor_signal')}）の全体との差を足すので、その全体以上の値にする。"),
    StopEventKind(
        "turn", "minor_signal", "信号での上位の道の横断", False,
        "信号のある交差点を、交差点の上位の道より下の階級の道から直進で渡るとき。下の道の側の青は短い。" + _WHOLE_PASSAGE),
    StopEventKind(
        "stop", "signal", "信号", False,
        "信号のある交差点（と横断歩道の信号）を通るたびに、どう通っても失う時間（止まる前後の減速と加速を含む）。止まる割合は"
        f"赤の割合。信号のある交差点では{_MAJOR_CROSSING_ID}を足さない。"),
    StopEventKind("stop", "crossing", "横断歩道(信号なし)", False, "歩行者に譲って止まったときの待ち。"),
    StopEventKind(
        "stop", "stop", "一時停止・徐行", False,
        f"標識・標示で止まる時間。相手の流れが途切れるのを待つ時間は含まず、上位の道を渡るときだけ{_MAJOR_CROSSING_ID}で足す。"),
    StopEventKind("stop", "level_crossing", "踏切", False,
                  "踏切の直前で止まって（道路交通法第33条）、遮断機が上がるまで待つ時間。"),
    StopEventKind("stop", "barrier", "車止め・減速構造", True, "ボラード等で減速して失う時間（止まらず減速する出来事）。"),
)

#: (置き場, 名前) → 種類。
STOP_EVENT_KIND_OF: dict[tuple[EventGroup, str], StopEventKind] = {(k.group, k.name): k for k in STOP_EVENT_KINDS}
if len(STOP_EVENT_KIND_OF) != len(STOP_EVENT_KINDS):
    raise ValueError("止まる出来事の種類が重複している")
