"""公開中の軸を書き換える・公開へ切り替える書き込みの決まり（管理APIの書き込みと軸の定義ファイルの適用が通す）。

利用者の保存した重みは`axis_id`で残るので、公開後に評価の中身を変える・消すと他の利用者の設定を黙って壊す。
"""

from typing import Literal

from app.domain.axis_definitions import AxisDefinition, BreakpointLinearShape, axis_dependencies, named_references


#: 公開済みの軸に拒む操作。
PublishedAxisAction = Literal["updated", "deleted"]


class AxisPublishedImmutableError(ValueError):
    """公開済み（is_published=True）の軸を更新・削除しようとした場合に送出する。

    一般ユーザーの保存設定（RouteSettingsPanelのプリセット・重み）はaxis_idキーで
    再現されるため、公開後の破壊的変更・削除は他ユーザーの設定を黙って壊す。
    改良したい場合は、新しいaxis_idの下書き軸として作ってから公開する（この関数は変更を拒否するだけ）。

    ただし更新（`action="updated"`）については、`axis_id`も読む材料も変えない差分
    （`is_update_allowed_while_published`）なら例外的に許可する（`check_publish_immutability`の
    `candidate`引数参照）。利用者の保存した重みは`axis_id`で残るので、点数の付け方の目盛りを
    差し替えても壊れない。
    """

    def __init__(self, existing: "AxisDefinition", action: PublishedAxisAction) -> None:
        name = named_references([existing.axis_id], {existing.axis_id: existing})
        if action == "deleted":
            message = f"{name}は公開中のため削除できません。先に非公開に戻してください。"
        else:
            message = (
                f"{name}は公開中のため、表示と折れ点以外は変えられません。非公開に戻してから変えるか、"
                "新しいaxis_idの軸として作ってください。"
            )
        super().__init__(message)


# 評価ロジック（shape・default_weight・priority_overrides等）に一切影響しない
# 表示専用フィールド。値を変えてもaxis_idキーで再現される他ユーザーの保存重み設定・
# ルート計算結果は変わらない。
# display_band_labels_overrideもdisplay_thresholds_overrideと同じ「地図の色分け段階の
# 見せ方」の表示専用フィールドのためここへ加える。
_COSMETIC_ONLY_FIELDS = frozenset(
    {
        "icon_id",
        "display_thresholds_override",
        "display_band_labels_override",
    }
)


def is_update_allowed_while_published(existing: AxisDefinition, candidate: AxisDefinition) -> bool:
    """`existing`から`candidate`への差分が、公開したまま書いてよいものだけかどうか。

    許すのは表示専用フィールド（`_COSMETIC_ONLY_FIELDS`）と、折れ線の形の`breakpoints`。どちらも`axis_id`・
    読む材料・項・前処理・重み・形の種類を変えないので、利用者の保存した重みはそのまま効く。`existing`へ
    `candidate`側の許す値だけを重ねた結果が`candidate`と完全一致すれば、それ以外は変わっていないと分かる。"""
    update: dict[str, object] = {field: getattr(candidate, field) for field in _COSMETIC_ONLY_FIELDS}
    if isinstance(existing.shape, BreakpointLinearShape) and isinstance(candidate.shape, BreakpointLinearShape):
        update["shape"] = existing.shape.model_copy(update={"breakpoints": candidate.shape.breakpoints})
    return existing.model_copy(update=update) == candidate


def check_publish_immutability(
    existing: AxisDefinition, action: PublishedAxisAction, candidate: AxisDefinition | None = None
) -> None:
    """`existing`が公開済みなら`AxisPublishedImmutableError`を送出する（更新・削除の
    どちらの直前でも呼べる汎用関数、`action`は断りの文を選ぶ）。

    `candidate`（更新後の内容）が渡され、かつその差分が公開したまま書いてよいものだけ
    （`is_update_allowed_while_published`）の場合は例外的に許可する。`delete()`のように
    `candidate`が無い呼び出しは一律拒否のまま。"""
    if existing.is_published and not (candidate is not None and is_update_allowed_while_published(existing, candidate)):
        raise AxisPublishedImmutableError(existing, action)


class AxisInternalAxisPublishError(ValueError):
    """他の軸から参照されている内部軸を公開（is_published=True）しようとした場合に
    送出する。

    「内部軸は他の軸から参照される専用で、恒久的に非公開のまま運用する」という軸階層の
    設計意図（`domain/axis_definitions.py: AxisDefinition`のdocstring「軸の階層」）をコードレベルで
    強制する。内部軸が誤って公開されると、一般ユーザー向けのルート設定画面
    （`GET /api/axis-catalog`、is_publishedフィルタのみ）へそのまま漏れ出てしまう。
    """

    def __init__(self, candidate: "AxisDefinition", referencing: "AxisDefinition") -> None:
        axes = {candidate.axis_id: candidate, referencing.axis_id: referencing}
        super().__init__(
            f"{named_references([candidate.axis_id], axes)}は{named_references([referencing.axis_id], axes)}が組み合わせに使っている軸なので、"
            "公開できません（組み合わせに使う軸は非公開のまま使います）。公開せずに保存してください。"
        )


def check_internal_axis_not_published(candidate: AxisDefinition, existing: dict[str, AxisDefinition]) -> None:
    """`candidate`が`existing`内の他の軸（自分自身を除く）から軸参照（内部軸）として
    使われているにもかかわらず、is_published=Trueで保存しようとしていないか検査する。
    非公開のままなら常に許可する（早期return）。

    断るのは公開へ切り替える書き込みだけで、`existing`にある書く前の版が既に公開中なら許可する。
    時刻で変わる軸が公開軸を組み合わせる形（`domain/axis_definitions.py: check_axis_set`のdocstring）では、組み合わせに
    使われる軸が公開中のまま残り、その表示と折れ点の直し（`check_publish_immutability`が許す差分）も保存する。
    """
    previous = existing.get(candidate.axis_id)
    if not candidate.is_published or (previous is not None and previous.is_published):
        return
    known_axis_ids = set(existing) | {candidate.axis_id}
    for other_id, other in existing.items():
        if other_id == candidate.axis_id:
            continue
        if candidate.axis_id in axis_dependencies(other, known_axis_ids):
            raise AxisInternalAxisPublishError(candidate, other)
