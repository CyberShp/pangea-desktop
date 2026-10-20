import { randomUUID } from 'node:crypto'

/** Freeze the authoritative Harness admission gate before inspecting sessions. */
export async function acquirePortableUpdateAdmission(harnessUrl: string | undefined): Promise<() => Promise<void>> {
  if (!harnessUrl) throw new Error('工作台尚未就绪，无法确认任务状态，请稍后重试升级。')
  const endpoint = new URL('/api/pangea-product/update-admission', harnessUrl)
  const token = randomUUID()
  const request = async (action: 'freeze' | 'release'): Promise<void> => {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pangea-desktop-update': '1' },
      body: JSON.stringify({ action, token }), signal: AbortSignal.timeout(10_000)
    })
    if (response.status === 404) throw new Error('当前工作台运行时不支持升级任务保护，请重新启动工作台后重试。')
    const value = await response.json() as { ok?: boolean; frozen?: boolean; token?: string; error?: string; message?: string }
    if (!response.ok || value.ok !== true) throw new Error(typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : '无法确认升级任务保护状态。')
    if (action === 'freeze' && (value.frozen !== true || value.token !== token)) throw new Error('升级任务保护未确认，已取消升级。')
  }
  const release = async () => {
    let failure: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await request('release'); return } catch (error) { failure = error }
    }
    throw failure
  }
  try {
    await request('freeze')
  } catch (error) {
    // A lost response can follow a successful freeze. Release the same token;
    // never leave the workbench frozen merely because the handshake failed.
    try { await release() } catch {
      throw new Error(`${error instanceof Error ? error.message : String(error)} 任务保护解除未确认，请重新启动工作台后继续使用。`)
    }
    throw error
  }
  return release
}
