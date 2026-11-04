# -*- coding: utf-8 -*-
"""生ピング（Factori 形式）から、タシケント市域内の「高頻度観測区間」だけを抜き出す（DuckDB 版）。
手順: 範囲と精度で絞る → 端末ごとに時刻順に並べる → バースト（MIN_GAP 秒未満の連続点）を間引く
      → （任意）連続する点の間隔が GAP_MIN 分を超えたら区間を切る（既定 0 = 切らない。Stay の判定は途切れも時間幅として使うため）
      → MIN_PTS 点以上の区間（切らない場合は端末）だけ残す
出力: <out>_points.parquet（点。maid, ts, t_local, lat, lon, acc, seg_id, seg_n, seg_start, seg_end）と
      <out>_segments.parquet（区間。seg_id, maid, t_start, t_end, n, dur_s, len_m, 始点終点の緯度経度, date_local）

使い方: python extract_dense.py <zip または フォルダ/ファイル> --out tashkent_dense
  --bbox W,S,E,N   抽出する範囲（既定 68.95,41.00,69.65,41.55 = 市域 + 通勤圏の衛星都市（チルチク、キブライ、ヤンギユル、ザンギアタ、ヌラフション）。
                   市境をまたぐトリップを壊さないため広めに取り、市域内かどうかは make_trips.py が起点・終点ごとに判定する）
  --acc-max 100    使う精度の上限 [m]（精度 0 は不明扱いで除く。--keep-zero-acc で残す）
  --min-gap 5      バースト間引き：直前に残した点から何秒未満なら捨てるか
  --gap-min 0      この分数を超えて途切れたら別の区間（0 = 切らない。切るなら 720 など）
  --min-pts 10     区間（切らない場合は端末全体）に必要な最小点数
  --tz Asia/Tashkent  日付・現地時刻の基準
  --id/--lat/--lon/--acc/--time/--unit  列名。指定が無ければ先頭ファイルのスキーマから Factori（maid, latitude, …）か Irys（deviceId, startTime, location.latitude, …, duration）かを自動判定する
  Irys を手で指定する場合: --id deviceId --time startTime --lat location.latitude --lon location.longitude --acc horizontalAccuracy --dur duration --keep-null-acc
  --dur 列名        滞在の継続秒の列。指定すると区間の切れ目は滞在の終了（開始 + 継続）から次の点までで測る
  --keep-null-acc   精度が欠損の行も残す（Irys は 46% が欠損）
  --mem 4GB --tmp 一時フォルダ
必要: pip install duckdb pyarrow
"""
import argparse, shutil, sys, tempfile, time, zipfile
from pathlib import Path
try:
    import duckdb
except ImportError:
    sys.exit("duckdb が必要です: pip install duckdb")


def unzip_all(path, tmpdir):
    with zipfile.ZipFile(path) as zf:
        names = [i.filename for i in zf.infolist() if not i.is_dir() and i.filename.lower().endswith((".parquet", ".parq"))]
        if not names: sys.exit(f"{path} の中に parquet がありません")
        for k, n in enumerate(names, 1):
            zf.extract(n, tmpdir)
            if k % max(1, len(names) // 10) == 0 or k == len(names): print(f"  展開 {k}/{len(names)}")
    return Path(tmpdir)


VERSION = "2026-11-02e"


def main():
    print(f"{Path(__file__).name} 版 {VERSION}")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path"); ap.add_argument("--out", required=True)
    ap.add_argument("--bbox", default="68.95,41.00,69.65,41.55"); ap.add_argument("--acc-max", type=float, default=100)
    ap.add_argument("--min-gap", type=float, default=5); ap.add_argument("--gap-min", type=float, default=0); ap.add_argument("--min-pts", type=int, default=10)
    ap.add_argument("--tz", default="Asia/Tashkent"); ap.add_argument("--mem", default="4GB"); ap.add_argument("--tmp")
    ap.add_argument("--id"); ap.add_argument("--lat"); ap.add_argument("--lon")
    ap.add_argument("--acc"); ap.add_argument("--time"); ap.add_argument("--unit", default="s", choices=["s", "ms"])
    ap.add_argument("--dur"); ap.add_argument("--keep-null-acc", action="store_true")
    ap.add_argument("--keep-zero-acc", action="store_true", help="精度 0 の行も残す（既定は不明扱いで除く）")
    a = ap.parse_args()
    W, S, E, N = map(float, a.bbox.split(","))
    p = Path(a.path); work = Path(tempfile.mkdtemp(prefix="dense_", dir=a.tmp))
    try:
        if p.is_file() and p.suffix.lower() == ".zip": p = unzip_all(p, work / "data")
        glob = str(p / "**" / "*.parquet").replace("\\", "/") if p.is_dir() else str(p).replace("\\", "/")
        # 列名の自動判定（先頭ファイルのスキーマ）。引数で指定した列はそちらを優先
        import pyarrow.parquet as pq
        first = next(p.rglob("*.parquet")) if p.is_dir() else p
        names = pq.ParquetFile(first).schema_arrow.names
        if "deviceId" in names and "location" in names:
            preset = dict(id="deviceId", time="startTime", lat="location.latitude", lon="location.longitude", acc="horizontalAccuracy", dur="duration"); a.keep_null_acc = True; print("スキーマ: Irys 形式と判定（精度欠損の行は残す）")
        else:
            preset = dict(id="maid", time="timestamp", lat="latitude", lon="longitude", acc="horizontal_accuracy", dur=None); print("スキーマ: Factori 形式と判定")
        for k, v in preset.items():
            if getattr(a, k) is None: setattr(a, k, v)
        print(f"列: id={a.id} time={a.time} lat={a.lat} lon={a.lon} acc={a.acc} dur={a.dur}")
        con = duckdb.connect()
        con.execute(f"SET TimeZone='{a.tz}'"); con.execute(f"SET memory_limit='{a.mem}'"); con.execute(f"SET temp_directory='{str(work / 'duck').replace(chr(92), '/')}'")
        ts = f"CAST({a.time} AS BIGINT)" + (" // 1000" if a.unit == "ms" else "")
        t0 = time.time()
        # 1) 範囲と精度で絞る
        dur = f"coalesce({a.dur}, 0)::BIGINT" if a.dur else "0::BIGINT"
        accok = f"(({a.acc} {'>=' if a.keep_zero_acc else '>'} 0 AND {a.acc} <= {a.acc_max})" + (f" OR {a.acc} IS NULL)" if a.keep_null_acc else ")")
        con.execute(f"""CREATE TABLE p AS SELECT {a.id} AS maid, {ts} AS ts, {dur} AS dur, {a.lat}::DOUBLE AS lat, {a.lon}::DOUBLE AS lon, {a.acc}::DOUBLE AS acc
            FROM read_parquet('{glob}', union_by_name=true)
            WHERE {a.lat} BETWEEN {S} AND {N} AND {a.lon} BETWEEN {W} AND {E} AND {accok}""")
        n1, d1 = con.execute("SELECT count(*), count(DISTINCT maid) FROM p").fetchone()
        n0 = con.execute("SELECT count(*) FROM p WHERE acc = 0").fetchone()[0] if a.keep_zero_acc else 0
        print(f"範囲内かつ精度 ≤{a.acc_max:g} m: {n1:,} 点、{d1:,} 端末" + (f"（うち精度 0 の点 {n0:,} を含む）" if a.keep_zero_acc else "（精度 0 は除外）") + f"（{time.time() - t0:.0f} 秒）")
        # 2) 端末ごとに時刻順。同じ秒の重複は 1 点に。バースト間引き（直前の点との差が MIN_GAP 秒未満なら捨てる。近似：1 つ前の点との差で判定）
        con.execute(f"""CREATE TABLE q AS
            WITH u AS (SELECT maid, ts, max(dur) AS dur, any_value(lat) AS lat, any_value(lon) AS lon, min(acc) AS acc FROM p GROUP BY maid, ts),
                 l AS (SELECT *, ts - lag(ts + dur) OVER (PARTITION BY maid ORDER BY ts) AS dprev FROM u)
            SELECT maid, ts, dur, lat, lon, acc FROM l WHERE dprev IS NULL OR dprev >= {a.min_gap}""")
        n2 = con.execute("SELECT count(*) FROM q").fetchone()[0]
        print(f"バースト間引き後: {n2:,} 点（{time.time() - t0:.0f} 秒）")
        # 3) 区間に切る（間隔 > GAP_MIN 分で切る）と、区間の集計
        con.execute(f"""CREATE TABLE s AS
            WITH l AS (SELECT *, ts - lag(ts + dur) OVER (PARTITION BY maid ORDER BY ts) AS dprev FROM q),   -- 滞在があればその終了から次の点まで
                 b AS (SELECT *, CASE WHEN dprev IS NULL OR ({a.gap_min} > 0 AND dprev > {a.gap_min * 60}) THEN 1 ELSE 0 END AS brk FROM l),   -- gap-min 0 なら切らない
                 g AS (SELECT *, sum(brk) OVER (PARTITION BY maid ORDER BY ts ROWS UNBOUNDED PRECEDING) AS seg_no FROM b)
            SELECT maid, ts, dur, lat, lon, acc, seg_no,
                   lag(lat) OVER w AS plat, lag(lon) OVER w AS plon FROM g WINDOW w AS (PARTITION BY maid, seg_no ORDER BY ts)""")
        con.execute("""CREATE TABLE seg AS
            SELECT maid, seg_no, count(*) AS n, min(ts) AS t_start, max(ts + dur) AS t_end, max(ts + dur) - min(ts) AS dur_s,
                   sum(CASE WHEN plat IS NULL THEN 0 ELSE 2 * 6371000 * asin(sqrt(pow(sin(radians(lat - plat) / 2), 2) + cos(radians(plat)) * cos(radians(lat)) * pow(sin(radians(lon - plon) / 2), 2))) END) AS len_m,
                   arg_min(lat, ts) AS lat_start, arg_min(lon, ts) AS lon_start, arg_max(lat, ts) AS lat_end, arg_max(lon, ts) AS lon_end
            FROM s GROUP BY maid, seg_no""")
        con.execute(f"CREATE TABLE segk AS SELECT row_number() OVER (ORDER BY maid, t_start) AS seg_id, * FROM seg WHERE n >= {a.min_pts}")
        ns, nd, npt = con.execute("SELECT count(*), count(DISTINCT maid), sum(n) FROM segk").fetchone()
        print(f"区間（{'途切れで切らない' if a.gap_min <= 0 else f'間隔 ≤{a.gap_min:g} 分'}、{a.min_pts} 点以上）: {ns:,} 区間、{nd:,} 端末、{npt:,} 点（{time.time() - t0:.0f} 秒）")
        if not ns: sys.exit("条件を満たす区間がありません")
        # 4) 書き出し（端末・時刻順）
        out = Path(a.out)
        con.execute(f"""COPY (SELECT s.maid, s.ts, CAST(to_timestamp(s.ts) AS TIMESTAMP) AS t_local, s.dur AS dur_s, s.lat, s.lon, s.acc, k.seg_id, k.n AS seg_n,
                              s.ts = k.t_start AS seg_start, s.ts + s.dur = k.t_end AS seg_end
                        FROM s JOIN segk k ON s.maid = k.maid AND s.seg_no = k.seg_no ORDER BY s.maid, s.ts)
                        TO '{str(out) + "_points.parquet"}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
        con.execute(f"""COPY (SELECT seg_id, maid, t_start, t_end, CAST(to_timestamp(t_start) AS TIMESTAMP) AS t_start_local, CAST(to_timestamp(t_start) AS DATE) AS date_local,
                              n, dur_s, round(len_m) AS len_m, lat_start, lon_start, lat_end, lon_end FROM segk ORDER BY maid, t_start)
                        TO '{str(out) + "_segments.parquet"}' (FORMAT PARQUET, COMPRESSION ZSTD)""")
        print(f"書き出し: {out}_points.parquet, {out}_segments.parquet（{time.time() - t0:.0f} 秒）")
        # 5) 要約
        print("\n=== 区間の要約 ===")
        q = con.execute("SELECT quantile_cont(n, [0.5, 0.9]), quantile_cont(dur_s / 60, [0.5, 0.9]), quantile_cont(len_m / 1000, [0.5, 0.9]) FROM segk").fetchone()
        print(f"区間あたり 点数 50/90% {[round(x) for x in q[0]]} | 継続 [分] 50/90% {[round(x, 1) for x in q[1]]} | 移動距離 [km] 50/90% {[round(x, 2) for x in q[2]]}")
        print("日別の区間数（現地日付）:", {str(d): c for d, c in con.execute("SELECT CAST(to_timestamp(t_start) AS DATE) AS d, count(*) FROM segk GROUP BY 1 ORDER BY 1").fetchall()})
        print("日別の端末数:", {str(d): c for d, c in con.execute("SELECT CAST(to_timestamp(t_start) AS DATE) AS d, count(DISTINCT maid) FROM segk GROUP BY 1 ORDER BY 1").fetchall()})
        print("移動距離 1 km 以上の区間:", con.execute("SELECT count(*) FROM segk WHERE len_m >= 1000").fetchone()[0], "| 端末あたり区間数 50/90%:", [round(x, 1) for x in con.execute("SELECT quantile_cont(c, [0.5, 0.9]) FROM (SELECT count(*) AS c FROM segk GROUP BY maid)").fetchone()[0]])
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
