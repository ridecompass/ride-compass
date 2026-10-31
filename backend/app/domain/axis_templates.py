"""評価軸の変換ロジックが還元できる2つの汎用プリミティブ。

- **連続演算**（`evaluate_breakpoint_linear`）: 値を区分線形カーブ（両端クランプ）でスコア化する。
- **離散演算**（`evaluate_categorical`）: 単一の離散値（bool/カテゴリ文字列）を
  テーブル引きでスコア化する。

どちらも配列で受ける（欠損値はNaNで表現・伝播する）。
"""

from __future__ import annotations

import numpy as np

from app.domain.attributes import CategoricalColumn, MaterialColumn


def evaluate_breakpoint_linear(value: np.ndarray, breakpoints: list[tuple[float, float]]) -> np.ndarray:
    """区分線形補間（breakpointsはx昇順の(x, y)組、両端でクランプ）。

    numpyの`np.interp`（既定でx範囲外はfp[0]/fp[-1]にクランプ）をそのまま使う。
    NaN（欠損値）が混じる要素は、`np.interp`がNaNを正しく伝播しない（内部の探索がNaNを
    0番目の区間として扱ってしまう）ため、`np.isnan`でマスクして明示的にNaNへ戻す。
    """
    xp, fp = zip(*breakpoints, strict=True)
    result = np.interp(value, xp, fp)
    return np.where(np.isnan(value), np.nan, result)


def evaluate_categorical(value: MaterialColumn, mapping: dict) -> np.ndarray:
    """カテゴリ値の配列→定数のマッピング。引けない値（欠損、および`mapping`に無い値）は
    「評価不能」としてNaNを返す。欠損の表現は材料により異なり、dtype=object の配列はNoneで表す。

    分類の材料の列（`CategoricalColumn`、ルート選びの経路）は語彙ごとに1回引いて番号で配る。
    それ以外（真偽の材料の配列と、Pythonの値から作ったobjectの配列）は、キーでソートした`np.searchsorted`で
    引く（キー数の多い材料でも、キーごとに配列全体を走査しない）。欠損（None）はstrと順序比較できず
    searchsortedが例外になるので実在のキー`keys[0]`へ差し替えて引き、`missing`のマスクで不一致に戻す。
    """
    if isinstance(value, CategoricalColumn):
        return value.lookup(mapping)
    keys = sorted(mapping.keys())
    key_scores = np.array([mapping[key] for key in keys], dtype=float)
    keys_array = np.array(keys, dtype=value.dtype if value.dtype != object else object)
    missing = value == None  # noqa: E711 (numpy配列の要素ごと比較、`is`では動かない)
    safe_value = np.where(missing, keys[0], value)
    idx = np.clip(np.searchsorted(keys_array, safe_value), 0, len(keys) - 1)
    matched = (keys_array[idx] == safe_value) & ~missing
    return np.where(matched, key_scores[idx], np.nan)
