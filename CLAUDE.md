# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

Trino 전용 데스크톱 IDE. 두 가지 핵심 작업을 지원한다:
1. **Host 관리** — Trino 서버 접속 정보(URL, 사용자, catalog/schema, 비밀번호)를 등록/수정/삭제하고 연결 테스트.
2. **쿼리 결과 조회** — SQL을 작성·실행하고 결과를 그리드로 본다.

스택: **Electron + TypeScript + React**, 빌드 도구는 **electron-vite**. Trino 통신은 `trino-client`(npm) 사용.

## 명령어

```bash
npm run dev          # 개발 모드 (HMR + Electron 창)
npm run build        # main/preload/renderer 프로덕션 빌드 → out/
npm run typecheck    # node(main+preload) + web(renderer) 타입체크 둘 다
npm run typecheck:node   # main/preload/shared 만
npm run typecheck:web    # renderer/shared 만

npm run dist         # 빌드 + electron-builder 패키징 → release/ (.dmg/.zip/.app)
npm run dist:dir     # 패키징 없이 .app 디렉터리만 (빠른 확인용)
```

코드 서명이 없으면 자동 탐색을 끄고 빌드한다(ad-hoc 서명만 적용):
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
```

`npm test`는 Vitest로 Preview SQL·로컬 페이지 계산·Main process 세션/스풀 경계 조건을 검증한다.

### Electron 바이너리 주의
`npm install` 후에도 Electron 실제 바이너리가 안 받아져 `dev`가 `Error: Electron uninstall`로 죽을 수 있다. 이때:
```bash
node node_modules/electron/install.js   # 바이너리 재다운로드
```
`node_modules/electron/path.txt`와 `node_modules/electron/dist/`가 존재해야 정상이다.

## 아키텍처

Electron의 3-프로세스 구조를 따른다. **Trino 접속과 비밀번호는 전부 main 프로세스에만** 있고, renderer는 `window.api`(preload가 contextBridge로 노출) 너머로만 접근한다.

```
renderer (React)  ──IPC──▶  main process  ──HTTP──▶  Trino
  window.api                 ipc.ts                   trino-client
                             trino/client.ts
                             store/hosts.ts (userData/hosts.json)
```

### 레이어와 책임 (`src/`)
- `shared/types.ts` — main과 renderer가 **공유하는 타입 전용** 모듈(런타임 코드 금지). `HostConfig`/`HostInput`/`QueryResultPayload`/`IpcResult<T>`/`TrinoIdeApi`의 단일 출처.
- `main/index.ts` — 앱 생명주기, BrowserWindow 생성. dev면 `ELECTRON_RENDERER_URL` 로드, 아니면 `out/renderer/index.html`.
- `main/ipc.ts` — 모든 IPC 핸들러 등록. host 입력을 접속 정보(`ResolvedConn`)로 **복호화**하고, 실행 중 쿼리를 `requestId → {token, conn}` 맵으로 추적해 취소를 지원한다. `query:run`은 **성공/실패 모두 `history` 저장소에 자동 기록**하고, 사용자 SQL을 **재작성 없이 그대로 1회 실행**한다(아래 결과 수신).
- `main/trino/client.ts` — `trino-client`로 쿼리 실행. `runQuery(conn, sql, token, rowLimit, onProgress?)`가 `trino.query()`의 async iterator(nextUri 페이징)를 돌며 columns/data/stats를 누적. `rowLimit`(기본 `SAFETY_CAP`=5만) 도달 시 서버 쿼리를 `cancel`하고 `truncated` 표시. **취소(#50)**: `token.trinoQueryId`를 **루프 진입 전** `initialQueryId(iter)`로 즉시 확보한다 — trino-client의 `QueryIterator.next()`가 무데이터 페이지를 내부 재귀로 삼켜 for-await 본문이 안 돌 수 있어, 본문에서만 id를 잡으면 무출력 쿼리에서 `query:cancel`이 서버 `DELETE`를 스킵해 중지가 안 먹던 버그를 막는다(`initialQueryId`는 `iter.iter.queryResult.id` 내부 구조 의존, 실패 시 undefined 폴백). **SQL은 재작성하지 않는다** — 원본을 그대로 실행한다(페이지네이션 헬퍼 `canPaginate`/`wrapPaginated` 등은 제거됨). 에러는 `TrinoQueryError`(errorName/errorType/errorCode + Trino 런타임 필드 `errorLocation`의 line/column 보존)로 던진다. `onProgress`는 페이지마다 stats를 흘려보내지만 **trino-client의 iterator가 `data`가 빈 stats-only 페이지를 내부에서 건너뛰므로**(`QueryIterator.next()` 재귀 skip) 진행 stats는 **데이터가 실린 페이지에서만** 스트리밍된다(계획/큐 단계는 안 옴 → 라이브 경과 타이머가 그 공백을 메운다).
- `main/trino/previewSession.ts` — 테이블 Preview 전용 세션 관리자. SQL을 한 번 제출한 뒤 최초 POST 응답과 `nextUri` 스트림을 Main process가 끝까지 소비해 NDJSON 임시 파일에 append하고, Renderer에는 요청한 로컬 페이지 구간만 반환한다. 세션별 행 한도(1천/1만/5만), 256 MiB 저장 한도, 8 MiB 단일 행·16 MiB IPC 페이지 한도와 owner 기반 취소/정리를 적용한다.

### 결과 수신 (원본 SQL 1회 실행 + 클라이언트 페이지네이션) — #40
- **SQL을 재작성하지 않는다.** `query:run`은 사용자가 쓴 문장을 **그대로 1회 실행**한다(OFFSET/LIMIT 주입·서브쿼리 래핑·페이지 재실행 **없음**). 근거: Trino `nextUri`는 단일 실행을 forward 스트리밍하는 커서라 재작성 없이 결과를 받아올 수 있고, 재작성 페이지네이션(구 "방식 B")은 정확성(ORDER BY 없을 때 페이지 간 행 중복/누락)·투명성(사용자 SQL≠전송 SQL)·서버 부하(OFFSET 재스캔) 모두에서 열등했다.
- **메모리 보호 안전 상한** `SAFETY_CAP`(`client.ts`, 5만 행)까지만 스트림 수신 후 서버 쿼리를 `cancel`(= nextUri DELETE) → 초과 시 `truncated`로 "SQL에 LIMIT/WHERE로 좁혀 재실행" 안내. 서버엔 최초 수신 몇 초 외 아무것도 안 띄운다.
- **페이지네이션은 클라이언트가** — 받은 결과 전체가 renderer 메모리에 있고 `ResultsPane`의 `@tanstack/react-virtual` 가상 스크롤로 열람한다(서버 왕복·◀▶ 페이저 없음). 딥 페이징은 지원하지 않는다(서버 부하 회피).
- **진짜 서버 부하 절감은 사용자가 SQL에 `LIMIT`을 거는 것**(서버 pushdown/top-N) — 그래서 커서 문장에 최상위 LIMIT이 없으면 `largeScanRisk`가 경고 칩("LIMIT 없음")을 띄워 유도한다.
- `main/store/settings.ts` — 앱 전역 설정(`<userData>/settings.json`). 현재 사용자 설정 항목 없음(`AppSettings`는 빈 인터페이스, 향후 확장용). `getSettings`/`updateSettings`.
- `main/store/hosts.ts` — host 영속화. `<userData>/hosts.json` 평문 + 비밀번호만 `safeStorage`(OS 키체인)로 암호화해 `enc:<base64>`로 저장. 키체인 불가 환경은 `plain:<base64>` 폴백(난독화 수준).
- `main/store/history.ts` — 쿼리 실행 기록 영속화. `<userData>/history.json`에 **최신순**으로 저장, 최근 `MAX_HISTORY`(200)개만 유지. `addHistory`/`listHistory`/`deleteHistory`/`clearHistory`.
- `main/store/savedQueries.ts` — 저장 쿼리 라이브러리(`<userData>/saved-queries.json`). 1단계 `폴더(QueryFolder)` + 폴더 소속 `SavedQuery`. 폴더 삭제 시 안의 쿼리 **연쇄삭제**, `createQuery`는 대상 폴더가 없으면 거부.
- `preload/index.ts` — `window.api`(=`TrinoIdeApi`) 노출. `preload/index.d.ts`가 `Window.api` 전역 타입 보강.
### 멀티 탭 에디터 모델 (`renderer/src/lib/tabs.ts`)
- **탭 1개 = 독립 SQL 문서**(`EditorTab`). `savedQueryId!=null`이면 저장 쿼리 **바인딩** 탭, null이면 미저장 **스크래치** 탭. `dirty = sql !== baseSql`.
- **탭별 상태**: `sql`/`baseSql`/`hostId`/`result`/`error`/`running`/`requestId`/`progress`. **전역**: `hosts`/`selectedHostId`/`library`/`history`. → 즉 **결과·연결은 탭마다**.
- 저장 쿼리 클릭 = **open-or-focus**(같은 쿼리가 열려 있으면 그 탭 포커스). 폴더 `＋쿼리`는 **빈 SQL** 쿼리를 `Untitled query N`으로 즉시 생성→바인딩 탭으로 연다.
- **미작업(일회용) 탭 교체(#42)**: 콘텐츠를 새로 열 때(저장쿼리 신규·히스토리·＋)는 포커스 pane의 활성 탭이 **`isDisposable`**(=`!isDirty && result===null && error===null && !running`, 즉 연 뒤 편집·실행 0)이면 **새 탭을 쌓지 않고 그 자리에 교체**한다(`openOrReplaceInFocused`가 **탭 id를 재사용** → 탭 순서·⌘1..9 인덱스 안정, 누적 없이 내용만 스왑). 편집(→dirty)이나 실행(→result/running)으로 disposable이 풀린 탭은 보존된다. `＋`는 활성 탭이 **빈 미작업 스크래치**면 no-op(빈 탭 누적 차단), 아니면 새 스크래치(빈 바인딩 탭 제외). 활성 탭만 대상(백그라운드 탭 불변), non-dirty라 `CloseTabDialog`/`cancelQuery` 안 탐 — 순수 renderer.
- 저장(💾): 스크래치면 `SaveQueryDialog`로 저장 후 그 탭을 **리바인딩**, 바인딩이면 `updateQuery`로 **덮어쓰기**. 닫기: dirty면 `CloseTabDialog`(저장/저장안함/취소), 마지막 탭 닫으면 새 스크래치 자동 생성. 저장 쿼리가 삭제되면 열린 탭은 **스크래치로 변환**(작업 보존, `App`의 reconcile effect).
- **세션 재시작 영속화(#12, `lib/session.ts`)**: 열린 탭들의 **SQL·레이아웃**(pane별 tabs `{id,savedQueryId,title,sql,baseSql,hostId}` + activeTabId + focusedPaneId, split 비율은 기존 `wsSplitRatio` 재사용)을 **localStorage `wsSession`**(`{v,panes,focusedPaneId}`)에 저장 → 재시작 시 `panes`/`focusedPaneId` lazy initializer가 **한 번만 hydrate**해 복원(무공지). **결과/에러/실행중 상태는 저장 안 함**(복원 시 휘발 필드 초기화 — 자동 재실행 없음, 서버 왕복 0). `baseSql`도 저장해 dirty(`●`) 정합 유지. 저장은 **디바운스(500ms)** + `beforeunload`/`visibilitychange:hidden` 플러시. **가드 2개**: ① 라이브러리 최초 로드 전(`libraryLoaded`)엔 reconcile 스킵(복원된 바인딩 탭 오변환 방지) ② hostId 정리 effect가 삭제된 host 참조를 기본 연결로 교체(hosts 미로드 시 성급히 안 지움). 손상/버전불일치/빈 데이터는 기본 스크래치 1개로 폴백. 순수 렌더러(main 무관).

- `renderer/src/` — React UI. **보편적 DB IDE 레이아웃**: 좌측 `ActivityRail`(아이콘) + `explorer`(섹션 패널) + `workspace`(에디터/결과) + 하단 `StatusBar`. `App.tsx`가 상태/오케스트레이션:
  - `ActivityRail` (Connections/Saved/History 섹션 전환). explorer 헤더(제목+추가 액션)는 `App`이 섹션별로 렌더.
    - **에디터↔결과 세로 크기조절(#46)**: 각 `.ws-pane` 안 `SqlEditor`(`.editor-pane`)와 `ResultsPane`(`.results`) 사이 `.v-splitter`(row-resize) 드래그로 세로 비율 조절, **더블클릭=기본 복원(0.4)**. `.ws-pane`에 인라인 CSS 변수 `--editor-grow`/`--results-grow`를 세팅해 두 자식이 `flex: var()`로 소비(`.cm-host`는 고정 clamp 높이 대신 `flex:1; min-height:64px`, `.results`는 `min-height:120px`). `editorRatio`(에디터 몫 0.15~0.85)는 **별도 localStorage 키**로 영속(세션 `wsSession`과 무관), **분할 시 양쪽 pane 공유**. 에디터 휠 스크롤은 `cmTheme`의 `.cm-scroller { overflow:auto; overscroll-behavior:contain }`로 활성(긴 SQL 클리핑 해결·끝에서 전파 방지). 순수 렌더러.
    - **explorer 사이드바 크기조절/접기**(`App.tsx`): explorer↔workspace 사이 `.splitter` 드래그로 너비 조절(`MIN_EXPLORER 190`~`MAX_EXPLORER 460`px, `explorerWidth` state를 인라인 `style`로 적용). 완전 접기/펼치기(`explorerCollapsed`) — 헤더의 접기 버튼(`<`)·스플리터 더블클릭으로 접고, 레일 아이콘 클릭으로 펼침(같은 섹션 아이콘 재클릭=접기, VS Code 관례). `explorerWidth`/`explorerCollapsed`는 **localStorage 영속화**(렌더러 전용, main 무관). 접힘 시 `ActivityRail`은 `collapsed` prop으로 활성 하이라이트를 끈다.
  - **Browser 탭(등록됨 기본 + 찾아보기, #52)**: ActivityRail 5번째 섹션(`IconSitemap`) `BrowserPanel` — 내부 **2모드**(패널 내 스왑, tablist 아님). host 셀렉터 공유.
    - **직접 등록(팝업)**: 찾아보기(드릴다운) 없이 **`RegisterTableDialog`**로 catalog·schema·table을 직접 입력해 등록(연결 기본 catalog/schema 프리필, 중복 차단). 등록은 `registerTables`(upsertMetadata manual) 위임 — 서버 왕복 0. home 진입 버튼 행("찾아보기 + 직접 등록")·빈 상태 CTA에서 연다.
    - **home(등록됨, 기본·서버 0)**: `metadata[hostId]`에서 **manual 테이블로 이어지는 경로만** 트리로 렌더(catalog→schema→table, learned·컬럼 제외 → Metadata 탭과 스코프 분리). 필터가 "manual 리프 경로"라 부모 source 승격 여부·등록 해제 후 빈 노드 자동 소거에 견고. caret 중립(앰버 없음). 상단 full-width **"＋ 찾아보기"**, 캡션 "등록한 항목 · 서버 조회 0". 테이블 hover **"등록 해제"**(`IconTrash` → `deleteMetadata` + 토스트). 등록 0건이면 **"찾아보기로 시작" CTA**(→browse 전환). host 미선택 안내.
    - **browse(찾아보기, 서버 라이브)**: 상단 **"← 등록됨"** 바 + 드릴다운 — 카탈로그 펼치면 `SHOW SCHEMAS FROM "cat"`, 스키마 펼치면 `SHOW TABLES FROM "cat"."sch"`(펼치기 = **명시 클릭 1회 = 서버 왕복 1회**). 최상위는 **"카탈로그 불러오기 · 서버 조회 1회" 버튼**만 트리거(탭 열기·host 변경·모드 스왑으론 조회 0). **비용 시그니처**: 미로드 확장노드 caret=앰버(`--warn`)→로드(캐시) 중립 + 캡션 + 노드 title 힌트. 테이블 hover `＋`/스키마 "전체"(로드된 미등록분 일괄, 추가 왕복 0) → `upsertMetadata`(manual) → home·Metadata·자동완성 반영, 이미 등록(manual)분 "등록됨"(대소문자 무시). 노드/카탈로그 새로고침(명시 1회).
    - **테이블 데이터 프리뷰(#54)**: home(등록됨) 트리 테이블 **더블클릭** → **전용 프리뷰 탭**(`EditorTab.preview` 변별자, `renderPane` 상단 슬롯을 `SqlEditor` 대신 `PreviewPane`로 스왑, **v-splitter+ResultsPane 그대로 재사용**). 즉시 `SELECT * FROM "cat"."sch"."tbl" LIMIT 500` 1회 실행. **SQL 숨김·에디터 미주입** — 상단은 [탭 스트립 + 컨트롤 바(테이블칩·LIMIT·조회·"SQL 편집기로 열기") + `FilterBar`]. **프리뷰 레이아웃**: 프리뷰 탭은 고정 분할·v-splitter 없이 **상단 크롬(툴바+필터)만 내용 높이, ResultsPane이 나머지를 가득**(`.ws-pane.preview-mode`). 조회/중지·필터 비우기·LIMIT·SQL 편집기로 열기는 **툴바 한 줄**로. **필터 바**(온디맨드 행 `[체크박스] 컬럼 | 조건 | 값 | 상태칩 | −`, AND): 0필터면 렌더 없음(결과가 위로 가득). **행 추가는 그리드 컬럼 우클릭 "필터 추가"/셀 "이 값으로 필터"로만 = 위쪽에 한 칸씩 prepend**(별도 ＋ 버튼 없음). 조건 8종(라벨은 부등호/영어: `=`/`≠`/`>`/`<`/`contains`/`not contains`/`starts with`/`ends with`; op 키 eq/ne/gt/lt/contains/ncontains/starts/ends는 불변). 그리드 헤더 **우클릭 "필터 추가"** / 셀 **"이 값으로 필터"**(`ResultsPane.onAddFilter`, 프리뷰 탭에만)로도 행 생성(값 프리필). **체크박스 off=그 조건 보존한 채 WHERE 제외**(`PreviewFilter.enabled`, `buildPreviewSql`이 skip). **행별 상태칩**(`FilterBar`, `PreviewSpec.appliedFilters` 스냅샷에서 파생 → 거짓 표시 없음): `✓ 적용됨`(틸 `--accent`, 마지막 조회에 실제 포함)·`● 대기`(앰버, 클릭=조회)·`꺼짐`·`값 입력`. 필터 하단 **푸터**(요약 `필터 N · 적용 M · 대기 K` + `필터 비우기`(`clearPreviewFilters`) + `조회`[변경대기 ●]/중지 — 조회/중지는 preview 툴바에서 이 푸터로 이동, 앱 전체 조회 버튼은 1개). **적용 = 명시 "조회"**(값 Enter/⌘↵/대기칩 클릭) — 값 편집·체크·행 추가/삭제는 **서버 0**, 자동/디바운스 **없음**, 변경 대기 `●`(현재 필터/LIMIT SQL ≠ 마지막 실행 SQL). 이미지(TablePlus 스타일) 인터랙션 채택, 전 컬럼 자동나열·행별 개별쿼리·하단 Export/SQL·단축키 레전드는 과설계로 제외(사용자 확정: 온디맨드·틸). **LIMIT** 100/500/1000/5000/10000(=페이지 크기, 바꾸면 즉시 page 0 재조회). **페이지네이션(프리뷰 한정)**: 결과 하단 `.transport`에 `◀ 페이지 N ▶ · a–b행 · 정렬 col ▲`(`ResultsPane.pager`). **정렬 기반·정확**(#40의 "OFFSET 없음"은 *사용자 작성 SQL 결과*엔 그대로 유지, 프리뷰는 우리가 SQL을 생성하므로 예외): 페이지는 `… ORDER BY … LIMIT n OFFSET n*page`. **정렬 승격** — 프리뷰에선 그리드 헤더 클릭이 서버 ORDER BY로 승격(`ResultsPane.onServerSort`, 클라 정렬 비활성)해 page 0 리셋. `orderBy` 지정 시 `"col" dir` + 나머지 **정렬가능 컬럼 tiebreaker**(총순서 → 경계 중복/누락 없음; ROW/MAP 등 비정렬 타입 제외 `isOrderable`, 비정렬 컬럼 헤더 클릭은 no-op+토스트). **미정렬 기본**도 정렬가능 컬럼 **ordinal 총순서**(`ORDER BY 1, 2, …` — result.columns 있으면 tiebreaker 포함해 경계 정확). 단 **첫 조회**는 컬럼명을 몰라 `ORDER BY 1`(첫 컬럼)로 폴백 → 그 첫 렌더~첫 Next의 0↔1 경계만 동점에서 약하게 흔들릴 수 있음(이후 페이지는 총순서). **마지막 판정**: COUNT 없음 — 이번 페이지가 정확히 pageSize행+`OFFSET 상한 PREVIEW_OFFSET_CAP(10,000)` 이내면 "다음" 활성(상한 초과 시 "WHERE로 좁히세요"). **커밋-온-성공**: page/orderBy도 실행 성공 시에만(prod 취소·에러 시 거짓 이동 방지). Prev/Next·정렬·LIMIT는 **적용 스냅샷(appliedFilters) 기준**으로 조립(라이브 미적용 필터 안 끌어옴)·즉시 재조회(staged 아님). 페이지당 서버 왕복 1회(옵트인 라벨). `PreviewSpec.page/orderBy` 추가. **안전 변환 `lib/previewQuery.ts`(순수 함수 — 인젝션 이스케이프를 개발 중 헤드리스로 확인, 커밋된 테스트는 없음)**: `buildPreviewSql`/`buildPredicate` = `quoteIdent`(식별자) + 값 이스케이프(`'`→`''`·숫자컬럼+숫자값만 raw·`DATE`/`TIMESTAMP` 리터럴) + LIKE `%_\` 이스케이프+`ESCAPE '\'`, 비문자 컬럼 `CAST(col AS varchar) LIKE` → 인젝션 차단. **실행은 `runFresh(…, recordHistory=false)`** → history·자동학습·메인 그리드 무오염(prod 확인 다이얼로그는 공유). 프리뷰 탭은 `isDirty=false`(닫기 확인·저장 없음), 세션 복원 시 `preview` 미직렬화 → 마지막 SELECT를 담은 **SQL 스크래치로 degrade**(자동 재실행 0). 같은 테이블 재열기는 **open-or-focus**. "SQL 편집기로 열기"=컴파일 SELECT를 새 스크래치 탭으로(탈출구). **렌더러 전용**(main/ipc/preload/shared 무변경). ResultsPane 전량 재사용(정렬·복사·내보내기·에러카드·run-overlay·인스펙터).
    - **캐시**: App `browseCache`(host별, 세션 한정) → 섹션 전환·모드 스왑·재펼침 시 서버 0. **실행 `query:run(recordHistory:false)` 재사용** — history·자동학습·메인 그리드 무오염(main/ipc/preload/shared 무변경). SQL 조립·인용(`"`→`""`)·파싱은 `lib/showQueries.ts` 순수함수. 인플라이트 SHOW는 host 전환 시 requestId 가드로 무효화. **자동/폴링 없음**. Metadata 탭 = learned 코퍼스+manual+위생/CRUD(자동완성 구동), Browser = manual 큐레이트 + 서버 발견 — 역할 분리(#52 재설계, 사용자 확정 "등록됨 기본 + 찾아보기").
    - **테이블 Preview 스트리밍(현재 구현; 위 OFFSET 설계를 대체)**: 서버에는 `WHERE`/사용자가 명시한 `ORDER BY`/전체 행 `LIMIT`을 포함한 SQL을 **한 번만** 제출한다. Main process가 최초 응답과 `nextUri`를 eager 소비해 private NDJSON temp spool에 저장하고, 페이지 이동·페이지 크기 변경은 저장된 행에 대한 로컬 IPC 읽기만 수행한다(`OFFSET`·기본 `ORDER BY`·페이지별 재실행 없음). 페이지 크기(1/100/500/1000/5000/10000, 기본 500; 1행은 대형 행 복구용)와 전체 행 한도(1000/10000/50000, 기본 10000)는 독립이다. 필터 적용·전체 한도 변경·헤더 정렬만 기존 세션을 정리하고 새 스트림을 시작한다. 상태는 `starting/running/finished/cancelled/failed/row_limit/size_limit`로 구분하며 탭/창/앱 종료 시 서버 취소와 temp 정리를 best-effort로 수행한다.
  - `HostList` (연결 목록/선택/편집/삭제) — 추가는 헤더 +, 선택은 `App.selectedHostId` 갱신(에디터 툴바 드롭다운과 동기).
  - `HistoryList` (실행 기록; **클릭=에디터 로드, 더블클릭=재실행**, 삭제된 host는 표시만)
  - `SavedPanel` (폴더 트리; 쿼리 **클릭=로드/더블클릭=실행**·이름변경·삭제. 폴더 생성은 헤더 +)
  - `SqlEditor` (`EditorTabs` 탭 스트립 + 툴바[연결 드롭다운·**포맷**·저장·실행 · LIMIT 없으면 "LIMIT 없음" 경고칩] + CodeMirror). CodeMirror 크롬은 `lib/cmTheme.ts`로 토큰화. ⌘↵ **현재 문장 실행** / ⌘S 저장 / ⇧⌘F 포맷.
    - **문장 단위 실행(렌더러 측)**: `;`로 구분된 여러 문장 중 **커서(caret head)가 놓인 문장 하나만** 실행/기록한다(드래그 선택은 무시). `handleRun`이 `cmRef`(=`ReactCodeMirrorRef`)의 `view.state`에서 커서 문장 본문을 뽑아 `onRun(sql: string)`으로 올리고, `App.runQuery(sqlToRun)`가 그 문장으로 `runFresh`한다. → **main/ipc/history/client는 그대로**(그 문장만 재작성 없이 실행하고 `addHistory`가 저장).
    - **활성 문장 하이라이트**: `lib/cmActiveStatement.ts`(CodeMirror `StateField`)가 커서 문장 라인에 `.cm-stmt-active`(틸 워시 + 좌측 액센트 바)를 **항상** 칠해 실행 대상을 시각화.
    - **포맷**: `lib/formatSql.ts` = `sql-formatter`의 `format(sql, { language:'trino', tabWidth:2 })`(키워드 대소문자 **원본 유지**, 파싱 실패 시 원문 반환). 트랜잭션 dispatch라 undo 가능. `sql-formatter`는 렌더러 번들 대상이라 **devDependencies**.
    - 문장 분리는 `lib/sqlStatements.ts`의 토크나이저 `splitStatements`/`statementAtCursor`(문자열 `'…'`·식별자 `"…"`·`--`/`/* */` 주석 안의 `;`는 무시, `''`/`""` 이스케이프 처리) — 실행·하이라이트·인디케이터가 공유하는 순수 함수.
    - **쿼리 파라미터**(`lib/queryParams.ts` + `components/ParamBar.tsx` + `lib/cmParams.ts`, #34): SQL의 `{{name}}`을 실행 대상 문장(`runTarget.text`)에서 스캔해 에디터↔결과 사이 **인라인 파라미터 바**를 상주시킨다. 값만 바꿔 ⌘↵ 반복 실행(모달 아님). **타입은 SQL이 아니라 파라미터 바의 드롭다운에서 선택**(`PARAM_TYPES`) — **기본 `그대로(raw)`**(따옴표 없이 값 그대로 삽입 → 식별자·동적 스키마/테이블명 보간, 예 `laplacian_{{USER_ID}}`), 그 외 `문자열(text)`(`'…'`+`''`이스케이프)·`숫자(number)`(raw, 숫자 정규식)·`날짜(date)`(`DATE '…'`)·`여러 값(multi)`(`'a','b'` — 사용자가 `IN(…)` 작성). **date-range**는 `{{x.start}}`+`{{x.end}}` 접미 네이밍으로 자동 묶음(드롭다운 없이 범위 위젯, 한쪽만이면 일반 파라미터로 degrade). `{{name:type}}` 접미는 선택적 **초기 타입 힌트**(드롭다운으로 덮어쓰기 가능). **치환은 `query:run` 전 순수 렌더러**(`applyParams(sql, values, kinds)`, 서버 왕복·스키마 조회 0, main/ipc/client 무변경). 스캔은 `sqlStatements` 토크나이저와 같은 규칙으로 **문자열/식별자/주석 속 `{{…}}`를 무시**, `{{snippet:…}}`는 F26용 예약. **값+타입 선택은 `ParamSlot`(owner=savedQueryId 태그로 #42 탭 재사용 오염 방지)** — 탭 세션 + 저장쿼리는 `localStorage`(`param:<savedQueryId>`={values,types})로 프리필. 필수값(빈값·비숫자·범위역전·빈 multi) 미충족 시 실행 차단+토스트+첫 무효 필드 focus(빨강은 1회 차단 후에만). `실행될 SQL 보기`로 치환 결과 투명 노출. 컴파일된 SQL이 실행·history·(prod) 확인창에 쓰이고, 저장쿼리 본문은 템플릿 유지. 에디터의 `{{…}}`는 `.cm-param`(`--meta` 워시)로 강조.
    - **Trino 자동완성**(`lib/trinoDialect.ts` + `lib/trinoWords.ts`): `sql()` 대신 `trino`(`SQLDialect.define` 기반 `LanguageSupport`)를 주입. 실제 서버 메타데이터가 아니라 **정적 Trino 키워드/타입/함수 목록**(`trinoWords.ts` — `sql-formatter`의 Trino 데이터에서 생성, **소문자 필수** = 토크나이저 하이라이팅 조건). 커스텀 완성 소스: 키워드/타입은 대문자·함수는 소문자 라벨, 상위 빈용 함수 `boost`, 함수는 **2글자↑**부터, `.`뒤·문자열·주석에서 억제, **자동 괄호 없음**(`current_date` 등 무괄호 함수 때문). 팝업 스타일·타입색 아이콘·틸 매칭 강조는 `cmTheme.ts`. 목록 재생성은 `scratchpad/gen-trino-words.mjs` 참고(출처 커밋 고정). **테이블/컬럼은 완성되지 않음**(범위 밖).
  - `EditorTabs` (멀티 탭 스트립 + 새 탭 `+`), `CloseTabDialog` (dirty 탭 닫기 3버튼 확인).
  - `ResultsPane` (서브탭 **Results/Messages** + **타입 인지 그리드**[숫자 우정렬·타입 라벨·NULL·헤더/행번호 sticky] + **계기판 푸터**[rows · time · scan · bytes]). 그리드는 **`@tanstack/react-virtual` 가상 스크롤**(div 기반, 열 너비는 상위 300행 샘플로 미리 고정, `scrollMargin=HEAD_H`로 sticky 헤더 보정) — 받은 행 **전체**를 스크롤로 본다(DOM에는 보이는 ~30행만). 서버 페이저 없음.
    - **결과 활용**(배치1): **정렬**(헤더 클릭 = 현재 페이지 클라이언트 정렬 asc→desc→해제, 타입 인지·NULL은 끝, `displayRows` useMemo), **복사**(셀 클릭 선택+⌘C, 우클릭 값/행/열 복사, 툴바 "복사"=전체 TSV → `api.copyToClipboard`), **내보내기**(툴바 "내보내기" → CSV/JSON, `api.saveTextFile`가 main `dialog.showSaveDialog`+`writeFile`), **셀 hover 툴팁**(잘린/중첩 값 전체 확인, `title`). 복사/저장은 상단 `.copy-flash` 토스트. 정렬은 페이지 이동/새 쿼리 시 초기화(시그니처 변경 시 `sort`/`sel` 리셋). 헤더 드래그(순서)와 클릭(정렬)이 공존.
    - **실행 경험**(배치2): 실행 중 `.run-overlay`(라이브 **경과 타이머**[월클럭 100ms 틱] + **진행 stats**[state·scan rows·bytes, `tab.progress`←`query:progress` 스트림] + **인라인 중지**). 에러는 `.error-card`로 **구조화 표시**(`errorInfo` = errorName 배지·errorType·`line:col`·원문). `errorInfo.line`은 재작성이 없어 항상 원본과 일치하므로 노출. 탭에 `progress`/`errorInfo` 필드 추가.
    - **컬럼 조작**: 헤더 우측 가장자리 드래그로 **너비 조정**, 헤더 본문 드래그로 **순서 변경**, 우상단 **"열" 팝오버**(체크박스+초기화)로 **숨김/표시**, 헤더 **우클릭 컨텍스트 메뉴**(`.ctx-menu`, 마우스 위치 `fixed`)의 **"열 숨김"**으로 해당 열 즉시 숨김(바깥클릭·Esc·스크롤 시 닫힘). 상태는 `colState={sig, cols:ColConfig[]}`(각 `{origIndex,width,visible}`, 배열 순서=표시 순서)로 보관. **컬럼 시그니처**(이름+타입 목록)가 같으면 유지, 바뀌면 기본값 재구성 — 그래서 **같은 쿼리의 페이지 이동(동일 시그니처) 중에는 너비/순서/숨김이 유지**되고, 다른 모양의 새 쿼리면 초기화된다. header/body 모두 `visibleCols`를 `origIndex`로 렌더해 정렬 유지.
    - **모든 쿼리는 `SAFETY_CAP`(5만 행) 안전 상한**까지만 수신 → 초과 시 `truncated`로 "SQL에 LIMIT/WHERE로 좁혀 재실행" 안내(정렬 note도 "받은 행만 정렬"로 분기). 딥 페이징은 지원하지 않는다(서버 부하 회피 — 더 보려면 사용자가 SQL을 좁힌다).
    - **중지(취소) 표시(#50)**: payload `cancelled`(=`token.cancelled`)가 true면 "정상 완료 0행"과 구분되게 **그리드 상단 배너**(`⏹ 실행을 중지했습니다 — 중지 시점까지 받은 N행`) + **푸터 `⏹ 중지됨`** + **Messages 배지 `중지됨`/배너**로 노출한다. 중지 시 stats가 없을 수 있어 `finished`는 `!cancelled && (…)`로 계산(취소를 '확정'으로 오표기 방지). 중지 시점까지 받은 부분 결과는 그대로 표시된다.
  - **우측 인스펙터 사이드바(#48)**: `InspectorPanel`(`aside.inspector`) — **에디터 탭 스트립 우측 액션의 사이드바 토글 버튼**(`IconPanelRight`, 분할 토글 옆)이나 **⌘⌥B**로 열고 닫는다(상시 레일 없음). 패널 상단 탭(Details/Assistant, 각 아이콘)으로 내용 선택 + 우측 닫기(×) 버튼. 너비 드래그(`.splitter` 재사용, 우측이라 방향 반전)·접기·`inspectorWidth`/`inspectorCollapsed`/`inspectorTab` **localStorage 영속**(explorer 패턴 미러, 기본 접힘). **Details**: 결과 그리드에서 **셀 클릭** 시 그 **행의 전체 필드**를 세로로(필드명 + 타입 배지 + 값 박스). 클릭 필드 강조(`.hit`), 긴 값 `pre-wrap`+`max-height:240px` 스크롤(**입력창 같은 박스**), 필드별 복사(현재 표시 텍스트), **JSON pretty**(값 박스 우상단 `Pretty`/`원문` 토글 — `valueViews`가 객체(ROW/MAP/JSON 타입)·varchar에 담긴 JSON을 모두 판정해 **정렬 가능하면 기본 ON**, 깨진 JSON은 `JSON 형식이 아니에요` 인라인 안내, 일반 varchar/숫자엔 버튼 없음), **필드 검색**(이름 부분일치), NULL 라벨, 빈 상태 4종(실행중/오류/결과없음/선택없음), 푸터 `행 #N · 받은 M행`. **Assistant**: "준비중" 안내만. **선택 모델(A2)**: ResultsPane 내부 `sel`(CellSel)은 **불변**, 선택/정렬/결과변경 시 파생 `RecordSnapshot`만 `onSelectRecord`로 emit-up → App의 `recordByPane` 맵에 pane별 저장 → Details는 **포커스 pane** 것만 렌더. 값·타입 렌더는 `lib/cellFormat.ts`(`typeClass`/`formatCell`/`prettyValue`/`buildRecordSnapshot`, ResultsPane와 공유)로 단일 출처화. 순수 렌더러(이미 받은 결과만, 서버 왕복 0). 정렬 변경 시 `toggleSort`가 이미 `setSel(null)`→emit null이라 stale 없음.
  - `StatusBar` (연결 라이브 점·이름·URL / rows·elapsed). 실행 중 점은 앰버 pulse.
  - `SaveQueryDialog` / `HostDialog` / `PromptDialog` / `ConfirmDialog` (모달). **주의: Electron은 `window.prompt` 미지원** → 이름 입력은 `PromptDialog`로. **네이티브 `window.confirm`/`alert`도 안 씀**(다크 테마와 이질적) → 삭제 확인은 `ConfirmDialog`(App의 `askConfirm(cfg)`), 경량 알림은 App **토스트**(`.app-toast`, `setToast`)로. 모든 모달은 `useEscClose` 훅 + `role="dialog"`/`aria-modal`.
    - **완성도**(배치3): 커스텀 확인/토스트, 모달 Esc·autoFocus·ARIA, StatusBar 상태점 정직화(실행중=앰버·오류=빨강·성공=초록·선택만=중립·미선택=회색)+`catalog.schema` 뱃지+"연결 선택 안 됨", `⌘1..9` 탭 전환(App 전역 keydown), 아이콘 일관화(⌫→`IconTrash`·▸▾→chevron·＋쿼리→`IconPlus`), 미저장 `●`는 탭 hover 중에도 유지, "제한하지 않음" 문구를 5만 행 상한과 정합.
  - `icons.tsx` (16px 스트로크 SVG 세트).
  - 저장 쿼리는 host와 무관 → 더블클릭 실행은 **현재 선택된 host**로.

### 디자인 시스템
- 토큰은 `styles.css` `:root`(층진 그래파이트 bg + 단일 틸 `--accent` + 절제된 앰버 신호 + 데이터 타입색). 컴포넌트는 이 CSS 변수만 쓴다.
- 폰트: UI=**Inter**, 코드/데이터/수치=**JetBrains Mono**(`@fontsource/*`, `main.tsx`에서 import해 오프라인 번들). 데이터 그리드·통계·에디터는 mono.

### IPC 계약
대부분 채널은 `ipcRenderer.invoke`(요청/응답)이고 `query:progress`와 `preview:update`는 단방향 이벤트(main→renderer)다. 쿼리/테스트는 throw 대신 `IpcResult<T>`(`{ok,value} | {ok,error,errorInfo?}`)로 실패를 표현한다(`errorInfo`는 구조화 에러).

| 채널 | 인자 → 반환 |
|------|------|
| `hosts:list` | → `HostConfig[]` |
| `hosts:save` | `HostInput` → `HostConfig` |
| `hosts:delete` | `id` → void |
| `hosts:test` | `HostInput` → `IpcResult<QueryResultPayload>` (SELECT 1) |
| `query:run` | `RunQueryRequest{hostId,sql,requestId}` → `IpcResult<QueryResultPayload>` (실행 시 자동 history 기록) |
| `query:cancel` | `requestId` → void |
| `query:progress` | **(이벤트, main→renderer `webContents.send`)** `QueryProgress{requestId,stats}`. preload `onQueryProgress(cb)`로 구독(해제 함수 반환) |
| `preview:start` | `StartPreviewRequest{sessionId,hostId,sql,maxRows}` → `IpcResult<PreviewSessionUpdate>` |
| `preview:getPage` | `GetPreviewPageRequest{sessionId,offset,limit}` → `IpcResult<PreviewPage>` (로컬 temp spool 읽기) |
| `preview:cancel` / `preview:dispose` | `sessionId` → void (호출 Renderer owner만 허용) |
| `preview:update` | **(이벤트, main→renderer `webContents.send`)** `PreviewSessionUpdate`. preload `onPreviewUpdate(cb)`로 구독 |
| `history:list` | → `HistoryEntry[]` (최신순) |
| `history:delete` | `id` → void |
| `history:clear` | → void |
| `saved:list` | → `SavedLibrary{folders,queries}` |
| `saved:createFolder` | `name` → `QueryFolder` |
| `saved:renameFolder` | `id, name` → void |
| `saved:deleteFolder` | `id` → void (쿼리 연쇄삭제) |
| `saved:createQuery` | `CreateQueryInput` → `SavedQuery` |
| `saved:updateQuery` | `UpdateQueryInput` → `SavedQuery` |
| `saved:deleteQuery` | `id` → void |
| `settings:get` | → `AppSettings` (현재 빈 설정) |
| `settings:update` | `Partial<AppSettings>` → `AppSettings` |
| `clipboard:write` | `text` → void (OS 클립보드 복사) |
| `file:saveText` | `SaveTextInput{defaultName,content}` → `SaveFileResult{saved,path?}` (저장 다이얼로그) |

새 기능을 추가할 때는 보통 **4곳을 같이 고친다**: `shared/types.ts`(타입/`TrinoIdeApi`) → `main/ipc.ts`(핸들러) → `preload/index.ts`(브리지) → renderer 호출부.

### 비밀번호/보안 경계
- 비밀번호는 renderer로 **절대 내려보내지 않는다**. `HostConfig`는 `hasPassword: boolean`만 노출.
- 수정 시 `HostInput.password`가 비어 있으면 기존 암호를 유지(`main/ipc.ts`의 `resolveInput`, `store/hosts.ts`의 `saveHost`가 처리).

## Trino 클라이언트 메모 (`trino-client@0.2.x`)
- 접속: `Trino.create({ server, source, catalog, schema, auth, ssl })`. `server`는 전체 URL(`http(s)://host:port`).
- **사용자(user)는 ConnectionOptions에 없다.** `trino.query({ query, user, catalog, schema })`의 Query 객체로 넘긴다(`X-Trino-User`).
- 비밀번호 있으면 `new BasicAuth(user, password)` (실서버는 보통 https 필요).
- self-signed https는 `ssl: { rejectUnauthorized: false }` (host의 `insecure` 토글).
- `trino.query()`는 async iterator를 반환하고, 각 `QueryResult` 페이지에 `columns?/data?/stats?/error?/id`가 들어온다. `data`는 `any[][]`.

## 빌드 도구 제약 (버전 충돌 주의)
- **vite 7 + `@vitejs/plugin-react` 5**로 고정돼 있다. `@vitejs/plugin-react@6`은 vite 8을 요구하지만 `electron-vite@5`는 vite ≤7만 지원 → 올리지 말 것.
- `tsconfig`에 `baseUrl`을 쓰지 않는다(TS 6에서 deprecated). path alias(`@shared/*`,`@renderer/*`)는 `moduleResolution: bundler`로 baseUrl 없이 동작.
- `trino-client`는 반드시 `dependencies`에 둔다. electron-vite의 `externalizeDepsPlugin`이 main 번들에서 제외하므로 런타임에 `node_modules`에서 require된다(렌더러 의존성 react/codemirror는 번들되므로 devDependencies).

## 패키징 (electron-builder)
- 설정은 `electron-builder.yml`. 현재 **macOS arm64** 타겟(`dmg` + `zip`), `identity: null`(서명 없이 ad-hoc), 산출물은 `release/`.
- 프로덕션 `dependencies`(trino-client, axios)는 electron-builder가 자동으로 asar에 포함한다 — 그래서 `trino-client`를 devDependencies로 옮기면 패키징 앱에서 쿼리가 깨진다.
- 다른 OS/아키텍처(intel x64, Windows, Linux)는 `electron-builder.yml`의 `mac.target.arch`/`win`/`linux`를 추가. 단 Windows .exe는 macOS 크로스 빌드가 제한적이라 해당 OS에서 빌드 권장.
- 앱 아이콘 미설정(기본 Electron 아이콘). 커스텀 아이콘은 `build/icon.icns` 추가.

## 개발 워크플로 (git worktree)
기능/이슈 작업은 **`.worktree/` 아래 격리된 git worktree + 전용 브랜치**에서 한다(메인 워킹트리의 `main`은 깨끗하게 유지). 워크트리 루트 `.worktree/`는 **`.gitignore`에 등록**돼 레포에 커밋되지 않는다.

- **새 작업 시작**:
  ```bash
  git worktree add .worktree/<작업명> -b feat/<이슈번호>-<키워드> main
  # 워크트리는 node_modules를 공유하지 않으므로 루트 것을 심링크로 연결
  ln -s ../../node_modules .worktree/<작업명>/node_modules
  ```
  심링크로 electron 바이너리·의존성을 공유하므로, 그 디렉터리에서 `npm run dev`/`typecheck`/`build`가 그대로 동작한다(별도 `npm install` 불필요).
- **브랜치 네이밍**: `feat/<이슈번호>-<키워드>` (예: `feat/14-metadata-store`). 커밋은 기존 conventional 스타일(`feat(scope): …`) 유지.
- **작업 종료/머지 후 정리**:
  ```bash
  git worktree remove .worktree/<작업명>
  git branch -d feat/<...>            # 머지됐으면
  ```
- 예: 에픽 #13(메타데이터 자동완성)은 `.worktree/metadata-store`(`feat/14-metadata-store`)에서 작업.

## 이슈 트래킹 / 기능 계획 워크플로
새 기능/큰 변경은 **GitHub 이슈로 등록**한다. 저장소 `Piat0046/trino-ide`(issues 활성).

- **구조: 에픽 이슈 + 네이티브 하위이슈(sub-issues) + 마일스톤(Phase).** 에픽(부모) 1개에 sub-issue를 연결하면 진행률이 자동 집계된다. Phase 구분은 각 하위 이슈에 마일스톤(`Phase 1`/`Phase 2` …)을 부여해 이중으로 얻는다.
- 보통 흐름: **UI/UX 등 전문가 에이전트에게 구현 방안을 물어 종합 → 사용자와 핵심 결정 확정 → 에픽+하위이슈로 등록 → Phase 1부터 구현, 완료 시 해당 이슈 close.**
- **인증 제약(확인됨)**: gh 토큰 스코프는 `repo`,`read:org`,`gist`. **`repo`로 sub-issues·milestones 모두 됨.** 단 **GitHub Projects는 `project` 스코프가 없어 불가** → 필요 시 `gh auth refresh -s project`(브라우저) 선행. Projects는 이 프로젝트 규모엔 과함(에픽+하위이슈로 충분).
- **gh 레시피**(하위이슈 API는 `gh issue`에 없어 `gh api` 사용):
  ```bash
  # 마일스톤: gh api repos/OWNER/REPO/milestones -f title="Phase 1 — …"
  # 에픽/이슈: gh issue create -R OWNER/REPO --title "[Epic] …" --body "…"
  # 하위이슈 생성+마일스톤: gh issue create … --milestone "Phase 1 — …"
  # 에픽에 연결: gh api repos/OWNER/REPO/issues/<EPIC_NUM>/sub_issues -F sub_issue_id=<CHILD_ID>
  #   ⚠ sub_issue_id 는 이슈 '번호'가 아니라 REST id(큰 정수): gh api repos/OWNER/REPO/issues/<num> --jq .id
  ```
- 예시: 에픽 #1 "세로 2분할 워크스페이스(split view)" + Phase 1(#2–#8)/Phase 2(#9–#12) 하위이슈로 등록됨.

## 알려진 미구현/개선 여지
- 결과 그리드는 가상 스크롤이 없어 `ResultPanel`의 `DISPLAY_LIMIT`(2,000행)까지만 그린다. 대용량은 가상화 도입 필요.
- 코드 서명/공증(notarization) 미설정 — 외부 배포 시 필요.
- 테스트 프레임워크 미도입.
