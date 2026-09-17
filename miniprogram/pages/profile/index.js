/**
 * 我的：看当前登录是谁、在哪个堆场，以及退出登录。
 * 依赖：request（通知后台退出）、auth（读/清登录态）。
 */
const request = require('../../utils/request')
const auth = require('../../utils/auth')
const collabUnread = require('../../utils/collabUnread')

Page({
  data: {
    user: {}, // 当前登录用户资料
    isFieldRole: false, // 是不是现场岗位（决定定位说明怎么写）
    avatarText: '员', // 头像上那个字，一般取姓名第一个字
    yardName: '', // 当前堆场名
    accountText: '系统用户' // 头像下那行身份说明
  },

  /** 每次进到这一页都重新读本地用户，保证刚换堆场也能对上 */
  onShow() {
    const user = auth.getUser() // 本地记住的用户
    // 没有登录就赶回登录页
    if (!user) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    const isFieldRole = auth.isFieldRole() // 现场岗位还是司机
    // 在能进的堆场里找到当前这个
    const yard = (user.accessibleYards || []).find(item => String(item.id) === String(user.currentCyId))
    const name = user.displayName || user.userName || user.userAccount || '用户' // 显示名
    this.setData({
      user,
      isFieldRole,
      avatarText: name.slice(0, 1), // 头像用姓名首字
      yardName: yard ? yard.cyName : (user.yardName || ''), // 当前堆场
      // 岗位名 / 临时司机 / 系统用户
      accountText: user.roleLabel || (isFieldRole ? '现场岗位' : (user.driverType === 1 ? '临时司机' : '系统用户'))
    })
  },

  /** 打开微信系统权限页，方便司机去开定位 */
  openSettings() {
    wx.openSetting()
  },

  /** 点退出：先问一句，再通知后台并清本地 */
  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出堆场引导系统吗？',
      success: async result => {
        // 点了取消就留下
        if (!result.confirm) return
        try {
          // 通知后台作废这次登录
          await request({ url: '/navigation/auth/logout', method: 'POST' })
        } catch (error) {
          // 即使服务端会话已失效，也应清理本地登录态。
        }
        auth.clearSession() // 清掉手机里的令牌和用户
        getApp().globalData.user = null // 清掉全局用户
        collabUnread.stop()
        wx.reLaunch({ url: '/pages/login/index' }) // 回到登录页
      }
    })
  }
})
