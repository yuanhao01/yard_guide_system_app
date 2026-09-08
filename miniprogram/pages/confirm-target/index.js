const request = require('../../utils/request')
const locationUtil = require('../../utils/location')

Page({
  data: {
    target: null,
    sourceType: 0,
    starting: false
  },

  onLoad() {
    const selection = getApp().globalData.selectedTarget
    if (!selection) {
      wx.showToast({ title: '请先选择目的贝位', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1200)
      return
    }
    this.setData(selection)
  },

  async startNavigation() {
    this.setData({ starting: true })
    try {
      const location = await locationUtil.getCurrentLocation()
      const session = await request({
        url: '/navigation/mobile/sessions',
        method: 'POST',
        data: {
          targetId: this.data.target.id,
          sourceType: this.data.sourceType,
          longitude: location.longitude,
          latitude: location.latitude
        }
      })
      getApp().globalData.selectedTarget = null
      wx.redirectTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
    } catch (error) {
      wx.showModal({
        title: '无法开始导航',
        content: error.message,
        confirmText: '打开设置',
        success: result => result.confirm && wx.openSetting()
      })
    } finally {
      this.setData({ starting: false })
    }
  },

  goBack() {
    wx.navigateBack()
  }
})
