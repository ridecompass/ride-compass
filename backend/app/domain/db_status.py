"""本番DBの数を「注意が要るか」へ読む判断。

しきい値そのものより「なぜその値か」が重要なため、定数ごとに根拠を書く。
"""

#: `idle in transaction`がこれより長く続いていれば注意。放置されたトランザクションは
#: VACUUMが古い行を回収するのを止め、テーブルを肥大化させる。冷えた状態のルート生成でも
#: 数分で終わるため、正常な処理がこの長さを超えることは無い。
IDLE_TRANSACTION_WARN_SECONDS = 600.0

#: 接続数がmax_connectionsのこの割合を超えたら注意（残り枠が尽きると新規接続が失敗する）。
CONNECTION_USAGE_WARN_RATIO = 0.8

#: 不要行（dead tuple）が行全体のこの割合を超えたら注意。VACUUMが追いついていない。
DEAD_TUPLE_WARN_RATIO = 0.2

#: 統計が無いことを注意として出す行数の下限。これを下回るテーブルは、プランナが行数を
#: どう推定しても全走査で足りるため実行計画が変わらない——注意を出しても打つ手が無い。
STATISTICS_WARN_MIN_ROWS = 10_000

#: 不要行を注意として出す絶対数の下限。割合だけで見ると、行数の少ないテーブルが常に注意に
#: なるが、回収できる容量が無く行動につながらない。
DEAD_TUPLE_WARN_MIN_ROWS = 1_000


def table_attention(row_count: int, dead_tuples: int, *, analyzed: bool) -> list[str]:
    """テーブル1つの注意の理由。空なら注意は要らない。"""
    reasons: list[str] = []
    if not analyzed and row_count >= STATISTICS_WARN_MIN_ROWS:
        reasons.append(
            "統計を一度も取っていない（プランナの行数推定が実数から外れ、クエリが遅いプランを選びうる）"
        )
    if dead_tuples >= DEAD_TUPLE_WARN_MIN_ROWS and dead_tuples / (row_count + dead_tuples) > DEAD_TUPLE_WARN_RATIO:
        reasons.append(f"不要行が{dead_tuples:,}件（VACUUMが追いついていない）")
    return reasons


def connection_attention(total: int, max_connections: int, longest_idle_transaction_seconds: float) -> list[str]:
    """接続の注意の理由。空なら注意は要らない。"""
    reasons: list[str] = []
    if longest_idle_transaction_seconds > IDLE_TRANSACTION_WARN_SECONDS:
        minutes = longest_idle_transaction_seconds / 60
        reasons.append(
            f"開いたまま放置されたトランザクションが{minutes:.0f}分（VACUUMが古い行を回収できず肥大化する）"
        )
    if max_connections and total / max_connections > CONNECTION_USAGE_WARN_RATIO:
        reasons.append(f"接続が{total}/{max_connections}（残り枠が尽きると新規接続が失敗する）")
    return reasons


def import_attention(*, succeeded: bool, status_label: str, latest_succeeded_id: int | None) -> list[str]:
    """取込1種別の最後の実行の注意の理由。空なら注意は要らない。派生データの世代比較は成功した取込を基準にするため、
    最後の実行が成功していなければ、それ以降の取り込みは派生データへ届いていない。"""
    if succeeded:
        return []
    if latest_succeeded_id is None:
        return [f"最後の取込が「{status_label}」。成功した取込が1件も無い"]
    return [
        f"最後の取込が「{status_label}」。派生データの基準は成功した#{latest_succeeded_id}のままで、"
        "それ以降の取り込みは反映されていない"
    ]


def source_needs_rebuild(*, derived_run_id: int | None, latest_run_id: int | None) -> bool:
    """派生データを作り直しに使った取込が、成功した最新の取込でない（取込が1度も成功していない・まだ作り直しに
    使っていない、も含む）。"""
    return latest_run_id is None or derived_run_id != latest_run_id


def table_needs_rebuild(*, recorded: bool, added: tuple[str, ...], removed: tuple[str, ...]) -> bool:
    """表を作り直しが要る（今の表を作ったときの列の記録が無い・記録が今の宣言の列と違う のどちらか）。"""
    return not recorded or bool(added or removed)
