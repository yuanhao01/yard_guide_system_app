const request = require('../../utils/request')
const auth = require('../../utils/auth')

Page({
  data: {
    yards: [],
    blocks: [],
    bays: [],
    yardIndex: -1,
    blockIndex: -1,
    bayIndex: -1,
    keyword: '',
    results: [],
    loading: false
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
    this.setData({ yardIndex, blockIndex: -1, bayIndex: -1, blocks: [], bays: [] })
    try {
      const yard = this.data.yards[yardIndex]
      const user = auth.getUser() || {}
      if (user.driverType !== 1 && String(user.currentCyId || '') !== String(yard.value)) {
        await request({
          url: '/user/switchYard',
          method: 'POST',
          data: { cyId: yard.value }
        })
        user.currentCyId = yard.value
        auth.setSession(user)
        getApp().globalData.user = user
      }
      const blocks = await request({ url: `/navigation/mobile/yards/${yard.value}/blocks` })
      this.setData({ blocks })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  async onBlockChange(event) {
    const blockIndex = Number(event.detail.value)
    this.setData({ blockIndex, bayIndex: -1, bays: [] })
    try {
      const block = this.data.blocks[blockIndex]
      const bays = await request({ url: `/navigation/mobile/blocks/${block.value}/bays` })
      this.setData({ bays })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  onBayChange(event) {
    this.setData({ bayIndex: Number(event.detail.value) })
  },

  onKeywordInput(event) {
    this.setData({ keyword: event.detail.value.trim() })
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
      this.openConfirmation(exactTarget)
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
    } finally {
      this.setData({ loading: false })
    }
  },

  async search() {
    if (!this.data.keyword) {
      wx.showToast({ title: '请输入贝位编码', icon: 'none' })
      return
    }
    try {
      const yard = this.data.yardIndex >= 0 ? this.data.yards[this.data.yardIndex] : null
      const query = yard ? `&yardId=${yard.value}` : ''
      const results = await request({
        url: `/navigation/mobile/targets?keyword=${encodeURIComponent(this.data.keyword)}${query}`
      })
      this.setData({ results })
      if (!results.length) {
        wx.showToast({ title: '未找到已配置的贝位', icon: 'none' })
      }
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  chooseSearchResult(event) {
    this.openConfirmation(this.data.results[event.currentTarget.dataset.index])
  },

  openConfirmation(target) {
    getApp().globalData.selectedTarget = { target, sourceType: 0 }
    wx.navigateTo({ url: '/pages/confirm-target/index' })
  }
})
