"""変異ごとの当てるテストと、かかる時間の見込みを出し、回す変異の一覧を書く。backend/mutants の下で打つ。

書くもの（環境変数 MUT_OUT の場所）:
- rows.json: 変異ごとの（ファイル・変異・当てるテストの数・記録の段で測ったテストの秒の合計・書き換えた行の番号・元の行・
  書き換えた行）。行を読めなかった変異は、行の3つが null
- all.txt: テストの当たる変異を全部、種を固定した無作為の並びで。分けて回すときは行を順に配る（ランナーごとに
  無作為の標本になり、途中で止まっても回した分が偏らない）。環境変数 MUT_WITH_BASELINE があれば、関数ごとの基準も混ぜる。
  この台本の隣に一覧（recheck.txt・only.txt）があれば、その中身
テストの当たらない変異は回しても見つけようがないので、all.txt に入れず別に数える。
"""
import collections
import glob
import json
import os
import random

from _shared import BASELINE_LIST, BASELINES, ONLY_LIST, ORIGINAL, RECHECK_LIST, baselines, fn_of, layer, mutation_line, \
    read_lines, read_stats

OUT = os.environ["MUT_OUT"]
tbf, dur = read_stats()


def shuffled(names):
    """種を固定した無作為の並び。"""
    random.Random(661).shuffle(names)
    return names


rows = []
for f in glob.glob("app/**/*.meta", recursive=True):
    for k in json.load(open(f, encoding="utf-8"))["exit_code_by_key"]:
        tests = tbf.get(fn_of(k), [])
        path = f[:-5].replace("\\", "/")
        where = mutation_line(k, path, ".", "..") or (None, None, None)
        rows.append((path, k, len(tests), sum(dur.get(t, 0) for t in tests), *where))
json.dump(rows, open(os.path.join(OUT, "rows.json"), "w", encoding="utf-8"), ensure_ascii=False)
print("変異", len(rows), "テストの当たらない変異", sum(1 for r in rows if r[2] == 0),
      "テストの秒の合計", round(sum(r[3] for r in rows)), "行を読めなかった変異", sum(1 for r in rows if r[4] is None))
by: dict[str, list[float]] = collections.defaultdict(lambda: [0, 0, 0.0])
for f, _k, c, s, *_where in rows:
    by[layer(f)][0] += 1
    by[layer(f)][1] += c == 0
    by[layer(f)][2] += s
for name, v in sorted(by.items()):
    print(name, v[0], v[1], round(v[2]))
pool = shuffled(sorted(r[1] for r in rows if r[2] > 0))
tested = sorted({fn_of(m) for m in pool})
# 一覧があれば、それだけを回す。recheck.txt は runner.py がテスト全体を当てる（importtime.py の説明）。only.txt は
# 記録のテスト（その関数を通るテスト）で回す——テストを消したあと、消したテストが見つけていた変異を残る側が
# 落とすかを確かめる。両方あれば recheck.txt を使う。
# baseline.txt があれば、変異を入れない基準を回す（runner.py の説明）。行は関数の名前（mutmut の mangled name）か、
# 全部の関数なら「*」。「+orig」の行があれば、元の版（差し込んでいない版）の基準も回す。
if os.path.exists(BASELINE_LIST):
    lines = read_lines(BASELINE_LIST)
    funcs = tested if "*" in lines else [f for f in tested if f in lines]
    pool = shuffled(baselines(funcs, BASELINES + ((ORIGINAL,) if "+orig" in lines else ())))
    open(os.path.join(OUT, "all.txt"), "w", encoding="utf-8").write("\n".join(pool) + "\n")
    print("baseline.txt の基準を回す", len(funcs), "関数", len(pool), "件")
    raise SystemExit(0)
for listed in (RECHECK_LIST, ONLY_LIST):
    if os.path.exists(listed):
        pool = read_lines(listed)
        print(os.path.basename(listed), "の一覧を回す")
        break
else:
    # 環境変数 MUT_WITH_BASELINE があれば、全部の変異に、テストの当たる関数ごとの基準（BASE1・BASE2）を混ぜて1つの一覧にする
    # （定期の測り。.github/workflows/mutation.yml。report.py が基準で落ちたテストを見つけたに数えない）。
    if os.environ.get("MUT_WITH_BASELINE"):
        pool = shuffled(pool + baselines(tested))
        print("基準を混ぜる", len(tested), "関数")
open(os.path.join(OUT, "all.txt"), "w", encoding="utf-8").write("\n".join(pool) + "\n")
print("all.txt", len(pool), "件")
