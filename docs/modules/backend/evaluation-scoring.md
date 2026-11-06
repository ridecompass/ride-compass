# 費用・材料（backend）

## 責務

探索の費用（所要時間と代償の秒）を区間の材料から組む決まりと、その材料・管理DBの定義（道の区分・費用の軸）を持つ。
費用の式の構造は[評価モデル](../../architecture/evaluation-model.md)、探索への差し込みは[ルート生成エンジン](routing-engine.md)。

**対象ファイル**

| レイヤー | ファイル |
|---|---|
| domain | `hard_filters.py`（0次フィルタ）・`road_avoidance.py`（道の行ごとの避け方）・`cost_preference.py`（費用の式の利用者の値: 全体のつまみと費用の軸ごとの倍率と、その範囲）・`cost_axes.py`（費用の軸の定義の型・検証と、プロセス内の定義）・`ledger_costs.py`（費目の帳簿の式。代償の秒と、その較正値の束）・`axis_templates.py`（道のストレスの重さを材料から引く折れ線と表引き）・`search_materials.py`（探索の材料の表）・`material_catalog.py`・`material_coverage_spec.py`（材料の欠損率の測り方の型と、欠損率の見出し）・`material_value_labels.py`（材料のタグの値ごとの日本語の対訳表）・`material_sql.py`（材料の値をSQLで導出する式。道・ノードの生データを読む副問い合わせは`infrastructure/source_models.py`）・`road_classes.py`（道の区分の全体の型と、区分に道を振り分ける式）・`road_class_catalog.py`（道の区分を画面の設定で配る形） |
| services | `material_coverage_service.py`・`cost_axis_service.py`（費用の軸の定義の読み込みと管理APIの入れ替え）・`road_class_service.py`（道の区分の読み込みと管理APIの入れ替え） |
| infrastructure | `material_coverage.py`（材料ごとの欠損割合の集計クエリ）・`cost_axis_models.py`・`cost_axis_repository.py`・`road_class_models.py`・`road_class_repository.py`・`definition_write_lock.py`（定義の書き込みを直列にする鍵） |
| api | `material_catalog.py`（材料の欠損割合のエンドポイント）・`cost_axis_catalog.py`（`GET /api/cost-axes`で費用の軸の見せ方・総合のレンズを、`GET /api/cost-axes/lens-equivalents`で利用者の値での段の境目の目安を画面へ配る。両方の要求の利用者の値の受け口`cost_preference_query`も持つ）・`cost_axis_admin.py`・`road_class_admin.py`（どちらも全体の読みと入れ替えの管理API）・`client_config.py`（`GET /api/client-config`。較正値・タイルの世代・事故の収録年・道の区分を画面へ配る） |

`material_sql.py`が**domainにある**のは、材料が何から導かれるかがdomainの知識だから。
[routing-engine.md](routing-engine.md)の`ROAD_SURFACE_TILE_MVT_SQL`と本モジュールの
`material_coverage.py`が同じ式を参照する——infrastructureの各所がそれぞれSQLを書くと、
一方だけ変わったときに気付けない。

**材料の導出は`MaterialSpec.value_sql`1本**。探索・地図タイル配信・欠損率の集計は、すべて同じ式を読む。入力に対する
あるべき値は`tests/test_material_values.py`が期待値の表で固定する。式が実在の列と、読み出しの経路ごとのFROM句に
ある別名だけを読むことも同じファイルが見る——値の表は別名を値で与えるため、綴りの合わない列や、
経路に無い別名（路面タイルの`re`等）を読む式は、値の表だけでは見つからない。

**タイルへ焼く列は、値式を載せ方で包むだけ**。`tile_property`を持つ全材料について、タイルの列を
`domain/material_catalog.py: tile_column_sql`が値式から組み、路面タイルの文
（`road_tile_sql.py: ROAD_SURFACE_TILE_MVT_SQL`）は`material_tile_columns`をそのまま並べる——材料を1つ足せば
タイルにも列が増え、式を直せば地図と探索が一緒に変わる（タイルの形の署名も変わり、配信中のタイルは作り直しになる）。
`tile_property`を持つ材料は値式を必ず持つ（宣言の検証が断る）。載せ方は型ごとに決まる:

| 型 | 載せ方 |
|---|---|
| 真偽 | `CASE WHEN (value_sql) THEN true END`。「該当しない」をNULLへ畳み、フィーチャーからキーを省いてタイルを軽くする。タグの不在を「不明」とする真偽の材料（`coverage.missing_semantics`が`"unknown"`）はこの載せ方の対象外で、タイルへ焼くなら「不明」を値として持つ分類の材料にする（例: 路面の見込み） |
| 真偽でないもの | 値式をそのまま |

タイルの文は、値式が読む別名をフィーチャーの単位で与える。区間単位のフィーチャーは`em`が区間の値・
`re`の長さが区間の長さ、way丸ごとのフィーチャーは`em`が道1本の値の同じ名前の列（無い列はNULL）・`re`の長さが
wayの長さ（0はNULL）になる——件数と長さは必ず同じ側から取る。

## 0次ハードフィルタと道の行ごとの避け方（`domain/hard_filters.py`・`domain/road_avoidance.py`）

`domain/hard_filters.py: compute_search_exclusion`が、探索の材料の表の0次フィルタに当たる区間（`domain/search_materials.py: SearchMaterials.hard_filtered`）と区分の列（`domain/search_materials.py: SearchMaterials.road_classes`）と、
リクエストが指定した行ごとの避け方の段から、Edgeごとに「探索から除く」と「割り増す」を求める。
0次フィルタは宣言されたものがいつも全部効き、リクエストでは切れない（要求の欄も持たない）。

要求の行の鍵は断らない（`api/routers/routes.py: RoadAvoidanceOverride`）。区分は管理DBが持ち、デプロイを待たずに直せるので、
直す前に読み込んだ画面が消えた行の鍵を送りうる。今の行へ揃えるのは`domain/road_avoidance.py: resolve_road_avoidance`で、
応答には揃えた後の今の行を全部返す。

- 0次フィルタは法的に自転車が通行できない道を外す（高速道路・自動車専用道路と、`bicycle=no`の道）。
  走れるが走りにくい道（国道等）は、0次フィルタではなく下の避け方で扱う。
  `domain/hard_filters.py: HARD_FILTERS`が名前・画面に出す名前と説明・該当する道の条件をまとめて持つ唯一のレジストリで、
  条件は道の区分と同じ形（`domain/road_classes.py: conditions_match`）で事実の列に当てる。`compute_search_exclusion`は
  探索の材料の表が組んだときに求めた「どれかのフィルタに当たる」の配列を読み、フィルタごとの専用引数・専用フィールドは持たない。
  フィルタを足しても変わるのはこの辞書だけ。名前と説明は生成物`route-generate-config.json`の`hard_filters`で配り、
  画面は避け方の行の並びの先頭に「通らない」で固定して出す。フィルタは区分の宣言とは別に持つ——区分は管理DBで直せるが、
  通れない道を外すことは直してはいけない。
  タグが無い道は除外しない（判断材料が無い区間まで一律に除外すると探索対象が過度に狭まるため、不明な場合は許可し費用の側へ委ねる）。
- **道の区分ごとの避け方**: 除外の設定（管理DBの道の区分。`domain/road_classes.py: RoadClassDefinitions.avoidance_classifications`）が
  指す公開した分け方の区分ごとに、「通る」「なるべく避ける」「通らない」を選ぶ（行の鍵は`<分け方>.<区分>`。選べないとした区分は行にならない）。
  区間が行に当たるかは、地図がその分け方の線を塗るのと同じ区分の列（`domain/road_classes.py: class_material_id`）から求める。
  「通らない」の行に当たる区間は除き、「なるべく避ける」の行に当たる区間は費用に較正値`avoidance.avoid_cost_multiplier`を
  掛ける（`domain/leg_costs.py: LegCostComposer`）。1つの区間が複数の行に当たれば強い段が効く。
  要求に無い行は、管理DBが持つ既定の段を取る。
  倍率は本番で前後の幹線の割合・距離を比べて決める。
- `motor_vehicle=no`（自転車可の車両通行禁止）はここでは扱わない。自転車は法的に通行
  可能なため0次のハード除外対象にはしない。

## 材料の求め方は1本（読む経路は粒度ごとに分かれる）

材料の値の求め方は`MaterialSpec.value_sql`だけが知っている。読む経路は粒度ごとに分かれるが、
**どの経路も材料の一覧を持たず、式も持たない**——DBが値を返し、受け取る側は列を並べるだけ。

| 経路 | 入口 | 粒度 |
|---|---|---|
| 探索の材料 | `road_graph_repository.py: get_edge_material_arrays` | 区間群（取込範囲の道路網） |
| タイルのフィーチャー | `road_graph_repository.py: get_feature_materials_in_tile` | タイル1枚の区間か道1本（地図のレンズ・道の窓） |

区間の値を持つ`em`は、道1本を単位に読む文脈では道1本の値の同じ名前の列を引く別名になる——**区間の値をway1本へ
落としているのではなく、way粒度の値を同じ名前で読んでいる**（way側の値は
`derive_landcover`等の段が区間から集約して持つ）。

**暗黙の前提**: 取込はタグを絞らない（`batch/source_adapters/osm_pbf.py`がタグを全部`attrs`へ入れる）。どのキーも
`attrs`に在るため、値式はそこから読んでよい。**捨てると後から解釈を変えられない**という
理由で全部持つ設計で、許可リストは持たない。

**この1本道が壊れたときに起きること**: 経路ごとに式を書くと、片方だけ変更されたときに
同じ道の同じ場所で地図の色とルートの費用・内訳の数字が食い違う。費用はほかの軸でも決まるため、
食い違ってもルートは返り続け、誰も気づかない。

## 探索の材料の表（`domain/search_materials.py`）

`domain/search_materials.py: build_search_materials`が、切り出した範囲の材料（`EdgeMaterialColumns`）から、生成のたびに1回
`SearchMaterials`を組む。行は切り出した区間の順で、数値の材料は材料のidごとに区間の値が連続する行列で持つ。キャッシュしない。

- **運ぶ材料**は、所要時間が読む材料（`domain/cycling_speed.py: travel_model_material_ids`）と、費用の式が読む材料（道のストレスの軸の
  材料。`domain/cost_axes.py: burden_material_ids`）だけ。所要時間が読む材料の列が欠けた表は組み立てで断る（`ValueError`）——欠けたまま
  通すと、欠けた材料の待ち・坂が全区間で黙って0秒になる。区間ごとの値の欠け（NaN）は平地・待ち無しとして扱い、
  `missing_travel_data_share`で数える。
- **DBに無い材料**は、材料カタログにあれば値の無い列で読める（`_ColumnsOrEmpty`が読まれたときに埋める）。
- **分類の材料**（`highway`・路面の見込み等）は、道路網の置き場が持つ語彙への番号の列（`domain/attributes.py: CategoricalColumn`）
  のまま運ぶ。区分の表引き・0次条件・走行モデルの転がり抵抗は、語彙の値ごとに1回引いた表を番号で配る——区間ごとに値の
  文字列へ戻して1件ずつ引くと、区間数に比例したPythonの仕事になり、探索範囲の広い生成では1回に数秒単位で効く。
- **区間の幾何**（距離・方位・中点）も同じ行順で持つ。中点は通過予定時刻の推定と風の格子点の引き当てに使う。

## 費目の帳簿の式（`domain/ledger_costs.py`・`domain/cost_axes.py`）

構造は[評価モデル](../../architecture/evaluation-model.md)「費目の帳簿の式」。ここは実装の受け渡し。

- **費用の軸の定義**は表`cost_axis_definitions`（`infrastructure/cost_axis_models.py`。1行のJSONB）に全体を1つで持ち、
  管理API（`/api/admin/cost-axes`の GET・PUT）で全体を1回で読み書きする（道の区分と同じ）。起動時は区分の後に読み
  （`services/definitions_loading.py`）、行が無いか通らない定義なら起動を止める——探索・地図のレンズ・応答の内訳はどれも
  費用の軸の定義から組むので、定義の無いまま動く経路を持たない。検証（`domain/cost_axes.py: check_cost_axes`）は書き込みと
  起動時の両方が通し、道の区分を入れ替えるときも今の定義を新しい区分で通し直す——区分の重さは分け方のすべての区分に
  書かせるので、区分を足すと先に重さを足すまで区分の入れ替えが断られる。
- **合成**: `domain/leg_costs.py: LegCostComposer`は、ビンごとの費用を「所要時間 ＋ 代償の秒」で組む。代償の体力は走行の模型が
  点の間ごとに重みを掛けて返し（`domain/cycling_speed.py: SegmentSpeedModel.ride`）、道のストレスは時刻に依らないのでリクエストに1回
  だけ求める。曲がる所の費用も同じ換算で組み（`LegCostComposer.transition_costs`）、探索へは`RoadGraphContext.transition_cost`
  で渡る。
- **利用者の値**: つまみと倍率は生成の要求の`cost_preference`（`domain/cost_preference.py: CostPreference`）で届く。つまみは
  較正値`evaluation.penalty_strength`に掛ける比で、帳簿の較正値の束（`domain/ledger_costs.py: current_ledger_parameters`）が
  呼ぶたびに今の較正値で組む——較正値を変えても利用者の値は標準のまま。倍率は書いていない軸を標準とし、条件のエコーへは
  今の費用の軸を全部書いた形（`CostPreference.resolved`）を返す。
- **組み立ての部品**: 走行の模型の入力（転がり抵抗・止まる出来事の待ちと漕ぎ出し・断面。`domain/leg_costs.py: travel_inputs`）と
  道のストレスの1kmあたりの重さ（`domain/leg_costs.py: burden_weights`）は、材料の列（材料id→区間の列）から組む関数で、探索の合成と
  地図のレンズ（[レンズ・フィーチャー値配信](dynamic-way-values.md)「費用の軸のレンズ」）が同じものを呼ぶ。代償の秒は軸ごとの内訳
  （`domain/ledger_costs.py: LedgerCosts.penalty_by_axis`）を持ち、その和が区間の代償の秒（`LedgerCosts.penalty_seconds`）になる。
- **ルートの内訳**: 経路の区間の代償は、探索がその区間に使ったビンの風で、経路上の行だけを解き直して求める
  （`domain/leg_costs.py: LegCostComposer.values_at_rows`が`domain/ledger_costs.py: LedgerCosts.row_seconds`を呼び、走行の模型は
  `SegmentSpeedModel.ride`に行を渡すとその行の点の間だけを解く）。点の間ごとの計算は互いに依らないので、全部を解いた探索の
  値と同じになり、所要時間と内訳の和が探索の費用に合う。回避指定の秒は、避け方の倍率の1を越えた分 ×（区間の所要時間＋代償）。
  曲がる所の漕ぎ出しの代償（慣性の費目の軸の倍率を掛けたもの）は、曲がった先の区間の内訳の別の欄`turn_seconds`に置き、
  軸の秒には足さない（`services/road_graph_candidates.py`。軸の秒は地図のレンズと同じ道の量）。
- **欠けの埋め方**: 停止要因の密度と、道のストレスの軸の材料の欠けは、`domain/road_network.py: material_fills`の分布で埋める
  （数値の材料の平均は`RoadNetwork.numeric_means`で道路網と同じ寿命で1回だけ、区分の材料の割合は道のストレスの軸が読む分だけ
  道路網・区分の列・材料の組ごとに1回だけ求めて取っておく。`services/graph_service.py: network_fills`）。停止要因の密度は所要時間（待ち）と体力（漕ぎ出し）の両方に同じ値を使う。

## 管理DBの定義（道の区分・費用の軸）

道の分け方と区分（条件）・地図の線の層・転がり抵抗の較正値の割り当て・回避タブに出す分け方と区分ごとの既定は、管理DBの表
（`infrastructure/road_class_models.py`）が、費用の軸は上の表`cost_axis_definitions`が正本で、コードは写しも既定も持たない。

- **形の良し悪しは表の制約だけが決める**（[設計原則](../../architecture/design-principles.md)構造仕様15）。鍵の綴り・参照先の実在・
  並びの重なり等は制約が守り、appは読む前・書く前に確かめ直さない。外部キーは取引の終わりまで遅らせるので、全体を消して入れ直す
  書き込みは入れ替えた後の形で確かめられる。制約で表せない良し悪し（条件が重なる・条件の値の綴りが事実の語彙に無い）は判定せず、
  振り分けの式が1つの答えを出す: 2つ以上の区分に当たる道は区分なし、知らない事実はどの道にも無い事実として扱う。
- **コードの宣言と費用の軸が名指す値は、入れ替えるときだけ確かめる**。事実・まとめ先・色の段・較正値の名が宣言に無い
  （`domain/road_classes.py: undeclared_references`）か、今の費用の軸が新しい区分で通らない（`domain/cost_axes.py: check_cost_axes`）
  入れ替えは断る。区分と費用の軸の書き込みは同じ鍵（`infrastructure/definition_write_lock.py: acquire_definition_write_lock`）で
  直列にするので、確かめてから確定するまでの間に相手の定義は入れ替わらない。
- **管理APIは全体の読みと全体の入れ替えだけ**。入れ替えは1つの取引で、表の制約・上の確かめに通らなければ何も変えずに409で
  断りの文を返す。確定してからプロセス内の全体を差し替え、起動時も表から読む（単一プロセスが前提）。管理APIのDB障害は、どの口でも
  503で返す（`api/db_errors.py: install_db_unavailable_handler`）。
- **画面の設定は解決した形で配る**（`GET /api/client-config`の`road_classes`の欄。`domain/road_class_catalog.py`）。公開した分け方
  だけを出し、色・層の説明のうち区分から組む部分をbackendが決める。区分の説明は意味の文だけで、条件は管理の経路
  （`/api/admin/road-classes`）でだけ見せる。指紋（`generation`）は全体の中身から作る。
- **回避タブの見出しは地図の線の層から作る**: 見出しは除外に出す分け方ごとに1つで、名前は分け方の名前、並びは凡例の層の並び
  （`domain/road_classes.py: published_map_layers`）。見出しの名前・並びを別に持たないので、凡例と回避タブは食い違わない。
  除外に出す分け方は地図の線の層でなければならない（外部キー）——凡例に無い見出しを作らない。
- **地図の線の層の値もbackendが決める**（`domain/road_classes.py: layer_columns`）。値は区分の鍵か「データなし」で、地図の線
  （`/api/region/road-classes`）とルートの区間の帯が同じ値を読む。地図は条件を当てない。
- **本番へは管理APIで全体を入れる**（`PUT /api/admin/road-classes`・`PUT /api/admin/cost-axes`）。全体のJSONは本番の今の全体
  （`GET`）から作り、リポジトリの外に置く（[本番のデータ](../../../.claude/skills/production-data/SKILL.md)）。
- **区分の鍵は読み替えない**: 区分の鍵を改める・分ける・合わせると、前の鍵で選んだ避け方は既定の段で読まれる
  （`domain/road_avoidance.py: resolve_road_avoidance`）。費用の軸が前の鍵に重さを書いていれば入れ替えは断られるので、費用の軸を
  先に直す。

## 材料カタログ（`domain/material_catalog.py`）

費用の式・地図・走行モデルが参照する材料（material）の正式カタログ。`MATERIAL_CATALOG: dict[str, MaterialSpec]`が単一ソース。

`MaterialSpec`の主なフィールド:

| フィールド | 意味 |
|---|---|
| `dtype` | `"numeric"`/`"boolean"`/`"categorical"` |
| `unit` | 値の単位（凡例・数値表示用、無次元・真偽値・カテゴリ値は空文字）。生成物`material-catalog.json`がfrontendへ届け、frontendは単位を持たない（唯一の正）。**`material-catalog.json: label`へ単位を書かない**——ラベルと単位を別々に組み立てる画面で「制限速度(km/h) 35km/h」のように二重になる |
| `tile_property` | MVTタイルへ既に焼き込み済みのプロパティ名。`None`はタイルに載らない材料。列は`value_sql`から組む（上の「タイルへ焼く列」） |
| `primary_attribute` | 対応する一次属性（`PRIMARY_ATTRIBUTES`の宣言そのもの。idの文字列では指さない）。材料idと一次属性id（frontendの`primaryAttributes.ts`が使う名前空間）は名前が異なるため明示的に対応させる |
| `source` | 値の出どころ（`"db"`・`"road_class"`）。DB（`value_sql`で求める）か、道の区分から都度作る区分の列（`domain/road_classes.py: class_columns`） |
| `value_sql` | その材料の値をDBから求めるSQL式。出どころが`"db"`の材料だけが持つ。揃わない宣言は登録時に断る。タイルへ焼く材料は必ず持つ |
| `coverage` | 欠損率の測り方。way単位・区間単位・対象外の3択で、**どれかを必ず持つ**（どちらの一覧にも載っていない材料を型として作れなくする） |
| `value_labels` | categorical材料の値ごとの日本語ラベル対訳表（生成物`material-catalog.json`が届ける） |

- **費用の式が参照する材料は、正規化された生データ（数値・boolean・単純categorical）に統一する。** 地図表示・API応答向けの
  人間可読な分類ラベル（「この道は自転車レーンあり」のような優先順位付きの多値分類）は道の区分（管理DB）の関心事で、材料にしない。
- 材料の「登録」（本カタログに載る）と「費用の軸での利用」（道のストレスの軸の`burden.material`が名指す）は独立している。
- 材料自体はGUIから追加・編集・削除できない（コード変更＋デプロイが前提）。frontendが材料を知る
  経路はビルド時の生成物`material-catalog.json`（`scripts/export_openapi.py`）だけで、実行時のAPIでは
  配らない——材料は再デプロイでしか変わらないため、実行時に取りに行くと取得失敗という状態だけが増える。
  生成物の`label`は「論理名 - 物理名」（`MaterialSpec.full_label`）、`name`は論理名だけ
  （一般向けの画面・地図のポップアップ向け）。
- コードが名指しで読む材料（例: 勾配・路面の良否）は、同じファイルのid定数（`GRADIENT_PERCENT`等）で
  指し、カタログのキーにも同じ定数を使う。文字列で書き写すと、綴りがずれたときに読む側が材料を
  見つけられず、黙って欠損（全区間が舗装路扱いになる等）として扱う。
- 土地被覆の割合材料は`edge_landcover.lc_*`／`way_landcover.lc_*`（区間単位・way単位、
  [静的道路属性・タイル配信](static-road-attributes.md)）が持つクラス別の割合で、
  **どのクラスが割合列を持つかは`landcover.py: LANDCOVER_CLASSES`が単一の正本**で、
  列指向テーブル・集計SQL・読み出しは、そこからクラス値の昇順で
  導いた`PERCENT_CLASSES`を読む。材料もクラスの宣言から1クラス1材料で生成する（材料idは割合列の名前、
  表示名はクラスの表示名から作る）ため、クラスを足せば材料も揃って増える。列の名前の規則
  （`lc_<鍵>`）は`landcover.py: landcover_key`だけが持つ。
  **材料の値式は`em.lc_*`だけを読み、区間の値が無いときに道1本の値へ落とさない**——区間の値は全区間ぶん
  計算されており、落とす先は同じ道の平均でしかない。道1本を単位に値を求める文脈
  （`material_joins.py: material_from_clause`が`em`を道1本の行へ読み替える）では道の値になる。
  路面タイルも、フィーチャーの単位（区間かway丸ごとか）で読む列を選ぶ——単位を揃えないと、同じ場所で地図の色と
  内訳の数字が食い違う。

  **欠損判定に1クラスを名指ししない。** 判定も読み出し列もクラスの宣言から導く
  ——名指しすると、クラスを1つ足して既存行を埋め戻す前に、その列がNULLというだけで
  行ごと捨てる。
  **1つの道のストレスの軸で複数のクラスを足さないこと**——割合の合計が100%へ固定されているため
  同じ地面を二重に数える（[設計原則](../../architecture/design-principles.md)構造仕様14）。
- 値式は`domain/material_sql.py`の組み立て関数から作る（タグの正規化・タグ値の一致・
  数値パース・件数の密度化・タグが無いときの非該当）。同じ判定を材料ごとに書き写さないため、
  判定を直すと全材料へ同時に効く。

### 値式が参照するエイリアス

値式は**材料の数が増えてもエイリアスが増えない**形で設計する。元データの出どころごとに
1つのエイリアスを用意し、材料はそのどれかの列を指す。

| エイリアス | 元データ | ここから生える材料 |
|---|---|---|
| `w` | 生の道（`source_features`の`source='osm_way'`を、よく引くタグを列へ出した副問い合わせ。`infrastructure/source_models.py: ways_source_sql`） | `surface`・`lit`・`maxspeed_kmh`・`bridge`・`smoothness`等 |
| `re` | 区間の行（`road_edges`） | `highway`・距離（密度の分母） |
| `em` | 区間に付く値（主キーが区間の鍵の派生の表） | 標高・件数の密度・区間単位の土地被覆 |
| `wm` | 道1本に付く値（主キーが道の鍵の派生の表） | way単位の土地被覆・道の曲がり具合等 |

`em`・`wm`を与えるJOINは、どの経路でも`material_joins.py: material_from_clause`が組み立てる。式が読む列を
宣言（`derived_models.py`）から引き、その列を持つ表だけを主キーで外部結合する。宣言に無い列を読む式は組み立てる時点で
送出し、区間の表どうし（道の表どうし）が同じ名前の列を持つとimportの時点で送出する（別名の列の出どころが決まらない）。
区間へ結ばずに値のある区間だけを数える欠損割合は、式が読む区間の値の表を同じ宣言から引き（`material_joins.py: edge_material_table`）、
その表を直に`em`として走査する。

**行の有無と値の有無を分ける。** `w`の行が無い（求めた区間がDBに無い・取込で消えた道を、派生を
作り直すまでの区間が指す）ときはタグ由来の材料が不明（NULL）になり、行があればタグが無くても非該当（false）として
確定する（`tag_absent_is_false_sql`。真偽の材料（照明・橋・トンネル・自転車道の有無等）が使う）。探索の配列でも
真偽の材料は数値の行列に1.0/0.0で載り、不明は`NaN`のまま届く（`material_catalog.material_array_columns`）——真偽の行列に
載せると欠損を持てず、不明が非該当に化ける。件数も同じで、集計行が無ければ不明、行があれば
載っていないキーは0件。集計前を0件として読むと、全区間が「停止要因ゼロ」と扱われてルート選択が静かに歪む。

`MaterialDType`（`numeric`/`boolean`/`categorical`）は、元データの出どころを
増やしても増えない。

**エイリアスを足してよいかの判定基準**: その材料の兄弟が今後増えるなら、既存の
エイリアスの列として足す。新しいエイリアスを足すのは、元データの表そのものが増えるとき
だけ（読む経路のFROM句の全部へ同じ名前で用意する必要がある）。区間・道の値の表を足すだけなら、`em`・`wm`の列が
増えるだけで別名は増えない。

### 材料カタログのAPI（`api/routers/material_catalog.py`）

材料の一覧そのものはAPIで配らない（上記）。ここにあるのは実データを読まないと答えられないものだけ。

| エンドポイント | 認可 | 内容 |
|---|---|---|
| `GET /api/admin/material-catalog/coverage` | Basic認証必須 | 材料ごとの欠損割合（下記）。全表走査を伴うため認可なしには公開しない |

## 材料の欠損割合（`infrastructure/material_coverage.py`・`services/material_coverage_service.py`）

欠損データを取込側で推測して埋めるのではなく、欠損の実態を管理画面
（[開発者ツール（frontend）](../frontend/developer-tools.md)「材料」タブ）で可視化し、
埋めるかどうかの判断は費用の軸の定義の側へ委ねる。「欠損」は元データ（OSMタグ・派生テーブルの行）の
不在を指し、探索が不在をどう扱うかは`missing_semantics`として併記する。

材料id→「どの母集団の、どの条件が成り立てば欠損か」は各材料の`MaterialSpec.coverage`が宣言し、
`material_coverage_specs()`がカタログから集めて`MATERIAL_COVERAGE_SPECS`（導いた値で、宣言ではない）にする。

| 母集団 | 対象 | 判定 |
|---|---|---|
| `"way"` | 生の道の全行（`infrastructure/source_models.py: WAYS_SOURCE_SQL`） | `missing_condition`（生の道の列・`tags` JSONBのみで構成したSQL真偽式、`domain/material_sql.py`の共有断片から組み立てる）。全way材料を`count(*) FILTER`で1回の走査にまとめる（`_way_coverage_sql`、`FROM {WAYS_SOURCE_SQL} AS w`）。判定式は[routing-engine.md](routing-engine.md)の`ROAD_SURFACE_TILE_MVT_SQL`と同じPython定数を参照するため、独立した2つの文字列を突き合わせる形の整合性テストは持たない（同じ定数を使う構成自体が一致を保証する） |
| `"edge"` | `road_edges`全行 | `present_condition`（区間の値（別名`em`）が値を持つときに真のSQL条件式）。区間の値の表は区間への外部キーと同じ主キーを持ち区間1本に行は0か1なので、値のある区間は区間へ結ばずにその表だけを走査して数え、総数は`road_edges`の件数とする。式が読む表は宣言から引き（`material_joins.py: edge_material_table`）、edge材料を`count(*) FILTER`で表ごとに1回の走査にまとめる（`_edge_coverage_sql`）。判定式が区間の形（`re`）を読むなら区間へ結ぶ形に戻す |

- **「行がある」と「値がある」を混同しない**。派生の表は区間ごとに行を持ち、値を出せない列は
  NULLのまま残す（土地被覆の`lc_*`がそう。NULLの意味は[静的道路属性](static-road-attributes.md)「値が無ければNULL」）。
  行の有無だけで数えると、値がNULLの行を「データあり」と数えてしまう。判定は探索が実際に読む**列**のNULLまで見る。
- `missing_semantics`: `"unknown"`（欠損は不明値[NaN/None]として扱われる）／`"definite"`（欠損は確定値[タグ不在=非該当等]として
  扱われる）。宣言はタグの不在の意味で、値の式がそれに合わせて`NULL`か`false`を返し、配列では読み替えない
  （真偽の材料はどちらでも数値の行列へ載り、`NULL`を`NaN`で持つ）。地図の不明の帯（`domain/material_catalog.py: display_axis_missing_semantics`）もこの宣言から引く。
- `CoverageExcluded(reason=...)`: 集計対象外の材料とその理由（NOT NULL列由来の`oneway`、生データの道のCHECK
  `source_features_way_has_kind`でhighwayを必ず持つ`highway`・`highway_is_cycleway`等）。
  欠損し得ない材料を集計対象へ置かない——欠損の判定が常に0件を数える式になり、DBが持つ前提を式の側でもう一度持つことになる。
  管理画面はこの理由をそのまま表示する。
- **どちらか一方を必ず持つことは型が保証する**: `MaterialSpec.coverage`は必須で、
  way単位・Edge単位・対象外の3択（`domain/material_coverage_spec.py: MaterialCoverage`）のいずれかしか取れない。
  「どちらの一覧にも載っていない材料」を作れないため、網羅性を確かめるテストは要らない。
- `MaterialCoverageService.get_material_coverage`はDB例外を握りつぶさず伝播させ、アプリ共通の例外の扱い
  （`api/db_errors.py`）が503で返す（診断用APIのため空レポートへ倒して「欠損0件」に見せない）。
  `api/dependencies.py: get_material_coverage_service`はルート生成用の長い
  `command_timeout`（180秒）を持つセッションを渡す（全表走査がタイル配信用の20秒を
  超えうるため）。
- 欠損の扱いと母集団の画面の名前（管理画面の欠損率の見出し・説明）は、`domain/material_coverage_spec.py: MISSING_SEMANTICS_DISPLAY`・`domain/material_coverage_spec.py: POPULATION_LABELS`が持ち、生成物`vocabulary.ts`で画面へ届く。
