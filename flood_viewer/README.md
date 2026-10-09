# flood_viewer

東京 2024-08-21 の冠水候補分析（run2024.ipynb）の出力を地図で見るスタンドアローン HTML ビューワー。

- **タブ**: 車（道路リンクの異常）／軌跡（徒歩軌跡）／徒歩変化（メッシュのラスタ）の 3 つ。右上のボタンか M キーで切り替える。データの無いタブは無効。降雨と家電の点は全タブ共通の重ね合わせ。
- **車タブ（入力 1）**: リンクを 対象外（灰）/ 対象（黒）/ 異常 L1〜L3 で着色。タイムスライダー、再生、リンクホバーで平時・イベント時の速度と台数の時系列を表示、クリックで固定。
- **閾値パネル（⚙）**: is_target の台数・速度、異常レベル 1〜3 の速度比・台数比とその組み合わせ（または／かつ）、裏取り要否を画面で変更すると即時に再計算。error.csv を読み込んでいれば再計算結果との不一致セル数を表示。
- **軌跡タブ（入力 2）**: 各 ID × 時刻の直近 1 時間の徒歩軌跡（LineString）、滞留点、車→徒歩の変化点、急な方向転換点を平時・イベント時で表示。ズーム 14 以上で有効。交通量の情報は表示しない。地物のホバーで属性、クリックでその地物だけを太く描く。種類ごとの表示切替と「最寄りの軌跡へ」。人流フォルダ内の grid*/ や入力 3 のメッシュを「徒歩変化」で道路の下に重ねられる。
- **徒歩変化タブ（入力 3、または人流フォルダ内の grid*/）**: 道路を描かず、選んだ層のラスタだけを重ねる。walk_mesh.ipynb の grid_walk25（25 m メッシュの徒歩ユニーク人数、平時・有事・比）、grid_users.py、probe_trips.py の grid/ を読む。比率の層（有事 ÷ 平時）は閾値で塗り分け（既定: 200 % 以上 = 赤、50 % 以下 = 青、その間 = 薄い灰、平時 0 = 透明）、件数の層は 0 を透明にして上限までの 5 段階の青。時刻に連動し、カーソル位置の値を表示。層の名前と単位は各フォルダの index.json の labels / units から取る。
- **家電（入力 4、全タブ）**: kaden_compare.ipynb の kaden_event_ts.csv / kaden_baseline_ts.csv（行 = 郵便番号、列 = 15 分の窓）を読み、郵便番号の代表点を常に描く。丸の大きさ = 平時の台数、色 = 発災日/平時の比（1/3 以下 赤、2/3 以下 橙、平時並み 灰、3 倍以上 青。平時 5 台未満は判定せず薄く）。ホバーで比と台数の時系列（平時・発災日）をグラフに、クリックで固定。チェックで表示切替。列名は "HH:MM"（当日）か "MM-DD HH:MM"（複数日）で、スライダーの時刻と日付で突き合わせる。
- **降雨（XRAIN、入力 5）**: xrain_to_geotiff.py の出力フォルダ（rain_YYYYMMDD_HHMM.tif。index.json は無くてよい）を入力 5 で選ぶか、車流フォルダの中の rain/ に置くと、全タブ共通で道路の下に半透明で重ねる。時刻スライダーに連動して 15 分スロットの GeoTIFF を読み、気象庁の降水強度凡例と同じ 8 段階で着色（1 mm/h 未満は透明）。カーソル位置の値を上部に表示。チェックで表示切替。
- **SNS 投稿（入力 6、全タブ）**: CSV を複数読み、緯度経度のある投稿を地点に描く。2 つの列構成をヘッダで判別する: FASTALERT 形式（投稿ID, 日時, 事象区分, 事象名, 市区町村, 字・番地, 緯度, 経度, 範囲, 投稿文, 写真動画）と、post_id, post_datetime_jst（ISO、+09:00 は JST の壁時計として読む）, source_category, message_summary, municipality, location_text, latitude, longitude, message, post_url, media_page_url / photo_url / video_url, platform, author_handle, location_level, coordinate_confidence, inclusion_status, review_flags, notes, flood_evidence の形式（UTF-8 / cp932）。スライダーの時刻に終わる窓（直近 1 時間 / 3 時間 / 当日 0 時から / すべて）の投稿だけを表示し、同じ地点の投稿は 1 つの丸にまとめて件数で大きさを変える。クリックで引き出し線付きの枠に本文・時刻・区分・場所・投稿者・位置の確からしさ・投稿と写真動画のリンクが出て、同地点の投稿を前後に送れる。色は区分。
- **メッシュのツールチップ**: 徒歩変化タブ（と軌跡タブでメッシュを重ねたとき）は、カーソルの下のセルの層名・窓・値を吹き出しで表示する。
- 2026-10-07 に、トラックタブ・デフォルトタブ・浸水域 shp・低位地帯の重ね合わせを削除した（git 履歴にあり。必要なら戻せる）。SNS 投稿は 10-08 に入力 6 として戻した。

## 使い方

配布物は `dist/flood_viewer_standalone.html` 1 ファイル（MapLibre GL JS 同梱、約 1.1 MB）。
ダブルクリックで開き、フォルダ（1: 車流 = tomtom_out（必須）、2: 人流 = probe_out（viewer/ と grid*/）、3: 徒歩変化のメッシュ = grid_walk25 など、4: 家電 = kaden_out、5: 降雨 = xrain_to_geotiff.py の出力、6: SNS 投稿の CSV）を選んで「読み込む」を押す（時刻別ファイルは表示時に必要な分だけ読む）。rain/ が 1 のフォルダに入っていれば 5 は省略できる。
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
| 入力 4 のフォルダ: <任意の名前><YYYYMMDDHHMM>.shp / .dbf（/ .cpg） | 任意 | 浸水域ポリゴン（WGS84）。各時刻には、その時刻以前の最新のファイルを表示。属性の浸水深（列名に「浸水深」または depth）で塗り分け。フォルダ選択のみ（http では読まない） |
| 入力 6: グリッドのフォルダ（grid_users/ や grid/） | 任意 | index.json とラスタをそのまま読む。人流フォルダ内の grid*/ と同じ扱い |
| 入力 5: SNS 投稿 CSV（複数可） | 任意 | 緯度経度のある投稿を地点に表示。フォルダ選択ではなくファイル選択（http では読まない） |
| grid*/<param>[_<role>]_<HHMM>.tif + index.json | 任意 | 100 m メッシュのラスタ。grid/ は probe_trips.py の比率（有事 ÷ 平時、平時 0 のセルは NaN）、grid_users/ は grid_users.py のユニーク ID 数（平時・有事の件数と比率）。`grid` で始まるフォルダをすべて読む。軌跡モードで選んだ層のその時刻のラスタを道路の下に半透明で描く。比率は閾値、件数は上限までの段階で塗る |
| 入力 3 のフォルダ: network_agg.shp/.dbf + traffic_YYYYMMDD_HHMM.csv | 任意 | トラックプローブのリンク統計（`probe/truck_traffic.ipynb` の出力）。形状は network_agg.shp をページ内で読む（外部ライブラリなし）。時刻別 CSV の日付から平時・有事を決める（人流の期間に合えばその期間、合わなければ最新日 = 有事、他 = 平時）。フォルダ選択のみ（http では読まない） |

`time` は 1 時間ウィンドウの終端で CSV ヘッダと同じ "HH:MM"。ISO 形式でも HH:MM 部分で照合する。

判定論理はノートブックと同じ:

```
is_target = baseline_count >= MIN_BASE_COUNT AND baseline_speed >= MIN_BASE_SPEED
error1_k  = speed_ratio <= LEVEL_k.speed OR count_ratio <= LEVEL_k.count      (k = 1, 2, 3 = 0.75 / 0.60 / 0.50)
error_k   = is_target AND error1_k AND (対向リンクが同時刻に is_target&error1_k OR 同一リンクが前後 15 分に is_target&error1_k)
error_level = 満たした最も厳しい k（0 = 異常なし）。リンクは L1 橙 / L2 赤 / L3 暗赤で着色
```

## シンプル版（車流 + 降雨のみ）: flood_viewer_simple.html

車流（TomTom の異常リンク）と降雨（XRAIN）だけを表示する版。配布物は `dist/flood_viewer_simple_standalone.html` 1 ファイル（約 1.1 MB）。
入力は 1: 車流のフォルダ（必須。tomtom_out そのまま、または個別ファイル）と 2: 降雨のフォルダ（任意。1 の中の rain/ でも可）の 2 つだけで、
タブ・軌跡・徒歩変化・家電・SNS は無い。道路の着色、閾値パネル（⚙）、ホバーの時系列グラフ、再生・キー操作、降雨の切替と凡例、カーソル位置の降雨強度は本体と同じ。
期間モード（viewer/index.json）が無いので、降雨の日付はプルダウンで選ぶ「最初の時刻（スライダー左端）の日付」とし、時刻軸が日付をまたぐところ（23:45 → 00:00）から翌日のファイルを使う。
既定の日付はネットワークファイル名の YYYYMMDD（フォルダにその日のファイルがあるとき。無ければ最後の日付）。選んだ日付のファイルが無い時刻は「この時刻の降雨なし」で、別の日の降雨は出さない。

`flood_viewer_simple.html` は生成ファイル（先頭に GENERATED の注記）。`build_simple.mjs` が `flood_viewer_simple.template.html`（画面と固有の処理）に、
`flood_viewer.html` の共通関数（CSV / GeoTIFF の解析、異常判定、グラフ、降雨の描画など。テンプレートの `// @from flood_viewer.html: 名前, …` 行）と
CONFIG の必要な項目（`// @config from flood_viewer.html: …` 行）、MapLibre のタグをそのまま埋め込んで作る。本体を直せばシンプル版にも `npm run build` で反映される。
直すときはテンプレートか本体を編集して `npm run build` し、生成された `flood_viewer_simple.html` も一緒にコミットする（テストが生成結果との一致を確かめる）。
配布先向けの使い方は `README_simple_viewer.txt`（単独で読める 1 枚もの。本体やビルドには触れない）。

## 開発・テスト

```
npm install                      # maplibre-gl, playwright
npx playwright install chromium  # 初回のみ
npm run data                     # sample/output に合成データ 10 ファイルを生成（numpy, pandas が必要）
npm run build                    # flood_viewer_simple.html を生成し、dist/ に 2 つの standalone HTML（本体・シンプル版）を作る
npm test                         # Playwright + node:test によるブラウザテスト（tests/viewer.test.js と tests/simple.test.js）
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
10c. SNS 投稿: CSV の読み込み（引用符・改行マーカー）、窓による絞り込み、同地点の束ね、クリックの引き出し枠と前後送り、表示切替。
10b. 浸水域: 4 時点の shp の登録、時刻以前の最新ファイルの選択と経過分、cp932 の列名と浸水深、ホバーの属性、最大経過時間、表示切替。
10. トラックタブ: network_agg.shp/.dbf と時刻別 CSV の読み込みと日付の役割分け、平時 2 台以上の描画と 50 % 以下の赤、CSV からの独立再集計との一致、ホバーの統計パネル、閾値変更、M キーの 3 タブ巡回。
11. グリッド重畳: grid/index.json からの登録、軌跡モードでの表示と時刻連動、指標の切替、表示切替、カーソル位置の判定。
12. JavaScript エラーが発生していないこと。

シンプル版（`tests/simple.test.js`）: 生成ファイルがテンプレートと本体から作り直した結果と一致し、本体のタブ・重ね合わせを含まないこと。http での読み込みと error.csv との全セル一致、
スライダー・キー・再生、ホバーのグラフと固定・解除、閾値パネル、降雨（登録、最初の時刻の日付 + 日付またぎ、GeoTIFF の復号、カーソルの値、切替、日付変更で該当日の無い時刻は降雨なし）、
file:// でのファイル選択 + 降雨フォルダ、フォルダ選択（中の rain/ と error.csv）、降雨なし、JavaScript エラーなし。

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

1 秒毎のトラックプローブ（zip 内の CSV: serial_number, record_time, speed, gps_latitude, gps_longitude, …。ファイルの分割単位は問わない）を
TomTom 道路ネットワーク shp に動的計画法で割り付け、15 分ウィンドウ × リンク別の車両数 Hits と平均速度 AvgSp を出す。
セル単位で意味を確認しながら進める想定の ipynb（`build_truck_traffic_nb.py` から生成）。1 節 = 1 ステップで、中間ファイルから再開できる。

1. ネットワーク集約: 座標列が同じ（逆向きも同じ）リンクを 1 本に統合。代表 Id = メンバー中の最小 Id。`network_agg.csv` / `.shp`。
   端点（0.1 m で丸め）からノードと隣接表を作り、リンクごとに「網の距離 250 m 以内で届くリンク」の近傍表を初回に計算して辞書にキャッシュ
2. 1 回目の読み込み: 全ファイルを 200 万行ずつ走査し（ID・緯度・経度の 3 列）、区域ポリゴン（`AREA_GEOJSON`）内に 1 点でも持つ車両 ID を
   辞書で集める → `vehicles_in_area.csv`（車両 ID を含む）。行数と緯度経度の欠損もファイルごとに数える
3. 2 回目の読み込み: 通過車両の行だけ残し、残した行だけ時刻を解釈して欠損を除き、リンクの範囲外の点を落とし、
   `POINT_STEP_S`（既定 10 秒）ごとの最初の 1 点に間引いて、車両・時刻順の 1 つの表に → `trajectories.parquet`（pyarrow が無ければ `.csv.gz`）。
   以降はこの表だけが入力。間引きで点数が約 1/10 になり、節 4〜7 の時間もほぼ比例して減る。
   代わりに進入・退出時刻の誤差が最大 10 秒になり、10 秒 × 3 点未満の短い走行は経路を決められず落ちる
4. 候補（step 5-1）: 車両ごとの点列（120 秒超の欠測で切る）を 30 m / 60 秒ごとに間引き、各点から 50 m 以内で近い順に 5 本を候補にする。
   候補の無い点で点列を切る（間引き後 3 点未満の区間は使わない）
5. 動的計画法（step 5-2, 5-3）: 観測コスト (点からリンクまでの距離 / 15 m)^2。遷移コストは 同一リンク = 0、接続リンク =
   1 × 乗り換え本数 + 2 × |経路距離 − 直線距離| / 直線距離、それ以外 = 対象外。点ごとに各候補の最小総コストだけを残して
   次の点へ進み（点数 × 5 × 5 の評価）、最後の点の最小コストから逆にたどった列を経路にする。どの候補にも届かない点で区間を切って再開
6. 各点にリンクを付け、リンクごとの進入・退出時刻を出す（step 6）: 区間の経路を 1 本の折れ線とみなして各 1 秒点の道のり（弧長）を求め（時間順に単調）、
   弧長が含まれるリンクをその点のリンクにする。リンク境界をまたいだ時刻を前後の点から線形補間して進入・退出時刻にする（点の落ちない短いリンクも時刻を持つ）
   → `matched_points.parquet`（serial_number, t, lat, lon, speed, Id, StreetName, FRC, SpeedLimit, Length）と
   `link_stays.parquet`（serial_number, Id, t_enter, t_exit, n_points, v_mean, リンク属性）。どちらも車両 ID を含む
7. 15 分 × リンクの統計: 滞在を進入した窓から退出した窓まで展開して Hits（その窓にいた車両数）を数え、速度はその窓・そのリンク上の点の平均。
   ウィンドウ内の最高速度 < 3 km/h の車両（駐停車）は数えない → `traffic_YYYYMMDD_HHMM.csv`（Id, Hits, AvgSp, MedSp, n_points）、`traffic_15min.csv`
8. `summary.json`（行数、通過車両数、点数、区間数、付かなかった点数、滞在数、点の無い滞在数など）
9. 直近 1 時間の軌跡（旧節 8、`traj/`）は廃止。ビューワーも読まない

### walk_mesh.ipynb: 直近 1 時間の徒歩ユニーク人数を 25 m メッシュで（`probe/build_walk_mesh_nb.py` が生成）

probe_trips.py の `*_points.csv`（利用者 ID を含む唯一の出力）だけを読む独立のノートブック（probe_trips.py は import しない）。
徒歩の点（segment = Move かつ dense = 1 かつ mode = walk。`WALK_ONLY = False` で全点）について、15 分スロットごとに窓 (T−60 分, T] に
セル内の点を持つ利用者 ID の数を 25 m メッシュで数え（`TRACE_SEGMENTS = True` なら、ビューワーが線で結ぶ連続点の線分を `SAMPLE_M` = 5 m ごとに刻み、
軌跡が通過したセルにも利用者を割り付ける。刻んだ点の時刻は線形補間）、`grid_walk25/walk25_{baseline,event}_HHMM.tif`（日平均の人数、nodata −99）、
`walk25_HHMM.tif`（有事/平時。平時が MIN_BASE_USERS（既定 5 人）未満のセルは NaN）、`index.json` を書く。役割はファイル名（期間モードの baseline_/event_、日別モードは EVENT_DATE）から、
メッシュの範囲は GRID_BBOX、無ければ既存の grid/index.json の bounds（100 m グリッドと揃う）、無ければ点の範囲。
出力フォルダ名が grid で始まるので、人流フォルダ（入力 2）の中に置けばビューワーのグリッド層に自動で加わる（入力 6 で直接指定してもよい）。
さらに、比が RATIO_LOW（1/3）以下または RATIO_HIGH（3 倍）以上のセルを、窓ごとに `anomaly/walk25_anomaly_HHMM.geojson`（セルの四角形。属性 cell, row, col, time, baseline, event, ratio, kind = low/high。該当なしでも空ファイル）に書く。
テストは `test_probe_trips.py` の test_walk_mesh_nb。

### kaden_compare.ipynb: 家電データ（シャープ）の郵便番号別接続台数を平時と比べる（`probe/build_kaden_compare_nb.py` が生成）

15 分ごとの全国スナップショット `YYYYMMDDHHMM_15M_*.csv`（郵便番号 × メーカー × 家電種別の接続台数 count）を有事の日・平時の日のフォルダから読み、
郵便番号を GeoNames 形式の表（タブ区切り、490-1401 の形）で代表点に変えて、同じ時刻の窓で比較する。numpy と pandas だけで動く。
対象は BBOX か AREA_GEOJSON の外接矩形の中の郵便番号。家電種別（echonet_object の先頭 4 桁）とメーカーで絞れる（既定は全種別の合計）。
比 = 有事/平時（平時複数日は日平均、有事に行が無ければ 0）、平時 MIN_BASE_COUNT（5 台）以上だけ判定、減少 = 比 ≤ 1/3、増加 = 比 ≥ 3、
REQUIRE_ADJACENT なら前後の窓でも同じ判定のときだけ異常。出力は `kaden_15min.csv`（窓 × 郵便番号の表、緯度経度付き）、
`kaden_event_ts.csv` / `kaden_baseline_ts.csv` / `kaden_ratio_ts.csv`（行 = 郵便番号、列 = 15 分の窓。発災日と前日の時系列を同じ並びで）、`kaden_zips.csv` / `.geojson`（郵便番号ごとのまとめ）、
`anomaly/kaden_anomaly_YYYYMMDD_HHMM.geojson`（異常の郵便番号の点。該当なしでも空ファイル）、
`grid_kaden/kaden_{baseline,event}_HHMM.tif` + `kaden_HHMM.tif` + `index.json`（代表点を CELL_M = 250 m のセルに集計。ビューワーの入力 6 で読める）。
発災日は EVENT_DIRS に複数日を並べれば 1 本の時系列として扱い（列名は MM-DD HH:MM）、ラスタだけ日ごとの `grid_kaden_YYYYMMDD/`（層名 kaden0813 など）に分ける。
データの意味（count = その 15 分に接続していた台数、窓の時刻 = ファイル名）はサンプルからの解釈で、仕様書は未入手。テストは `test_kaden_compare.py`。

### truck_compare.ipynb: 平時と有事の比較 → 異常リンクの GeoJSON（`probe/build_truck_compare_nb.py` が生成）

truck_traffic.ipynb を平時の日（例 2024-08-20、2025-09-10）と有事の日（08-21、09-11）で実行した出力フォルダを比べる。
run2024.ipynb と同じ定義: 比率 = 有事/平時（平時が複数日なら台数は日平均、速度は平均）、判定対象 = 平時 Hits ≥ 5 かつ AvgSp ≥ 10、
L1 = 速度比 ≤ 0.5 または台数比 ≤ 0.5、L2 = 両方 ≤ 0.5、L3 = 両方 ≤ 0.25、さらに同じリンクが隣接する窓でも同レベル。
対向リンクの条件は、truck_traffic の節 1 で向きの違う同形状リンクを 1 本にしているため使わない。
出力は `error_geojson/error_L{レベル}_{YYYYMMDD}_{HHMM}.geojson`（その窓でちょうどそのレベルのリンクだけ。該当なしでも空ファイル。全窓 × 3 レベル）と
`error_15min.csv`（全窓 × リンクの判定表）。テストは `test_truck_traffic.py` の check_compare。

以前の版（ファイルごとに処理）は、同じ時刻の軌跡ファイルをファイルごとに上書きしていた（最後のファイルの車両しか残らない）。
2 回読みにして全車両の表から書くことで、この問題は構造的に起きない。

```
python3 probe/test_truck_traffic.py     # 合成ネットワーク + 合成プローブ zip（時間で 2 分割）でノートブックのセルを順に実行し、区域あり（1 秒）・区域なし（1 秒）・既定の 10 秒間引き の 3 通りを検証
```

目安（合成データでの実測: 格子状のネットワーク 19,800 リンク、500 台 × 1,000 秒 = 点 50 万、GPS 誤差 5 m、非圧縮 CSV 1 ファイル）: 全体 36 秒（走査 0.5 秒、抽出 0.7 秒、間引き・候補 1.4 秒、動的計画法 5.6 秒、点へのリンク付与 2.8 秒、集計 0.5 秒、軌跡 GeoJSON 11 秒、残りはネットワーク構築）、ピークメモリ 0.6 GB。実データでは 1 GB 級 CSV × 20 の読み込みを 2 回行う分（1 回あたり数十分）が加わる。動的計画法の計算量は 間引き後の点数 × 候補数² に比例するので、遅ければ `SAMPLE_M` を大きくするか `AREA_GEOJSON` で範囲を絞る。

## 単純集計: ユニーク ID 数のグリッド（probe/grid_users.py, grid_users/）

probe_trips.py のグリッドが徒歩・滞留・方向転換などを「直近 1 時間」で数えるのに対し、こちらは 1 つだけ数える単純版:
各 100 m セル × 15 分スロットで、その窓にセル内に 1 点でも持つ利用者 ID の数（Stay/Move やモードの判定なし、全点を使う）。
入力と期間指定は probe_trips.py と同じ（日別 CSV、`--period-start` で日をまたぐ期間、無ければ `--event-date` でファイルの役割分け）。
窓は (T − WINDOW_MIN, T] で既定 15 分（= 単純な 15 分ビン）。60 にすれば「直近 1 時間」になる。

```
python3 probe/grid_users.py 2024-08-14.csv.gz 2024-08-21.csv.gz --out probe_out --period-start "2024-08-21 12:00" --grid-network probe_out/tokyo_20240821_network.geojson
```

出力 `probe_out/grid_users/`: `users_baseline_HHMM.tif`、`users_event_HHMM.tif`（件数。複数日は平均）、`users_HHMM.tif`（有事 ÷ 平時、平時 0 は NaN）、`index.json`
（labels / units / window_min を含み、ビューワーはこれで層名と単位を出す）。自己テストは `test_probe_trips.py` の `test_grid_users` にある。

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
| 時間ジャンプ: 連続点の間隔がこれを超えると新トリップ（同一 Stay 内の間隔は除く）。記録は通常 1 分間隔なので 2 分 = 欠測 1 回まで許す | 2 分 | `--time-gap-min` |
| 位置ジャンプ: 連続点の見かけ速度がこれを超え、かつ距離がこれ以上 | 150 km/h, 500 m | `--jump-speed-kmh`, `--jump-min-dist-m` |
| 密な点列: 間隔がこれ以下で連続し、この点数以上の点列だけを軌跡・トリップの線として描く（Stay 判定には掛けない。`--dense-for-stays` で掛ける） | 2 分, 5 点 | `--dense-max-gap-min`, `--dense-min-points`（0 で無効） |
| Stay の統合: 連続する Stay の間隔がこれ以下で、重心が Stay 半径の 2 倍以内なら 1 つの Stay にする（間の短い外出点も Stay に含める） | 10 分 | `--stay-merge-gap-min`（0 で無効） |
| 移動モード: 密な Move 点に OS の activitytype を当てる。walk = on_foot / walking / running、vehicle = in_vehicle / on_bicycle、other = それ以外（still, unknown, 欠損）。ラベルは短く揺れるので、同じモードに挟まれたこれより短い区間はそのモードに吸収し（1 回の走査では両隣より短い区間だけ）、残った短い walk / vehicle 区間は other にする | 3 分 | `--mode-min-min` |
| 速度による補完: Move かつ密な点で other に残った点（still・欠損を含む）を、同一ユーザー・トリップ・密な点列内の前後区間の見かけ速度（両方あれば平均）で判定。これ以下なら walk、これ以上なら vehicle、間や計算不能（同時刻など）は other のまま。OS ラベルの後・揺れ補正の前に適用 | 6 km/h, 12 km/h | `--walk-max-kmh`, `--vehicle-min-kmh` |
| 徒歩ジャンプ: 補正後に walk となった全点について、連続する walk 点間の見かけ速度がこれを超え、かつ距離がこれを超える区間を切る。切った区間は線を結ばず、方向転換・車→徒歩の判定もまたがない。点のラベルは変えない（points.csv の walk_break = 1 が切れ目の直後の点） | 12 km/h, 100 m | `--walk-jump-kmh`, `--walk-jump-min-m` |
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
- `<stem>_trips.geojson`: トリップごとの密な Move 点の LineString（全モード。2 分超の間隔で分割、n_move / n_dense / n_walk / n_vehicle、起点・終点に Stay があるか、距離）
- `<stem>_events.geojson`: 車→徒歩の変化点（at, v_before_kmh, gap_min）と急な方向転換点（at, mode, angle_deg）の Point
- 端末・Stay・トリップの識別子を持つのは points.csv だけ。GeoJSON と viewer/ の地物は属性のみで、端末をまたいで結び付けられない
- `viewer/<role>_<HHMM>.geojson` と `viewer/index.json`: ビューワー軌跡モード用。期間モードでは role は期間で決まり、index.json の `period` に各 role の開始時刻と長さを書く（ビューワーは降雨の日付をこれに合わせる）。日別モードでは role は `--event-date`（カンマ区切りで複数可）の日付なら event、他は baseline で、同じ role の日が複数あれば同じ時刻別ファイルにまとめて書く。各地物の `date` 属性はその窓の日付。
  各地物は kind = traj / dwell / modechange / turn、time = 15 分刻みの窓終端 "HH:MM"。識別子は持たない。
  軌跡は窓内 [time−60 分, time] の徒歩の密な Move 点（トリップ・点列境界で分割、複数なら MultiLineString）、
  滞留は窓に重なる Stay の重心 MultiPoint、変化点・方向転換点は窓内に時刻が入る Point。
  ビューワーは表示中の時刻のファイルだけを読むので `--viewer-bbox` は不要。
  `--merged-viewer` で従来の 1 日 1 ファイル形式も併せて出力できる。

合成データは格子状の仮想道路網で、実データではない。実データ規模（約 77,000 リンク × 48 時刻）での動作は未検証。
