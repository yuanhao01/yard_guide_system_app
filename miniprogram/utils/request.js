const config = require('../config')
const auth = require('./auth')
const DEVICE_ID_KEY = 'navigation_device_id'

function getDeviceId() {
  let deviceId = wx.getStorageSync(DEVICE_ID_KEY)
  if (!deviceId) {
    deviceId = `mini-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
    wx.setStorageSync(DEVICE_ID_KEY, deviceId)
  }
  return deviceId
}

function isPublicAuth(url) {
  return /^\/navigation\/auth\/(yards|driver-login|role-login|login)(\?|$)/.test(url || '')
}

function request(options) {
  const token = options.skipAuth || isPublicAuth(options.url) ? '' : auth.getToken()
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.apiBaseUrl}${options.url}`,
      method: options.method || 'GET',
      data: options.data,
      header: {
        'content-type': 'application/json;charset=UTF-8',
        'Device-Id': getDeviceId(),
        ...(token ? { satoken: token } : {}),
        ...(options.header || {})
      },
      timeout: 15000,
      success(response) {
        const body = response.data || {}
        const tokenMissing = /有效\s*token/i.test(String(body.msg || ''))
        if (response.statusCode === 401 || body.code === 401 || tokenMissing) {
          if (!options.skipUnauthorizedRedirect) {
            auth.clearSession()
            wx.reLaunch({ url: '/pages/login/index' })
          }
          reject(new Error(body.msg || '登录已过期'))
          return
        }
        if (response.statusCode < 200 || response.statusCode >= 300 || body.code !== 200) {
          reject(new Error(body.msg || `请求失败（${response.statusCode}）`))
          return
        }
        resolve(body.data)
      },
      fail(error) {
        reject(new Error(error.errMsg || '网络连接失败'))
      }
    })
  })
}

module.exports = request
