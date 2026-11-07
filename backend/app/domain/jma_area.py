"""地点が属する区域（class20）から、JMA警報エリアの親子関係を解決する。

JMA警報API（r8スキーマ）は府県予報区単位（例: 東京都全体）でしか個別に問い合わせられ
ないが、レスポンス内の`class10Items`/`class20Items`は都道府県内の細分区域ごとに警報を
持つ（例: 東京地方 vs 伊豆諸島北部 vs 小笠原諸島）。地点を正しい細分区域まで解決する
ために、気象庁が公開する地域マスタ（area.json）の親子関係
（class20=市区町村等 → class15 → class10=一次細分区域 → offices=府県予報区）を辿る。
"""

from __future__ import annotations

from dataclasses import dataclass

#: どの区域にも入らない地点を、最も近い区域へ寄せる距離の上限（度。おおむね1km）。境界は簡略化して
#: 持つため隣の区域との間に隙間ができ、海岸の区域は岸壁・橋の上を含まないことがある。
NEAREST_LIMIT_DEG = 0.01


@dataclass(frozen=True)
class ResolvedArea:
    class20_code: str
    class10_code: str
    office_code: str


@dataclass(frozen=True)
class AreaEntry:
    """地域マスタの1区域。どの区域も親と名前を持つ（2026-11-07 の実物で、区域・中間・一次細分・府県予報区の全部が持つ）。"""

    parent: str
    name: str


@dataclass(frozen=True)
class AreaMaster:
    """地域マスタ（area.json）のうち、警報エリアの解決に使う階層。区域のコード→区域。"""

    class20s: dict[str, AreaEntry]
    class15s: dict[str, AreaEntry]
    class10s: dict[str, AreaEntry]


class AreaNotInMasterError(ValueError):
    """区域のコードを地域マスタで警報のエリアまで辿れない（手元の区域の境界と気象庁の地域マスタが食い違っている）。"""


def resolve_area(class20_code: str, master: AreaMaster) -> ResolvedArea:
    """地域マスタを使い、区域のコードからJMA警報エリア（class20/class10/office）を解決する。
    辿れなければ`AreaNotInMasterError`を投げる。"""
    # class15→class10まで親を辿る。区域によってはclass20の親が既にclass10自身になっている
    # （細分がそれ以上分かれない）ため、class10sに見つかるまでループする。
    try:
        code = master.class20s[class20_code].parent
        seen = {code}
        while code not in master.class10s:
            code = master.class15s[code].parent
            if code in seen:
                # 循環は本来あり得ないが、外部のデータで辿りが止まらないと、イベントループごと止まる。
                raise AreaNotInMasterError(class20_code)
            seen.add(code)
    except KeyError as error:
        raise AreaNotInMasterError(class20_code) from error
    return ResolvedArea(class20_code=class20_code, class10_code=code, office_code=master.class10s[code].parent)
