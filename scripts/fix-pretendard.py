"""Pretendard 다이나믹 서브셋을 자체 호스팅용으로 내려받아 정리한다.

원본 woff2 의 name 테이블에 (platformID, encodingID, langID, nameID) 가 같은 중복 레코드가 있어
Firefox(OTS) 가 "downloadable font: name: name records are not sorted" 경고를 낸다.
중복을 제거하고 정렬해 다시 저장하면 경고가 사라진다.

    python3 -m venv .venv && .venv/bin/pip install fonttools brotli
    .venv/bin/python fix-pretendard.py          # fonts/pretendard/*.woff2, css/pretendard.css 갱신
"""
import os, re, urllib.request, concurrent.futures
from pathlib import Path
from fontTools.ttLib import TTFont

VER     = '1.3.9'
WEIGHTS = {400, 600, 700, 900}          # 사이트에서 실제 쓰는 굵기만
ROOT    = Path(__file__).resolve().parent.parent
OUT     = ROOT / 'fonts' / 'pretendard'
CSS_OUT = ROOT / 'css' / 'pretendard.css'
CDN     = f'https://fastly.jsdelivr.net/gh/orioncactus/pretendard@{VER}'
CHUNKS  = CDN + '/packages/pretendard/dist/web/static/woff2-dynamic-subset/'

css = urllib.request.urlopen(CDN + '/dist/web/static/pretendard-dynamic-subset.css').read().decode()
faces = []
for block in re.findall(r'@font-face \{(.*?)\}', css, re.S):
    w = int(re.search(r'font-weight: *(\d+)', block).group(1))
    if w not in WEIGHTS: continue
    f  = re.search(r'woff2-dynamic-subset/([^)]+\.woff2)\)', block).group(1)
    ur = re.search(r'unicode-range: *([^;]+);', block).group(1).strip()
    faces.append((w, f, ur))

OUT.mkdir(parents=True, exist_ok=True)
def fetch_fix(item):
    _, f, _ = item
    raw = urllib.request.urlopen(CHUNKS + f).read()
    tmp = OUT / (f + '.tmp'); tmp.write_bytes(raw)
    font = TTFont(tmp); font.flavor = 'woff2'
    seen, keep = set(), []
    for r in font['name'].names:
        k = (r.platformID, r.platEncID, r.langID, r.nameID)
        if k in seen: continue
        seen.add(k); keep.append(r)
    keep.sort(key=lambda r: (r.platformID, r.platEncID, r.langID, r.nameID))
    font['name'].names = keep
    font.save(OUT / f); tmp.unlink()
with concurrent.futures.ThreadPoolExecutor(8) as ex: list(ex.map(fetch_fix, faces))

lic = css[:css.index('/* [0] */')].rstrip()
lines = [lic, '',
  f'/* Pretendard {VER} 다이나믹 서브셋(사용 굵기 {sorted(WEIGHTS)}만)을 자체 호스팅.',
  '   원본 woff2 의 name 테이블에 중복 레코드가 있어 Firefox 가 "name records are not sorted" 경고를 내므로',
  '   fontTools 로 중복 제거·정렬해 재저장한 파일 (scripts/fix-pretendard.py 로 재생성) */']
for w, f, ur in faces:
    lines.append(f"@font-face{{font-family:'Pretendard';font-style:normal;font-display:swap;font-weight:{w};src:url(../fonts/pretendard/{f}) format('woff2');unicode-range:{ur}}}")
CSS_OUT.write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(f'{len(faces)} faces → {OUT}, {CSS_OUT}')
