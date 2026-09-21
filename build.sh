#!/usr/bin/env bash
# 앱 실행에 필요한 파일만 dist/ 로 골라낸다 — 화이트리스트.
#
# 왜 저장소 루트를 그대로 서빙하지 않는가
#   루트에는 테스트 7종, README, 스크린샷 22장이 섞여 있다. 비밀은 없지만(전부 GitHub 에
#   공개돼 있다) 앱 주소에서 그것들이 서빙될 이유가 없다. 그리고 목록에 적힌 것만 나가는
#   화이트리스트라야, 나중에 누가 파일을 추가해도 조용히 공개되지 않는다.
#
# Cloudflare 가 배포할 때 wrangler.jsonc 의 build.command 로 이 스크립트를 부른다.
set -euo pipefail
cd "$(dirname "$0")"

FILES=(index.html core.js app.js dnd.js ai.js sw.js manifest.webmanifest
       icon-180.png icon-192.png icon-512.png icon-maskable.png)

rm -rf dist && mkdir -p dist
for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "✗ 파일이 없습니다: $f"; exit 1; }
  cp "$f" dist/
done

# 키로 보이는 문자열이 섞였으면 배포를 멈춘다
if grep -rlIE 'AIza[A-Za-z0-9_-]{20,}|AQ\.[A-Za-z0-9_-]{20,}' dist | grep -q .; then
  echo "✗ dist 안에 키로 보이는 문자열이 있습니다. 배포를 중단합니다."; exit 1
fi
echo "▸ dist/ 에 ${#FILES[@]}개"
