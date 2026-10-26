import { useEffect } from 'react'

/** The one modal shell of Estrategias: dark backdrop, Escape and an outside click close it. */
export default function ModalFrame({
  label,
  onClose,
  wide = false,
  xwide = false,
  children,
}: {
  label: string
  onClose: () => void
  wide?: boolean
  /** Aún más ancho: pantallas con una grilla al lado de un detalle. */
  xwide?: boolean
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
      className="fixed inset-0 z-50 grid place-items-center bg-modal-overlay p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={`grid max-h-dialog gap-3 overflow-auto rounded-lg border border-solid border-line bg-surface-1 p-4.5 text-ink modal-copy:m-0! modal-h2:text-brand-compact modal-h2:leading-normal modal-h3:text-label modal-h3:leading-normal modal-h3:tracking-section modal-h3:text-ink-2 modal-h3:uppercase modal-dl:m-0 modal-dl:grid modal-dl:grid-cols-modal-facts modal-dl:gap-x-3.5 modal-dl:gap-y-1 modal-dl:text-note modal-dl:leading-normal modal-dt:text-ink-2 modal-dd:m-0 modal-dd:wrap-anywhere modal-ul:m-0 modal-ul:grid modal-ul:gap-1 modal-ul:pl-4.5 modal-ul:text-note modal-ul:leading-normal modal-pre:m-0 modal-pre:max-h-65 modal-pre:overflow-auto modal-pre:rounded-panel modal-pre:border modal-pre:border-solid modal-pre:border-line modal-pre:bg-canvas modal-pre:p-2.5 modal-pre:font-brand-mono modal-pre:text-hint modal-pre:leading-normal ${xwide ? 'w-modal-xwide' : wide ? 'w-modal-wide' : 'w-modal'}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  )
}
