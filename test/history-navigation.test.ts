import { describe, expect, it } from 'vitest'
import { installHistoryNavigationGuard } from '../src/preload/history-navigation'

describe('desktop history navigation', () => {
  for (const type of ['mousedown', 'mouseup', 'auxclick']) {
    for (const button of [3, 4]) {
      it(`cancels browser history for button ${button} on ${type}`, () => {
        const target = new EventTarget()
        installHistoryNavigationGuard(target as unknown as Window)
        const event = new Event(type, { cancelable: true })
        Object.defineProperty(event, 'button', { value: button })
        expect(target.dispatchEvent(event)).toBe(false)
        expect(event.defaultPrevented).toBe(true)
      })
    }
    for (const button of [0, 1, 2]) {
      it(`preserves button ${button} on ${type}`, () => {
        const target = new EventTarget()
        installHistoryNavigationGuard(target as unknown as Window)
        const event = new Event(type, { cancelable: true })
        Object.defineProperty(event, 'button', { value: button })
        expect(target.dispatchEvent(event)).toBe(true)
      })
    }
  }

  it('preserves workbench clicks and text editing', () => {
    const target = new EventTarget()
    installHistoryNavigationGuard(target as unknown as Window)
    for (const type of ['click', 'keydown', 'input']) {
      expect(target.dispatchEvent(new Event(type, { cancelable: true }))).toBe(true)
    }
  })
})
