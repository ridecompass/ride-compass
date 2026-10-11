"""変異テストの台本どうしが共有する読み方（変異の名前・落ちたテストの記録・テスト関数の行・書き換えた行）。台本と同じ
ディレクトリから読む。"""
import ast
import collections
import difflib
import functools
import glob
import os


def fn_of(mutant):
    """mutmut の変異の名前から、変異を作った関数の名前（mangled name）。"""
    return mutant.partition("__mutmut_")[0]


def read_kills(directory, kills=None):
    """runner.py が kills/ に書いた落ちたテストの記録を、変異の名前ごとのテストの集合へ足して返す。"""
    kills = collections.defaultdict(set) if kills is None else kills
    for f in glob.glob(os.path.join(directory, "kills", "*.tsv")):
        for line in open(f, encoding="utf-8"):
            m, t, _when = line.rstrip("\n").split("\t")
            kills[m].add(t)
    return kills


@functools.cache
def _parsed(path):
    src = open(path, encoding="utf-8").read()
    return src.splitlines(), ast.parse(src)


def def_span(path, name):
    """テスト関数（`クラス::関数` のように :: でつないだ名前）の、デコレータの行と終わりの行（1から数える）。見つからなければ
    None。ファイルを読めなければ OSError。"""
    _lines, tree = _parsed(path)
    body = tree.body
    parts = name.split("::")
    for i, p in enumerate(parts):
        node = next((n for n in body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                     and n.name == p), None)
        if node is None:
            return None
        if i == len(parts) - 1:
            return (node.decorator_list[0].lineno if node.decorator_list else node.lineno), node.end_lineno
        body = node.body
    return None


@functools.cache
def _defs(path):
    """ファイルの行と、直下の関数とクラスのメソッドの名前ごとの構文木（同じ名前は先に出たもの）。"""
    lines, tree = _parsed(path)
    out = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.setdefault(node.name, node)
        elif isinstance(node, ast.ClassDef):
            for child in node.body:
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    out.setdefault(child.name, child)
    return lines, tree, out


def mutation_line(mutant, path, mutants_dir, src_dir):
    """変異が書き換えた最初の行の（元の版のファイルの行番号, 元の行, 書き換えた行）。読めなければ None。

    path は変異のファイルの、backend からのパス（app/…）。mutants_dir は差し込んだ版の、src_dir は元の版の backend の場所。
    mutmut を読み込まずに、差し込んだ版のファイルで元の関数（__mutmut_orig）と変異の関数を並べて比べる。
    """
    short = mutant.rsplit(".", 1)[1]
    fn = fn_of(short)
    lines, _tree, defs = _defs(os.path.join(mutants_dir, path))
    orig, mut = defs.get(fn + "__mutmut_orig"), defs.get(short)
    if orig is None or mut is None:
        return None
    o = lines[orig.lineno - 1:orig.end_lineno]
    n = lines[mut.lineno - 1:mut.end_lineno]
    n[0] = n[0].replace(short, fn + "__mutmut_orig", 1)
    first = next((op for op in difflib.SequenceMatcher(None, o, n, autojunk=False).get_opcodes() if op[0] != "equal"), None)
    if first is None:
        return None
    _tag, i1, _i2, j1, _j2 = first
    _src_lines, tree, _ = _defs(os.path.join(src_dir, path))
    if "ǁ" in fn:  # xǁクラスǁメソッド: そのクラスの中だけを探す（同じ名前のメソッドを別のクラスが持ちうる）
        _x, cls, name = fn.split("ǁ")
        owner = next((c for c in tree.body if isinstance(c, ast.ClassDef) and c.name == cls), None)
        body = owner.body if owner else []
    else:
        name, body = fn[2:], tree.body
    real = next((f for f in body if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)) and f.name == name), None)
    if real is None:
        return None

    def shown(lines, i):  # def の行の書き換え（既定値等）は、差し込んだ版の名前を元の名前に戻して見せる
        return lines[i].strip().replace(fn + "__mutmut_orig", name, 1) if i < len(lines) else ""

    return real.lineno + i1, shown(o, i1), shown(n, j1)
