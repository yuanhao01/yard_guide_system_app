/**
 * 任务确认：确认目的贝位，然后开导航。
 * 不再分提空/提重/还空/还重，到位确认后就结束，验箱、出场由首页单独发起。
 * 依赖：request、location（取起点）、auth。
 */
const request = require('../../utils/request')
const locationUtil = require('../../utils/location')
const auth = require('../../utils/auth')

/** 场区名改成「区」 */
function displayAreaText(text) {
  return String(text || '').replace(/座场区/g, '区').replace(/座/g, '区')
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

  /** 从全局取出刚选的贝位；没有就退回去 */
  onLoad() {
    const selection = getApp().globalData.selectedTarget
    if (!selection) {
      wx.showToast({ title: '请先选择目的贝位', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1200)
      return
    }
    const user = auth.getUser() || {}
    // 场区名改成「区」再显示
    const target = selection.target ? {
      ...selection.target,
      targetName: displayAreaText(selection.target.targetName),
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

  /** 回上一页重新选贝位 */
  goBack() {
    wx.navigateBack()
  }
})
