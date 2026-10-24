"""`domain/axis_publication.py`——公開中の軸を書き換える・公開へ切り替える書き込みの決まり。

入口:
- 公開中の軸の更新・削除を断る（`check_publish_immutability`）
- 他の軸が組み合わせに使う軸を公開へ切り替える書き込みを断る（`check_internal_axis_not_published`）

ここで見ないもの:
- 軸1本の宣言と軸の集合の検査 → `test_axis_definitions.py`
- 書き込みの道筋で決まりが通ること → `test_axis_registry_service.py`
- 軸の定義ファイルの適用が公開中の軸の書き方を選ぶこと → `test_axis_apply.py`
"""

from contextlib import nullcontext

import pytest

from app.domain import axis_publication
from app.domain.axis_definitions import AxisDefinition, CategoricalShape, MaterialTerm
from tests.axis_system_fixture import linear


def axis(axis_id: str = "axis_a", shape=None, **fields) -> AxisDefinition:
    return AxisDefinition(
        axis_id=axis_id,
        shape=shape if shape is not None else linear(MaterialTerm(material="num_a")),
        **{"default_weight": 1.0, "label": "軸", **fields},
    )


NEW_BREAKPOINTS = ((0.0, 0.0), (5.0, 100.0))


SHOWN_DIFFERENTLY = {
    "shape": linear(MaterialTerm(material="num_a"), breakpoints=((0.0, 0.0), (5.0, 60.0), (20.0, 100.0))),
    "icon_id": "icon",
    "display_thresholds_override": [1.0],
    "display_band_labels_override": ["弱", "強"],
}
UPDATE_REFUSED = "表示と折れ点以外は変えられません"


class TestPublishImmutability:
    @pytest.mark.parametrize(
        ("action", "changed", "refusal"),
        [
            ("deleted", None, "「軸」は公開中のため削除できません"),
            # 公開したまま書けないと、下書きへ戻す間だけ一般の画面から軸が消え、利用者の重みが既定へ戻る。
            ("updated", SHOWN_DIFFERENTLY, None),
            # 折れ点は、ほかを変えない差し替えのときだけ公開したまま書ける。
            ("updated", {"default_weight": 2.0, "shape": linear(MaterialTerm(material="num_a"), breakpoints=NEW_BREAKPOINTS)},
             UPDATE_REFUSED),
            ("updated", {"shape": linear(MaterialTerm(material="num_b"), breakpoints=NEW_BREAKPOINTS)}, UPDATE_REFUSED),
            ("updated", {"shape": linear(MaterialTerm(material="num_a", weight=2.0), breakpoints=NEW_BREAKPOINTS)},
             UPDATE_REFUSED),
            ("updated", {"shape": linear(MaterialTerm(material="num_a"), breakpoints=NEW_BREAKPOINTS, preprocess="abs")},
             UPDATE_REFUSED),
            ("updated", {"shape": CategoricalShape(material="num_a", mapping={"x": 50.0})}, UPDATE_REFUSED),
            ("updated", {"is_published": False, "shape": linear(MaterialTerm(material="num_a"), breakpoints=NEW_BREAKPOINTS)},
             UPDATE_REFUSED),
        ],
        ids=["削除", "表示と折れ点", "重み", "材料", "項", "前処理", "形の種類", "公開"],
    )
    def test_a_published_axis_may_change_only_how_it_is_shown_and_its_breakpoints(self, action, changed, refusal):
        published = axis(is_published=True)
        candidate = None if changed is None else published.model_copy(update=changed)

        with nullcontext() if refusal is None else pytest.raises(axis_publication.AxisPublishedImmutableError, match=refusal):
            axis_publication.check_publish_immutability(published, action, candidate)


class TestInternalAxisPublish:
    EXISTING = {"outer": axis("outer", label="外の軸", shape=linear(MaterialTerm(material="inner")))}

    @pytest.mark.parametrize(
        ("previous", "refused"),
        [
            ({}, True),
            ({"inner": axis("inner")}, True),
            # 時刻で変わる軸が組み合わせる公開軸の、表示だけの直し。公開へ切り替える書き込みではない。
            ({"inner": axis("inner", is_published=True)}, False),
        ],
        ids=["new", "draft", "already_published"],
    )
    def test_an_axis_another_axis_reads_is_not_published(self, previous, refused):
        candidate = axis("inner", is_published=True, icon_id="内")
        refusal = pytest.raises(axis_publication.AxisInternalAxisPublishError, match="「軸」は「外の軸」が組み合わせに使っている軸")
        with refusal if refused else nullcontext():
            axis_publication.check_internal_axis_not_published(candidate, {**self.EXISTING, **previous})
