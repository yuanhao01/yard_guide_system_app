/**
 * 首页：司机看进行中导航、去作业贝位、一键去验箱区/出场口；现场岗位看协同群列表。
 * 验箱、出场不再跟在作业后面自动接续，司机需要时在首页点一下，按当前位置规划。
 * 依赖：request、auth、specialNav（开验箱/出场导航）。
 */
const request = require('../../utils/request')
const auth = require('../../utils/auth')
const specialNav = require('../../utils/specialNav')
const collabUnread = require('../../utils/collabUnread')

/** 首页「剩余约 xx 米」用哪个数：规划很长但沿路只剩很短时，优先用规划全长，避免刚出发就显示快到了 */
function remainMetersText(session) {
  const planned = Number(session && session.route && session.route.distanceMeters) // 规划出来的全长
  const along = Number(session && session.remainingDistanceMeters) // 沿当前折线还剩多少
  // 规划超过 500 米、沿路却不到 150，多半是折线被裁短了，用全长
  if (Number.isFinite(planned) && planned > 500 && (!Number.isFinite(along) || along < 150)) {
    return String(Math.round(planned))
  }
  if (Number.isFinite(along) && along > 0) return String(Math.round(along))
  if (Number.isFinite(planned) && planned > 0) return String(Math.round(planned))
  return '--'
}

/** 会话还在路上（导航中 / 待确认到达）才算进行中 */
function isActive(session) {
  return Boolean(session) && (session.status === 0 || session.status === 1)
}

/** 已到位、协同群还开着的作业会话，验箱/出场要挂在它下面，协同群才能对上并在出场后解散 */
function openJobOf(session) {
  if (!session || isActive(session)) return null
  return (!session.purpose || session.purpose === 'job') ? session : null
}

/** 目的地用途的中文名 */
const PURPOSE_NAME = { job: '作业贝位', safety: '验箱区', exit: '出场口' }

/** 根据进行中的会话，写出首页橙色卡上的标题、说明和按钮字 */
function describeSession(session) {
  if (!isActive(session)) {
    return { currentTitle: '', currentDetail: '', currentAction: '' }
  }
  return {
    currentTitle: `前往 ${session.targetName || PURPOSE_NAME[session.purpose] || ''}`,
    currentDetail: `剩余约 ${remainMetersText(session)} 米`,
    currentAction: '继续导航 →'
  }
}

/** 把后台协同群整理成首页那张深蓝卡片要的字段 */
function mapGroupCard(group) {
  const members = group.members || [] // 群成员
  const unread = Number(group.unreadCount) || 0 // 未读条数
  return {
    id: group.id, // 群编号
    sessionId: group.sessionId, // 对应哪一趟导航
    title: group.groupName || group.taskLabel || '现场协同群', // 卡片标题
    desc: group.lastMsgPreview // 最后一句预览
      || group.statusText
      || (group.onlineCount != null
        ? `${group.onlineCount}/${group.memberCount || group.onlineCount}人在线`
        : '点进群聊查看现场成员'),
    lastMsgTimeText: group.lastMsgTimeText || '', // 最后消息时间
    unreadCount: unread, // 未读数字，用来决定红点显不显
    unreadText: unread > 99 ? '99+' : String(unread), // 红点上的字
    memberText: members.map(item => item.memberName || item.displayName).filter(Boolean).join(' · ') // 成员名串
  }
}

/** 底部第一个页签：现场岗位写成「协同」，司机写成「导航」 */
function syncHomeTab(isFieldRole) {
  wx.setTabBarItem({
    index: 0,
    text: isFieldRole ? '协同' : '导航'
  })
}

/** 把当前用户、堆场、岗位写到首页顶部 */
function applyUserContext(page) {
  const user = auth.getUser() || {} // 当前用户
  const yards = user.accessibleYards || [] // 能进的堆场
  const yard = yards.find(item => String(item.id) === String(user.currentCyId)) // 当前堆场
  const isFieldRole = auth.isFieldRole()
  syncHomeTab(isFieldRole)
  page.setData({
    isFieldRole, // 决定下面画协同列表还是选贝位
    canSwitchYard: auth.canSwitchYard(), // 车牌进场不能换堆场
    yards,
    yardName: (yard && yard.cyName) || user.yardName || '',
    roleLabel: user.roleLabel || '', // 岗位名
    displayName: user.displayName || user.userName || user.userAccount || '' // 顶部大字
  })
}

Page({
  data: {
    isFieldRole: false, // 现场岗位首页
    canSwitchYard: false, // 显示切换堆场
    yards: [], // 能进的堆场
    roleLabel: '', // 岗位名
    displayName: '', // 顶部显示名
    yardName: '', // 当前堆场名
    currentSession: null, // 司机进行中的那一趟（只放还在路上的）
    specialLoading: '', // 正在规划的一键导航：safety / exit
    collabGroup: null, // 司机这一趟对应的协同群
    collabGroups: [], // 现场岗位的群列表
    currentTitle: '', // 橙色卡标题
    currentDetail: '', // 橙色卡说明
    currentAction: '', // 橙色卡右下角按钮字
    statusBarHeight: 20 // 自定义顶栏避开手机状态栏
  },

  onLoad() {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20
    })
  },

  /** 每次回到首页：没登录赶回登录，有登录就刷新任务/群 */
  onShow() {
    if (!auth.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    applyUserContext(this)
    collabUnread.start()
    if (!this._offUnread) {
      this._offUnread = collabUnread.subscribe(snapshot => this.applyUnreadSnapshot(snapshot))
    }
    this.refresh()
  },

  onUnload() {
    if (this._offUnread) {
      this._offUnread()
      this._offUnread = null
    }
  },

  /** 未读仓库有更新时，只改卡片右上角数字，不整页重拉 */
  applyUnreadSnapshot(snapshot) {
    if (!collabUnread.isReady()) return
    const groups = (snapshot && snapshot.groups) || []
    if (this.data.isFieldRole || auth.isFieldRole()) {
      this.setData({
        collabGroups: groups.map(mapGroupCard)
      })
      return
    }
    const current = this.data.collabGroup
    if (!current) return
    const next = groups.find(item => String(item.id) === String(current.id))
    if (next) {
      this.setData({
        collabGroup: Object.assign({}, current, mapGroupCard(next))
      })
    }
  },

  /** 下拉刷新 */
  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh())
  },

  /** 按身份刷新：岗位拉群，司机拉进行中导航 */
  async refresh() {
    if (this.data.isFieldRole || auth.isFieldRole()) {
      await this.refreshRoleHome()
      return
    }
    await this.refreshDriverHome()
  },

  /** 现场岗位首页：清掉司机那张橙色卡，只拉自己的协同群 */
  async refreshRoleHome() {
    applyUserContext(this)
    this.setData({
      currentSession: null,
      collabGroup: null,
      currentTitle: '',
      currentDetail: '',
      currentAction: ''
    })
    try {
      const groups = await collabUnread.refresh({ silent: true })
      this.setData({
        collabGroups: (groups || []).map(mapGroupCard)
      })
    } catch (error) {
      this.setData({ collabGroups: [] })
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  /** 点「切换」换当前堆场 */
  chooseYard() {
    const yards = this.data.yards || []
    if (yards.length < 2) return
    wx.showActionSheet({
      itemList: yards.map(item => item.cyName || String(item.id)), // 弹出堆场名
      success: async result => {
        const yard = yards[result.tapIndex] // 点中的堆场
        // 点的就是当前堆场，不用换
        if (!yard || String(yard.id) === String((auth.getUser() || {}).currentCyId)) return
        try {
          wx.showLoading({ title: '切换中' })
          const user = await request({
            url: '/navigation/auth/switch-yard',
            method: 'POST',
            data: { cyId: yard.id }
          })
          const token = user.token || auth.getToken() // 有的接口会换新令牌
          auth.setSession(Object.assign({}, auth.getUser(), user, { token })) // 合并进本地用户
          getApp().globalData.user = auth.getUser()
          applyUserContext(this)
          await this.refresh() // 换堆场后任务/群都要重拉
        } catch (error) {
          wx.showToast({ title: error.message || '切换失败', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      }
    })
  },

  /** 司机首页：拉进行中会话和对应协同群 */
  async refreshDriverHome() {
    applyUserContext(this)
    try {
      const currentSession = await request({ url: '/navigation/mobile/sessions/current' })
      let collabGroup = null
      // 协同群只建在作业会话上：单独发起的验箱/出场没挂作业时不显示
      const showCollab = Boolean(currentSession)
        && (!currentSession.purpose || currentSession.purpose === 'job' || currentSession.parentSessionId)
      if (showCollab) {
        try {
          const group = await request({
            url: `/navigation/mobile/sessions/${currentSession.jobSessionId || currentSession.id}/collab`
          })
          collabGroup = mapGroupCard(group)
          collabGroup.sessionId = group.sessionId || currentSession.jobSessionId || currentSession.id
        } catch (error) {
          collabGroup = null
        }
      }
      this.openJob = openJobOf(currentSession) // 已到位的作业，验箱/出场挂它下面
      this.setData({
        currentSession: isActive(currentSession) ? currentSession : null,
        collabGroup,
        collabGroups: [], // 司机首页不用岗位群列表
        ...describeSession(currentSession)
      })
    } catch (error) {
      this.openJob = null
      this.setData({
        currentSession: null,
        collabGroup: null,
        collabGroups: [],
        currentTitle: '',
        currentDetail: '',
        currentAction: ''
      })
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  /** 扫贝位码开导航；已有进行中任务则继续那一趟 */
  scanCode() {
    if (this.data.isFieldRole) return // 岗位不扫码导航
    if (this.data.currentSession) {
      this.continueNavigation()
      return
    }
    wx.scanCode({
      scanType: ['qrCode'],
      success: async result => {
        try {
          wx.showLoading({ title: '识别中' })
          const target = await request({
            url: '/navigation/mobile/scan',
            method: 'POST',
            data: { content: result.result } // 二维码原文交给后台解析
          })
          this.openConfirmation(target, 1) // 1 表示来自扫码
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
        } finally {
          wx.hideLoading()
        }
      }
    })
  },

  /** 去手动选贝位；已有进行中任务则继续那一趟 */
  selectTarget() {
    if (this.data.isFieldRole) return
    if (this.data.currentSession) {
      this.continueNavigation()
      return
    }
    wx.navigateTo({ url: '/pages/select-target/index' })
  },

  /** 点橙色卡：贝位、验箱区、出场口都回导航页接着走 */
  continueNavigation() {
    const session = this.data.currentSession
    if (!session) return
    wx.navigateTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
  },

  /** 一键去验箱区 */
  goSafety() {
    this.startSpecial('safety')
  },

  /** 一键去出场口 */
  goExit() {
    this.startSpecial('exit')
  },

  /** 按当前位置开一趟去验箱区/出场口的导航；有别的进行中导航先问要不要结束 */
  startSpecial(purpose) {
    if (this.data.isFieldRole || this.data.specialLoading) return
    const current = this.data.currentSession
    // 正在去的就是这里，直接接着走
    if (current && current.purpose === purpose) {
      this.continueNavigation()
      return
    }
    // 还有别的导航没走完：后台一次只允许一趟，先问司机
    if (current) {
      wx.showModal({
        title: '切换导航',
        content: `当前正在前往${current.targetName || PURPOSE_NAME[current.purpose] || '目的地'}，是否结束并改去${PURPOSE_NAME[purpose]}？`,
        confirmText: '结束并前往',
        success: async result => {
          if (!result.confirm) return
          try {
            await request({ url: `/navigation/mobile/sessions/${current.id}/cancel`, method: 'POST' })
          } catch (error) {
            wx.showToast({ title: error.message || '结束当前导航失败', icon: 'none' })
            return
          }
          this.setData({ currentSession: null, ...describeSession(null) })
          this.openSpecial(purpose)
        }
      })
      return
    }
    this.openSpecial(purpose)
  },

  /** 取当前位置和验箱区/出场口，开会话后进对应页面 */
  async openSpecial(purpose) {
    this.setData({ specialLoading: purpose })
    try {
      const job = this.openJob
      const session = await specialNav.startSpecialNav({
        purpose,
        task: job, // 有已到位的作业就带上箱号等信息
        parentSessionId: job ? job.id : undefined
      })
      wx.navigateTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
    } catch (error) {
      const message = error.message || '无法开始导航'
      const needSetting = /定位权限|定位服务|请在设置中允许|auth deny/i.test(message)
      wx.showModal({
        title: '无法开始导航',
        content: message,
        confirmText: needSetting ? '打开设置' : '知道了',
        showCancel: needSetting,
        success: result => {
          if (needSetting && result.confirm) wx.openSetting()
        }
      })
    } finally {
      this.setData({ specialLoading: '' })
    }
  },

  /** 司机点协同卡片进群 */
  openCollabGroup() {
    const group = this.data.collabGroup
    if (!group) {
      wx.showToast({ title: '暂无进行中的任务', icon: 'none' })
      return
    }
    const query = group.id
      ? `groupId=${group.id}`
      : `sessionId=${group.sessionId}`
    wx.navigateTo({ url: `/pages/collab-group/index?${query}` })
  },

  /** 现场岗位点某一群进群 */
  openRoleGroup(event) {
    const groupId = event.currentTarget.dataset.id
    if (!groupId) {
      wx.showToast({ title: '协同群不存在', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/collab-group/index?groupId=${groupId}` })
  },

  /** 把选中的贝位暂存到全局，再去确认任务页 */
  openConfirmation(target, sourceType) {
    getApp().globalData.selectedTarget = { target, sourceType }
    wx.navigateTo({ url: '/pages/confirm-target/index' })
  }
})
