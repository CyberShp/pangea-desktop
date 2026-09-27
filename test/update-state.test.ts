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

  it('keeps the selected ZIP name through validation and its result', () => {
    const selected = reduceUpdateStatus(initialUpdateStatus('1.0.4'), {
      type: 'check', manual: true, packageName: 'PANGEA-Desktop-1.0.5-win.zip'
    })
    const validating = reduceUpdateStatus(selected, { type: 'progress', percent: 43 })
    const ready = reduceUpdateStatus(validating, { type: 'downloaded', version: '1.0.5', packageType: 'full' })
    const failed = reduceUpdateStatus(validating, { type: 'error', message: 'signature invalid' })
    expect([selected, validating, ready, failed].map(status => status.packageName)).toEqual(Array(4).fill('PANGEA-Desktop-1.0.5-win.zip'))
    expect(reduceUpdateStatus(ready, { type: 'reset' }).packageName).toBeUndefined()
  })

  it('retains signed patch base and target details when the base does not match', () => {
    const status = reduceUpdateStatus(initialUpdateStatus('1.0.4'), {
      type: 'error',
      message: '此补丁仅适用于 1.0.3，当前版本为 1.0.4。',
      packageType: 'patch',
      baseVersion: '1.0.3',
      availableVersion: '1.0.5'
    })

    expect(status).toMatchObject({
      phase: 'error',
      currentVersion: '1.0.4',
      packageType: 'patch',
      baseVersion: '1.0.3',
      availableVersion: '1.0.5'
    })
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

  it('keeps the exact patch base in the verified update state', () => {
    const status = reduceUpdateStatus(initialUpdateStatus('1.0.0'), {
      type: 'downloaded',
      version: '1.0.1',
      packageType: 'patch',
      baseVersion: '1.0.0'
    })
    expect(status).toMatchObject({
      phase: 'downloaded',
      availableVersion: '1.0.1',
      packageType: 'patch',
      baseVersion: '1.0.0'
    })
  })

  it('restores a failed external update as a visible manual error', () => {
    expect(reduceUpdateStatus(initialUpdateStatus('1.0.0'), {
      type: 'restore-error',
      version: '1.1.0',
      message: 'the working version was restored'
    })).toEqual({
      phase: 'install-error',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      manual: true,
      message: 'the working version was restored'
    })
  })
})
