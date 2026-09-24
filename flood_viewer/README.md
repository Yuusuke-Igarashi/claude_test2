# flood_viewer

東京 2024-08-21 の冠水候補分析（run2024.ipynb）の出力を地図で見るスタンドアローン HTML ビューワー。

- **交通モード**: リンクを 対象外（灰）/ 対象（黒）/ 異常（赤）で着色。タイムスライダー、再生、リンクホバーで平時・イベント時の速度と台数の時系列を表示。
- **閾値パネル（⚙）**: is_target の台数・速度、異常レベル 1〜3 の速度比・台数比、裏取り要否を画面で変更すると即時に再計算。error.csv を読み込んでいれば再計算結果との不一致セル数を表示。
- **降雨・低位地帯**: rain/ と lowland.geojson があれば両モード共通で道路の下に重ねる。降雨は時刻スライダーに連動して 15 分スロットの画像を読み、気象庁の降水強度凡例と同じ 8 段階で着色（1 mm/h 未満は透明）。カーソル位置の値を上部に表示。チェックで表示切替。
- **トラックタブ**: 入力 3（truck_traffic.ipynb の出力フォルダ）の network_agg.shp/.dbf（集約後のリンク形状）と時刻別 traffic_YYYYMMDD_HHMM.csv を読んで描く。その時刻の平時台数が 2 台以上のリンクだけを描き、有事の台数または速度が平時の 50 % 以下なら赤。ホバーでその時刻の平時・有事の台数・速度と時系列。閾値は ⚙ パネルで変更できる。平時に複数日があれば時刻ごとに平均する。traffic_15min.csv は使わない。
- **グリッド重畳（軌跡モード）**: grid/ があれば、軌跡モードの上部の「グリッド」で指標を選ぶと、その時刻の比率ラスタ（有事 ÷ 平時）を背景に重ねる。閾値は同じ行で指定（既定: 200 % 以上 = 赤、50 % 以下 = 青、その間 = 薄い灰、平時 0 = 透明）し、変えるとその場で塗り直す。時刻に連動し、カーソル位置の比率（%）が表示される。
- **軌跡モード**: 各 ID × 時刻の直近 1 時間の徒歩軌跡（LineString）、滞留点、車→徒歩の変化点、急な方向転換点を平時・イベント時で表示。ズーム 14 以上で有効。交通量の情報（着色・件数・時系列パネル）は表示しない。地物のホバーで属性を表示し、クリックでその地物だけを太く描く（もう一度クリックか空白のクリックで解除）。地物は端末の識別子を持たないので、同じ端末の地物をまとめて強調する機能はない。種類ごとの表示切替と「最寄りの軌跡へ」（現在時刻のデータのうち地図中心に最も近いものへ移動）を備え、状態行に表示範囲内の件数・その時刻のファイル全体の件数・見つからないファイル名を出す。

## 使い方

配布物は `dist/flood_viewer_standalone.html` 1 ファイル（MapLibre GL JS 同梱、約 1.1 MB）。
ダブルクリックで開き、3 つのフォルダ（1: 車流 = tomtom_out（必須）、2: 人流 = probe_out（viewer/ と grid/）、3: トラック = yazaki_out（traffic_15min.csv））を選んで「読み込む」を押す（viewer/ と grid/ の時刻別ファイルは表示時に必要な分だけ読む）。rain/ や lowland.geojson が 1 のフォルダに入っていればそれも使う（画面の入力欄は無い）。
1 のフォルダは probe_out のような出力フォルダそのままでよく、対象外のファイル（stays / trips / events の GeoJSON、gpkg など）は無視する。
期間モード（viewer/index.json に period がある）では時刻軸を期間そのもの（開始時刻から slot_min 刻みで hours 時間）とし、交通 CSV の列は "HH:MM" で照合する。1 日分 00:00〜23:45 の CSV は 12:00 開始に並べ直され、CSV にない時刻は空欄になる（状態行に注記）。
ページ見出しは viewer/index.json の期間（例 「冠水候補 2026-08-13 12:00〜08-14 12:00（平時 08-06 12:00〜08-07 12:00）」）から付け、期間がないときはネットワークファイル名の日付を使う。
output フォルダに置いて `python -m http.server` 経由で開けば自動で読み込む。

| ファイル | 必須 | 内容 |
|---|---|---|
| *_network.geojson（例 tokyo_20240821_network.geojson） | 必須 | リンク形状。properties: id, pair_id。フォルダ内に 1 つだけ置く |
| baseline_speed.csv / event_speed.csv / baseline_count.csv / event_count.csv | 必須 | リンク × 時刻の行列。id 列 + "HH:MM" 列 |
| error.csv | 任意 | ノートブックの error_level（0〜3）。異常が出たリンクの行だけでよい（無い行は 0）。旧形式（全リンク 0/1）も読める。照合にのみ使用 |
| viewer/<role>_<HHMM>.geojson + viewer/index.json | 任意（推奨） | 時刻別の軌跡・滞留・変化点（properties.kind = traj / dwell / modechange / turn, time）。スライダーの時刻のファイルだけを読むので全域を出力できる |
| baseline_trajectory.geojson / event_trajectory.geojson | 任意 | 1 日分をまとめた LineString / MultiLineString。properties: time。小規模向け |
| baseline_dwell.geojson / event_dwell.geojson | 任意 | 同、MultiPoint / Point |
| rain/rain_<YYYYMMDD>_<HHMM>.tif + rain/index.json | 任意 | XRAIN の 15 分平均降雨強度の GeoTIFF（`probe/xrain_to_geotiff.py` の出力）。時刻ごとに差し替え、色分けはビューワー側。日付はプルダウンで選ぶ。フォルダ選択ではファイル名だけで登録するので index.json は http 経由のときだけ必要 |
| lowland.geojson | 任意 | 低位地帯のポリゴン（WGS84）。道路の下に半透明で描く |
| grid/<param>_<HHMM>.tif + grid/index.json | 任意 | probe_trips.py の 100 m メッシュ比率ラスタ（有事 ÷ 平時、平時 0 のセルは NaN）。軌跡モードで、選んだ指標（徒歩移動者数・徒歩移動距離・滞留数・引き返し数・車→徒歩数）のその時刻のラスタを道路の下に半透明で描く。色の閾値は画面で指定 |
| 入力 3 のフォルダ: network_agg.shp/.dbf + traffic_YYYYMMDD_HHMM.csv | 任意 | トラックプローブのリンク統計（`probe/truck_traffic.ipynb` の出力）。形状は network_agg.shp をページ内で読む（外部ライブラリなし）。時刻別 CSV の日付から平時・有事を決める（人流の期間に合えばその期間、合わなければ最新日 = 有事、他 = 平時）。フォルダ選択のみ（http では読まない） |

`time` は 1 時間ウィンドウの終端で CSV ヘッダと同じ "HH:MM"。ISO 形式でも HH:MM 部分で照合する。

判定論理はノートブックと同じ:

```
is_target = baseline_count >= MIN_BASE_COUNT AND baseline_speed >= MIN_BASE_SPEED
error1_k  = speed_ratio <= LEVEL_k.speed OR count_ratio <= LEVEL_k.count      (k = 1, 2, 3 = 0.75 / 0.60 / 0.50)
error_k   = is_target AND error1_k AND (対向リンクが同時刻に is_target&error1_k OR 同一リンクが前後 15 分に is_target&error1_k)
error_level = 満たした最も厳しい k（0 = 異常なし）。リンクは L1 橙 / L2 赤 / L3 暗赤で着色
```

## 開発・テスト

```
npm install                      # maplibre-gl, playwright
npx playwright install chromium  # 初回のみ
npm run data                     # sample/output に合成データ 10 ファイルを生成（numpy, pandas が必要）
npm run build                    # dist/flood_viewer_standalone.html を生成
npm test                         # Playwright + node:test によるブラウザテスト
```

テスト内容（`tests/viewer.test.js`）:

1. 10 ファイルの読み込み。既定閾値での画面内再計算が Python 側で独立に計算した error.csv（異常リンクのみ、レベル 0〜3）と全セル一致すること、時刻別の異常本数（合計とレベル別）が error.csv の列集計と一致すること。
2. スライダー、キー操作、再生。
3. 異常リンクのホバーでパネル・異常帯・2 系列が出て、クリックで固定できること。
4. 閾値変更で件数が変わり、既定値に戻すと元の件数に戻ること。
5. 軌跡モードのズーム制御、時刻別ファイルの遅延読み込みとキャッシュ、表示範囲内の件数と全体件数の診断、4 種類の地物の描画と種類別の表示切替、交通情報の非表示、軌跡ホバーのツールチップ、クリックによる 1 地物の強調と解除、平時オフ、「最寄りの軌跡へ」、M キー。
6. file:// で開いて必須 5 ファイルだけを選択した場合も同じ結果になり、軌跡ボタンが無効になること。
7. file:// でフォルダごと選択すると viewer/ と rain/ の時刻別ファイルが登録され、表示時に FileReader で読まれること。
7b. データファイル・rain フォルダ・低位地帯 GeoJSON を 3 つの入力で別々に指定できること。
8. viewer/ が無く 1 日 1 ファイルの軌跡 GeoJSON だけの場合も従来通り読めること。
9. 降雨スロットと低位地帯: 時刻連動の画像差し替え、値の読み出し、表示切替、軌跡モードでも表示、フォルダ選択からの読み込み。
10. トラックタブ: traffic_15min.csv の読み込みと日付の役割分け、平時 2 台以上の描画と 50 % 以下の赤、CSV からの独立再集計との一致、ホバーの統計パネル、閾値変更、M キーの 3 タブ巡回。
11. グリッド重畳: grid/index.json からの登録、軌跡モードでの表示と時刻連動、指標の切替、表示切替、カーソル位置の判定。
12. JavaScript エラーが発生していないこと。

GitHub Actions（`.github/workflows/flood-viewer.yml`）が `flood_viewer/` の変更で同じ手順を実行し、
standalone HTML とスクリーンショットをアーティファクトとして残す。

## XRAIN 降雨の変換（probe/xrain_to_geotiff.py）

XRAIN の 250 m メッシュ 1 分値 CSV（`CX<1次メッシュ><YYYYMMDDhhmm>.csv`、320 × 320 のヘッダなし mm/h）を、
15 分スロットごとの GeoTIFF にする。処理は ① グリッド定義（入力に現れる 1 次メッシュ全体を 1 枚の経緯度格子に）→
② 1 スロット分（15 分 × メッシュ数）のファイルを読む → ③ セルごとに平均して GeoTIFF に書く → ④ グリッドを空にして次のスロット、の繰り返し。

```
python3 probe/xrain_to_geotiff.py xrain_folder_or_zip --out probe_out/chiba     # -> probe_out/chiba/rain/rain_YYYYMMDD_HHMM.tif
```

- float32 1 バンド、EPSG:4326、nodata = −1、非圧縮。値は 15 分平均の降雨強度 [mm/h]（`--unit mm` でその 15 分の降雨量 [mm]）。
- `--row-order` で CSV の 1 行目が北端（既定）か南端かを指定する。向きが逆だと南北反転するので、1 スロットを既知の雨域と見比べて確認する。
- 依存は numpy のみ（GeoTIFF は直接書く）。rasterio で読めることを確認済み。
- ビューワーは非圧縮・1 バンドの GeoTIFF を自前で読む（ModelTiepoint / ModelPixelScale から範囲、GDAL_NODATA から nodata）。GDAL 等で作った GeoTIFF も、非圧縮・1 バンドなら読める。経緯度格子を 4 隅で貼るため、メルカトルの歪みで南北方向に最大 1% 程度の位置ずれが出る。

## トラックプローブからの交通統計（probe/truck_traffic.ipynb）

1 秒毎のトラックプローブ（zip 内の 1 時間毎 CSV: serial_number, record_time, speed, gps_latitude, gps_longitude, …）を
TomTom 道路ネットワーク shp に最近傍法で割り付け、15 分ウィンドウ × リンク別の車両数 Hits と平均速度 AvgSp を出す。
セル単位で意味を確認しながら進める想定の ipynb（`build_truck_traffic_nb.py` から生成）。

1. ネットワーク集約: 座標列が同じ（逆向きも同じ）リンクを 1 本に統合。代表 Id = メンバー中の最小 Id。`network_agg.csv` / `.shp`
2. zip を解凍せずに 1 時間分ずつ読む（`__MACOSX/` 等は除外、読めないファイルは記録して飛ばす）
3. `STRtree.query_nearest` で最近傍リンク（50 m より遠い点はネットワーク外）
4. (15 分ウィンドウ, 車両, リンク) ごとに在線判定: 平均速度 > max(制限速度 × 1.3, 制限速度 + 20) → over_speed、
   観測数 < max(3, 0.3 × 期待通過秒数) → too_short（期待通過秒数はウィンドウの端で切れている分だけ短くする）、
   最高速度 < 3 km/h → stopped（駐停車、数えない）
5. 非割付の点を、非割付リストのリンクを除いた最近傍へ再割付。4 → 5 を新しい非割付が無くなるまで繰り返し。
   同じウィンドウで 4 本以上のリンクから非割付になった車両はそのウィンドウで割付不可
6. `traffic_YYYYMMDD_HHMM.csv`（Id, Hits, AvgSp, MedSp, n_points）、`traffic_15min.csv`、`groups.csv`（診断用、車両 ID を含む）、`summary.csv`

```
python3 probe/test_truck_traffic.py     # 合成ネットワーク + 合成プローブ zip でノートブックのセルを順に実行し、結果を検証
```

目安: リンク 2 万本 × 点 50 万（1 時間分）で約 5 秒、ピークメモリ 0.7 GB（点 100 万あたり約 0.5〜1 GB）。

## 100 m メッシュの増減グリッド（probe/probe_trips.py, grid/）

`GRID_M`（既定 100 m）が正のとき、位置ログの前処理と同時に `grid/` を書く。

1. 格子: `--grid-network`（道路ネットワーク GeoJSON）の範囲、無ければ `--grid-bbox` / `--bbox`、それも無ければデータの範囲を、
   中心緯度で 100 m × 100 m になる経緯度セルで覆う（行 0 が北端）。
2. 平時・イベント時それぞれ、15 分スロットごとに直近 1 時間（窓 (T−60 分, T]）の値をセル別に数える:
   `walkers`（徒歩点を持つユニーク ID 数）、`walk_dist_m`（徒歩軌跡のうちセル内の長さ。線分を `GRID_SAMPLE_M` = 25 m 刻みで
   標本化して配分）、`stays`（窓に重なる滞留の重心数）、`turns`（方向転換点数）、`modechanges`（車→徒歩の変化点数）。
   徒歩点・滞留・変化点の定義はビューワーの軌跡モードと同じ。
3. スロット × パラメータごとに イベント時 ÷ 平時 の比率を float32 の GeoTIFF `grid/<param>_<HHMM>.tif`（EPSG:4326、非圧縮、平時 0 のセルは NaN）に書く。
   色分けの閾値はビューワー側で指定する。`grid/index.json` に格子定義。`--grid-count-rasters` で件数そのもののラスタ（`<param>_<role>_<HHMM>.tif`、nodata −99）も書く。

## 位置ログの前処理（probe/）

端末の位置ログ（1 行 1 測位: id, recordedat, lon, lat, accuracy, speed, userid, ... の日別 CSV）から
Stay/Move 判定、トリップ ID 付与、ビューワー用 GeoJSON を作る。

```
python3 probe/probe_trips.py 2024-08-14.csv 2024-08-21.csv --out probe_out --event-date 2024-08-21
python3 probe/test_probe_trips.py     # 合成軌跡による自己テスト
python3 probe/probe_trips.py chiba_*.csv.gz --out probe_out --period-start "2026-08-13 12:00" --grid-network probe_out/tokyo_20250911_network.geojson
```

| 規則 | 既定値 | 引数 |
|---|---|---|
| Stay: 連続する点をすべて含む半径 R の円が描け（最小包含円の半径 ≤ R）、D 分以上 | R = 50 m, D = 20 分 | `--stay-radius-m`, `--stay-min-min` |
| Stay の判定法: `circle`（最小包含円）/ `anchor`（先頭点から R 以内、近似・高速） | circle | `--stay-method` |
| Move: それ以外（速度 0 でも Move） | | |
| トリップ = 直前の一連の Stay + 連続する Move | | |
| 時間ジャンプ: 連続点の間隔がこれを超えると新トリップ（同一 Stay 内の間隔は除く） | 5 分 | `--time-gap-min` |
| 位置ジャンプ: 連続点の見かけ速度がこれを超え、かつ距離がこれ以上 | 150 km/h, 500 m | `--jump-speed-kmh`, `--jump-min-dist-m` |
| 密な点列: 間隔がこれ以下で連続し、この点数以上の点列だけを軌跡・トリップの線として描く（Stay 判定には掛けない。`--dense-for-stays` で掛ける） | 5 分, 10 点 | `--dense-max-gap-min`, `--dense-min-points`（0 で無効） |
| Stay の統合: 連続する Stay の間隔がこれ以下で、重心が Stay 半径の 2 倍以内なら 1 つの Stay にする（間の短い外出点も Stay に含める） | 10 分 | `--stay-merge-gap-min`（0 で無効） |
| 移動モード: 密な Move 点に OS の activitytype を当てる。walk = on_foot / walking / running、vehicle = in_vehicle / on_bicycle、other = それ以外（still, unknown, 欠損）。ラベルは短く揺れるので、同じモードに挟まれたこれより短い区間はそのモードに吸収し（1 回の走査では両隣より短い区間だけ）、残った短い walk / vehicle 区間は other にする | 3 分 | `--mode-min-min` |
| 速度による補完: Move かつ密な点で other に残った点（still・欠損を含む）を、同一ユーザー・トリップ・密な点列内の前後区間の見かけ速度（両方あれば平均）で判定。これ以下なら walk、これ以上なら vehicle、間や計算不能（同時刻など）は other のまま。OS ラベルの後・揺れ補正の前に適用 | 6 km/h, 12 km/h | `--walk-max-kmh`, `--vehicle-min-kmh` |
| 徒歩ジャンプ: 補正後に walk となった全点について、連続する walk 点間の見かけ速度がこれを超え、かつ距離がこれを超える区間を切る。切った区間は線を結ばず、方向転換・車→徒歩の判定もまたがない。点のラベルは変えない（points.csv の walk_break = 1 が切れ目の直後の点） | 15 km/h, 100 m | `--walk-jump-kmh`, `--walk-jump-min-m` |
| 車→徒歩: 同一トリップ内で vehicle 区間の次に walk 区間が来る。walk 区間の先頭点を出力 | | |
| 急な方向転換: 手前の区間（後方に L 以上離れた点から）と先の区間（前方に L 以上離れた点まで）の方位差がこれ以上。全モードの密な Move 点が対象 | 120°, L = 50 m | `--turn-min-deg`, `--turn-leg-m` |
| ビューワー軌跡: walk の点だけを描く | | |
| 精度フィルタ: accuracy がこれを超える点を除外 | なし | `--max-accuracy-m` |
| 範囲フィルタ: bbox 内の点だけを読み込み時に残す（GeoJSON の範囲からも指定可） | なし | `--bbox lon_min,lat_min,lon_max,lat_max` / `--area-geojson path` |
| ビューワー用出力の範囲: この bbox 内に点を持つユーザーだけ出力 | bbox と同じ | `--viewer-bbox` |
| 当日フィルタ: ファイル名の日付（YYYYMMDD）以外の行を除外 | オフ | `--only-main-date` |
| 試走: 先頭 N ユーザーだけ処理 / ビューワー出力を省略 | | `--sample-users N` / `--no-viewer` |
| 期間モード: イベント期間の開始時刻を与えると、そこから `PERIOD_HOURS` 時間（日をまたいでよい）をイベント、同じ時刻の `BASELINE_DAYS_BEFORE` 日前からを平時として、全入力ファイルから期間の行（前 1 時間を含む）を結合して処理する。時刻別ファイルは期間の先頭から 15 分刻み（例 12:00, 12:15, …, 23:45, 00:00, …, 11:45）で、交通 CSV の時刻列と同じ並びになる | なし（日別モード） | `--period-start "YYYY-MM-DD HH:MM"`, `--period-hours 24`, `--baseline-days-before 7` |

1 日 2,000 万行・25 万ユーザー規模を想定し、チャンク読み込みでフィルタを適用しながら読む。
notebook からは `import probe_trips; probe_trips.run([files], "out", "2024-08-21", AREA_GEOJSON="tokyo.geojson", ONLY_MAIN_DATE=True)` のように呼べる。
期間モードの例: `probe_trips.run([08-06, 08-07, 08-13, 08-14 の 4 ファイル], "out", PERIOD_START="2026-08-13 12:00")`（イベント 08-13 12:00 → 08-14 12:00、平時 08-06 12:00 → 08-07 12:00）。出力の日別ファイルは `event_20260813_1200_*`, `baseline_20260806_1200_*` の 2 組になる。

出力（`--out`）:

- `<stem>_points.csv`: userid, recordedat, lon, lat, accuracy, speed, activitytype + segment（Stay/Move）, stay_no, trip_no（ユーザー内の通し番号）, split_reason（start / stay / time_gap / jump）, dense（密な点列なら 1）, mode（walk / vehicle / other、Stay と疎な点は空）, flag（modechange / turn）, walk_break（徒歩ジャンプで切った直後の点なら 1）
- `<stem>_stays.geojson`: Stay ごとの重心 Point（開始・終了・滞在分・点数・最大半径）
- `<stem>_trips.geojson`: トリップごとの密な Move 点の LineString（全モード。5 分超の間隔で分割、n_move / n_dense / n_walk / n_vehicle、起点・終点に Stay があるか、距離）
- `<stem>_events.geojson`: 車→徒歩の変化点（at, v_before_kmh, gap_min）と急な方向転換点（at, mode, angle_deg）の Point
- 端末・Stay・トリップの識別子を持つのは points.csv だけ。GeoJSON と viewer/ の地物は属性のみで、端末をまたいで結び付けられない
- `viewer/<role>_<HHMM>.geojson` と `viewer/index.json`: ビューワー軌跡モード用。期間モードでは role は期間で決まり、index.json の `period` に各 role の開始時刻と長さを書く（ビューワーは降雨の日付をこれに合わせる）。日別モードでは role は `--event-date`（カンマ区切りで複数可）の日付なら event、他は baseline で、同じ role の日が複数あれば同じ時刻別ファイルにまとめて書く。各地物の `date` 属性はその窓の日付。
  各地物は kind = traj / dwell / modechange / turn、time = 15 分刻みの窓終端 "HH:MM"。識別子は持たない。
  軌跡は窓内 [time−60 分, time] の徒歩の密な Move 点（トリップ・点列境界で分割、複数なら MultiLineString）、
  滞留は窓に重なる Stay の重心 MultiPoint、変化点・方向転換点は窓内に時刻が入る Point。
  ビューワーは表示中の時刻のファイルだけを読むので `--viewer-bbox` は不要。
  `--merged-viewer` で従来の 1 日 1 ファイル形式も併せて出力できる。

合成データは格子状の仮想道路網で、実データではない。実データ規模（約 77,000 リンク × 48 時刻）での動作は未検証。
