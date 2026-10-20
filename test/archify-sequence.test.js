import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../vendor/archify/bin/archify.mjs', import.meta.url))
const fixture = {
  "schema_version": 1,
  "diagram_type": "sequence",
  "meta": {
    "title": "接收处理及恢复",
    "locale": "zh-CN",
    "quality_profile": "showcase",
    "column_fit": "spread",
    "viewBox": [
      920,
      1050
    ]
  },
  "participants": [
    {
      "id": "host",
      "type": "external",
      "label": "主机"
    },
    {
      "id": "receiver",
      "type": "backend",
      "label": "连接接收侧"
    },
    {
      "id": "queue",
      "type": "messagebus",
      "label": "请求队列"
    }
  ],
  "messages": [
    {
      "id": "request",
      "from": "host",
      "to": "receiver",
      "y": 184,
      "label": "发送请求"
    },
    {
      "id": "dispatch",
      "from": "receiver",
      "to": "queue",
      "y": 332,
      "label": "提交有效请求"
    },
    {
      "id": "completed",
      "from": "queue",
      "to": "receiver",
      "y": 380,
      "label": "完成通知",
      "variant": "return"
    },
    {
      "id": "reset",
      "from": "host",
      "to": "receiver",
      "y": 492,
      "label": "接收 RST"
    },
    {
      "id": "cancel",
      "from": "receiver",
      "to": "queue",
      "y": 540,
      "label": "取消未完成请求"
    },
    {
      "id": "cleanup",
      "from": "receiver",
      "to": "receiver",
      "y": 596,
      "label": "清理连接状态"
    },
    {
      "id": "retry",
      "from": "receiver",
      "to": "queue",
      "y": 788,
      "label": "重试提交"
    },
    {
      "id": "ack",
      "from": "queue",
      "to": "receiver",
      "y": 838,
      "label": "响应",
      "variant": "return"
    }
  ],
  "fragments": [
    {
      "id": "result",
      "kind": "alt",
      "from": 240,
      "to": 650,
      "label": "接收结果",
      "operands": [
        {
          "from": 270,
          "condition": "[请求有效]"
        },
        {
          "from": 430,
          "condition": "else [收到复位]"
        }
      ]
    },
    {
      "id": "retry-loop",
      "kind": "loop",
      "from": 700,
      "to": 890,
      "label": "有界重试",
      "operands": [
        {
          "from": 728,
          "condition": "[仍允许重试；成功或耗尽则退出]"
        }
      ]
    }
  ],
  "cards": [
    {
      "title": "范围说明",
      "items": [
        "合成用例，仅验证时序排版与片段表达。"
      ],
      "dot": "cyan"
    }
  ]
}

async function render(candidate, inspect) {
  const folder = await mkdtemp(path.join(tmpdir(), 'pangea-sequence-'))
  try {
    const input = path.join(folder, 'candidate.json'), output = path.join(folder, 'diagram.html')
    await writeFile(input, JSON.stringify(candidate))
    const result = spawnSync(process.execPath, [cli, 'deliver', 'sequence', input, output, '--quality', 'showcase', '--json'], { encoding: 'utf8' })
    const receipt = JSON.parse(result.stdout)
    return await inspect({ result, receipt, html: result.status === 0 ? await readFile(output, 'utf8') : '' })
  } finally { await rm(folder, { recursive: true, force: true }) }
}

it('delivers alt/else, loop and self cleanup messages as distinct guarded fragments', async () => {
  await render(fixture, ({ result, receipt, html }) => {
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(receipt.ok).toBe(true)
    expect(html).toContain('data-fragment-kind="alt"')
    expect(html).toContain('data-fragment-kind="loop"')
    expect(html).toContain('else [收到复位]')
    expect(html).toContain('清理连接状态')
    expect(html).toMatch(/data-composition-edge-id="cleanup"[^>]+L [^ ]+ 620 L/)
  })
})

it('supports opt and escapes authored guard text without executable markup', async () => {
  const candidate = structuredClone(fixture)
  candidate.fragments[1].kind = 'opt'
  candidate.fragments[1].operands[0].condition = '[a < b & c]'
  await render(candidate, ({ result, html }) => {
    expect(result.status).toBe(0)
    expect(html).toContain('data-fragment-kind="opt"')
    expect(html).toContain('[a &lt; b &amp; c]')
  })
})

it('rejects invalid operand layouts, unsupported nesting and self messages crossing else or end', async () => {
  for (const modify of [
    c => { c.fragments[0].operands.pop() },
    c => { c.fragments[1].from = 630 },
    c => { c.fragments[0].operands[1].from = 265 },
    c => { c.messages.find(m => m.id === 'cleanup').y = 640 },
    c => { c.messages.find(m => m.id === 'cleanup').y = 418 },
  ]) {
    const candidate = structuredClone(fixture); modify(candidate)
    await render(candidate, ({ result, receipt }) => {
      expect(result.status).not.toBe(0)
      expect(receipt.ok).toBe(false)
      expect(JSON.stringify(receipt)).toMatch(/Fragment|fragment/)
    })
  }
})

it('keeps legacy sequence candidates without fragments compatible', async () => {
  const candidate = JSON.parse(await readFile(new URL('../vendor/archify/examples/cache-miss-request.sequence.json', import.meta.url), 'utf8'))
  await render(candidate, ({ result, receipt }) => {
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(receipt.ok).toBe(true)
  })
})
