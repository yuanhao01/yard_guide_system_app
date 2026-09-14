const request = require('../../utils/request')
const auth = require('../../utils/auth')

Page({
  data: {
    user: {},
    isFieldRole: false,
    avatarText: '员',
    yardName: '',
    accountText: '系统用户'
  },

  onShow() {
    const user = auth.getUser()
    if (!user) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    const isFieldRole = auth.isFieldRole()
    const yard = (user.accessibleYards || []).find(item => String(item.id) === String(user.currentCyId))
    const name = user.displayName || user.userName || user.userAccount || '用户'
    this.setData({
      user,
      isFieldRole,
      avatarText: name.slice(0, 1),
      yardName: yard ? yard.cyName : (user.yardName || ''),
      accountText: user.roleLabel || (isFieldRole ? '现场岗位' : (user.driverType === 1 ? '临时司机' : '系统用户'))
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
