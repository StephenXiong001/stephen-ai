/**
 * Client half of the task-mode-switch bundle.
 *
 * Renders one compact control in the composer tool row (`conversation.input.left`)
 * that picks the Agent preset this task runs, plus AUTO, which picks one from the
 * task text.
 *
 * The switch itself goes through this bundle's Host `/mode` command
 * (`ctx.remote.commands.execute`), which re-composes the LIVE session through the
 * preset registry. That is what makes a mid-task switch possible at all: the
 * shipped `agentPresets.select` Remote refuses any session that already started a
 * turn (`agent-preset/locked`). Setting the mode new tasks start in stays a
 * separate, explicit action in the same menu, so it can never be confused with
 * switching the task in front of you.
 *
 * AUTO is a client-side preference (browser localStorage). While it is on and the
 * task is idle, the control classifies the composer draft with a local keyword
 * heuristic and applies the matching preset, so no send-time interception is
 * needed. The heuristic is conservative and reports which keywords matched; it
 * never calls a model.
 *
 * No model-facing tool is registered: choosing the composition is a user-owned
 * decision.
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-mode-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React
    // Baseline module of the frozen platform table (the shipped permission and
    // preset surfaces import it the same way); Menu portals its popup, so the
    // docked composer cannot clip it.
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const Menu = primitives.Menu
    const Chevron = primitives.IconChevronDownOutlineRegular

    /** Locale namespace of this control. */
    const NS = 'task-mode-switch'
    /** The settings namespace that retains `selectedDefault` for new sessions. */
    const SETTINGS_NS = 'agent-preset-registry'
    /** Marker used to install the stylesheet once and remove it on unload. */
    const STYLE_ID = 'dsh-task-mode-switch/styles'
    /** Browser-local preference for the AUTO switch. */
    const AUTO_KEY = 'dsh-task-mode-switch:auto'
    /** The AUTO roster id used by this control (never a Host preset id). */
    const AUTO_ID = 'auto'
    /** Menu id prefix of the "set as the default for new tasks" submenu rows. */
    const DEFAULT_PREFIX = 'default:'
    /** Menu id of the parent row that only opens that submenu. */
    const DEFAULT_PARENT = 'default'
    /** How long a settled note stays in the tool row. */
    const NOTE_MS = 9000
    /** Draft length below which AUTO refuses to guess. */
    const AUTO_MIN_CHARS = 4
    /** Quiet period after the last keystroke before AUTO recomposes. */
    const AUTO_DEBOUNCE_MS = 600
    /** Prefix scanned by the classifier: the opening intent carries the signal. */
    const AUTO_SAMPLE_CHARS = 2000

    /** The four Host presets this control offers, in menu order. */
    const MODES = [
      { id: 'standard', nameKey: 'm.standard.name', shortKey: 'm.standard.short', hintKey: 'm.standard.hint' },
      { id: 'ptc', nameKey: 'm.ptc.name', shortKey: 'm.ptc.short', hintKey: 'm.ptc.hint' },
      { id: 'minimal', nameKey: 'm.minimal.name', shortKey: 'm.minimal.short', hintKey: 'm.minimal.hint' },
      { id: 'cordis', nameKey: 'm.creator.name', shortKey: 'm.creator.short', hintKey: 'm.creator.hint' },
    ]
    /** The AUTO entry, which never reaches the Host as a preset id. */
    const AUTO_MODE = { id: AUTO_ID, nameKey: 'm.auto.name', shortKey: 'm.auto.short', hintKey: 'm.auto.hint' }
    /** Everything the menu lists as modes, in display order. */
    const MENU_MODES = [...MODES, AUTO_MODE]

    /**
     * Keyword rules for AUTO. A strong hit weighs 3, a weak hit 1, but a mode needs
     * at least one strong hit to be chosen; ties keep the earlier rule (creator
     * before minimal before PTC).
     */
    const CLASSIFIER = [
      {
        id: 'cordis',
        strong: ['插件', 'plugin', 'cordis', '预设', 'preset', '技能', 'skill', '自定义模式'],
        weak: ['界面', '按钮', '面板', '组件', '主题', '皮肤', '钩子', 'hook', 'mcp', '扩展', 'widget', 'component', 'button', 'panel', 'theme'],
      },
      {
        id: 'minimal',
        strong: ['最小复现', '最小改动', '基线', '基准', 'benchmark', '对照组', '极简'],
        weak: ['对照', '对比', '复现', '只改', '一行', '实验', 'baseline', 'repro', 'compare', 'comparison', 'minimal'],
      },
      {
        id: 'ptc',
        strong: ['批量', '批处理', '逐条', '逐个', '遍历', '汇总', '统计', '去重', '筛选', '清洗', '重命名', 'batch', 'bulk', 'aggregate', 'dedupe', 'iterate over', 'summarize'],
        weak: ['csv', 'excel', '表格', '数据', '正则', 'regex', '所有文件', '目录下', '脚本', '格式', '合并', '拆分', '整理', 'filter', 'rename', 'merge', 'split', 'spreadsheet', 'table', 'script'],
      },
    ]

    const CSS = `
.dms-root{display:inline-flex;align-items:center;gap:2px;min-width:0;max-width:100%;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}
.dms-root[data-busy="true"]{opacity:.7}
.dms-trigger{border-radius:var(--dsw-radius-sm,6px);min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font:inherit;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}
@media (hover:hover){.dms-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}}
.dms-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}
.dms-trigger:disabled{color:var(--dsw-alias-label-secondary);opacity:.55;cursor:default}
.dms-triggerIcon{flex:none;display:inline-flex;opacity:.8}
.dms-triggerIcon svg{width:14px;height:14px}
.dms-triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.dms-chevron{color:var(--dsw-alias-label-secondary);flex:none;transition:transform .12s;display:inline-flex;opacity:.7}
.dms-chevronOpen{transform:rotate(180deg)}
.dms-item{display:flex;flex-direction:column;gap:1px;min-width:0;text-align:left}
.dms-itemName{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dms-itemHint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;white-space:normal}
.dms-note{display:inline-flex;align-items:center;min-width:0;max-width:200px;margin-left:2px;padding:0 8px;color:var(--dsw-alias-label-secondary);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dms-note[data-kind="ok"]{color:var(--dsw-alias-state-success-primary)}
.dms-note[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}
.dms-select{appearance:none;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm,6px);height:26px;font:inherit;font-size:12px;padding:0 6px;outline:none}
`

    const DICT = {
      en: {
        'group.aria': 'Agent mode',
        'menu.label': 'Choose the agent mode',
        'trigger.title': 'Agent mode: {name}',
        'trigger.titleAuto': 'AUTO picks the mode from the task text',
        'trigger.hintSwitch': 'Switching mode re-composes this task\u2019s tools and prompt sections.',
        'trigger.hintRunning': 'This task is running; switch the mode once the turn ends.',
        'm.standard.name': 'Standard mode',
        'm.standard.short': 'Standard',
        'm.standard.hint': 'Everyday tasks: files, commands, search, subagents',
        'm.ptc.name': 'PTC mode',
        'm.ptc.short': 'PTC',
        'm.ptc.hint': 'Batches tool calls; best for bulk filtering, dedupe and aggregation',
        'm.minimal.name': 'Minimal mode',
        'm.minimal.short': 'Minimal',
        'm.minimal.hint': 'Smallest tool set, for comparisons and baselines',
        'm.creator.name': 'Creator mode',
        'm.creator.short': 'Creator',
        'm.creator.hint': 'Extends DSH: plugins, presets and skills',
        'm.auto.name': 'AUTO',
        'm.auto.short': 'AUTO',
        'm.auto.hint': 'Picks a mode from the task text (keyword heuristic)',
        'default.name': 'Default for new tasks',
        'default.hint': 'Currently {name}',
        'default.set': 'Set {name} as the default for new tasks',
        'note.switched': 'Switched to {name}',
        'note.switchedTitle': 'This task now runs {name}; its tools and prompt sections were re-composed.',
        'note.default': 'New tasks now start in {name}',
        'note.defaultTitle': '{name} is now the default for tasks created later. This task is unchanged.',
        'note.autoApplied': 'AUTO → {name}',
        'note.autoAppliedTitle': 'AUTO picked {name} because the task mentions {terms}.',
        'note.autoKeep': 'AUTO keeps {name}',
        'note.autoStarted': 'AUTO is on',
        'note.autoStartedTitle': 'AUTO is on. The mode follows the task text while this task is idle.',
        'note.autoWaiting': 'AUTO is on — type the task to pick a mode',
        'note.autoWaitingTitle': 'AUTO is on. Write at least a few words; the mode is picked from the task text.',
        'note.currentUnknown': 'its current mode',
        'auto.reason': 'AUTO picks {name}',
        'error.noRemote': 'The agent mode service is unavailable on this page.',
        'error.noSession': 'Open a task to switch its agent mode.',
        'error.commandMissing': 'The /mode command is not registered, so this build cannot switch a started task.',
        'error.unavailable': '{name} is not available in this installation.',
        'error.failed': 'Could not switch mode: {reason}',
        'error.failedNoReason': 'the host returned no reason',
        'error.locked': 'this task already started, so its mode is fixed',
        'error.notFound': 'this mode is not part of the current configuration',
      },
      zh: {
        'group.aria': 'Agent 模式',
        'menu.label': '选择 Agent 模式',
        'trigger.title': 'Agent 模式：{name}',
        'trigger.titleAuto': 'AUTO 会按任务内容自动选择模式',
        'trigger.hintSwitch': '切换模式会重新组合本任务的工具与提示词。',
        'trigger.hintRunning': '当前任务正在执行，等这一轮结束后再切换模式。',
        'm.standard.name': '标准模式',
        'm.standard.short': '标准',
        'm.standard.hint': '日常任务：文件、命令、搜索、子代理',
        'm.ptc.name': 'PTC 模式',
        'm.ptc.short': 'PTC',
        'm.ptc.hint': '批量调用工具，适合批量筛选、去重、汇总',
        'm.minimal.name': '极简模式',
        'm.minimal.short': '极简',
        'm.minimal.hint': '最小工具集，用于对照与基线测试',
        'm.creator.name': '创造模式',
        'm.creator.short': '创造',
        'm.creator.hint': '扩展 DSH：编写插件、预设与技能',
        'm.auto.name': 'AUTO',
        'm.auto.short': 'AUTO',
        'm.auto.hint': '按任务内容自动选择模式（关键词判断）',
        'default.name': '新任务默认模式',
        'default.hint': '当前：{name}',
        'default.set': '把{name}设为新任务的默认模式',
        'note.switched': '已切换到{name}',
        'note.switchedTitle': '本任务已切换为{name}；工具与提示词已重新组合。',
        'note.default': '新任务默认：{name}',
        'note.defaultTitle': '之后新建的任务默认使用{name}；当前任务不变。',
        'note.autoApplied': 'AUTO → {name}',
        'note.autoAppliedTitle': '任务里出现了{terms}，AUTO 选择了{name}。',
        'note.autoKeep': 'AUTO 保持{name}',
        'note.autoStarted': 'AUTO 已开启',
        'note.autoStartedTitle': 'AUTO 已开启：任务空闲时按任务内容选择模式。',
        'note.autoWaiting': 'AUTO 已开启——写下任务后自动选择',
        'note.autoWaitingTitle': 'AUTO 已开启。写下几个词后，会按任务内容选择模式。',
        'note.currentUnknown': '当前模式',
        'auto.reason': 'AUTO 将选择{name}',
        'error.noRemote': '当前页面无法使用 Agent 模式服务。',
        'error.noSession': '请先打开一个任务再切换 Agent 模式。',
        'error.commandMissing': '/mode 命令未注册（Host 半侧未生效），因此无法切换已开始的任务。',
        'error.unavailable': '当前安装未提供{name}。',
        'error.failed': '切换模式失败：{reason}',
        'error.failedNoReason': '宿主未返回原因',
        'error.locked': '当前任务已开始，模式已固定',
        'error.notFound': '当前配置未提供该模式',
      },
    }

    /** Fill `{name}` placeholders in one localized pattern. */
    const format = (pattern, values) =>
      pattern.replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))

    /** Remote failure codes whose `details` carry no human text, mapped to locale keys. */
    const FAILURE_KEYS = {
      'agent-preset/locked': 'error.locked',
      'agent-preset/not-found': 'error.notFound',
    }

    /** The best available message for a failed Remote result or a thrown error. */
    const describeFailure = (error, t) => {
      if (error !== null && typeof error === 'object') {
        const key = typeof error.code === 'string' ? FAILURE_KEYS[error.code] : undefined
        if (key !== undefined) return t(key)
        const details = error.details
        if (details !== null && typeof details === 'object' && typeof details.reason === 'string' && details.reason !== '') {
          return details.reason
        }
        if (typeof error.message === 'string' && error.message !== '') return error.message
      }
      if (typeof error === 'string' && error !== '') return error
      return t('error.failedNoReason')
    }

    /** Read the roster row for one preset id. */
    const optionOf = (presets, id) =>
      presets.find((preset) => preset !== null && typeof preset === 'object' && preset.id === id)

    /** The mode entry for a preset id, or undefined for ids this control does not offer. */
    const modeOf = (id) => (id === undefined ? undefined : MENU_MODES.find((mode) => mode.id === id))

    /** The localized name of a mode id, preferring whatever the preset itself published. */
    const modeName = (mode, option, t) => {
      if (option !== undefined && typeof option.name === 'string' && option.name !== '') return option.name
      return mode === undefined ? '' : t(mode.nameKey)
    }

    /** Whether a roster row can compose a session. */
    const usable = (option) => option !== undefined && !(typeof option.broken === 'string' && option.broken !== '')

    /**
     * Classify a task text into one of the four presets.
     * @param text - the composer draft.
     * @returns the matched preset with its keywords, or undefined when the draft is too short or carries no strong signal.
     */
    const classifyTask = (text) => {
      const sample = typeof text === 'string' ? text.slice(0, AUTO_SAMPLE_CHARS) : ''
      if (sample.trim().length < AUTO_MIN_CHARS) return undefined
      const lower = sample.toLowerCase()
      let best
      for (const rule of CLASSIFIER) {
        const strong = rule.strong.filter((term) => lower.includes(term.toLowerCase()))
        const weak = rule.weak.filter((term) => lower.includes(term.toLowerCase()))
        // Weak keywords alone never decide a mode: without one strong hit the
        // draft keeps whatever the session already runs.
        if (strong.length === 0) continue
        const score = strong.length * 3 + weak.length
        if (best === undefined || score > best.score) best = { id: rule.id, score, terms: [...strong, ...weak].slice(0, 2) }
      }
      return best === undefined ? undefined : { id: best.id, terms: best.terms, matched: true }
    }

    const classNames = (parts) => parts.filter(Boolean).join(' ')

    /** Read the AUTO preference; storage can be unavailable in a locked-down page. */
    const readAutoPreference = () => {
      try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(AUTO_KEY) === '1'
      } catch (error) {
        return false
      }
    }

    /** Persist the AUTO preference. */
    const writeAutoPreference = (on) => {
      try {
        if (typeof localStorage === 'undefined') return
        if (on) localStorage.setItem(AUTO_KEY, '1')
        else localStorage.removeItem(AUTO_KEY)
      } catch (error) {
        /* storage denied: the switch stays session-scoped */
      }
    }

    const GLYPHS = {
      standard: h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: false },
        h('circle', { cx: 8, cy: 8, r: 5.75, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M8 2.25a5.75 5.75 0 0 1 0 11.5z', fill: 'currentColor' }),
      ),
      ptc: h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: false },
        h('path', { d: 'M5.5 3.5 2.5 8l3 4.5M10.5 3.5l3 4.5-3 4.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ),
      minimal: h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: false },
        h('circle', { cx: 8, cy: 8, r: 5.75, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M5 8h6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      ),
      cordis: h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: false },
        h('path', { d: 'M8 1.8l1.5 3.8 3.8 1.5-3.8 1.5L8 12.4 6.5 8.6 2.7 7.1l3.8-1.5z', fill: 'currentColor' }),
        h('circle', { cx: 12.4, cy: 12.4, r: 1.3, fill: 'currentColor', opacity: 0.7 }),
      ),
      auto: h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: false },
        h('path', { d: 'M8.6 1.5 3.4 8.6h3.3L6.7 14.5l5.9-7.4H9.2z', fill: 'currentColor' }),
      ),
    }

    /**
     * Build the slot component over one plugin context.
     * @param ctx - the Client plugin context (carries the `remote` facade).
     * @returns the React component registered into `conversation.input.left`.
     */
    function createModeSwitch(ctx) {
      /** The Remote facade, read lazily because namespaces mount after apply. */
      const remoteOf = () => {
        try {
          return ctx.get('remote')
        } catch (error) {
          return undefined
        }
      }

      return function ModeSwitch(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined
        const useSessions = props.useSessions
        const useInput = props.useInput

        const sessionMode = useSessions((state) => {
          const value = state === undefined ? undefined : state.byId?.[sessionId]?.projectionValues?.agentPreset
          return typeof value === 'string' && value !== '' ? value : undefined
        })
        const running = useSessions((state) => (state === undefined ? false : state.byId?.[sessionId]?.running === true))
        const draft = useInput((state) => {
          const value = state === undefined ? '' : state.draft
          return typeof value === 'string' ? value : ''
        })

        const [presets, setPresets] = useState(null)
        const [rosterError, setRosterError] = useState(null)
        const [busy, setBusy] = useState(false)
        const [note, setNote] = useState(null)
        const [pickedLive, setPickedLive] = useState(undefined)
        const [auto, setAuto] = useState(readAutoPreference)
        const [open, setOpen] = useState(false)
        const aliveRef = useRef(true)
        const busyRef = useRef(false)
        const lastAutoRef = useRef(undefined)

        useEffect(() => {
          aliveRef.current = true
          return () => {
            aliveRef.current = false
          }
        }, [])

        /** Read the live roster; a failure leaves the controls usable but unexplained. */
        async function loadRoster() {
          const remote = remoteOf()
          const roster = remote === undefined ? undefined : remote.agentPresets
          if (roster === undefined || typeof roster.list !== 'function') {
            if (aliveRef.current) setRosterError(t('error.noRemote'))
            return
          }
          try {
            const result = await roster.list()
            if (!aliveRef.current) return
            if (result !== undefined && result.ok === true) {
              setPresets(Array.isArray(result.value?.presets) ? result.value.presets : [])
              setRosterError(null)
            } else if (result !== undefined && result.error?.code === 'gateway/invocation-unavailable') {
              // The shipped surfaces read this as "no roster on this host", not
              // as a failure: the deployment composes no preset registry.
              setPresets([])
              setRosterError(null)
            } else {
              setRosterError(result === undefined ? t('error.failedNoReason') : describeFailure(result.error, t))
            }
          } catch (error) {
            if (aliveRef.current) setRosterError(describeFailure(error, t))
          }
        }

        useEffect(() => {
          loadRoster()
        }, [])

        useEffect(() => {
          if (note === null) return undefined
          const timer = window.setTimeout(() => {
            if (aliveRef.current) setNote(null)
          }, NOTE_MS)
          return () => window.clearTimeout(timer)
        }, [note])

        // Once the session projection reports the mode a switch committed, the
        // projection is authoritative again; dropping the local pick keeps a
        // later change made elsewhere (settings, the hero picker) visible.
        useEffect(() => {
          if (pickedLive !== undefined && sessionMode === pickedLive) setPickedLive(undefined)
        }, [pickedLive, sessionMode])

        const options = presets === null ? [] : presets
        const defaultOption = options.find((preset) => preset !== null && typeof preset === 'object' && preset.isDefault === true)
        const defaultId = defaultOption === undefined ? undefined : defaultOption.id
        // A switch's accepted pick wins over a projection that has not caught up
        // yet; `defaultId` answers only sessions that record no preset.
        const liveId = pickedLive ?? sessionMode ?? defaultId
        const liveMode = modeOf(liveId)
        const liveName = liveId === undefined ? t('note.currentUnknown') : modeName(liveMode, optionOf(options, liveId), t)
        const defaultName = defaultId === undefined ? t('note.currentUnknown') : modeName(modeOf(defaultId), optionOf(options, defaultId), t)
        // An unmatched draft keeps the mode the session already runs instead of
        // forcing a change: AUTO only overrides a composition it can justify.
        const autoTarget = useMemo(() => {
          if (!auto) return undefined
          const matched = classifyTask(draft)
          if (matched !== undefined) return matched
          return liveId === undefined ? undefined : { id: liveId, terms: [], matched: false }
        }, [auto, draft, liveId])
        const selectedId = auto ? AUTO_ID : liveId

        /** Glyph and label of the trigger: the real mode, or AUTO with its resolved target. */
        let faceGlyph = GLYPHS.standard
        let faceName = liveId === undefined ? '…' : liveName
        if (auto) {
          faceGlyph = GLYPHS.auto
          faceName = t('m.auto.name')
          const targetMode = autoTarget === undefined ? undefined : modeOf(autoTarget.id)
          if (targetMode !== undefined && targetMode.id !== AUTO_ID) {
            faceGlyph = GLYPHS[targetMode.id] ?? GLYPHS.auto
            faceName = format('{auto}·{name}', { auto: t('m.auto.short'), name: t(targetMode.shortKey) })
          }
        } else if (liveMode !== undefined) {
          faceGlyph = GLYPHS[liveMode.id] ?? GLYPHS.standard
          faceName = liveName
        }

        /** Show one error in the tool row. */
        const fail = (text) => {
          setNote({ kind: 'error', text, title: text })
          return false
        }

        /**
         * Switch THIS task's preset through the bundle's Host `/mode` command.
         * @param id - target preset id.
         * @param viaAuto - true when AUTO chose it, which words the note differently.
         * @returns whether the Host committed the switch.
         */
        async function switchTask(id, viaAuto = false) {
          if (busyRef.current) return false
          if (sessionId === undefined) return fail(t('error.noSession'))
          const remote = remoteOf()
          // The generated client stub counts declared wire parameters:
          // (agentId, line, submittedAttachments) — exactly three.
          const commands = remote === undefined ? undefined : remote.commands
          if (commands === undefined || typeof commands.execute !== 'function') return fail(t('error.noRemote'))
          if (running) return fail(t('trigger.hintRunning'))

          const mode = modeOf(id)
          const name = modeName(mode, optionOf(options, id), t)
          busyRef.current = true
          setBusy(true)
          setNote(null)
          try {
            const result = await commands.execute(sessionId, `/mode ${id}`, [])
            if (!aliveRef.current) return false
            if (result === undefined || result.ok !== true) {
              return fail(format(t('error.failed'), { reason: result === undefined ? t('error.failedNoReason') : describeFailure(result.error, t) }))
            }
            // `undefined` means the Host resolved no command with that name.
            const execution = result.value
            if (execution === undefined) return fail(t('error.commandMissing'))
            const outcome = execution.result
            if (outcome === undefined || outcome.kind !== 'success') {
              // The Host's own text explains refusals precisely (running, unknown
              // preset, composition failure), so it is shown verbatim.
              return fail(typeof outcome?.text === 'string' && outcome.text !== '' ? outcome.text : t('error.failedNoReason'))
            }
            setPickedLive(id)
            setNote(viaAuto ? describeAutoPick(t, name, autoTarget) : {
              kind: 'ok',
              text: format(t('note.switched'), { name }),
              title: format(t('note.switchedTitle'), { name }),
            })
            return true
          } catch (error) {
            return aliveRef.current ? fail(format(t('error.failed'), { reason: describeFailure(error, t) })) : false
          } finally {
            busyRef.current = false
            if (aliveRef.current) setBusy(false)
          }
        }

        /**
         * Persist one preset as the mode tasks created later start in.
         * @param id - preset id to store as the user default.
         */
        async function setDefault(id) {
          if (busyRef.current) return
          const remote = remoteOf()
          const settings = remote === undefined ? undefined : remote.settings
          if (settings === undefined || typeof settings.update !== 'function') {
            fail(t('error.noRemote'))
            return
          }
          const name = modeName(modeOf(id), optionOf(options, id), t)
          busyRef.current = true
          setBusy(true)
          setNote(null)
          try {
            // Third argument must be PASSED (undefined = unconditional write):
            // the client stub counts it even though the Host accepts absence.
            const result = await settings.update(SETTINGS_NS, { selectedDefault: id }, undefined)
            if (!aliveRef.current) return
            if (result === undefined || result.ok !== true) {
              fail(format(t('error.failed'), { reason: result === undefined ? t('error.failedNoReason') : describeFailure(result.error, t) }))
              return
            }
            setNote({
              kind: 'ok',
              text: format(t('note.default'), { name }),
              title: format(t('note.defaultTitle'), { name }),
            })
            await loadRoster()
          } catch (error) {
            if (aliveRef.current) fail(format(t('error.failed'), { reason: describeFailure(error, t) }))
          } finally {
            busyRef.current = false
            if (aliveRef.current) setBusy(false)
          }
        }

        /** Build the note that explains one AUTO choice. */
        function describeAutoPick(localT, name, target) {
          if (target === undefined || target.matched === false) {
            return { kind: 'ok', text: format(localT('note.autoKeep'), { name }), title: format(localT('note.autoKeep'), { name }) }
          }
          const terms = target.terms.join('、')
          return {
            kind: 'ok',
            text: format(localT('note.autoApplied'), { name }),
            title: format(localT('note.autoAppliedTitle'), { name, terms }),
          }
        }

        // AUTO applies the classified mode while the task is idle. The debounce
        // keeps typing from issuing one switch per keystroke, and the id is
        // remembered only after the Host committed it, so a refused switch is
        // retried when the classification changes rather than silently skipped.
        useEffect(() => {
          if (!auto || sessionId === undefined || running) return undefined
          const target = autoTarget
          if (target === undefined) return undefined
          if (target.matched === false) return undefined
          if (presets !== null && !usable(optionOf(options, target.id))) return undefined
          if (target.id === liveId || target.id === lastAutoRef.current) return undefined
          const timer = window.setTimeout(() => {
            switchTask(target.id, true).then((committed) => {
              if (committed) lastAutoRef.current = target.id
            })
          }, AUTO_DEBOUNCE_MS)
          return () => window.clearTimeout(timer)
        }, [auto, running, sessionId, presets, autoTarget === undefined ? undefined : autoTarget.id, liveId])

        /** Turn AUTO on or off, applying or explaining it for the current task. */
        function toggleAuto(next) {
          setAuto(next)
          writeAutoPreference(next)
          if (!next) return
          lastAutoRef.current = undefined
          if (running) {
            setNote({ kind: 'ok', text: t('note.autoStarted'), title: t('trigger.hintRunning') })
            return
          }
          const target = classifyTask(draft)
          if (target === undefined) {
            setNote({ kind: 'ok', text: t('note.autoWaiting'), title: t('note.autoWaitingTitle') })
            return
          }
          if (target.id === liveId) {
            setNote(describeAutoPick(t, liveName, target))
            return
          }
          switchTask(target.id, true)
        }

        /** Menu selection: AUTO toggles the heuristic, a mode switches the task. */
        function choose(id) {
          setOpen(false)
          if (id === AUTO_ID) {
            toggleAuto(true)
            return
          }
          if (typeof id === 'string' && id.startsWith(DEFAULT_PREFIX)) {
            setDefault(id.slice(DEFAULT_PREFIX.length))
            return
          }
          if (id === DEFAULT_PARENT) return
          if (auto) {
            setAuto(false)
            writeAutoPreference(false)
          }
          switchTask(id, false)
        }

        const items = MENU_MODES.map((mode) => {
          const option = optionOf(options, mode.id)
          const unavailable = mode.id !== AUTO_ID && presets !== null && !usable(option)
          const name = mode.id === AUTO_ID ? t(mode.nameKey) : modeName(mode, option, t)
          const hint = unavailable
            ? format(t('error.unavailable'), { name })
            : mode.id === AUTO_ID && auto && autoTarget !== undefined && autoTarget.matched !== false
              ? format(t('auto.reason'), { name: modeName(modeOf(autoTarget.id), optionOf(options, autoTarget.id), t) })
              : t(mode.hintKey)
          return {
            id: mode.id,
            icon: GLYPHS[mode.id],
            disabled: running || unavailable,
            label: h(
              'span',
              { className: 'dms-item', 'aria-label': name },
              h('span', { className: 'dms-itemName' }, name),
              h('span', { className: 'dms-itemHint' }, hint),
            ),
          }
        })

        // "Default for new tasks" is a nested row: it can never be confused with
        // switching the task in front of you, which is what a top-level click does.
        items.push({
          id: DEFAULT_PARENT,
          disabled: running || presets === null,
          icon: GLYPHS.standard,
          label: h(
            'span',
            { className: 'dms-item', 'aria-label': t('default.name') },
            h('span', { className: 'dms-itemName' }, t('default.name')),
            h('span', { className: 'dms-itemHint' }, format(t('default.hint'), { name: defaultName })),
          ),
          submenu: MODES.map((mode) => {
            const option = optionOf(options, mode.id)
            const name = modeName(mode, option, t)
            return {
              id: DEFAULT_PREFIX + mode.id,
              disabled: presets !== null && !usable(option),
              label: format(t('default.set'), { name }),
            }
          }),
        })

        const triggerTitle = [
          format(t('trigger.title'), { name: liveName }),
          running ? t('trigger.hintRunning') : t('trigger.hintSwitch'),
          auto ? t('trigger.titleAuto') : undefined,
          rosterError,
        ]
          .filter(Boolean)
          .join('\n')

        const anchor = h(
          'button',
          {
            type: 'button',
            className: 'dms-trigger',
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': t('menu.label'),
            title: triggerTitle,
            disabled: busy,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => setOpen(!open),
          },
          h('span', { className: 'dms-triggerIcon', 'aria-hidden': true }, faceGlyph),
          h('span', { className: 'dms-triggerLabel' }, faceName),
          Chevron === undefined
            ? null
            : h('span', { className: classNames(['dms-chevron', open && 'dms-chevronOpen']), 'aria-hidden': true }, h(Chevron, {})),
        )

        if (typeof Menu !== 'function') {
          // Defensive fallback: the baseline table always ships Menu; a native
          // select keeps the control usable if a future shell drops it.
          const selectable = MENU_MODES.map((mode) => h('option', { key: mode.id, value: mode.id }, modeName(mode, optionOf(options, mode.id), t)))
          if (selectedId !== undefined && !MENU_MODES.some((mode) => mode.id === selectedId)) {
            selectable.unshift(h('option', { key: selectedId, value: selectedId }, liveName))
          }
          return h(
            'select',
            {
              className: 'dms-select',
              value: selectedId === undefined ? '' : selectedId,
              'aria-label': t('menu.label'),
              disabled: busy || running,
              onChange: (event) => choose(event.target.value),
            },
            selectable,
          )
        }

        return h(
          'div',
          { className: 'dms-root', 'data-busy': busy ? 'true' : 'false', role: 'group', 'aria-label': t('group.aria') },
          h(Menu, {
            open,
            anchor,
            items,
            selectedId,
            side: 'top',
            align: 'start',
            portal: true,
            onSelect: choose,
            onClose: () => setOpen(false),
          }),
          note === null
            ? null
            : h(
                'span',
                { className: 'dms-note', 'data-kind': note.kind, 'aria-live': 'polite', title: note.title },
                note.text,
              ),
        )
      }
    }

    return {
      // The shipped preset surfaces declare these namespaces plus `remote`, so
      // activation waits until the Host Remotes this control calls are mounted.
      inject: ['slots', 'locale', 'remote', 'remote.agentPresets', 'remote.settings', 'remote.commands'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']'
          if (document.querySelector(selector) !== null) return () => {}
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-task-mode-switch'
          tag.dataset.pluginCss = STYLE_ID
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => {
            tag.remove()
          }
        }, 'task-mode-switch: stylesheet')

        ctx.effect(() => ctx.locale.register(NS, DICT), 'task-mode-switch: dictionaries')

        const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : (key) => key
        const ModeSwitch = createModeSwitch(ctx)
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'task-mode-switch',
              order: 10,
              locale: NS,
              label: () => t('group.aria'),
            },
            ModeSwitch,
          ),
        )
      },
    }
  },
})
