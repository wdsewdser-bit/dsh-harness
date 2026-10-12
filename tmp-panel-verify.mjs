async (page) => {
  const tabs = ['成员', '已冻结', '看板', '协作房间', '消息投递', '操作概况']
  const report = []
  for (const label of tabs) {
    const tab = page.getByRole('tab', { name: new RegExp('^' + label) })
    await tab.click()
    await page.waitForTimeout(500)
    const panelText = await page.evaluate(() => {
      const tablists = Array.from(document.querySelectorAll('[role="tablist"]'))
      const team = tablists.find((list) => /成员/.test(list.textContent ?? ''))
      const container = team?.parentElement?.parentElement ?? document.body
      return (container.innerText ?? '').slice(0, 4000)
    })
    const box = await tab.boundingBox()
    report.push({
      label,
      selected: await tab.getAttribute('aria-selected'),
      box,
      length: panelText.length,
      head: panelText.replace(/\s+/g, ' ').slice(0, 220),
      markers: {
        leadAlpha: panelText.includes('lead-alpha'),
        alphaMember: panelText.includes('alpha-m1'),
        taskId: panelText.includes('group-alpha-t1') || panelText.includes('task-1'),
        roomId: panelText.includes('group:alpha:tier-2') || panelText.includes('root'),
      },
    })
  }
  return report
}
