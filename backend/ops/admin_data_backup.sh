#!/bin/bash
# 本番DBの全体をpg_dumpで書き出し、Object Storageの非公開バケットへ1個だけ置く。
# 本番VMのsystemd（ridecompass-admin-data-backup.service）がrootで毎日打つ。登録と戻し方は
# .claude/skills/production-data/SKILL.md「DBのバックアップ」「本番DBを失ったとき」。
#
# 環境変数（/etc/ridecompass/admin-data-backup.env）: OCI_NAMESPACE・BACKUP_BUCKET
set -euo pipefail

: "${OCI_NAMESPACE:?}" "${BACKUP_BUCKET:?}"

# 書き出しはDBのディスクの、PostgreSQLのdata_directoryの外に置く。OSのディスクと/runには入らない大きさになる。
# 前の回の書き出しは次の回まで残し、バケットへ置けなかった回も手元から送り直せるようにする。
backup_dir=/mnt/pgdata/ridecompass-backup
# 圧縮は可逆なものから、本番で書き出して枠に余裕を持って収まったもの（pg_dumpの--compressの書き方）。
# 強さを上げると、縮みはほぼ止まって時間だけが延び、本番の1コアを長くふさぐ。
compress=zstd:9
# バケットに置くのは常に1個で、無料の枠（10GB）に収める。超えるなら置かずに落ちる。
# 枠は少ないほうの読み（10^10バイト）で取り、DBが育って枠に迫ったら、超える前に落ちて気づけるだけ余らせる。
max_bytes=9500000000

mkdir -p "$backup_dir"
# DB名は、デプロイ済みのbackendと同じ接続先の設定から取る（接続先・利用者・パスワードは出さない——
# ホストのpg_dumpはpostgresユーザーのpeer認証で同じDBへつなぐ）。取込と作り直しが取る鍵の名前も同じイメージから取る。
read -r db_name lock_name < <(docker run --rm --env-file /home/ubuntu/ridecompass-backend.env ridecompass-backend:latest \
  python -c 'from sqlalchemy.engine import make_url; from app.config import settings; from app.batch.common import SOURCE_DATA_LOCK; print(make_url(settings.database_url).database, SOURCE_DATA_LOCK)')
: "${db_name:?}" "${lock_name:?}"

# 書き出す前に、書き出しが入る空きを確かめる。書き出しは圧縮してもDBより大きくはならない。
db_bytes=$(runuser -u postgres -- psql --dbname="$db_name" --tuples-only --no-align \
  --command='SELECT pg_database_size(current_database())')
free_bytes=$(df --output=avail --block-size=1 "$backup_dir" | tail -n 1)
if (( free_bytes < db_bytes )); then
  echo "DBのディスクの空きがDBの大きさより少ないので書き出しません free=$free_bytes db=$db_bytes" >&2
  exit 1
fi

# pg_dumpはホストのものを使う。サーバーと同じPGDGの版で入っているため、版が必ず揃う
# （pg_dumpは自分より新しいメジャー版のサーバーからは書き出さない）。
# 書き出しは、取込と作り直しが止まっている時点で取る。pg_dumpのスナップショットは、そのあとに取込が表を
# TRUNCATEして入れ直すと空の表を書き出し、作り直しの途中なら作りかけの表を書き出す。取込と作り直しが取る鍵を
# 排他で取り、走っていれば終わるまで待つ。持つ間に始めた取込と作り直しは、鍵を取れずに止まる。
# 鍵はセッションに付くので、書き出しが終わるまでpsqlを開いたままにし、閉じると外れる（このスクリプトが落ちても外れる）。
coproc source_lock {
  runuser -u postgres -- psql --dbname="$db_name" --no-psqlrc --quiet --tuples-only --no-align \
    --set=ON_ERROR_STOP=1 --set=lock="$lock_name"
}
echo "取込と作り直しの鍵を待ちます lock=$lock_name"
echo "SELECT 'locked' FROM pg_advisory_lock(hashtext(:'lock'));" >&"${source_lock[1]}"
read -r locked <&"${source_lock[0]}"
[[ "$locked" == locked ]]

next="$backup_dir/next.dump"
runuser -u postgres -- pg_dump --format=custom --compress="$compress" --dbname="$db_name" > "$next"
lock_input=${source_lock[1]}
exec {lock_input}>&-
# shellcheck disable=SC2154  # coprocが作る変数
wait "$source_lock_PID"
# 置く前に、戻せる形のアーカイブであることを確かめる。
pg_restore --list "$next" > /dev/null
bytes=$(stat -c %s "$next")
if (( bytes > max_bytes )); then
  echo "書き出しがバケットの枠に収まらないので置きません bytes=$bytes max=$max_bytes" >&2
  exit 1
fi

# 認証はインスタンス・プリンシパル（鍵をVMに置かない）。VMに許すのはこのバケットのオブジェクトの一覧・作成・削除だけ。
# 公開イメージは空の設定（資格なし）で取る。rootのDockerの設定にghcr.ioの失効した資格が残っていると、
# ghcr.ioは公開イメージでも拒否する（denied）。
anon_config="$backup_dir/docker-config"
mkdir -p "$anon_config"
oci() {
  docker --config "$anon_config" run --rm --network=host -v "$backup_dir:/backup:ro" ghcr.io/oracle/oci-cli:latest \
    --auth instance_principal "$@"
}

# 枠に2個は入らないので、前の回のものを消してから置く。確かめの通った書き出しが手元にあるので、
# ここから先で落ちても手元から送り直せる。
oci os object bulk-delete --namespace "$OCI_NAMESPACE" --bucket-name "$BACKUP_BUCKET" --prefix db/ --force > /dev/null
mv "$next" "$backup_dir/latest.dump"
name="db/$(date -u +%Y%m%dT%H%M%SZ).dump"
# 分けて送ると、分けて送るための許し（OBJECT_OVERWRITE等）が要る。1回で送れば作成の許しだけで済み、1個はその上限に収まる。
oci os object put --namespace "$OCI_NAMESPACE" --bucket-name "$BACKUP_BUCKET" \
  --name "$name" --file /backup/latest.dump --no-multipart --force > /dev/null

# 置けた時刻を、backendのコンテナが`data/`として見るディレクトリへ書く。`/health`が経過時間を返し、
# 定時のActionsがそれを読んで止まりを知らせる（名前は`app/infrastructure/admin_data_backup.py: MARKER_PATH`と揃える）。
# 途中で落ちた回は書かないので、ここより前に置かない。
marker=/home/ubuntu/ridecompass-cache-data/admin_data_backup_at
date -u +%Y-%m-%dT%H:%M:%S+00:00 > "$marker.tmp"
mv "$marker.tmp" "$marker"

echo "DBの全体を置きました object=$name bytes=$bytes db=$db_name compress=$compress"
