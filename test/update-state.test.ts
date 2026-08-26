import { describe, expect, it } from 'vitest'
import {
  initialUpdateStatus,
  reduceUpdateStatus
} from '../src/main/update/update-state'

describe('desktop update state', () => {
  it('tracks local package verification through completion', () => {
    let status = initialUpdateStatus('1.0.0')
    status = reduceUpdateStatus(status, { type: 'check', manual: true })
    status = reduceUpdateStatus(status, { type: 'progress', percent: 52.37 })

    expect(status).toEqual({
      phase: 'downloading',
      currentVersion: '1.0.0',
      percent: 52.4,
      manual: true
    })

    status = reduceUpdateStatus(status, { type: 'downloaded', version: '1.1.0' })
    expect(status).toEqual({
      phase: 'downloaded',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      manual: true
    })
  })

  it('preserves a user-initiated package error', () => {
    let status = initialUpdateStatus('1.0.0')
    status = reduceUpdateStatus(status, { type: 'check', manual: true })
    status = reduceUpdateStatus(status, { type: 'error', message: 'invalid package' })

    expect(status.phase).toBe('error')
    expect(status.manual).toBe(true)
  })

  it('clamps invalid download percentages', () => {
    const status = {
      ...initialUpdateStatus('1.0.0'),
      availableVersion: '1.1.0'
    }

    expect(reduceUpdateStatus(status, { type: 'progress', percent: -5 }).percent).toBe(0)
    expect(reduceUpdateStatus(status, { type: 'progress', percent: 140 }).percent).toBe(100)
    expect(
      reduceUpdateStatus(status, { type: 'progress', percent: Number.NaN }).percent
    ).toBe(0)
  })

  it('keeps a verified package ready when restart is temporarily blocked', () => {
    const ready = reduceUpdateStatus(initialUpdateStatus('1.0.0'), {
      type: 'downloaded',
      version: '1.1.0'
    })
    expect(reduceUpdateStatus(ready, {
      type: 'install-error',
      message: 'analysis is still running'
    })).toMatchObject({
      phase: 'downloaded',
      availableVersion: '1.1.0',
      message: 'analysis is still running'
    })
  })
})
