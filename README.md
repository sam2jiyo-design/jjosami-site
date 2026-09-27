# 쪼삼이 홈페이지

확정된 A 디자인을 사용하는 운영용 앱입니다. Next.js 웹 앱, Supabase 인증·PostgreSQL·Storage, Cloudflare Durable Object 수집기로 구성됩니다. 기존 독립 HTML 목업은 이 디렉터리 밖의 `prototypes`에 유지하며 배포하지 않습니다.

공개 페이지: 홈, 프로필, 캘린더, 시그풍, 노래책, 업보, 방셀 신청.

관리자: 로그인 후 프로필 항목·일정·이미지·곡·분류·신청·업보 원장·룰렛 연동을 관리합니다. 변경은 공유 DB에 저장됩니다. 브라우저 저장소는 테마 선택에만 사용합니다.

## 시작

Node.js 22와 pnpm 10.10.0을 준비합니다.

```sh
corepack enable
corepack prepare pnpm@10.10.0 --activate
pnpm install --frozen-lockfile
```

`apps/web/.env.example`을 `.env.local`로 복사하고 별도 개발 Supabase의 값을 설정합니다. DB 마이그레이션과 관리자 등록 후:

```sh
pnpm dev
```

개발 주소는 `http://localhost:4320`입니다. 브라우저 주소와 `SITE_ORIGIN`의 호스트·포트는 같아야 합니다.

## 배포·운영

- [DEPLOYMENT.md](DEPLOYMENT.md): DB → 웹 → 수집기 배포, 환경변수, 도메인 설정
- [OPERATIONS.md](OPERATIONS.md): 관리자 사용, 백업·복구, 장애 대조, 운영 개시 검수
- [licenses/ASSETS.md](licenses/ASSETS.md): 폰트·이미지·아이콘 출처

```sh
pnpm check
pnpm build
pnpm collector:check
node scripts/healthcheck.mjs https://배포한-도메인
```

초기 데이터에는 확인된 프로필·생일·첫 방송일과 편집 가능한 업보 항목만 들어 있습니다. 시그풍·노래·시청자·후원·방셀 신청 예시는 넣지 않습니다. 운영 계정, 도메인, 실제 위플랩 주소와 비밀키도 포함하지 않습니다.
