const request = require('../../utils/request')
const auth = require('../../utils/auth')

Page({
  data: {
    user: {},
    avatarText: '司',
    yardName: ''
  },

  onShow() {
    const user = auth.getUser()
    if (!user) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    const yard = (user.accessibleYards || []).find(item => String(item.id) === String(user.currentCyId))
    this.setData({
      user,
      avatarText: (user.userName || '司机').slice(0, 1),
      yardName: yard ? yard.cyName : (user.yardName || '')
    })
  },

  openSettings() {
    wx.openSetting()
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出堆场引导系统吗？',
      success: async result => {
        if (!result.confirm) return
        try {
          await request({ url: '/navigation/auth/logout', method: 'POST' })
        } catch (error) {
          // 即使服务端会话已失效，也应清理本地登录态。
        }
        auth.clearSession()
        getApp().globalData.user = null
        wx.reLaunch({ url: '/pages/login/index' })
      }
    })
  }
})
