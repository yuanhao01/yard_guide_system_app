const request = require('../../utils/request')
const locationUtil = require('../../utils/location')
const specialNav = require('../../utils/specialNav')
const vehicleLoader = require('../../utils/vehicleLoader')
const { createScopedThreejs } = require('../../libs/threejs/index.js')

function verifyLabelFromName(name) {
  const raw = String(name || '').trim()
  if (!raw || raw === '--') return '--'
  return raw.replace(/\s*·\s*/g, '-').replace(/\s+/g, '')
}

Page({
  data: {
    statusBarHeight: 20,
    sessionId: '',
    targetName: '',
    verifyLabel: '--',
    arriveTime: '--',
    accuracyText: '--',
    equipmentHint: '等待堆高机完成作业',
    stepLabel: '到位作业',
    parkTip: '请听从机械手指挥停车',
    confirmBtnText: '扫码确认到位',
    confirmNeedScan: true,
    confirming: false,
    mapLoading: true
  },

  onLoad(options) {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const now = new Date()
    const pad = n => String(n).padStart(2, '0')
    const targetName = decodeURIComponent(options.targetName || '--')
    this.setData({
      statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20,
      sessionId: options.sessionId || '',
      targetName,
      verifyLabel: verifyLabelFromName(targetName),
      arriveTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`
    })
    this.loadSession().finally(() => this.initScene())
    locationUtil.getCurrentLocation().then(loc => {
      const m = loc.accuracy != null ? Number(loc.accuracy) : null
      this.setData({
        accuracyText: m != null && isFinite(m)
          ? (m < 10 ? `${m.toFixed(1)}m` : `${Math.round(m)}m`)
          : '较弱'
      })
    }).catch(() => {})
  },

  onUnload() {
    if (this.vignette) {
      this.vignette.dispose()
      this.vignette = null
    }
  },

  goBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/home/index' })
    })
  },

  async loadSession() {
    if (!this.data.sessionId) return
    try {
      this.session = await request({ url: `/navigation/mobile/sessions/${this.data.sessionId}` })
      const purpose = this.session.purpose || 'job'
      const name = this.session.targetName || this.data.targetName
      const hint = purpose === 'exit'
        ? '请按门岗指示离场'
        : (this.session.equipmentName
          ? `${this.session.equipmentName} 正在作业`
          : '等待堆高机完成作业')
      this.setData({
        targetName: name,
        verifyLabel: verifyLabelFromName(name),
        equipmentHint: hint,
        stepLabel: purpose === 'exit' ? '出场确认' : '到位作业',
        parkTip: purpose === 'exit' ? '请按门岗指示驶离' : '请听从机械手指挥停车',
        confirmBtnText: purpose === 'exit' ? '确认离场' : '扫码确认到位',
        confirmNeedScan: purpose !== 'exit'
      })
    } catch (error) {
      // 会话取不到时仍可确认到位
    }
  },

  async initScene() {
    return new Promise(resolve => {
      wx.createSelectorQuery()
        .select('#arriveCanvas')
        .fields({ node: true, size: true })
        .exec(async result => {
          const item = result && result[0]
          if (!item || !item.node) {
            this.setData({ mapLoading: false })
            resolve()
            return
          }
          try {
            const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
            const dpr = Math.min((windowInfo && windowInfo.pixelRatio) || 2, 2.5)
            const THREE = createScopedThreejs(item.node)
            const parts = await vehicleLoader.loadPair()
            this.vignette = vehicleLoader.createVignette(
              item.node,
              item.width,
              item.height,
              dpr,
              THREE,
              parts,
              'arrive'
            )
          } catch (error) {
            console.warn('[arrive-confirm] vignette failed', error)
          } finally {
            this.setData({ mapLoading: false })
            resolve()
          }
        })
    })
  },

  onConfirmTap() {
    if (this.data.confirmNeedScan) {
      this.scanConfirmArrive()
    } else {
      this.confirmArrive()
    }
  },

  scanConfirmArrive() {
    if (!this.data.sessionId || this.data.confirming) return
    wx.scanCode({
      scanType: ['qrCode'],
      success: res => this.verifyScanThenConfirm(res.result || ''),
      fail: err => {
        if (err && /cancel/i.test(String(err.errMsg || ''))) return
        this.confirmArrive()
      }
    })
  },

  async verifyScanThenConfirm(content) {
    const text = String(content || '').trim()
    if (!text) {
      wx.showToast({ title: '未识别到二维码', icon: 'none' })
      return
    }
    try {
      const target = await request({
        url: '/navigation/mobile/scan',
        method: 'POST',
        data: { content: text }
      })
      const session = this.session
      if (session && target) {
        const sameBlock = !session.targetBlockId || !target.blockId
          || String(session.targetBlockId) === String(target.blockId)
        const sameSlot = !session.targetSlot || !target.slot
          || String(session.targetSlot) === String(target.slot)
        if (!sameBlock || !sameSlot) {
          wx.showModal({
            title: '箱区不一致',
            content: `扫码为 ${target.targetName || '其他位置'}，与当前任务 ${this.data.targetName} 不一致，仍要确认到位吗？`,
            confirmText: '仍要确认',
            success: r => {
              if (r.confirm) this.confirmArrive()
            }
          })
          return
        }
      }
      await this.confirmArrive()
    } catch (error) {
      wx.showModal({
        title: '二维码无效',
        content: error.message || '无法解析该二维码，是否直接确认到位？',
        confirmText: '直接确认',
        success: r => {
          if (r.confirm) this.confirmArrive()
        }
      })
    }
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
    const session = await specialNav.startSpecialNav({
      purpose: 'exit',
      task: this.session,
      parentSessionId: specialNav.collabSessionId(this.session)
    })
    wx.redirectTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
  }
})
