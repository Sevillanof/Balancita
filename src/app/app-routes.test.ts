import { describe, expect, it } from 'vitest'
import { appNavigation } from './app-navigation.ts'
import {
  isInvestigationPath,
  isSessionPath,
  sectionForPath,
} from './app-routes.ts'

describe('sectionForPath', () => {
  it('maps the two screens and falls back to the terminal', () => {
    expect(sectionForPath('/estrategias')).toBe('estrategias')
    expect(sectionForPath('/estrategias/')).toBe('estrategias')
    expect(sectionForPath('/terminal')).toBe('terminal')
    expect(sectionForPath('/')).toBe('terminal')
    expect(sectionForPath('/otra-cosa')).toBe('terminal')
  })
})

describe('isInvestigationPath', () => {
  it('recognises only the investigation page, with or without a slash', () => {
    expect(isInvestigationPath('/investigacion')).toBe(true)
    expect(isInvestigationPath('/investigacion/')).toBe(true)
    expect(isInvestigationPath('/terminal')).toBe(false)
    expect(isInvestigationPath('/investigacion/otra')).toBe(false)
  })
  it('does not add a section nor a navigation tab', () => {
    expect(sectionForPath('/investigacion')).toBe('terminal')
    expect(appNavigation('terminal').map((i) => i.href)).toEqual([
      '/terminal',
      '/estrategias',
    ])
  })
})

describe('appNavigation', () => {
  it('marks only the current section', () => {
    const items = appNavigation('estrategias')
    expect(items.map((i) => [i.href, i.current])).toEqual([
      ['/terminal', false],
      ['/estrategias', true],
    ])
  })
})

describe('isSessionPath', () => {
  it('recognises only the session page and adds no tab', () => {
    expect(isSessionPath('/sesion')).toBe(true)
    expect(isSessionPath('/sesion/')).toBe(true)
    expect(isSessionPath('/sesion/otra')).toBe(false)
    expect(isSessionPath('/terminal')).toBe(false)
    expect(sectionForPath('/sesion')).toBe('terminal')
    expect(appNavigation('terminal').map((i) => i.href)).toEqual([
      '/terminal',
      '/estrategias',
    ])
  })
})
