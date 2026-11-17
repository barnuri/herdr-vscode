// vx-status (Claude Code plugin): the Claude half of Herdr's vx-status bar.
// Inside a Herdr terminal (HC_TERMINAL_ID set) it writes the session's model, effort, context
// window and usage meters to ~/.local/state/vx-status/<terminal>.json, which the bar watches.
// It writes nothing else: no prompt or response text, no git, nothing drawn in Claude Code.
import type { EngineInterface, Register } from 'claude-code'

type Meter = { label: string; percent: number }
type Info = { model: string; effort: string | null; window: number | null; meters: Meter[]; at: number }

// `five_hour` -> 5h, `seven_day` -> 7d, anything else as its own name.
const limitLabel = (kind: string): string => {
  const k = kind.toLowerCase()
  return k.includes('five') ? '5h' : k.includes('seven') || k.includes('week') ? '7d' : k.replace(/_/g, ' ')
}

let effort: string | null = null
let target: Promise<string | null> | null = null
let last = ''

// Where to write, once per load; null outside Herdr (then this plugin does nothing at all).
function stateFile($: EngineInterface): Promise<string | null> {
  target ??= $.process
    .run(['sh', '-c', 'printf "%s\\n%s" "$HC_TERMINAL_ID" "$HOME"'])
    .then((r) => {
      const [terminal, home] = r.stdout.split('\n')
      return r.exitCode === 0 && terminal && home && /^[\w.-]+$/.test(terminal) ? `${home}/.local/state/vx-status/${terminal}.json` : null
    })
    .catch(() => null)
  return target
}

async function configuredEffort($: EngineInterface): Promise<string | null> {
  const rows = await $.config.list().catch(() => [])
  const row = rows.find((r) => /effort/i.test(r.key) || /effort/i.test(r.label))
  return row && row.value !== null && row.value !== undefined && row.value !== '' ? String(row.value) : null
}

async function report($: EngineInterface): Promise<void> {
  const file = await stateFile($)
  if (file === null) return
  const [model, usage] = await Promise.all([$.session.model(), $.session.usage()])
  const meters: Meter[] = [
    ...(usage.context.percent == null ? [] : [{ label: 'ctx', percent: usage.context.percent }]),
    ...usage.rateLimits.map((l) => ({ label: limitLabel(l.kind), percent: l.percentUsed })),
  ].map((m) => ({ ...m, percent: Math.max(0, Math.min(100, Math.round(m.percent))) }))
  const info: Omit<Info, 'at'> = {
    model,
    effort: effort ?? (await configuredEffort($)),
    window: usage.context.window || null,
    meters,
  }
  const text = JSON.stringify(info)
  if (text === last) return
  last = text
  await $.fs.write(file, JSON.stringify({ ...info, at: Date.now() })).catch(() => undefined)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await report($)
    return result
  })

  // The effort the latest model request ran at.
  on('turn.step', async function* ($, e, next) {
    if (e.effort !== undefined) effort = String(e.effort)
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await report($)
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await report($)
    return result
  })
}
