"""ルート生成が候補を1本も返せないときの、利用者へ見せる理由の文。

どの文も、変えてみる設定として、地図の道路のまとまり（`ROAD_OVERLAY_GROUP`）の名前を名指す。
"""

from app.domain.map_display import ROAD_OVERLAY_GROUP

_ROAD_SETTINGS_TAB = ROAD_OVERLAY_GROUP.label

#: 経由地・目的地を通る経路を結べなかったとき。
UNREACHABLE_POINTS_REASON = (
    f"指定した経由地・目的地を通る経路が見つかりませんでした。地点や「{_ROAD_SETTINGS_TAB}」の設定を変えてお試しください。"
)
#: 経由地を置かずに、目的地までの経路を結べなかったとき。
UNREACHABLE_DESTINATION_REASON = (
    f"指定した目的地までの経路が見つかりませんでした。地点や「{_ROAD_SETTINGS_TAB}」の設定を変えてお試しください。"
)


def no_turnaround_reason(distance_km: float, ring_m: tuple[float, float] | None) -> str:
    """距離ありの生成で、全長が目標に合う折返し地点が1つも無かったとき。`ring_m`は経由地を置かない周回の、出発地からの
    片道の範囲[m]（下限, 上限）。それ以外（経由地か目的地がある）ならNone。"""
    if ring_m is not None:
        lower_m, upper_m = ring_m
        return (
            f"出発地から片道{lower_m / 1000:.1f}〜{upper_m / 1000:.1f}kmで到達できる折返し地点が見つかりませんでした。"
            f"距離や「{_ROAD_SETTINGS_TAB}」の設定を変えてお試しください。"
        )
    return (
        f"置いた地点を通って全長{distance_km:.1f}km前後になる経路が見つかりませんでした。"
        f"距離や地点、「{_ROAD_SETTINGS_TAB}」の設定を変えてお試しください。"
    )


def no_traced_reason(failed: int, filtered_out: int, distance_km: float, distance_tolerance_km: float) -> str:
    """折返し地点はあったが、帰り道が見つからないか全長が目標から外れて、周回が1本も残らなかったときの要約。

    折返し地点が1つ以上あって1本も残らないのは、失敗か距離外れが1件以上あるときだけ（1本目は似すぎを問わず、求める本数は
    1以上）なので、どちらも0で呼ばれることは無い。
    """
    parts = []
    if failed:
        parts.append(f"{failed}件の折り返し地点で、帰り道が見つかりませんでした[「{_ROAD_SETTINGS_TAB}」の設定をご確認ください]")
    if filtered_out:
        parts.append(
            f"{filtered_out}件の周回候補は指定距離[{distance_km:.1f}km±{distance_tolerance_km:.1f}km]から外れました"
        )
    return "、".join(parts) + f"。距離や「{_ROAD_SETTINGS_TAB}」の設定を変えてお試しください。"
