const request = require('../../utils/request')
const auth = require('../../utils/auth')
const config = require('../../config')
const { createCollabSocket } = require('../../utils/collabSocket')

/**
 * 现场协同群：群、成员、消息全部来自后端
 * GET  /navigation/mobile/sessions/{sessionId}/collab
 * GET  /navigation/mobile/collab/{groupId}/messages?sinceSeq=
 * POST /navigation/mobile/collab/{groupId}/messages
 *
 * 消息走 WebSocket 实时推送，在线人数由各成员的连接状态决定；
 * 断线期间可能漏推，重连后用 sinceSeq 补齐。
 */
const MEMBER_STYLE = {
  1: { cls: 'stacker', avatar: '堆' },
  2: { cls: 'gate', avatar: '道' },
  3: { cls: 'dispatch', avatar: '调' },
  4: { cls: 'driver', avatar: '司' },
  5: { cls: 'system', avatar: '系' },
  9: { cls: 'other', avatar: '员' }
}

function applyDict(dict) {
  const items = (dict && dict.senderTypes) || []
  items.forEach(item => {
    MEMBER_STYLE[item.code] = {
      cls: item.cssClass || 'system',
      avatar: item.avatar || '系'
    }
  })
}

const DRIVER_QUICK = [
  { label: '📍 确认位置', text: '已确认位置，正在前往' },
  { label: '⏱ 预计到达', text: '预计 3 分钟到达作业点' },
  { label: '▶ 已出发', text: '已出发，请堆高机留意' },
  { label: '✓ 已到位', text: '已到位，等待指挥' }
]

const ROLE_QUICK = {
  1: [
    { label: '🛠 正在就位', text: '堆高机正在就位' },
    { label: '⏱ 预计到达', text: '预计 3 分钟到达作业点' },
    { label: '✓ 可以作业', text: '已就位，可以作业' },
    { label: '⚠ 注意箱位', text: '请注意箱位，按指令作业' }
  ],
  2: [
    { label: '🚪 已放行', text: '车辆已放行，请进场' },
    { label: '▶ 请进场', text: '请司机按引导进场' },
    { label: '✓ 已核箱', text: '已核对箱号' },
    { label: '⏳ 请等候', text: '请排队等候' }
  ],
  3: [
    { label: '📋 按指令', text: '请按调度指令前往' },
    { label: '🛠 已协调', text: '已协调作业机械' },
    { label: '⚠ 注意安全', text: '注意场内安全' },
    { label: '✓ 已确认', text: '任务已确认' }
  ]
}

function quickRepliesForUser() {
  const user = auth.getUser() || {}
  if (user.userKind === 'role') {
    return ROLE_QUICK[user.roleType] || [
      { label: '✓ 已知晓', text: '已知晓' },
      { label: '▶ 处理中', text: '正在处理' },
      { label: '⚠ 请注意', text: '请注意现场情况' }
    ]
  }
  return DRIVER_QUICK
}

function resolveFileUrl(path) {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path
  return `${config.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

function parseExtra(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch (error) {
    return {}
  }
}

function decorate(message) {
  const style = MEMBER_STYLE[message.senderType] || MEMBER_STYLE[5]
  const extra = parseExtra(message.extraJson)
  let card = null
  if (message.msgType === 1 && extra && (extra.etaMin != null || extra.routeText || extra.statusText)) {
    card = extra
  }
  const imageUrl = message.msgType === 3 ? resolveFileUrl(extra.url || message.content) : ''
  return {
    id: message.id,
    type: card ? 'machine' : (message.msgType === 2 ? 'system' : (imageUrl ? 'image' : 'text')),
    roleClass: style.cls,
    avatar: style.avatar,
    name: message.senderName,
    role: message.displayName || '',
    time: message.sendTimeText || '',
    text: message.content || '',
    imageUrl,
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
    messages: [],
    quickReplies: DRIVER_QUICK
  },

  onLoad(options) {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20,
      quickReplies: quickRepliesForUser()
    })
    this.sessionId = options.sessionId
    this.groupId = options.groupId || null
    this.lastMessageId = null
    this.lastMessageSeq = null
    this.socket = null
    this._onAppHide = () => {
      this.stopPoll()
      this.closeSocket()
    }
    this._onAppShow = () => {
      if (this.socket) this.socket.open()
      this.pullNewMessages()
      this.startPoll()
    }
    wx.onAppHide(this._onAppHide)
    wx.onAppShow(this._onAppShow)
    this.loadDict().finally(() => this.loadGroup())
  },

  onShow() {
    if (this.socket) {
      this.socket.open()
      this.pullNewMessages()
    }
    this.startPoll()
  },

  onHide() {
    // 真机调试会误触发页面 hide，这里不断开，避免手机收不到推送
  },

  onUnload() {
    if (this._onAppHide) wx.offAppHide(this._onAppHide)
    if (this._onAppShow) wx.offAppShow(this._onAppShow)
    this.stopPoll()
    this.closeSocket()
  },

  async loadDict() {
    try {
      applyDict(await request({ url: '/navigation/mobile/collab/dict' }))
    } catch (error) {
      // 字典失败时沿用本地兜底样式
    }
  },

  async loadGroup() {
    if (!this.sessionId && !this.groupId) {
      this.setData({ loading: false, errorText: '缺少任务信息，无法打开协同群' })
      return
    }
    try {
      const url = this.groupId
        ? `/navigation/mobile/collab/groups/${this.groupId}`
        : `/navigation/mobile/sessions/${this.sessionId}/collab`
      const group = await request({ url })
      const messages = (group.messages || []).map(decorate)
      this.groupId = group.id
      const last = (group.messages || [])[messages.length - 1] || {}
      this.lastMessageId = last.id || null
      this.lastMessageSeq = last.seq != null ? last.seq : this.lastMessageId
      const lastMachine = messages.slice().reverse().find(item => item.type === 'machine')
      this.setData({
        loading: false,
        errorText: '',
        groupName: group.groupName || '现场协同群',
        taskLabel: group.taskLabel || '',
        onlineCount: group.onlineCount || 0,
        memberCount: group.memberCount || 0,
        statusText: group.statusText || '',
        dissolved: group.status !== 0,
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
        this.startPoll()
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

  startPoll() {
    this.stopPoll()
    this._pollTimer = setInterval(() => this.pullNewMessages(), 3000)
  },

  stopPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
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
    if (raw.seq != null) this.lastMessageSeq = raw.seq
    this.setData({
      messages: this.data.messages.concat([message]),
      scrollInto: `msg-${message.id}`
    })
  },

  /** 断线重连后补齐这期间漏推的消息。 */
  async pullNewMessages() {
    if (!this.groupId || this.data.dissolved) return
    try {
      const cursor = this.lastMessageSeq != null ? this.lastMessageSeq : this.lastMessageId
      const query = cursor != null ? `?sinceSeq=${cursor}` : ''
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

  chooseImageSource() {
    if (this.data.sending || this.data.dissolved || !this.groupId) {
      if (this.data.dissolved) wx.showToast({ title: '协同群已解散', icon: 'none' })
      return
    }
    wx.showActionSheet({
      itemList: ['拍照', '从手机相册选择', '从微信聊天记录选择'],
      success: result => {
        if (result.tapIndex === 0) this.pickFromCamera()
        else if (result.tapIndex === 1) this.pickFromAlbum()
        else this.pickFromChat()
      }
    })
  },

  pickFromCamera() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera'],
      sizeType: ['compressed'],
      success: res => this.uploadPicked(res.tempFiles && res.tempFiles[0])
    })
  },

  pickFromAlbum() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
      sizeType: ['compressed'],
      success: res => this.uploadPicked(res.tempFiles && res.tempFiles[0])
    })
  },

  pickFromChat() {
    wx.chooseMessageFile({
      count: 1,
      type: 'image',
      success: res => {
        const file = (res.tempFiles || [])[0]
        if (!file) return
        this.uploadPicked({
          tempFilePath: file.path,
          width: file.width,
          height: file.height
        })
      }
    })
  },

  uploadPicked(file) {
    const filePath = file && (file.tempFilePath || file.path)
    if (!filePath || !this.groupId) return
    this.setData({ sending: true })
    wx.uploadFile({
      url: `${config.apiBaseUrl}/navigation/mobile/collab/${this.groupId}/images`,
      filePath,
      name: 'file',
      header: {
        satoken: auth.getToken() || ''
      },
      formData: {
        width: file.width || 0,
        height: file.height || 0
      },
      timeout: 30000,
      success: res => {
        let body = {}
        try {
          body = JSON.parse(res.data || '{}')
        } catch (error) {
          body = {}
        }
        if (res.statusCode === 401 || body.code === 401) {
          auth.clearSession()
          wx.reLaunch({ url: '/pages/login/index' })
          return
        }
        if (res.statusCode === 200 && body.code === 200 && body.data) {
          this.appendMessage(body.data)
          return
        }
        wx.showToast({ title: body.msg || '图片发送失败', icon: 'none' })
      },
      fail: error => {
        wx.showToast({ title: error.errMsg || '图片发送失败', icon: 'none' })
      },
      complete: () => this.setData({ sending: false })
    })
  },

  previewImage(event) {
    const url = event.currentTarget.dataset.url
    if (!url) return
    const urls = (this.data.messages || []).map(item => item.imageUrl).filter(Boolean)
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
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
