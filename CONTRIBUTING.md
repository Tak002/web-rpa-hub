# 세트 올리는 방법

web-rpa 에서 만든 레시피를 "진행 세트"로 내보내 허브에 올리는 방법이다. 올리기 전에 [허브 정책](POLICY.md)을 꼭 읽는다. **PR 이나 이슈를 여는 순간 내용이 공개된다.**

## 올리기 전에 확인할 것

- [ ] [세트로 내보내기]의 정리 단계에서 "남은 값"을 모두 확인했다 (변수로 바꾸지 않은 입력값, 고정값, 화면 글자)
- [ ] 예시 데이터(`input/sample.csv`)는 공개 정보나 합성값이다. 실제 고객 데이터가 아니다
- [ ] 예시로 실행해 성공했고 `expected.json` 이 있다
- [ ] 사이트 이용약관과 robots.txt 를 확인했다. 공식 API 가 있으면 README 에 적었다
- [ ] 캡처와 영상에 개인정보가 없다
- [ ] 이 세트를 공개할 권리가 있다 (업무상 만든 것이면 회사 허락을 받았다)

## 방법 1: PR 로 올리기 (GitHub 사용에 익숙한 경우)

1. web-rpa 의 레시피 화면에서 **[세트로 내보내기]**를 눌러 `.wrset` 파일을 만든다. 이름, 요약, 사이트별 목적, 엑셀 열 설명, 라이선스(기본 CC0-1.0)를 채운다.
2. 이 저장소를 fork 하고 내 PC 에 clone 한다.
3. `.wrset` 을 세트 폴더에 푼다. 폴더는 `sets/<게시자>/<이름>/<버전>/` 이고, `<게시자>/<이름>` 은 `manifest.json` 의 `id`, `<버전>` 은 `version` 과 같아야 한다. Node.js 20 이상이 있으면 아래 명령이 검사한 뒤 알맞은 폴더에 풀어 준다.

   ```cmd
   node tools\hub.mjs unpack 내세트.wrset
   ```

   Node.js 가 없으면 `.wrset` 은 zip 이므로 이름 끝을 `.zip` 으로 바꿔 풀고, 안의 파일을 위 폴더에 그대로 옮긴다.

4. 검사를 돌려 오류가 없는지 본다.

   ```cmd
   node tools\hub.mjs lint sets\<게시자>\<이름>\<버전>
   ```

5. 커밋하고 PR 을 연다. **PR 하나에는 세트 버전 하나만** 넣는다. PR 화면의 체크리스트를 채운다.

## 방법 2: 이슈로 올리기 (GitHub 에 익숙하지 않은 경우)

1. web-rpa 에서 **[세트로 내보내기]**로 `.wrset` 파일을 만든다.
2. [세트 제출 이슈](https://github.com/Tak002/web-rpa-hub/issues/new?template=submit-set.yml)를 열고 파일을 끌어다 놓는다. GitHub 이 `.wrset` 첨부를 받지 않으면 파일 이름 끝에 `.zip` 을 붙여서(예: `내세트.wrset.zip`) 올린다.
3. 관리자가 파일을 검사해 PR 로 옮긴다(`node tools/hub.mjs unpack`). 이후 진행은 PR 과 같다.

## 새 버전 올리기

- 게시된 버전 폴더는 바꿀 수 없다. 새 버전 폴더(예: `1.0.1/`)를 만들고 `manifest.json` 의 `version` 을 맞춘다.
- 사이트 변화 대응은 patch, 출력·선택 열 추가는 minor, 엑셀 열이나 출력 값 이름이 바뀌면 major 를 올린다([정책 7](POLICY.md#7-버전)).
- README 의 "바뀐 점"에 무엇이 바뀌었는지 적는다.

## 세트 폴더 예

```text
sets/tak002/dart-latest-periodic-report/1.0.0/
├─ manifest.json      세트 정보 (id, 이름, 버전, 요약, 사이트, 엑셀 열, 위험 표시, pacing, 라이선스)
├─ recipe.json        정리된 레시피
├─ README.md          무엇을 하나, 준비물, 엑셀 열, 결과, 주의(약관·속도·공식 API), 바뀐 점
├─ input/sample.csv   예시 입력 1~5행 (UTF-8)
└─ expected.json      예시 실행의 기대 결과 (값의 모양과 파일)
```

## PR 에서 일어나는 일

1. **`lint` 검사**(필수): manifest 형식, 폴더 경로와 id·버전 일치, 게시된 버전 보호, 버전 증가, 선언하지 않은 사이트, 위험 표시, 녹화 흔적, 개인정보 패턴, 예시 CSV, 엑셀 양식, 파일 종류·크기, 되돌릴 수 없는 버튼의 확인 대기를 본다. 실패하면 검사 화면과 PR 의 Files 탭에 이유가 한국어로 나온다.
2. **AI 참고 검토**: 관리자가 키를 설정했으면 AI 가 의견 댓글과 `ai-*` 라벨을 단다. 참고용이며 병합을 결정하지 않는다.
3. **관리자 승인**: 관리자가 정책에 따라 보고 승인하면 병합한다. 처음 올리는 경우나 새 사이트·새 위험이 생긴 경우에는 예시를 직접 돌려 본다.
4. **게시**: 병합되면 몇 분 안에 <https://tak002.github.io/web-rpa-hub/> 와 `index.json` 에 반영되고, web-rpa 의 [허브] 탭에 나타난다.

## 도구를 고칠 때

`tools/` 를 바꾸는 PR 은 관리자만 병합한다. `tools/wrset/core.mjs`, `tools/wrset/zip.mjs` 는 web-rpa 저장소의 사본이므로 여기서 직접 고치지 않는다([tools/README.md](tools/README.md)).
