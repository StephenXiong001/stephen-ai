# dsh-task-mode-switch

**Switch a DeepSeek Harness task's Agent preset (mode) from the composer, including a task that has already started, plus AUTO, which picks one from the task text.**

在 DeepSeek Harness 输入框工具栏切换任务的 Agent 模式（预设），**包括已经在进行中的旧任务**；另有 AUTO 按任务内容自动选择。

## Install / 安装

```sh
dsh plugin --profile desktop add dsh-task-mode-switch   # DSH Desktop
dsh plugin --profile web add dsh-task-mode-switch       # dsh web
```

From this repository (before the npm release):

```sh
dsh plugin --profile desktop add "git+https://github.com/StephenXiong001/stephen-ai.git#main&path:/dsh-task-mode-switch"   # DSH Desktop
dsh plugin --profile web add "git+https://github.com/StephenXiong001/stephen-ai.git#main&path:/dsh-task-mode-switch"       # dsh web
```

Restart DSH, then open the **+** / tool row at the left of the composer: a mode control sits beside the permission and plan controls.

## What you get / 功能

| 选择 | preset | 说明 |
|---|---|---|
| 标准模式 / Standard | `standard` | Everyday tasks: files, commands, search, subagents |
| PTC 模式 / PTC | `ptc` | Batches tool calls; bulk filtering, dedupe, aggregation |
| 极简模式 / Minimal | `minimal` | Smallest tool set, for comparisons and baselines |
| 创造模式 / Creator | `cordis` | Extends DSH: plugins, presets, skills |
| AUTO | — | Picks one of the above from the composer draft (keyword heuristic, local, no model call) |

Clicking a mode **switches the task you are looking at**, not just the default for new tasks. A separate menu row (「新任务默认模式 ▸」/ “Default for new tasks”) writes the default for tasks created later, so the two actions can never be confused. While a turn is running the control refuses with an explanation; it never re-binds a composition mid-step.

The same switch is available as a slash command:

```
/mode            # report the current preset and what can be switched to
/mode ptc        # switch this task
```

## How it works / 实现要点

1. **Composition.** The shipped `agentPresets.select` Remote refuses a started session (`agent-preset/locked`). This bundle's Host half re-composes one through the registry's own `recompose()` entry (whose contract says *“the caller owns the blank-session check”*) and therefore takes that responsibility itself: refuse while running, re-bind through the registry (never by touching scope internals, so `tools/change` is announced), then append `agent-preset/selected` to the Session log, because a model-visible change must be logged.
2. **Request series.** Tool declarations are projected from the Session's recorded request series; a tool missing from it is announced as a *deferred* addition. A preset switch replaces the whole catalog, so every tool would be deferred, and providers reject a request whose tools are all deferred (“at least one tool must have defer_loading=false”). The plugin asks for a **request-series restart** on the first admitted step after a switch, via the documented `agent/pre-step` waterfall and `PreStepDecision.startsRequestSeries`, the same field the shipped goal-round driver sets.
3. **UI.** One registration into `conversation.input.left`, using the baseline `@deepseek-ai/dsh-client-ui-primitives` `Menu` (ported popup) and theme tokens; no DOM of other plugins is touched, and no model-facing tool is registered (choosing a mode is a user-owned decision).

## Caveats / 代价与限制

- Switching mid-task changes the tool catalog and prompt sections of that task; the **next request restarts its request series**, so that turn's KV cache is rebuilt from scratch. Earlier turns keep the tools they ran with.
- The switch relies on a public registry entry whose caller owns the blank-session guard. That is a deliberate, documented bypass of the “live composition stays stable” policy; it is what makes a mid-task switch possible at all.
- AUTO is a keyword heuristic over the draft. It never calls a model, and only ever picks a mode when at least one *strong* keyword matches; otherwise it keeps the current mode.
- Verified on DSH `0.2.2-rc.1` (Windows desktop). A deployment without the Agent-preset registry has nothing to switch, and the control says so.

## Verification / 验证状态

- Bundle installs and activates (`application: applied`, no warnings); the Host row and the Client slot registration are both observable.
- `/mode` verified end to end on real sessions: switching an **already started, idle** task changes the composition and the session projection; switching a **running** task is refused and leaves the preset unchanged; a refusal's reason is surfaced verbatim.
- The series-restart request verified at the `agent/pre-step` decision level (`startsRequestSeries: true`, consumed exactly once).
- AUTO classifier: 10/10 offline cases (Chinese and English, bulk-processing, baseline-comparison, weak-keyword no-op, too-short drafts).
- Not verified by automation: the rendered control, its menu, and a human click — that needs a browser.

## License

MIT. See [LICENSE](./LICENSE).
