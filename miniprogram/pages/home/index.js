const request = require('../../utils/request')
const auth = require('../../utils/auth')
const specialNav = require('../../utils/specialNav')

function remainMetersText(session) {
  const planned = Number(session && session.route && session.route.distanceMeters)
  const along = Number(session && session.remainingDistanceMeters)
  if (Number.isFinite(planned) && planned > 500 && (!Number.isFinite(along) || along < 150)) {
    return String(Math.round(planned))
  }
  if (Number.isFinite(along) && along > 0) return String(Math.round(along))
  if (Number.isFinite(planned) && planned > 0) return String(Math.round(planned))
  return '--'
}

function describeSession(session) {
  if (!session) {
    return { currentTitle: '', currentDetail: '', currentAction: '' }
  }
  const next = session.nextAction
  if (next === 'safety' || next === 'inspect') {
    return {
      currentTitle: '前往安全操作区验箱',
      currentDetail: session.workTypeLabel ? `${session.workTypeLabel}完成，请先验箱再出场` : '请先验箱再出场',
      currentAction: '去验箱 →'
    }
  }
  if (next === 'exit' && session.status === 2) {
    return {
      currentTitle: '前往出场口',
      currentDetail: '验箱完成，开始出场导航',
      currentAction: '出场导航 →'
    }
  }
  return {
    currentTitle: `前往 ${session.targetName || ''}`,
    currentDetail: `剩余约 ${remainMetersText(session)} 米`,
    currentAction: '继续导航 →'
  }
}

function mapGroupCard(group) {
  const members = group.members || []
  const unread = Number(group.unreadCount) || 0
  return {
    id: group.id,
    sessionId: group.sessionId,
    title: group.groupName || group.taskLabel || '现场协同群',
    desc: group.lastMsgPreview
      || group.statusText
      || (group.onlineCount != null
        ? `${group.onlineCount}/${group.memberCount || group.onlineCount}人在线`
        : '点进群聊查看现场成员'),
    lastMsgTimeText: group.lastMsgTimeText || '',
    unreadCount: unread,
    unreadText: unread > 99 ? '99+' : String(unread),
    memberText: members.map(item => item.memberName || item.displayName).filter(Boolean).join(' · ')
  }
}

function syncHomeTab(isFieldRole) {
  wx.setTabBarItem({
    index: 0,
    text: isFieldRole ? '协同' : '导航'
  })
}

function applyUserContext(page) {
  const user = auth.getUser() || {}
  const yards = user.accessibleYards || []
  const yard = yards.find(item => String(item.id) === String(user.currentCyId))
  const isFieldRole = auth.isFieldRole()
  syncHomeTab(isFieldRole)
  page.setData({
    isFieldRole,
    canSwitchYard: yards.length > 1,
    yards,
    yardName: (yard && yard.cyName) || user.yardName || '',
    roleLabel: user.roleLabel || '',
    displayName: user.displayName || user.userName || user.userAccount || ''
  })
}

Page({
  data: {
    isFieldRole: false,
    canSwitchYard: false,
    yards: [],
    roleLabel: '',
    displayName: '',
    yardName: '',
    currentSession: null,
    collabGroup: null,
    collabGroups: [],
    currentTitle: '',
    currentDetail: '',
    currentAction: ''
  },

  onShow() {
    if (!auth.isLoggedIn()) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    applyUserContext(this)
    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh())
  },

  async refresh() {
    if (this.data.isFieldRole || auth.isFieldRole()) {
      await this.refreshRoleHome()
      return
    }
    await this.refreshDriverHome()
  },

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
      const groups = await request({ url: '/navigation/mobile/collab/my-groups' })
      this.setData({
        collabGroups: (groups || []).map(mapGroupCard)
      })
    } catch (error) {
      this.setData({ collabGroups: [] })
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  chooseYard() {
    const yards = this.data.yards || []
    if (yards.length < 2) return
    wx.showActionSheet({
      itemList: yards.map(item => item.cyName || String(item.id)),
      success: async result => {
        const yard = yards[result.tapIndex]
        if (!yard || String(yard.id) === String((auth.getUser() || {}).currentCyId)) return
        try {
          wx.showLoading({ title: '切换中' })
          const user = await request({
            url: '/navigation/auth/switch-yard',
            method: 'POST',
            data: { cyId: yard.id }
          })
          const token = user.token || auth.getToken()
          auth.setSession(Object.assign({}, auth.getUser(), user, { token }))
          getApp().globalData.user = auth.getUser()
          applyUserContext(this)
          await this.refresh()
        } catch (error) {
          wx.showToast({ title: error.message || '切换失败', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      }
    })
  },

  async refreshDriverHome() {
    applyUserContext(this)
    try {
      const currentSession = await request({ url: '/navigation/mobile/sessions/current' })
      let collabGroup = null
      const showCollab = Boolean(currentSession)
        && (currentSession.purpose !== 'exit' || currentSession.parentSessionId)
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
      this.setData({
        currentSession,
        collabGroup,
        collabGroups: [],
        ...describeSession(currentSession)
      })
    } catch (error) {
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

  scanCode() {
    if (this.data.isFieldRole) return
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
            data: { content: result.result }
          })
          this.openConfirmation(target, 1)
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
        } finally {
          wx.hideLoading()
        }
      }
    })
  },

  selectTarget() {
    if (this.data.isFieldRole) return
    if (this.data.currentSession) {
      this.continueNavigation()
      return
    }
    wx.navigateTo({ url: '/pages/select-target/index' })
  },

  continueNavigation() {
    const session = this.data.currentSession
    if (!session) return
    if (session.status === 0 || session.status === 1) {
      if (session.purpose === 'safety') {
        wx.navigateTo({ url: `/pages/safety-zone/index?sessionId=${session.id}` })
        return
      }
      wx.navigateTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
      return
    }
    if (session.nextAction === 'safety' || session.nextAction === 'inspect') {
      wx.navigateTo({
        url: `/pages/safety-zone/index?jobSessionId=${session.jobSessionId || session.id}`
      })
      return
    }
    if (session.nextAction === 'exit') {
      this.continueExit(session)
      return
    }
    wx.navigateTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
  },

  async continueExit(session) {
    try {
      wx.showLoading({ title: '规划出场' })
      const next = await specialNav.startSpecialNav({
        purpose: 'exit',
        parentSessionId: session.jobSessionId || session.id,
        task: session
      })
      wx.hideLoading()
      wx.navigateTo({ url: `/pages/navigation/index?sessionId=${next.id}` })
    } catch (error) {
      wx.hideLoading()
      wx.showToast({ title: error.message || '无法开始出场导航', icon: 'none' })
    }
  },

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

  openRoleGroup(event) {
    const groupId = event.currentTarget.dataset.id
    if (!groupId) {
      wx.showToast({ title: '协同群不存在', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/collab-group/index?groupId=${groupId}` })
  },

  openConfirmation(target, sourceType) {
    getApp().globalData.selectedTarget = { target, sourceType }
    wx.navigateTo({ url: '/pages/confirm-target/index' })
  }
})
