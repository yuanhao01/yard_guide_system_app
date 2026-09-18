/**
 * 到位确认：到贝位后直接确认，再去验箱或出场。
 * 依赖：request、location、specialNav、vehicleLoader（画集卡小景）、threejs。
 */
const request = require('../../utils/request')
const locationUtil = require('../../utils/location')
const specialNav = require('../../utils/specialNav')
const vehicleLoader = require('../../utils/vehicleLoader')
const { createScopedThreejs } = require('../../libs/threejs/index.js')

/** 把目的地名收成校验条上能显示的短标签 */
function verifyLabelFromName(name) {
  const raw = String(name || '').trim()
  if (!raw || raw === '--') return '--'
  return raw.replace(/\s*·\s*/g, '-').replace(/\s+/g, '')
}

Page({
  data: {
    statusBarHeight: 20, // 顶栏避开手机状态栏
    sessionId: '', // 这一趟导航编号
    targetName: '', // 目的地名
    verifyLabel: '--', // 箱区校验条上的字
    arriveTime: '--', // 到位时间
    accuracyText: '--', // 定位精度
    equipmentHint: '等待堆高机完成作业', // 机械状态说明
    stepLabel: '到位作业', // 底部第三步名字
    parkTip: '请听从机械手指挥停车', // 停车提示
    confirmBtnText: '确认到位', // 主按钮字
    confirming: false, // 正在提交确认
    mapLoading: true, // 小景还在加载
    sceneFailed: false // 小景绘制失败，用文字兜底
  },

  /** 进页：记下会话、时间，拉会话详情，再画集卡小景 */
  onLoad(options) {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const now = new Date()
    const pad = n => String(n).padStart(2, '0') // 时间个位数补 0
    const targetName = decodeURIComponent(options.targetName || '--')
    this.setData({
      statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20,
      sessionId: options.sessionId || '',
      targetName,
      verifyLabel: verifyLabelFromName(targetName),
      arriveTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`
    })
    this.loadSession().finally(() => this.initScene()) // 先拉会话再画图
    // 顺便取一次精度给页面看
    locationUtil.getCurrentLocation().then(loc => {
      const m = loc.accuracy != null ? Number(loc.accuracy) : null
      this.setData({
        accuracyText: m != null && isFinite(m)
          ? (m < 10 ? `${m.toFixed(1)}m` : `${Math.round(m)}m`)
          : '较弱'
      })
    }).catch(() => {})
  },

  /** 离开页时拆掉小景，释放显卡资源 */
  onUnload() {
    if (this.vignette) {
      this.vignette.dispose()
      this.vignette = null
    }
  },

  /** 返回上一页；没有上一页就回首页 */
  goBack() {
    wx.navigateBack({
      fail: () => wx.switchTab({ url: '/pages/home/index' })
    })
  },

  /** 拉这一趟详情，按作业/出场换提示和按钮 */
  async loadSession() {
    if (!this.data.sessionId) return
    try {
      this.session = await request({ url: `/navigation/mobile/sessions/${this.data.sessionId}` })
      const purpose = this.session.purpose || 'job'
      const name = this.session.targetName || this.data.targetName
      const hint = purpose === 'exit'
        ? '请按门岗指示离场'
        : (this.session.equipmentName
          ? `等待${this.session.equipmentName}完成作业`
          : '等待作业机械完成作业')
      this.setData({
        targetName: name,
        verifyLabel: verifyLabelFromName(name),
        equipmentHint: hint,
        stepLabel: purpose === 'exit' ? '出场确认' : '到位作业',
        parkTip: purpose === 'exit' ? '请按门岗指示驶离' : '请听从机械手指挥停车',
        confirmBtnText: purpose === 'exit' ? '确认离场' : '确认到位'
      })
    } catch (error) {
      // 会话取不到时仍可确认到位
    }
  },

  /** 在画布上画一辆集卡小景，给司机看「车已经停在贝位」 */
  async initScene() {
    return new Promise(resolve => {
      const query = wx.createSelectorQuery()
      query.select('#arriveCanvas').fields({ node: true, size: true })
      // 有些机型这时候 canvas 节点自身的 size 还没结算出来（返回 0），
      // 用外层容器的实际渲染尺寸兜底，避免拿 0 去初始化渲染器导致画面全空。
      query.select('.scene-wrap').boundingClientRect()
      query.exec(async result => {
        const item = result && result[0]
        const wrap = result && result[1]
        if (!item || !item.node) {
          console.warn('[arrive-confirm] canvas 节点未取到')
          this.setData({ mapLoading: false })
          resolve()
          return
        }
        const width = item.width || (wrap && wrap.width) || 0
        const height = item.height || (wrap && wrap.height) || 0
        if (!width || !height) {
          console.warn('[arrive-confirm] canvas 尺寸为 0，跳过小景绘制', width, height)
          this.setData({ mapLoading: false })
          resolve()
          return
        }
        try {
          const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
          const dpr = Math.min((windowInfo && windowInfo.pixelRatio) || 2, 2.5) // 屏幕清晰度
          const THREE = createScopedThreejs(item.node) // 这块画布自己的三维引擎
          const parts = await vehicleLoader.loadPair() // 集卡、堆高机网格
          this.vignette = vehicleLoader.createVignette(
            item.node,
            width,
            height,
            dpr,
            THREE,
            parts,
            'arrive' // 到位场景：车道+集卡
          )
        } catch (error) {
          console.warn('[arrive-confirm] vignette failed', error && (error.stack || error.message || error))
          this.setData({ sceneFailed: true })
        } finally {
          this.setData({ mapLoading: false })
          resolve()
        }
      })
    })
  },

  /** 主按钮：直接确认到位/离场，不用扫码 */
  onConfirmTap() {
    this.confirmArrive()
  },

  /** 告诉后台已经到位，然后按下一步去验箱、出场或回首页 */
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

  /** 走错了，回到这一趟导航 */
  renavigate() {
    if (!this.data.sessionId) {
      wx.switchTab({ url: '/pages/home/index' })
      return
    }
    wx.redirectTo({ url: `/pages/navigation/index?sessionId=${this.data.sessionId}` })
  },

  /** 验箱之后直接开出场导航 */
  async startExitNav() {
    const session = await specialNav.startSpecialNav({
      purpose: 'exit',
      task: this.session,
      parentSessionId: specialNav.collabSessionId(this.session)
    })
    wx.redirectTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
  }
})
