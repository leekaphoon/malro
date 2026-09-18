#!/usr/bin/env bash
# 앱을 Cloudflare Pages 에 올린다. 아이폰·아이패드에서 쓰려면 HTTPS 주소가 필요하다.
#
# 왜 dist/ 를 따로 만드는가
#   저장소에는 서버 코드(server/, worker/), 테스트, 그리고 설정 파일이 섞여 있다.
#   폴더째 올리면 그것들이 전부 공개 웹에 올라간다. 앱 실행에 필요한 파일만 골라 올린다.
#   특히 .env.local 류가 절대 섞이지 않도록, 화이트리스트 방식으로만 복사한다.
set -euo pipefail
cd "$(dirname "$0")"

# 프로젝트 이름은 파일에 적어 둔다.
#   Pages 는 프로젝트 이름으로 배포 대상을 정한다. 다른 맥에서 이름 없이 실행하면
#   기본값으로 "새 프로젝트"가 만들어지고, 주소가 통째로 바뀐다 — OAuth 원본 등록도
#   다시 해야 한다. 이 파일은 앱 폴더 안에 있으므로 iCloud 로 다른 맥에 따라간다.
NAMEFILE=".pages-project"
CREATE=0
for a in "$@"; do [ "$a" = "--create" ] && CREATE=1; done
ARG=""
for a in "$@"; do [ "$a" = "--create" ] || { [ -z "$ARG" ] && ARG="$a"; }; done

if [ -n "$ARG" ]; then PROJECT="$ARG"
elif [ -f "$NAMEFILE" ]; then PROJECT="$(tr -d '[:space:]' < "$NAMEFILE")"
else PROJECT="saydo"; fi

APP_FILES=(index.html core.js app.js dnd.js ai.js sw.js manifest.webmanifest
           icon-180.png icon-192.png icon-512.png icon-maskable.png)

rm -rf dist && mkdir -p dist
for f in "${APP_FILES[@]}"; do
  [ -f "$f" ] || { echo "✗ 파일이 없습니다: $f"; exit 1; }
  cp "$f" dist/
done

# 안전장치 — 비밀값이 섞였는지 올리기 전에 확인한다.
if grep -rlIE 'GEMINI_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]|AIza[A-Za-z0-9_-]{20,}|AQ\.[A-Za-z0-9_-]{20,}' dist 2>/dev/null | grep -q .; then
  echo "✗ dist 안에 키로 보이는 문자열이 있습니다. 배포를 중단합니다."
  exit 1
fi

echo "▸ 올릴 파일 ${#APP_FILES[@]}개"
echo "▸ Pages 프로젝트  ${PROJECT}$([ -f "$NAMEFILE" ] && echo "  (${NAMEFILE} 에서 읽음)")"

# 이 맥에 도구가 있는지 — wrangler 설치와 로그인은 기기마다 따로다 (iCloud 로 따라오지 않는다)
command -v node >/dev/null || { echo "✗ node 가 없습니다:  brew install node"; exit 1; }
command -v wrangler >/dev/null || { echo "✗ wrangler 가 없습니다:  npm i -g wrangler"; exit 1; }
if ! wrangler whoami >/dev/null 2>&1; then
  echo "✗ Cloudflare 에 로그인돼 있지 않습니다 (로그인 정보는 맥마다 따로입니다)."
  echo "    wrangler login"
  exit 1
fi

# 이름이 틀리면 새 사이트가 생긴다. 목록에 없으면 여기서 멈추고 확인하게 한다.
if ! wrangler pages project list 2>/dev/null | grep -qE "(^| )${PROJECT}( |$)"; then
  echo
  echo "⚠ 이 계정에 \"${PROJECT}\" 프로젝트가 안 보입니다."
  echo "  그대로 진행하면 같은 앱이 다른 주소에 새로 만들어지고, OAuth 원본도 다시 등록해야 합니다."
  echo
  echo "  현재 프로젝트 목록:"
  wrangler pages project list 2>/dev/null | sed 's/^/    /'
  echo
  echo "  맞는 이름으로 다시 실행하십시오:   ./deploy-pages.sh <이름>"
  echo "  정말 새로 만드는 것이라면:          ./deploy-pages.sh ${PROJECT} --create"
  if [ "$CREATE" != "1" ]; then exit 1; fi
  echo
  echo "▸ --create 지정됨 — 새 프로젝트로 진행합니다"
fi

OUT="$(wrangler pages deploy dist --project-name="$PROJECT" --commit-dirty=true 2>&1 | tee /dev/stderr)"

# wrangler 가 출력하는 것은 이번 배포 고유의 해시 주소다 (https://<해시>.<프로젝트>.pages.dev).
# 해시는 배포할 때마다 바뀌므로 OAuth 에 등록하면 재배포 때마다 로그인이 깨진다.
# 등록해야 하는 것은 해시를 뗀 고정 주소다.
HASHED="$(printf '%s' "$OUT" | grep -oE 'https://[a-z0-9.-]+\.pages\.dev' | tail -1)"
STABLE="$(printf '%s' "$HASHED" | sed -E 's#https://[0-9a-f]{6,}\.#https://#')"

cat <<EOF

──────────────────────────────────────────────────────────
이번 배포 주소 : ${HASHED:-(감지 실패 — 위 출력 참조)}
                 └ 해시가 붙어 있고 배포할 때마다 바뀝니다. 등록하지 마십시오.

★ 고정 주소   : ${STABLE:-(감지 실패)}
                 └ 아이폰에서 열고, OAuth 에 등록할 주소는 이것입니다.

배포 후 반드시 할 일 — 이걸 빼면 아이폰에서 로그인이 거부됩니다.

1. https://console.cloud.google.com/apis/credentials 에서
   **OAuth 클라이언트가 있는 프로젝트**를 선택합니다.
   클라이언트 ID 앞의 숫자가 곧 프로젝트 번호입니다.
   예: 1234567890-abcd… → ?project=1234567890
   (Gemini 키가 있는 프로젝트와 다를 수 있습니다. 목록이 비어 있으면 프로젝트가 틀린 것입니다.)
2. OAuth 2.0 클라이언트 ID → 웹 애플리케이션 → 열기
3. "승인된 JavaScript 원본" 에 위 ★ 고정 주소를 **경로도 끝 슬래시도 없이** 추가 → 저장
4. 반영에 몇 분 걸립니다. 그 뒤 아이폰 Safari 로 고정 주소를 열면 됩니다.

확인:  curl -sI ${STABLE:-<고정주소>} | head -1     → HTTP/2 200
──────────────────────────────────────────────────────────
EOF

printf '%s\n' "$PROJECT" > "$NAMEFILE"   # 다음 배포와 다른 맥을 위해 이름을 남긴다

# dist/ 를 남기지 않는다. 이 폴더가 iCloud 안이면 배포할 때마다 복사본이
# 클라우드로 올라가 다른 기기까지 내려받게 된다. 매번 다시 만드니 남길 이유가 없다.
rm -rf dist
