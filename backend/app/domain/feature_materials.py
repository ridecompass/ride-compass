"""タイル1枚のフィーチャーごとの材料（地図の道の線の層が区分を塗る入力）。"""

from dataclasses import dataclass

from app.domain.attributes import MaterialColumn


@dataclass(frozen=True)
class FeatureMaterials:
    """タイル1枚のフィーチャーごとの材料。`columns`の各列は`feature_keys`と同じ並び（数値・真偽はfloatの配列で欠損は
    NaN、分類は`CategoricalColumn`）。"""

    feature_keys: tuple[str, ...]
    columns: dict[str, MaterialColumn]

    def __len__(self) -> int:
        return len(self.feature_keys)
