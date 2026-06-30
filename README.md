# Trino IDE

Trino 전용 데스크톱 IDE. **Host 관리**와 **쿼리 결과 조회**에 집중한 가벼운 도구.

- Trino 서버(host) 등록/수정/삭제 + 연결 테스트
- SQL 작성·실행(⌘↵ / Ctrl+↵), 결과를 그리드로 확인
- 비밀번호는 OS 키체인(`safeStorage`)으로 암호화 저장 — 디스크에 평문으로 남지 않음

**스택:** Electron + TypeScript + React, 빌드 도구 electron-vite, Trino 통신은 [`trino-client`](https://www.npmjs.com/package/trino-client).

## 시작하기

```bash
npm install

# Electron 바이너리가 안 받아져 dev가 "Error: Electron uninstall"로 죽으면:
node node_modules/electron/install.js

npm run dev        # 개발 모드 (Electron 창 + HMR)
```

## 스크립트

| 명령 | 설명 |
|------|------|
| `npm run dev` | 개발 모드 실행 |
| `npm run build` | 프로덕션 빌드 → `out/` |
| `npm run typecheck` | main/preload + renderer 타입체크 |

## 사용법

1. 왼쪽 **Hosts** 패널의 `＋`로 Trino 서버를 등록한다(이름, 서버 URL `http://host:8080`, 사용자, 선택적으로 catalog/schema/비밀번호).
2. **연결 테스트**로 `SELECT 1`이 통과하는지 확인 후 저장.
3. host를 선택하고 SQL을 입력한 뒤 **실행 ▶**(또는 ⌘↵).
4. 아래 그리드에서 결과·통계(소요시간, 스캔 행/바이트)를 확인. 실행 중에는 **중지 ■**로 취소.

> 결과는 메모리 보호를 위해 최대 50,000행까지 받고, 화면에는 2,000행까지 표시한다(`src/main/trino/client.ts`의 `MAX_ROWS`, `src/renderer/src/components/ResultPanel.tsx`의 `DISPLAY_LIMIT`).

## 데이터 저장 위치

host 설정은 Electron `userData` 디렉터리의 `hosts.json`에 저장된다(macOS 기준 `~/Library/Application Support/trino-ide/hosts.json`). 비밀번호는 `enc:<base64>`(키체인 암호화)로만 보관된다.

## 구조

자세한 아키텍처는 [`CLAUDE.md`](./CLAUDE.md) 참고.

```
src/
  shared/types.ts   공유 타입 (IPC 계약의 단일 출처)
  main/             Electron main — Trino 접속·host 저장·IPC
  preload/          contextBridge로 window.api 노출
  renderer/         React UI (host 사이드바 · SQL 에디터 · 결과 그리드)
```
