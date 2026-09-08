const request = require('../../utils/request')
const auth = require('../../utils/auth')

Page({
  data: {
    yardName: '',
    currentSession: null
  },

  onShow() {
    if (!auth.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh())
  },

  async refresh() {
    const user = auth.getUser() || {}
    const yard = (user.accessibleYards || []).find(item => String(item.id) === String(user.currentCyId))
    this.setData({ yardName: yard ? yard.cyName : (user.yardName || '') })
    try {
      const currentSession = await request({ url: '/navigation/mobile/sessions/current' })
      this.setData({ currentSession })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  scanCode() {
    if (this.data.currentSession) {
      this.continueNavigation()
      return
    }
    wx.scanCode({
      scanType: ['qrCode'],
      success: async result => {
        try {
          wx.showLoading({ title: '识别中' })
          const target = await request({
            url: '/navigation/mobile/scan',
            method: 'POST',
            data: { content: result.result }
          })
          this.openConfirmation(target, 1)
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
        } finally {
          wx.hideLoading()
        }
      }
    })
  },

  selectTarget() {
    if (this.data.currentSession) {
      this.continueNavigation()
      return
    }
    wx.navigateTo({ url: '/pages/select-target/index' })
  },

  continueNavigation() {
    wx.navigateTo({ url: `/pages/navigation/index?sessionId=${this.data.currentSession.id}` })
  },

  openConfirmation(target, sourceType) {
    getApp().globalData.selectedTarget = { target, sourceType }
    wx.navigateTo({ url: '/pages/confirm-target/index' })
  }
})
