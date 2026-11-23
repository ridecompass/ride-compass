"""このプロセスが入っているコンテナ（cgroup v2）のメモリ上限と、このプロセスが使ったメモリ。"""

import sys
from pathlib import Path

#: 本番の読み手はこのファイルだけだが、テストがディスク（プロセス境界）の置き場を差し替えて上限を与えるために公開する
#: （testing.md「確かめる高さ」の (c)）。
CGROUP_MEMORY_MAX = Path("/sys/fs/cgroup/memory.max")


def memory_limit_bytes() -> int | None:
    """上限のバイト数。上限が付いていない（`max`）・cgroup v2の外（開発機）ならNone。"""
    try:
        text = CGROUP_MEMORY_MAX.read_text().strip()
    except OSError:
        return None
    return None if text == "max" else int(text)


def memory_note() -> str:
    """このプロセスがこれまでに使った最大の常駐メモリと、コンテナの上限の、ログに書く1語（例: `最大のメモリ=3470MB/上限4096MB`）。
    測れない（Windowsの開発機には`resource`が無い）なら空。"""
    if sys.platform == "win32":
        return ""
    import resource

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024  # Linuxはキロバイトで返す
    limit = memory_limit_bytes()
    return f"最大のメモリ={peak}MB" + (f"/上限{limit // 2**20}MB" if limit is not None else "")
