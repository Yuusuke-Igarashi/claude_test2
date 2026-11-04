# ソースコードレビュー結果（2026-11-04）

対象: `1_extract_dense.py`（版 2026-11-02e）、`2_make_trips.py`（版 2026-11-04m）、`3_build_tashkent_graphs.py`（版 2026-11-02b）、`4_map_match.py`（版 2026-11-04b）

方法: 4 本を読み合わせたうえで、合成データ（`tests/gen_synth.py`）を使って修正前・修正後を通しで実行し、挙動を比べました。
実データ（Factori / Irys のピング、タシケントの道路網 GeoPackage）は手元に無いため、実データでの再現は未確認です。

## 結論

| # | ファイル | 重さ | 内容 | 対応 |
|---|---|---|---|---|
| 1 | 4_map_match.py | 致命的（結果が黙って壊れる） | ノード番号の int32 桁あふれで、別の弧を引く。ノード数が 46,341 を超える網で起きる | 修正 |
| 2 | 2_make_trips.py | 誤った出力 | モードチェンジの境目を取り消した後も `n_parts` が取り消し前の値のまま | 修正 |
| 3 | 4_map_match.py | 系統的な品質低下 | 起点・終点（Stay の重心）への区間にも速度上限を掛けるため、徒歩トリップの終端で経路が切れる | 修正 |
| 4 | 1_extract_dense.py | 軽微 | 区間が 0 件のとき TypeError で落ち、本来の終了メッセージが出ない | 修正 |
| 5 | 1_extract_dense.py | 軽微 | parquet の無いフォルダを渡すと StopIteration で落ちる | 修正 |
| – | 3_build_tashkent_graphs.py | – | 致命的な箇所は見つかりませんでした | 変更なし |

修正後の版: extract_dense 2026-11-02f、make_trips 2026-11-04n、map_match 2026-11-04c。

## 1. map_match.py: `edges_of` の int32 桁あふれ（致命的）

**現象** `scipy.sparse.csgraph.dijkstra` が返す predecessors は int32 です（scipy 1.18.1 で確認）。`path_nodes` が返すノード列は末尾以外が int32 のままで、`edges_of` の `np.asarray(nodes_seq[:-1]) * g["N"]` は int32 のまま計算されます。ノード番号 × ノード数が 2^31（約 21.5 億）を超えると桁あふれし、`searchsorted` が別のノード対の弧を返します。例外は出ません。

**影響** ノード数 N が 46,341 を超える網では、番号の大きいノードを通る経路から順に、`matched_len_m`、`_mm_paths.parquet` の弧列、弧ごとの進入・退出時刻が誤ったものになります。`status` は ok のままです。タシケント市域の歩行者網・道路網はこの規模を超える可能性が高いと考えますが、実データのノード数は未確認です。

**修正** ノード列を int64 に揃えて鍵を作り、さらに `pair_key[pos] == k` を確かめて、一致しなければ例外にしました（黙って誤った弧を返さない）。

**確認** 220×220 の格子（ノード 48,400）に端末を番号の大きい側に置き、間引きを 180 秒・1,500 m にして連続点の間に中間の弧が入るようにした場合:

- 修正前: 34 本の経路のうち 15 本で、隣の弧とつながらない継ぎ目が合計 88 箇所。`status` は 33 本が ok で、異常が表に出ない
- 修正後: 継ぎ目の不整合 0 箇所、34 本すべて ok

既定の間引き（60 秒・100 m）では、合成データの弧が約 1 km と長く、連続点の間に中間の弧がほとんど入らないため、修正前でも異常が出ませんでした。実データの弧は交差点ごとに切れて短いので、既定でも起きると考えます。

## 2. make_trips.py: `n_parts` が取り消し前の値のまま（誤った出力）

**現象** `chain.update({..., "n_parts": len(cuts) + 1, ...})` は、境目を取り消す while ループより前に、取り消し前の `cuts` で計算されています。取り消しで境目がすべて消えると `if cuts:` に入らず、`n_parts` が 2 以上のまま残ります。このとき `modes` は 1 つの mode で、`_trip_parts.parquet` にも載りません。

**影響** `n_parts > 1` でモードチェンジのあるトリップを数える処理（要約の「モードチェンジのあるトリップ」や下流の抽出）が過大になります。

**修正** 初期値を 1 にしました。境目が残る場合は従来どおり `if cuts:` の中で `len(parts)` に付け直されます。

**確認** 部分の mode を強制的に同じにして境目が必ず取り消されるようにしたところ、修正前は 3 本が `n_parts = 2`（`modes` は "vehicle"、parts ファイルなし）、修正後は `n_parts = 1` になりました。

## 3. map_match.py: 起点・終点への区間の速度上限（系統的な品質低下）

**現象** make_trips が出すトリップの起点・終点は Stay の重心で、時刻は Stay の端（終了・開始）です。Stay 判定の直径（既定 300 m）の分だけ、到着直前の Move 点は Stay に吸収されるため、「最後の Move 点 → 終点」は 1 サンプリング間隔で 200〜300 m 進んだ形になります。map_match はこの区間にも `P ÷ 経過時間 ≤ V_MAX` を掛けていたため、徒歩（V_MAX 20 km/h）では 30 秒で 278 m（約 33 km/h）のように判定され、終端で経路が切れて `partial` になっていました。make_trips 側は同じ理由で「速度は Move 点だけで測る」としており、map_match 側だけ考慮が漏れていた形です。

**修正** 直前の点が起点、または今の点が終点のときは、迂回の上限（DETOUR × D + BUFFER）だけを掛け、速度の上限は掛けないようにしました。

**確認** 合成データ（徒歩 15 本・車 19 本、ノード 900 の格子）で、徒歩の ok は 7/15 → 15/15、「速度超過」で切れた点は 8 → 0 になりました。車は 14/19 → 15/19 です（増えた 1 本は合成データの跳びを含むトリップで、参考値）。残る車 4 本の `partial` は、合成軌跡が一方通行に逆行している箇所の迂回超過で、期待どおりの挙動です。

## 4・5. extract_dense.py（軽微）

- 区間が 0 件のとき `sum(n)` が NULL になり、件数の表示で TypeError になって「条件を満たす区間がありません」が出ませんでした。`coalesce(sum(n), 0)` にしました。
- parquet の無いフォルダでは `next()` が StopIteration で落ちていました。メッセージを出して終了するようにしました。

## 修正していない気づき（判断をお任せしたい点）

優先度の高い順ではなく、ファイル順です。いずれも挙動を変える判断を含むため、今回は手を入れていません。

- extract_dense: Irys の滞在（`dur`）が次の行の開始と重なると `dprev` が負になり、バースト間引きで落ちます。意図どおりかの確認をお勧めします。
- make_trips: 150 km/h 超の除外は「直前の点」との 1 回限りの比較なので、跳んだ先に点が続く場合は最初の 1 点しか落ちません（ワープ判定が主役で、既知の近似と理解しています）。
- make_trips: `trip_points` の `part` で、境目の点は前の部分にだけ属します。map_match は後の部分をその次の点から当て始めるので、部分の起点が 1 点ぶんずれます。
- make_trips: gpkg 出力の `include_groups=False` は pandas 2.2 以降が必要です。それより前では TypeError になり、`except ImportError` では拾えません。
- map_match: 経路長 P の計算で平面長（`glen`）と測地線長（`L`）を混ぜています。市域スケールでは差は小さいと考えます。
- map_match: 全点の行（`rows_pt`）をメモリに持つため、点が数千万になると重くなります。塊ごとに書き出す形が安全です。
- build_tashkent_graphs: `as_linestring` の向き合わせは、座標が既に分かっているノードに対してだけ働くので、処理順によって結果が変わり得ます。from/to と幾何の向きが揃っている入力なら影響はありません。

## 検証環境と手順

環境: Python 3.13.18、duckdb 2.0.0、pyarrow 26.0.1、pandas 3.0.5、numpy 2.5.3、scipy 1.18.1、shapely 2.2.0、geopandas 1.2.0、networkx 3.7、pyproj 3.8.0、pyogrio 0.13.0

通しの確認:

```bash
bash tests/run_synth_check.sh /path/to/work
```

int32 桁あふれの再現（修正前のスクリプトに対して）:

```bash
python tests/gen_synth.py --out /path/to/big --grid 220 --ioff 190
python 1_extract_dense.py /path/to/big/raw --out /path/to/big/dense --bbox 68.95,41.00,72.5,41.55
python 2_make_trips.py /path/to/big/dense_points.parquet --out /path/to/big/trips --source Factori
python 3_build_tashkent_graphs.py --input /path/to/big/Tashkent_Road_Network.gpkg --output-dir /path/to/big/graphs --formats csv
python 4_map_match.py --trips /path/to/big/trips_trips.parquet --points /path/to/big/trips_trip_points.parquet --graphs /path/to/big/graphs --out /path/to/big/mm --no-gpkg --thin-s 180 --thin-m 1500
```

`_mm_paths.parquet` の弧列を `graphs/*_edges.csv` の u, v と突き合わせ、隣り合う弧の v と u が一致するかを数えると、修正前は不一致が出ます。
