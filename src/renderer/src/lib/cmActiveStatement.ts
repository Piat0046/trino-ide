import { StateField, RangeSetBuilder, type Extension, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { splitStatements, statementAtCursor } from './sqlStatements'

// 커서(caret head)가 놓인 문장의 라인들에 배경 하이라이트를 칠하는 확장.
// 실행될 문장을 눈으로 보여준다. 드래그 선택 여부와 무관하게 head 기준 문장을 칠한다.

const activeLine = Decoration.line({ class: 'cm-stmt-active' })

function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc
  if (doc.length === 0) return Decoration.none
  const text = doc.toString()
  const stmts = splitStatements(text)
  const head = state.selection.main.head
  const active = statementAtCursor(text, head, stmts)
  if (!active || !active.text) return Decoration.none

  // 문장 본문(공백/세미콜론 제외)이 실제로 걸치는 라인만 칠한다.
  const bodyStart = text.indexOf(active.text, active.start)
  const from = bodyStart < 0 ? active.start : bodyStart
  const to = Math.min(doc.length, from + active.text.length)

  const builder = new RangeSetBuilder<Decoration>()
  const firstLine = doc.lineAt(from).number
  const lastLine = doc.lineAt(Math.max(from, to - 1)).number
  for (let ln = firstLine; ln <= lastLine; ln++) {
    builder.add(doc.line(ln).from, doc.line(ln).from, activeLine)
  }
  return builder.finish()
}

const activeStatementField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection) return buildDecorations(tr.state)
    return value
  },
  provide: (f) => EditorView.decorations.from(f)
})

export const activeStatement: Extension = activeStatementField
