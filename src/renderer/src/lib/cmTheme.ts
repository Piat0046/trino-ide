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
      lineHeight: '1.6'
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
    '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0' }
  },
  { dark: true }
)
