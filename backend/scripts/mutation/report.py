"""変異テストの記録（gen.py・runner.py が書いたもの）を、層や道具に依らない表にする。backend の下で、測った版と同じ版の
チェックアウトで打つ（元のファイル・テスト関数の行・読み込みのときに呼ばれうる関数を、ここから読む）。

引数: 成果物を取ってきた場所（gh run download で mutation-<番号> のディレクトリが並ぶ所） 当て直しの成果物の場所（成果物ごとの
ディレクトリが並ぶ所。名前は問わない。当て直しが無ければ空のディレクトリ） 書き出すファイル
表の形は Stryker の結果の JSON（mutation-testing-elements の report schema の版2）で、Stryker が出す表と同じ読み方で読める。
変異ごとに場所・書き換え・結果・落としたテスト（killedBy）・通ったテスト（coveredBy）を、テストごとに場所を持つ。テストの id は
testFiles の定義を指す短い番号。標準に無い欄は、テストの定義の baselineFailed（その関数の基準で落ちた）だけ。config は、測った版
（revision）と層の並び（layers。.importlinter の layers を上から）を持つ。
結果の読み方:
- Killed: 変異で落ちたテストがある。集める時点で落ちたもの（変異が import やパラメータの組を壊した。素の版では集まる）と、
  テスト全体の当て直しで落ちたもの（importtime.py）も含み、statusReason で分ける。killedBy は、その関数の基準（変異を入れない版で
  同じテストの組み合わせを同じ並びで2回。plan.py）の2回とも通ったテストだけ。集める時点の失敗はファイルで記録されるので、
  そのファイルの中でその関数を通るテストにそろえる。当て直しで落ちたものは、記録のテストの外で見つけたので killedBy を空にする
  （テストごとの重なりの数を変えない）
- Survived: どのテストも落ちなかった。落ちたのが全部その関数の基準でも落ちるテストだったものも含む
- Timeout: 止まらなくなった（見つけた側）。RuntimeError: ほかの終わり方
- NoCoverage: どのテストも通らない（回していない）。Pending: 回し終えていない
- static: 読み込みのときに呼ばれうる関数の変異（importtime.py。記録はその呼び出しを、そのとき走っていたテスト1本にしか結ばない）
"""
import collections
import configparser
import glob
import json
import os
import subprocess
import sys

from _shared import def_span, fn_of, read_kills
from importtime import called_at_import, is_import_time

ART, RECHECK_ART, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
shard_dirs = sorted(glob.glob(os.path.join(ART, "mutation-*")))
rows = json.load(open(os.path.join(shard_dirs[0], "rows.json"), encoding="utf-8"))
stats = json.load(open(os.path.join(shard_dirs[0], "mutmut-stats.json"), encoding="utf-8"))
tbf = {k: set(v) for k, v in stats["tests_by_mangled_function_name"].items()}

results = {}
kills: collections.defaultdict[str, set[str]] = collections.defaultdict(set)
for d in shard_dirs:
    path = os.path.join(d, "results.jsonl")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            r = json.loads(line)
            results[r["mutant"]] = r
    read_kills(d, kills)
rechecked = {}
for d in glob.glob(os.path.join(RECHECK_ART, "*")):
    path = os.path.join(d, "results.jsonl")
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            r = json.loads(line)
            rechecked[r["mutant"]] = r["status"]


def base_fn(m):
    """基準（BASE1:<関数> 等）の名前から、その関数の名前。"""
    return m.partition(":")[2]


def expand(tests, fn):
    """落ちた記録を、その関数を通るテストの名前にそろえる（集める時点の失敗はファイルで記録される）。"""
    out = set()
    for t in tests:
        out |= {t} if "::" in t else {u for u in tbf.get(fn, ()) if u.startswith(t + "::")}
    return out


base_ran = {base_fn(m) for m in results if m.startswith("BASE1:")} & {base_fn(m) for m in results if m.startswith("BASE2:")}
baseline_failed = {f: expand(kills.get("BASE1:" + f, set()) | kills.get("BASE2:" + f, set()), f) for f in base_ran}

all_tests = set(stats["duration_by_test"]) | set().union(*baseline_failed.values(), *tbf.values())
test_ids = {t: str(i) for i, t in enumerate(sorted(all_tests))}


def ids(tests):
    return sorted((test_ids[t] for t in tests), key=int)


def judge(m):
    """回した変異の（結果・statusReason・killedBy のテスト）。"""
    fn = fn_of(m)
    r = results[m]
    s = r["status"]
    failed = expand(kills.get(m, set()), fn)
    credited = failed - baseline_failed.get(fn, set())
    if s in ("exit 2", "exit 3", "exit 4"):
        return "Killed", "集める時点で落ちた", credited
    if s == "killed" and (credited or not failed):
        return "Killed", None if failed else "落ちたテストの記録が無い", credited
    if s == "timeout":
        return "Timeout", None, set()
    if s in ("killed", "survived"):
        reason = "落ちたのは、その関数の基準でも落ちるテストだけ" if s == "killed" else None
        if rechecked.get(m, "survived") != "survived":
            return "Killed", "テスト全体の当て直しで落ちた", set()
        return "Survived", reason, set()
    return "RuntimeError", (r.get("stderr") or s), set()


called = called_at_import()
files: dict[str, dict] = {}
for path, m, ntests, _secs, line, old, new in rows:
    if path not in files:
        src = open(path, encoding="utf-8").read()
        files[path] = {"language": "python", "source": src, "mutants": [], "_lines": src.split("\n")}
    fn = fn_of(m)
    if line is None:
        loc = {"start": {"line": 1, "column": 1}, "end": {"line": 1, "column": 1}}
        old, new = "", "（書き換えた行を読めなかった）"
    else:
        text = files[path]["_lines"][line - 1]
        loc = {"start": {"line": line, "column": len(text) - len(text.lstrip()) + 1},
               "end": {"line": line, "column": len(text) + 1}}
    rec = {"id": m, "mutatorName": "mutmut", "location": loc, "replacement": new, "description": f"{old} → {new}",
           "static": is_import_time(fn, called)}
    covered = tbf.get(fn, set())
    if ntests == 0:
        rec["status"] = "NoCoverage"
    elif m not in results:
        rec["status"] = "Pending"
        rec["coveredBy"] = ids(covered)
    else:
        status, reason, killed_by = judge(m)
        rec["status"] = status
        if reason:
            rec["statusReason"] = reason
        if status == "Killed":
            rec["killedBy"] = ids(killed_by)
        rec["coveredBy"] = ids(covered)
        rec["testsCompleted"] = len(covered)
        rec["duration"] = round(results[m].get("seconds", 0) * 1000)
    files[path]["mutants"].append(rec)
for f in files.values():
    del f["_lines"]

failed_any = set().union(*baseline_failed.values())
test_files: dict[str, dict] = collections.defaultdict(lambda: {"tests": []})
for t in sorted(all_tests):
    path, _, name = t.partition("::")
    entry: dict = {"id": test_ids[t], "name": name}
    try:
        span = def_span(path, name.split("[")[0])
    except (OSError, SyntaxError):
        span = None
    if span:
        entry["location"] = {"start": {"line": span[0], "column": 1}, "end": {"line": span[1] + 1, "column": 1}}
    if t in failed_any:
        entry["baselineFailed"] = True
    test_files[path]["tests"].append(entry)

revision = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
cfg = configparser.ConfigParser()
cfg.read(".importlinter", encoding="ascii")
layers = [line.strip() for line in cfg["importlinter:contract:layers"]["layers"].splitlines() if line.strip()]
report = {"schemaVersion": "2", "thresholds": {"high": 80, "low": 60}, "projectRoot": "backend",
          "framework": {"name": "mutmut"}, "config": {"revision": revision, "layers": layers}, "files": files, "testFiles": test_files}
json.dump(report, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
counts = collections.Counter(m["status"] for f in files.values() for m in f["mutants"])
print("表", OUT, "変異", sum(counts.values()), dict(counts), "テスト", len(all_tests),
      "基準を回した関数", len(base_ran), "基準で落ちたテスト", len(failed_any))
