# レンズ・道ごとの値の配信（backend）

## 責務

ルートを出す前の地図が道を塗る値（費用の軸のレンズ・道の線の層）と、押した道の窓の値を、路面タイルのフィーチャーの鍵で
配る。配信の単位は路面タイルのフィーチャーと同じで、ズームによってway丸ごとにも区間（road_edges）にもなる——このモジュールは
どちらかを知る必要がなく、タイルと同じ`feature_key`を鍵として扱う（[static-road-attributes.md](static-road-attributes.md)の
`EDGE_UNIT_MIN_ZOOM`参照）。ルートの線は区間の値で塗るので、ここは読まない。

**対象ファイル**

| レイヤー | ファイル |
|---|---|
| domain | `way_value_formula.py`（中立の式の木の型と、numpyでの評価）・`gradient.py`（道を辿る向きを走行方位で選ぶ木と、勾配の桁）・`lens_values.py`（タイルのフィーチャーと辿る向きで網の行を束ね、1kmあたりの代償の秒にする・地図の式の木・押した道の値と事実）・`lens_equivalents.py`（段の境目の秒の、標準の条件での事実の目安）・`lens_total.py`（総合のレンズのidと、軸ごとの値から総合を出す決まり。ルートの線も読む）・`feature_materials.py`（タイル1枚のフィーチャーごとの材料の型） |
| services | `lens_service.py`（タイル1枚のレンズの値と、押した道のレンズの値と事実）・`feature_materials.py`（タイルのフィーチャーごとの材料を読み、ディスクへ持つ。地図の線の層の値）・`region_service.py: RoadInspectorService`（道の窓） |
| infrastructure | `feature_material_cache.py`（タイルのフィーチャーごとの材料。ディスク経由）・`tile_persistent_cache.py`（呼び出し元が設計したタプルの鍵でPythonオブジェクトを置く汎用のディスクキャッシュ。`diskcache`の包み。路面タイルの世代に結んだ値を、世代を読めたときだけ24時間持つ口`tile_persistent_cache.py: set_tile_entry`も持つ） |
| api | `region.py`（`GET /api/region/lens/{lens_id}/...`・`GET /api/region/road-classes/...`・`POST /api/region/road-inspector`）・`dependencies.py`（`dependencies.py: get_lens_service`・`dependencies.py: get_road_inspector_service`・`dependencies.py: get_feature_material_service`） |

フィーチャーごとの材料をDBから取り出す`infrastructure/road_graph_repository.py: get_feature_materials_in_tile`と、そのSQL
（`infrastructure/road_tile_sql.py`）は[routing-engine.md](routing-engine.md)が主管するファイルに属する。

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
  フィーチャーと辿る向き（道の向き・逆向き）ごとに足して長さで割る。DBは読まない。避け方の倍率は道の値ではなく、曲がる所の漕ぎ出しは
  来た道と曲がる向き（通る道筋）で決まるので入れない。
- **フィーチャー**: タイルに区間の外接矩形が掛かる区間から、路面タイルと同じ鍵（区間で塗るズームは区間、引いたズームは道）で
  束ねる。道1本で塗るズームでは、タイルの外の区間も含めた道の全区間で1つの値にする（どのタイルから見ても同じ値）。
  区間を1本も持たない道（路面タイルは道丸ごとで焼く）は値を持たない。
- **向き**: 地図の向きでどちらを塗るかは式の木（`domain/lens_values.py: lens_way_formula`）が選ぶ。地図を回しても取り直さない。
  一方通行の逆向きは値を載せない。
- **条件**: 風の時刻（`at`）と想定速度（平地の出力が決まる）は要求へ載せる（`domain/lens_values.py: LENS_MATERIAL_CONDITIONS`）。
  風は区間の中点に最も近い予報の格子点の、指定時刻の値を引く（探索と同じ選び方。格子はタイルと区間の中点の両方を覆う）。
  風を読めない・予報の範囲の外の時刻は、無風で求めずに失敗する（`MsmUnavailableError`。口は503）。
- **段の境目の目安**（`domain/lens_equivalents.py`）: `GET /api/cost-axes/lens-equivalents`（軸id→目安。地図のレンズと同じ
  `strength`・`multipliers`のクエリ）は、段の境目の秒が、標準の人・利用者のつまみと倍率・無風の1kmの道でどれだけの事実に当たるか（登坂は斜度、向かい風は風速、停止は止まる回数、摩擦と
  道のストレスは区分・折れ点ごとの秒）。事実の値を刻んだ道を並べて同じ費用の式へ通し、秒から引き戻す——別の換算の式を持たない。
- **キャッシュしない**: 値は風の時刻・想定速度で変わり、タイル1枚の区間で走行の模型を1回解くだけ。欠けを埋める区分の割合
  だけは全区間を数えるので、道の網・区分の列・材料の組ごとにプロセスに1つ持つ（`services/graph_service.py: network_fills`）。段の目安は
  利用者の値（つまみと倍率）で変わるので、要求ごとに求める。

## 道の窓（`services/region_service.py: RoadInspectorService`）

道を押したときの窓（`POST /api/region/road-inspector`）は、押した道の一次属性（`highway`・タグ）と、**押したフィーチャー**
（区間で塗る倍率なら区間、道1本で塗る倍率なら道1本）のレンズの値を返す。レンズの値は地図のレンズと同じタイルの値から
求め（`services/lens_service.py: LensService.inspect`）、窓のために別の評価を持たない——窓の値は押した倍率の地図の線の色と
同じになる。

- **値**: 押したフィーチャーの両方の向きの総合と軸ごとの秒、地図がいま塗っている向き（地図と同じ式の木で選ぶ）、元の事実
  （断面の一番急な登り・下り、向かい風の成分、止まる回数——止まる出来事を漕ぎ出す回数に換え、欠けを埋めた、探索・凡例の目安と
  同じ量——の1kmあたり。名前と単位を付けて返す。ほかに転がり抵抗の区分で一番長い路面）を、要求の`cost_preference`で返す。
  事実は体感する量で、レンズの秒の内訳を辿るためのもの。
- **要求**: 走行方位・時刻・想定速度・押したタイルを本文で受ける（押した位置をURLに残さない）。押した道か、押したタイルの
  そのフィーチャーが見つからなければ`null`。

## API（`api/routers/region.py`）

| エンドポイント | 返すもの |
|---|---|
| `GET /api/region/lens/{lens_id}/{z}/{x}/{y}?speed_kmh=&at=&strength=&multipliers=` | フィーチャーの鍵→道の向き・逆向きの1kmあたりの代償の秒と道の向き。知らないレンズは404 |
| `GET /api/region/road-classes/{z}/{x}/{y}` | フィーチャーの鍵→地図の線の層の値（区分の鍵か「データなし」。区分の外の道の層は載せない）。ルートの区間の帯も同じ値を持つ |
| `POST /api/region/road-inspector` | 上の「道の窓」 |

- 鍵はタイルが焼いた`feature_key`と同じもので、ズームによって区間・wayのどちらかになる。値の無い材料は載せない。
- 静的な路面タイル（`/api/region/road-surface-tiles`、MVT）とは別経路——フロントは同じz/x/yに対して両方を取得し、
  MapLibreの`setFeatureState`で合成する（[map-axis-coloring.md](../frontend/map-axis-coloring.md)参照）。
- 路面・点のタイルと同じレート制限・座標検証を共有し、道の線の層の値とレンズの値は同時実行の上限のsemaphore
  （`api/routers/_tile_http.py: region_tile_semaphore`、`config.py: road_tile_max_concurrent`）も共有する（レンズはDBを読まないが、
  タイルごとの計算がルート生成と共有のスレッドの置き場を埋めないように待たせる）。道の窓は押すたびの
  単発の要求なので専用の上限を持つ。

## タイルの材料（`services/feature_materials.py`）

タイル1枚ぶんのフィーチャーごとに、全部の材料（`domain/material_catalog.py: material_value_sql`を持つ材料）を読む
（`infrastructure/road_tile_sql.py: FEATURE_MATERIALS_IN_TILE_SQL`）。地図の線の層の値（`FeatureMaterialService.road_layer_values`）は
これに区分の列（`domain/road_classes.py: class_columns`）を読むたびに当てて求める——持つものに区分を含めないので、区分を
書き換えても持ったものを作り直さずに済む。

- フィーチャーの並びと材料の表の結び方は路面タイルと同じ（区間単位のズームは区間の値、way単位のズームと区間を
  持たない道は道1本の行の値。密度の分母の長さもフィーチャーと同じ側から取る）。
- 値は探索と同じ値式で求める。事故の密度は今の収録年数（`RoadGraphRepository.get_accident_years_covered`）で割る。区間単位のズームで、
  探索が同じ区間に読む材料と同じ値になる（`tests/test_feature_materials_in_tile.py`）。
- 取込範囲外・フィーチャーの無いタイルは値なし（地図の配信は`{}`）。DB障害は空へ倒さず投げ、503になる
  （[横断インフラ](cross-cutting-infrastructure.md)「DB障害として扱う例外」節）——空へ倒すと、応答は200・空のままになり、
  地図では「データなし」と見分けがつかない。

## キャッシュ（`infrastructure/feature_material_cache.py`）

読んだタイルの材料をディスク（`tile_persistent_cache`）へ持つ。鍵は`(路面タイルの世代, 読み方の署名, z, x, y)`で、
区分・走行方位・時刻を入れない——材料はどれにも依らない。

- **路面タイルの世代**: 材料の鍵は路面タイルの`feature_key`と一致して初めて意味を持ち、派生の作り直しで同じSQLでも
  別の値になる。世代は派生の表と生データの両方を覆い、事故の収録年数も派生の作り直しと一緒に変わる。世代を読めない
  ときに読んだ材料は持たない（`infrastructure/cache_identity.py: is_known_tile_version`）。
- **読み方の署名**（`services/feature_materials.py: FEATURE_MATERIALS_VALUE_SHAPE`）: 読み出しのSQLの形と、持つ値の
  列の組から機械で署名する。SQLを変えたデプロイの直後から前の読み方のエントリは読まれなくなり、TTL（24時間）で失効する。
- 取込範囲外・空のタイル・DB障害は持たない（次の要求で読み直す）。
- Redisに置かないのは、失っても自前のPostGISから読み直せるため（[.claude/rules/caching-retention.md](../../../.claude/rules/caching-retention.md)
  「Redisへ置くもの・置かないもの」）。読み直しの重さは、本番でタイルを焼く文と同じ結び方で全材料を読んで都心 z12 で
  0.65秒・z14 で0.08秒。1エントリの大きさ（材料の列×フィーチャー数）は未計測。
- hit/missは`FeatureMaterialService`の`log_external_call`（`region:feature-materials`）の`fields["cache"]`に書く。
