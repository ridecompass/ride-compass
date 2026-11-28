# レンズ・道ごとの値の配信（backend）

## 責務

ルートを出す前の地図が道を塗る値（費用の軸のレンズ）と、押した道の窓の値を、路面タイルのフィーチャーの鍵で
配り、路面タイルが焼く地図の線の層の値を求める。配信の単位は路面タイルのフィーチャーと同じで、ズームによってway丸ごとにも区間（road_edges）にもなる——このモジュールは
どちらかを知る必要がなく、タイルと同じ`feature_key`を鍵として扱う（[static-road-attributes.md](static-road-attributes.md)の
`EDGE_UNIT_MIN_ZOOM`参照）。ルートの線は区間の値で塗るので、ここは読まない。

**対象ファイル**

| レイヤー | ファイル |
|---|---|
| domain | `way_value_formula.py`（中立の式の木の型と、numpyでの評価）・`gradient.py`（道を辿る向きを走行方位で選ぶ木と、勾配の桁）・`lens_values.py`（タイルのフィーチャーと辿る向きで網の行を束ね、1kmあたりの代償の秒にする・地図の式の木・押した道の区間の秒と事実）・`lens_equivalents.py`（色の物差しの緑の端〜赤の端を、事実の値で刻んだ段にする）・`lens_total.py`（総合のレンズのidと、軸ごとの値から総合を出す決まり。ルートの線も読む）・`feature_materials.py`（地図のフィーチャーごとの材料の型と、押した道の小窓へタイルの名前で出す材料）・`time_frames.py`（時刻で変わる値のコマの型と、範囲と、印からコマを引くこと）・`road_features.py`（地図のフィーチャーを道路網の配列から選ぶこと（範囲・押した所の近く）と形と、配列の行と道の向きに走った材料と、地図の線の層の値） |
| services | `lens_service.py`（タイル1枚のレンズの値と、押した道のレンズの値と事実）・`region_service.py: RoadInspectorService`（道の窓）・`time_frame_service.py`（時刻で変わる値（路面タイル・レンズ）のコマの一覧と、要求の印を判定の時刻へ戻すこと） |
| api | `region.py`（`GET /api/region/lens/{lens_id}/...`・`POST /api/region/road-inspector`）・`dependencies.py`（`dependencies.py: get_lens_service`・`dependencies.py: get_road_inspector_service`） |


## 地図へ配る式の木（`domain/way_value_formula.py`）

地図の値のうち走行方位で変わる部分を、地図のライブラリに依らない演算の木（`WayValueFormula`。値の木と、値の決まらない道の
木の組）で配る。地図は道ごとの材料を向きに依らずに1回取り、地図を回すたびに木で値を求め直せる。木の型はAPIの応答
（`GET /api/cost-axes`の`map_lens.formula`）に載り、OpenAPIから画面の生成型へ流れる。値の約束（欠けた値・真偽・剰余・丸め）は
`domain/way_value_formula.py`のモジュールのdocstringが持つ。

- **辿る向き**: 道ごとの材料は道の向き・逆向きに辿った値と道の向き（始点から終点の方位）で、走行方位でどちらを読むかを
  `domain/gradient.py: travel_direction_formula`が選ぶ。道路は道路に沿ってしか走れず、方位が決められるのは「どちら向きに
  辿るか」だけ——角度差を係数に掛ける（cos投影）と、同じ道の値が方位次第で薄まる。
- **指定方位に対して直角に近い道路は値を決めない**（同じ木の`undetermined`。地図では「向きで決まらない」）。直角付近は
  その道をどちら向きに辿るかが決まらない。結果から落とすと、値の無い道（「データなし」）と見分けられない。決めない幅は
  較正値（`gradient.perpendicular_band_deg`）で、木を組むときに読む。地図は一覧の木で塗るので、変えた幅は画面を読み込み直すと効く。

## 費用の軸のレンズ（`domain/lens_values.py`・`services/lens_service.py`）

地図のレンズは総合と費用の軸ごとで、どれも**1kmあたりの代償の秒**で塗る（軸ごとはその軸の分だけ、総合はその和。ルート生成と
同じ利用者の値——つまみ`strength`と倍率`multipliers`のクエリ——で求めるので倍率がそのまま映り、足すと総合になる）。タイルの
SQLと式の木の材料では作れない体力（走行の模型）を、backendが道ごとに求めて配る。

- **探索と同じ所から読む**: 値は、取込範囲全体の道の網（`infrastructure/road_network_store.py: current`）の有向の区間について、
  探索と同じ部品——走行の模型の入力（`domain/leg_costs.py: travel_inputs`）・道のストレスの1kmあたりの重さ（`domain/leg_costs.py: burden_weights`）・
  軸ごとの代償の秒（`domain/ledger_costs.py: LedgerCosts.penalty_by_axis`）・欠けを埋める取込範囲全体の平均——で求め、
  フィーチャーと辿る向き（道の向き・逆向き）ごとに足して長さで割る。値を求めるのにDBは読まない。避け方の倍率は道の値ではなく、曲がる所の漕ぎ出しは
  来た道と曲がる向き（通る道筋）で決まるので入れない。
- **フィーチャー**: 路面タイルと同じ選び方で網からタイルのフィーチャーを選び（`domain/road_features.py: map_features_in`。区間で
  塗るズームは区間、引いたズームは道）、その鍵で網の区間の行を束ねる（`domain/lens_values.py: lens_features`）。道1本で塗るズームでは、
  タイルの外の区間も含めた道の全区間で1つの値にする（どのタイルから見ても同じ値）。値の無いフィーチャーも空の材料で載る。
- **向き**: 地図の向きでどちらを塗るかは式の木（`domain/lens_values.py: lens_way_formula`）が選ぶ。地図を回しても取り直さない。
  一方通行の逆向きは値を載せない。
- **条件**: レンズごとに、値が変わる走る条件だけを配る（`domain/lens_values.py: lens_conditions`。体力の軸は費目の式が読む入力で決め、
  道のストレスの軸は区分の材料なら条件を持たず数値の材料なら向きだけ、総合は無効の軸も含めてどれかの軸が変わる条件）。風の時刻
  （レンズのコマの印`frame`。設計原則の構造仕様18）と想定速度（平地の出力が決まる）はそのレンズが依るときだけ要求へ載せ、走行方位で変わらないレンズは塗る向きを選ばない
  （`domain/lens_values.py: map_lens`。向きで決まらない道は無く、一方通行の道も辿れる向きの値で塗る）。載せない条件では値が変わらないので、口は時刻を今、速度を画面の既定で求める。
  風は区間の中点に最も近い予報の格子点の、指定時刻の値を引く（探索と同じ選び方。格子はタイルと区間の中点の両方を覆う）。
  レンズのコマ（`services/time_frame_service.py`）は風の予報の正時の前後30分ずつで、印は予報の版と正時から作る（同じコマの
  要求は同じ風を引き、持ちを分け合う）。予報が入れ替わる前の印と終わったコマの印は断る（口は409）。風を読めない・予報の範囲の外の
  時刻は、地図のレンズでは無風で求めずに失敗する（`MsmUnavailableError`。口は503）。道の窓は下の「道の窓」の値の箇条のとおり失敗しない。
- **段**（`domain/lens_equivalents.py: lens_bands`）: 軸の定義は、色の物差し（緑の端と一番濃い赤の端を軸の事実の値で。
  `domain/cost_axes.py: LensScale`）を持つ。端の値は較正で、本番の定義が持つ。`GET /api/cost-axes`は、緑から赤までを事実の値で較正値の数に刻んだ所に
  境目を置いた段（境目は標準の人・標準の利用者の値・無風の1kmの道の秒、名前は数で言える事実の値の範囲だけで、区分の軸と総合には付けない。地図は色で大小を見せ、色の理由を文で言わない）を配る。事実の値の道を同じ費用の式へ
  通して秒を求める——別の換算の式を持たない。物差しを書く前の定義は、定義の段のまま配る。レンズの量の名前と単位
  （`domain/cost_axes.py: LENS_QUANTITY_LABEL`・`domain/cost_axes.py: LENS_UNIT`）は、生成物`route-generate-config.json`で画面へ配る。
- **応答はプロセスの中で持つ**（`services/lens_service.py: new_response_cache`）: 応答のJSONのバイト列を、バイト数の上限つき
  （`services/lens_service.py: RESPONSE_CACHE_BYTES`。道路網の配列のためにとっておくメモリの内側）で持ち、使われていないものから
  押し出す。鍵は`infrastructure/cache_identity.py: dynamic_tile_key`が組み、応答が読んだ道路網の置き場の名前（`road_network_store.py: directory_name`）・
  較正値と費用の軸・道の区分の定義の署名（`cache_identity.py: model_settings_signature`。管理APIで差し替えると変わる）・レンズ・タイル・
  値を変える入力（利用者の値と、レンズが依るときだけ想定速度と風）を入れる。風は予報のファイルの版（`msm_client.py: forecast_version`）と、
  時刻に最も近い予報の1時間のコマと、今の正時（予報を読む範囲の始まり。範囲の外へ出た時刻に前の持ちを返さない）で表す。
  形（コードの版）は鍵に入れない——持ちはデプロイで空になる。欠けを埋める道のストレスの重さの平均は全区間を数えるので、道の網・
  区分の列・道のストレスの軸の費目の組ごとにプロセスに1つ持つ（`services/graph_service.py: network_burden_fills`）。段の目安は
  利用者の値（つまみと倍率）で変わるので、要求ごとに求める。
- **タイルのどのフィーチャーも名指す**: 値の無いフィーチャー（網に行の無いもの・どちらの向きにも値の無いもの）も空の材料で載せ、
  届いたタイルの値の無い道と、まだ届いていない道を受け取る側が見分けられるようにする。

## 道の窓（`services/region_service.py: RoadInspectorService`）

道を押したときの窓（`POST /api/region/road-inspector`）は、押した道の一次属性（`highway`・タグ）と、**押したフィーチャー**
（区間で塗る倍率なら区間、道1本で塗る倍率なら道1本）の代償の秒を返す。秒は地図のレンズと同じタイルの行ごとの秒を
押したフィーチャーの区間の長さぶん足したもので（`services/lens_service.py: LensService.inspect`）、窓のために別の評価を持たない
——窓の秒を区間の長さで割ると、押した倍率の地図の線の色の値になる。

- **値**: 押したフィーチャーの両方の向きの総合と軸ごとの秒、地図がいま塗っている向き（要求の`lens_id`のレンズの、地図と同じ式の木で選ぶ。
  `lens_id`が無ければ総合の木）、軸ごとの元の
  事実を、要求の`cost_preference`で返す。事実はルートの事実と同じ作り方（`domain/leg_costs.py: axis_facts`）で、その軸の換算
  ルールが読む値を1つ——登坂は押した区間の辿る向きの登り、停止は止まる回数
  （止まる出来事を漕ぎ出す回数に換え、欠けを埋めた、探索と同じ量）、路面の抵抗と区分の材料の道のストレスの軸はその軸の秒に一番効いた
  区分の名前、数の材料の道のストレスの軸はその軸の秒に一番効いた区間の材料の値（名前と単位は材料の宣言）。向かい風は事実を載せない（乗り手の高さへ直して平均した風は格子点に無い値で、
  [外部データソース](../../architecture/data-sources.md)「今の扱い」が画面に出さないとする）。求められない事実は載せない。数えない（無効の）軸は秒も事実も載せない。
  風を読めないとき（予報を読めない・要求の`wind`が偽）は、風で変わる軸（出発時刻を走る条件に持つレンズの軸）の秒と事実と総合を載せず
  （総合は`null`）、風に依らない軸の秒と事実だけを返す——今の風や無風で求めた値を出発時刻の値として出さない。
- **要求**: 走行方位・時刻・想定速度・押したタイル・地図が塗っているレンズ・風を読むか（出発時刻の風のコマが無ければ偽）を本文で受ける（押した位置をURLに残さない）。押した道か、押したタイルの
  そのフィーチャーが見つからなければ`null`。

## API（`api/routers/region.py`）

| エンドポイント | 返すもの |
|---|---|
| `GET /api/region/lens/{lens_id}/{z}/{x}/{y}?speed_kmh=&at=&strength=&multipliers=` | フィーチャーの鍵→道の向き・逆向きの1kmあたりの代償の秒と道の向き（`materials`）と、引いた風が前に出た予報のものなら前のrunに替わる時刻（`wind_previous_run_from`）。知らないレンズは404 |
| `POST /api/region/road-inspector` | 上の「道の窓」 |

- 鍵はタイルが焼いた`feature_key`と同じもので、ズームによって区間・wayのどちらかになる。値の無い材料は載せない。
- 静的な路面タイル（`/api/region/road-surface-tiles`、MVT）とは別経路——フロントは同じz/x/yに対して両方を取得し、
  MapLibreの`setFeatureState`で合成する（[map-axis-coloring.md](../frontend/map-axis-coloring.md)参照）。
- 路面・点のタイルと同じレート制限・座標検証を共有し、レンズの値は同時実行の上限のsemaphore
  （`api/routers/_tile_http.py: region_tile_semaphore`、`config.py: road_tile_max_concurrent`）も共有する（レンズもタイルのフィーチャーの鍵をDBから読み、
  タイルごとの計算はルート生成と共有のスレッドの置き場を使うので、同じ上限で待たせる）。道の窓は押すたびの
  単発の要求なので専用の上限を持つ。

## タイルの材料（`domain/road_features.py`）

タイル1枚ぶんのフィーチャーとその形は道路網の配列から選び（`domain/road_features.py: map_features_in`・`feature_lines`）、その鍵で
全部の材料を同じ配列から引く（`domain/road_features.py: feature_materials`）——どのフィーチャーがタイルに入るかと、その値と形を、
ルートが読むのと同じ配列だけで決める。地図のレンズも、同じフィーチャーの区間の行を束ねる（`domain/lens_values.py: lens_features`）。
路面タイルが焼く地図の線の層の値（`domain/road_features.py: road_layer_values`。
`services/region_service.py: RegionService.get_road_surface_tile`が読む）は、これに
区分の列（`domain/road_classes.py: class_columns`）を読むたびに当てて求める——配列に区分を含めないので、区分を書き換えても配列を
作り直さずに済む（路面タイルは区分の書き換えのあとに捨てて焼き直す。`infrastructure/region_tile_cache.py: discard_region_tiles`）。

- フィーチャーの単位と鍵は路面タイルと同じ（区間で塗るズームは区間の一番若い行の値、道1本で塗るズームは道1本の値）。値はどれも道の向き（形の始点から終点）に走った値で、逆向きにしか走れない一方通行の区間も、逆向きの行の
  勾配の符号を返し、登りの量を下りの量に読み替える（`domain/road_network_build.py: along_way`）。道1本の値の集め方は
  `domain/road_network_build.py`のモジュールの説明が持つ。
- 配列に行の無い道（端点のノードが無く配列が落とした区間と、そういう区間しか持たない道）は、ルートが通れないので地図にも描かない。
- 配列に無い材料（テストの道路網）は、値の無い列として読む（`domain/search_materials.py: ColumnsOrEmpty`）。
