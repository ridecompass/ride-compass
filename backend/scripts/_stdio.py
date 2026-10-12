"""`scripts/`の実行口と、リポジトリの根の`scripts/`の道具・フックが共通で使う、標準の入出力の設定。

`scripts/`を直接実行したとき（`python scripts/<名前>.py`）は`scripts/`自身が`sys.path`の先頭に
入るため、実行口は`from _stdio import use_utf8_stdio`で読める。テストはスクリプトを
`scripts.<名前>`としてimportするので、読むのは`if __name__ == "__main__":`の中に限る。
backendの像には`backend/`だけが入り、像の中の実行口も読むので、ここに置く。根の道具は
`backend/scripts`を`sys.path`の末尾へ足して読む（根の同じ名前のモジュールを隠さない）。
"""

import io
import sys


def use_utf8_stdio() -> None:
    """標準の入出力をUTF-8にする。Windowsの既定（cp932）は日本語以外の記号（—等）を書けずに落ち、UTF-8でやり取りする
    相手（Claude Codeのフックの入出力）の文を化けさせる。"""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(encoding="utf-8")
