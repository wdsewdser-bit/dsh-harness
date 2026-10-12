async (page) => {
  const out = 'D:/dsh-test/output/'
  const tabs = [
    ['成员', 'v14-panel-tab-members-desktop'],
    ['已冻结', 'v14-panel-tab-frozen-desktop'],
    ['看板', 'v14-panel-tab-board-desktop'],
    ['协作房间', 'v14-panel-tab-rooms-desktop'],
    ['消息投递', 'v14-panel-tab-delivery-desktop'],
    ['操作概况', 'v14-panel-tab-ops-desktop'],
  ]
  const results = []
  for (const [label, file] of tabs) {
    const tab = page.getByRole('tab', { name: new RegExp('^' + label) })
    await tab.click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: out + file + '.png' })
    results.push({ label, file, selected: await tab.getAttribute('aria-selected') })
  }
  return results
}
