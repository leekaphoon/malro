# Saydo — 말로 쓰는 할 일

한국어로 말하면 알아듣는 태스크 앱. 데이터는 **사용자 본인의 Google Tasks** 에만 저장되고,
브라우저가 Google API 를 직접 호출한다. **중앙 서버가 없다.**

```
"시리야, 할 일 추가"
  → "추가할 할 일을 말씀하세요"
  → "내일 오후 3시 배포 파이프라인 점검 급한 걸로 매주 월"
  → "내일 15시에 우선순위 1로 배포 파이프라인 점검, 프로젝트에 추가했습니다."
```

> **이 저장소는 개인용 Tasq 에서 갈라져 나온 공개판이다.** Tasq 는 혼자 쓰는 도구였고,
> Saydo 는 남이 쓰는 것을 전제로 한다. 그 차이가 설계 전반에 반영되어 있다 — 아래 참고.

---

## In English

**Saydo is a Korean-language task app with no backend.** It stores everything in the
user's own Google Tasks; the browser calls the Google API directly. There is no server
of mine holding your data, because there is no server.

Google Tasks gives you five fields — title, notes, due date, status, parent. Saydo adds
priority, labels, time-of-day, recurrence and duration by encoding them into the last
line of `notes` as `⟦p1 @field ⏰14:00 ↻w1:1 ⏳90⟧`. The app hides that line; other
Google clients show it. That trade-off, and what it costs, is the most interesting part
of the design.

An optional AI assistant (bring your own Gemini key) and a Siri pipeline let you add and
query tasks by voice without opening the app. The Siri path runs through Google Apps
Script — the only host that cleared all six obstacles documented in `voice/SHORTCUT.md`.

- **Try it**: open any deployment with `?demo=1` — zero network requests, nothing stored.
- **Design notes**: this README (Korean). The failure log at the end is the honest part.
- **Security**: read `SECURITY.md` before sharing a proxy secret with anyone. Don't.
- **License**: MIT.

Built and tested against real daily use, not as a portfolio exercise. Tests: 460+
assertions across 7 suites, each deliberately sabotaged before being committed — because
three separate test sets turned out to pass while verifying nothing.

---

## Tasq 와 무엇이 다른가

| | Tasq (개인용) | **Saydo (공개판)** |
|---|---|---|
| OAuth 클라이언트 | 코드에 박아 둔 기본값 하나 | **검증받은 클라이언트 하나**, 사용자는 Google 로그인만 |
| AI 어시스턴트 | 내 Gemini 키 (Apps Script) | **각자 자기 키** (BYO) — 아래 이유 |
| 동기화 | 5분마다 + 탭 복귀마다 전량 | **30분 + 복귀 디바운스 + 목록·완료분 TTL** |
| 완료 항목 | 전부, 1000건에서 조용히 잘림 | **90일까지, 잘리면 배너로 알림** |
| 수용 인원 | 약 125명 | **약 909명** (+ 쿼터 증량 시 그 이상) |
| 계정 소유 | 회사 Workspace 에 일부 자산 | **전부 개인 계정** |

### 왜 AI 만 BYO 인가 — 비용보다 데이터 때문이다

AI 를 내가 중계하면 **남의 할 일 내용이 내 Gemini 프로젝트를 통과한다.** 그 순간 나는
개인정보 처리자가 된다. 각자 자기 키를 쓰면 나는 그들의 데이터를 **구조적으로 볼 수 없다.**

비용도 물론 있다 — 사용자 1,000명이면 월 27만원, 1만 명이면 270만원 규모로 선형 증가한다.
하지만 그것이 없어도 데이터 경계 하나만으로 BYO 가 맞다.

그래서 UX 는 이렇다: **Google 로그인만 하면 태스크 앱으로 완전히 동작하고, AI 는 설정에서
켜는 선택 기능.**

---

## 동기화 예산 — 이 앱의 수용 인원을 결정하는 숫자

Google Tasks API 는 **프로젝트당 하루 5만 쿼리**다. 사용자별이 아니라 **앱 전체 합계**이므로,
동기화 빈도가 곧 "몇 명까지 쓸 수 있는가" 가 된다.

**쿼터는 호출 건수를 센다.** `updatedMin` 델타 조회는 전송량만 줄일 뿐 건수는 같아서
쿼터에는 도움이 되지 않는다. 줄일 수 있는 것은 **빈도**와 **호출당 건수** 둘뿐이다.

| | 하루 8시간 사용 (목록 3개) | 5만 쿼터 수용 |
|---|---|---|
| Tasq 방식 (5분 + 복귀마다 전량) | 약 400콜 | 약 125명 |
| **Saydo 방식** | **55콜** | **약 909명** |

적용한 것:

```js
const SYNC_EVERY   = 30 * 60 * 1000;      // 주기 동기화
const SYNC_MIN_GAP = 10 * 60 * 1000;      // 탭 복귀로 앞당길 수 있는 최소 간격
const LISTS_TTL    =  6 * 60 * 60 * 1000; // 목록은 거의 안 바뀐다
const DONE_TTL     =  6 * 60 * 60 * 1000; // 완료분도 거의 안 바뀐다
```

- 사용자가 직접 요청한 것(`R` 키·새로고침 버튼·AI 가 데이터를 바꾼 직후)은 `fullSync(true)`
  로 간격을 무시한다
- **스로틀이 인증 문제 발견을 늦추지 않는다** — 뮤테이션 경로(`flush`)는 스로틀 밖이라
  사용자가 무엇이든 조작하면 401 이 즉시 드러난다. 테스트로 고정해 두었다

`uitest.js` 의 **`[동기화 예산]`** 절은 기능이 아니라 **호출 건수를 센다.** 누군가 편의를
위해 동기화를 자주 돌리면 수용 인원이 조용히 1/6 로 줄어드는데 화면으로는 전혀 드러나지
않기 때문이다. 실제로 스로틀과 TTL 을 무력화해 보면 909명 → 77명으로 떨어지며 단언이 깨진다.

완료 항목 분리(아래)로 목록당 호출이 평균 1.08회가 되어 수용 인원이 960명에서 909명으로
**5% 줄었다.** 그 대가로 평상시 전송량과 화면 반응이 크게 나아지고, 1000건 상한에
조용히 걸리던 문제가 사라진다. 바꿀 만한 거래라고 판단했다.

---

## 완료 항목은 90일까지만 — 그리고 상한을 조용히 넘기지 않는다

Tasq 는 목록마다 `showCompleted=true` 로 **완료분까지 전부** 받아 왔다. 몇 년 쓰면 미완료
20건을 보려고 완료 3000건을 매번 내려받고, 파싱하고, `localStorage` 에 넣는다. 그리고
1000건에서 루프가 끊기는데 **아무도 그 사실을 몰랐다.**

호출을 둘로 나눴다.

| | 조회 | 주기 |
|---|---|---|
| 미완료 | `showCompleted=false` | 매 동기화 |
| 완료 | `completedMin=<90일 전>` | `DONE_TTL`(6시간) 간격 |

**왜 한 호출로 합치지 않는가.** `completedMin` 을 `showCompleted=true` 와 함께 주면 완료일이
없는 태스크 — 즉 **미완료 전부** — 가 비교에서 탈락해 같이 걸러진다. 한 호출로 합치면
"할 일이 하나도 없다" 는 화면이 나온다. 둘로 나누면 이 의미론이 어느 쪽이든 결과가 같다.
미완료 호출은 완료 필터를 아예 쓰지 않기 때문이다. `uitest.js` 의 스텁은 **이 못된 성질을
그대로 흉내낸다** — 스텁이 봐주면 파라미터를 잘못 붙였을 때 실제 증상이 나타나지 않는다.

알려진 절충: 다른 클라이언트(구글 태스크 앱·시리)에서 완료한 항목은 미완료 목록에서 즉시
사라지지만 '완료됨' 뷰에는 최대 6시간 뒤에 나타난다. `R`(강제 동기화)로 바로 당긴다.

### 상한 도달은 화면에 남는 배너로 알린다

```js
if (pageToken && out.length >= PAGE_CAP) { truncated = true; break; }   // 예전: 조용히 break
```

토스트가 아니라 **배너**다. 토스트는 지나가지만 이건 지속되는 상태라서, 사라지고 나면
사용자는 자기가 보는 화면이 완전한 줄 안다. 어느 목록이 잘렸는지 **이름으로** 말해 준다 —
"일부 항목" 같은 말로는 어디를 정리해야 할지 알 수 없다.

같은 이유로 **목록 단위 실패도 더는 삼키지 않는다.** 예전에는 `apiTasks(id).catch(() => 캐시)`
로 넘기고 동기화 표시를 초록으로 찍었다. 목록 하나가 몇 시간째 낡아 있어도 화면은 정상이라고
말했다. 이제는 실패한 목록 이름을 남기고, 표시를 빨강으로 두고, `lastSync` 를 찍지 않는다 —
찍으면 `SYNC_MIN_GAP` 동안 재시도조차 막힌다.

---

## 편집은 잃지 않는다 — 실패를 종류로 나눈다

개인용 Tasq 에는 **조용한 데이터 손실**이 있었다. `flush()` 가 실패한 연산을 종류 구분 없이
큐에서 버렸다. 낙관적 업데이트 때문에 화면에는 그대로 남아 저장된 것처럼 보이고, 다음
`fullSync` 가 서버 데이터로 덮으면 편집이 사라졌다. 토스트는 `동기화 실패 — 새로고침해
주세요` 였는데 **그 새로고침이 바로 지우는 동작이었다.**

Saydo 는 두 갈래로 나눈다.

| 실패 | 처리 |
|---|---|
| 네트워크 오류 · 5xx · 429 · 408 | **큐에 남기고** 지수 백오프(2초→최대 1분)로 재시도. 최대 6회 |
| 그 밖의 4xx | 재시도해도 소용없으므로 버리되 **무엇을 못 저장했는지 제목까지 말한다** |

그리고 `fullSync` 가 **미전송 편집을 덮지 않는다.** 큐에 연산이 걸린 태스크는 로컬 판이
최신이므로 서버 데이터로 교체하지 않고, 아직 서버에 없는 신규 항목(`tmp_` id)도 유지한다.

```
[동기화 실패와 편집 보존]
  ✓ 전송 실패한 연산을 큐에서 버리지 않는다
  ✓ 미전송 편집이 동기화로 덮이지 않는다
  ✓ 연결이 돌아오면 큐를 스스로 비운다
  ✓ 무엇을 저장하지 못했는지 알려 준다 (조용히 버리지 않는다)
  ✓ 예전의 해로운 안내("새로고침해 주세요")를 쓰지 않는다
```

옛 `catch` 로 되돌리면 9건 중 7건이 깨지고, `fullSync` 병합만 제거하면 정확히 1건
— "미전송 편집이 동기화로 덮이지 않는다" — 이 깨진다. 두 방어선이 각각 따로 지켜진다.

---

## 반복은 어느 경로로 완료해도 이어진다

Tasq 에는 백로그에 적어 둔 것보다 나쁜 문제가 있었다. 기록에는 "시리로 반복 태스크를
완료하면 시리즈가 끊긴다" 로만 적혀 있었는데, 실제로 열어 보니 **`voice/Code.gs` 가
`↻` 를 읽지도 쓰지도 않았다.**

```js
// 옛 decodeNotes — p, @label, ⏰, ⏳ 만 알고 ↻ 는 모른다
// 옛 encodeNotes — 그래서 다시 쓰지도 않는다
```

결과는 완료 시 이월 실패가 아니라 **데이터 파괴**다. 시리나 AI 로 우선순위 하나만 바꿔도
`decode(반복 없음) → encode(반복 없음)` 를 거쳐 "매주 월요일" 이 영영 사라진다. 경고도
흔적도 없다.

### 왜 테스트가 못 잡았나

`voicetest.js` 는 두 구현의 인코딩이 **바이트 단위로 같은지** 검증한다고 적혀 있었다.
그런데 비교 직전에 이렇게 하고 있었다.

```js
const theirs = core.encodeNotes(body, { ...meta, rec: null });   // ← 반복을 빼고 비교
```

**알려진 차이를 드러내는 대신 우회하도록 쓰여 있었다.** 이 프로젝트에서 세 번째 사례다.
지금은 `rec` 를 그대로 넘겨 비교하고, 반복 6종을 케이스에 넣었다.

### 고친 내용

- `Code.gs` 에 `parseRec` · `serRec` · `nextDue` · `addDays` · `addMonths` 를 이식.
  Apps Script 는 `core.js` 를 import 할 수 없으므로 **결과를 대조하는 것**이 유일한 방어다
- `toolComplete` 가 반복 태스크를 완료로 찍지 않고 **다음 회차로 이월**한다 (앱과 동일)
- 회귀 테스트: 반복 6종 × 기준일 5개 = **30조합의 다음 회차가 `core.js` 와 전부 일치**해야
  통과. ↻ 지원을 다시 걷어내면 15건이 깨진다

기한이 **지난** 반복은 오늘 기준으로 이월한다 — 과거로 밀면 영원히 지연 상태가 된다.
(이 규칙을 잊고 손으로 기댓값을 적었다가 틀렸다. 두 구현을 대조한 단언이 맞았고
내 손계산이 틀렸다.)

---

## 목록 삭제 — 되돌릴 수 없는 조작은 그렇게 다룬다

만들기만 있고 **이름 변경도 삭제도 없었다.** 둘 다 넣되 성격이 정반대라 다르게 다룬다.

- **이름 변경**은 되돌릴 수 있다 → 확인을 묻지 않는다
- **삭제**는 되돌릴 수 없다 → 확인이 무게를 진다

Google Tasks API 는 목록을 지우면 **안의 태스크까지 함께 지우고, 휴지통이 없다.**

| 상황 | 동작 |
|---|---|
| 마지막 남은 목록 | **막는다** (Tasks 는 목록 0개를 허용하지 않는다) |
| 빈 목록 | 한 번 확인 |
| 태스크가 있는 목록 | **건수를 보여 주고 목록 이름을 직접 입력**하게 한다 |

**되돌리기를 제공하지 않는다.** 캐시로 복원하는 흉내는 낼 수 있지만 id·position·상위
관계가 달라지고 중간에 실패하면 반쯤 복원된 상태가 남는다. **못 지킬 약속을 UI 에 다는
것**이 이 프로젝트에서 반복해 고쳐 온 실수라, 여기서는 하지 않는다.

지운 목록에 걸려 있던 미전송 연산도 큐에서 함께 정리한다 — 남겨 두면 404 를 맞고
"저장하지 못했습니다" 토스트만 쌓인다.

테스트 12건은 "지워지는가" 보다 **"실수로 지워지지 않는가"** 를 본다. 확인 절차를
제거하면 "확인 이름이 다르면 삭제하지 않는다" 가 곧바로 깨진다.

---

## 어느 계정에 연결됐는지 항상 보인다

구글 계정을 여러 개 쓰면 **"동기화가 안 된다" 고 느끼는 상황이 사실은 다른 계정을 보고 있는
것**이다. 앱이 말해 주지 않으면 확인할 방법이 없다. 실제로 개발 중에 이 혼란을 겪었다.

사이드바 맨 아래에 연결된 계정 주소를 표시하고, 옆의 **전환** 버튼이
`prompt: 'select_account'` 로 계정 선택 화면을 연다. 전환할 때는 **이전 계정의 토큰과
태스크 캐시를 반드시 비운다** — 안 그러면 이전 계정 할 일이 남아 섞인다.

---

## 설정해야 하는 것 (아직 비어 있음)

이 저장소는 **개인 계정 자산으로 새로 시작한다.** Tasq 의 값을 그대로 가져오지 않는다 —
그쪽 Cloud 프로젝트는 회사 Workspace 계정에 묶여 있고, 공개판이 거기에 의존하면 소유권이
흐려진다.

| 항목 | 상태 |
|---|---|
| `app.js` 의 `DEFAULT_CLIENT_ID` | ✅ **완료** — 개인 계정 프로젝트 `345139066407` 에서 발급 |
| OAuth 동의 화면 | 외부(External) + `auth/tasks` 는 민감 범위 → **검증 필요**(개인정보처리방침·도메인 소유 확인·데모 영상, 3~5영업일, 무료) |
| 승인된 JavaScript 원본 | `http://localhost:4173` 등록됨. **배포 후 Pages 주소 추가 필요** |
| Cloudflare Pages 프로젝트 | `.pages-project` = `saydo` — 개인 계정으로 새로 생성 |
| Apps Script (AI 백엔드) | 사용자가 각자 배포 — `voice/README.md` 참고 |

### OAuth 클라이언트 발급 절차

Cloud Console 의 메뉴 구조는 자주 바뀐다. **직접 주소로 들어가는 편이 확실하다.**
(2025년 개편으로 `API 및 서비스 → OAuth 동의 화면` 이 **Google 인증 플랫폼** 으로 옮겨졌다.)

**0. 로그인 계정부터 확인한다** — 우측 상단 아바타가 의도한 Google 계정인지 본다.
회사·학교 계정으로 만들면 Cloud 프로젝트가 **그 조직 소유**로 들어가고, 나중에 개인
프로젝트로 떼어내기 어려워진다. 개인 용도라면 프로젝트 선택기에서
**조직 = "조직 없음"** 이어야 한다.

**1. 인증 플랫폼 초기 설정** (최초 1회) — <https://console.cloud.google.com/auth/overview>

| 칸 | 값 |
|---|---|
| 앱 이름 | `Saydo` |
| 사용자 지원 이메일 | 본인 개인 Gmail |
| 대상(Audience) | **외부(External)** — 개인 계정은 이것만 선택 가능 |
| 연락처 이메일 | 본인 개인 Gmail |

**2. 범위 추가** — <https://console.cloud.google.com/auth/scopes>
→ `https://www.googleapis.com/auth/tasks` 하나만. 지금 넣어 두면 나중에 검증 신청이 수월하다.

**3. 테스트 사용자 등록** — <https://console.cloud.google.com/auth/audience>
게시 상태가 `테스트` 인 동안에는 **여기 등록된 계정만 로그인된다.** 본인 이메일을 넣지
않으면 `access_denied` 가 난다. (한도 100명. 검증을 마치고 `프로덕션` 으로 올리면 해제)

**4. 클라이언트 만들기** — <https://console.cloud.google.com/auth/clients>
→ **클라이언트 만들기**

| 칸 | 값 |
|---|---|
| 애플리케이션 유형 | **웹 애플리케이션** |
| 이름 | `Saydo Web` |
| **승인된 JavaScript 원본** | `http://localhost:4173` (배포 후 Pages 주소를 여기 추가) |
| 승인된 리디렉션 URI | **비워 둔다** — 토큰 클라이언트 방식이라 쓰지 않는다 |

원본은 **오리진만** 넣는다. 경로도 끝 슬래시도 안 된다.

```
https://saydo-ab12.pages.dev          ○
https://saydo-ab12.pages.dev/         ✗
https://saydo-ab12.pages.dev/index.html   ✗
```

**5. 생성된 클라이언트 ID 를 `app.js` 의 `DEFAULT_CLIENT_ID` 에 붙여넣는다.**

원본 등록은 반영에 몇 분 걸린다. 등록 전에 열면 `origin_mismatch` 가 난다.

---

## 검증

```bash
node test.js       # 80   메타 인코딩, 반복 규칙, 자연어 파서, 타임존
node uitest.js     # 127  인증·렌더·편집·정렬·재연결, **동기화 예산**, 완료 90일·상한 도달
node demotest.js   # 27   데모 모드, 외부 요청 0건, 테마·스킨
node movetest.js   # 44   보드 컬럼, 드래그 이동·중첩·승격
node aitest.js     # 75   Gemini 양쪽 형식, 도구 루프, Apps Script 모드
node voicetest.js  # 140  시리 백엔드, 인코딩 동일성, 음성 모드
node swtest.js     # 7    서비스워커 — 정규화 301, 오프라인 셸 폴백
```

**새 테스트는 일부러 망가뜨려 실패하는지 확인한 뒤에 넣는다.** 이 원칙은 값비싸게 배웠다 —
정렬 기능의 첫 테스트 13건은 정렬 함수를 통째로 무력화해도 전부 통과했고, 동기화 예산
테스트의 첫 판도 상수로 계산해서 호출이 12배 늘어도 통과했다. 둘 다 고쳤다.
