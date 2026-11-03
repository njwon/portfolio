"""TV 영상 목록 생성기.

img/tv/ 폴더의 영상 파일 이름을 img/tv/videos.json 에 적는다. 사이트는 이 목록에서 무작위로 골라 TV 에 띄움.
GitHub Pages 는 폴더 목록을 못 읽어서 목록 파일이 필요하다.

- 푸시하면 GitHub Actions(.github/workflows/tv-videos.yml)가 자동으로 실행해 커밋하므로 영상만 넣으면 됨
- 로컬에서 바로 확인하려면: python scripts/build-tv-list.py
"""
import json
from pathlib import Path

TV_DIR = Path(__file__).resolve().parent.parent / "img" / "tv"
EXTS = {".webm", ".mp4"}

videos = sorted(p.name for p in TV_DIR.iterdir() if p.is_file() and p.suffix.lower() in EXTS)
out = TV_DIR / "videos.json"
text = json.dumps(videos, ensure_ascii=False, indent=2) + "\n"
if not out.exists() or out.read_text(encoding="utf-8") != text:
    out.write_text(text, encoding="utf-8", newline="\n")
    print(f"videos.json 갱신: {len(videos)}개")
else:
    print(f"변경 없음: {len(videos)}개")
