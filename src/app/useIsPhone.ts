import { useEffect, useState } from 'react'

const QUERY = '(max-width: 600px)'

const read = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(QUERY).matches

/** True on a phone-sized screen: the Terminal then paints its own mobile view. Desktop never changes. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(read)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(QUERY)
    const onChange = () => setPhone(list.matches)
    onChange()
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [])
  return phone
}
