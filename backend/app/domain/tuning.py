"""ルーティング評価が読む固定値の宣言。

探索のコストモデルの値は実走してみないと決まらないため、デプロイ無しで変えられるように
する。**変えられる値（較正値）はここが唯一の正本**で、`TUNING_PARAMETERS`が既定・範囲・
単位を持ち、エンジンが読む値・管理画面が並べる項目・変更が効くために何をやり直す必要が
あるかを、すべてそこから導く。変えられるようにする対象と管理画面が面倒を見る対象を
別々に決めると必ずズレるため、宣言を1つにする。

**載せてよいのは走ってみて決める値だけ**。物理定数・資源の上限・外部データの刻みは載せず、
使う側のモジュールが値と根拠を隣り合わせで持つ——ここへ載せた瞬間に管理画面から変えられる
ようになり、模型を壊す値や本番を止める値が画面の手に入る。

宣言そのものの矛盾（idの重複・既定が範囲の外・既定が順の約束を破る・空の見出し）はimport時に落ちる。黙って
通すと、後勝ちで消えた1件は画面にも探索にも現れず、範囲外の既定は画面が出した値を
書き戻せない状態になる。
"""

import math
from collections import Counter
from dataclasses import dataclass
from enum import Enum


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
    IMMEDIATE = ("immediate", "次のルート生成から効く")
    #: 派生の作り直し（`batch/derive_cli.py`）をやり直さないと効かない。派生バッチは作り直しを始めるときに上書きを読み、
    #: 段の較正値は段の入力なので読む段から後ろが流れ、道路網の配列の較正値は配列を作り直させる。派生の外で同じ値を読む所は、
    #: 作り直しに使った値（`infrastructure/derived_data_meta.py: DerivedTuningRow`）を読む。
    DERIVE_REBUILD = ("derive_rebuild", "派生データを作り直すまで効かない")
    #: 画面を読み込み直すと効く（フロントが起動時のカタログ取得で受け取る値）。
    CLIENT_RELOAD = ("client_reload", "画面を読み込み直すと効く")


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
    default: float
    #: 桁を間違えたときに止めるための範囲であって、**意味的な歯止めではない**
    #: （`axis_admin`が重みに歯止めを設けないのと同じ考え方）。
    minimum: float
    maximum: float
    effect: TuningEffect
    #: 何を決める値か。管理画面のⓘへ出す。
    description: str
    #: 利用者の画面の説明文に値を出すか。出すものは効き方によらずカタログ取得でフロントへ配る
    #: （`_sent_to_client`）——文に数を直書きすると、管理画面で変えたときに文が嘘になる。
    shown_to_users: bool = False

    def __post_init__(self) -> None:
        if not self.id or not self.label or not self.description:
            raise ValueError(f"較正値の宣言に空の項目がある: {self.id!r}")
        if not all(math.isfinite(v) for v in (self.default, self.minimum, self.maximum)):
            raise ValueError(f"較正値の宣言に有限でない数がある: {self.id}")
        if not self.minimum <= self.default <= self.maximum:
            raise ValueError(
                f"較正値の既定が範囲の外: {self.id} "
                f"既定={self.default} 範囲=[{self.minimum}, {self.maximum}]"
            )


def event_seconds_parameter_id(group: str, name: str) -> str:
    """止まる出来事（`group`は`stop`＝停止要因・`turn`＝曲がる所、`name`は種類）の、止まった（減速した）ときの待ちの
    較正値のid（綴りを組み立てる場所を1つにする）。"""
    return f"{group}.{name}_seconds"


def event_share_parameter_id(group: str, name: str) -> str:
    """止まる出来事の、止まる割合の較正値のid。"""
    return f"{group}.{name}_share"


def _event_parameters(group: str, name: str, labels: tuple[str, str], share: float, wait: float, maximum: float,
                      description: str) -> tuple[TuningParameter, TuningParameter]:
    """止まる出来事1種類ぶんの宣言（止まる割合と、止まった・減速したときの待ち。`labels`はその2つの名前）。所要時間は
    割合 × 待ち、漕ぎ出しの体力は割合ぶん数える（`domain/traffic.py: StopEvent`）。"""
    return (
        TuningParameter(
            event_share_parameter_id(group, name), labels[0], "", share, 0.0, 1.0, TuningEffect.IMMEDIATE,
            "通るたびに止まる（減速する）割合。所要時間と漕ぎ出しの体力に同じ割合を使う。",
        ),
        TuningParameter(event_seconds_parameter_id(group, name), labels[1], "秒", wait, 0.0, maximum, TuningEffect.IMMEDIATE,
                        description),
    )


def _stop_parameters(kind: str, share: float, wait: float, description: str) -> tuple[TuningParameter, TuningParameter]:
    """停止要因1種別ぶんの宣言。種別（`POI_COUNT_KINDS`のキー）は名前へ添える対象（`domain/tuning_labels.py`）で示す。"""
    return _event_parameters("stop", kind, ("止まる割合", "止まったときの待ち"), share, wait, 300.0, description)


def _turn_parameters(name: str, label: str, share: float, wait: float, maximum: float,
                     description: str) -> tuple[TuningParameter, TuningParameter]:
    """曲がる所の出来事1種類ぶんの宣言。"""
    return _event_parameters("turn", name, (f"{label}の割合", label), share, wait, maximum, description)


#: 説明の文が名指す較正値のid。宣言と説明が同じ綴りを引く。
_MAJOR_CROSSING_ID = event_seconds_parameter_id("turn", "major_crossing")
_STOP_ID = event_seconds_parameter_id("stop", "stop")
_SIGNAL_ID = event_seconds_parameter_id("stop", "signal")
_CRR_ID = "speed.crr"
_CRR_GRAVEL_ID = "speed.crr_gravel"
_CRR_COBBLESTONE_ID = "speed.crr_cobblestone"
_TURNAROUND_OVERLAP_ID = "search.turnaround_max_overlap_ratio"
_TURNAROUND_RELAXED_OVERLAP_ID = "search.turnaround_relaxed_overlap_ratio"
_LOOP_RATIO_MIN_ID = "search.loop_to_outbound_ratio_min"
_LOOP_RATIO_MAX_ID = "search.loop_to_outbound_ratio_max"
_DISTANCE_TOLERANCE_ID = "search.distance_tolerance_ratio"
#: 派生の外（地図の点のタイル・近くの点の読み出し）も作り直しに使った値を読む較正値のid。
STOP_CLUSTER_DISTANCE_ID = "stop.cluster_distance_m"
ACCIDENT_MATCH_DISTANCE_ID = "accident.match_max_distance_m"
#: 道路網の配列を作る読み出しが、作り直しに使った値を読む較正値のid。
TURN_BEARING_DISTANCE_ID = "turn.bearing_distance_m"
#: 土地被覆を数える帯の外・内の幅のid。外の幅は地図の説明の文にも出る。
LANDCOVER_RING_OUTER_ID = "landcover.ring_outer_m"
LANDCOVER_RING_INNER_ID = "landcover.ring_inner_m"
#: 区間の標高の断面を刻む幅の上限のid。
ELEVATION_PROFILE_STEP_ID = "elevation.profile_step_m"


TUNING_PARAMETERS: tuple[TuningParameter, ...] = (
    # --- 曲がる所の出来事（方位差で決まる。割合 × 待ちが所要時間、割合が漕ぎ出しの体力） ---
    *_turn_parameters(
        "left", "左折", 1.0, 2.0, 120.0,
        "左折で減速して失う時間（止まらず減速する出来事）。",
    ),
    *_turn_parameters(
        "right", "右折", 1.0, 12.0, 120.0,
        "右折で止まって待つ時間。自転車は交差点の側端に沿って曲がる（道路交通法第34条第3項。二段階右折）ので、"
        "止まる出来事として数える。",
    ),
    *_turn_parameters(
        "uturn", "Uターン", 1.0, 60.0, 600.0,
        "折り返し1回で止まって失う時間。実質的に選ばせないための大きな値。",
    ),
    TuningParameter(
        "turn.straight_max_deg",
        "直進とみなす方位差", "度", 30.0, 0.0, 90.0,
        TuningEffect.IMMEDIATE,
        "この角度までの曲がりは直進とみなし、費用を足さない。",
    ),
    *_turn_parameters(
        "major_crossing", "上位の道の横断", 1.0, 8.0, 300.0,
        "信号の無い交差点で、上位の階級の道を直進で渡るときに足す。"
        f"一時停止で止まるぶん（{_STOP_ID}）とは別で、義務の停止を超えて相手の"
        "流れが途切れるのを待つぶんを表す（止まること自体は交通ルール上、車が来ていなくても"
        f"発生する）。信号のある交差点では足さない——{_SIGNAL_ID}が赤で待つ時間、"
        "すなわち渡れるようになるまでの待ちそのものを表すため。",
    ),
    *_turn_parameters(
        "major_turn", "上位の道への右左折", 1.0, 15.0, 300.0,
        "信号の無い交差点で、上位の階級の道へ右左折で入るときに足す。",
    ),
    # --- 停止要因（種別はPOI_COUNT_KINDSが正本。割合 × 待ちが所要時間、割合が漕ぎ出しの体力） ---
    *_stop_parameters("signal", 0.5, 42.0,
                      "赤で止まったときに青まで待つ時間（一般的な信号サイクルからの見積もり）。止まる割合は赤の割合。"
                      "渡れるようになるまでの待ちそのものを表すため、信号のある交差点では"
                      f"{_MAJOR_CROSSING_ID}を足さない。"),
    *_stop_parameters("crossing", 0.0, 5.0,
                      "歩行者に譲って止まったときの待ち。自転車が止まる前提は置いていない（割合0）。"),
    *_stop_parameters("stop", 1.0, 8.0,
                      "標識・標示で減速して止まるぶん。交通ルール上、車が来ていなくても止まる"
                      "ため相手の交通と無関係に発生する。相手の流れが途切れるのを待つぶんは"
                      f"含まず、そちらは{_MAJOR_CROSSING_ID}が上位の道を渡るときだけ"
                      "足す。"),
    *_stop_parameters("level_crossing", 1.0, 25.0,
                      "踏切の直前で止まり（道路交通法第33条）、遮断機の待ちを含む見積もり。"),
    *_stop_parameters("barrier", 1.0, 8.0, "ボラード等で減速して失う時間（止まらず減速する出来事）。"),
    TuningParameter(
        "stop.slowed_speed_ratio", "減速の出来事で残る速さの割合", "", 0.5, 0.0, 1.0, TuningEffect.IMMEDIATE,
        "止まらず減速する出来事（左折・車止め等）で、巡航速度のうち残る速さの割合。漕ぎ出しの体力は、止まる出来事の"
        "（1 − 割合²）倍になる。",
    ),
    # --- 交差点と停止の点 ---
    TuningParameter(
        "signal.match_radius_m",
        "信号とみなす半径", "m", 25.0, 1.0, 200.0,
        TuningEffect.DERIVE_REBUILD,
        "交差点から何m以内の信号を、その交差点のものとみなすか。"
        "広げるほど横断の費用が付く交差点が減る（頭打ちが無い）。",
    ),
    TuningParameter(
        STOP_CLUSTER_DISTANCE_ID,
        "停止の点をまとめる距離", "m", 40.0, 0.0, 200.0,
        TuningEffect.DERIVE_REBUILD,
        "同じ場所にある同種の停止要因の点を、1回の停止としてまとめる距離。日本のOSMは1つの信号交差点を流入路ごとの"
        "信号と横断歩道の位置の複数の点で描くため、点を素直に数えると停止回数を上回る。停止回数・地図の停止の点・"
        "ルートの印が同じ値でまとめる。",
    ),
    TuningParameter(
        TURN_BEARING_DISTANCE_ID,
        "曲がりの向きを測る長さ", "m", 20.0, 1.0, 200.0,
        TuningEffect.DERIVE_REBUILD,
        "交差点での曲がり（直進・左・右）を、区間の端からこの道のりの点までの向きで測る。区間がこれより短ければ端から端を見る。"
        "道路網の配列に効く。",
    ),
    # --- 事故 ---
    TuningParameter(
        ACCIDENT_MATCH_DISTANCE_ID,
        "事故を道に付ける距離", "m", 30.0, 1.0, 200.0,
        TuningEffect.DERIVE_REBUILD,
        "事故の点を、この距離以内で最も近い道に付ける。事故の点はOSMの要素ではないうえ、緯度経度は本票の度分秒の表記からの"
        "変換で粗いため、大きめに採る。事故の数とルートの印が同じ値で付ける。",
    ),
    TuningParameter(
        "accident.fatal_weight",
        "死亡事故の重み", "件", 3.0, 1.0, 20.0,
        TuningEffect.DERIVE_REBUILD,
        "死亡事故1件を何件分の事故として数えるか。単純に数えると死亡事故が軽い事故と同じ1件になり、最も避けたい重大な事故の"
        "危険が薄まる。実測から導いた値ではない。",
    ),
    # --- 標高 ---
    TuningParameter(
        ELEVATION_PROFILE_STEP_ID,
        "標高の断面の刻み", "m", 50.0, 10.0, 500.0,
        TuningEffect.DERIVE_REBUILD,
        "区間をこの道のり以下の等しい刻みに分けた点で標高を引き、獲得標高と勾配を出す。刻みが勾配をならす幅になる。"
        "狭めるほど短い起伏まで登りに数えるが、道の脇の地形（堤防の斜面等）や標高データの誤差による跳ね上がりも拾う。"
        "北千住から石岡への実走の獲得標高（スマートウォッチで約600m）と、刻みごとの値を比べて決めた。",
    ),
    # --- 土地被覆 ---
    TuningParameter(
        LANDCOVER_RING_OUTER_ID,
        "土地被覆を数える帯の外の幅", "m", 100.0, 10.0, 500.0,
        TuningEffect.DERIVE_REBUILD,
        "道の中心線からこの距離までの帯に重なる土地被覆の画素を数え、道の周りの土地被覆の割合にする。広げるほど道から"
        "離れた土地が混ざり、狭めるほど帯1本の画素が減って割合が粗くなる。実測から導いた値ではない。",
        shown_to_users=True,
    ),
    TuningParameter(
        LANDCOVER_RING_INNER_ID,
        "土地被覆を数える帯の内の幅", "m", 10.0, 0.0, 100.0,
        TuningEffect.DERIVE_REBUILD,
        "道の中心線からこの距離までは、路面そのものとして土地被覆の帯から除く。外の幅以下でなければならない。",
    ),
    # --- 走行モデル ---
    TuningParameter(
        "speed.cda_m2",
        "空気抵抗 CdA", "m²", 0.32, 0.1, 1.0, TuningEffect.IMMEDIATE,
        "ロードバイクのブラケットポジションの標準値。",
        shown_to_users=True,
    ),
    TuningParameter(
        _CRR_ID,
        "転がり抵抗", "", 0.005, 0.001, 0.05, TuningEffect.IMMEDIATE,
        "舗装路の23〜28mmタイヤの標準値。",
    ),
    # 路面の区分ごとの転がり抵抗。どの区分がどの値を使うかは管理DBの道の区分の転がり抵抗の表が持つ。
    TuningParameter(
        "speed.crr_paving_stones",
        "転がり抵抗", "", 0.0065, 0.001, 0.1, TuningEffect.IMMEDIATE,
        f"切石・レンガの敷石の計測値が見当たらないため、舗装（{_CRR_ID}）と石畳（{_CRR_COBBLESTONE_ID}）の間に置く。",
    ),
    TuningParameter(
        "speed.crr_compacted",
        "転がり抵抗", "", 0.010, 0.001, 0.1, TuningEffect.IMMEDIATE,
        f"締め固めた路面の計測値が見当たらないため、舗装（{_CRR_ID}）と砂利（{_CRR_GRAVEL_ID}）の中間に置く。",
    ),
    TuningParameter(
        _CRR_GRAVEL_ID,
        "転がり抵抗", "", 0.015, 0.001, 0.1, TuningEffect.IMMEDIATE,
        "未舗装の値域（0.012〜0.020）の中ほどで、舗装の約3倍（惰行試験で砂利は舗装の約3倍）。",
    ),
    TuningParameter(
        "speed.crr_soil",
        "転がり抵抗", "", 0.018, 0.001, 0.1, TuningEffect.IMMEDIATE,
        "草は舗装の約3.5倍（惰行試験）。砂はさらに大きいが、区分の中では土・草が多いため未舗装の値域の上寄りに置く。",
    ),
    TuningParameter(
        _CRR_COBBLESTONE_ID,
        "転がり抵抗", "", 0.008, 0.001, 0.1, TuningEffect.IMMEDIATE,
        "模擬石畳の試験台で空気圧を最適にしたロードバイクのタイヤが約0.0055。実際の玉石は凹凸が大きく"
        "空気圧も合わせないため、それより上で、舗装と締め固めの間に置く。",
    ),
    TuningParameter(
        "speed.crr_unknown",
        "転がり抵抗", "", 0.010, 0.001, 0.1, TuningEffect.IMMEDIATE,
        f"舗装の道も未舗装の道も多いため、舗装（{_CRR_ID}）と砂利（{_CRR_GRAVEL_ID}）の中間に置く。",
    ),
    TuningParameter(
        "speed.mass_kg",
        "総質量", "kg", 80.0, 30.0, 200.0, TuningEffect.IMMEDIATE,
        "体重＋車体＋装備。",
        shown_to_users=True,
    ),
    TuningParameter(
        "speed.max_descent_kmh",
        "下りの速度上限", "km/h", 45.0, 10.0, 100.0,
        TuningEffect.IMMEDIATE,
        "入れないと急勾配で所要時間が発散する。巡航速度がこれより速い人は、巡航速度を上限にする。",
        shown_to_users=True,
    ),
    TuningParameter(
        "speed.walking_kmh",
        "押して歩く速度", "km/h", 4.5, 1.0, 10.0, TuningEffect.IMMEDIATE,
        "登りでこれ以下になったら押して歩くとみなす。",
        shown_to_users=True,
    ),
    TuningParameter(
        "cost.effort_alpha",
        "体力の換算", "倍", 1.0, 0.0, 10.0, TuningEffect.IMMEDIATE,
        "平地の出力を越えて踏んだ体力を、平地をその秒だけ走る体力とみなした秒に掛ける倍率（費用の式のα）。全部の体力の軸に"
        "共通。",
    ),
    TuningParameter(
        "cost.burden_seconds_per_km",
        "道の負担の換算", "秒/km", 180.0, 0.0, 3600.0, TuningEffect.IMMEDIATE,
        "重さ1の道に換算した1kmを、何秒の損とみなすか（費用の式のβ）。既定は時速20kmで1km走る時間。全部の道の負担の軸に共通。",
    ),
    TuningParameter(
        "cost.effort_weight_exponent",
        "体力の重みの曲がり方", "", 1.0, 0.0, 4.0, TuningEffect.IMMEDIATE,
        "踏みたい出力（上限で切る前）と平地の出力の比を何乗して体力の重みにするか。0で重みを掛けない。上げるほど、上限を"
        "越えて踏みたい急な坂・強い向かい風を重く数える。",
    ),
    # 既定は、巡航20km/hの人（総質量80kg）が勾配5%で時速10km前後になるという実感に合わせた（勾配1%あたり15W）。
    TuningParameter(
        "speed.extra_power_per_force",
        "抵抗が増えたときの踏み増し", "W/N", 1.91, 0.0, 20.0,
        TuningEffect.IMMEDIATE,
        "平地・無風・基準の路面より抵抗（坂の重力・向かい風の空気抵抗・路面の転がり抵抗の増えた分の和）が1N増えるごとに、"
        "何W余分に踏むか。抵抗の種類によらず同じ決まりで踏み増す。坂での速度の実感に合わせた暫定値で、根拠は薄い。",
    ),
    TuningParameter(
        "speed.max_climb_power_ratio",
        "踏み増しの上限倍率", "倍", 2.5, 1.0, 10.0,
        TuningEffect.IMMEDIATE,
        "平地の巡航に対して何倍まで踏むか。踏み増しをここで頭打ちにする。",
    ),
    # --- 道の避け方 ---
    TuningParameter(
        "avoidance.avoid_cost_multiplier",
        "「なるべく避ける」の割り増し", "倍", 2.0, 1.0, 20.0, TuningEffect.IMMEDIATE,
        "道のレイヤの行を「なるべく避ける」にしたとき、その行に当たる区間の探索の費用に掛ける倍率。"
        "2なら、その区間を通るより倍の長さまでの回り道を選ぶ。1は避けない。",
    ),
    # --- 候補の選び方 ---
    TuningParameter(
        _TURNAROUND_OVERLAP_ID,
        "折返し点の往路の重なりの上限", "", 0.6, 0.0, 1.0, TuningEffect.IMMEDIATE,
        "採用済みの折返し点と往路が、距離の割合でこれより重なる折返し点は飛ばす。同じ道筋の折返し点が上位を"
        "占め、往路の大半が同じ周回が並ぶのを防ぐ。距離なしの目的地の代替経路も、経路全体の重なりに同じ値を使う。",
    ),
    TuningParameter(
        _TURNAROUND_RELAXED_OVERLAP_ID,
        "折返し点の往路の重なりの緩めた上限", "", 0.85, 0.0, 1.0, TuningEffect.IMMEDIATE,
        f"{_TURNAROUND_OVERLAP_ID}で候補の数が埋まらないとき、この上限まで緩めてやり直す。"
        f"{_TURNAROUND_OVERLAP_ID}以上にする。",
    ),
    TuningParameter(
        "search.min_turnaround_separation_km",
        "折返し点どうしの最小の間隔", "km", 1.5, 0.0, 20.0, TuningEffect.IMMEDIATE,
        "採用済みの折返し点からこれより近い折返し点は飛ばす。近い折返し点は同じ周回の変種にしかならない。",
    ),
    TuningParameter(
        "search.loop_max_overlap_ratio",
        "周回どうしの重なりの上限", "", 0.7, 0.0, 1.0, TuningEffect.IMMEDIATE,
        "帰りまで継いだ周回が、採用済みの周回と進む向きによらず距離の割合でこれより重なれば捨てる。"
        "同じ周回の逆回りや、往路は違うが帰りが同じ裏道へ収まる周回を弾く。"
        f"往路だけを見る{_TURNAROUND_OVERLAP_ID}より緩い、最後の確かめ。",
    ),
    TuningParameter(
        _LOOP_RATIO_MIN_ID,
        "周回の全長の見込みの下限", "倍", 1.8, 1.0, 5.0, TuningEffect.IMMEDIATE,
        "周回の全長が往路の何倍になるかの見込みの下限。帰りは往路を避けて探すため往路と同じかそれより長い。"
        "全長が目標±許容に入るよう、折返し点を探す往路の長さの範囲をこの見込みで決める。"
        "置いた点を通る・目的地で終わるときの帰りは、終点までの最短のこの値−1倍以上と見込む。",
    ),
    TuningParameter(
        _LOOP_RATIO_MAX_ID,
        "周回の全長の見込みの上限", "倍", 2.2, 1.0, 5.0, TuningEffect.IMMEDIATE,
        f"{_LOOP_RATIO_MIN_ID}の上限側。{_LOOP_RATIO_MIN_ID}以上にする。",
    ),
    TuningParameter(
        "search.alternative_max_stretch",
        "目的地への代わりの道の長さの上限", "倍", 1.3, 1.0, 3.0, TuningEffect.IMMEDIATE,
        "距離なしで目的地へ向かうとき、合成の費用が最も低い道の長さの何倍までの道を代わりの道の候補にするか。"
        "上げるほど遠回りの候補が並ぶ。",
    ),
    TuningParameter(
        "search.pareto_distance_quantum_m",
        "候補の距離を同じとみなす粒度", "m", 200.0, 1.0, 5000.0, TuningEffect.IMMEDIATE,
        "候補（折返し点・目的地への道の経由のNode）を並べるとき、距離の鍵がこの刻みの中で違うだけなら同じ距離とみなす。細かすぎると"
        "互いに劣らない候補が全件残って間引けず、粗すぎると候補が減りすぎる。",
    ),
    TuningParameter(
        "search.turnaround_radius_ratio",
        "距離ありの探索範囲の半径の比", "倍", 0.4, 0.1, 1.0, TuningEffect.IMMEDIATE,
        "距離ありで道路網を切り出す範囲の半径を、自由に選ぶ部分（目標から置いた点の間の長さを引いた残り）の"
        "何倍にするか。折返し点の往路はその半分付近にあり、直線ではそれより短いので0.5より小さく置く。"
        "上げると範囲の面積が二乗で増え、生成の準備の時間とメモリが増える。足りなければ折返し点の候補が欠ける。",
    ),
    TuningParameter(
        _DISTANCE_TOLERANCE_ID,
        "全長の目標の許容の割合", "", 0.15, 0.01, 1.0, TuningEffect.IMMEDIATE,
        "距離ありで、全長が目標からその目標のこの割合の長さの中に入る候補だけを返す（0.15なら30kmで±4.5km）。"
        "折返し点を探す往路の長さの範囲もこの幅から決める。",
        shown_to_users=True,
    ),
    TuningParameter(
        "search.retrace_penalty_multiplier",
        "走った道を帰りで通る罰", "倍", 8.0, 1.0, 100.0, TuningEffect.IMMEDIATE,
        "帰りを探す間、それまでに走った道（逆向きを含む）の探索の費用に掛ける倍率。1は避けない。"
        "有限なので、走った道を戻るほかに道が無い所（袋小路等）は通れる。",
    ),
    # --- 地図の評価 ---
    # 地図は費用の軸の一覧（`/api/cost-axes`の`map_lens.formula`）の木でこの幅を読むので、一覧を取り直す（画面を読み込み直す）と効く。
    TuningParameter(
        "gradient.perpendicular_band_deg",
        "勾配を示さない直角からの幅", "度", 15.0, 0.0, 45.0, TuningEffect.CLIENT_RELOAD,
        "走る向きに対して直角からこの角度以内の道は、どちら向きに辿るか決まらないため、その向きでの勾配を示さない"
        "（地図では向きで決まらない道として塗る）。広げるほど勾配を示さない道が増える。",
    ),
    # --- 画面が使う値（カタログ取得でフロントへ配る） ---
    TuningParameter(
        "splice.min_stretch_km",
        "区間を割る下限", "km", 0.2, 0.01, 5.0, TuningEffect.CLIENT_RELOAD,
        "区間の乗り換えで、これより短い断片は作らない。"
        "細かく割るほど選択肢が増え、1区間=1行の一覧が縦に伸びる。",
    ),
    # --- 主観と時間の換算 ---
    TuningParameter(
        "evaluation.penalty_strength",
        "主観と時間の換算レート", "", 0.7, 0.0, 5.0,
        TuningEffect.IMMEDIATE,
        "難易度を所要時間の割増しへ換算する強さ。",
    ),
)


#: 宣言の逆引き。
TUNING_PARAMETERS_BY_ID: dict[str, TuningParameter] = {p.id: p for p in TUNING_PARAMETERS}

_DUPLICATE_IDS = sorted(
    param_id for param_id, count in Counter(p.id for p in TUNING_PARAMETERS).items() if count > 1
)
if _DUPLICATE_IDS:
    raise ValueError(f"較正値のidが重複している: {', '.join(_DUPLICATE_IDS)}")

#: 値どうしの順の約束（下側のid, 上側のid）。下側は上側以下でなければならない。範囲は1件ずつしか
#: 見ないので、片方だけを動かして順が逆になる上書きは、全件を重ねたあとにここで断る。
TUNING_ORDERINGS: tuple[tuple[str, str], ...] = (
    (_TURNAROUND_OVERLAP_ID, _TURNAROUND_RELAXED_OVERLAP_ID),
    (_LOOP_RATIO_MIN_ID, _LOOP_RATIO_MAX_ID),
    (LANDCOVER_RING_INNER_ID, LANDCOVER_RING_OUTER_ID),
)


def misordered_pairs(values: dict[str, float]) -> list[tuple[str, str]]:
    """`values`（id → 値。宣言の全idを持つ）のうち、順の約束（`TUNING_ORDERINGS`）を破る組。"""
    return [(lower, upper) for lower, upper in TUNING_ORDERINGS if values[lower] > values[upper]]


_MISORDERED_DEFAULTS = misordered_pairs({p.id: p.default for p in TUNING_PARAMETERS})
if _MISORDERED_DEFAULTS:
    raise ValueError(f"較正値の既定が順の約束を破る: {_MISORDERED_DEFAULTS}")

#: いま効いている値（id → 値）。既定で初期化し、DBの上書きを読み込んだときに**中身だけ**を
#: 差し替える（束縛済みの参照先が古いままにならないよう、`.update()`で更新する。鍵は宣言の全idで
#: 変わらないので、`.clear()`は挟まない——理由は`services/tuning_service.py: _apply_tuning_values`）。
TUNING_VALUES: dict[str, float] = {p.id: p.default for p in TUNING_PARAMETERS}


def tuning_value(param_id: str) -> float:
    """いま効いている較正値。宣言に無いidは呼び出し側の綴り間違いなので落とす。"""
    try:
        return TUNING_VALUES[param_id]
    except KeyError:
        raise KeyError(f"較正値の宣言に無いid: {param_id}") from None


def tuning_parameters_by_effect() -> list[TuningParameter]:
    """較正値の宣言を効き方の順（`TuningEffect`の宣言順）に並べる。同じ効き方の中は宣言順のまま。"""
    effects = list(TuningEffect)
    return sorted(TUNING_PARAMETERS, key=lambda parameter: effects.index(parameter.effect))


def _sent_to_client(parameter: TuningParameter) -> bool:
    """フロントへ配る較正値か（効き方が`CLIENT_RELOAD`のものと、画面の説明文に値を出すもの）。
    配る対象を宣言から導く——配信側とフロント側で別々に並べると、1つ足したときに片方だけが古くなる。"""
    return parameter.effect is TuningEffect.CLIENT_RELOAD or parameter.shown_to_users


#: フロントへ配る較正値のうち、効き方が`DERIVE_REBUILD`のもの。画面の文が語る派生の値はまだ前の作り直しの値で
#: 作られているので、配る側はプロセスの上書きではなく作り直しに使った値（派生の記録）を読んで配る。
REBUILT_CLIENT_TUNING_IDS: tuple[str, ...] = tuple(
    p.id for p in TUNING_PARAMETERS if _sent_to_client(p) and p.effect is TuningEffect.DERIVE_REBUILD
)


def client_tuning_values() -> dict[str, float]:
    """フロントへ配る較正値のうち、`REBUILT_CLIENT_TUNING_IDS`を除くもの（id → いま効いている値）。"""
    return {
        p.id: tuning_value(p.id)
        for p in TUNING_PARAMETERS
        if _sent_to_client(p) and p.id not in REBUILT_CLIENT_TUNING_IDS
    }


def client_tuning_defaults() -> dict[str, float]:
    """フロントへ配る較正値の全部の既定（id → 宣言の既定）。"""
    return {p.id: p.default for p in TUNING_PARAMETERS if _sent_to_client(p)}
