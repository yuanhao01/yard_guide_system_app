/**
 * 任务确认：确认目的贝位，然后开导航。
 * 不再分提空/提重/还空/还重，到位确认后就结束，验箱、出场由首页单独发起。
 * 依赖：request、location（取起点）、auth。
 */
const request = require('../../utils/request')
const locationUtil = require('../../utils/location')
const auth = require('../../utils/auth')
const { loginDriver } = require('../../utils/driverLogin')

/** 场区名改成「区」 */
function displayAreaText(text) {
  return String(text || '').replace(/座场区/g, '区').replace(/座/g, '区')
}

/** 贝位标题显示成「A1区-02贝」；没有场区或贝号（验箱区、出场口等）就用原名称 */
function bayTitleOf(target) {
  const block = displayAreaText(target.blockName)
  if (block && target.slot) return `${block}-${target.slot}贝`
  return displayAreaText(target.targetName)
}

/** 微信扫一扫打开时取二维码原文：普通链接码在 q 里（已编码），也兼容直接带 token */
function scanContentOf(options) {
  if (options && options.q) return decodeURIComponent(options.q)
  if (options && options.token) return `token=${options.token}`
  return ''
}

/** 取链接里的查询参数（已解码） */
function queryOf(content) {
  const params = {}
  const index = String(content || '').indexOf('?')
  if (index < 0) return params
  content.slice(index + 1).split(/[&#]/).forEach(pair => {
    const eq = pair.indexOf('=')
    if (eq <= 0) return
    try {
      params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1))
    } catch (ignore) {
      // 编码坏了的参数跳过
    }
  })
  return params
}

/** 车牌比较：去空格、统一大写 */
function samePlate(left, right) {
  const norm = value => String(value || '').replace(/\s/g, '').toUpperCase()
  return norm(left) === norm(right)
}

/**
 * 作业小票带了车号和堆场编号：按小票上的车辆登录。
 * 没登录、或登录的是别的车/别的堆场就重新登录；现场人员账号保持不动。
 */
async function ensureTicketDriver(plate, cyCode) {
  const user = auth.isLoggedIn() ? (auth.getUser() || {}) : null
  const isDriver = user && (user.userKind === 'driver' || user.plateLogin)
  if (user && !isDriver) return
  const yards = await request({ url: '/navigation/auth/yards', skipUnauthorizedRedirect: true }) || []
  const yard = yards.find(item => String(item.cyCode || '').toUpperCase() === String(cyCode).trim().toUpperCase())
  if (!yard) {
    throw new Error(`堆场 ${cyCode} 不存在或未启用`)
  }
  if (user && samePlate(user.plateNumber, plate) && String(user.currentCyId) === String(yard.id)) return
  if (user) auth.clearSession() // 换车或换堆场，旧登录作废
  await loginDriver({ plateNumber: String(plate).trim(), cyId: yard.id })
}

Page({
  data: {
    target: null, // 目的贝位
    sourceType: 0, // 0 手动选，1 扫码
    starting: false, // 正在开导航
    yardName: '', // 当前堆场名
    forkliftInfo: null, // 这块场区负责的叉车
    distanceText: '计算中' // 从当前位置沿路线到贝位还有多远
  },

  /** 微信扫码进来就按二维码解析贝位；否则从全局取出刚选的贝位，没有就退回去 */
  onLoad(options) {
    const content = scanContentOf(options)
    if (content) {
      this.openFromScan(content)
      return
    }
    const selection = getApp().globalData.selectedTarget
    if (!selection) {
      wx.showToast({ title: '请先选择目的贝位', icon: 'none' })
      setTimeout(() => this.goBack(), 1200)
      return
    }
    this.showSelection(selection)
  },

  /**
   * 微信扫一扫直接打开。作业小票码带车号和堆场，自动按小票车辆登录；
   * 贝位码没带车号，没登录就先去登录，登录后再回到这里。现场岗位不走扫码导航。
   */
  async openFromScan(content) {
    const app = getApp()
    const params = queryOf(content)
    if (params.plate && params.cy) {
      wx.showLoading({ title: '登录中' })
      try {
        await ensureTicketDriver(params.plate, params.cy)
      } catch (error) {
        wx.hideLoading()
        wx.showModal({
          title: '自动登录失败',
          content: `${error.message || '登录失败'}，请手动登录后重新扫码`,
          showCancel: false,
          success: () => wx.reLaunch({ url: '/pages/login/index' })
        })
        return
      }
      wx.hideLoading()
    }
    if (!auth.isLoggedIn()) {
      app.globalData.pendingScan = content // 登录页登录成功后取走
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    if (auth.isFieldRole()) {
      wx.showToast({ title: '现场岗位不需要扫码导航', icon: 'none' })
      setTimeout(() => this.goBack(), 1200)
      return
    }
    app.globalData.pendingScan = content // 令牌过期会被请求跳去登录，先留着
    wx.showLoading({ title: '识别中' })
    try {
      const target = await request({
        url: '/navigation/mobile/scan',
        method: 'POST',
        data: { content } // 二维码原文交给后台解析
      })
      app.globalData.pendingScan = null
      this.showSelection({ target, sourceType: 1 }) // 1 表示来自扫码
    } catch (error) {
      if (!auth.isLoggedIn()) return // 令牌过期，已跳登录页，登录后接着解析
      app.globalData.pendingScan = null
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
      setTimeout(() => this.goBack(), 2500)
    } finally {
      wx.hideLoading()
    }
  },

  /** 把选中的贝位显示出来，并拉叉车和距离 */
  showSelection(selection) {
    const user = auth.getUser() || {}
    // 场区名改成「区」再显示
    const target = selection.target ? {
      ...selection.target,
      targetName: bayTitleOf(selection.target),
      blockName: displayAreaText(selection.target.blockName)
    } : selection.target
    this.setData({
      ...selection,
      target,
      yardName: user.currentCyName || user.yardName || ''
    })
    this.loadForkliftInfo(target && target.blockId) // 拉这块场区的叉车
    this.loadDistance(target && target.id) // 算当前位置到贝位的路线距离
  },

  /** 用当前位置预览一次路线，显示到贝位的真实行驶距离；取不到就显示 -- */
  async loadDistance(targetId) {
    if (!targetId) {
      this.setData({ distanceText: '--' })
      return
    }
    try {
      const location = await locationUtil.getCurrentLocation()
      const route = await request({
        url: '/navigation/mobile/preview',
        method: 'POST',
        data: { targetId, longitude: location.longitude, latitude: location.latitude }
      })
      const meters = Number(route && route.distanceMeters)
      this.setData({ distanceText: Number.isFinite(meters) && meters > 0 ? `${Math.round(meters)} 米` : '--' })
    } catch (error) {
      this.setData({ distanceText: '--' })
    }
  },

  /** 按场区查负责的叉车，给司机看联系谁 */
  async loadForkliftInfo(blockId) {
    if (!blockId) {
      this.setData({ forkliftInfo: null })
      return
    }
    try {
      const forklifts = await request({ url: `/basics/forklift/by-block/${encodeURIComponent(blockId)}` })
      this.setData({ forkliftInfo: (forklifts && forklifts.length) ? forklifts[0] : null })
    } catch (error) {
      this.setData({ forkliftInfo: null })
    }
  },

  /** 取当前位置并开一趟作业导航 */
  async startNavigation() {
    if (!this.data.target || !this.data.target.id) {
      wx.showToast({ title: '请先确认目的贝位', icon: 'none' })
      return
    }
    this.setData({ starting: true })
    try {
      const location = await locationUtil.getCurrentLocation() // 规划起点
      const session = await request({
        url: '/navigation/mobile/sessions',
        method: 'POST',
        data: {
          targetId: this.data.target.id, // 目的贝位
          sourceType: this.data.sourceType, // 手动或扫码
          purpose: 'job', // 作业导航
          cntrCondition: '好箱',
          longitude: location.longitude,
          latitude: location.latitude,
          direction: locationUtil.headingOf(location)
        }
      })
      getApp().globalData.selectedTarget = null // 用完清掉，避免下次误用
      wx.redirectTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
    } catch (error) {
      // 已有进行中任务：直接接着那一趟走
      if (/未完成|进行中/.test(error.message || '')) {
        try {
          const current = await request({ url: '/navigation/mobile/sessions/current' })
          if (current && current.id) {
            wx.redirectTo({ url: `/pages/navigation/index?sessionId=${current.id}` })
            return
          }
        } catch (ignore) {
          // 回落到下方提示
        }
        wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
        return
      }
      const message = error.message || '无法开始导航'
      const needSetting = /定位权限|定位服务|请在设置中允许|auth deny/i.test(message)
      wx.showModal({
        title: '无法开始导航',
        content: message,
        confirmText: needSetting ? '打开设置' : '知道了',
        showCancel: needSetting,
        success: result => {
          if (needSetting && result.confirm) {
            wx.openSetting()
          }
        }
      })
    } finally {
      this.setData({ starting: false })
    }
  },

  /** 回上一页重新选贝位；扫码直接打开时没有上一页，回首页 */
  goBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/home/index' })
  }
})
