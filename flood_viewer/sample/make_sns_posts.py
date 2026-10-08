"""Synthetic SNS posts in the second CSV layout the viewer reads (record_id, post_id, platform, ..., post_datetime_jst,
municipality, location_text, longitude, latitude, message, source_category, post_url ...): sample/output/sns/chiba_sample_posts.csv.
14 rows: 12 with coordinates (3 stacked at 139.76, 35.685 between 23:50 and 00:20), 2 without; times on the sample's event night."""
import csv
from pathlib import Path

OUT = Path(__file__).parent / "output" / "sns"; OUT.mkdir(parents=True, exist_ok=True)
HEADER = ["record_id", "post_id", "platform", "author_handle", "message", "message_kind", "message_summary", "post_datetime_jst", "post_date_jst", "datetime_basis",
          "source_report_time_jst", "incident_start_date", "observation_date", "observation_date_basis", "date_group", "post_url", "media_status", "media_type", "media_count",
          "media_page_url", "photo_url", "video_url", "all_media_page_urls", "municipality", "location_text", "longitude", "latitude", "coord_crs", "location_level",
          "coordinate_confidence", "coordinate_method", "source_longitude", "source_latitude", "coordinate_source_url", "post_verification", "post_metadata_url",
          "flood_evidence", "report_type", "inclusion_status", "review_flags", "notes", "source_category", "source_url", "retrieved_date_jst"]
rows = []
def post(k, t, cat, lon, lat, text, city="新宿区", loc="冠水 新宿区付近", media="video", flags=""):
    pid = f"20877{k:014d}"
    r = dict.fromkeys(HEADER, "")
    r.update({"record_id": f"SAMPLE_{pid}", "post_id": pid, "platform": "X" if k % 4 else "YouTube", "author_handle": f"user{k}", "message": text, "message_kind": "原文短文",
              "message_summary": f"{city}における浸水・冠水関連の報告", "post_datetime_jst": t, "post_date_jst": t[:10], "datetime_basis": "X created_at確認",
              "incident_start_date": "2024-08-21", "observation_date_basis": "撮影・目撃日未確認", "date_group": "0821", "post_url": f"https://x.com/user{k}/status/{pid}",
              "media_status": "あり" if media != "none" else "なし", "media_type": media, "media_count": "1" if media != "none" else "0",
              "media_page_url": f"https://x.com/user{k}/status/{pid}/video/1" if media != "none" else "", "photo_url": f"https://pbs.twimg.com/media/sample{k}.jpg" if media == "photo" else "",
              "video_url": f"https://video.twimg.com/amplify_video/{pid}/vid/avc1/720x1280/sample.mp4" if media == "video" else "",
              "municipality": city, "location_text": loc, "longitude": "" if lon is None else f"{lon:.5f}", "latitude": "" if lat is None else f"{lat:.5f}",
              "coord_crs": "EPSG:4326", "location_level": "landmark_vicinity" if lon is not None else "unlocated", "coordinate_confidence": "独立位置照合未実施" if lon is not None else "座標保留",
              "coordinate_method": "公開地図の出典座標を採用" if lon is not None else "位置未確定・出典座標不採用", "post_verification": "本文・日時・メディアmetadata確認",
              "flood_evidence": "本文に浸水等の明示あり", "report_type": "公開投稿(現地目撃かは未検証)", "inclusion_status": "採用", "review_flags": flags,
              "source_category": cat, "source_url": "https://example.invalid/report", "retrieved_date_jst": "2026-10-08"})
    rows.append(r)
k = 0
for t, cat, lon, lat, text in [("2024-08-21T18:40:00+09:00", "河川", 139.705, 35.655, "川の水位が上がってきた"),
                                ("2024-08-21T20:05:00+09:00", "浸水・冠水", 139.72, 35.66, "アンダーパスが冠水、通行止め"),
                                ("2024-08-21T21:30:00+09:00", "追加報道SNS", 139.78, 35.70, "【速報】都内で記録的短時間大雨"),
                                ("2024-08-21T22:10:00+09:00", "河川", 139.79, 35.69, "神田川が危険水位です"),
                                ("2024-08-21T23:50:00+09:00", "浸水・冠水", 139.76, 35.685, '道路が川のよう、"膝まで水" です'),
                                ("2024-08-22T00:05:00+09:00", "浸水・冠水", 139.76, 35.685, "さっきより水位が上がった, 車が動けない"),
                                ("2024-08-22T00:20:00+09:00", "追加の現地浸水投稿", 139.76, 35.685, "消防が来ている"),
                                ("2024-08-22T00:15:00+09:00", "浸水・冠水", 139.74, 35.675, "地下駐車場に水が流れ込んでいる"),
                                ("2024-08-22T00:28:00+09:00", "河川", 139.73, 35.69, "川沿いの道が冠水"),
                                ("2024-08-22T01:10:00+09:00", "追加の現地浸水投稿", 139.75, 35.665, "水が引き始めた"),
                                ("2024-08-22T02:40:00+09:00", "浸水・冠水", 139.77, 35.66, "まだ冠水している交差点あり"),
                                ("2024-08-22T04:00:00+09:00", "追加報道SNS", 139.71, 35.68, "各地で浸水被害、朝の交通に影響")]:
    post(k, t, cat, lon, lat, text, media="photo" if k % 3 == 0 else "video"); k += 1
post(k, "2024-08-21T23:00:00+09:00", "浸水・冠水", None, None, "家の前が冠水（場所は非公開）", media="none", flags="broad_location"); k += 1
post(k, "2024-08-22T00:30:00+09:00", "河川", None, None, "川が溢れそう", media="none"); k += 1
with open(OUT / "chiba_sample_posts.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=HEADER); w.writeheader(); w.writerows(rows)
print(f"wrote {len(rows)} posts to {OUT / 'chiba_sample_posts.csv'}")
