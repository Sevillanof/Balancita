import { useEffect } from 'react'
import './StrategyModals.css'

/** The one modal shell of Estrategias: dark backdrop, Escape and an outside click close it. */
export default function ModalFrame({
  label,
  onClose,
  wide = false,
  children,
}: {
  label: string
  onClose: () => void
  wide?: boolean
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="smodal__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={wide ? 'smodal smodal--wide' : 'smodal'}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  )
}
