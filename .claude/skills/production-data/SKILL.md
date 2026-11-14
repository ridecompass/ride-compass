---
name: production-data
description: "本番の派生データを作り直す・本番へ道の区分と費用の軸の変更を入れる・DBのバックアップを登録する・本番DBを失ったときに戻す手順。本番のデータに触る作業の前に使う。"
---

## 派生データの作り直し

- 対象: 管理画面の「派生データの鮮度」が作り直し待ちを出したとき（古い理由がどれであっても打つのは同じ
  1コマンド。`app/batch/derive_cli.py`が段の順に作り直す単一の入口）。
- ルール: **本番VM（SSHで入る）で、稼働中のbackendコンテナではなく別のコンテナをメモリ上限付きで立てて**
  打つ（手元の端末から打つと開発DBに効き、本番は古いまま。稼働中のコンテナで打つと、メモリ上限まで使い切ったときに
  コンテナごとOOM killされてサービス全体が止まる。`--memory`付きの別のコンテナなら止まるのはバッチだけ）:

  ```
  sudo docker run --rm --network=host --memory=4g --log-driver=journald \
    -v /home/ubuntu/ridecompass-cache-data:/app/data \
    --env-file /home/ubuntu/ridecompass-backend.env \
    ridecompass-backend:latest \
    python -m app.batch.derive_cli
  ```

  `--log-driver=journald` で打った分のログは、打った端末を閉じても VM の journal に残る（読み方は
  [tech-stack.md](../../../docs/architecture/tech-stack.md)「本番のログ」）。

- 住所の区画の段は、住所の生データ（`abr`）の取込が無いと止まり、作り直し全体が何も入れ替えない。初めて流す前と住所を取り直すときは、
  同じ別のコンテナで取得と取込を先に打つ（手順は[data-sources.md](../../../docs/architecture/data-sources.md)「住所の区画の元データ」）。

- **`/app/data`のマウントを外さない**（同じ入口が道路網全体の配列`data/road_network/`を作ってから表を入れ替える。配列は本番で数分かかる。
  外すと配列がコンテナと一緒に消え、表だけが入れ替わってルート生成は古い配列を読み続ける）。
  途中で落ちたとき（配列を作れなかったときを含む）は何も入れ替わらず、backendは前の表と配列を読み続けるので、原因を直して打ち直す。
- 取込（`app.batch.ingest_cli`）は派生の表・派生の世代・道路網の配列を変えない。取り込んだら続けて派生を作り直す。
  地図のタイルは生データも直接読むので、成功した取込は配信するタイルの世代を進める（読み直しのTTLの後から、全系統のタイルを焼き直す）。
- 作り直す段は、上のコマンドの末尾に`--stages <段>...`で選ぶ（選ばなければ全部の段。本番で約1時間10分）。選んだ段の出力を
  読む後ろの段は入口が足し、道路網の配列は毎回作る。何が変わったかの自動判定は無いので、変えたものから段を選ぶ:

  | 変えたもの | 選ぶ段 |
  |---|---|
  | 道（`osm_way`）を取り直した | `topology addresses`（`topology`を選ぶと道路の段が全部流れる） |
  | ノード（`osm_node`）を取り直した | `nodes` |
  | 事故（`accident`）を取り直した | `counts` |
  | 標高（`dem`）を取り直した | `elevation` |
  | 土地被覆（`lulc`）を取り直した | `landcover` |
  | 住所（`abr`・`isj_block`）を取り直した | `addresses` |
  | 地点・寺社・小地域（`overture_place`・`bunka_heritage`・`estat_small_area`）を取り直した | `places` |
  | 段のコード（`app/batch/derive_<段>.py`と、それが使う式）を変えた | その段 |
  | 段が読む較正値を変えた | その較正値を宣言した段（`app/batch/derive_cli.py: STAGES`の`tuning`） |
  | 派生の表に列を足した・消した | その表を書く段（`STAGES`の`tables`） |
  | 道路網の配列だけが読む較正値を変えた | `network`（段を流さず配列だけを作る） |

  迷ったら段を選ばずに全部を流す。
- 取込と作り直しは同時に走らない（後から始めた方が止まる。終わってから打ち直す）。DBのバックアップの書き出し（毎日03:17（日本時間）から
  30分ほど）の間に打った取込と作り直しも止まる。仕組みは[静的道路属性](../../../docs/modules/backend/static-road-attributes.md)「派生」。

## 本番へ効かせたい道の区分・費用の軸の変更は、本番の管理APIへ入れる

- 対象: 道の区分（分け方・区分の条件・地図の線の層・転がり抵抗の割り当て・道路タブの設定）と費用の軸の定義（体力の軸の
  見せ方・道のストレスの軸・総合のレンズ）を変える全ての作業。どちらも各環境のDBの表が正本で、管理API
  （`/api/admin/road-classes`・`/api/admin/cost-axes`）の全体の`GET`・`PUT`だけで読み書きする（仕組みは
  [費用・材料](../../../docs/modules/backend/evaluation-scoring.md)「管理DBの定義（道の区分・費用の軸）」）。
- ルール: **DBは環境ごとに独立していて、その環境の管理APIがそのDBをメンテナンスする**。
  開発DBだけ変えてタスクを完了扱いにしない——本番へ効かせるなら本番の管理APIへ入れる。環境間で内容を転送する仕組みは持たない。
  **リポジトリは定義の写しを持たない**ため、再ダンプの手順は無い。
- 入れ方: 本番の`GET`が返す今の全体を取り、変える所だけを直した全体のJSONを作って、同じ口へ`PUT`する。担当は打たず、
  開発機の対話のセッションがユーザーがチャットで言ったときだけ打つ（[dev-session/SKILL.md](../dev-session/SKILL.md)「本番へ書く」）。
  今の全体と書く全体の差（項目ごとの「前 → 後」）をチャットで見せ、書くよう言われてから書く。宛先はリポジトリの
  `production-origins.json`から読み、認証情報は`backend/.env.oracle.local`の`ADMIN_BASIC_AUTH_USERNAME`・`ADMIN_BASIC_AUTH_PASSWORD`に置く。
  JSONはリポジトリの外（作業ツリーの外の手元の置き場）に置き、コミットしない——定義は較正の値を持ち、公開のリポジトリへ写さない
  （[data-sources.md](../../../docs/architecture/data-sources.md)「OSM から作った値と独自の層」）。記録はタスクの issue に書き、そこにも
  定義の値を写さない。本番の写しとして直し続けない（次に変えるときは本番の今の全体から新しいJSONを作る）。
- 道の区分と費用の軸は、入れ替えるときに互いを確かめる（区分を入れ替えると今の費用の軸を新しい区分で通し直し、費用の軸は今の
  区分で通す）。表の制約か確かめに通らなければ、何も変えずに409と断りの文を返す。区分を足すときは費用の軸へ重さを先に書き、
  区分を消すときは区分を先に消してから重さを消す。その途中に残る分け方に無い区分の重さは断られず、backend のログに警告
  「費用の軸に分け方に無い区分の重さが残っています」が出る（読み方は [tech-stack.md](../../../docs/architecture/tech-stack.md)「本番のログ」）。
- 完了の条件: `PUT`の応答が書いた全体と一致し、本番の公開の口（区分は`GET /api/client-config`の`road_classes`、費用の軸は
  `GET /api/cost-axes`）に変えた分が出ていること。

## 付録

作業の前には読まない。一度きりの準備（登録）と、災害時の手順。

### DBのバックアップ

- 対象: 本番DBの全体（管理APIで入れた道の区分・費用の軸の定義と較正値、生データ・派生データ）。
  仕組みは[横断基盤](../../../docs/modules/backend/cross-cutting-infrastructure.md)「本番DBのバックアップ」。
- ルール: 本番VMのsystemdのtimerが毎日03:17（日本時間）に、DBの全体を`pg_dump`（custom形式・圧縮あり）して、
  Oracle Cloud Object Storageの非公開バケットへ`db/<UTCの時刻>.dump`として置き、前の回のものを消す。残すのは、バケットに
  1個（無料の枠の10GBに1個だけ入る）と、VMのDBのディスクの`/mnt/pgdata/ridecompass-backup/latest.dump`に1個。
  置けたら時刻を書き、backendの`/health`が`admin_data_backup_age_hours`（最後に置けてからの時間）を返す。
  **VMを作り直したら、下の登録の1.〜4.をやり直す**。
- 登録（1回。Oracle Cloudのコンソールと、VMにSSHで入って打つ）:
  1. バケットを作る: コンソールの Storage → Buckets で、ホームリージョン（無料枠はホームリージョンだけ）に
     標準の層・既定の見え方（公開しない）で作る（例: `ridecompass-admin-data`）。ネームスペースは同じ画面か、
     テナンシの詳細の「Object Storage namespace」に出る。
  2. VMを動的グループに入れる: Identity → Dynamic groups で、ルール`instance.id = '<VMのインスタンスのOCID>'`
     の動的グループを作る（例: `ridecompass-vm`。OCIDはコンソールのインスタンスの詳細に出る）。
  3. そのバケットのオブジェクトの一覧・作成・削除・読み出しだけを許す（読み出しは、下の「本番DBを失ったとき」でバケットから取るため。
     上書きの権限は足さない）: Identity → Policies で、バケットのあるコンパートメントに次の4文のポリシーを作る。
     ```
     Allow dynamic-group ridecompass-vm to manage objects in compartment <コンパートメント名> where all {target.bucket.name='ridecompass-admin-data', request.permission='OBJECT_INSPECT'}
     Allow dynamic-group ridecompass-vm to manage objects in compartment <コンパートメント名> where all {target.bucket.name='ridecompass-admin-data', request.permission='OBJECT_READ'}
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
- 動いているかを見る: 止まると、毎日06:23（日本時間）の`.github/workflows/prod-route-check.yml`のジョブ`backup`が落ち、
  GitHub Actionsの失敗の知らせが届く（backendの`/health`の`admin_data_backup_age_hours`を読む。上限は
  [横断基盤](../../../docs/modules/backend/cross-cutting-infrastructure.md)「本番DBのバックアップ」）。落ちた理由はVMで`systemctl list-timers ridecompass-admin-data-backup.timer`
  （前回・次回）と`sudo journalctl -u ridecompass-admin-data-backup.service --since -2d`。

### 本番DBを失ったとき

- 対象: 本番DB（またはVMごと）を失った・誤操作で壊したとき。
- 戻る材料: 上の「DBのバックアップ」の書き出し1個。戻すと、DBは書き出した時点の全体（管理データ・生データ・派生データ）になる。
  それより後の管理画面の変更と取込は戻らないので、要るならやり直す。
- 戻すファイルを取る: VMのDBのディスクが残っていれば`/mnt/pgdata/ridecompass-backup/latest.dump`を使う。残っていなければ、
  VMからバケットの`db/`のオブジェクトを取る（登録の2.〜4.を済ませたVMで。書き出しの8GBほどが2分ほどで取れる）:
  ```
  set -a; . /etc/ridecompass/admin-data-backup.env; set +a
  cfg=$(mktemp -d); echo '{}' > "$cfg/config.json"; sudo mkdir -p /mnt/pgdata/restore && sudo chmod 1777 /mnt/pgdata/restore
  oci() { sudo docker --config "$cfg" run --rm --network=host -v /mnt/pgdata/restore:/restore ghcr.io/oracle/oci-cli:latest --auth instance_principal "$@"; }
  name=$(oci os object list --namespace "$OCI_NAMESPACE" --bucket-name "$BACKUP_BUCKET" --prefix db/ --query 'data[-1].name' --raw-output)
  oci os object get --namespace "$OCI_NAMESPACE" --bucket-name "$BACKUP_BUCKET" --name "$name" --file /restore/restore.dump
  ```
  取れたら、大きさがバケットの値（`oci os object head … --query '"content-length"'`）と同じで、`sudo -u postgres pg_restore --list <ファイル>`が
  目録を出すことを確かめる。コンソールのStorage → Buckets → バケット → `db/`からダウンロードして`scp`で送ってもよい。
- 戻す順番（本番VMで。DB名・利用者は`/home/ubuntu/ridecompass-backend.env`の`DATABASE_URL`のもの）:
  1. backendを止める: `sudo docker stop ridecompass-backend`（コンテナが無ければ飛ばす）
  2. DBが無ければ、利用者とDBを作る（利用者は書き出しに入らない）:
     ```
     sudo -u postgres createuser --pwprompt <利用者>
     sudo -u postgres createdb --owner=<利用者> <DB名>
     ```
  3. 戻す（表を作り直して行を入れる。30GBのDBを`--jobs=1`で戻して37分かかった）:
     ```
     sudo chmod 644 <ファイル>
     sudo -u postgres pg_restore --clean --if-exists --jobs=4 --dbname=<DB名> <ファイル>
     ```
  4. 書き出しのあとに較正値を宣言へ足していたら、その行は戻したDBに無く、backendは起動のときに
     「較正値の行がありません（本番の表へ行を入れてから起動する）: <id>」で止まる（宣言は初めの値を持たない）。名指された行を、
     その較正値を足したタスクの issue に記録した値で表`tuning_overrides`へ入れてから起動する。書き出しのあとに管理画面で変えた
     較正値・道の区分・費用の軸も戻らないので、上の「戻る材料」のとおり要ればやり直す。
  5. 書き出しのあとに派生を作り直していたら、道路網の配列の置き場（`/home/ubuntu/ridecompass-cache-data/road_network/`の中）を消す
     （戻したDBより新しい世代の置き場が残ると、backendはそれを読む）。
  6. `deploy-backend.yml`を`workflow_dispatch`で打つ（ラスタを取り、道路網の配列が無ければ作り、backendを起動する）。
     戻ったことを確かめる:
     ```
     curl -fsS http://localhost:8000/health
     curl -fsS http://localhost:8000/api/cost-axes | head -c 300
     sudo docker logs --tail 50 ridecompass-backend 2>&1 | grep -E '道の区分|費用の軸の定義|較正値'
     ```
     `/health`が応答し、ログに「道の区分を読み込みました」と「費用の軸の定義を読み込みました axes=<戻した軸の数>」が出ていれば済み。
  7. VMを作り直したときは、上の「DBのバックアップ」の登録の2.〜4.をやり直す（動的グループのルールはVMのOCIDを指す）。
