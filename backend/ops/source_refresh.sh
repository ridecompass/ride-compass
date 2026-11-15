#!/bin/bash
# 全部の元を上流から取り直し、全部取り込み直し、派生を全部作り直す。
# 本番VMのsystemd（ridecompass-source-refresh.service）がrootで打つ。
set -euo pipefail

# 稼働中のbackendとは別のコンテナで、メモリの上限を付けて打つ（上限を使い切っても止まるのはこのコンテナだけ）。
# 名前を決めて付けるので、前の回のコンテナが残っていれば起動が断られ、2回が重ならない。
# 3段を1つのコンテナの中で順に打ち、どれかが落ちたらそこで止める（後ろの段は前の段の結果を読む）。
# ログはVMのjournalへ送り、コンテナが消えたあとも読めるようにする。
docker run --rm \
  --name ridecompass-source-refresh \
  --network=host \
  --memory=4g --memory-swap=4g \
  --log-driver=journald \
  -v /home/ubuntu/ridecompass-cache-data:/app/data \
  -v /home/ubuntu/ridecompass-raster:/app/raster \
  --env-file /home/ubuntu/ridecompass-backend.env \
  ridecompass-backend:latest \
  sh -c 'set -e
    python -m app.batch.fetch_cli --all
    python -m app.batch.ingest_cli --all
    python -m app.batch.derive_cli'

# 通った時刻を、backendのコンテナが`data/`として見るディレクトリへ書く。`/health`が経過時間を返し、
# 定時のActionsがそれを読んで止まりを知らせる（名前は`app/api/routers/health.py: _MARKER_FIELDS`と揃える）。
# 途中で落ちた回は書かないので、ここより前に置かない。
marker=/home/ubuntu/ridecompass-cache-data/source_refresh_at
date -u +%Y-%m-%dT%H:%M:%S+00:00 > "$marker.tmp"
mv "$marker.tmp" "$marker"

echo "全部の元を取り直し、取り込み直し、作り直しました"
