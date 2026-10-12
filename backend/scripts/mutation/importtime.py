"""生き残りのうち、読み込みのときに呼ばれうる関数の変異を拾う。backend の下で打つ。

mutmut の「関数ごとに通るテスト」の記録は、テストが走る前（モジュールの読み込み・クラスの本体・既定値・デコレータ）に
呼ばれた関数のテストを漏らす。そうした関数の変異は、記録にあるテストだけを回すと生き残りに見えるので、テスト全体を
当て直す（issue #661 の検算の3）。関数の外で呼ばれる名前を集め、生き残りの関数の名前と照らす。メソッドの get は
辞書の get と名前がぶつかるので外す。report.py も、同じ照らしで読み込みのときに呼ばれうる関数の変異に印（static）を付ける。
引数: 変異の結果（runner.py が書く results.jsonl） 出力のファイル
当て直すのは、その回でどのテストも落ちなかった変異（基準と比べるのは、全部の本の結果がそろう report.py）。
"""
import ast
import glob
import sys

from _shared import baseline_of, read_results, split_name


def _visit(node, called):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
        if not isinstance(node, ast.Lambda):
            for d in node.decorator_list + node.args.defaults + node.args.kw_defaults:
                if d is not None:
                    _visit(d, called)
        return  # 本体は呼ばれたときに走るので見ない
    if isinstance(node, ast.Call):
        f = node.func
        called.add(f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", None))
    for child in ast.iter_child_nodes(node):
        _visit(child, called)


def called_at_import():
    """app の関数の外（読み込みのときに走る所）で呼ばれる名前。"""
    called: set[str | None] = set()
    for path in glob.glob("app/**/*.py", recursive=True):
        _visit(ast.parse(open(path, encoding="utf-8").read()), called)
    return called


def is_import_time(mangled, called):
    """mutmut の関数か変異の名前が、読み込みのときに呼ばれうるか。"""
    _module, cls, name = split_name(mangled)
    return name in called and not (cls and name == "get")


if __name__ == "__main__":
    names = called_at_import()
    hits = [m for m, r in read_results(sys.argv[1]).items()
            if r["status"] == "survived" and baseline_of(m) is None and is_import_time(m, names)]
    open(sys.argv[2], "w", encoding="utf-8").write("\n".join(hits) + "\n")
    print(len(hits), "件")
