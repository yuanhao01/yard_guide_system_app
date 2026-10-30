/**
 * 现场协同群：群、成员、消息全部来自后端
 * GET  /navigation/mobile/sessions/{sessionId}/collab
 * GET  /navigation/mobile/collab/{groupId}/messages?sinceSeq=
 * POST /navigation/mobile/collab/{groupId}/messages
 * POST /navigation/mobile/collab/{groupId}/read
 * POST /navigation/mobile/collab/{groupId}/images、/voices（图片、语音上传）
 *
 * 消息走 WebSocket 实时推送，在线人数由各成员的连接状态决定；
 * 断线期间可能漏推，重连后用 sinceSeq 补齐。
 * 依赖：request、auth、config、collabSocket。
 */
const request = require('../../utils/request')
const auth = require('../../utils/auth')
const config = require('../../config')
const { createCollabSocket } = require('../../utils/collabSocket')
const collabUnread = require('../../utils/collabUnread')

// 头像底色和字：1 堆高机、2 道口、3 调度、4 司机、5 系统、9 其他
const MEMBER_STYLE = {
  1: { cls: 'stacker', avatar: '堆' },
  2: { cls: 'gate', avatar: '道' },
  3: { cls: 'dispatch', avatar: '调' },
  4: { cls: 'driver', avatar: '司' },
  5: { cls: 'system', avatar: '系' },
  9: { cls: 'other', avatar: '员' }
}

/** 后台字典来了就覆盖本地头像样式 */
function applyDict(dict) {
  const items = (dict && dict.senderTypes) || []
  items.forEach(item => {
    MEMBER_STYLE[item.code] = {
      cls: item.cssClass || 'system',
      avatar: item.avatar || '系'
    }
  })
}

// 司机常用四句快捷回复
const DRIVER_QUICK = [
  { label: '📍 确认位置', text: '已确认位置，正在前往' },
  { label: '⏱ 预计到达', text: '预计 {eta} 分钟到达作业点' },
  { label: '▶ 已出发', text: '已出发，请堆高机留意' },
  { label: '✓ 已到位', text: '已到位，等待指挥' }
]

// 堆高机 / 道口 / 调度各自的快捷回复
const ROLE_QUICK = {
  1: [
    { label: '🛠 正在就位', text: '堆高机正在就位' },
    { label: '⏱ 预计到达', text: '预计 {eta} 分钟到达作业点' },
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

/** 把快捷回复里的 {eta} 换成导航页算出的真实预计分钟；导航页还没算出来就退回默认值，不显示假数字 */
function resolveQuickText(text) {
  if (!text || text.indexOf('{eta}') === -1) return text
  const app = getApp()
  const eta = app && app.globalData ? app.globalData.navEtaMinutes : null
  return text.replace('{eta}', eta != null ? String(eta) : '几')
}

/** 按当前登录身份挑一组快捷回复 */
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

// 语音：最长 60 秒（到点录音器自动停并发出），短于 1 秒不发
const VOICE_MAX_MS = 60000
const VOICE_MIN_MS = 1000
// 按住说话时手指上滑超过这么多 px 算取消
const VOICE_CANCEL_DY = 80
const RECORD_OPTIONS = {
  duration: VOICE_MAX_MS,
  format: 'mp3',
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000
}

/** 把后台给的相对路径拼成能打开的图片地址 */
function resolveFileUrl(path) {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path // 已经是完整地址
  return `${config.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

/** 消息上的附加 JSON（预计到达、图片地址等） */
function parseExtra(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch (error) {
    return {}
  }
}

/** 把后台一条消息整理成页面气泡要的字段 */
function decorate(message) {
  const style = MEMBER_STYLE[message.senderType] || MEMBER_STYLE[5] // 头像样式
  const extra = parseExtra(message.extraJson)
  let card = null // 堆高机动态卡片
  if (message.msgType === 1 && extra && (extra.etaMin != null || extra.routeText || extra.statusText)) {
    card = extra
  }
  const imageUrl = message.msgType === 3 ? resolveFileUrl(extra.url || message.content) : ''
  const voiceUrl = message.msgType === 4 ? resolveFileUrl(extra.url) : ''
  const voiceSeconds = Math.max(1, Math.min(60, Number(extra.seconds) || Math.round(Number(extra.durationMs) / 1000) || 1))
  let type = 'text'
  if (card) type = 'machine'
  else if (message.msgType === 2) type = 'system'
  else if (imageUrl) type = 'image'
  else if (voiceUrl) type = 'voice'
  return {
    id: message.id, // 消息编号
    type,
    roleClass: style.cls, // 头像颜色类
    avatar: style.avatar, // 头像字
    name: message.senderName, // 发送人
    role: message.displayName || '', // 岗位
    time: message.sendTimeText || '',
    text: message.content || '',
    imageUrl,
    voiceUrl, // 语音地址
    voiceSeconds, // 语音秒数
    voiceWidth: 150 + voiceSeconds * 5, // 语音条宽度（rpx），越长越宽
    self: Boolean(message.self), // 是不是自己发的
    etaMin: card ? card.etaMin : null, // 堆高机预计分钟
    routeText: card ? card.routeText : '',
    statusText: card ? card.statusText : ''
  }
}

Page({
  data: {
    statusBarHeight: 20, // 避开状态栏
    taskLabel: '', // 顶栏任务名
    groupName: '现场协同群',
    onlineCount: 0, // 在线人数
    memberCount: 0, // 群总人数
    statusText: '', // 群解散时的状态字
    dissolved: false, // 群是否已解散
    draft: '', // 输入框草稿
    sending: false, // 正在发送
    loading: true, // 群还在加载
    errorText: '', // 加载失败原因
    connected: false, // 长连接是否连上
    scrollInto: '', // 滚到哪一条
    lastMachineId: '', // 最后一条堆高机动态
    members: [], // 成员列表
    messages: [], // 聊天记录
    quickReplies: DRIVER_QUICK, // 底部快捷回复
    pendingNewCount: 0, // 往上翻时新来的未看条数
    pendingNewText: '', // 右上角未读数字
    voiceMode: false, // 输入栏切到「按住说话」
    recording: false, // 正在录音
    recordCancel: false, // 手指已上滑，松开就取消
    recordSeconds: 0, // 已录秒数
    playingId: '' // 正在播放的语音消息编号
  },

  /** 进页：记会话/群号，听前后台，拉字典和群 */
  onLoad(options) {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20,
      quickReplies: quickRepliesForUser()
    })
    this.sessionId = options.sessionId // 用作业会话打开
    this.groupId = options.groupId || null // 直接用群号打开
    if (this.groupId) collabUnread.setActiveGroup(this.groupId)
    this.lastMessageId = null // 最后一条消息编号
    this.lastMessageSeq = null // 最后一条序号，补拉用
    this._lastMarkedSeq = null // 已经报过已读的序号
    this._foreground = true // 小程序在前台
    this._atBottom = true // 是不是停在最新消息附近
    this._lastScrollTop = 0
    this.socket = null
    this._onAppHide = () => {
      this._foreground = false
      this.abortRecord()
      this.stopVoice()
      this.stopPoll()
      this.closeSocket()
    }
    this._onAppShow = () => {
      this._foreground = true
      if (this.socket) this.socket.open()
      this.pullNewMessages()
      this.startPoll()
    }
    wx.onAppHide(this._onAppHide)
    wx.onAppShow(this._onAppShow)
    this.initVoice()
    this.loadDict().finally(() => this.loadGroup())
  },

  /** 回到这一页：重连并补消息 */
  onShow() {
    this._foreground = true
    if (this.groupId) collabUnread.setActiveGroup(this.groupId)
    collabUnread.start()
    if (this.socket) {
      this.socket.open()
      this.pullNewMessages()
    }
    this.startPoll()
  },

  onHide() {
    // 真机调试会误触发页面 hide，这里不断开，避免手机收不到推送
  },

  /** 离开页：取消前后台监听、停补拉、关掉长连接 */
  onUnload() {
    if (this._onAppHide) wx.offAppHide(this._onAppHide)
    if (this._onAppShow) wx.offAppShow(this._onAppShow)
    this.stopPoll()
    this.closeSocket()
    this.abortRecord()
    if (this.audio) {
      this.audio.destroy()
      this.audio = null
    }
    collabUnread.setActiveGroup(null)
    if (this._markReadTimer) {
      clearTimeout(this._markReadTimer)
      this._markReadTimer = null
    }
  },

  /** 往上滑就认为离开底部，新消息先记未读、不自动跟着滚 */
  onChatScroll(event) {
    const top = event && event.detail ? Number(event.detail.scrollTop) : 0
    if (this._lastScrollTop && top < this._lastScrollTop - 12) {
      this._atBottom = false
    }
    this._lastScrollTop = top
  },

  /** 滑到最新附近：清本群未读并报已读 */
  onChatToLower() {
    this.clearPendingNew()
    this.scheduleMarkRead()
  },

  /** 点「N条新消息」滚回底部 */
  jumpToLatest() {
    this.clearPendingNew()
    if (this.lastMessageId) {
      this.setData({ scrollInto: `msg-${this.lastMessageId}` })
    }
    this.scheduleMarkRead()
  },

  /** 清掉本页未读角标，并告诉全局仓库这群已经看过 */
  clearPendingNew() {
    this._atBottom = true
    if (this.data.pendingNewCount) {
      this.setData({ pendingNewCount: 0, pendingNewText: '' })
    }
    if (this.groupId) collabUnread.zeroGroup(this.groupId)
  },

  /** 拉发送人类型字典，用来画头像 */
  async loadDict() {
    try {
      applyDict(await request({ url: '/navigation/mobile/collab/dict' }))
    } catch (error) {
      // 字典失败时沿用本地兜底样式
    }
  },

  /** 拉群资料、成员和历史消息，再开长连接 */
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
      collabUnread.setActiveGroup(this.groupId)
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
        dissolved: group.status !== 0, // 不是进行中就当解散
        members: group.members || [],
        messages,
        lastMachineId: lastMachine ? lastMachine.id : '',
        scrollInto: this.lastMessageId ? `msg-${this.lastMessageId}` : ''
      })
      // 群还在进行中才连实时通道
      if (group.status !== 1) {
        const selfCode = group.selfMemberCode
          || ((group.members || []).find(item => item.self) || {}).memberCode
        const selfMember = (group.members || []).find(item =>
          item.self || (selfCode && item.memberCode === selfCode)
        ) || {}
        this.openSocket(selfCode, selfMember.id)
        this.startPoll()
        this.scheduleMarkRead()
      }
    } catch (error) {
      this.setData({ loading: false, errorText: error.message || '协同群加载失败' })
    }
  },

  /** 为当前成员打开协同长连接 */
  openSocket(memberCode, memberId) {
    if ((!memberCode && !memberId) || this.socket) return
    this.socket = createCollabSocket(memberCode, {
      memberId,
      onOpen: () => {
        this.setData({ connected: true })
        this.pullNewMessages() // 刚连上先补漏
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
      },
      onRead: payload => {
        if (!payload) return
        const seq = Number(payload.readSeq)
        if (Number.isFinite(seq)) {
          this._lastMarkedSeq = Math.max(this._lastMarkedSeq || 0, seq)
        }
      }
    })
    this.socket.open()
  },

  /** 关掉长连接 */
  closeSocket() {
    if (this.socket) {
      this.socket.close()
    }
    this.setData({ connected: false })
  },

  /** 每 3 秒补拉一次，防止推送漏了 */
  startPoll() {
    this.stopPoll()
    this._pollTimer = setInterval(() => this.pullNewMessages(), 3000)
  },

  /** 停掉补拉 */
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

  /** 列表末尾追加一条，已有的不重复加 */
  appendMessage(raw) {
    if (!raw || !raw.id) return
    const rawId = String(raw.id)
    if ((this.data.messages || []).some(item => String(item.id) === rawId)) return
    const message = decorate(raw)
    this.lastMessageId = message.id
    if (raw.seq != null) this.lastMessageSeq = raw.seq
    const stay = this._atBottom !== false || message.self
    const pending = stay ? 0 : (this.data.pendingNewCount || 0) + (message.self ? 0 : 1)
    this.setData({
      messages: this.data.messages.concat([message]),
      scrollInto: stay ? `msg-${message.id}` : this.data.scrollInto,
      pendingNewCount: pending,
      pendingNewText: pending > 99 ? '99+' : String(pending)
    })
    if (stay) {
      this._atBottom = true
      this.scheduleMarkRead()
    }
  },

  /** 断线重连后补齐这期间漏推的消息。 */
  async pullNewMessages() {
    if (!this.groupId || this.data.dissolved) return
    try {
      const cursor = this.lastMessageSeq != null ? this.lastMessageSeq : this.lastMessageId
      const query = cursor != null ? `?sinceSeq=${cursor}` : ''
      const list = await request({ url: `/navigation/mobile/collab/${this.groupId}/messages${query}` })
      ;(list || []).forEach(item => this.appendMessage(item))
      if (this._atBottom !== false) this.scheduleMarkRead()
    } catch (error) {
      // 补拉失败静默处理，避免打断司机操作
    }
  },

  /** 稍等再报已读，避免每来一条就打一次接口 */
  scheduleMarkRead() {
    if (!this._foreground || !this.groupId || this.data.dissolved) return
    if (this._atBottom === false) return
    const seq = this.lastMessageSeq
    if (seq == null) return
    if (this._lastMarkedSeq != null && seq <= this._lastMarkedSeq) return
    if (this._markReadTimer) clearTimeout(this._markReadTimer)
    this._markReadTimer = setTimeout(() => this.markRead(), 400)
  },

  /** 告诉后台我看到哪一条了，首页红点才会消 */
  async markRead() {
    this._markReadTimer = null
    if (!this._foreground || !this.groupId || this.data.dissolved) return
    const seq = this.lastMessageSeq
    if (seq == null) return
    if (this._lastMarkedSeq != null && seq <= this._lastMarkedSeq) return
    try {
      await request({
        url: `/navigation/mobile/collab/${this.groupId}/read`,
        method: 'POST',
        data: { seq }
      })
      this._lastMarkedSeq = seq
      collabUnread.zeroGroup(this.groupId)
    } catch (error) {
      // 已读失败下次进群再补，不影响聊天
    }
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
  },

  /** 输入框内容变化 */
  onDraft(e) {
    this.setData({ draft: e.detail.value })
  },

  /** 点快捷回复直接发出去 */
  sendQuick(e) {
    this.submit(resolveQuickText(e.currentTarget.dataset.text))
  },

  /** 点发送或键盘发送 */
  sendDraft() {
    this.submit((this.data.draft || '').trim())
  },

  /** 选拍照、相册或微信聊天里的图 */
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

  /** 把选中的图传到后台，成功后当作一条消息加到列表 */
  uploadPicked(file) {
    const filePath = file && (file.tempFilePath || file.path)
    if (!filePath || !this.groupId) return
    this.uploadToGroup('images', filePath, {
      width: file.width || 0,
      height: file.height || 0
    }, '图片发送失败')
  },

  /** 图片、语音共用的上传：成功后当作自己的一条消息落地 */
  uploadToGroup(kind, filePath, formData, failText) {
    this.setData({ sending: true })
    wx.uploadFile({
      url: `${config.apiBaseUrl}/navigation/mobile/collab/${this.groupId}/${kind}`,
      filePath,
      name: 'file',
      header: {
        satoken: auth.getToken() || ''
      },
      formData,
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
        wx.showToast({ title: body.msg || failText, icon: 'none' })
      },
      fail: error => {
        wx.showToast({ title: error.errMsg || failText, icon: 'none' })
      },
      complete: () => this.setData({ sending: false })
    })
  },

  /** 点图片放大预览 */
  previewImage(event) {
    const url = event.currentTarget.dataset.url
    if (!url) return
    const urls = (this.data.messages || []).map(item => item.imageUrl).filter(Boolean)
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
  },

  /** 录音器和播放器各一个，回调在这里挂一次 */
  initVoice() {
    this._recState = 'idle' // idle 空闲 / starting 已调 start 未开始 / recording 录音中 / stopping 等结果
    this._recCancel = false
    this._recordAuthed = false
    // 以前授权过就不用再问，第一次按住就能录
    wx.getSetting({
      success: res => {
        if (res.authSetting && res.authSetting['scope.record']) this._recordAuthed = true
      }
    })
    // 录音器是全局单例，回调会跟着每次进页累加；本页没在录（idle）时一律忽略，免得旧页面也去上传
    const recorder = wx.getRecorderManager()
    this.recorder = recorder
    recorder.onStart(() => {
      if (this._recState === 'idle') return
      // 手指在录音真正开始前就松开了：开始后立刻停
      if (this._recState === 'stopping') {
        recorder.stop()
        return
      }
      this._recState = 'recording'
    })
    recorder.onStop(res => {
      if (this._recState === 'idle') return
      const cancel = this._recCancel
      this.resetRecord()
      if (cancel || !res || !res.tempFilePath) return
      if ((res.duration || 0) < VOICE_MIN_MS) {
        wx.showToast({ title: '说话时间太短', icon: 'none' })
        return
      }
      if (this.data.dissolved || !this.groupId) return
      this.uploadToGroup('voices', res.tempFilePath, {
        durationMs: Math.min(Math.round(res.duration), VOICE_MAX_MS)
      }, '语音发送失败')
    })
    recorder.onError(error => {
      if (this._recState === 'idle') return
      this.resetRecord()
      const message = (error && error.errMsg) || ''
      if (/auth|permission/i.test(message)) {
        this._recordAuthed = false
        this.ensureRecordAuth()
        return
      }
      wx.showToast({ title: '录音失败，请重试', icon: 'none' })
    })

    // 静音键打开时也要能听见，和导航语音同一设置
    if (wx.setInnerAudioOption) {
      wx.setInnerAudioOption({ obeyMuteSwitch: false, mixWithOther: true })
    }
    const audio = wx.createInnerAudioContext()
    this.audio = audio
    const clear = () => this.setData({ playingId: '' })
    audio.onEnded(clear)
    audio.onStop(clear)
    audio.onError(() => {
      // 没在播（比如空 src 上调了 stop）时 iOS 也会报错，不提示
      if (!this.data.playingId) return
      clear()
      wx.showToast({ title: '语音播放失败', icon: 'none' })
    })
  },

  /** 麦克风授权：没授权就申请，之前拒绝过就引导去设置 */
  ensureRecordAuth() {
    return new Promise(resolve => {
      wx.authorize({
        scope: 'scope.record',
        success: () => {
          this._recordAuthed = true
          resolve(true)
        },
        fail: () => {
          wx.showModal({
            title: '需要麦克风权限',
            content: '发送语音需要使用麦克风，请在设置中允许。',
            confirmText: '去设置',
            success: result => {
              if (result.confirm) wx.openSetting()
            }
          })
          resolve(false)
        }
      })
    })
  },

  /** 「语音 / 键盘」切换；切到语音时先把授权要好，免得按住时才弹窗 */
  toggleVoiceMode() {
    if (this.data.dissolved) {
      wx.showToast({ title: '协同群已解散', icon: 'none' })
      return
    }
    const voiceMode = !this.data.voiceMode
    this.setData({ voiceMode })
    if (voiceMode && !this._recordAuthed) this.ensureRecordAuth()
  },

  /** 按下：开始录音 */
  onVoiceStart(event) {
    if (this.data.sending || this.data.dissolved || !this.groupId || this._recState !== 'idle') return
    if (!this._recordAuthed) {
      this.ensureRecordAuth()
      return
    }
    const touch = (event.touches && event.touches[0]) || {}
    this._touchStartY = touch.clientY || 0
    this._recCancel = false
    this._recState = 'starting'
    this.stopVoice()
    this.setData({ recording: true, recordCancel: false, recordSeconds: 0 })
    this._recTimer = setInterval(() => {
      this.setData({ recordSeconds: Math.min(60, this.data.recordSeconds + 1) })
    }, 1000)
    this.recorder.start(RECORD_OPTIONS)
  },

  /** 按住时手指上滑超过阈值就进入「松开取消」 */
  onVoiceMove(event) {
    if (this._recState === 'idle') return
    const touch = (event.touches && event.touches[0]) || {}
    const cancel = this._touchStartY - (touch.clientY || 0) > VOICE_CANCEL_DY
    if (cancel !== this._recCancel) {
      this._recCancel = cancel
      this.setData({ recordCancel: cancel })
    }
  },

  /** 松开：停录音，结果在 onStop 里决定发不发 */
  onVoiceEnd() {
    if (this._recState === 'idle' || this._recState === 'stopping') return
    const started = this._recState === 'recording'
    this._recState = 'stopping'
    if (started) this.recorder.stop()
  },

  /** 被来电等打断：按取消处理 */
  onVoiceCancel() {
    this._recCancel = true
    this.onVoiceEnd()
  },

  /** 切后台、离开页面时丢弃正在录的语音 */
  abortRecord() {
    if (!this.recorder || this._recState === 'idle') return
    this._recCancel = true
    const started = this._recState === 'recording'
    this._recState = 'stopping'
    if (started) this.recorder.stop()
  },

  /** 录音结束（发出、取消或出错）后回到空闲，停掉秒数计时 */
  resetRecord() {
    if (this._recTimer) {
      clearInterval(this._recTimer)
      this._recTimer = null
    }
    this._recState = 'idle'
    this._recCancel = false
    this.setData({ recording: false, recordCancel: false, recordSeconds: 0 })
  },

  /** 点语音条播放，再点一次停止；同时只播一条 */
  playVoice(event) {
    const { id, url } = event.currentTarget.dataset
    if (!url || !this.audio) return
    if (this.data.playingId === id) {
      this.audio.stop()
      return
    }
    // 换 src 会自动停掉上一条；第一次播放前 src 为空，此时调 stop 在 iOS 上会触发 onError
    this.audio.src = url
    this.audio.play()
    this.setData({ playingId: id })
  },

  /** 停掉正在播放的语音（开始录音、切后台时） */
  stopVoice() {
    if (this.audio && this.data.playingId) this.audio.stop()
  },

  /** 发出一条文字 */
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
