"""変異テストの表（Stryker の結果の JSON の形。backend は report.py が書く）から、テストの見直しの候補を出す
（.claude/rules/testing-review.md「テストを変異テストで見直す」）。backend の下で、測った版と同じ版のチェックアウトで打つ
（層の並びと、テスト関数の中身を読む）。

引数: 表のファイル 前回の見直しの場所（review.json がある所。無ければ空のディレクトリ） 書き出す場所
書くもの（書き出す場所）:
- review.json: 測った版・前回の版・回し終えたか・変異の数・候補（観点ごと）・判断できずに残したテストの理由
- candidates.md: 候補を観点ごとに1件1行で並べた表。「落ちると利用者に何が壊れるか」の欄を空けて出す。候補は消す一覧ではなく、
  人が1件ずつその欄を書いてから、消す・足す・直すを決める
- summary.md: 実行の要約に出す表（層ごとの変異スコア・テストの区分・観点ごとの候補の数）

候補（隔離のほかは、1件ごとに空の breaks の欄を持つ。隔離は汚した側を探して直すもので、壊れるものでは決めない）:
- effect（効き）: 生き残り（Survived）と、どのテストも通らない変異（NoCoverage）
- overlap（重なり）: 下の選び方で選んだテスト関数。前回の見直しでも重なりの候補で、中身が変わっていないものは previous が真
  （変異を回し終えていない測りでは、比べず、真にしない）
- isolation（隔離）: 基準で落ちたテスト（表の baselineFailed）
- writing（書き方）: 通るのに変異を1つも見つけないテスト・100本以上のテストが一緒に落ちる書き換えでしか落ちないテスト

重なりの選び方（testing-review.md の重なりの 1〜3）:
- テストの高さは、通る変異のファイルの層（.importlinter の layers）の一番上。200本以上のテストが通る変異（足場）と、読み込みの
  ときに呼ばれうる変異（static）は数えない。数える変異が無いテストは判断できないので残す。
- 判断できないものは残す: static の変異を見つけるテスト・基準で落ちたテスト（隔離の候補）。変異を1つも見つけないテストは
  比べようがないので候補にしない（書き方の候補に出す）。
- API の経路（app/api/routers の関数）ごとに、それを通るテストを1本は残す。表は関数の名前を持たないので、経路のファイルの変異を
  通るテストの組ごとに数える（同じ関数の変異は、同じテストの組に通られる）。
- 低い高さから順に、同じ高さ以下の残すテストで見つからない変異を多く見つける順に残し、何も足さないものを候補にする。
- 候補はテスト関数ごと: パラメータの組の1つでも残すなら、その関数は候補にしない。
"""
import collections
import configparser
import functools
import hashlib
import heapq
import json
import math
import os
import sys

REPORT, PREV, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
SCAFFOLD_TESTS = 200
BROAD_TESTS = 100
ROUTES = "app/api/routers/"
LIST_IN_SUMMARY = 60
os.makedirs(OUT, exist_ok=True)

report = json.load(open(REPORT, encoding="utf-8"))
name_of = {}
span_of = {}
baseline_failed = set()
for path, tf in report.get("testFiles", {}).items():
    for d in tf["tests"]:
        t = f"{path}::{d['name']}"
        name_of[d["id"]] = t
        loc = d.get("location")
        if loc and loc.get("end"):
            span_of[t] = (path, loc["start"]["line"], loc["end"]["line"])
        if d.get("baselineFailed"):
            baseline_failed.add(t)
mutants = {m["id"]: dict(m, file=path) for path, f in report["files"].items() for m in f["mutants"]}
DETECTED = ("Killed", "Timeout")
ran = {k for k, m in mutants.items() if m["status"] not in ("Pending", "NoCoverage")}


def tests(m, key):
    return {name_of[i] for i in m.get(key, ())}


def key_of(nodeid):
    """テスト関数（パラメータの組を外した名前）。"""
    return nodeid.split("[")[0]


# 層の高さ。.importlinter の layers は上から並ぶので、下ほど低い。
cfg = configparser.ConfigParser()
cfg.read(".importlinter", encoding="ascii")
layers = [line.strip() for line in cfg["importlinter:contract:layers"]["layers"].splitlines() if line.strip()]
rank = {name.strip(): len(layers) - 1 - i for i, line in enumerate(layers) for name in line.split("|")}


def layer(path):
    """ファイルの層（app の直下のパッケージかモジュールの名前）。"""
    parts = path.split("/")
    return parts[1].removesuffix(".py") if len(parts) > 1 else path


found = collections.defaultdict(set)
covering = collections.defaultdict(set)  # 通る変異（回していない変異も。高さに使う）
heights_of = collections.defaultdict(set)
for k, m in mutants.items():
    covered = tests(m, "coveredBy")
    for t in tests(m, "killedBy"):
        found[t].add(k)
    for t in covered:
        covering[t].add(k)
    h = rank.get(layer(m["file"]))
    if h is not None and not m.get("static") and len(covered) < SCAFFOLD_TESTS:
        for t in covered:
            heights_of[t].add(h)
heights = {t: max(heights_of[t]) if heights_of[t] else None for t in found}
height_of = {t: h for t, h in heights.items() if h is not None}  # 高さの決まるテストだけ

judge = set(found)
why_kept = {}
for t in judge:
    if any(mutants[m].get("static") for m in found[t]):
        why_kept[t] = "読み込みのときに呼ばれうる関数の変異を見つける"
    elif t in baseline_failed:
        why_kept[t] = "基準で落ちた（隔離）"
    elif heights[t] is None:
        why_kept[t] = "高さを決める関数が無い"
by_key = collections.defaultdict(set)
for t in judge:
    by_key[key_of(t)].add(t)


def close_siblings(kept):
    """残すテストの、同じテスト関数のパラメータの組も残す。"""
    for k in {key_of(t) for t in kept}:
        kept |= by_key[k]
    return kept


forced = close_siblings(set(why_kept))
routes: dict[tuple[str, ...], set[str]] = {}
for m in sorted(mutants.values(), key=lambda m: (m["file"], m["location"]["start"]["line"])):
    if m["file"].startswith(ROUTES) and m.get("coveredBy"):
        routes.setdefault(tuple(m["coveredBy"]), tests(m, "coveredBy"))
for through in routes.values():
    if any(t not in judge or t in forced for t in through):
        continue  # 何も見つけないテスト（候補にしない）か、もう残すテストが通っている
    pick = min((t for t in through if heights[t] is not None),
               key=lambda t: (heights[t], -len(found[t]), t), default=None)
    if pick:
        why_kept[pick] = "API の経路を通る1本"
        forced = close_siblings(forced | {pick})

kept = set(forced)
redundant = set()
cov = set()
for h in sorted({v for v in heights.values() if v is not None}):
    level = [t for t in judge if heights[t] == h]
    for t in level:
        if t in kept:
            cov |= found[t]
    # 足す変異の多い順に残す（足す数は残すたびに減るだけなので、取り出したときに数え直して、減っていなければ一番多い）。
    heap = [(-len(found[t] - cov), t) for t in level if t not in kept]
    heapq.heapify(heap)
    while heap:
        neg, t = heapq.heappop(heap)
        gain = len(found[t] - cov)
        if gain == 0:
            redundant.add(t)
        elif gain < -neg:
            heapq.heappush(heap, (-gain, t))
        else:
            kept.add(t)
            cov |= found[t]
kept = close_siblings(kept)
cand_keys = sorted(k for k, ts in by_key.items() if ts <= redundant and not ts & kept)

# 確かめ: 候補の見つける変異は、全部、同じ高さ以下の残すテストが見つける。
kept_found_by_height: dict[int, set[str]] = collections.defaultdict(set)
for t in kept:
    if t in height_of:
        kept_found_by_height[height_of[t]] |= found[t]
kept_found_at_or_below: dict[int, set[str]] = {}
below: set[str] = set()
for h in sorted(set(kept_found_by_height) | {v for v in heights.values() if v is not None}):
    below = below | kept_found_by_height.get(h, set())
    kept_found_at_or_below[h] = below
violations = [t for k in cand_keys for t in by_key[k] if not found[t] <= kept_found_at_or_below[height_of[t]]]
if violations:
    raise SystemExit(f"低い方に残すの確かめに反する候補 {len(violations)} 件: {violations[:5]}")

finders_kept = collections.defaultdict(list)
for t in sorted(kept):
    for m in found[t]:
        finders_kept[m].append(t)


@functools.cache
def source_of(key):
    """テスト関数の中身（デコレータから）のハッシュと行数。場所が無いか読めなければ（None, 0）。"""
    span = span_by_key.get(key)
    if span is None:
        return None, 0
    path, start, end = span
    try:
        lines = open(path, encoding="utf-8").read().split("\n")[start - 1:end - 1]
    except OSError:
        return None, 0
    return hashlib.sha1("\n".join(lines).encode()).hexdigest()[:12], len(lines)


span_by_key: dict[str, tuple[str, int, int]] = {}
for t in sorted(span_of):
    span_by_key.setdefault(key_of(t), span_of[t])
prev_path = os.path.join(PREV, "review.json")
prev = json.load(open(prev_path, encoding="utf-8")) if os.path.exists(prev_path) else None
prev_overlap = {c["test"]: c["hash"] for c in prev["candidates"]["overlap"]} if prev else {}
complete = not any(m["status"] == "Pending" for m in mutants.values())  # 途中で止まった測りは、候補が欠けるので比べない
overlap = []
for k in cand_keys:
    digest, n = source_of(k)
    t = min(by_key[k])
    m = min(found[t], key=lambda x: (len(finders_kept[x]), x))
    witness = next(u for u in finders_kept[m] if u in height_of and height_of[u] <= height_of[t])
    overlap.append({"test": k, "hash": digest, "lines": n, "height": height_of[t], "mutant": m, "kept_test": witness,
                    "previous": bool(complete and digest and prev_overlap.get(k) == digest), "breaks": ""})

instances = collections.defaultdict(set)
for t in set(covering) | judge:
    instances[key_of(t)].add(t)


def whole(group):
    """全部のパラメータの組が group に入るテスト関数。"""
    return sorted(k for k in {key_of(t) for t in group} if instances[k] <= group)


finders = collections.Counter(m for t in found for m in found[t])
covered_ran = {t for t, ms in covering.items() if ms & ran}
zero = {t for t in covered_ran if not found.get(t)}
broad_only = {t for t in found if all(finders[m] >= BROAD_TESTS for m in found[t])}
writing = [{"test": k, "lines": source_of(k)[1], "form": form, "breaks": ""}
           for form, group in (("通るのに何も見つけない", zero), ("広くしか落ちない", broad_only)) for k in whole(group)]
effect = [{"mutant": k, "file": m["file"], "line": m["location"]["start"]["line"], "change": m.get("description", ""),
           "status": m["status"], "static": bool(m.get("static")), "breaks": ""}
          for k, m in sorted(mutants.items(), key=lambda x: (x[1]["file"], x[1]["location"]["start"]["line"], x[0]))
          if m["status"] in ("Survived", "NoCoverage")]
isolation = [{"test": k} for k in sorted({key_of(t) for t in baseline_failed})]

measured = report.get("config", {}).get("revision", "")
counts = collections.Counter(m["status"] for m in mutants.values())
review = {"measured": measured, "previous": prev["measured"] if prev else None, "complete": complete,
          "mutants": dict(counts),
          "candidates": {"effect": effect, "overlap": overlap, "isolation": isolation, "writing": writing},
          "kept_reasons": dict(collections.Counter(why_kept.values()))}
json.dump(review, open(os.path.join(OUT, "review.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)


def cell(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def wilson(k, n):
    if n == 0:
        return (0, 0)
    z = 1.96
    p = k / n
    c = (p + z * z / (2 * n)) / (1 + z * z / n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (c - h, c + h)


def kind(m):
    """層ごとの表の列。Killed は statusReason で分ける。"""
    reason = m.get("statusReason", "")
    if m["status"] == "Killed":
        return {"集める時点で落ちた": "collect", "テスト全体の当て直しで落ちた": "full"}.get(reason, "killed")
    return m["status"]


by: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
for m in mutants.values():
    for name in (layer(m["file"]), "全体"):
        by[name][kind(m)] += 1
md = [f"## テストの見直し（測った版 `{measured[:9]}`、前回 `{(prev['measured'] if prev else '無し')[:9]}`）", "",
      "### 効き: 層ごとの変異スコア", "",
      "| 層 | 回した変異 | 落ちた | 集める時点で落ちた | 時間切れ | テスト全体で落ちた | 生き残り | ほか | スコア | 95%の幅 |"
      " テストの当たらない変異 | 回し終えていない |", "|---|" + "---:|" * 11]
for name in sorted(by, key=lambda x: (x == "全体", x)):
    c = by[name]
    det = c["killed"] + c["collect"] + c["Timeout"] + c["full"]
    n = det + c["Survived"] + c["RuntimeError"]
    lo, hi = wilson(det, n)
    md.append(f"| {name} | {n} | {c['killed']} | {c['collect']} | {c['Timeout']} | {c['full']} | {c['Survived']} | "
              f"{c['RuntimeError']} | {det / n if n else 0:.1%} | {lo:.1%}〜{hi:.1%} | {c['NoCoverage']} | {c['Pending']} |")


def total_lines(group):
    return sum(source_of(k)[1] for k in {key_of(t) for t in group})


all_tests = set(name_of.values())
unique = {t for t in found if any(finders[m] == 1 for m in found[t])}
remaining = set(finders)
chosen = set()
# 全部の発見を保つ最小の組の目安（貪欲法）。足す変異の多い順（同じなら名前の大きい順）に選ぶ。
order = {t: i for i, t in enumerate(sorted(found))}
greedy = [(-len(found[t]), -order[t], t) for t in found]
heapq.heapify(greedy)
while remaining:
    neg, rank_t, t = heapq.heappop(greedy)
    gain = len(found[t] & remaining)
    if gain < -neg:
        heapq.heappush(greedy, (-gain, rank_t, t))
        continue
    chosen.add(t)
    remaining -= found[t]
groups = [("全体（収集した）", all_tests), ("どの変異も通らない", all_tests - set(covering)), ("回した変異を通る", covered_ran),
          ("通るのに変異を1つも見つけない", zero), ("1つ以上見つけた", set(found)),
          ("見つけたものが全部ほかでも見つかる", set(found) - unique), ("ほかに無い発見を持つ", unique),
          ("全部の発見を保つ最小の組（貪欲法）", chosen), ("100本以上が一緒に落ちる書き換えだけで落ちた", broad_only)]
md += ["", "### テストの区分", "", "| 区分 | テスト | テスト関数 | 行数 |", "|---|---:|---:|---:|"]
md += [f"| {name} | {len(s)} | {len({key_of(t) for t in s})} | {total_lines(s)} |" for name, s in groups]
both = [c for c in overlap if c["previous"]]
md += ["", "### 候補（1件ずつ「落ちると利用者に何が壊れるか」を書いてから決める。成果物の candidates.md）", "",
       "| 観点 | 件数 | テスト関数の行数 |", "|---|---:|---:|",
       f"| 効き: 生き残り・どのテストも通らない変異 | {len(effect)} | |",
       f"| 重なり: 今回の候補 | {len(overlap)} | {sum(c['lines'] for c in overlap)} |",
       f"| 重なり: そのうち前回も候補で中身が同じ | {len(both)} | {sum(c['lines'] for c in both)} |",
       f"| 隔離: 基準で落ちた | {len(isolation)} | {sum(source_of(c['test'])[1] for c in isolation)} |"]
md += [f"| 書き方: {form} | {sum(1 for c in writing if c['form'] == form)} | "
       f"{sum(c['lines'] for c in writing if c['form'] == form)} |" for form in ("通るのに何も見つけない", "広くしか落ちない")]
md += ["", f"判断できずに重なりの候補にしなかったテスト: {review['kept_reasons']}", ""]
if not complete:
    md += [f"変異を回し終えていない（回し終えていない {counts['Pending']} 件）ので、前回と比べず、次の見直しの前回にもしない。", ""]
if prev and prev["measured"] == measured:
    md += ["前回と同じ版を測ったので、前回も候補だったことは、2回続けての確かめになっていない。", ""]
if both:
    md += ["### 重なり: 前回も候補で中身が同じ", ""] + [f"- `{c['test']}`" for c in both[:LIST_IN_SUMMARY]]
    if len(both) > LIST_IN_SUMMARY:
        md.append(f"- ほか {len(both) - LIST_IN_SUMMARY} 件（成果物 mutation-review の candidates.md）")
    md.append("")
per_file: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
for t in all_tests:
    r = per_file[t.partition("::")[0]]
    r["テスト"] += 1
    r["通らない"] += t not in covering
    r["見つけない"] += t in zero
    r["ほかに無い"] += t in unique
    r["最小の組"] += t in chosen
    r["広くだけ"] += t in broad_only
flines = {f: total_lines({t for t in all_tests if t.startswith(f + "::")}) for f in per_file}
md += ["### テストのファイルごと（行数の多い順）", "",
       "| ファイル | テスト | 行数 | 変異が通らない | 通るのに見つけない | ほかに無い発見 | 最小の組 | 広くだけ |",
       "|---|" + "---:|" * 7]
md += [f"| {f} | {r['テスト']} | {flines[f]} | {r['通らない']} | {r['見つけない']} | {r['ほかに無い']} | {r['最小の組']} | "
       f"{r['広くだけ']} |" for f, r in sorted(per_file.items(), key=lambda x: (-flines[x[0]], x[0]))[:40]]
open(os.path.join(OUT, "summary.md"), "w", encoding="utf-8").write("\n".join(md) + "\n")

BREAKS = "落ちると利用者に何が壊れるか"
cand = [f"# テストの見直しの候補（測った版 `{measured[:9]}`）", "",
        f"候補は消す一覧ではない。1件ずつ「{BREAKS}」を書いてから、消す・足す・直すを決める"
        "（.claude/rules/testing-review.md「テストを変異テストで見直す」）。", "",
        "## 重なり（前回も候補で中身が同じものを先に）", "",
        f"| テスト関数 | 前回も | 行数 | 高さ | 見つける変異の1つ | それを見つける残すテスト | {BREAKS} |", "|---|---|---:|---:|---|---|---|"]
cand += [f"| `{c['test']}` | {'◯' if c['previous'] else ''} | {c['lines']} | {c['height']} | `{c['mutant']}` | `{c['kept_test']}` | |"
         for c in sorted(overlap, key=lambda c: (not c["previous"], c["test"]))]
cand += ["", "## 効き（この書き換えが入っても、どのテストも落ちない）", "",
         f"| ファイル | 行 | 書き換え | 結果 | 読み込みのとき | {BREAKS}（書き換えが入ると） |", "|---|---:|---|---|---|---|"]
cand += [f"| `{c['file']}` | {c['line']} | {cell(c['change'])} | {c['status']} | {'◯' if c['static'] else ''} | |" for c in effect]
cand += ["", "## 書き方", "", f"| テスト関数 | 形 | 行数 | {BREAKS} |", "|---|---|---:|---|"]
cand += [f"| `{c['test']}` | {c['form']} | {c['lines']} | |" for c in writing]
cand += ["", "## 隔離（基準で落ちた。汚した側を探して直す）", ""] + [f"- `{c['test']}`" for c in isolation]
open(os.path.join(OUT, "candidates.md"), "w", encoding="utf-8").write("\n".join(cand) + "\n")
print("\n".join(md))
if os.environ.get("GITHUB_OUTPUT"):  # ワークフローが、回し終えた測りの見直しだけを成果物に残す
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
        f.write(f"complete={'true' if complete else 'false'}\n")
