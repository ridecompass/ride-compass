"""地図の総合のレンズ: id と、軸ごとの値から総合を出す決まり（地図のレンズとルートの線が同じ決まりで出す）。

ルートの型（`domain/route.py`）も読むので、ほかの domain に依らない。
"""

from collections.abc import Mapping

import numpy as np

#: 地図の総合のレンズ（軸ごとの代償の秒の和）のid。軸のidと同じ名前空間に並ぶので、軸には使えない。
TOTAL_LENS_ID = "total"


def lens_values_with_total[T: (float, np.ndarray)](per_axis: Mapping[str, T], zero: T) -> dict[str, T]:
    """軸ごとのレンズの値に、総合（`TOTAL_LENS_ID`。軸の和）を足した、レンズid→値（`zero`は和の始まり——配列なら同じ形の0）。"""
    return {TOTAL_LENS_ID: sum(per_axis.values(), zero), **per_axis}
