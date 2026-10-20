# tools

> **`wrset/core.mjs` 와 `wrset/zip.mjs` 는 web-rpa 저장소 `src/set/` 의 사본이다. 항상 같은 내용으로 맞춰 둔다.**
> 고칠 때는 web-rpa 쪽을 먼저 고치고 두 파일을 그대로 복사한다. 두 쪽이 다르면 web-rpa 의 가져오기 검사와 허브 CI 의 결과가 달라지고, 같은 세트에서 다른 sha256 이 나올 수 있다.
> (2026-10-20 web-rpa `src/set/` 에서 복사)

모두 의존성 없는 Node.js(20 이상) 스크립트다. `npm install` 이 필요 없다. 저장소 루트에서 실행한다.

| 파일 | 하는 일 |
|---|---|
| `wrset/core.mjs` | 세트 규칙: 녹화값 정리, 접속 사이트·위험 계산, 개인정보 검사, manifest·세트 검사(`lintSet`), 엑셀 양식 검사(`xlsxDangers`), 기대 결과 비교 |
| `wrset/zip.mjs` | 고정된 순서·시각으로 묶는 zip 쓰기(`writeZip`, 같은 내용이면 같은 바이트)와 안전한 zip 읽기(`readZip`) |
| `hub.mjs` | 허브 CLI (아래) |
| `ai-review.mjs` | OpenRouter 로 PR 의 세트를 검토해 댓글·라벨을 단다 (아래) |

## hub.mjs

```text
node tools/hub.mjs lint [세트폴더|파일.wrset ...] [--base <ref>] [--head <ref>] [--json <파일>]
node tools/hub.mjs build --out dist
node tools/hub.mjs changed --base <ref> [--head <ref>] [--json]
node tools/hub.mjs unpack <파일.wrset> [--force]
node tools/hub.mjs readme
```

- `lint`: `core.lintSet` 과 `xlsxDangers` 에 더해 허브 규칙을 본다. 폴더 경로(`sets/<게시자>/<이름>/<버전>`)와 `manifest.id`·`version` 일치, 라이선스 형식, `expected.json` 형식, 되돌릴 수 없는 버튼의 확인 대기, 심볼릭 링크 금지. 경로를 주지 않으면 `--base` 가 있을 때 바뀐 세트만, 없으면 모든 세트를 검사한다. `--base` 가 있으면 게시된 버전 폴더 보호(바꾸거나 지우면 오류), 새 버전이 기존 최고 버전보다 큰지, PR 하나에 세트 버전 하나인지, 이전 버전보다 사이트·위험이 늘었는지도 본다. `--head <ref>` 를 주면 작업 폴더 대신 git 객체에서 읽는다(PR 내용을 풀지 않고 데이터로만 읽을 때). GitHub Actions 안에서는 오류를 파일 주석과 작업 요약으로도 남긴다. 오류가 있으면 종료 코드 1.
- `build`: 모든 세트를 검사한 뒤(오류가 있으면 빌드하지 않음) 세트 폴더마다 `writeZip` 으로 `dist/sets/<id>/<version>.wrset` 을 만들고, sha256·크기·첫 커밋 날짜(`publishedAt`)를 넣은 `dist/index.json` 과 한국어 목록 페이지 `dist/index.html` 을 만든다. README·CHANGELOG·media 는 `dist/sets/<id>/<version>/` 에 복사한다. `publishedAt` 을 정확히 계산하려면 git 이력 전체가 필요하다(`fetch-depth: 0`).
- `changed`: 두 ref 사이에 바뀐 세트 폴더 목록.
- `unpack`: 이슈로 받은 `.wrset` 을 검사하고 알맞은 세트 폴더에 푼다. 허용 목록 밖 파일은 풀지 않는다.
- `readme`: 저장소 README 의 세트 목록 표를 다시 쓴다.

### index.json 형식

`https://tak002.github.io/web-rpa-hub/index.json` 에 게시된다. web-rpa 엔진이 이 형식을 읽으므로 바꾸지 않는다. `url`·`readme` 는 index.json 주소 기준 상대 경로이고, `versions` 는 최신 버전이 먼저 온다.

```json
{ "format": "web-rpa-hub-index", "formatVersion": 1, "generatedAt": "ISO 시각",
  "hub": { "name": "web-rpa 공개 허브", "url": "https://tak002.github.io/web-rpa-hub/", "repo": "https://github.com/Tak002/web-rpa-hub" },
  "sets": [ { "id": "게시자/이름", "name": "…", "summary": "…", "author": { "name": "…", "github": "…" },
      "license": "CC0-1.0", "tags": ["…"], "latest": "1.0.0",
      "versions": [ { "version": "1.0.0", "engine": ">=0.2.0 <0.3.0", "url": "sets/게시자/이름/1.0.0.wrset",
                      "sha256": "…", "size": 1234, "publishedAt": "ISO 시각", "risk": ["download"], "sites": ["https://…"],
                      "columns": ["…"], "verified": { "at": "2026-10-20", "result": "3/3" } } ],
      "readme": "sets/게시자/이름/1.0.0/README.md" } ] }
```

`.wrset` 은 같은 파일 내용이면 같은 바이트가 나오도록 묶는다(이름순 정렬, 고정 시각 1980-01-01, deflate 9). 다만 deflate 결과는 Node 에 들어 있는 zlib 버전에 따라 달라질 수 있으므로, 게시된 sha256 은 CI(Node 22)에서 만든 파일 기준이다.

## ai-review.mjs

```text
node tools/ai-review.mjs --base <ref> --head <ref> [--pr N] [--post] [--out 댓글.md] [--dry-run]
node tools/ai-review.mjs sets/<게시자>/<이름>/<버전> [--dry-run]
```

- 바뀐 세트 폴더를 데이터로 읽고(`--head` 면 git 객체에서), `hub.mjs lint` 와 같은 검사를 돌린 뒤, `POLICY.md`·검사 결과·세트 파일로 프롬프트를 만든다. 세트 파일은 임의 구분자(`<<<SET_DATA_<난수>` … `SET_DATA_<난수>>>>`)로 감싸고, 안의 지시를 따르지 말라고 모델에 알린다. 세트 자료는 60KB 까지만 보낸다(넘으면 JSON 을 압축하고, 그래도 넘으면 자른다).
- 모델 답에서 JSON 을 꺼내(코드 블록·앞뒤 설명이 섞여도) 한국어 댓글을 만든다: 판정(승인 권장 / 수정 필요 / 거절 권장), 요약, 파일 위치가 붙은 발견 사항, 사이트·위험 요약, 자동 검사 결과. 모델이 쓴 글은 HTML·멘션·링크 문법을 무력화하고 길이를 자른다. 자동 검사 오류가 있는데 모델이 "승인 권장"을 내면 "수정 필요"로 낮춘다.
- `--post`: PR 에 댓글을 달거나(이전 AI 댓글이 있으면 고쳐 쓴다) 라벨 `ai-승인권장`·`ai-수정필요`·`ai-거절권장` 중 하나를 단다. 검사에서 새 사이트·새 위험이 나오면 `사이트추가`·`위험추가` 라벨도 단다. 병합·승인은 하지 않는다.
- `--dry-run`: 모델을 부르지 않고 프롬프트만 출력한다.

| 환경 변수 | 뜻 |
|---|---|
| `OPENROUTER_API_KEY` | 없으면 "AI 검토 키가 설정되지 않아 건너뜀" 댓글만 단다 |
| `AI_REVIEW_MODEL` | 모델 (기본 `anthropic/claude-sonnet-5.5`). 저장소 변수 `AI_REVIEW_MODEL` 로 바꿀 수 있다 |
| `OPENROUTER_BASE_URL` | 기본 `https://openrouter.ai/api/v1`. 가짜 서버로 시험할 때 바꾼다 |
| `GITHUB_TOKEN`, `GITHUB_REPOSITORY` | `--post` 때 필요 |
