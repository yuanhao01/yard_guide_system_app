const request = require('../../utils/request')
const { createCollabSocket } = require('../../utils/collabSocket')

/**
 * 现场协同群：群、成员、消息全部来自后端
 * GET  /navigation/mobile/sessions/{sessionId}/collab
 * GET  /navigation/mobile/collab/{groupId}/messages?sinceId=
 * POST /navigation/mobile/collab/{groupId}/messages
 *
 * 消息走 WebSocket 实时推送，在线人数由各成员的连接状态决定；
 * 断线期间可能漏推，重连后用 sinceId 补齐。
 */
const MEMBER_STYLE = {
  1: { cls: 'stacker', avatar: '堆' },
  2: { cls: 'gate', avatar: '道' },
  3: { cls: 'dispatch', avatar: '调' },
  4: { cls: 'driver', avatar: '司' },
  5: { cls: 'system', avatar: '系' }
}

function decorate(message) {
  const style = MEMBER_STYLE[message.senderType] || MEMBER_STYLE[5]
  let card = null
  if (message.msgType === 1 && message.extraJson) {
    try {
      card = JSON.parse(message.extraJson)
    } catch (error) {
      card = null
    }
  }
  return {
    id: message.id,
    type: card ? 'machine' : (message.msgType === 2 ? 'system' : 'text'),
    roleClass: style.cls,
    avatar: style.avatar,
    name: message.senderName,
    role: message.displayName || '',
    time: message.sendTimeText || '',
    text: message.content || '',
    self: Boolean(message.self),
    etaMin: card ? card.etaMin : null,
    routeText: card ? card.routeText : '',
    statusText: card ? card.statusText : ''
  }
}

Page({
  data: {
    statusBarHeight: 20,
    taskLabel: '',
    groupName: '现场协同群',
    onlineCount: 0,
    memberCount: 0,
    statusText: '',
    dissolved: false,
    draft: '',
    sending: false,
    loading: true,
    errorText: '',
    connected: false,
    scrollInto: '',
    lastMachineId: '',
    members: [],
    messages: []
  },

  onLoad(options) {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20 })
    this.sessionId = options.sessionId
    this.groupId = null
    this.lastMessageId = null
    this.socket = null
    this.loadGroup()
  },

  onShow() {
    if (this._hideCloseTimer) {
      clearTimeout(this._hideCloseTimer)
      this._hideCloseTimer = null
    }
    if (this.socket) {
      this.socket.open()
      this.pullNewMessages()
    }
  },

  onHide() {
    if (this._hideCloseTimer) clearTimeout(this._hideCloseTimer)
    this._hideCloseTimer = setTimeout(() => {
      this._hideCloseTimer = null
      this.closeSocket()
    }, 5000)
  },

  onUnload() {
    if (this._hideCloseTimer) {
      clearTimeout(this._hideCloseTimer)
      this._hideCloseTimer = null
    }
    this.closeSocket()
  },

  async loadGroup() {
    if (!this.sessionId) {
      this.setData({ loading: false, errorText: '缺少任务信息，无法打开协同群' })
      return
    }
    try {
      const group = await request({ url: `/navigation/mobile/sessions/${this.sessionId}/collab` })
      const messages = (group.messages || []).map(decorate)
      this.groupId = group.id
      this.lastMessageId = messages.length ? messages[messages.length - 1].id : null
      const lastMachine = messages.slice().reverse().find(item => item.type === 'machine')
      this.setData({
        loading: false,
        errorText: '',
        groupName: group.groupName || '现场协同群',
        taskLabel: group.taskLabel || '',
        onlineCount: group.onlineCount || 0,
        memberCount: group.memberCount || 0,
        statusText: group.statusText || '',
        dissolved: group.status === 1,
        members: group.members || [],
        messages,
        lastMachineId: lastMachine ? lastMachine.id : '',
        scrollInto: this.lastMessageId ? `msg-${this.lastMessageId}` : ''
      })
      if (group.status !== 1) {
        const selfCode = group.selfMemberCode
          || ((group.members || []).find(item => item.self) || {}).memberCode
        const selfMember = (group.members || []).find(item =>
          item.self || (selfCode && item.memberCode === selfCode)
        ) || {}
        this.openSocket(selfCode, selfMember.id)
      }
    } catch (error) {
      this.setData({ loading: false, errorText: error.message || '协同群加载失败' })
    }
  },

  openSocket(memberCode, memberId) {
    if ((!memberCode && !memberId) || this.socket) return
    this.socket = createCollabSocket(memberCode, {
      memberId,
      onOpen: () => {
        this.setData({ connected: true })
        this.pullNewMessages()
      },
      onClose: () => this.setData({ connected: false }),
      onMessage: message => this.appendMessage(message),
      onPresence: presence => {
        if (!presence) return
        this.setData({
          onlineCount: presence.onlineCount,
          memberCount: presence.memberCount
        })
        this.refreshMembers(presence)
      }
    })
    this.socket.open()
  },

  closeSocket() {
    if (this.socket) {
      this.socket.close()
    }
    this.setData({ connected: false })
  },

  /** 收到上下线通知时同步成员列表上的在线小圆点。 */
  refreshMembers(presence) {
    const members = (this.data.members || []).map(member => (
      member.memberCode === presence.memberCode
        ? Object.assign({}, member, { online: presence.online })
        : member
    ))
    this.setData({ members })
  },

  appendMessage(raw) {
    if (!raw || !raw.id) return
    if ((this.data.messages || []).some(item => item.id === raw.id)) return
    const message = decorate(raw)
    this.lastMessageId = message.id
    this.setData({
      messages: this.data.messages.concat([message]),
      scrollInto: `msg-${message.id}`
    })
  },

  /** 断线重连后补齐这期间漏推的消息。 */
  async pullNewMessages() {
    if (!this.groupId || this.data.dissolved) return
    try {
      const query = this.lastMessageId ? `?sinceId=${this.lastMessageId}` : ''
      const list = await request({ url: `/navigation/mobile/collab/${this.groupId}/messages${query}` })
      ;(list || []).forEach(item => this.appendMessage(item))
    } catch (error) {
      // 补拉失败静默处理，避免打断司机操作
    }
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
  },

  onDraft(e) {
    this.setData({ draft: e.detail.value })
  },

  sendQuick(e) {
    this.submit(e.currentTarget.dataset.text)
  },

  sendDraft() {
    this.submit((this.data.draft || '').trim())
  },

  async submit(text) {
    if (!text || !this.groupId || this.data.sending) return
    if (this.data.dissolved) {
      wx.showToast({ title: '协同群已解散', icon: 'none' })
      return
    }
    this.setData({ sending: true })
    try {
      const message = await request({
        url: `/navigation/mobile/collab/${this.groupId}/messages`,
        method: 'POST',
        data: { content: text }
      })
      // 服务端推送时排除了发送者本人，自己的消息在这里落地
      this.appendMessage(message)
      this.setData({ draft: '' })
    } catch (error) {
      wx.showToast({ title: error.message || '发送失败', icon: 'none' })
    } finally {
      this.setData({ sending: false })
    }
  }
})
