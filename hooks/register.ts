// Between-tasks compaction for the main session.
//
// Compaction only runs between turns, so the model's `compact` tool schedules
// it: when the turn ends, `/compact` runs with the model's instructions and
// its next steps come back as a prompt, so work resumes without the user.
// Once the context reaches each of MARKS, a share of the size at which
// auto-compaction runs, one tool result carries a reminder that it is near.
import type { EngineInterface, Register, ModelUsage } from 'claude-code'

type $ = EngineInterface

const TOOL = 'mcp__task-compact__compact'
const MARKS = [0.7, 0.9]

type Request = { instructions: string; next_steps?: string }

// What the model scheduled this turn.
let pending: Request | undefined
// The main conversation's size as of its last model response.
let tokens = 0
// The size at which auto-compaction runs, as of the main session's last turn; undefined while it is off.
let threshold: number | undefined
// How many MARKS the model has been reminded of since the conversation was last below them.
let reminded = 0

const size = (u: ModelUsage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens

const crossed = () => MARKS.filter(m => tokens >= m * (threshold ?? Infinity)).length

const k = (n: number) => `${Math.round(n / 1000)}k`

function reminder(n: number) {
  return n === 1
    ? `Context is at ${k(tokens)} tokens; auto-compaction runs at ${k(threshold!)} and would interrupt your work. Finish the chunk of work you are on; at the next task boundary call ${TOOL} with instructions (what the summary must keep) and next_steps (what to do afterwards), then end your turn. You will resume automatically.`
    : `Context is at ${k(tokens)} tokens; auto-compaction is close. Wrap up the current step and call ${TOOL} now.`
}

async function compact($: $, r: Request) {
  await $.command.run({ command: 'compact', args: r.instructions })
  if (r.next_steps) {
    await $.prompt.submit({ text: `Context was compacted between tasks, as you scheduled. Continue with your next steps:\n\n${r.next_steps}` })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'compact',
      description:
        'Main session only. Compacts the conversation at a task boundary instead of letting auto-compaction interrupt work. Call it when told that context is nearing auto-compaction, after finishing the current chunk of work, then end your turn at once: compaction runs when the turn ends, and next_steps comes back to you as a prompt so you continue on your own.',
      inputSchema: {
        type: 'object',
        properties: {
          instructions: {
            type: 'string',
            description: 'What the summary must keep: the goal, decisions made, files touched and their state, open problems, the plan.',
          },
          next_steps: {
            type: 'string',
            description: 'What to do right after compaction, written to yourself. Leave it out only when all requested work is done.',
          },
        },
        required: ['instructions'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId === undefined && r.usage) {
      // Read once a turn: a model or settings change between turns moves it.
      if (e.index === 0) threshold = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.autoCompactThreshold
      tokens = size(r.usage)
      reminded = Math.min(reminded, crossed())
    }
    return r
  })

  on('tool.call', { tool: TOOL }, ($, e) => {
    if (e.agentId !== undefined) return { deny: 'Only the main session can use this tool.' }
    const r = e as unknown as Request
    pending = { instructions: r.instructions, next_steps: r.next_steps }
    return {
      result: `Compaction scheduled for when this turn ends. End your turn now with one short line and no more tool calls. ${
        r.next_steps
          ? 'Do not start on your next steps yet: they come back to you as a prompt right after compaction.'
          : 'Without next_steps, the user continues afterwards.'
      }`,
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || e.tool === TOOL) return next(e)
    const r = await next(e)
    const n = crossed()
    if (n <= reminded || r.deny !== undefined) return r
    reminded = n
    return { ...r, context: [...(r.context ?? []), reminder(n)] }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || !pending) return r
    const scheduled = pending
    pending = undefined
    if (e.isAborted) {
      $.ui.toast('Scheduled compaction cancelled: the turn was interrupted.')
    } else {
      // From a timer, not this hook: the turn waits on its hooks, and /compact queues until the session is idle.
      $.clock.after(0, () => void compact($, scheduled).catch(err => $.ui.toast(`Scheduled compaction failed: ${err}`)))
    }
    return r
  })
}
