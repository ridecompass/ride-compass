"""変異テストの台本どうしが共有する読み方と判断（変異と基準の名前・記録・生き残りの判断・テスト関数の行・書き換えた行）。
台本と同じディレクトリから読む。"""
import ast
import collections
import difflib
import functools
import glob
import json
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
#: 台本の隣に置くと、測りがその中身だけを回す一覧の口（測りに渡す作業ブランチでだけ置く）。baseline.txt は基準だけ、
#: recheck.txt は並んだ変異にテスト全体を、only.txt は並んだ変異に記録のテストを当てる（plan.py・runner.py の説明）。
BASELINE_LIST = os.path.join(_HERE, "baseline.txt")
RECHECK_LIST = os.path.join(_HERE, "recheck.txt")
ONLY_LIST = os.path.join(_HERE, "only.txt")
LISTS = (BASELINE_LIST, RECHECK_LIST, ONLY_LIST)

#: 基準（変異を入れずに、その関数の変異と同じテストの組み合わせを同じ並びで回す）の種類。BASELINES は差し込んだ版を2回、
#: ORIGINAL は元の版（差し込んでいない版）。基準の回の名前は「<種類>:<関数>」。
BASELINES = ("BASE1", "BASE2")
ORIGINAL = "ORIG"


def baselines(functions, kinds=BASELINES):
    """関数ごとの基準の回の名前。"""
    return [f"{kind}:{fn}" for fn in functions for kind in kinds]


def baseline_of(name):
    """基準の回の名前なら（種類, 関数）、変異の名前なら None。"""
    kind, sep, fn = name.partition(":")
    return (kind, fn) if sep else None


def fn_of(mutant):
    """mutmut の変異の名前から、変異を作った関数の名前（mangled name）。"""
    return mutant.partition("__mutmut_")[0]


def split_name(name):
    """mutmut の関数か変異の名前から（モジュール, クラスか None, 関数）。"""
    module, _, short = fn_of(name).rpartition(".")
    if short.startswith("xǁ"):
        _x, cls, function = short.split("ǁ")
        return module, cls, function
    return module, None, short[2:]


def read_lines(path):
    """一覧のファイルの、空でない行。"""
    return [line.strip() for line in open(path, encoding="utf-8") if line.strip()]


def read_stats(directory="."):
    """mutmut の記録（mutmut-stats.json）の（関数ごとに通るテスト, テストごとの秒）。"""
    stats = json.load(open(os.path.join(directory, "mutmut-stats.json"), encoding="utf-8"))
    return stats["tests_by_mangled_function_name"], stats["duration_by_test"]


def read_results(path, results=None):
    """runner.py が書いた結果の JSONL を、変異（と基準）の名前ごとの記録へ足して返す。ファイルが無ければ足さない。"""
    results = {} if results is None else results
    if os.path.exists(path):
        with open(path, encoding="utf-8") as lines:
            for line in lines:
                r = json.loads(line)
                results[r["mutant"]] = r
    return results


def read_kills(directory, kills=None):
    """runner.py が kills/ に書いた落ちたテストの記録を、変異の名前ごとのテストの集合へ足して返す。

    集める時点の失敗は、テストでなく集める単位（ファイル・クラス）の名前で記録されるので、`::` で終わる名前にして
    expand がその下のテストへ広げる。
    """
    kills = collections.defaultdict(set) if kills is None else kills
    for f in glob.glob(os.path.join(directory, "kills", "*.tsv")):
        with open(f, encoding="utf-8") as lines:
            for line in lines:
                m, t, when = line.rstrip("\n").split("\t")
                kills[m].add(f"{t}::" if when == "collect" else t)
    return kills


def expand(tests, fn, tbf):
    """落ちた記録を、その関数を通るテストの名前にそろえる（集める単位の記録は、その下のテストへ広げる）。"""
    out = set()
    for t in tests:
        out |= {u for u in tbf.get(fn, ()) if u.startswith(t)} if t.endswith("::") else {t}
    return out


def baseline_failures(results, kills, tbf):
    """基準を回した関数ごとの、基準のどれかの回で落ちたテスト（途中で止まった測りでは、回し終えた回だけを見る）。"""
    ran = {b[1] for name in results if (b := baseline_of(name)) and b[0] in BASELINES}
    return {fn: expand(set().union(*(kills.get(name, set()) for name in baselines([fn]))), fn, tbf) for fn in ran}


def judge(record, failed, baseline_failed, rechecked="survived"):
    """回した変異の（結果・理由・見つけたテスト）。結果は Stryker の結果の名前（Killed・Survived・Timeout・RuntimeError）。

    failed はその変異の回で落ちたテスト（expand でそろえたもの）、baseline_failed はその関数の基準で落ちたテスト、rechecked は
    テスト全体の当て直し（importtime.py）の結果。落ちたテストが全部その関数の基準でも落ちるなら、変異と関係なく落ちていて
    気づいたとは言えないので生き残りに数え、見つけたテストは基準で落ちなかったものだけにする。集める時点で落ちたもの
    （変異が import やパラメータの組を壊した）と時間切れは気づいた側。
    """
    status = record["status"]
    credited = failed - baseline_failed
    if status in ("exit 2", "exit 3", "exit 4"):
        return "Killed", "集める時点で落ちた", credited
    if status == "killed" and (credited or not failed):
        return "Killed", None if failed else "落ちたテストの記録が無い", credited
    if status == "timeout":
        return "Timeout", None, set()
    if status in ("killed", "survived"):
        if rechecked != "survived":
            return "Killed", "テスト全体の当て直しで落ちた", set()
        return "Survived", "落ちたのは、その関数の基準でも落ちるテストだけ" if status == "killed" else None, set()
    return "RuntimeError", record.get("stderr") or status, set()


_PYTEST_PARAMS = re.compile(r"(::[A-Za-z_]\w*)\[.*\]$")


def function_of_test(nodeid):
    """テスト関数（pytest のパラメータの組を外した名前。vitest の it.each の行の名前にある [] は外さない）。"""
    return _PYTEST_PARAMS.sub(r"\1", nodeid)


def layer(path):
    """ファイル（表を書いた層の下からのパス）の層（app・src の直下のパッケージかモジュールの名前）。"""
    parts = path.split("/")
    return parts[1].removesuffix(".py") if len(parts) > 1 else path


def cell(s):
    """Markdown の表の欄に入れる文字列。"""
    return str(s).replace("|", "\\|").replace("\n", " ")


def def_lines(node):
    """関数・クラスの定義の、デコレータの行と終わりの行（1から数える）。"""
    return (node.decorator_list[0].lineno if node.decorator_list else node.lineno), node.end_lineno or node.lineno


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
            return def_lines(node)
        body = node.body
    return None


@functools.cache
def _defs(path):
    """ファイルの行と、直下の関数とクラスのメソッドの名前ごとの構文木（同じ名前は先に出たもの）。"""
    lines, tree = _parsed(path)
    out: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
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
    _module, cls, name = split_name(mutant)
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
    if cls:  # メソッドはそのクラスの中だけを探す（同じ名前のメソッドを別のクラスが持ちうる）
        owner = next((c for c in tree.body if isinstance(c, ast.ClassDef) and c.name == cls), None)
        body = owner.body if owner else []
    else:
        body = tree.body
    real = next((f for f in body if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)) and f.name == name), None)
    if real is None:
        return None

    def shown(lines, i):  # def の行の書き換え（既定値等）は、差し込んだ版の名前を元の名前に戻して見せる
        return lines[i].strip().replace(fn + "__mutmut_orig", name, 1) if i < len(lines) else ""

    return real.lineno + i1, shown(o, i1), shown(n, j1)
