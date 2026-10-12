---
name: production-data
description: "本番の派生データを作り直す・本番へ軸定義の変更を入れる・DBのバックアップを登録する・本番DBを失ったときに戻す手順。本番のデータに触る作業の前に使う。"
---

## 派生データの作り直し

- 対象: 管理画面の「派生データの鮮度」が作り直し待ちを出したとき（古い理由がどれであっても打つのは同じ
  1コマンド。`app/batch/derive_cli.py`が段の順に作り直す単一の入口）。
- ルール: **本番VM（SSHで入る）で、稼働中のbackendコンテナではなく別のコンテナをメモリ上限付きで立てて**
  打つ:

  ```
  sudo docker run --rm --network=host --memory=4g \
    -v /home/ubuntu/ridecompass-cache-data:/app/data \
    --env-file /home/ubuntu/ridecompass-backend.env \
    ridecompass-backend:latest \
    python -m app.batch.derive_cli
  ```

- 住所の区画の段は、住所の生データ（`abr`）の取込が無いと止まり、作り直し全体が何も入れ替えない。初めて流す前と住所を取り直すときは、
  同じ別のコンテナで取得と取込を先に打つ（手順は[data-sources.md](../../../docs/architecture/data-sources.md)「住所の区画の元データ」）。

- **`/app/data`のマウントを外さない**（同じ入口が道路網全体の配列`data/road_network/`を作ってから表を入れ替える。配列は本番で数分かかる）。
  途中で落ちたとき（配列を作れなかったときを含む）は何も入れ替わらないので、原因を直して打ち直す。
- 取込（`app.batch.ingest_cli`）は派生の表・派生の世代・道路網の配列を変えない。取り込んだら続けて派生を作り直す。
- 作り直しは、入力（読むソースの取込・前の段・較正値・書く表の列・段のコード・実行環境の版）が前回の作り直しと同じ段を
  流さず、ログに「段 <名前> を飛ばした」と出す。全部の段が同じなら何も入れ替えずに終える。段を選んで流す口は無く、
  どの場面（取り直した・段のやり方を変えた・較正値を変えた・列を足した）でも上の1コマンドを打つ。
- 取込と作り直しは同時に走らない（後から始めた方が止まる。終わってから打ち直す）。DBのバックアップの書き出し（毎日03:17（日本時間）から
  30分ほど）の間に打った取込と作り直しも止まる。仕組みは[静的道路属性](../../../docs/modules/backend/static-road-attributes.md)「派生」。

## 本番へ効かせたい軸定義の変更は、本番の管理APIへ入れる

- 対象: `axis_admin`のAPI（各環境の軸スタジオGUI、直接API呼び出し、または下の道具）経由で
  `axis_definitions`等のDB行データを変更する全ての作業。
- ルール: **DBは環境ごとに独立していて、その環境の管理画面がそのDBをメンテナンスする**。
  開発DBだけ変えてタスクを完了扱いにしない
  ——本番へ効かせるなら本番の軸スタジオか、次の道具で行う。環境間で内容を転送する仕組みは持たない。
  **リポジトリは軸の写しを持たない**ため、再ダンプの手順は無い。
- 変える中身が決まっている変更（タスクで値を決めた軸の書き換え・追加・削除）は、軸1本の定義のJSONを作り、
  `backend/scripts/axis_apply.py`で入れる
  （仕組みは[axis-studio.md](../../../docs/modules/backend/axis-studio.md)「軸の定義をファイルから本番へ入れる」）:

  ```
  python scripts/axis_apply.py <JSONのパス>               # 差を出すだけ
  python scripts/axis_apply.py <JSONのパス> --apply <指紋>  # 書く
  python scripts/axis_apply.py --delete <axis_id> [--apply <指紋>]
  ```

  担当は打たず、開発機の対話のセッションがユーザーがチャットで言ったときだけ打つ
  （[dev-session/SKILL.md](../dev-session/SKILL.md)「本番へ書く」）。差（項目ごとの「前 → 後」）と指紋をチャットで見せ、書くよう言われてから、同じ指紋で書く。宛先は
  リポジトリの`production-origins.json`から読み、認証情報は`backend/.env.oracle.local`の`ADMIN_BASIC_AUTH_USERNAME`・
  `ADMIN_BASIC_AUTH_PASSWORD`に置く。JSONは`docs/records/`へ置かない（記録はタスクの issue に書く）。
  本番の写しとして直し続けない（次に変えるときは本番の今の定義から新しいJSONを作る）。
- 完了の条件: 道具が「反映を確かめました」を出したこと。
  画面で変えたときは、本番の`GET /api/axis-catalog`で変えた軸を確かめる。

## 付録

作業の前には読まない。一度きりの準備（登録）と、災害時の手順。

### DBのバックアップ

- 対象: 本番DBの全体（管理画面で積み上げた軸の定義・較正値の上書き、生データ・派生データ）。
  仕組みは[横断基盤](../../../docs/modules/backend/cross-cutting-infrastructure.md)「本番DBのバックアップ」。
- ルール: 本番VMのsystemdのtimerが毎日03:17（日本時間）に、DBの全体を`pg_dump`（custom形式・圧縮あり）して、
  Oracle Cloud Object Storageの非公開バケットへ`db/<UTCの時刻>.dump`として置き、前の回のものを消す。残すのは、バケットに
  1個（無料の枠の10GBに1個だけ入る）と、VMのDBのディスクの`/mnt/pgdata/ridecompass-backup/latest.dump`に1個。
  置けたら時刻を書き、backendの`/health`が`admin_data_backup_age_hours`（最後に置けてからの時間）を返す。
  **VMを作り直したら、下の登録の1.〜4.をやり直す**。
- 登録（1回。Oracle Cloudのコンソールと、VMにSSHで入って打つ）:
  1. バケットを作る: コンソールの Storage → Buckets で、ホームリージョンに
     標準の層・既定の見え方（公開しない）で作る（例: `ridecompass-admin-data`）。ネームスペースは同じ画面か、
     テナンシの詳細の「Object Storage namespace」に出る。
  2. VMを動的グループに入れる: Identity → Dynamic groups で、ルール`instance.id = '<VMのインスタンスのOCID>'`
     の動的グループを作る（例: `ridecompass-vm`。OCIDはコンソールのインスタンスの詳細に出る）。
  3. そのバケットのオブジェクトの一覧・作成・削除だけを許す: Identity → Policies で、バケットのあるコンパートメントに次の3文のポリシーを作る。
     ```
     Allow dynamic-group ridecompass-vm to manage objects in compartment <コンパートメント名> where all {target.bucket.name='ridecompass-admin-data', request.permission='OBJECT_INSPECT'}
     Allow dynamic-group ridecompass-vm to manage objects in compartment <コンパートメント名> where all {target.bucket.name='ridecompass-admin-data', request.permission='OBJECT_CREATE'}
     Allow dynamic-group ridecompass-vm to manage objects in compartment <コンパートメント名> where all {target.bucket.name='ridecompass-admin-data', request.permission='OBJECT_DELETE'}
     ```
     動的グループをDefault以外のアイデンティティ・ドメインに作ったときは、`dynamic-group '<ドメイン名>'/'ridecompass-vm'`と書く。
     バケットがテナンシのルートのコンパートメントにあるときは、`in compartment <コンパートメント名>`の代わりに`in tenancy`と書く
     （場所の書き方は公式の文書「Policy Syntax」の Location）。ルートを`compartment`で書くと、コンソールが
     `Compartment {<ルートの名前>} does not exist or is not part of the policy compartment subtree`で断る。
  4. VMで設定ファイルを置き、ユニットを登録し、1回打って確かめてからtimerを有効にする（ユニットはデプロイが
     揃える作業コピーのものを`systemctl link`で指す）:
     ```
     sudo mkdir -p /etc/ridecompass
     printf 'OCI_NAMESPACE=%s\nBACKUP_BUCKET=%s\n' '<ネームスペース>' 'ridecompass-admin-data' | sudo tee /etc/ridecompass/admin-data-backup.env
     sudo systemctl link /home/ubuntu/ridecompass-repo/backend/ops/ridecompass-admin-data-backup.service \
       /home/ubuntu/ridecompass-repo/backend/ops/ridecompass-admin-data-backup.timer
     sudo systemctl start ridecompass-admin-data-backup.service
     sudo journalctl -u ridecompass-admin-data-backup.service -n 30 --no-pager
     sudo systemctl enable --now ridecompass-admin-data-backup.timer
     systemctl list-timers ridecompass-admin-data-backup.timer
     ```
     1回は30分ほどかかる。`journalctl`の最後に「DBの全体を置きました object=db/…」が出て、コンソールのバケットにそのオブジェクトが
     1個だけ見え、`curl -fsS http://localhost:8000/health`の`admin_data_backup_age_hours`が0.0なら済み。
- 動いているかを見る: backendの`/health`の`admin_data_backup_age_hours`。詳しくはVMで`systemctl list-timers ridecompass-admin-data-backup.timer`
  （前回・次回）と`sudo journalctl -u ridecompass-admin-data-backup.service --since -2d`。

### 本番DBを失ったとき

- 対象: 本番DB（またはVMごと）を失った・誤操作で壊したとき。
- 戻る材料: 上の「DBのバックアップ」の書き出し1個。戻すと、DBは書き出した時点の全体（管理データ・生データ・派生データ）になる。
  それより後の管理画面の変更と取込は戻らないので、要るならやり直す。
- 戻すファイルを取る: VMが残っていれば`/mnt/pgdata/ridecompass-backup/latest.dump`を使う。VMを失ったときは、コンソールの
  Storage → Buckets → バケット → `db/`のオブジェクトをダウンロードし、`scp`で新しいVMのDBのディスク（例: `/mnt/pgdata/restore.dump`）へ送る。
- 戻す順番（本番VMで。DB名・利用者は`/home/ubuntu/ridecompass-backend.env`の`DATABASE_URL`のもの）:
  1. backendを止める: `sudo docker stop ridecompass-backend`（コンテナが無ければ飛ばす）
  2. DBが無ければ、利用者とDBを作る（利用者は書き出しに入らない）:
     ```
     sudo -u postgres createuser --pwprompt <利用者>
     sudo -u postgres createdb --owner=<利用者> <DB名>
     ```
  3. 戻す（表を作り直して行を入れる。数十分かかる）:
     ```
     sudo chmod 644 <ファイル>
     sudo -u postgres pg_restore --clean --if-exists --jobs=4 --dbname=<DB名> <ファイル>
     ```
  4. 書き出しのあとに派生を作り直していたら、道路網の配列の置き場（`/home/ubuntu/ridecompass-cache-data/road_network/`の中）を消す
     （戻したDBより新しい世代の置き場が残ると、backendはそれを読む）。
  5. `deploy-backend.yml`を`workflow_dispatch`で打つ（ラスタを取り、道路網の配列が無ければ作り、backendを起動する）。
     戻ったことを確かめる:
     ```
     curl -fsS http://localhost:8000/health
     curl -fsS http://localhost:8000/api/axis-catalog | head -c 300
     sudo docker logs --tail 50 ridecompass-backend 2>&1 | grep -E '軸定義|AxisDefinitionSyncError|TuningOverrideError'
     ```
     `/health`が応答し、ログに「軸定義をDBから読み込みました axes=<戻した軸の数>」が出ていれば済み。
  6. VMを作り直したときは、上の「DBのバックアップ」の登録の2.〜4.をやり直す（動的グループのルールはVMのOCIDを指す）。

## 厳選まで仮置き

原則の見直しで消えた記載を、厳選まで元の節ごとに仮に置く。**今の決まりと食い違えば今の決まりを取る。**

### 元: docs/conventions の deployment-sync.md

#### デプロイ・DB同期の作業標準

コード変更と本番環境（DB・デプロイ）の同期に関する作業標準をまとめる。個々のモジュールの設計・実装事実は
ここに書かない（`docs/modules/*.md`が正）。ここに書くのは「作業として何を完了条件に
含めるべきか」という運用ルールのみ。

本番DBを失ったときの作り直しは付録の「本番DBを失ったとき」（その材料は付録の「DBのバックアップ」）、
派生データの作り直しは「派生データの作り直し」。

#### コミットと同時に揃えるもの

コード変更と同期して更新すべきペアは、別のコミットに分けると片方が漏れる。次は**同一コミットで**実施する。

- **規模M以上でAPI・ドメイン概念・レイヤー種を新設するタスクは、完了条件へ
  docs/architecture/・docs/modules/の追従を既定で含める**。今のコードの動き（「現状」）はdocs/modules/が持ち、
  docs/architecture/は構造の約束と外部の制約を持つ（docs/architecture/README.md「書き分け」）。どちらもコード変更と
  同一コミットで更新する。

- **既存の仕組みと技術的に別方式の新しい配信・レンダリング機構（例: タイル焼き込み済み
  ramp軸に対する、フィーチャーの鍵で値を配る`dedicated_way_value_layer`）を新設するときは、
  着手前に`docs/architecture/design-principles.md`の構造仕様3・8（1本道の追加点）がこの新しい機構にも
  適用されるかを点検し、適用されるなら軸ごとのファイル・関数・定数・propを新設しない
  汎用設計にする**（新しい種類の機構を作る時にだけ点検が漏れやすい）。

- **MVT焼き込み値（CASE式・材料タグ・domain純関数）を変更したら**、生成物
  （region-tile-config.json）を同一コミットで再生成する（タイル世代そのものは焼き込みSQLから
  導出されるため手で上げない。`app/infrastructure/cache_identity.py`参照）。

- **評価軸（`axis_definitions`テーブル）の新規追加・削除・既存軸の`shape_params`調整は、
  すべて`axis_admin`のAPI（軸スタジオのGUI、または直接API呼び出し。新規追加=POST、
  削除=unpublish→DELETE、公開軸の調整=unpublish→PUT→republish）経由で行う。**
  **正本は本番DBだけ**で、リポジトリは軸の写しを持たない——スキーマはORMの宣言から
  `create_tables()`が作り、軸の中身は実行時の`GET /api/axis-catalog`がフロントへ配る。
  `create_tables()`はまっさらなDB向けで、本番の既存の表は宣言を変えても追従しない。差は人が本番で埋め、
  デプロイが入れ替えの後に測る（docs/architecture/tech-stack.md「デプロイの反映確認（backend/frontendで注入元が異なる）」の`schema_gap.py`）。
  ビルド時の生成物（`frontend/src/types/generated/`）はすべてコードの宣言から決まり、
  DBを読まない。DBのバックアップは付録の「DBのバックアップ」。
  完了扱いにする条件は下の「本番へ効かせたい軸定義の変更は、本番の管理APIへ入れる」
  （開発DBのみの反映で完了扱いにしない）。

- **既存DBの行データを新しいコードが読めなくなる変更（Pydanticモデルの破壊的変更等）を
  含む`backend/**`の変更は、本番DBのデータ移行を完了させてからmasterへ入れる（マージする）**。
  作業ブランチへのpushでは本番へ出ない。masterに入ってCI（`.github/workflows/ci.yml`）が通ると、backendは本番へ自動デプロイされる
  （コンテナを入れ替えるかの振り分けは`scripts/deploy_gate.py`が正本）。
  DB移行より先にmasterへ入れると、新コードが本番DBに残る旧形式データを読めず、
  `refresh_axis_definitions`等のfail-fast設計により本番backendが起動失敗する。
  対応順序は事前に次のいずれかを選ぶこと: 1) 本番DBのデータ移行を先に完了させてから
  マージ（移行を即座に行えなければ、終わるまでmasterへ入れずに待つ——masterのCIが通れば必ず
  デプロイされ、自動のデプロイを止める仕組みは無い）、2) 新旧両方の形式を一時的に許容する後方互換コードを
  経由して段階的に移行する。

#### 派生データの作り直し

- 住所の区画の段は、住所の生データ（`abr`）の取込が無いと止まり、作り直し全体が何も入れ替えない。初めて流す前と住所を取り直すときは、
  同じ別のコンテナで取得と取込を先に打つ（手順は[data-sources.md](../../../docs/architecture/data-sources.md)「住所の区画の元データ」）。

- 同じ入口が、作り直した表から道路網全体の配列（ルート生成が読む。`data/road_network/`）を作ってから
  表を入れ替える（配列は本番で数分）。**`/app/data`のマウントを外さない**——外すと配列がコンテナと一緒に
  消え、表だけが入れ替わってルート生成は古い配列を読み続ける。途中で落ちたとき（配列を作れなかったときを
  含む）は何も入れ替わらず、backendは前の表と配列を読み続けるので、原因を直して打ち直す。

- 作り直しは、どの取込から作ったかを全ソースぶん（表`derived_source_runs`）、どの列の表を作ったかを派生の表ごと
  （表`derived_columns`）に記録する。記録が段の読んだ生データと一致するよう、取込と作り直しは同時に走らず
  （後から始めた方が止まる。終わってから打ち直す）、途中の段から流す`--from`は、生データか派生の表の列が前の
  作り直しの記録から変わっていれば止まる（`--from`を外して最初から流す）。
  仕組みは[静的道路属性](../../../docs/modules/backend/static-road-attributes.md)「派生」。

- なぜ: 手元の端末で打つと、そこから見えるのは開発用のDBで、本番は古いまま変わらない。稼働中のbackendの
  コンテナの中で走らせると、そのコンテナのメモリ上限まで使い切ったときにコンテナごとOOM killされ、
  サービス全体が止まる。別のコンテナを`--memory`付きで立てれば、上限を超えても止まるのはバッチだけで済む。

#### backendを先に出した窓では、frontendが新しい材料を知らない

- ルール: backendをデプロイしてからfrontendをデプロイするまでの間、**新しい材料を使う軸の
  編集画面は別物として開く**——frontend側のカタログにその材料が無いため、材料として引けず
  「組み合わせる軸」の側へ倒れる。窓の間は軸スタジオでその軸を触らない。両方のデプロイが
  終わったことを確認してから編集する。

- なぜ黙って起きるか: 画面はエラーを出さない（引けない材料は「無い」として扱われる）ため、
  開いた人には壊れて見えず、保存すると**軸の中身が変わって書き戻る**。

#### 本番へ効かせたい軸定義の変更は、本番の管理APIへ入れる

- ルール: **DBは環境ごとに独立していて、その環境の管理画面がそのDBをメンテナンスする**。
  開発DBへの変更は開発環境にしか効かないため、開発DBだけ変えてタスクを完了扱いにしない
  ——本番へ効かせるなら本番の軸スタジオか、次の道具で行う。環境間で内容を転送する仕組みは持たない。
  **リポジトリは軸の写しを持たない**ため、再ダンプの手順は無い。

- 変える中身が決まっている変更（タスクで値を決めた軸の書き換え・追加・削除）は、軸1本の定義のJSONを作り、
  `backend/scripts/axis_apply.py`で入れる
  （仕組みは[axis-studio.md](../../../docs/modules/backend/axis-studio.md)「軸の定義をファイルから本番へ入れる」）:

- 完了の条件: 道具が「反映を確かめました」を出したこと（管理APIと公開の軸カタログの両方で見ている）。
  画面で変えたときは、本番の`GET /api/axis-catalog`で変えた軸を確かめる。

- なぜ: 開発DBだけに反映してタスクを完了扱いにすると、本番だけ古い軸定義のまま取り残される。

道具は本番の管理APIを読み書きするので、担当は打たず、開発機の対話のセッションがユーザーがチャットで言ったときだけ打つ
（[flow.md](../../../docs/conventions/flow.md)「本番へ書く」）。差（項目ごとの「前 → 後」）と指紋をチャットで見せ、書くよう言われてから、同じ指紋で書く。宛先は
リポジトリの`production-origins.json`から読み、認証情報は`backend/.env.oracle.local`の`ADMIN_BASIC_AUTH_USERNAME`・
`ADMIN_BASIC_AUTH_PASSWORD`に置く。JSONは1回当てたら役目を終えるもので、`docs/records/`へは置かない（維持しない階層。
記録はタスクの issue に書く）。本番の写しとして直し続けない（次に変えるときは本番の今の定義から新しいJSONを作る）。

### 元: .claude/skills/production-data の SKILL.md

#### 派生データの作り直し

- 取込（`app.batch.ingest_cli`）は派生の表・派生の世代・道路網の配列を変えない。地図のタイルは生データも
  直接読むため、成功した取込は配信するタイルの世代を進める（読み直しのTTLの後から、全系統のタイルを
  新しい生データで焼き直す）。取り込んだら続けて派生を作り直す。

- 作り直しは、どの取込から作ったかを全ソースぶん（表`derived_source_runs`）、どの列の表を作ったかを派生の表ごと
  （表`derived_columns`）、段ごとの入力の指紋を（表`derived_stages`）記録する。記録が段の読んだ生データと一致するよう、
  取込と作り直しは同時に走らない（後から始めた方が止まる。終わってから打ち直す）。
  仕組みは[静的道路属性](../../../docs/modules/backend/static-road-attributes.md)「派生」。
