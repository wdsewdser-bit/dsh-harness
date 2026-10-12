async (page) => {
  const out = 'D:/dsh-test/output/'
  await page.setViewportSize({ width: 480, height: 900 })
  await page.waitForTimeout(800)
  const shots = []
  for (const [label, file] of [['成员', 'v14-panel-tab-members-narrow'], ['协作房间', 'v14-panel-tab-rooms-narrow'], ['操作概况', 'v14-panel-tab-ops-narrow']]) {
    const tab = page.getByRole('tab', { name: new RegExp('^' + label) })
    await tab.click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: out + file + '.png' })
    const box = await tab.boundingBox()
    shots.push({ label, file, box })
  }
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  await page.setViewportSize({ width: 1440, height: 900 })
  return { shots, overflow }
}
