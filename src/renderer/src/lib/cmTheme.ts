import { EditorView } from '@codemirror/view'

/**
 * CodeMirror 컨테이너 크롬(배경/폰트/거터/선택/커서)을 앱 토큰에 맞춘다.
 * 구문 토큰 색상은 react-codemirror의 theme="dark"가 담당하고,
 * 이 확장은 그 위에 컨테이너 스타일만 덧입힌다.
 */
export const cmTheme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'var(--text-0)', height: '100%' },
    '.cm-scroller': {
      fontFamily: 'var(--mono)',
      fontSize: '13px',
      lineHeight: '1.6',
      // 고정 높이 슬롯을 넘는 SQL을 휠로 스크롤(세로/가로). 끝에서 결과·페이지로 전파 방지.
      overflow: 'auto',
      overscrollBehavior: 'contain'
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--text-2)',
      border: 'none'
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-1)' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.025)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(52, 211, 192, 0.20)'
    },
    '.cm-selectionMatch': { backgroundColor: 'rgba(52, 211, 192, 0.12)' },
    '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0' },

    // ----- 자동완성 팝업(Trino 키워드/타입/함수) -----
    '.cm-tooltip.cm-tooltip-autocomplete': {
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--r-md)',
      backgroundColor: 'var(--bg-1)',
      boxShadow: '0 10px 28px rgba(0, 0, 0, 0.45)',
      overflow: 'hidden'
    },
    '.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--mono)',
      fontSize: '12px',
      maxHeight: '17em'
    },
    '.cm-tooltip-autocomplete > ul > li': {
      padding: '3px 8px',
      color: 'var(--text-1)'
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--accent-dim)',
      color: 'var(--text-0)'
    },
    '.cm-completionLabel': { color: 'inherit' },
    // fuzzy 매칭된 글자를 밑줄 대신 틸로 강조 → 산발적 매칭이 한눈에 보임
    '.cm-completionMatchedText': {
      color: 'var(--accent)',
      textDecoration: 'none',
      fontWeight: '600'
    },
    '.cm-completionIcon': { paddingRight: '0.55em', opacity: '0.95' },
    // 카테고리별 색: 함수=틸(동사), 타입=데이터타입색, 키워드=조용한 회색
    '.cm-completionIcon-function::after': { color: 'var(--accent)' },
    '.cm-completionIcon-type::after': { color: 'var(--t-time)' },
    '.cm-completionIcon-keyword::after': { color: 'var(--text-2)' },
    // 학습된 메타데이터(catalog/schema/table): 단일 --meta 색 + 레벨별 글리프(base 테마에 없어 content 직접 지정)
    '.cm-completionIcon-catalog::after': { content: '"▤"', color: 'var(--meta)' },
    '.cm-completionIcon-schema::after': { content: '"◇"', color: 'var(--meta)' },
    '.cm-completionIcon-table::after': { content: '"▦"', color: 'var(--meta)' },
    '.cm-completionIcon-column::after': { content: '"│"', color: 'var(--meta)' }
  },
  { dark: true }
)
