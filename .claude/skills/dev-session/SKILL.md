---
name: dev-session
description: "開発機の対話のセッションでタスクを進める決まり（対話作業の issue でタスクを持つ・本番へ書く・裏の作業役に任せる・担当との違い）。開発機でタスクを触る前に使う。"
---

## 開発機の対話のセッション

導く原則: 1・3・7。

開発機の対話のセッション（と、それが任せる裏の作業役）も、.claude/skills/task-work/SKILL.md の「実装担当」「検証担当」の手順で進める。
違いは次の表のとおりで、表に無いことは担当と同じ。

| 項目 | 担当（Actions） | 開発機の対話のセッション |
|---|---|---|
| タスクを持つ | 担当の実行がある間、ゲートがその担当の種類（実装・検証）にして振り出さない | ラベル「開発機で作業中」を付けて持つ（下の「持つ」） |
| 依存 | 担当のワークフローが入れてある | 要る道具を動かすときだけ、作業ツリーごとに `npm ci --prefix frontend` から入れる（docs/architecture/setup.md「作業ツリーどうしで node_modules を共有しない」）。backend は .claude/skills/run-checks/SKILL.md「開発機でのbackendテストの回し方」 |
| 本番 | 接続情報を持たない（`docs/conventions/flow.md`「自動で進めないもの」） | 読める（`run_probe.py`）。書くのは下の「本番へ書く」 |
| マージ | 検証担当がマージする | 検証担当と同じ確かめ（.claude/skills/task-work/SKILL.md「検証担当」の1〜5）を自分でして、満たしていれば聞かずにマージする。ワークフローのファイル（`.github/workflows/`）を変える Pull Request は、開発機の gh のトークンに `workflow` の権限が無いので、ユーザーがブラウザでマージする |
| 答え | 回答フォーム | ユーザーがチャットで決めたことを、Claude が issue に記録する（.claude/skills/ask/SKILL.md「答え」。答えを待つ問いがあれば `answer.mjs` で） |

- **決まりの出どころ**: どちらも CLAUDE.md と、そこから指す docs/・`.claude/` の rules・skills・commands と `.claude/settings.json` のフックを読む。
  権限だけは使う人が決めるもので、担当は `.github/claude-task/settings.json`、開発機はユーザー自身の `~/.claude/settings.json` が持つ
  （`docs/conventions/flow.md`「担当の権限」）。開発機にしか無い置き場（ユーザーの CLAUDE.md・`.claude/settings.local.json`・自動の記憶）には決まりを置かない。
- **持つ**: タスクを触る（issue へ書く・作業ブランチへ push する・Pull Request を出す・マージする）前に、そのタスクにラベル「開発機で作業中」
  （`tools/flow-gate/flow.config.json: devLabel`）を付ける（付いている間は振り出されず、担当者は Claude）。自分で起こして持つ issue は、起こすときに `new-issue.mjs --hold` で付ける。担当の実行が動いている（欄「実行の status」がある）
  なら、終わるまで触らない。触り終えたら、やったことをそのタスクの issue に書き、ラベルを外す（外し忘れると、タスクは振り出されないまま残る）。
  対話作業の issue（開発機でしかできない約束のある作業）も同じに持ち、果たした条件にチェックを付ける（条件が全部済めばゲートが閉じる）。
- **裏の作業役に任せる**: その場で手順を書き起こさず、task-work の担当の手順で進めるよう渡し、対話作業の issue を閉じない・問いを書かない、とだけ足す。
- **戻せない操作**（本番への書き込み・消す）は、対象・中身・差（前 → 後）・戻せないことと、それで何が起きうるかをチャットで見せ、
  ユーザーの言葉をもらってから進める。
- **本番へ書く**: 打つスクリプトは開発機の `C:\Users\h7g4b\ride-compass-ops\`（コミットしない）へ置く。
  - 書く・作り直す・設定を変える・消す: ユーザーがその操作をチャットで言ったときだけ、Claude が打つ。

  打ったあと、前後に読んで比べるもの（`run_probe.py` の読み取り等）で確かめ、ユーザーの言葉と結果を issue に記録する。
