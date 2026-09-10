# flood_viewer

東京 2024-08-21 の冠水候補分析（run2024.ipynb）の出力を地図で見るスタンドアローン HTML ビューワー。

- **交通モード**: リンクを 対象外（灰）/ 対象（黒）/ 異常（赤）で着色。タイムスライダー、再生、リンクホバーで平時・イベント時の速度と台数の時系列を表示。
- **閾値パネル（⚙）**: is_target の台数・速度、error1 の速度比・台数比・ほぼ消失、裏取り要否を画面で変更すると即時に再計算。error.csv を読み込んでいれば再計算結果との不一致セル数を表示。
- **軌跡モード**: 各 ID × 時刻の直近 1 時間の徒歩軌跡（LineString）、滞留点、車→徒歩の変化点、急な方向転換点を平時・イベント時で表示。ズーム 14 以上で有効。交通量の情報（着色・件数・時系列パネル）は表示しない。地物のホバーで属性を表示し、クリックで同じ ID の地物だけを強調して他を薄くする（もう一度クリックか空白のクリックで解除）。ホバーで強調しないのは、大きな時刻でマウス移動ごとに 16 レイヤーを再フィルタすると遅延が大きいため。種類ごとの表示切替と「最寄りの軌跡へ」（現在時刻のデータのうち地図中心に最も近いものへ移動）を備え、状態行に表示範囲内の件数・その時刻のファイル全体の件数・見つからないファイル名を出す。

## 使い方

配布物は `dist/flood_viewer_standalone.html` 1 ファイル（MapLibre GL JS 同梱、約 1.1 MB）。
ダブルクリックで開き、「フォルダごと選択」で output フォルダを選ぶ（viewer/ の時刻別ファイルは表示時に必要な分だけ読む）。
output フォルダに置いて `python -m http.server` 経由で開けば自動で読み込む。

| ファイル | 必須 | 内容 |
|---|---|---|
| tokyo_20240821_network.geojson | 必須 | リンク形状。properties: id, pair_id |
| baseline_speed.csv / event_speed.csv / baseline_count.csv / event_count.csv | 必須 | リンク × 時刻の行列。id 列 + "HH:MM" 列 |
| error.csv | 任意 | ノートブックの最終 error。照合にのみ使用 |
| viewer/<role>_<HHMM>.geojson + viewer/index.json | 任意（推奨） | 時刻別の軌跡・滞留・変化点（properties.kind = traj / dwell / modechange / turn, id, time）。スライダーの時刻のファイルだけを読むので全域を出力できる |
| baseline_trajectory.geojson / event_trajectory.geojson | 任意 | 1 日分をまとめた LineString / MultiLineString。properties: id, time。小規模向け |
| baseline_dwell.geojson / event_dwell.geojson | 任意 | 同、MultiPoint / Point |

`time` は 1 時間ウィンドウの終端で CSV ヘッダと同じ "HH:MM"。ISO 形式でも HH:MM 部分で照合する。

判定論理はノートブックと同じ:

```
is_target = baseline_count >= MIN_BASE_COUNT AND baseline_speed >= MIN_BASE_SPEED
error1    = count_ratio < ZERO_COUNT_RATIO_LIMIT OR (speed_ratio <= SPEED_RATIO_LIMIT AND count_ratio <= COUNT_RATIO_LIMIT)
error     = is_target AND error1 AND (対向リンクが同時刻に is_target&error1 OR 同一リンクが前後 15 分に is_target&error1)
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

1. 10 ファイルの読み込み。既定閾値での画面内再計算が Python 側で独立に計算した error.csv と全セル一致すること、時刻別の異常本数が error.csv の列集計と一致すること。
2. スライダー、キー操作、再生。
3. 異常リンクのホバーでパネル・異常帯・2 系列が出て、クリックで固定できること。
4. 閾値変更で件数が変わり、既定値に戻すと元の件数に戻ること。
5. 軌跡モードのズーム制御、時刻別ファイルの遅延読み込みとキャッシュ、表示範囲内の件数と全体件数の診断、4 種類の地物の描画と種類別の表示切替、交通情報の非表示、軌跡ホバーのツールチップとクリックでの強調・解除、平時オフ、「最寄りの軌跡へ」、M キー。
6. file:// で開いて必須 5 ファイルだけを選択した場合も同じ結果になり、軌跡ボタンが無効になること。
7. file:// でフォルダごと選択すると viewer/ の時刻別ファイルが登録され、表示時に FileReader で読まれること。
8. viewer/ が無く 1 日 1 ファイルの軌跡 GeoJSON だけの場合も従来通り読めること。
9. JavaScript エラーが発生していないこと。

GitHub Actions（`.github/workflows/flood-viewer.yml`）が `flood_viewer/` の変更で同じ手順を実行し、
standalone HTML とスクリーンショットをアーティファクトとして残す。

## 位置ログの前処理（probe/）

端末の位置ログ（1 行 1 測位: id, recordedat, lon, lat, accuracy, speed, userid, ... の日別 CSV）から
Stay/Move 判定、トリップ ID 付与、ビューワー用 GeoJSON を作る。

```
python3 probe/probe_trips.py 2024-08-14.csv 2024-08-21.csv --out probe_out --event-date 2024-08-21
python3 probe/test_probe_trips.py     # 合成軌跡による自己テスト
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
| 移動モード: 密な Move 点に OS の activitytype を当てる。walk = on_foot / walking / running、vehicle = in_vehicle、other = それ以外（still, on_bicycle, unknown, 欠損）。ラベルは短く揺れるので、同じモードに挟まれたこれより短い区間はそのモードに吸収し、残った短い walk / vehicle 区間は other にする | 3 分 | `--mode-min-min` |
| 車→徒歩: 同一トリップ内で vehicle 区間の次に walk 区間が来る。walk 区間の先頭点を出力 | | |
| 急な方向転換: 手前の区間（後方に L 以上離れた点から）と先の区間（前方に L 以上離れた点まで）の方位差がこれ以上。全モードの密な Move 点が対象 | 120°, L = 50 m | `--turn-min-deg`, `--turn-leg-m` |
| ビューワー軌跡: walk の点だけを描く | | |
| 精度フィルタ: accuracy がこれを超える点を除外 | なし | `--max-accuracy-m` |
| 範囲フィルタ: bbox 内の点だけを読み込み時に残す（GeoJSON の範囲からも指定可） | なし | `--bbox lon_min,lat_min,lon_max,lat_max` / `--area-geojson path` |
| ビューワー用出力の範囲: この bbox 内に点を持つユーザーだけ出力 | bbox と同じ | `--viewer-bbox` |
| 当日フィルタ: ファイル名の日付（YYYYMMDD）以外の行を除外 | オフ | `--only-main-date` |
| 試走: 先頭 N ユーザーだけ処理 / ビューワー出力を省略 | | `--sample-users N` / `--no-viewer` |

1 日 2,000 万行・25 万ユーザー規模を想定し、チャンク読み込みでフィルタを適用しながら読む。
notebook からは `import probe_trips; probe_trips.run([files], "out", "2024-08-21", AREA_GEOJSON="tokyo.geojson", ONLY_MAIN_DATE=True)` のように呼べる。

出力（`--out`）:

- `<stem>_points.csv`: userid, recordedat, lon, lat, accuracy, speed, activitytype + segment（Stay/Move）, stay_no, trip_no（ユーザー内の通し番号）, split_reason（start / stay / time_gap / jump）, dense（密な点列なら 1）, mode（walk / vehicle / other、Stay と疎な点は空）, flag（modechange / turn）
- `<stem>_stays.geojson`: Stay ごとの重心 Point（開始・終了・滞在分・点数・最大半径）
- `<stem>_trips.geojson`: トリップごとの密な Move 点の LineString（全モード。5 分超の間隔で分割、n_move / n_dense / n_walk / n_vehicle、起点・終点 Stay、距離）
- `<stem>_events.geojson`: 車→徒歩の変化点（at, v_before_kmh, gap_min）と急な方向転換点（at, mode, angle_deg）の Point
- `viewer/<role>_<HHMM>.geojson` と `viewer/index.json`: ビューワー軌跡モード用。role は `--event-date` の日付なら event、他は baseline。
  各地物は kind = traj / dwell / modechange / turn、id = userid の先頭 12 文字、time = 15 分刻みの窓終端 "HH:MM"。
  軌跡は窓内 [time−60 分, time] の徒歩の密な Move 点（トリップ・点列境界で分割、複数なら MultiLineString）、
  滞留は窓に重なる Stay の重心 MultiPoint、変化点・方向転換点は窓内に時刻が入る Point。
  ビューワーは表示中の時刻のファイルだけを読むので `--viewer-bbox` は不要。
  `--merged-viewer` で従来の 1 日 1 ファイル形式も併せて出力できる。

合成データは格子状の仮想道路網で、実データではない。実データ規模（約 77,000 リンク × 48 時刻）での動作は未検証。
