# flood_viewer

東京 2024-08-21 の冠水候補分析（run2024.ipynb）の出力を地図で見るスタンドアローン HTML ビューワー。

- **交通モード**: リンクを 対象外（灰）/ 対象（黒）/ 異常（赤）で着色。タイムスライダー、再生、リンクホバーで平時・イベント時の速度と台数の時系列を表示。
- **閾値パネル（⚙）**: is_target の台数・速度、error1 の速度比・台数比・ほぼ消失、裏取り要否を画面で変更すると即時に再計算。error.csv を読み込んでいれば再計算結果との不一致セル数を表示。
- **軌跡モード**: 各リンク × 時刻の 1 時間軌跡（LineString）と滞留点（MultiPoint）を平時・イベント時で表示。ズーム 14 以上で有効。交通量の情報（着色・件数・時系列パネル）は表示しない。軌跡または滞留点にホバーすると、その軌跡と対応する滞留点だけを強調し、他を薄くする。クリックで固定。

## 使い方

配布物は `dist/flood_viewer_standalone.html` 1 ファイル（MapLibre GL JS 同梱、約 1.1 MB）。
ダブルクリックで開き、ノートブックの output フォルダのファイルをまとめて選択する。
output フォルダに置いて `python -m http.server` 経由で開けば自動で読み込む。

| ファイル | 必須 | 内容 |
|---|---|---|
| tokyo_20240821_network.geojson | 必須 | リンク形状。properties: id, pair_id |
| baseline_speed.csv / event_speed.csv / baseline_count.csv / event_count.csv | 必須 | リンク × 時刻の行列。id 列 + "HH:MM" 列 |
| error.csv | 任意 | ノートブックの最終 error。照合にのみ使用 |
| baseline_trajectory.geojson / event_trajectory.geojson | 任意 | LineString / MultiLineString。properties: id, time |
| baseline_dwell.geojson / event_dwell.geojson | 任意 | MultiPoint / Point。properties: id, time |

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
5. 軌跡モードのズーム制御、表示範囲内の件数、交通情報の非表示、軌跡ホバーでの強調と固定、平時オフ、M キー。
6. file:// で開いて必須 5 ファイルだけを選択した場合も同じ結果になり、軌跡ボタンが無効になること。
7. JavaScript エラーが発生していないこと。

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
| 時間ジャンプ: 連続点の間隔がこれを超えると新トリップ（同一 Stay 内の間隔は除く） | 30 分 | `--time-gap-min` |
| 位置ジャンプ: 連続点の見かけ速度がこれを超え、かつ距離がこれ以上 | 150 km/h, 500 m | `--jump-speed-kmh`, `--jump-min-dist-m` |
| 精度フィルタ: accuracy がこれを超える点を除外 | なし | `--max-accuracy-m` |
| 範囲フィルタ: bbox 内の点だけを読み込み時に残す（GeoJSON の範囲からも指定可） | なし | `--bbox lon_min,lat_min,lon_max,lat_max` / `--area-geojson path` |
| ビューワー用出力の範囲: この bbox 内に点を持つユーザーだけ出力 | bbox と同じ | `--viewer-bbox` |
| 当日フィルタ: ファイル名の日付（YYYYMMDD）以外の行を除外 | オフ | `--only-main-date` |
| 試走: 先頭 N ユーザーだけ処理 / ビューワー出力を省略 | | `--sample-users N` / `--no-viewer` |

1 日 2,000 万行・25 万ユーザー規模を想定し、チャンク読み込みでフィルタを適用しながら読む。
notebook からは `import probe_trips; probe_trips.run([files], "out", "2024-08-21", AREA_GEOJSON="tokyo.geojson", ONLY_MAIN_DATE=True)` のように呼べる。

出力（`--out`）:

- `<stem>_points.csv`: userid, recordedat, lon, lat, accuracy, speed, activitytype + segment（Stay/Move）, stay_no, trip_no（ユーザー内の通し番号）, split_reason（start / stay / time_gap / jump）
- `<stem>_stays.geojson`: Stay ごとの重心 Point（開始・終了・滞在分・点数・最大半径）
- `<stem>_trips.geojson`: トリップごとの Move 点の LineString（起点・終点 Stay、距離）
- `baseline_trajectory.geojson` / `baseline_dwell.geojson` / `event_trajectory.geojson` / `event_dwell.geojson`:
  ビューワー軌跡モード用。id = userid の先頭 12 文字、time = 15 分刻みの窓終端 "HH:MM"、
  軌跡は窓内 [time−60 分, time] の Move 点（トリップ境界で分割、複数なら MultiLineString）、
  滞留は窓に重なる Stay の重心 MultiPoint。`--event-date` の日付のファイルが event、他は baseline に集約される。

合成データは格子状の仮想道路網で、実データではない。実データ規模（約 77,000 リンク × 48 時刻）での動作は未検証。
