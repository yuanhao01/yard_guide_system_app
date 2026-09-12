const request = require('../../utils/request')
const locationUtil = require('../../utils/location')
const specialNav = require('../../utils/specialNav')
const vehicleLoader = require('../../utils/vehicleLoader')
const { createScopedThreejs } = require('../../libs/threejs/index.js')

Page({
  data: {
    sessionId: '',
    targetName: '',
    arriveTime: '--',
    accuracyText: '--',
    equipmentHint: '等待堆高机完成作业',
    stepLabel: '到位作业',
    parkTip: '请听从机械手指挥停车',
    confirming: false
  },

  onLoad(options) {
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    this.setData({
      sessionId: options.sessionId || '',
      targetName: decodeURIComponent(options.targetName || '--'),
      arriveTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`
    })
    this.loadSession()
    locationUtil.getCurrentLocation().then(loc => {
      const m = loc.accuracy != null ? Number(loc.accuracy) : null
      this.setData({
        accuracyText: m != null && isFinite(m) ? `约${m < 10 ? m.toFixed(1) : Math.round(m)}m` : '较弱'
      })
    }).catch(() => {})
    this.initScene()
  },

  onUnload() {
    if (this.vignette) {
      this.vignette.dispose()
      this.vignette = null
    }
  },

  async loadSession() {
    if (!this.data.sessionId) return
    try {
      this.session = await request({ url: `/navigation/mobile/sessions/${this.data.sessionId}` })
      const purpose = this.session.purpose || 'job'
      const hint = purpose === 'exit'
        ? '请按门岗指示离场'
        : '等待堆高机完成作业'
      this.setData({
        targetName: this.session.targetName || this.data.targetName,
        equipmentHint: hint,
        stepLabel: purpose === 'exit' ? '出场确认' : '到位作业',
        parkTip: purpose === 'exit' ? '请按门岗指示驶离' : '请听从机械手指挥停车'
      })
    } catch (error) {
      // 会话取不到时仍可确认到位
    }
  },

  initScene() {
    wx.createSelectorQuery()
      .select('#arriveCanvas')
      .fields({ node: true, size: true })
      .exec(async result => {
        const item = result && result[0]
        if (!item || !item.node) return
        try {
          const THREE = createScopedThreejs(item.node)
          const parts = await vehicleLoader.loadPair()
          const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
          const dpr = Math.min((windowInfo && windowInfo.pixelRatio) || 2, 2)
          this.vignette = vehicleLoader.createVignette(
            item.node, item.width, item.height, dpr, THREE, parts, 'arrive'
          )
        } catch (error) {
          console.warn('[arrive-confirm] 3d failed', error)
        }
      })
  },

  async confirmArrive() {
    if (!this.data.sessionId || this.data.confirming) return
    this.setData({ confirming: true })
    try {
      const session = await request({
        url: `/navigation/mobile/sessions/${this.data.sessionId}/arrive`,
        method: 'POST'
      })
      this.session = session || this.session
      const next = (session && session.nextAction) || (this.session && this.session.nextAction)
      if (next === 'safety') {
        wx.redirectTo({
          url: `/pages/safety-zone/index?jobSessionId=${this.data.sessionId}`
        })
        return
      }
      if (next === 'exit') {
        await this.startExitNav()
        return
      }
      wx.showToast({ title: '到位已确认', icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 600)
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    } finally {
      this.setData({ confirming: false })
    }
  },

  renavigate() {
    if (!this.data.sessionId) {
      wx.switchTab({ url: '/pages/home/index' })
      return
    }
    wx.redirectTo({ url: `/pages/navigation/index?sessionId=${this.data.sessionId}` })
  },

  async startExitNav() {
    try {
      wx.showLoading({ title: '规划出场' })
      const session = await specialNav.startSpecialNav({
        purpose: 'exit',
        parentSessionId: (this.session && this.session.jobSessionId) || this.data.sessionId,
        task: this.session
      })
      wx.hideLoading()
      wx.redirectTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
    } catch (error) {
      wx.hideLoading()
      wx.showToast({ title: error.message || '无法开始出场导航', icon: 'none' })
      setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 1200)
    }
  }
})
