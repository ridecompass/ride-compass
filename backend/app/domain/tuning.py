"""ルーティング評価が読む固定値の宣言。

探索のコストモデルの値は実走してみないと決まらないため、デプロイ無しで変えられるように
する。**どの値が較正値かはここが唯一の正本**で、`TUNING_PARAMETERS`が単位を持ち、エンジンが読む値の
id・管理画面が並べる項目・変更が効くために何をやり直す必要があるかを、すべてそこから導く。**値はここに持たない**——
値の正本はDBの表（`infrastructure/tuning_overrides.py`）で、起動時に全部を読む。変えられるようにする対象と管理画面が面倒を見る対象を
別々に決めると必ずズレるため、宣言を1つにする。

**載せてよいのは、走ってみて決める物理の較正値と、標準の人の好みの定義（代償の交換比・避ける・好むの倍率）だけ**。
定義は物理の外で、正解が測りで決まらないので、出典の無い定義だと説明に書く。物理定数・資源の上限・外部データの刻みは載せず、
使う側のモジュールが値と根拠を隣り合わせで持つ——ここへ載せた瞬間に管理画面から変えられる
ようになり、模型を壊す値や本番を止める値が画面の手に入る。

宣言そのものの矛盾（idの重複・空の見出し）はimport時に落ちる。黙って通すと、後勝ちで消えた1件は画面にも探索にも
現れない。
"""

import math
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType

from app.domain.stop_events import (
    STOP_EVENT_KINDS,
    EventGroup,
    StopEventKind,
    event_seconds_parameter_id,
    event_share_parameter_id,
)


class TuningEffect(Enum):
    """値を変えたとき、効くまでに何が要るか。

    **「変えたのに効かない」を宣言として持つ**。変更の反映に別の操作が要る値が混ざっている
    のに画面が同じ見た目だと、効いていないことに気づけない。

    **利用者へ見せる言い方（`title`）もここが持つ**。画面側に対応表を置くと、効き方を
    1つ足したときに画面がそれを知らず、名前の無いまとまり（「その他」）へ落とす——
    値は出るが「何をすれば効くのか」だけが失われる、という形で壊れる。メンバーは値と
    見出しの2つを必ず書くので、書き忘れはこのクラスの定義時に落ちる。

    宣言の順がそのまま画面の並び順になる（`tuning_parameters_by_effect`）。
    """

    def __new__(cls, value: str, title: str) -> "TuningEffect":
        if not title:
            raise ValueError(f"効き方の見出しが空: {value}")
        member = object.__new__(cls)
        member._value_ = value
        member.title = title
        return member

    #: 利用者へ見せる、効くまでに何が要るかの言い方。
    title: str

    #: 次のリクエストから効く（リクエストごとのコスト合成が読む）。
    IMMEDIATE = ("immediate", "次のルート生成から反映")
    #: 派生の作り直し（`batch/derive_cli.py`）をやり直さないと効かない。派生バッチは作り直しを始めるときに値を読み、
    #: 段の較正値はそれを読む段を選んで作り直すと効き、道路網の配列の較正値は配列を作り直すと効く。派生の外で同じ値を読む所は、
    #: 作り直しに使った値（`infrastructure/derived_data_meta.py: DerivedTuningRow`）を読む。
    DERIVE_REBUILD = ("derive_rebuild", "派生データを作り直すまで反映されない")
    #: 画面を読み込み直すと効く（フロントが起動時のカタログ取得で受け取る値）。
    CLIENT_RELOAD = ("client_reload", "画面を再読み込みすると反映")


@dataclass(frozen=True)
class TuningParameter:
    """較正値1つぶんの宣言（**この宣言に載っている＝管理画面から変えられる**）。"""

    id: str
    #: 管理画面の表示名。値を使う側の宣言が対象を持つもの（路面の見込みの転がり抵抗・停止要因の待ち）は、
    #: 対象の名前は`domain/tuning_labels.py: tuning_label`がそこから添える——ここはその宣言を読めない（循環する）ため、
    #: 対象の名前を写すと、対象の名前を変えたときに古くなる。
    label: str
    #: 単位（管理画面が値の右に出す）。無次元の比率等は空。
    unit: str
    effect: TuningEffect
    #: 何を決める値か。管理画面のⓘへ出す。
    description: str
    #: 利用者の画面の説明文に値を出すか。出すものは効き方によらずカタログ取得でフロントへ配る
    #: （`_sent_to_client`）——文に数を直書きすると、管理画面で変えたときに文が嘘になる。
    shown_to_users: bool = False

    def __post_init__(self) -> None:
        if not self.id or not self.label or not self.description:
            raise ValueError(f"較正値の宣言に空の項目がある: {self.id!r}")


def _event_parameters(kind: StopEventKind) -> tuple[TuningParameter, TuningParameter]:
    """止まる出来事1種類ぶんの宣言（止まる割合と、止まった・減速したときの待ち）。所要時間は割合 × 待ち、漕ぎ出しの体力は
    割合ぶん数える（`domain/traffic.py: StopEvent`）。停止要因の名前は、名前へ添える対象（`domain/tuning_labels.py`）で示す。"""
    share_label, seconds_label = (("止まる割合", "止まったときの待ち") if kind.group == "stop"
                                  else (f"{kind.label}の割合", kind.label))
    return (
        TuningParameter(
            event_share_parameter_id(kind.group, kind.name), share_label, "", TuningEffect.IMMEDIATE,
            "通るたびに止まる（減速する）割合。所要時間と漕ぎ出しの体力に同じ割合を使う。",
        ),
        TuningParameter(event_seconds_parameter_id(kind.group, kind.name), seconds_label, "秒", TuningEffect.IMMEDIATE,
                        kind.description),
    )


def _event_group_parameters(group: EventGroup) -> tuple[TuningParameter, ...]:
    return tuple(p for kind in STOP_EVENT_KINDS if kind.group == group for p in _event_parameters(kind))


#: 基準の転がり抵抗の較正値のid。
BASE_CRR_ID = "speed.crr"
_CRR_GRAVEL_ID = "speed.crr_gravel"
_CRR_COBBLESTONE_ID = "speed.crr_cobblestone"
#: 走行モデルの較正値のうち、値に実測の出典が無いものの説明の末尾。
_UNSOURCED = "値は根拠なし（出典のある実測が無い）。"
#: 標準の人の好みの定義（物理の較正値ではないもの）の説明の末尾。
_PREFERENCE_DEFINITION = "物理の較正値ではなく、標準の人の好みの定義（出典は無い）。"
RIDER_HEIGHT_ID = "wind.rider_height_m"
ROUGHNESS_CAP_ID = "wind.roughness_cap_m"
SNAP_CORRECTION_ID = "search.max_snap_correction_km"
LENS_SCALE_STEPS_ID = "lens.scale_steps"
_TURNAROUND_OVERLAP_ID = "search.turnaround_max_overlap_ratio"
_TURNAROUND_RELAXED_OVERLAP_ID = "search.turnaround_relaxed_overlap_ratio"
_LOOP_RATIO_MIN_ID = "search.loop_to_outbound_ratio_min"
_LOOP_RATIO_MAX_ID = "search.loop_to_outbound_ratio_max"
_DISTANCE_TOLERANCE_ID = "search.distance_tolerance_ratio"
#: 派生の段だけが読む較正値のid。
SIGNAL_MATCH_RADIUS_ID = "signal.match_radius_m"
#: 派生の外（地図の点のタイル・近くの点の読み出し）も作り直しに使った値を読む較正値のid。
STOP_CLUSTER_DISTANCE_ID = "stop.cluster_distance_m"
#: 道路網の配列を作る読み出しが、作り直しに使った値を読む較正値のid。
TURN_BEARING_DISTANCE_ID = "turn.bearing_distance_m"
#: 土地被覆を数える帯の外・内の幅のid。外の幅は地図の説明の文にも出る。
LANDCOVER_RING_OUTER_ID = "landcover.ring_outer_m"
LANDCOVER_RING_INNER_ID = "landcover.ring_inner_m"
#: 交通規制を区間へ当てる幅と割合と向きの差のid。区間の値の説明の文にも出る。
REGULATION_LINE_HALF_WIDTH_ID = "traffic_regulation.line_half_width_m"
REGULATION_EDGE_SHARE_ID = "traffic_regulation.edge_share"
REGULATION_MAX_ANGLE_ID = "traffic_regulation.max_angle_deg"
#: 区間の標高を拾う間隔の上限のid。
ELEVATION_PROFILE_STEP_ID = "elevation.profile_step_m"
#: 拾った標高の揺れを消す閾値のid。
ELEVATION_PROFILE_TOLERANCE_ID = "elevation.profile_tolerance_m"


TUNING_PARAMETERS: tuple[TuningParameter, ...] = (
    # --- 曲がる所の出来事（方位差で決まる。種類は`domain/stop_events.py: STOP_EVENT_KINDS`が正本） ---
    *_event_group_parameters("turn"),
    TuningParameter(
        "turn.straight_max_deg",
        "直進とみなす方位差", "度", TuningEffect.IMMEDIATE,
        "この角度までの曲がりは直進とみなし、費用を足さない。",
    ),
    # --- 停止要因（種類は`domain/stop_events.py: STOP_EVENT_KINDS`が正本） ---
    *_event_group_parameters("stop"),
    TuningParameter(
        "stop.slowed_speed_ratio", "減速の出来事で残る速さの割合", "", TuningEffect.IMMEDIATE,
        "止まらず減速する出来事（左折・車止め等）で、巡航速度のうち残る速さの割合。漕ぎ出しの体力は、止まる出来事の"
        "（1 − 割合²）倍になる。",
    ),
    # --- 交差点と停止の点 ---
    TuningParameter(
        SIGNAL_MATCH_RADIUS_ID,
        "信号とみなす半径", "m", TuningEffect.DERIVE_REBUILD,
        "交差点から何m以内の信号を、その交差点のものとみなすか。"
        "広げるほど横断の費用が付く交差点が減る（頭打ちが無い）。",
    ),
    TuningParameter(
        STOP_CLUSTER_DISTANCE_ID,
        "停止の点をまとめる距離", "m", TuningEffect.DERIVE_REBUILD,
        "同じ場所にある同種の停止要因の点を、1回の停止としてまとめる距離。日本のOSMは1つの信号交差点を流入路ごとの"
        "信号と横断歩道の位置の複数の点で描くため、点をそのまま数えると停止回数を上回る。停止回数・地図の停止の点・"
        "ルートの印が同じ値でまとめる。",
    ),
    TuningParameter(
        TURN_BEARING_DISTANCE_ID,
        "曲がりの向きを測る長さ", "m", TuningEffect.DERIVE_REBUILD,
        "交差点での曲がり（直進・左・右）を、区間の端からこの道のりの点までの向きで測る。区間がこれより短ければ端から端を見る。",
    ),
    # --- 標高 ---
    TuningParameter(
        ELEVATION_PROFILE_STEP_ID,
        "標高を拾う間隔", "m", TuningEffect.DERIVE_REBUILD,
        "区間をこの道のり以下の等しい間隔に分けた点で標高を引く。標高データの格子より広げると、格子が持つ短い起伏を拾わない。"
        "狭めるほど作り直しの時間が延びる。",
    ),
    TuningParameter(
        ELEVATION_PROFILE_TOLERANCE_ID,
        "標高の揺れを消す閾値", "m", TuningEffect.DERIVE_REBUILD,
        "拾った標高のうち、この高さ以下の上下を揺れとして消し、残した点の間で獲得標高と勾配を出す。高さがこの数倍に満たない"
        "短い段は、なだらかに残ることがある。広げるほど短い起伏も消え、狭めるほど標高データの誤差による上下も登りとして数える。",
    ),
    # --- 土地被覆 ---
    TuningParameter(
        LANDCOVER_RING_OUTER_ID,
        "土地被覆を数える帯の外の幅", "m", TuningEffect.DERIVE_REBUILD,
        "道の中心線からこの距離までの帯に重なる土地被覆の画素を数え、道の周りの土地被覆の割合にする。広げるほど道から"
        "離れた土地が混ざり、狭めるほど帯1本の画素が減って割合が粗くなる。",
        shown_to_users=True,
    ),
    TuningParameter(
        LANDCOVER_RING_INNER_ID,
        "土地被覆を数える帯の内の幅", "m", TuningEffect.DERIVE_REBUILD,
        "道の中心線からこの距離までは、路面そのものとして土地被覆の帯から除く。外の幅以下でなければならない。",
    ),
    # --- 交通規制 ---
    TuningParameter(
        REGULATION_LINE_HALF_WIDTH_ID,
        "線の交通規制を区間へ当てる帯の半幅", "m", TuningEffect.DERIVE_REBUILD,
        "線で配られる交通規制（歩行者用道路等）の線から両側へこの距離までの帯を規制の場所とし、帯に入る区間へ規制を当てる。"
        "広げるほど並行する別の道にも当たり、狭めるほど規制の線と地図の道のずれで当たり漏れる。",
    ),
    TuningParameter(
        REGULATION_EDGE_SHARE_ID,
        "交通規制を区間へ当てる長さの割合", "", TuningEffect.DERIVE_REBUILD,
        "区間の長さのうち、この割合以上が規制の場所（線の帯か面）の中にある区間へ規制を当てる。0より大きく1以下。下げるほど"
        "規制の場所を横切るだけの区間にも当たり、上げるほど規制の端に掛かる区間が漏れる。",
    ),
    TuningParameter(
        REGULATION_MAX_ANGLE_ID,
        "線の交通規制を区間へ当てる向きの差の上限", "度", TuningEffect.DERIVE_REBUILD,
        "線の規制は、区間の始点から終点への向きと、区間の中点に一番近い所の規制の線の向きの差（向きを問わず0〜90度）が"
        "この角度以下の区間にだけ当てる。広げるほど規制の線を交差点で横切る短い区間にも当たり、狭めるほど規制の線と"
        "地図の道の向きのずれで当たり漏れる。",
    ),
    # --- 走行モデル ---
    TuningParameter(
        RIDER_HEIGHT_ID, "乗り手の高さ", "m", TuningEffect.IMMEDIATE,
        "予報の地上の風を、この高さの風へ直して走行の模型に使う。踏み増しの向かい風の効きの元の実測の風（自転車に付けた風速計）の"
        "高さに揃える。" + _UNSOURCED,
    ),
    TuningParameter(
        ROUGHNESS_CAP_ID, "粗度長の頭打ち", "m", TuningEffect.IMMEDIATE,
        "風を乗り手の高さへ直すときの、土地被覆の粗度長の上限（格子の側・道の側の両方に掛ける）。下げるほど、市街の風が弱まりにくい。"
        + _UNSOURCED,
    ),
    TuningParameter(
        "speed.cda_m2",
        "空気抵抗 CdA", "m²", TuningEffect.IMMEDIATE,
        "走る姿勢の空気抵抗の係数と前面投影面積の積。" + _UNSOURCED,
    ),
    TuningParameter(
        BASE_CRR_ID,
        "転がり抵抗", "", TuningEffect.IMMEDIATE,
        "基準の路面（舗装）の転がり抵抗の係数。区分の外の道もこの値で走る。" + _UNSOURCED,
    ),
    # 路面の区分ごとの転がり抵抗。どの区分がどの値を使うかは管理DBの道の区分の転がり抵抗の表が持つ。
    TuningParameter(
        "speed.crr_paving_stones",
        "転がり抵抗", "", TuningEffect.IMMEDIATE,
        "切石・レンガの敷石の路面の転がり抵抗の係数。" + _UNSOURCED,
    ),
    TuningParameter(
        "speed.crr_compacted",
        "転がり抵抗", "", TuningEffect.IMMEDIATE,
        "締め固めた路面の転がり抵抗の係数。" + _UNSOURCED,
    ),
    TuningParameter(
        _CRR_GRAVEL_ID,
        "転がり抵抗", "", TuningEffect.IMMEDIATE,
        "砂利の路面の転がり抵抗の係数。" + _UNSOURCED,
    ),
    TuningParameter(
        "speed.crr_soil",
        "転がり抵抗", "", TuningEffect.IMMEDIATE,
        "土・草・砂の路面の転がり抵抗の係数。" + _UNSOURCED,
    ),
    TuningParameter(
        _CRR_COBBLESTONE_ID,
        "転がり抵抗", "", TuningEffect.IMMEDIATE,
        "石畳（玉石）の路面の転がり抵抗の係数。" + _UNSOURCED,
    ),
    TuningParameter(
        "speed.crr_unknown",
        "転がり抵抗", "", TuningEffect.IMMEDIATE,
        "舗装か未舗装かが分からない路面の転がり抵抗の係数。" + _UNSOURCED,
    ),
    TuningParameter(
        "speed.mass_kg",
        "総質量", "kg", TuningEffect.IMMEDIATE,
        "体重＋車体＋装備。" + _UNSOURCED,
    ),
    TuningParameter(
        "speed.max_descent_kmh",
        "下りの速度上限", "km/h", TuningEffect.IMMEDIATE,
        "上限が無いと、急な下りで計算上の速度が際限なく上がる。巡航速度がこれより速い人は、巡航速度を上限にする。" + _UNSOURCED,
        shown_to_users=True,
    ),
    TuningParameter(
        "speed.walking_kmh",
        "押して歩く速度", "km/h", TuningEffect.IMMEDIATE,
        "登りでこれ以下になったら押して歩くとみなす。" + _UNSOURCED,
    ),
    TuningParameter(
        "cost.effort_alpha",
        "体力の換算", "倍", TuningEffect.IMMEDIATE,
        "平地の出力を超えて使った体力を、平地を何秒走る分に当たるかに換算し、その秒に掛ける倍率（費用の式のα）。"
        "標準の人が、体力の1秒分を何秒の所要時間と引き換えにするかの交換比。体力の負担のすべての種類に共通。"
        + _PREFERENCE_DEFINITION,
    ),
    TuningParameter(
        "cost.burden_seconds_per_km",
        "道のストレスの換算", "秒/km", TuningEffect.IMMEDIATE,
        "道のストレスの基準の重さ（1）の道を1km走ることを、何秒の負担とみなすか（費用の式のβ）。標準の人が、その1kmを何秒の"
        "所要時間と引き換えにするかの交換比。道のストレスのすべての種類に共通。" + _PREFERENCE_DEFINITION,
    ),
    TuningParameter(
        "cost.effort_weight_exponent",
        "体力の重みの指数", "", TuningEffect.IMMEDIATE,
        "踏みたい出力（上限で切る前）と平地の出力の比を何乗して体力の重みにするか。0で重みを掛けない。上げるほど、上限を"
        "越えて踏みたい急な坂・強い向かい風を重く数える。",
    ),
    TuningParameter(
        "speed.extra_power_per_force",
        "抵抗1Nあたりの出力の増加", "W/N", TuningEffect.IMMEDIATE,
        "平地・無風・基準の路面より抵抗（坂の重力・向かい風の空気抵抗・路面の転がり抵抗の増えた分の和）が1N増えるごとに、"
        "何W余分に踏むか。抵抗の種類によらず同じ決まりで踏み増す。巡航速度（m/s）より大きければ巡航速度で止める（巡航が遅い人が"
        "登りや向かい風で巡航より速くならない）。値の出典は坂での速さの実測（Flügel ら 2017・Belikhov ら 2025）で、支える値の幅と"
        "合わせ方は docs/modules/backend/routing-engine.md「較正値（走ってみて決める値）」。",
    ),
    TuningParameter(
        "speed.max_climb_power_ratio",
        "踏み増しの上限倍率", "倍", TuningEffect.IMMEDIATE,
        "平地の巡航に対して何倍まで踏むか。踏み増しをここで頭打ちにする。" + _UNSOURCED,
    ),
    # --- 道の避け方 ---
    TuningParameter(
        "avoidance.avoid_cost_multiplier",
        "「なるべく避ける」の割り増し", "倍", TuningEffect.IMMEDIATE,
        "道のレイヤの行を「なるべく避ける」にしたとき、その行に当たる区間の所要時間に掛けて探索の費用にする倍率（代償には"
        "掛けない）。2なら、代償が同じなら、その区間を通るより所要時間が倍までの回り道を選ぶ。1は避けない。「少し避ける」は"
        "その平方根。道路タブの段の名前は、掛ける倍率で出す。" + _PREFERENCE_DEFINITION,
    ),
    TuningParameter(
        "avoidance.prefer_cost_multiplier",
        "「好む」の割り引き", "倍", TuningEffect.IMMEDIATE,
        "道のレイヤの行を「好む」にしたとき、その行に当たる区間の所要時間に掛けて探索の費用にする倍率（代償には掛けない）。"
        "0.8なら好む道の1分を0.8分とみなし、代償が同じなら、好む道を通る時間がほかの道の1.25倍以内のとき好む道を選ぶ。"
        "0より大きく1以下。「少し好む」はその平方根。" + _PREFERENCE_DEFINITION,
    ),
    # --- 候補の選び方 ---
    TuningParameter(
        SNAP_CORRECTION_ID, "置いた点を道へ寄せてよい距離", "km", TuningEffect.IMMEDIATE,
        "置いた点から出て戻れる道の点までがこの距離を超えると、寄せずに断る。広げるほど、利用者が指した覚えのない場所を通りやすい。",
    ),
    TuningParameter(
        _TURNAROUND_OVERLAP_ID,
        "折返し点の往路の重なりの上限", "", TuningEffect.IMMEDIATE,
        "採用済みの折返し点と往路が、距離の割合でこれより重なる折返し点は飛ばす。同じ道筋の折返し点が上位を"
        "占め、往路の大半が同じ周回が並ぶのを防ぐ。距離なしの目的地の代替経路も、経路全体の重なりに同じ値を使う。",
    ),
    TuningParameter(
        _TURNAROUND_RELAXED_OVERLAP_ID,
        "折返し点の往路の重なりの緩めた上限", "", TuningEffect.IMMEDIATE,
        f"{_TURNAROUND_OVERLAP_ID}で候補の数が埋まらないとき、この上限まで緩めてやり直す。"
        f"{_TURNAROUND_OVERLAP_ID}以上にする。",
    ),
    TuningParameter(
        "search.min_turnaround_separation_km",
        "折返し点どうしの最小の間隔", "km", TuningEffect.IMMEDIATE,
        "採用済みの折返し点からこれより近い折返し点は飛ばす。近い折返し点は同じ周回の変種にしかならない。",
    ),
    TuningParameter(
        "search.loop_max_overlap_ratio",
        "周回どうしの重なりの上限", "", TuningEffect.IMMEDIATE,
        "帰りまで継いだ周回が、採用済みの周回と進む向きによらず距離の割合でこれより重なれば捨てる。"
        "同じ周回の逆回りや、往路は違うが帰りが同じ裏道へ収まる周回を除く。"
        f"往路だけを見る{_TURNAROUND_OVERLAP_ID}より緩い、最後の確かめ。",
    ),
    TuningParameter(
        _LOOP_RATIO_MIN_ID,
        "周回の全長の見込みの下限", "倍", TuningEffect.IMMEDIATE,
        "周回の全長が往路の何倍になるかの見込みの下限。帰りは往路を避けて探すが、往路は費用の最も低い道で最短とは限らないので、"
        "帰りは往路より短くもなりうる。"
        "全長が目標±許容に入るよう、折返し点を探す往路の長さの範囲をこの見込みで決める。"
        "置いた点を通る・目的地で終わるときの帰りは、終点までの最短のこの値−1倍以上（最短を下回らない）と見込む。",
    ),
    TuningParameter(
        _LOOP_RATIO_MAX_ID,
        "周回の全長の見込みの上限", "倍", TuningEffect.IMMEDIATE,
        f"{_LOOP_RATIO_MIN_ID}の上限側。{_LOOP_RATIO_MIN_ID}以上にする。",
    ),
    TuningParameter(
        "search.alternative_max_cost_stretch",
        "目的地への代わりの道の費用の上限", "倍", TuningEffect.IMMEDIATE,
        "距離なしで目的地へ向かうとき、合成の費用が最も低い道の費用の何倍までの道を代わりの道の候補にするか（伸び率は長さでなく"
        "費用で測る。Abraham ら 2010 は伸び率の上限を1.25に置く）。"
        "上げるほど費用の高い候補が並ぶ。",
    ),
    TuningParameter(
        "search.pareto_distance_quantum_m",
        "候補の距離を同じとみなす粒度", "m", TuningEffect.IMMEDIATE,
        "候補（折返し点・目的地への道の経由のNode）を並べるとき、距離の鍵がこの刻みの中で違うだけなら同じ距離とみなす。細かすぎると"
        "互いに劣らない候補が全件残って間引けず、粗すぎると候補が減りすぎる。",
    ),
    TuningParameter(
        "search.turnaround_radius_ratio",
        "距離ありの探索範囲の半径の比", "倍", TuningEffect.IMMEDIATE,
        "距離ありで道路網を切り出す範囲の半径を、自由に選ぶ部分（目標から置いた点の間の長さを引いた残り）の"
        "何倍にするか。折返し点の往路は、自由に選ぶ部分の半分より短い。"
        "上げると範囲の面積が二乗で増え、生成の準備の時間とメモリが増える。足りなければ折返し点の候補が欠ける。",
    ),
    TuningParameter(
        _DISTANCE_TOLERANCE_ID,
        "全長の目標の許容の割合", "", TuningEffect.IMMEDIATE,
        "距離ありで、全長が目標からその目標のこの割合の長さの中に入る候補だけを返す（0.15なら30kmで±4.5km）。"
        "折返し点を探す往路の長さの範囲もこの幅から決める。",
        shown_to_users=True,
    ),
    TuningParameter(
        "search.retrace_penalty_multiplier",
        "往路の道を帰りに通るときの割り増し", "倍", TuningEffect.IMMEDIATE,
        "帰りを探す間、それまでに走った道（逆向きを含む）の探索の費用に、その道の所要時間にこの倍率から1を引いた数を掛けた"
        "秒を足す。好む・避けるの段に依らず、所要時間が同じ道は同じだけ割り増す。1は避けない。"
        "有限なので、走った道を戻るほかに道が無い所（袋小路等）は通れる。",
    ),
    # --- 地図の評価 ---
    # どちらも backend が費用の軸の一覧（`/api/cost-axes`）を組むときに読み、画面は値そのものを読まない（画面へ配らない）。
    # 地図に効くのは、画面が一覧を取り直した（読み込み直した）とき。
    TuningParameter(
        "gradient.perpendicular_band_deg",
        "勾配を示さない直角からの幅", "度", TuningEffect.IMMEDIATE,
        "走る向きに対して直角からこの角度以内の道は、どちら向きに辿るか決まらないため、その向きでの勾配を示さない"
        "（地図では勾配の段で塗らない）。広げるほど勾配を示さない道が増える。",
    ),
    TuningParameter(
        LENS_SCALE_STEPS_ID, "色の物差しを刻む数", "段", TuningEffect.IMMEDIATE,
        "負担で塗る色を、緑の端から赤の端までこの数に刻む。",
    ),
    # --- 画面が使う値（カタログ取得でフロントへ配る） ---
    TuningParameter(
        "splice.min_stretch_km",
        "区間を割る下限", "km", TuningEffect.CLIENT_RELOAD,
        "区間の乗り換えで、これより短い断片は作らない。"
        "細かく割るほど選択肢が増え、1区間=1行の一覧が縦に伸びる。",
    ),
)


#: 宣言の逆引き。
TUNING_PARAMETERS_BY_ID: dict[str, TuningParameter] = {p.id: p for p in TUNING_PARAMETERS}

_DUPLICATE_IDS = sorted(
    param_id for param_id, count in Counter(p.id for p in TUNING_PARAMETERS).items() if count > 1
)
if _DUPLICATE_IDS:
    raise ValueError(f"較正値のidが重複している: {', '.join(_DUPLICATE_IDS)}")

#: いま効いている値（id → 値）。起動時にDBの表から宣言の全idを読み込み、管理APIで書いたときに**中身だけ**を
#: 差し替える（束縛済みの参照先が古いままにならないよう、`.update()`で更新する。`.clear()`は挟まない——理由は
#: `services/tuning_service.py: refresh_tuning_values`）。計算はここを読まず、入口が`current_tuning`で写した束を受ける。
TUNING_VALUES: dict[str, float] = {}


class TuningValueError(ValueError):
    """較正値の値では、それを使う計算が成り立たない（壊れた結果を出さずに止まる）。条件は値を使う計算の所が持ち、
    管理者が直せるよう較正値の見出し・id・値を名指す。"""


def require_tuning(values: Mapping[str, float], holds: bool, condition: str) -> None:
    """`holds`が偽か、`values`（較正値のid → 使う値）に有限でない値があれば、較正値と条件`condition`を名指して断る。"""
    if holds and all(math.isfinite(value) for value in values.values()):
        return
    named = "、".join(f"{TUNING_PARAMETERS_BY_ID[param_id].label}（{param_id}）= {value!r}" for param_id, value in values.items())
    raise TuningValueError(f"較正値 {named} では計算できません（{condition}であること）。管理画面で値を直してください")


@dataclass(frozen=True)
class Tuning:
    """較正値の束（id → 値）。計算はこれを値で受け、1回の計算の間に管理APIが書き換えても同じ値を読む。"""

    values: Mapping[str, float]

    def value(self, param_id: str) -> float:
        return self.values[param_id]

    def checked(self, param_id: str, holds: Callable[[float], bool], condition: str) -> float:
        """較正値。`holds`を満たさなければ`require_tuning`で断る。"""
        value = self.values[param_id]
        require_tuning({param_id: value}, holds(value), condition)
        return value


def current_tuning() -> Tuning:
    """いま効いている較正値の写し。入口（services・batch・道具）だけが呼ぶ。読み込む前に読むのは起動の順の誤りなので、止める。"""
    if not TUNING_VALUES:
        raise RuntimeError("較正値を読み込む前に読んだ（services/definitions_loading.py: refresh_definitions を先に通す）")
    return Tuning(MappingProxyType(dict(TUNING_VALUES)))


def tuning_parameters_by_effect() -> list[TuningParameter]:
    """較正値の宣言を効き方の順（`TuningEffect`の宣言順）に並べる。同じ効き方の中は宣言順のまま。"""
    effects = list(TuningEffect)
    return sorted(TUNING_PARAMETERS, key=lambda parameter: effects.index(parameter.effect))


def _sent_to_client(parameter: TuningParameter) -> bool:
    """フロントへ配る較正値か（効き方が`CLIENT_RELOAD`のものと、画面の説明文に値を出すもの）。
    配る対象を宣言から導く——配信側とフロント側で別々に並べると、1つ足したときに片方だけが古くなる。"""
    return parameter.effect is TuningEffect.CLIENT_RELOAD or parameter.shown_to_users


#: フロントへ配る較正値のうち、効き方が`DERIVE_REBUILD`のもの。画面の文が語る派生の値はまだ前の作り直しの値で
#: 作られているので、配る側はプロセスの今の値ではなく作り直しに使った値（派生の記録）を読んで配る。
REBUILT_CLIENT_TUNING_IDS: tuple[str, ...] = tuple(
    p.id for p in TUNING_PARAMETERS if _sent_to_client(p) and p.effect is TuningEffect.DERIVE_REBUILD
)


def client_tuning_values(tuning: Tuning) -> dict[str, float]:
    """フロントへ配る較正値のうち、`REBUILT_CLIENT_TUNING_IDS`を除くもの（id → `tuning`の値）。"""
    return {
        p.id: tuning.value(p.id)
        for p in TUNING_PARAMETERS
        if _sent_to_client(p) and p.id not in REBUILT_CLIENT_TUNING_IDS
    }


def client_tuning_ids() -> list[str]:
    """フロントへ配る較正値の全部のid。"""
    return [p.id for p in TUNING_PARAMETERS if _sent_to_client(p)]
