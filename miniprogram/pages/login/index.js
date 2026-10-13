/**
 * 登录页：集卡司机用车牌+堆场进场，现场人员用电脑端账号登录。
 * 依赖：request（问后台）、auth（记住登录态）。
 */
const request = require('../../utils/request')
const auth = require('../../utils/auth')
const collabUnread = require('../../utils/collabUnread')
const features = require('../../utils/features')

const LAST_PLATE_KEY = 'nav_last_plate' // 本机上次登录的车牌，微信识别没回来前先顶上
const LAST_YARD_KEY = 'nav_last_cy_id' // 本机上次登录的堆场

/** 用 wx.login 拿一次性 code；拿不到就算了，不影响手动登录 */
function wxLoginCode() {
  return new Promise(resolve => {
    wx.login({
      success: res => resolve(res.code || ''),
      fail: () => resolve('')
    })
  })
}

/** 登录成功后切到首页（底部「导航/协同」那一栏） */
function switchToHome() {
  return new Promise((resolve, reject) => {
    wx.switchTab({
      url: '/pages/home/index', // 首页
      success: resolve, // 跳过去就算成功
      fail() {
        // 已经登录成功但页没打开，让司机再点一次
        reject(new Error('登录成功，但页面跳转失败，请重试'))
      }
    })
  })
}

// 注册登录这一页
Page({
  data: {
    loginKind: 'driver', // 当前选的是「集卡司机」还是「现场人员」
    plateNumber: '', // 司机输入的车牌
    yards: [], // 后台返回的堆场名单
    yardNames: [], // 给下拉框看的堆场名称
    yardIndex: -1, // 司机选中了第几个堆场，-1 表示还没选
    yardName: '', // 选中堆场的显示名
    yardsLoadError: '', // 堆场名单没拉下来时的原因
    prefillHint: '', // 自动填了上次车牌时给司机的提示
    userAccount: '', // 现场人员账号
    password: '', // 现场人员密码
    submitting: false, // 正在登录，用来转圈、防止连点
    statusBarHeight: 20 // 自定义顶栏要避开手机状态栏
  },

  /** 打开页面：已经登录就直接进首页，否则去拉堆场名单 */
  onLoad() {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20
    })
    // 手机里还有有效登录，不用再登
    if (auth.isLoggedIn()) {
      wx.switchTab({ url: '/pages/home/index' })
      return
    }
    // 先用本机记的车牌顶上，不用等网络
    const localPlate = wx.getStorageSync(LAST_PLATE_KEY) || ''
    if (localPlate) {
      this.setData({ plateNumber: localPlate, prefillHint: '已自动填入上次使用的车牌，换车请修改' })
    }
    // 堆场名单和微信识别一起问，都回来后再把上次的车牌、堆场填上
    Promise.all([this.loadYards(), this.identifyWechat()]).then(([, identity]) => {
      this.applyPrefill(identity)
    })
  },

  /** 凭微信身份问后台：这个微信上次用的车牌和堆场；失败返回空，司机手动填 */
  async identifyWechat() {
    const code = await wxLoginCode()
    if (!code) return null
    try {
      const identity = await request({
        url: '/navigation/auth/wx-identify', // 公开接口，不用先登录
        method: 'POST',
        data: { code },
        skipUnauthorizedRedirect: true
      })
      this.wxTicket = (identity && identity.wxTicket) || '' // 登录时带上，后台才能记住本次车牌
      return identity || null
    } catch (error) {
      console.warn('[login] 微信识别失败，改为手动填写', error.message)
      return null
    }
  },

  /** 把上次的车牌和堆场填进去；后台记录优先，本机记录兜底，司机已经在改就不动车牌 */
  applyPrefill(identity) {
    const plate = (identity && identity.plateNumber) || ''
    if (plate && !this.plateEdited) {
      this.setData({ plateNumber: plate, prefillHint: '已自动填入上次使用的车牌，换车请修改' })
    }
    const cyId = (identity && identity.lastCyId) || wx.getStorageSync(LAST_YARD_KEY)
    this.selectYardById(cyId)
  },

  /** 按堆场编号选中下拉项；名单里没有（已停用）就保持默认 */
  selectYardById(cyId) {
    if (!cyId) return
    const yards = this.data.yards || []
    const index = yards.findIndex(item => String(item.id) === String(cyId)) // id 是长整型，按字符串比
    if (index < 0) return
    this.setData({ yardIndex: index, yardName: yards[index].cyName || '' })
  },

  /** 向后台要启用中的堆场名单，给司机下拉选 */
  async loadYards() {
    try {
      const yards = await request({
        url: '/navigation/auth/yards', // 公开接口，不用先登录
        skipUnauthorizedRedirect: true // 失败不要再跳回登录页
      })
      const list = yards || [] // 没有数据就当空名单
      this.setData({
        yards: list, // 完整堆场对象，登录时要拿 id
        yardNames: list.map(item => item.cyName || String(item.id)), // 下拉显示名
        // 默认展示查询到的第一个堆场，不用司机再手动点开选择
        yardIndex: list.length ? 0 : -1,
        yardName: list.length ? (list[0].cyName || '') : '',
        yardsLoadError: '' // 清掉上次的失败原因
      })
      // 接口通了但库里没有启用堆场
      if (!list.length) {
        this.setData({
          yardsLoadError: '接口已通但未返回堆场，请查库表 t_yard_info 是否有 status=0（启用）的记录'
        })
      }
    } catch (error) {
      const msg = error.message || '堆场列表加载失败'
      this.setData({
        yards: [],
        yardNames: [],
        // 网络类错误补一句让人去对 config 里的地址
        yardsLoadError: msg.includes('fail') || msg.includes('timeout')
          ? `${msg}：请确认手机能访问 config.js 里的 apiBaseUrl`
          : msg
      })
      wx.showToast({ title: msg, icon: 'none', duration: 2800 })
    }
  },

  /** 点顶部「集卡司机 / 现场人员」切换登录方式 */
  switchKind(event) {
    const loginKind = event.currentTarget.dataset.kind // 点的是哪一种
    // 已经是这一种就不用刷新
    if (loginKind === this.data.loginKind) return
    this.setData({ loginKind, submitting: false }) // 换一种并解除转圈
  },

  /** 司机在改车牌 */
  onPlateInput(event) {
    this.plateEdited = true // 司机动过车牌，微信识别晚回来也不覆盖
    this.setData({ plateNumber: event.detail.value.trim(), prefillHint: '' }) // 去掉首尾空格
  },

  /** 司机在下拉里选了堆场 */
  onYardChange(event) {
    const yardIndex = Number(event.detail.value) // 选中的第几项
    const yard = (this.data.yards || [])[yardIndex] // 对应的堆场
    this.setData({
      yardIndex,
      yardName: yard ? (yard.cyName || '') : '' // 显示堆场名
    })
  },

  /** 现场人员在改账号 */
  onAccountInput(event) {
    this.setData({ userAccount: event.detail.value.trim() })
  },

  /** 现场人员在改密码 */
  onPasswordInput(event) {
    this.setData({ password: event.detail.value })
  },

  /** 点登录按钮：按当前选的种类走司机或现场人员 */
  async login() {
    if (this.data.loginKind === 'driver') {
      await this.loginDriver()
      return
    }
    await this.loginStaff()
  },

  /** 司机登录：车牌 + 堆场，不用预先建账号 */
  async loginDriver() {
    const plateNumber = String(this.data.plateNumber || '').trim() // 车牌
    const yard = (this.data.yards || [])[this.data.yardIndex] // 选中的堆场
    if (!plateNumber) {
      wx.showToast({ title: '请输入车牌号', icon: 'none' })
      return
    }
    if (!yard || !yard.id) {
      wx.showToast({ title: '请选择堆场', icon: 'none' })
      return
    }
    this.setData({ submitting: true }) // 按钮转圈，防连点
    try {
      const user = await request({
        url: '/navigation/auth/driver-login',
        method: 'POST',
        data: { plateNumber, cyId: yard.id, wxTicket: this.wxTicket || '' }, // 车牌、堆场编号、微信票据
        skipUnauthorizedRedirect: true // 账密错不要跳登录死循环
      })
      auth.setSession(user) // 把令牌和用户记到手机
      getApp().globalData.user = user // 同步到全局，首页马上能用
      this.wxTicket = '' // 票据后台已用掉
      wx.setStorageSync(LAST_PLATE_KEY, user.plateNumber || plateNumber) // 下次打开先填上
      wx.setStorageSync(LAST_YARD_KEY, yard.id)
      await features.refreshQuietly() // 进首页前拿到本堆场的模拟定位设置
      collabUnread.start()
      await switchToHome() // 进首页
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
      this.setData({ submitting: false }) // 失败才解除转圈，成功已经跳走
    }
  },

  /** 现场人员登录：用电脑端给的账号密码 */
  async loginStaff() {
    const userAccount = String(this.data.userAccount || '').trim() // 账号
    const password = String(this.data.password || '') // 密码
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
      await features.refreshQuietly()
      collabUnread.start()
      await switchToHome()
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
      this.setData({ submitting: false })
    }
  }
})
