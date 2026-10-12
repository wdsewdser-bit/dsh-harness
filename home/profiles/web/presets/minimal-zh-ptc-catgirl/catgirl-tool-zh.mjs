/**
 * 猫娘模式：把工具面里给模型看的英文说明换成中文。
 *
 * 为什么值得做：PTC（Code Mode）下工具不是以原生 schema 出现，而是被 dsh-tools
 * 渲染成 system 提示词里的 \`tools:sdk\` 段落——每个工具的 description 变成
 * \`interface ToolArgsMap\` 上面的注释行。那一段加上固定的英文使用说明，是这个
 * 预设里除工具结果之外最大的一坨英文，也是「思维链被英文带跑」的燃料之一。
 * 把它换成中文，等于从源头少给模型一截英文模仿素材。
 *
 * 怎么改（只动模型可见文本，不动任何行为）：
 *   - 挂 \`system-prompt/assemble\` 瀑布：dsh-tools 的原生 schema 列表、SDK 段落、
 *     \`tools:ptc-only\` 规则段都在这个 assembly 里，改完就是最终请求看到的文本。
 *   - \`tools:sdk\` 是**已经渲染好的字符串**（section 的 text provider 在瀑布之前
 *     就跑完了），所以不能只改 assembly.tools[].description：要按工具名找到它前面
 *     那行 JSDoc 注释（两条斜杠包起来的 /** 形式），整行换成中文。
 *   - 固定英文说明（run_code 用法、程序内约定、PTC-only 规则）按整段精确匹配替换；
 *     任何一段没匹配到就原样留着并只警告一次——DSH 升版改了文案时，退化成「部分
 *     没翻译」，而不是把提示词改坏。
 *
 * 翻译内容放在同目录的 catgirl-tool-zh.json：{ scaffold: {...}, tools: { name: "中文" } }。
 * 漏翻的工具会汇总成一条 warning，方便补。
 *
 * 不属于本插件的英文：工具**结果**（代码、报错、日志）没法本地化；系统提示词里
 * 其它插件的段落（沙箱策略、审批策略等）也不在这里动。
 */

import { readJson } from './catgirl-mode.mjs'

export const name = 'catgirl-tool-zh'

/** Deliberately no inject list：apply 期只读本地 JSON，事件期才用 waterfall。 */
export const inject = []

/** 默认翻译表（和预设同目录）。 */
const DEFAULT_TABLE_FILE = './catgirl-tool-zh.json'

/** 把一段 JSON 文本压成单行注释（和 dsh-tools 的 docLines 同一规则）。 */
function collapse(text) {
  return String(text).replace(/\s+/g, ' ').trim().replaceAll('*/', String.raw`*\/`)
}

/** 按精确匹配替换固定英文说明；找不到就记一笔。 */
function replaceOnce(text, from, to, missing) {
  if (typeof from !== 'string' || from.length === 0) return text
  if (!text.includes(from)) {
    missing.push(from.slice(0, 40))
    return text
  }
  return text.split(from).join(to)
}

/**
 * 把 \`tools:sdk\` 段落本地化。
 * @param text - dsh-tools 渲染好的 SDK 段落。
 * @param descriptions - { toolName: 中文说明 }。
 * @param scaffold - 固定英文说明的中文替换。
 * @param missing - 收集没匹配到的固定片段（调用方汇总成一条 warning）。
 * @returns 本地化后的段落。
 */
function localizeSdk(text, descriptions, scaffold, missing) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  out = replaceOnce(out, scaffold.sdkInstructions, scaffold.sdkInstructionsZh, missing)
  out = replaceOnce(out, scaffold.programInstructions, scaffold.programInstructionsZh, missing)
  out = replaceOnce(out, scaffold.bashExampleLead, scaffold.bashExampleLeadZh, missing)

  const lines = out.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const member = /^ {2}([A-Za-z_$][A-Za-z0-9_$]*): /.exec(lines[index])
    if (member === null) continue
    const chinese = descriptions[member[1]]
    if (typeof chinese !== 'string' || chinese.length === 0) continue
    const previous = lines[index - 1]
    if (previous === undefined || !/^ {2}\/\*\*.*\*\/$/.test(previous)) continue
    lines[index - 1] = `  /** ${collapse(chinese)} */`
  }
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  if (!enabled) return
  const tableFile = typeof config.tableFile === 'string' && config.tableFile.length > 0
    ? config.tableFile
    : DEFAULT_TABLE_FILE
  const table = readJson(tableFile, import.meta.url)
  const descriptions = table?.tools
  const scaffold = {
    sdkInstructions: table?.scaffold?.sdkInstructions,
    sdkInstructionsZh: table?.scaffold?.sdkInstructionsZh,
    programInstructions: table?.scaffold?.programInstructions,
    programInstructionsZh: table?.scaffold?.programInstructionsZh,
    bashExampleLead: table?.scaffold?.bashExampleLead,
    bashExampleLeadZh: table?.scaffold?.bashExampleLeadZh,
    ptcOnly: table?.scaffold?.ptcOnly,
    ptcOnlyZh: table?.scaffold?.ptcOnlyZh,
  }
  if (descriptions === undefined && scaffold.sdkInstructions === undefined) {
    ctx.logger?.warn?.(`${name}: no usable translation table at ${tableFile}; tool localization disabled`)
    return
  }

  let warned = false
  const reported = new Set()
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // 日志不可用就算了。
    }
  }

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    try {
      if (assembled === undefined || assembled === null) return assembled
      const map = descriptions ?? {}
      const missing = []
      const unmapped = new Set()

      const sections = Array.isArray(assembled.sections)
        ? assembled.sections.map((section) => {
          if (section?.name === 'tools:sdk') {
            const text = localizeSdk(section.text, map, scaffold, missing)
            // 漏翻清单：SDK 成员名里没有中文说明的那些。
            for (const line of String(section.text).split('\n')) {
              const member = /^ {2}([A-Za-z_$][A-Za-z0-9_$]*): /.exec(line)
              if (member !== null && typeof map[member[1]] !== 'string') unmapped.add(member[1])
            }
            return { ...section, text }
          }
          if (section?.name === 'tools:ptc-only' && typeof scaffold.ptcOnlyZh === 'string' && section.text === scaffold.ptcOnly) {
            return { ...section, text: scaffold.ptcOnlyZh }
          }
          return section
        })
        : assembled.sections

      // 原生 schema 那一份（mode: both / native 时用得上）也一起换掉，保持一致。
      const tools = Array.isArray(assembled.tools)
        ? assembled.tools.map((tool) => {
          const chinese = map[tool?.name]
          return typeof chinese === 'string' && chinese.length > 0 ? { ...tool, description: chinese } : tool
        })
        : assembled.tools

      if (missing.length > 0 || unmapped.size > 0) {
        warnOnce(`${name}: partial localization — 未匹配的固定段落 ${JSON.stringify(missing)}, 未翻译的工具 ${JSON.stringify([...unmapped])}`)
      }
      void context
      void reported
      return { ...assembled, sections, tools }
    } catch (error) {
      warnOnce(`${name}: localization failed, keeping the original text: ${String((error && error.message) || error)}`)
      return assembled
    }
  })
}
