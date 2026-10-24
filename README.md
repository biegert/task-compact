# task-compact

A Claude Code plugin that lets the model compact its conversation between tasks, before auto-compaction interrupts it mid-task.

Auto-compaction runs when the context fills up, wherever the work happens to be. task-compact gives the main session a `compact` tool, which the model calls after it finishes a chunk of work. When the turn ends, `/compact` runs with the model's own instructions for the summary. The model's next steps then come back as a prompt, so the work continues without you.

## Install

At the prompt of a Claude Code terminal session, run:

```
/plugin install task-compact --marketplace biegert/task-compact
```

Answer `y` to add the marketplace, then choose a scope. The plugin is active in that session right away.

From a shell, run:

```
claude plugin install task-compact --marketplace biegert/task-compact
```

In the desktop app, `/plugin` does not run. Click **+** next to the prompt box, then **Plugins**, then **Add marketplace** with `biegert/task-compact`, then **Add plugin**.

Tested with Claude Code 2.1.309.

## The compact tool

The main session gets one tool, `mcp__task-compact__compact`:

| Parameter | Required | Meaning |
| --- | --- | --- |
| `instructions` | Yes | What the summary must keep: the goal, decisions, files touched, open problems, and the plan. The plugin passes it to `/compact`. |
| `next_steps` | No | What the model does after compaction. The plugin submits it as a prompt once compaction finishes. |

- Compaction runs when the turn ends, not when the model calls the tool. Tool calls made after the model schedules a compaction still run.
- Without `next_steps`, the session compacts and then waits for you.
- If you interrupt the turn, the plugin cancels the scheduled compaction and shows a notice.
- Subagents cannot call the tool.

## Reminders before auto-compaction

When the context reaches 70% of the point where auto-compaction runs, one tool result carries a reminder to compact at the next task boundary. At 90%, a second reminder tells the model to wrap up and compact now. When the context drops below a mark, for example after a compaction, the reminder for that mark can fire again.

The plugin reads the auto-compaction point from Claude Code at the start of each turn, so the marks follow model and settings changes. With auto-compaction turned off, the plugin sends no reminders.

## Run the tests

In the repository folder, run:

```
claude plugin test .
```
