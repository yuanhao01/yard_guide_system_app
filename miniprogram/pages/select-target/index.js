const request = require('../../utils/request')
const auth = require('../../utils/auth')

function displayAreaText(text) {
  return String(text || '').replace(/座场区/g, '区').replace(/座/g, '区')
}

Page({
  data: {
    yards: [],
    blocks: [],
    bays: [],
    yardIndex: -1,
    blockIndex: -1,
    bayIndex: -1,
    loading: false,
    loadingYard: false,
    loadingBlock: false,
    loadingBays: false
  },

  async onLoad() {
    try {
      const yards = await request({ url: '/navigation/mobile/yards' })
      this.setData({ yards })
      if (yards.length === 1) {
        await this.selectYard(0)
      }
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  onYardChange(event) {
    this.selectYard(Number(event.detail.value))
  },

  async selectYard(yardIndex) {
    this.setData({
      yardIndex,
      blockIndex: -1,
      bayIndex: -1,
      blocks: [],
      bays: [],
      loadingYard: true
    })
    try {
      const yard = this.data.yards[yardIndex]
      const user = auth.getUser() || {}
      const tasks = [
        request({ url: `/navigation/mobile/yards/${yard.value}/blocks` })
      ]
      if (user.driverType !== 1 && String(user.currentCyId || '') !== String(yard.value)) {
        tasks.unshift(request({
          url: '/user/switchYard',
          method: 'POST',
          data: { cyId: yard.value }
        }))
      }
      const results = await Promise.all(tasks)
      const blocks = (results[results.length - 1] || []).map(item => ({
        ...item,
        label: displayAreaText(item.label)
      }))
      if (user.driverType !== 1 && String(user.currentCyId || '') !== String(yard.value)) {
        user.currentCyId = yard.value
        auth.setSession(user)
        getApp().globalData.user = user
      }
      this.setData({ blocks })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
    } finally {
      this.setData({ loadingYard: false })
    }
  },

  async onBlockChange(event) {
    const blockIndex = Number(event.detail.value)
    this.setData({ blockIndex, bayIndex: -1, bays: [], loadingBays: true })
    try {
      const block = this.data.blocks[blockIndex]
      const bays = await request({ url: `/navigation/mobile/blocks/${block.value}/bays` })
      this.setData({ bays })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
    } finally {
      this.setData({ loadingBays: false })
    }
  },

  onBayChange(event) {
    this.setData({ bayIndex: Number(event.detail.value) })
  },

  async confirmSelection() {
    const block = this.data.blocks[this.data.blockIndex]
    const bay = this.data.bays[this.data.bayIndex]
    this.setData({ loading: true })
    try {
      const targets = await request({
        url: `/navigation/mobile/targets?blockId=${encodeURIComponent(block.value)}&keyword=${encodeURIComponent(bay.value)}`
      })
      const exactTarget = targets.find(item => String(item.slot) === String(bay.value))
      if (!exactTarget) {
        throw new Error('该贝位尚未配置导航入口，请联系管理员')
      }
      getApp().globalData.selectedTarget = { target: exactTarget, sourceType: 0 }
      wx.navigateTo({ url: '/pages/confirm-target/index' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
    } finally {
      this.setData({ loading: false })
    }
  }
})
