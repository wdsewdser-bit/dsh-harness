window.__ModuleLoader__.load({
  id: '@local/evidence-reducer-ui',
  factory(require) {
    const React = require('react')
    const {
      SettingsForm,
      SettingsFormModel,
      SettingsValueField,
      settingsNumberField,
      settingsTextField,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement
    const NS = 'evidenceReducerUi'
    const SETTINGS_NS = 'evidence-reducer'
    const zh = {
      title: '证据 Reducer',
      description: '配置长工具日志的证据保留式压缩路由。',
      enabled: '启用 Reducer',
      enabledHint: '关闭后不再压缩长工具输出。',
      routeMode: '路由方式',
      routeModeHint: '跟随当前会话、指定供应商/模型，或关闭。',
      session: '跟随当前会话',
      explicit: '指定供应商/模型',
      off: '关闭',
      provider: '供应商',
      providerHint: '从 DSH 已注册的供应商中选择。',
      model: '模型',
      modelHint: '从所选供应商的已注册模型中选择。',
      effort: '思考档位',
      effortHint: '从所选模型支持的思考档位中选择。',
      providerPlaceholder: '请选择供应商',
      modelPlaceholder: '请选择模型',
      providerDefault: '供应商默认',
      notInCatalog: '不在当前模型目录',
      catalogLoading: '正在读取 DSH 模型目录…',
      catalogFailed: '模型目录读取失败：',
      catalogRetry: '重试',
      routeIncomplete: '指定路由需要同时选择供应商和模型。',
      remoteAllowed: '允许远程路由',
      remoteAllowedHint: '仅在你确认日志可以发送给该供应商时开启。',
      thresholdBytes: '触发字节数',
      thresholdHint: '工具输出超过此 UTF-8 字节数时才尝试压缩。',
      maxReceiptTokens: '收据最大 token',
      maxQuotes: '最大引用条数',
      timeoutMs: '超时毫秒',
      maxInputBytes: '最大输入字节',
      maxInputLines: '最大输入行数',
      overridden: '已覆盖',
      reset: '恢复默认',
      save: '保存',
      saving: '保存中…',
      saveFailed: '保存未生效，请检查字段后重试。',
      readOnly: '当前设置为只读。',
      unavailable: 'Reducer 设置当前不可用。',
      summary: '配置证据 Reducer 的路由、阈值和远程许可。',
      saveHint: '修改字段后请点击页面底部“保存”；保存成功后会立即写入运行态设置。',
    }
    const en = {
      title: 'Evidence Reducer',
      description: 'Configure evidence-preserving reduction for long tool logs.',
      enabled: 'Enable reducer',
      enabledHint: 'When off, long tool output is left untouched.',
      routeMode: 'Route mode',
      routeModeHint: 'Follow the current session, use an explicit route, or turn it off.',
      session: 'Follow current session',
      explicit: 'Explicit provider/model',
      off: 'Off',
      provider: 'Provider',
      providerHint: 'Choose from providers registered in DSH.',
      model: 'Model',
      modelHint: 'Choose from models registered for the selected provider.',
      effort: 'Reasoning effort',
      effortHint: 'Choose from the effort levels supported by the selected model.',
      providerPlaceholder: 'Select provider',
      modelPlaceholder: 'Select model',
      providerDefault: 'Provider default',
      notInCatalog: 'not in the current catalog',
      catalogLoading: 'Loading the DSH model catalog…',
      catalogFailed: 'Model catalog load failed: ',
      catalogRetry: 'Retry',
      routeIncomplete: 'Explicit routing requires both a provider and a model.',
      remoteAllowed: 'Allow remote route',
      remoteAllowedHint: 'Only enable when this provider may receive the log.',
      thresholdBytes: 'Trigger bytes',
      thresholdHint: 'Only reduce output larger than this UTF-8 byte count.',
      maxReceiptTokens: 'Maximum receipt tokens',
      maxQuotes: 'Maximum quotes',
      timeoutMs: 'Timeout (ms)',
      maxInputBytes: 'Maximum input bytes',
      maxInputLines: 'Maximum input lines',
      overridden: 'Overridden',
      reset: 'Reset',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The save did not land; correct the fields and retry.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'Reducer settings are unavailable.',
      summary: 'Configure reducer routing, thresholds, and remote permission.',
      saveHint: 'Edit the fields, then click Save at the bottom. A successful save is applied to the live settings immediately.',
    }

    function boolField(field) {
      return {
        field,
        format: (value) => value === true ? 'true' : 'false',
        parse: (text) => {
          if (text === '') return { kind: 'clear' }
          if (text === 'true') return { kind: 'set', value: true }
          if (text === 'false') return { kind: 'set', value: false }
          return undefined
        },
      }
    }

    function enumField(field, values) {
      return {
        field,
        format: (value) => typeof value === 'string' && values.includes(value) ? value : '',
        parse: (text) => text === ''
          ? { kind: 'clear' }
          : values.includes(text) ? { kind: 'set', value: text } : undefined,
      }
    }

    function FieldShell(props) {
      const field = props.field
      return h('div', { style: { marginBottom: '14px' } }, [
        h('div', { key: 'label', style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } }, [
          h('label', { key: 'label-text', htmlFor: props.id, style: { fontWeight: 600 } }, props.label),
          field && field.overridden
            ? h('span', { key: 'override', style: { color: 'var(--dsw-text-tertiary, #888)', fontSize: '12px' } }, props.overriddenLabel)
            : null,
          field && field.overridden && props.onReset
            ? h('button', { key: 'reset', type: 'button', disabled: props.disabled, onClick: props.onReset, style: { border: 0, background: 'none', color: 'var(--dsw-accent, #5b8cff)', cursor: 'pointer', padding: 0 } }, props.resetLabel)
            : null,
        ]),
        props.children,
        props.hint ? h('div', { style: { color: 'var(--dsw-text-tertiary, #888)', fontSize: '12px', marginTop: '4px' } }, props.hint) : null,
      ])
    }

    function CheckboxField(props) {
      return h(FieldShell, props, h('input', {
        id: props.id,
        type: 'checkbox',
        checked: props.state.text === 'true',
        disabled: props.disabled,
        onChange: (event) => props.onEdit(event.target.checked ? 'true' : 'false'),
      }))
    }

    function SelectField(props) {
      const options = props.options.length > 0
        ? props.options
        : []
      if (props.placeholder !== undefined && !options.some((option) => option.value === '')) {
        options.unshift({ value: '', label: props.placeholder })
      }
      if (options.length === 0) options.push({ value: '', label: props.placeholder ?? '' })
      return h(FieldShell, props, h('select', {
        id: props.id,
        value: props.state.text || props.fallback || '',
        disabled: props.disabled,
        onChange: (event) => props.onEdit(event.target.value),
        style: { minWidth: '220px', padding: '6px 8px' },
      }, options.map((option) => h('option', {
        key: option.value,
        value: option.value,
        disabled: option.disabled === true,
      }, option.label))))
    }

    function textField(id, label, hint, state, onEdit, onReset, disabled, overriddenLabel, resetLabel) {
      return h(SettingsValueField, {
        id,
        label,
        hint,
        overriddenLabel,
        resetLabel,
        invalidLabel: 'Invalid value',
        disabled,
        ...state,
        onEdit,
        onReset,
      })
    }

    function numberField(id, label, hint, state, onEdit, onReset, disabled, overriddenLabel, resetLabel) {
      return h(SettingsValueField, {
        id,
        label,
        hint,
        overriddenLabel,
        resetLabel,
        invalidLabel: 'Invalid number',
        numeric: true,
        disabled,
        ...state,
        onEdit,
        onReset,
      })
    }

    function EvidenceReducerCard(props) {
      const t = props.t
      const state = props.useEvidenceReducer((snapshot) => snapshot)
      const [catalog, setCatalog] = React.useState({ status: 'loading', groups: [], error: null })
      const [catalogReload, setCatalogReload] = React.useState(0)
      const [saveError, setSaveError] = React.useState(null)
      React.useEffect(() => {
        let active = true
        setCatalog((current) => ({ ...current, status: 'loading', error: null }))
        Promise.resolve(props.loadModelCatalog()).then((response) => {
          if (!active) return
          if (response?.ok !== true) {
            const detail = response?.error?.message ?? response?.error?.code ?? 'model catalog request failed'
            throw new Error(detail)
          }
          setCatalog({
            status: 'ready',
            groups: Array.isArray(response.value?.groups) ? response.value.groups : [],
            error: null,
          })
        }).catch((error) => {
          if (!active) return
          setCatalog({
            status: 'error',
            groups: [],
            error: error instanceof Error ? error.message : String(error),
          })
        })
        return () => {
          active = false
        }
      }, [catalogReload, props.loadModelCatalog])
      if (props.view === 'summary') return t('summary')
      const disabled = !state.writable
      const groups = catalog.groups
      const providerValue = state.provider.text
      const selectedGroup = groups.find((group) => group.id === providerValue)
      const providerOptions = groups.map((group) => ({
        value: group.id,
        label: group.name && group.name !== group.id ? `${group.name} (${group.id})` : group.id,
      }))
      if (providerValue && selectedGroup === undefined) {
        providerOptions.unshift({ value: providerValue, label: `${providerValue} (${t('notInCatalog')})` })
      }
      const modelValue = state.model.text
      const selectedModel = selectedGroup?.models?.find((model) => model.id === modelValue)
      const modelOptions = Array.isArray(selectedGroup?.models)
        ? selectedGroup.models.map((model) => ({
          value: model.id,
          label: model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id,
        }))
        : []
      if (modelValue && selectedModel === undefined) {
        modelOptions.unshift({ value: modelValue, label: `${modelValue} (${t('notInCatalog')})` })
      }
      const effortValue = state.reasoningEffort.text
      const effortOptions = [{ value: '', label: t('providerDefault') }]
      for (const effort of selectedModel?.reasoning?.efforts ?? []) {
        effortOptions.push({ value: effort.id, label: effort.name || effort.id })
      }
      if (effortValue && !effortOptions.some((option) => option.value === effortValue)) {
        effortOptions.push({ value: effortValue, label: `${effortValue} (${t('notInCatalog')})` })
      }
      const explicit = state.routeMode.text === 'explicit'
      const explicitIncomplete = explicit && (providerValue.trim() === '' || modelValue.trim() === '')
      const catalogReady = catalog.status === 'ready'
      const providerDisabled = disabled || !explicit || !catalogReady || providerOptions.length === 0
      const modelDisabled = disabled || !explicit || !catalogReady || providerValue.trim() === '' || modelOptions.length === 0
      const effortDisabled = disabled || !explicit || !catalogReady || modelValue.trim() === ''
      return h(SettingsForm, {
        labels: {
          unavailable: t('unavailable'),
          readOnly: t('readOnly'),
          saveFailed: saveError === null ? t('saveFailed') : t('saveFailed') + ' ' + saveError,
          save: t('save'),
          saving: t('saving'),
        },
        state: explicitIncomplete ? { ...state, invalid: true } : state,
        onSave: async () => {
          const failure = await props.save()
          setSaveError(failure ?? null)
        },
        onDiscard: props.discard,
        children: [
          h('p', {
            key: 'save-hint',
            style: { color: 'var(--dsw-text-tertiary, #888)', fontSize: '12px', margin: '0 0 14px' },
          }, t('saveHint')),
          h(CheckboxField, {
            key: 'enabled',
            id: 'evidence-reducer-enabled',
            label: t('enabled'),
            hint: t('enabledHint'),
            state: state.enabled,
            disabled,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            onEdit: (text) => props.edit('enabled', text),
            onReset: () => props.resetField('enabled'),
          }),
          h(SelectField, {
            key: 'routeMode',
            id: 'evidence-reducer-route-mode',
            label: t('routeMode'),
            hint: t('routeModeHint'),
            state: state.routeMode,
            fallback: 'session',
            disabled,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            options: [
              { value: 'session', label: t('session') },
              { value: 'explicit', label: t('explicit') },
              { value: 'off', label: t('off') },
            ],
            onEdit: (text) => props.edit('routeMode', text),
            onReset: () => props.resetField('routeMode'),
          }),
          catalog.status === 'loading'
            ? h('div', { key: 'catalog-loading', style: { color: 'var(--dsw-text-tertiary, #888)', fontSize: '12px', marginBottom: '10px' } }, t('catalogLoading'))
            : null,
          catalog.status === 'error'
            ? h('div', { key: 'catalog-error', style: { color: 'var(--dsw-alias-state-error-primary, #d44)', fontSize: '12px', marginBottom: '10px' } }, [
              t('catalogFailed') + catalog.error + ' ',
              h('button', {
                key: 'retry',
                type: 'button',
                disabled,
                onClick: () => setCatalogReload((value) => value + 1),
                style: { border: 0, background: 'none', color: 'inherit', cursor: 'pointer', padding: 0, textDecoration: 'underline' },
              }, t('catalogRetry')),
            ])
            : null,
          explicitIncomplete
            ? h('div', { key: 'route-incomplete', style: { color: 'var(--dsw-alias-state-warn-label, #b80)', fontSize: '12px', marginBottom: '10px' } }, t('routeIncomplete'))
            : null,
          h(SelectField, {
            key: 'provider',
            id: 'evidence-reducer-provider',
            label: t('provider'),
            hint: t('providerHint'),
            state: state.provider,
            placeholder: t('providerPlaceholder'),
            options: providerOptions,
            disabled: providerDisabled,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            onEdit: (text) => {
              props.edit('provider', text)
              const nextGroup = groups.find((group) => group.id === text)
              if (nextGroup === undefined || !nextGroup.models?.some((model) => model.id === state.model.text)) {
                props.edit('model', '')
                props.edit('reasoningEffort', '')
              }
            },
            onReset: () => props.resetField('provider'),
          }),
          h(SelectField, {
            key: 'model',
            id: 'evidence-reducer-model',
            label: t('model'),
            hint: t('modelHint'),
            state: state.model,
            placeholder: t('modelPlaceholder'),
            options: modelOptions,
            disabled: modelDisabled,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            onEdit: (text) => {
              props.edit('model', text)
              if (text !== state.model.text) props.edit('reasoningEffort', '')
            },
            onReset: () => props.resetField('model'),
          }),
          h(SelectField, {
            key: 'effort',
            id: 'evidence-reducer-effort',
            label: t('effort'),
            hint: t('effortHint'),
            state: state.reasoningEffort,
            options: effortOptions,
            disabled: effortDisabled,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            onEdit: (text) => props.edit('reasoningEffort', text),
            onReset: () => props.resetField('reasoningEffort'),
          }),
          h(CheckboxField, {
            key: 'remoteAllowed',
            id: 'evidence-reducer-remote-allowed',
            label: t('remoteAllowed'),
            hint: t('remoteAllowedHint'),
            state: state.remoteAllowed,
            disabled,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            onEdit: (text) => props.edit('remoteAllowed', text),
            onReset: () => props.resetField('remoteAllowed'),
          }),
          numberField(
            'evidence-reducer-threshold-bytes', t('thresholdBytes'), t('thresholdHint'),
            state.thresholdBytes, (text) => props.edit('thresholdBytes', text), () => props.resetField('thresholdBytes'),
            disabled, t('overridden'), t('reset'),
          ),
          numberField(
            'evidence-reducer-max-receipt-tokens', t('maxReceiptTokens'), '',
            state.maxReceiptTokens, (text) => props.edit('maxReceiptTokens', text), () => props.resetField('maxReceiptTokens'),
            disabled, t('overridden'), t('reset'),
          ),
          numberField(
            'evidence-reducer-max-quotes', t('maxQuotes'), '',
            state.maxQuotes, (text) => props.edit('maxQuotes', text), () => props.resetField('maxQuotes'),
            disabled, t('overridden'), t('reset'),
          ),
          numberField(
            'evidence-reducer-timeout-ms', t('timeoutMs'), '',
            state.timeoutMs, (text) => props.edit('timeoutMs', text), () => props.resetField('timeoutMs'),
            disabled, t('overridden'), t('reset'),
          ),
          numberField(
            'evidence-reducer-max-input-bytes', t('maxInputBytes'), '',
            state.maxInputBytes, (text) => props.edit('maxInputBytes', text), () => props.resetField('maxInputBytes'),
            disabled, t('overridden'), t('reset'),
          ),
          numberField(
            'evidence-reducer-max-input-lines', t('maxInputLines'), '',
            state.maxInputLines, (text) => props.edit('maxInputLines', text), () => props.resetField('maxInputLines'),
            disabled, t('overridden'), t('reset'),
          ),
        ],
      })
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'evidence-reducer-ui: dictionaries')
      const loadModelCatalog = () => ctx.remote.session.modelCatalog()
      const form = new SettingsFormModel(
        ctx.configForms.get(SETTINGS_NS),
        [
          boolField('enabled'),
          enumField('routeMode', ['session', 'explicit', 'off']),
          settingsTextField('provider'),
          settingsTextField('model'),
          settingsTextField('reasoningEffort'),
          boolField('remoteAllowed'),
          settingsNumberField('thresholdBytes'),
          settingsNumberField('maxReceiptTokens'),
          settingsNumberField('maxQuotes'),
          settingsNumberField('timeoutMs'),
          settingsNumberField('maxInputBytes'),
          settingsNumberField('maxInputLines'),
        ],
      )
      const store = form.bind(() => ({
        ...form.shell(),
        enabled: form.field('enabled'),
        routeMode: form.field('routeMode'),
        provider: form.field('provider'),
        model: form.field('model'),
        reasoningEffort: form.field('reasoningEffort'),
        remoteAllowed: form.field('remoteAllowed'),
        thresholdBytes: form.field('thresholdBytes'),
        maxReceiptTokens: form.field('maxReceiptTokens'),
        maxQuotes: form.field('maxQuotes'),
        timeoutMs: form.field('timeoutMs'),
        maxInputBytes: form.field('maxInputBytes'),
        maxInputLines: form.field('maxInputLines'),
      }))
      const baseActions = form.actions()
      const actions = {
        ...baseActions,
        save: async () => {
          const ops = form.plan().flatMap((item) => item.op === undefined ? [] : [item.op])
          if (ops.length === 0) return null
          const scope = form.scope
          const snapshot = scope.getSnapshot()
          const response = await ctx.remote.settings.mutate(SETTINGS_NS, ops, snapshot.revision)
          if (response?.ok !== true) {
            await scope.mirror?.load?.()
            return response?.error?.message ?? response?.error?.code ?? 'settings mutation rejected'
          }
          await scope.mirror?.load?.()
          const fresh = scope.getSnapshot()
          const accepted = response.value?.revision !== undefined
            && fresh.revision === response.value.revision
          if (!accepted) return 'settings write was accepted but live settings did not refresh'
          form.staged.clear()
          form.baseline = undefined
          form.failed = false
          form.publish()
          return null
        },
      }
      ctx.effect(() => () => form.dispose(), 'evidence-reducer-ui: form subscription')
      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
        name: 'plugins.item',
        id: 'evidence-reducer-ui',
        order: 41,
        label: () => t('title'),
        locale: NS,
        inject: () => ({
          hooks: { evidenceReducer: store },
          loadModelCatalog,
          ...actions,
        }),
      }, EvidenceReducerCard))), 'evidence-reducer-ui: page')
    }

    return {
      inject: ['slots', 'locale', 'configForms', 'remote', 'remote.session', 'remote.settings'],
      apply,
    }
  },
})
