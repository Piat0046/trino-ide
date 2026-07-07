import { StateField, RangeSetBuilder, type Extension, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { paramRanges } from './queryParams'

// SQL 안의 {{param}} 토큰에 배경 하이라이트(.cm-param)를 칠하는 확장(#34).
// 파라미터 문법의 발견성을 높인다 — 문자열/주석/snippet 속 토큰은 paramRanges가 제외.

const paramMark = Decoration.mark({ class: 'cm-param' })

function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc
  if (doc.length === 0) return Decoration.none
  const ranges = paramRanges(doc.toString())
  if (ranges.length === 0) return Decoration.none
  const builder = new RangeSetBuilder<Decoration>()
  for (const r of ranges) builder.add(r.from, r.to, paramMark)
  return builder.finish()
}

const paramField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update(value, tr) {
    if (tr.docChanged) return buildDecorations(tr.state)
    return value
  },
  provide: (f) => EditorView.decorations.from(f)
})

export const paramHighlight: Extension = paramField
