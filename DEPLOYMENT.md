# 배포 방법

운영 구성은 Vercel(Node.js) + Supabase + Cloudflare Workers입니다. 이 ZIP은 정적 HTML이 아니라 설치·빌드할 수 있는 운영 소스 패키지입니다. `apps/web`만 떼어 올리지 말고 패키지 루트 전체를 저장소에 올립니다.

## 1. Supabase

1. 운영 전용 프로젝트를 만들고 리전을 선택합니다. Vercel 함수 리전은 DB와 가깝게 맞춥니다.
2. Supabase CLI에서 로그인하고 이 디렉터리에서 프로젝트를 연결합니다. `supabase link --project-ref 실제-project-ref` 후 `supabase db push`로 `supabase/migrations`를 순서대로 적용합니다. 새 프로젝트에 최초 적용하는 마이그레이션입니다. 기존 다른 서비스의 DB에 적용하지 않습니다.
3. Authentication에서 **새 사용자 가입을 비활성화**합니다. `config.toml`은 로컬 개발 설정이며 호스팅 프로젝트의 가입 설정은 대시보드에서도 적용합니다.
4. Authentication → Users에서 실제 관리자 계정을 추가합니다. 비밀번호는 운영자가 정하고 보관합니다. `scripts/grant-admin.sql`의 이메일만 해당 계정으로 바꿔 SQL Editor에서 실행합니다. 공개 가입 화면이나 기본 비밀번호는 없습니다.
5. Project URL, publishable key, secret key를 Vercel 환경변수에 등록합니다. 기존 프로젝트의 anon/service_role 키도 각각 대응되는 값으로 사용할 수 있습니다. Secret/service_role은 서버에서만 사용합니다.
6. Storage의 `site-assets` 버킷과 public read 정책은 마이그레이션이 생성합니다. 업로드는 인증된 웹 API에서 파일 형식·3MB 크기를 확인한 후 서버 키로 수행합니다. 익명 업로드 정책을 추가하지 않습니다.

SQL 함수가 전체 원장 합산·중복 방지·버전 비교·방셀 완료/취소를 트랜잭션으로 처리합니다. 비공개 테이블에는 RLS가 적용되며 공개 업보는 별도 공개 조회 함수가 닉네임·아이디·항목·수량·변동 내역만 반환합니다.

## 2. Vercel 웹

Vercel에서 저장소를 가져오고 다음처럼 설정합니다.

| 설정 | 값 |
| --- | --- |
| Framework | Next.js |
| Root Directory | `apps/web` |
| Include source files outside Root Directory | 켬 |
| Node.js | 22.x |
| Install command | `pnpm install --frozen-lockfile` |
| Build command | `pnpm build` |
| Output Directory | Next.js 기본값 |

pnpm workspace 루트와 공통 패키지를 포함해야 합니다. Vercel 대시보드에서 Production 변수만 먼저 입력합니다.

| 변수 | 값·용도 |
| --- | --- |
| `SITE_ORIGIN` | 실제 HTTPS 도메인. 경로 없이 입력 |
| `STREAMER_KEY` | `jjosami` — Worker와 동일 |
| `SUPABASE_URL` | 운영 Supabase URL |
| `SUPABASE_PUBLISHABLE_KEY` | publishable 또는 anon 키 |
| `SUPABASE_SECRET_KEY` | secret 또는 service_role 키, 서버 전용 |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile 공개 사이트 키 |
| `TURNSTILE_SECRET_KEY` | 같은 위젯의 secret 키 |
| `RATE_LIMIT_HASH_SECRET` | 무작위 32바이트 이상 비밀값 |
| `SOOP_CHANNEL_ID` | `bomyangul` |
| `MUSICBRAINZ_USER_AGENT` | `Jjosami/1.0 (운영 연락 이메일 또는 운영 사이트 주소)` |
| `SONGBOOK_LOOKUPS_ENABLED` | 처음 `false`, 실제 검색·커버·영상 조회 확인 후 `true` |
| `LIVE_INTEGRATIONS_ENABLED` | 처음 `false`, 방송 상태·룰렛 검수 후 `true` |
| `COLLECTOR_ORIGIN` | 배포한 Worker HTTPS origin |
| `COLLECTOR_CONTROL_SECRET` | Worker와 같은 제어 서명 비밀값 |
| `COLLECTOR_INGEST_SECRET` | Worker와 같은 수신 서명 비밀값. 제어 키와 다르게 생성 |

비밀값 생성 예: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. 생성 결과를 저장소·채팅·빌드 로그에 남기지 말고 환경변수 관리 화면에 직접 보관합니다.

Turnstile 위젯의 허용 호스트에 실제 도메인을 등록합니다. 서버는 Siteverify의 성공 여부뿐 아니라 `hostname`과 `action=photo-request`를 검사합니다. 사이트 키가 없으면 신청 제출은 비활성화되고, 잘못된 토큰으로는 접수되지 않습니다. 테스트용 키를 운영에 사용하지 않습니다.

Preview에는 운영 Supabase 키·Worker 키를 전달하지 않습니다. `VERCEL_ENV=preview`는 기본적으로 DB 접근을 차단합니다. 미리보기가 필요하면 **별도 개발 Supabase 프로젝트**만 연결하고 그 환경에서만 `PREVIEW_DATABASE_ISOLATED=true`를 설정합니다. `LIVE_INTEGRATIONS_ENABLED`는 false로 유지합니다. 이 플래그는 별도 DB를 자동 생성하지 않습니다.

## 3. Cloudflare 수집기

```sh
pnpm --filter @jjosami/collector exec wrangler login
pnpm --filter @jjosami/collector exec wrangler secret put WEB_API_ORIGIN
pnpm --filter @jjosami/collector exec wrangler secret put COLLECTOR_CONTROL_SECRET
pnpm --filter @jjosami/collector exec wrangler secret put COLLECTOR_INGEST_SECRET
pnpm --filter @jjosami/collector deploy
```

`WEB_API_ORIGIN`은 Vercel의 실제 HTTPS 도메인입니다. 두 서명 키는 웹 환경변수와 일치해야 합니다. 이 구성에는 새로운 Cloudflare 계정 또는 결제 약관 동의가 자동으로 포함되지 않습니다.

`wrangler.jsonc`에는 SQLite Durable Object 바인딩·v1 마이그레이션·5분 Cron이 포함됩니다. `STREAMER_KEY`별 동일 객체 하나를 사용합니다. 최초에는 `COLLECTOR_ENABLED=false`이므로 자동 연결하지 않습니다. 실제 연동 준비가 끝나면 true로 바꾸고 재배포합니다. 수집 시작은 **관리자 → 룰렛 연동 → 수집 시작**으로 별도 수행합니다. 재배포·Cron은 중지 상태를 임의로 시작하지 않습니다.

관리자가 룰렛 목록 URL과 후원 알림 URL을 각각 입력합니다. 연구용 예시 URL은 코드·DB에 들어 있지 않습니다. 목록을 불러온 뒤 각 결과를 업보 항목·수량으로 연결하거나 기록 제외를 지정합니다. 미연결·모호한 결과는 확인 대기로 남고 자동 지급하지 않습니다.

위플랩 어댑터는 공개 페이지의 현재 관측 구조와 Engine.IO 4 / Socket.IO 메시지 형식에 기반합니다. 공개·계정 설정 또는 서비스 구조가 바뀌면 재검증이 필요합니다. 비공개 API 이용 허가나 모든 수신을 보장하는 계약은 포함하지 않습니다.

## 4. 공개 전 확인

```sh
node scripts/healthcheck.mjs https://실제-도메인
```

이 명령은 공개 API와 비인증 관리자 거부만 확인합니다. [운영 검수](OPERATIONS.md)의 로그인·업로드·신청·룰렛·24시간 관찰을 별도로 수행합니다. localhost에서의 DB 테스트는 호스팅 인증·Storage·실제 WebSocket·실제 Turnstile 검증을 대신하지 않습니다.

DNS·도메인·운영 계정·키가 제공되지 않아 이 패키지 제작 과정에서 실제 서비스 배포나 24시간 관찰은 수행하지 않았습니다. SOOP 오프라인 응답은 확인했으며 실제 LIVE 상태는 첫 방송 시 대조해야 합니다. 불명확한 응답은 LIVE로 추정하지 않고 ‘확인 지연’으로 표시합니다.

## 변경·롤백

DB 마이그레이션 → 웹 → Worker 순서로 배포합니다. 원장·이벤트 키·대기열을 유지하는 호환 변경만 적용합니다. 이전 웹/Worker 버전으로 롤백할 때 DB를 초기화하거나 Durable Object를 삭제하지 않습니다. 현재 마이그레이션 파일은 최초 배포 후 수정하지 말고 후속 번호의 새 파일을 추가합니다.

참고: [Next.js 배포](https://nextjs.org/docs/app/getting-started/deploying), [Supabase 서버 인증](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [Turnstile 서버 검증](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [Durable Objects WebSocket](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [MusicBrainz 요청 제한](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting).
