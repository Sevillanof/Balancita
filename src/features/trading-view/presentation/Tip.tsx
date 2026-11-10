import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'

/** Width of the tooltip, in px: `w-56`. */
const TIP_W = 224
/** Room the tooltip needs below its anchor before it flips above it, in px. */
const TIP_ROOM = 120
const EDGE = 8

type Place = { left: number; top: number; above: boolean }

/**
 * A tooltip for an icon or a figure: it opens on hover or keyboard focus and
 * closes on leave, blur or Escape. It is drawn on the page (not inside the
 * card) so a frame with `overflow-hidden` never clips it, and it flips above
 * the anchor near the bottom edge. `focusable` makes the anchor itself a tab
 * stop, for anchors that are not buttons; `label` then names it.
 */
export default function Tip({
  content,
  align = 'center',
  focusable = false,
  label,
  className = '',
  children,
}: {
  content: ReactNode
  /** Which edge of the anchor the tooltip lines up with. */
  align?: 'start' | 'center' | 'end'
  focusable?: boolean
  label?: string
  className?: string
  children: ReactNode
}) {
  const anchor: Ref<HTMLSpanElement> = useRef(null)
  const id = useId()
  const [place, setPlace] = useState<Place | null>(null)
  const show = () => {
    const box = anchor.current?.getBoundingClientRect()
    if (!box) return
    const wanted =
      align === 'start'
        ? box.left
        : align === 'end'
          ? box.right - TIP_W
          : box.left + box.width / 2 - TIP_W / 2
    const left = Math.min(
      Math.max(wanted, EDGE),
      Math.max(window.innerWidth - TIP_W - EDGE, EDGE),
    )
    const above = box.bottom + TIP_ROOM > window.innerHeight
    setPlace({ left, top: above ? box.top - 6 : box.bottom + 6, above })
  }
  const open = place !== null
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPlace(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <span
      ref={anchor}
      className={`inline-flex ${focusable ? 'cursor-default focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-2' : ''} ${className}`}
      tabIndex={focusable ? 0 : undefined}
      role={focusable ? 'img' : undefined}
      aria-label={focusable ? label : undefined}
      aria-describedby={open ? id : undefined}
      onMouseEnter={show}
      onFocus={show}
      onMouseLeave={() => setPlace(null)}
      onBlur={() => setPlace(null)}
    >
      {children}
      {place &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            style={{ left: place.left, top: place.top }}
            className={`pointer-events-none fixed z-50 w-56 rounded-control border border-solid border-line-strong bg-surface-2 p-2 text-left text-label font-normal text-ink shadow-menu ${place.above ? '-translate-y-full' : ''}`}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  )
}
