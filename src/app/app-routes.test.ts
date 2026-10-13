import { describe, expect, it } from 'vitest'
import { appNavigation } from './app-navigation.ts'
import { sectionForPath } from './app-routes.ts'

describe('sectionForPath', () => {
  it('maps the three screens and falls back to the terminal', () => {
    expect(sectionForPath('/estrategias')).toBe('estrategias')
    expect(sectionForPath('/estrategias/')).toBe('estrategias')
    expect(sectionForPath('/observabilidad')).toBe('observabilidad')
    expect(sectionForPath('/observabilidad/')).toBe('observabilidad')
    expect(sectionForPath('/terminal')).toBe('terminal')
    expect(sectionForPath('/')).toBe('terminal')
    expect(sectionForPath('/otra-cosa')).toBe('terminal')
  })
})

describe('appNavigation', () => {
  it('marks only the current section', () => {
    const items = appNavigation('estrategias')
    expect(items.map((i) => [i.href, i.current])).toEqual([
      ['/terminal', false],
      ['/estrategias', true],
      ['/observabilidad', false],
    ])
  })
})
