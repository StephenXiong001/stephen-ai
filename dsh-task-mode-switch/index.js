/**
 * Host half of the mode-switch bundle.
 *
 * Registers the `/mode` human command, which switches THIS task's Agent preset —
 * including a task that has already started its first turn.
 *
 * Two pieces of DSH machinery have to agree for that to be safe:
 *
 * 1. Composition. The shipped `agentPresets.select` Remote deliberately refuses a
 *    started session (`agent-preset/locked`). Re-composing one is possible through
 *    the registry's own `recompose()` entry, whose contract states that "the caller
 *    owns the blank-session check". This plugin is that caller, and it takes the
 *    responsibility explicitly: it refuses while the Agent is running (so no step is
 *    ever re-bound mid-flight), it re-binds through the registry (never by touching
 *    scope internals, so `tools/change` is announced), and it appends
 *    `agent-preset/selected` afterwards, because the preset decides model-visible
 *    tools and prompts and a model-visible change must be logged.
 *
 * 2. Request series. The Agent loop projects tool declarations from the Session's
 *    recorded request series: a tool missing from that series is announced as a
 *    deferred addition (`defer_loading: true`). A preset switch replaces the whole
 *    catalog, so every tool is "new" — and a request whose tools are ALL deferred is
 *    rejected by the provider ("at least one tool must have defer_loading=false").
 *    The loop already has the answer for a prefix it cannot reuse: a request series
 *    restart. This plugin asks for exactly that on the first admitted step after a
 *    switch, through the documented `agent/pre-step` waterfall — the same field the
 *    shipped goal-round driver sets — so the new catalog becomes the series baseline
 *    instead of a pile of deferred additions.
 *
 * `/mode` with no argument reports the current preset and the available ones.
 */
export const inject = ['commands', 'agentPresets']

/** The command name; `mode` is free among the shipped commands. */
const COMMAND = 'mode'

/** Render one thrown value as a short message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Read the preset roster defensively: a deployment without the registry has none.
 * @param ctx - the plugin context carrying `agentPresets`.
 * @returns the presets that can compose a session.
 */
async function usablePresets(ctx) {
  const roster = await ctx.agentPresets.remoteExportList()
  const rows = Array.isArray(roster?.presets) ? roster.presets : []
  return rows.filter((row) => row !== null && typeof row === 'object' && typeof row.broken !== 'string')
}

/**
 * Mount the `/mode` command and the series-restart listener.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  /**
   * Sessions whose next admitted step must start a new request series: the tool
   * catalog changed under them, so the recorded series can no longer describe it.
   * Keyed by Session id, which outlives Agent re-creation.
   */
  const pendingSeries = new Set()

  // Waterfall listener: take the downstream decision first, so every other listener
  // keeps its say, and only wrap the result for a session that switched.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const agent = payload?.agent
    if (agent === undefined || agent.session === undefined) return decision
    if (decision?.kind !== 'enter') return decision
    if (!pendingSeries.has(agent.session.id)) return decision
    pendingSeries.delete(agent.session.id)
    // Spread the downstream decision so its own fields survive; the only field this
    // listener owns is the series restart it was asked for.
    return { ...decision, startsRequestSeries: true }
  })

  /**
   * Switch one live Agent to another preset.
   * @param agent - the receiving Agent (the task whose mode is being switched).
   * @param rawInput - the command's argument text: a preset id, or empty to report.
   * @returns the command result the UI renders.
   */
  async function switchPreset(agent, rawInput) {
    const requested = typeof rawInput === 'string' ? (rawInput.trim().split(/\s+/)[0] ?? '') : ''

    let presets
    try {
      presets = await usablePresets(ctx)
    } catch (error) {
      return { kind: 'error', text: `无法读取模式名册：${messageOf(error)}` }
    }
    const ids = presets.map((preset) => preset.id)
    const current = ctx.agentPresets.presetForSession(agent.session) ?? 'unknown'

    if (requested === '' || requested === 'list') {
      return {
        kind: 'success',
        text: `当前模式：${current}；可切换：${ids.length === 0 ? '（暂无可用模式）' : ids.join('、')}`,
      }
    }

    const target = presets.find((preset) => preset.id === requested)
    if (target === undefined) {
      return { kind: 'error', text: `未知模式「${requested}」；可切换：${ids.join('、')}` }
    }
    if (agent.status === 'running') {
      return { kind: 'error', text: '当前任务正在执行，等这一轮结束后再切换模式。' }
    }

    const alreadyCurrent = current === target.id && ctx.agentPresets.composedPreset(agent.ctx) === target.id
    if (alreadyCurrent) {
      // Nothing to re-compose, but the recorded request series may still describe an
      // older catalog (a switch made before this fix, or a first request that failed
      // on all-deferred tools). One series restart is the cheapest repair, so an
      // explicit click on the current mode doubles as "rebuild the tool declarations".
      pendingSeries.add(agent.session.id)
      return {
        kind: 'success',
        text: `当前任务已经是 ${target.id}；已安排在下一次请求时重建工具声明，以便修复切换后可能出现的工具目录不匹配。`,
      }
    }

    try {
      await ctx.agentPresets.recompose(agent.ctx, target.id)
    } catch (error) {
      return { kind: 'error', text: `切换到 ${target.id} 失败：${messageOf(error)}` }
    }

    try {
      agent.session.append('agent-preset/selected', { agentPreset: target.id })
    } catch (error) {
      // The composition already changed; an unlogged change would be the worse
      // outcome, so report it instead of claiming success.
      return { kind: 'error', text: `已重新组合为 ${target.id}，但记录切换事件失败：${messageOf(error)}` }
    }

    // The next admitted step restarts the request series; until then the recorded
    // series still describes the previous catalog, which is exactly what a deferred
    // announcement would be built from.
    pendingSeries.add(agent.session.id)
    return { kind: 'success', text: `已切换到 ${target.id}：工具与提示词已重新组合，下一次请求会以新模式重建工具声明。` }
  }

  ctx.commands.register({
    name: COMMAND,
    description: 'Switch this task to another agent preset, even after it has started.',
    input: { hint: '<preset id>' },
    handler: ({ agent, rawInput }) => switchPreset(agent, rawInput),
  })
}
