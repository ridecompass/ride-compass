"""材料の値を道のストレスの重さへ写す区分線形カーブ（道のストレスの軸と、地図の式の木の折れ線が使う）。

配列で受ける（欠損値はNaNで表現・伝播する）。
"""

from __future__ import annotations

import numpy as np


def evaluate_breakpoint_linear(value: np.ndarray, breakpoints: list[tuple[float, float]]) -> np.ndarray:
    """区分線形補間（breakpointsはx昇順の(x, y)組、両端でクランプ）。

    numpyの`np.interp`（既定でx範囲外はfp[0]/fp[-1]にクランプ）をそのまま使う。
    NaN（欠損値）が混じる要素は、`np.interp`がNaNを正しく伝播しない（内部の探索がNaNを
    0番目の区間として扱ってしまう）ため、`np.isnan`でマスクして明示的にNaNへ戻す。
    """
    xp, fp = zip(*breakpoints, strict=True)
    result = np.interp(value, xp, fp)
    return np.where(np.isnan(value), np.nan, result)

