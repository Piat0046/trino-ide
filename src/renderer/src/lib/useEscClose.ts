import { useEffect } from 'react'

/** Esc 키로 닫기. 모달 컴포넌트에서 onClose와 함께 사용. */
export function useEscClose(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
}
