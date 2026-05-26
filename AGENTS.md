# AGENTS.md — opencode-smart-title

## Version Bump Procedure

버전 릴리스 시 다음 순서를 따른다. **태그(`vX.Y.Z`)와 `package.json`의 `version` 필드가 반드시 정확히 일치해야 한다.**

1. `package.json`의 `version` 필드를 새 버전으로 업데이트
2. `node -e "const p = require('./package.json'); console.log('v' + p.version)"` 으로 태그와 버전이 일치하는지 검증
3. `npm run build` 로 빌드 확인
4. 커밋: `chore: bump version to X.Y.Z`
5. `git tag vX.Y.Z` 로 태그 생성 후 `node -e "const p = require('./package.json'); if ('v'+p.version !== 'vX.Y.Z') throw new Error('tag/version mismatch')"` 재검증
6. 푸시: `git push origin master && git push origin vX.Y.Z`

## Project Structure

- `index.ts` — 플러그인 진입점, 이벤트 핸들링, 터미널 상태 동기화
- `lib/title.ts` — 세션 제목 생성, 터미널 타이틀 업데이트
- `lib/session.ts` — 세션 유틸리티 (루트 세션 조회, 서브에이전트 판별)
- `lib/context.ts` — 대화 컨텍스트 추출 및 포맷
- `lib/config.ts` — 플러그인 설정 로드
- `lib/model-selector.ts` — AI 모델 선택 및 폴백
- `lib/logger.ts` — 파일 로깅
- `prompt.ts` — 제목 생성 프롬프트

## Key Constraints

- 진입점: `session.idle` 이벤트 → `lib/title.ts` `updateSessionTitle`
- 터미널 타이틀은 OSC escape sequence로 변경 (공식 plugin API 없음)
- idle 전환에 5초 디바운스 적용 (running 이벤트 시 취소)
