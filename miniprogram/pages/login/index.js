const request = require('../../utils/request')
const auth = require('../../utils/auth')

function switchToHome() {
  return new Promise((resolve, reject) => {
    wx.switchTab({
      url: '/pages/home/index',
      success: resolve,
      fail() {
        reject(new Error('登录成功，但页面跳转失败，请重试'))
      }
    })
  })
}

Page({
  data: {
    loginKind: 'driver',
    plateNumber: '',
    yards: [],
    yardNames: [],
    yardIndex: -1,
    yardName: '',
    userAccount: '',
    password: '',
    submitting: false
  },

  onLoad() {
    if (auth.isLoggedIn()) {
      wx.switchTab({ url: '/pages/home/index' })
      return
    }
    this.loadYards()
  },

  async loadYards() {
    try {
      const yards = await request({
        url: '/navigation/auth/yards',
        skipUnauthorizedRedirect: true
      })
      const list = yards || []
      this.setData({
        yards: list,
        yardNames: list.map(item => item.cyName || String(item.id))
      })
    } catch (error) {
      wx.showToast({ title: error.message || '堆场列表加载失败', icon: 'none' })
    }
  },

  switchKind(event) {
    const loginKind = event.currentTarget.dataset.kind
    if (loginKind === this.data.loginKind) return
    this.setData({ loginKind, submitting: false })
  },

  onPlateInput(event) {
    this.setData({ plateNumber: event.detail.value.trim() })
  },

  onYardChange(event) {
    const yardIndex = Number(event.detail.value)
    const yard = (this.data.yards || [])[yardIndex]
    this.setData({
      yardIndex,
      yardName: yard ? (yard.cyName || '') : ''
    })
  },

  onAccountInput(event) {
    this.setData({ userAccount: event.detail.value.trim() })
  },

  onPasswordInput(event) {
    this.setData({ password: event.detail.value })
  },

  async login() {
    if (this.data.loginKind === 'driver') {
      await this.loginDriver()
      return
    }
    await this.loginStaff()
  },

  async loginDriver() {
    const plateNumber = String(this.data.plateNumber || '').trim()
    const yard = (this.data.yards || [])[this.data.yardIndex]
    if (!plateNumber) {
      wx.showToast({ title: '请输入车牌号', icon: 'none' })
      return
    }
    if (!yard || !yard.id) {
      wx.showToast({ title: '请选择堆场', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      const user = await request({
        url: '/navigation/auth/driver-login',
        method: 'POST',
        data: { plateNumber, cyId: yard.id },
        skipUnauthorizedRedirect: true
      })
      auth.setSession(user)
      getApp().globalData.user = user
      await switchToHome()
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
      this.setData({ submitting: false })
    }
  },

  async loginStaff() {
    const userAccount = String(this.data.userAccount || '').trim()
    const password = String(this.data.password || '')
    if (!userAccount) {
      wx.showToast({ title: '请输入账号', icon: 'none' })
      return
    }
    if (!password) {
      wx.showToast({ title: '请输入密码', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      const user = await request({
        url: '/navigation/auth/login',
        method: 'POST',
        data: { userAccount, password },
        skipUnauthorizedRedirect: true
      })
      auth.setSession(user)
      getApp().globalData.user = user
      await switchToHome()
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
      this.setData({ submitting: false })
    }
  }
})
