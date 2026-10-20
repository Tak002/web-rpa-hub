# web-rpa 공개 허브

[web-rpa](#web-rpa-란)로 바로 쓸 수 있는 **진행 세트**(`.wrset`)를 나누는 곳이다. 세트 하나에는 녹화한 웹 작업 순서(레시피), 예시 입력, 기대 결과, 설명이 들어 있다. 누구나 PR 로 세트를 올릴 수 있고, 자동 검사와 관리자 승인을 거친 세트만 목록에 올라간다.

- 세트 목록: <https://tak002.github.io/web-rpa-hub/>
- web-rpa 가 읽는 목록 파일: <https://tak002.github.io/web-rpa-hub/index.json>

## 세트 설치하기

1. **허브 탭에서 (web-rpa 0.2.0 이상)**: web-rpa 화면의 **[허브]** 탭에서 세트를 고르고 [가져오기]를 누른다. web-rpa 가 `index.json` 을 읽어 `.wrset` 을 받고 sha256 을 확인한다.
2. **파일로 (인터넷이 막힌 PC 등)**: [세트 목록](https://tak002.github.io/web-rpa-hub/)에서 `.wrset` 파일을 받아 옮긴 뒤, web-rpa 의 **[세트 파일 가져오기]**로 연다.

어느 쪽이든 가져오기 화면에서 **접속 사이트와 위험 표시를 확인**하고, 들어 있는 예시로 먼저 시험 실행한 뒤 쓴다.

## 세트 목록

<!-- sets:start -->
| 세트 | id | 최신 | 사이트 | 엑셀 열 | 위험 표시 |
|---|---|---|---|---|---|
| [DART 회사별 최신 정기보고서 PDF 받기](sets/tak002/dart-latest-periodic-report/1.0.0/README.md) | `tak002/dart-latest-periodic-report` | 1.0.0 | dart.fss.or.kr | 회사명 | download |
| [서울외국환중개 통화별 직전 월 월말 환율](sets/tak002/smbs-month-end-fx/1.0.0/README.md) | `tak002/smbs-month-end-fx` | 1.0.0 | www.smbs.biz | 통화 | download, insecure-http |
<!-- sets:end -->

이 표는 `node tools/hub.mjs readme` 로 만든다. 가장 정확한 목록은 [세트 목록 페이지](https://tak002.github.io/web-rpa-hub/)다.

### 위험 표시의 뜻

| 표시 | 뜻 |
|---|---|
| `submit` | 제출·신청·결제·삭제처럼 되돌릴 수 없는 버튼을 누른다 (허브 정책상 앞에 사용자 확인 대기가 있거나 README 에 이유가 있다) |
| `download` | 파일(다운로드, PDF, 화면 캡처)을 PC 에 저장한다 |
| `upload` | PC 의 파일을 사이트에 올린다 (올릴 파일은 설치 후 직접 지정) |
| `login` | 로그인이 필요하거나, 실행 중 사용자 확인을 기다린다 |
| `insecure-http` | 암호화하지 않은 `http://` 사이트에 접속한다 |
| `var-in-url` | 엑셀 값을 주소에 넣어 이동한다 |

선언하지 않은 사이트로 이동하는 세트는 자동 검사에서 거절된다.

## 세트 올리기

[CONTRIBUTING.md](CONTRIBUTING.md)를 본다. 요약하면, web-rpa 의 **[세트로 내보내기]**로 만든 `.wrset` 을 `sets/<게시자>/<이름>/<버전>/` 에 풀어 PR 을 열거나(PR 하나에 세트 버전 하나), [세트 제출 이슈](https://github.com/Tak002/web-rpa-hub/issues/new?template=submit-set.yml)에 파일을 첨부한다. 지켜야 할 규칙은 [허브 정책](POLICY.md)에 있다: 개인정보·고객 데이터 금지, 선언한 사이트만 접속, 캡차·차단 회피 금지, 자동 접속을 금지하는 사이트 금지, 속도(pacing) 필수, 제출·결제 세트는 사용자 확인 대기.

## 검토 방식

| 단계 | 누가 | 내용 |
|---|---|---|
| `lint` | CI (필수 검사) | manifest 형식, 폴더 경로, 게시된 버전 보호, 버전 증가, 선언하지 않은 사이트, 위험 표시, 녹화 흔적, 개인정보 패턴, 예시·엑셀 검사. 검사 도구는 main 의 것을 쓴다 |
| AI 참고 검토 | OpenRouter 모델 | 정책에 비춘 의견 댓글과 `ai-승인권장`·`ai-수정필요`·`ai-거절권장` 라벨. 병합 권한 없음 |
| 승인 | 관리자 (CODEOWNERS) | 1명 승인 후 병합. 병합되면 Pages 에 자동 게시 |

고장 신고와 삭제 요청은 [이슈](https://github.com/Tak002/web-rpa-hub/issues/new/choose)로 받는다. 개인정보가 들어간 세트는 공개 이슈 대신 [비공개 신고](https://github.com/Tak002/web-rpa-hub/security/advisories/new)로 알려 준다.

## 저장소 구성

```text
sets/<게시자>/<이름>/<버전>/   풀어 둔 세트 (manifest.json, recipe.json, README.md, input/sample.csv, expected.json)
tools/hub.mjs                  검사·빌드 CLI (lint, build, changed, unpack, readme)
tools/ai-review.mjs            AI 참고 검토
tools/wrset/                   web-rpa 와 같은 세트 규칙·zip 코드 (web-rpa src/set/ 의 사본)
.github/workflows/             check(lint), ai-review, build(Pages 게시)
```

도구는 의존성이 없는 Node.js 스크립트다. 자세한 내용과 `index.json` 형식은 [tools/README.md](tools/README.md)에 있다.

## web-rpa 란

웹에서 하는 반복 작업을 한 번 녹화해 레시피로 만들고, 엑셀 행마다 같은 작업을 자동으로 반복하는 Windows용 로컬 RPA 도구다. 모든 처리는 사용자 PC 안에서 한다. web-rpa 본체는 이 저장소에 들어 있지 않다.

## 라이선스

- 허브의 도구·문서·워크플로: [MIT](LICENSE)
- 각 세트: 그 세트의 `manifest.json` 의 `license` (기본 CC0-1.0). 세트 목록 페이지와 `index.json` 에도 표시된다.

## 책임 있는 사용

자동화하려는 사이트의 이용약관과 자동 접속 정책을 지키는 것은 사용자의 책임이다. 세트의 `pacing`(행 사이 간격, 한 번에 돌릴 최대 행 수)을 줄이지 말고, 공식 API 가 있으면 그것을 먼저 검토한다. 세트는 있는 그대로 제공된다.
