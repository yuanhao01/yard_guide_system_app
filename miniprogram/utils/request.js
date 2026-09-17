/**
 * 统一向后台发请求：自动拼接口地址、带上登录令牌和本机编号。
 * 令牌失效会清登录态并跳回登录页。
 * 依赖：config（接口地址）、auth（令牌）。
 */
const config = require('../config')
const auth = require('./auth')
// 本机编号在手机里的存放名字，用来让后台认出是同一台手机
const DEVICE_ID_KEY = 'navigation_device_id'

/** 取出或生成这台手机的编号，每次请求都带上，方便后台区分设备 */
function getDeviceId() {
  // 先看手机里有没有已经编过号
  let deviceId = wx.getStorageSync(DEVICE_ID_KEY)
  // 没有就现场编一个，并记住
  if (!deviceId) {
    // 用时间和随机数拼一个不会撞车的编号
    deviceId = `mini-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
    // 存到手机，下次还用这个号
    wx.setStorageSync(DEVICE_ID_KEY, deviceId)
  }
  // 返回本机编号
  return deviceId
}

/** 登录、取堆场列表这类公开接口不需要带令牌 */
function isPublicAuth(url) {
  // 匹配登录和堆场列表这几个不用登录就能访问的地址
  return /^\/navigation\/auth\/(yards|driver-login|login)(\?|$)/.test(url || '')
}

/** 发一次后台请求；成功返回业务数据，失败抛出中文错误给页面提示 */
function request(options) {
  // 公开接口或明确说跳过鉴权时不带头；其它请求带上登录令牌
  const token = options.skipAuth || isPublicAuth(options.url) ? '' : auth.getToken()
  // 用 Promise 包一层，页面才能用 await 等结果
  return new Promise((resolve, reject) => {
    // 真正发出网络请求
    wx.request({
      url: `${config.apiBaseUrl}${options.url}`, // 完整接口地址
      method: options.method || 'GET', // 没写方法就按查询处理
      data: options.data, // 要提交给后台的内容
      header: {
        'content-type': 'application/json;charset=UTF-8', // 告诉后台我们发的是 JSON
        'Device-Id': getDeviceId(), // 本机编号
        ...(token ? { satoken: token } : {}), // 有令牌才带头
        ...(options.header || {}) // 页面还可以再补自己的头
      },
      timeout: 15000, // 超过 15 秒还没回就算失败
      success(response) {
        // 取出后台返回的整包内容
        const body = response.data || {}
        // 后台有时用「有效 token」这类文案表示登录过期
        const tokenMissing = /有效\s*token/i.test(String(body.msg || ''))
        // 未登录或令牌失效：清本地并赶回登录页
        if (response.statusCode === 401 || body.code === 401 || tokenMissing) {
          // 登录页自己查堆场失败时不要再跳登录，避免死循环
          if (!options.skipUnauthorizedRedirect) {
            // 清掉过期登录态
            auth.clearSession()
            // 打开登录页
            wx.reLaunch({ url: '/pages/login/index' })
          }
          // 告诉页面登录已过期
          reject(new Error(body.msg || '登录已过期'))
          return
        }
        // HTTP 不是成功，或业务码不是 200，都当失败
        if (response.statusCode < 200 || response.statusCode >= 300 || body.code !== 200) {
          // 把后台说的原因抛给页面弹提示
          reject(new Error(body.msg || `请求失败（${response.statusCode}）`))
          return
        }
        // 成功：只把业务数据交给页面
        resolve(body.data)
      },
      fail(error) {
        // 网络不通或超时
        reject(new Error(error.errMsg || '网络连接失败'))
      }
    })
  })
}

// 各页面直接调用这个函数发请求
module.exports = request
