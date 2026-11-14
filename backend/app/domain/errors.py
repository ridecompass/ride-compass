class RoutingError(Exception):
    pass


#: ルート生成を混んでいるとして断るときに利用者へ出す文。投稿の時点と、枠を待つ間のどちらで断っても同じ文にする。
GENERATION_BUSY_MESSAGE = "ルート生成が混み合っています。しばらく待ってから再試行してください。"
