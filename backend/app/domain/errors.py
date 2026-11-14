class RoutingError(Exception):
    pass


class SearchAreaTooLargeError(Exception):
    """探索範囲の道路が多すぎて、1回の生成に使えるメモリへ収まらない。

    経路が無い（`RoutingError`）のとは別の理由で、利用者には範囲を狭めれば作れると伝える。
    """

    def __init__(self, edges: int, limit: int):
        super().__init__(f"edges={edges} limit={limit}")
        self.edges = edges
        self.limit = limit


#: ルート生成を混んでいるとして断るときに利用者へ出す文。投稿の時点（同時の件数）と探索範囲を組む時点（メモリ）のどちらで断っても同じ文にする。
GENERATION_BUSY_MESSAGE = "ルート生成が混み合っています。しばらく待ってから再試行してください。"


class SearchMemoryBusyError(Exception):
    """探索範囲は1回の生成に使えるメモリへ収まるが、同時に動くほかの生成が使っている分と合わせると収まらない。

    範囲が大きすぎる（`SearchAreaTooLargeError`）のとは別の理由で、利用者には待てば作れると伝える。
    """

    def __init__(self, edges: int, available: int):
        super().__init__(f"edges={edges} available={available}")
        self.edges = edges
        self.available = available
