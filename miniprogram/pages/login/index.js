const request = require('../../utils/request')
const auth = require('../../utils/auth')

function normalizeAccessCode(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 6)
}

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
    accessCode: '',
    plateNumber: '',
    submitting: false
  },

  onLoad() {
    if (auth.isLoggedIn()) {
      wx.switchTab({ url: '/pages/home/index' })
    }
  },

  onAccessCodeInput(event) {
    const accessCode = normalizeAccessCode(event.detail.value)
    this.setData({ accessCode })
    return accessCode
  },

  onPlateNumberInput(event) {
    this.setData({ plateNumber: event.detail.value.trim().toUpperCase() })
  },

  async login() {
    const accessCode = normalizeAccessCode(this.data.accessCode)
    const plateNumber = String(this.data.plateNumber || '').trim().toUpperCase()
    this.setData({ accessCode, plateNumber })
    if (!/^\d{6}$/.test(accessCode)) {
      wx.showToast({ title: '请输入6位堆场使用码', icon: 'none' })
      return
    }
    if (!plateNumber) {
      wx.showToast({ title: '请输入车牌号', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      const user = await request({
        url: '/navigation/auth/driver-login',
        method: 'POST',
        data: { accessCode, plateNumber },
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
