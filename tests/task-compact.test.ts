import type { On, SessionContextBreakdown } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

const TOOL = 'mcp__task-compact__compact'

type $ = Engine
type World = { context: number; threshold?: number; commands: string[]; prompts: string[]; toasts: string[] }

/**
 * The engine beneath the plugin: each model response reports `context` tokens, auto-compaction runs at `threshold`
 * (off where undefined); compactions, prompts and toasts are recorded.
 */
function world(on: On): World {
  const w: World = { context: 0, threshold: 1_000_000, commands: [], prompts: [], toasts: [] }
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000, breakdown: { autoCompactThreshold: w.threshold } as SessionContextBreakdown },
      rateLimits: [],
    },
  }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__task-compact__${e.name}` } }))
  on('tool.call', () => ({ result: 'ran' }))
  on('turn.step', async function* ($, e) {
    const usage = { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: w.context - 1, cache_creation_input_tokens: 0, model: 'm' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.run', ($, e) => {
    w.commands.push(`/${e.command} ${e.args}`)
    return { text: '' }
  })
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  return w
}

/** One model response of the turn, reporting `context` tokens. */
async function step($: $, w: World, context: number, agentId?: string) {
  w.context = context
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })
  for await (const _ of stream);
}

const endTurn = ($: $, isAborted = false) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted, turnId: 't1', reason: isAborted ? 'aborted' : 'answer' })

const schedule = ($: $, next_steps?: string) =>
  $.tool.call({ tool: TOOL, instructions: 'keep the plan', ...(next_steps ? { next_steps } : {}) })

test('the session registers the compact tool in the prompt tool list', async ($, on) => {
  const specs: unknown[] = []
  on('tool.register', ($, e) => {
    specs.push(e)
    return { value: { tool: TOOL } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(specs).toEqual([expect.objectContaining({ name: 'compact', isDeferred: false })])
})

test('a scheduled compaction runs /compact with the instructions once the turn ends, then resumes with the next steps', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const r = await schedule($, 'write the tests')
  expect(r.deny ?? r.isError).toBeUndefined()

  await clock.settle()
  expect(w.commands).toEqual([])

  await endTurn($)
  await clock.settle()
  expect(w.commands).toEqual(['/compact keep the plan'])
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('write the tests')
})

test('without next steps the session compacts and then waits for the user', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await schedule($)
  await endTurn($)
  await clock.settle()
  expect(w.commands).toEqual(['/compact keep the plan'])
  expect(w.prompts).toEqual([])
})

test('tool calls still run while a compaction is scheduled, so a blocked stop can be fixed first', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await schedule($, 'next')
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.deny).toBeUndefined()
  await endTurn($)
  await clock.settle()
  expect(w.commands).toEqual(['/compact keep the plan'])
})

test('an interrupted turn cancels the scheduled compaction', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  await schedule($, 'next')
  await endTurn($, true)
  await clock.settle()
  expect(w.commands).toEqual([])
  expect(w.toasts).toHaveLength(1)
})

test('a subagent cannot schedule a compaction, and its turns end without one', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)
  const r = await $.tool.call({ tool: TOOL, instructions: 'x', agentId: 'a1' })
  expect(r.deny).toBeDefined()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'a1' })
  await clock.settle()
  expect(w.commands).toEqual([])
})

const reminders = async ($: $) => (await $.tool.call({ tool: 'Bash', command: 'ls' })).context ?? []

test('tool results carry one reminder at 70% and one at 90% of the auto-compaction point, again after the context shrinks', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  w.threshold = 200_000

  await step($, w, 139_000)
  expect(await reminders($)).toEqual([])

  await step($, w, 150_000)
  const [first] = await reminders($)
  expect(first).toContain('150k')
  expect(first).toContain('200k')
  expect(first).toContain(TOOL)
  expect(await reminders($)).toEqual([])

  await step($, w, 185_000)
  expect(await reminders($)).toHaveLength(1)
  expect(await reminders($)).toEqual([])

  await step($, w, 20_000) // compacted
  await step($, w, 145_000)
  expect(await reminders($)).toHaveLength(1)
})

test('the auto-compaction point is read again each turn, so a switch to a smaller model reminds at once', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 150_000)
  expect(await reminders($)).toEqual([])

  w.threshold = 200_000
  await step($, w, 150_000)
  expect(await reminders($)).toHaveLength(1)
})

test('with auto-compaction off nothing reminds', async ($, on) => {
  mock.clock(on)
  const w = world(on)
  w.threshold = undefined
  await step($, w, 950_000)
  expect(await reminders($)).toEqual([])
})

test("a subagent's context size neither reminds the main session nor the subagent", async ($, on) => {
  mock.clock(on)
  const w = world(on)
  await step($, w, 950_000, 'a1')
  expect(await reminders($)).toEqual([])
  expect((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })).context ?? []).toEqual([])
})
