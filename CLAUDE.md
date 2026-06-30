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

`npm test`는 아직 없다(테스트 미도입).

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
- `main/ipc.ts` — 모든 IPC 핸들러 등록. host 입력을 접속 정보(`ResolvedConn`)로 **복호화**하고, 실행 중 쿼리를 `requestId → {token, conn}` 맵으로 추적해 취소를 지원한다. `query:run`은 **성공/실패 모두 `history` 저장소에 자동 기록**한다.
- `main/trino/client.ts` — `trino-client`로 쿼리 실행. `runQuery()`가 `trino.query()`의 async iterator(nextUri 페이징)를 돌며 columns/data/stats를 누적. `MAX_ROWS`(50,000) 초과 시 서버 쿼리를 `cancel`하고 `truncated` 표시.
- `main/store/hosts.ts` — host 영속화. `<userData>/hosts.json` 평문 + 비밀번호만 `safeStorage`(OS 키체인)로 암호화해 `enc:<base64>`로 저장. 키체인 불가 환경은 `plain:<base64>` 폴백(난독화 수준).
- `main/store/history.ts` — 쿼리 실행 기록 영속화. `<userData>/history.json`에 **최신순**으로 저장, 최근 `MAX_HISTORY`(200)개만 유지. `addHistory`/`listHistory`/`deleteHistory`/`clearHistory`.
- `main/store/savedQueries.ts` — 저장 쿼리 라이브러리(`<userData>/saved-queries.json`). 1단계 `폴더(QueryFolder)` + 폴더 소속 `SavedQuery`. 폴더 삭제 시 안의 쿼리 **연쇄삭제**, `createQuery`는 대상 폴더가 없으면 거부.
- `preload/index.ts` — `window.api`(=`TrinoIdeApi`) 노출. `preload/index.d.ts`가 `Window.api` 전역 타입 보강.
- `renderer/src/` — React UI. `App.tsx`가 상태/오케스트레이션, 나머지는 표현 컴포넌트:
  - `Sidebar` (좌측 Hosts/History/Saved **탭** 래퍼) → `HostList` / `HistoryList` / `SavedPanel`
  - `HostList` (host 목록/선택/추가/편집/삭제)
  - `HistoryList` (실행 기록; **클릭=에디터 로드, 더블클릭=재실행**, 삭제된 host는 표시만)
  - `SavedPanel` (폴더 트리; 폴더 생성/이름변경/삭제, 쿼리 **클릭=로드/더블클릭=실행**·이름변경·삭제. 폴더/쿼리 이름은 `window.prompt`)
  - `SaveQueryDialog` (에디터 "💾 저장" → 이름 + 폴더 선택/새 폴더)
  - `HostDialog` (host 폼 + 연결 테스트)
  - `SqlEditor` (CodeMirror, ⌘↵/Ctrl+↵ 실행, 💾 저장 버튼)
  - `ResultPanel` (결과 그리드 + 통계, DOM 보호용 `DISPLAY_LIMIT` 2,000행)
  - 저장 쿼리는 host와 무관 → 더블클릭 실행은 **현재 선택된 host**로 실행한다.

### IPC 계약
모든 채널은 `ipcRenderer.invoke`(요청/응답). 쿼리/테스트는 throw 대신 `IpcResult<T>`(`{ok,value} | {ok,error}`)로 실패를 표현한다.

| 채널 | 인자 → 반환 |
|------|------|
| `hosts:list` | → `HostConfig[]` |
| `hosts:save` | `HostInput` → `HostConfig` |
| `hosts:delete` | `id` → void |
| `hosts:test` | `HostInput` → `IpcResult<QueryResultPayload>` (SELECT 1) |
| `query:run` | `RunQueryRequest{hostId,sql,requestId}` → `IpcResult<QueryResultPayload>` (실행 시 자동 history 기록) |
| `query:cancel` | `requestId` → void |
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

## 알려진 미구현/개선 여지
- 결과 그리드는 가상 스크롤이 없어 `ResultPanel`의 `DISPLAY_LIMIT`(2,000행)까지만 그린다. 대용량은 가상화 도입 필요.
- 코드 서명/공증(notarization) 미설정 — 외부 배포 시 필요.
- 테스트 프레임워크 미도입.
