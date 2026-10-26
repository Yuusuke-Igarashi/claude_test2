# 冠水候補ビューア 入力ファイル仕様

別の notebook の出力を冠水候補ビューアで表示するための、ファイルの仕様です。
対象は `flood_viewer_simple_standalone.html`（2026-10 版、「欠測の扱い」スイッチあり）。本体版 `flood_viewer_standalone.html` も、車流と降雨のファイルは同じ関数で読みます（時間軸の決め方だけが違い、6 章の表に注記しました）。
書いてあるのは「ビューアのコードが実際にどう読むか」です。notebook 内部の計算は自由ですが、error.csv を出す場合は 9 章の判定式に合わせてください。

## 1. フォルダ構成

1 つの出力フォルダにまとめます。

| ファイル | 必須 | 役割 |
|---|---|---|
| `viewer.json` | 推奨 | 期間（開始日時）、判定の閾値、ネットワークのファイル名 |
| `YYYYMMDD_network.geojson` | 必須 | リンク形状と対向リンク |
| `baseline_speed.csv` `event_speed.csv` `baseline_count.csv` `event_count.csv` | 必須 | リンク × 窓の行列（平時・当日の速度と台数） |
| `error.csv` | 任意 | notebook の判定結果。画面の再計算との照合表示にだけ使う |
| `error_geojson/error_L{1,2,3}_YYYYMMDD_HHMM.geojson` | 任意 | 中身は読まない。viewer.json が無いとき、名前から期間の開始を決める（フォルダ選択時のみ） |
| `rain/rain_YYYYMMDD_HHMM.tif` と `rain/index.json` | 任意 | 降雨の GeoTIFF。別フォルダにして入力 2 で選んでもよい |

- フォルダ選択では、サブフォルダを含む全ファイルを**ファイル名だけ**で振り分けます。同じ名前のファイルを 2 か所に置かないでください（どちらが使われるかは決まりません。viewer.json だけは最初に見つかったもの）。
- 上の表以外のファイル（`*.gpkg`、`error_level1.csv`、`error_links.csv` など）は無視されます。

## 2. 共通規則

- 文字コードは UTF-8（BOM 可）。改行は LF・CRLF のどちらでも可。CSV はカンマで分割するだけで、引用符は解釈しません。id や値にカンマを含めないでください。
- 座標はすべて WGS84 の経度・緯度（EPSG:4326）。GeoJSON は `[経度, 緯度]` の順。
- **id は文字列で完全一致**させます。
  - CSV の 1 列目は前後の空白を除いて文字列のまま使います。`1001` と `1001.0` は別の id です。
  - GeoJSON の `properties.id` は JavaScript の `String()` で文字列にします。数値 `1001.0` は `"1001"` になり、前後の空白は除きません。2^53 を超える整数は丸められます。
  - 推奨は、両方とも整数の文字列（`"1001"`）で書くことです。TomTom の Id が float なら `int` にしてから `str` にします。
  - 同じ id を 2 行（2 地物）置かないでください。
- 時刻の列名は `HH:MM`（2 桁ゼロ埋め、窓の**開始**時刻）。`9:00` は不可です（viewer.json の開始時刻や降雨と一致しなくなります）。
- 4 つの CSV と error.csv は、列名・列の順・列の数を同一にします。
- 期間は最長 24 時間です（`HH:MM` が重複しないこと）。窓は等間隔にします。
- 窓の長さの読み方は 2 通りあります。
  - 台数の単位表示（台/30分）と、対象リンクの既定閾値には、隣り合う列の時刻差の**最頻値**を使います。
  - 前後の窓の隣接判定と、見出しの期間には、CSV の **1 列目と 2 列目の時刻差**を使います。この 2 列は必ず 1 窓分の間隔にしてください。
- 列の順は**期間の順**にします（開始窓が先頭。12:00 開始なら `12:00 … 23:30, 00:00 … 11:30`）。
  - ビューアは、期間の開始（6 章）が分かればその列が先頭に来るよう回転して表示します。分からなければ列の順のままです。
  - 回転すると裏取りの隣接が変わるので、notebook が列の順で作った error.csv と端の窓で差が出ます。期間の順に並べておけば差は出ません。

## 3. `YYYYMMDD_network.geojson`

```json
{"type": "FeatureCollection", "features": [
  {"type": "Feature", "properties": {"id": "1001", "pair_id": "1002"},
   "geometry": {"type": "LineString", "coordinates": [[139.70, 35.65], [139.702, 35.65]]}},
  {"type": "Feature", "properties": {"id": "1003", "pair_id": null},
   "geometry": {"type": "LineString", "coordinates": [[139.71, 35.66], [139.712, 35.66]]}}
]}
```

- `geometry`: LineString（MultiLineString も描けます）。
- `properties.id`（必須）: CSV の id と一致させます（2 章）。`properties` が無い地物があると読み込み全体が止まります。
- `properties.pair_id`（任意）: 対向リンク（同じ道路の逆向きの辺）の id。無いときは `null`、空文字、または省略。
  - 照合先は **CSV の id** です。相手が CSV に行を持たないと、ネットワークにあっても対向の裏取りは効きません。
  - 相手側も自分を指すよう対称に付けてください。片側だけだと、裏取りがその片側でしか効きません。
  - 網が有向グラフ（頂点の順 = 進行方向、双方向の道路は逆向きの 2 辺）なら、頂点列が完全に逆順の辺を相手にするのが最も単純です。
- 他の属性は無視します。ただし `properties._row` と地物直下の `id` はビューアが上書きします。
- 対向の 2 本は、表示用に左右へ 1 m ずつずらしておくと重なりません（任意）。
- ファイル名と探し方:
  - 推奨は `YYYYMMDD_network.geojson` を 1 つだけ置き、viewer.json の `files.network` にその名前を書くことです。
  - フォルダ選択時の探し方は、(1) viewer.json の `files.network` の名前、(2) 既定名 `tokyo_20240821_network.geojson`、(3) 名前の末尾が `network.geojson`（大文字小文字不問）のファイルがちょうど 1 つならそれ、の順です。(3) の候補が 2 つ以上あると「tokyo_20240821_network.geojson が選択されていません」で止まります。
  - http 経由では viewer.json の `files.network` の名前だけを読みます。viewer.json が無ければ既定名を読みます。
  - 名前の中で最初に現れる連続 8 桁の数字を `YYYYMMDD` とみなします（日付として正しいかは検査しません）。期間の開始が分からないときは、この日付を時間軸の日付と見出し（`Tokyo YYYY-MM-DD Flood Candidates`）に使います。ただし降雨を読み込んでいて、その日の降雨ファイルが無い場合は、降雨の最も早い日付を使います。
- CSV とネットワークの対応:
  - CSV にあってネットワークに無い id は、上段の対象数・異常数には数えますが、地図には描かれません。
  - ネットワークにあって CSV に無いリンクは灰色（対象外）で描きます。
  - 行はネットワークの全リンクに揃えるのが無難です。

## 4. 4 つの CSV

`baseline_speed.csv` `event_speed.csv` `baseline_count.csv` `event_count.csv`

```
id,12:00,12:30,13:00,...,11:30
1001,38.2,37.9,36.5,...,40.1
1002,,,,...,
```

- 1 列目は id（ヘッダの名前は任意、`id` を推奨）。2 列目以降が窓（`HH:MM`）。
- 4 ファイルとも同じ id を同じ順に並べます。行数・列数・ヘッダ・id の並びが違うと、エラーで読み込みが止まります。空行は無視します。
- 値は数値。欠測は空欄です（pandas の NaN は既定で空欄になります）。数値に読めない文字（`nan` など）も欠測になります。
- 内容:
  - `baseline_speed`: 平時の平均速度 km/h。
  - `baseline_count`: 平時の台数。**1 窓あたり・1 日あたり**の値（4 週分の合計なら 4 で割る）。
  - `event_speed`: 当日の平均速度 km/h。
  - `event_count`: 当日の台数（1 窓あたり）。**当日のデータに無いリンクは 0** を書きます。空欄だと「台数 0」として判定できません。
- 平時の台数か速度が欠測の窓は対象外（判定しない）です。
- 当日の台数が 0 で速度が空欄の窓は、ビューアの「欠測の扱い」スイッチで速度 0 として判定できます（既定は viewer.json の `zero_speed_when_no_traffic`）。notebook 側で先に 0 を書き込んでも読めますが、その出力ではスイッチが効かなくなります。

## 5. `error.csv`（任意）

- ヘッダは 4 つの CSV と完全に同じにします（1 列目の名前は任意）。**違うと、error.csv だけでなく読み込み全体がエラーで止まります。** 揃えられないときは置かないでください。
- 行は、異常（レベル 1 以上）が 1 窓でもあるリンクだけでよく、全リンクでも構いません。行の順は自由で、無い行は 0 とみなします。
- 値は 0〜3 の整数。空欄・数値でない値・負の値は 0、`2.0` は整数部の 2 になります。4 以上はそのまま読まれ、必ず不一致に数えられます。
- `True` / `False`（`true` / `false` も可。`TRUE` は 0 扱い）または 0/1 の旧形式も読めます。旧形式かどうかは「ファイル中の最大値が 1 以下か」だけで決まり、その場合は異常の有無だけを照合します。
- ビューアは**現在の閾値**（初期値は viewer.json の `thresholds`、無ければ内蔵の既定値）で再計算した結果と比べ、閾値パネルに「ノートブック error.csv との不一致: n セル」と出すだけです。表示の色には使いません。
- CSV の id に無い行は（ネットワークにあっても）「ネットワークに無い id n 行」と表示して無視します。

## 6. `viewer.json`（推奨）

```json
{
 "files": {"network": "20260813_network.geojson"},
 "period": {"start": "2026-08-13 12:00", "hours": 24.0, "slot_min": 30},
 "thresholds": {
  "min_base_count": 5.0,
  "min_base_speed": 10.0,
  "require_corroboration": true,
  "zero_speed_when_no_traffic": true,
  "error_levels": [
   {"speed": 0.4, "count": 0.4, "op": "or"},
   {"speed": 0.4, "count": 0.4, "op": "and"},
   {"speed": 0.2, "count": 0.2, "op": "and"}
  ]
 }
}
```

| 項目 | 内容 |
|---|---|
| `files.network` | ネットワークのファイル名。フォルダ直下の名前だけで、`^[\w.-]+\.geojson$` に合うこと |
| `period.start` | 期間の開始 `YYYY-MM-DD HH:MM`（`T` 区切りも可）。この `HH:MM` が CSV の列に無いと期間は使われない |
| `period.hours` | 期間の時間数（0 以下や欠落は 24）。シンプル版では状態表示だけに使う。本体版では時間軸の長さになる |
| `period.slot_min` | 窓の分（0 以下や欠落は 15）。シンプル版では状態表示だけで、窓は CSV の列から決める。本体版では時間軸の刻みになるので、CSV の窓と同じ値にする |
| `thresholds.min_base_count` | 対象リンクとする平時台数の下限（1 窓あたり） |
| `thresholds.min_base_speed` | 対象リンクとする平時速度の下限 km/h |
| `thresholds.require_corroboration` | 裏取りの有無。`false` のときだけオフ |
| `thresholds.zero_speed_when_no_traffic` | 「欠測の扱い」の既定。`true` のときだけオン |
| `thresholds.error_levels` | ちょうど 3 要素 `[L1, L2, L3]`。各要素は `{"speed", "count", "op"}`。speed と count は比の上限（数値）、op は `"and"` か `"or"`（それ以外は or）。L3 ⊂ L2 ⊂ L1 となるよう、後ろほど厳しくする |

- thresholds に数値でない値がある、または `error_levels` が 3 要素でないときは、thresholds 全体を無視して内蔵の既定値を使います（平時 1 時間 10 台を窓の長さで換算、10 km/h、L1〜L3 = 比 0.75 / 0.60 / 0.50 の「または」、裏取りあり、欠測オフ）。
- `period` が無効なときは期間だけを無視します。JSON として壊れていれば全体を無視します。
- フォルダ選択時は、読み込み画面のファイル一覧に「期間なし」「閾値なし」「読めません」と出ます。理由はブラウザのコンソールに出ます。
- 時間軸の開始の決め方は次の順です。日付が決まらないと降雨は表示されません。
  1. viewer.json の `period.start`
  2. `error_L*_YYYYMMDD_HHMM.geojson` の名前の最も早い窓（フォルダ選択時のみ）
  3. CSV の列の順。日付はネットワークのファイル名（3 章）

## 7. `error_geojson/`（任意）

- 名前は `error_L{level}_{YYYYMMDD}_{HHMM}.geojson`。level は 1〜3、`YYYYMMDD_HHMM` は窓の開始の日付と時刻で、日付をまたいだ窓は翌日の日付にします。
- ビューアは中身を読まず、名前の最も早い窓を期間の開始にするだけです（viewer.json が無く、フォルダ選択のときのみ）。その `HHMM` が CSV の列に無いと使われません。

## 8. `rain/`（任意）

- 名前は `rain_YYYYMMDD_HHMM.tif`（`.tiff` も可）。照合は名前だけです。`2400` は翌日の `0000` とみなします。
- 表示するのは「車流の窓の `HH:MM` と同じ `HHMM` で、その窓の日付」のファイルです。
  - XRAIN 変換（`xrain_to_geotiff.py`）の `HHMM` は 15 分平均の**終了**時刻ですが、そのまま窓の開始時刻と突き合わせます。
  - 窓が 30 分でも、降雨は 15 分ごとに置いて構いません。時刻が一致するファイルだけが表示されます。
  - ファイルが無い窓は「この時刻の降雨なし」と表示し、別の日のファイルは出しません。
- GeoTIFF の制約（ビューアは外部ライブラリを使わずに読みます）:
  - クラシック TIFF（BigTIFF は不可）。バイト順はどちらでも可。
  - 無圧縮、1 バンド、ストリップ構成（タイル分割は不可）。
  - 画素型は符号なし整数・符号付き整数（8/16/32 bit）、浮動小数（32/64 bit）。float32 を推奨。
  - 位置は `ModelPixelScaleTag`(33550) と `ModelTiepointTag`(33922) から取ります。北が上、単位は度（WGS84）、画素は面（PixelIsArea）として扱い、GeoKey は読みません。投影座標や回転のあるファイルはずれます。
  - 2 つのタグが無いと、index.json の `bounds` の位置に置きます。それも無ければ表示されません。
  - `GDAL_NODATA`(42113) は任意です。無ければ NaN だけを欠測とします。
- 値は降雨強度 mm/h（15 分平均）。NaN・nodata・負の値・1 mm/h 未満は透明で、1 / 5 / 10 / 20 / 30 / 50 / 80 の境界で色分けします。
- `rain/index.json` は http 経由で開くときに必須です（フォルダ選択では不要。名前だけで登録します）。ファイルは `rain/` の直下に置きます。

```json
{"unit": "mm/h (mean over the slot)",
 "files": [{"file": "rain_20260813_1200.tif"}, {"file": "rain_20260813_1215.tif"}]}
```

  使うのは `files[].file` と `unit` だけです。`unit` が `mm (` で始まると、凡例が「降雨量 mm（15 分）」になります。

## 9. ビューアの判定式（error.csv を合わせるため）

```
step            = CSV の 1 列目と 2 列目の時刻差（分）
is_target(l,t)  = baseline_count >= min_base_count AND baseline_speed >= min_base_speed   （欠測は不成立）
es              = event_speed。ただし「欠測の扱い」がオンで event_count == 0 かつ event_speed が欠測なら 0
speed_ratio     = es / baseline_speed            （baseline_speed <= 0 なら計算不能）
count_ratio     = event_count / baseline_count   （baseline_count <= 0 なら計算不能）
e1(l,t)         = is_target のとき、 speed_ratio <= L_k.speed <op_k> count_ratio <= L_k.count を満たす最大の k
                  （該当なし、または is_target でなければ 0。計算不能な比の条件は不成立）
裏取りあり      : level(l,t) = min( e1(l,t), max( e1(pair(l),t), e1(l,t-1)〔隣接時〕, e1(l,t+1)〔隣接時〕 ) )
裏取りなし      : level(l,t) = e1(l,t)
隣接            = 表示の並びで隣り合い、時刻差がちょうど step 分（23:30 → 00:00 も隣接。期間の両端の外側は隣なし）
```

- 裏取りはレベルの min です。相手（対向または前後の窓）が L1 なら自分も L1、相手が 0 なら 0（異常なし）になります。

## 10. 読み込み方

- フォルダ選択: 入力 1 = 出力フォルダ、入力 2 = 降雨フォルダ（任意。入力 1 の中の `rain/` でも可）。ファイルを個別に選んでも読めます。
- http: HTML を出力フォルダに置き、`python -m http.server` などで開くと自動で読みます。順に `viewer.json`、`files.network`、4 つの CSV と `error.csv`、`rain/index.json` を取り、降雨の tif は表示する時刻の分だけ読みます。

## 11. notebook 側のチェックリスト

- [ ] id は整数の文字列で、GeoJSON と CSV で同じ文字。重複なし
- [ ] 4 つの CSV と error.csv の列（`HH:MM` 2 桁ゼロ埋め・順・数）が同一。4 つの CSV は行（id・順）も同一
- [ ] 列は期間の順・等間隔・24 時間以内。1 列目と 2 列目の間隔が 1 窓分
- [ ] 当日に無いリンクの `event_count` は 0
- [ ] `viewer.json` の `period.start` の `HH:MM` が列にある。`error_levels` は 3 要素
- [ ] network.geojson は WGS84。`pair_id` は対称で CSV にある id を指す。名前の候補（末尾 `network.geojson`）は 1 つだけ
- [ ] 降雨の tif は無圧縮・1 バンド・度座標で 33550 / 33922 タグあり。http で開くなら `rain/index.json`
- [ ] サブフォルダに同じ名前のファイルを置かない

## 12. 確認の範囲

- 内容はビューアのコード（`flood_viewer_simple.html`）を読んで確認したものです。
- 動作は、合成データ（4,681 リンク × 48 窓、および 484 リンク × 48 窓）でのみ確認しています。10 万リンクを超える規模での読み込み時間・描画は未確認です。
