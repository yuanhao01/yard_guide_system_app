/**
 * 协同群 WebSocket 客户端。
 *
 * 在线状态由连接本身决定：连上即在线，退出小程序、切后台超过 5 秒、
 * 页面卸载都会断开连接，服务端 onClose 立刻判离线。
 * 断网这类服务端收不到关闭事件的情况，靠这里的定时心跳过期兜底。
 * 依赖：config（接口/长连接地址）、auth（登录令牌）。
 */
const config = require('../config')

const HEARTBEAT_INTERVAL_MS = 20000 // 每 20 秒发一次心跳，告诉后台「我还在线」
const RECONNECT_BASE_MS = 2000 // 第一次掉线后等 2 秒再连
const RECONNECT_MAX_MS = 30000 // 重连等待最长 30 秒，避免一直狂连

/** 为某个现场成员建一条协同群长连接，用来收消息、在线状态和已读回执 */
function createCollabSocket(memberCode, handlers) {
  // 页面传来的回调：连上、来消息、有人上下线、已读
  const on = handlers || {}
  // 这条连接自己的运行状态
  const state = {
    memberCode, // 成员代号（常是车牌），没成员 id 时用它进群
    memberId: on.memberId, // 成员数字编号，有它就不走含中文的车牌路径
    task: null, // 微信的 socket 任务对象
    heartbeatTimer: null, // 心跳定时器
    reconnectTimer: null, // 重连定时器
    retries: 0, // 已经重连了几次，用来拉长等待
    closedByUser: false, // 是不是用户自己关的（关了就不要自动重连）
    connected: false // 现在有没有连上
  }

  /** 停掉心跳和重连定时器，避免页面关掉后还在跑 */
  function clearTimers() {
    // 有心跳就清掉
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer)
      state.heartbeatTimer = null
    }
    // 有等待重连就取消
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
  }

  /** 掉线后按 2、4、8… 秒递增再连，最长等到 30 秒 */
  function scheduleReconnect() {
    // 用户主动关掉，或已经在排队重连，就不再排
    if (state.closedByUser || state.reconnectTimer) return
    // 算出这次要等多久
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, state.retries), RECONNECT_MAX_MS)
    // 重连次数加一
    state.retries += 1
    // 到点再连
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null
      connect()
    }, delay)
  }

  /** 连上之后定时发 PING，后台靠它判断人还在不在 */
  function startHeartbeat() {
    // 先清掉旧心跳，避免叠两个
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
    // 按间隔发心跳
    state.heartbeatTimer = setInterval(() => {
      // 没连接或没连上就不发
      if (!state.task || !state.connected) return
      state.task.send({
        data: JSON.stringify({ type: 'PING', content: 'ping', timestamp: Date.now() }), // 心跳包
        fail: () => {}
      })
    }, HEARTBEAT_INTERVAL_MS)
  }

  /** 把 http 接口地址改成 ws，用来拼长连接地址 */
  function wsBase() {
    // 优先从接口地址改协议，保证和后台同一台机
    const fromApi = String(config.apiBaseUrl || '').replace(/^http/i, 'ws')
    // 去掉末尾斜杠，后面再拼路径
    return (fromApi || config.wsBaseUrl || '').replace(/\/$/, '')
  }

  /** 真正去连后台协同通道 */
  function connect() {
    // 用户已关掉，或既没代号也没编号，就不要连
    if (state.closedByUser || (!state.memberCode && !state.memberId)) return
    // 已经有一条旧连接，先关掉再开新的
    if (state.task) {
      try { state.task.close({ code: 1000, fail: () => {} }) } catch (error) { /* ignore */ }
      state.task = null
    }
    // 车牌含中文时直接放路径，微信模拟器经常握不上手；有成员 id 就走纯 ASCII
    const userId = state.memberId
      ? 'NAVCOLLAB:id:' + state.memberId
      : 'NAVCOLLAB:' + state.memberCode
    // 现场取令牌，连上时后台要验人
    const auth = require('./auth')
    const token = auth.getToken()
    // 有令牌就拼到地址后面
    const tokenQuery = token ? `?satoken=${encodeURIComponent(token)}` : ''
    // 完整长连接地址
    const url = `${wsBase()}/websocket/${encodeURIComponent(userId)}${tokenQuery}`
    // 发起连接，失败就排队重连
    const task = wx.connectSocket({ url, fail: () => scheduleReconnect() })
    state.task = task
    // 微信没给出任务对象，也排队重连
    if (!task) {
      scheduleReconnect()
      return
    }

    // 握手成功：标在线、重置重连次数、开始心跳
    task.onOpen(() => {
      state.connected = true
      state.retries = 0
      startHeartbeat()
      if (on.onOpen) on.onOpen()
    })

    // 收到一条推送：群消息 / 有人上下线 / 已读
    task.onMessage(res => {
      let payload = null
      try {
        // 后台推的是 JSON 文本
        payload = JSON.parse(res.data)
      } catch (error) {
        return
      }
      // 没有类型的包忽略
      if (!payload || !payload.type) return
      // 群聊文字/图片
      if (payload.type === 'COLLAB_MESSAGE' && on.onMessage) {
        on.onMessage(payload.content)
      // 有人进线或离线
      } else if (payload.type === 'COLLAB_PRESENCE' && on.onPresence) {
        on.onPresence(payload.content)
      // 对方已读到哪一条
      } else if (payload.type === 'COLLAB_READ' && on.onRead) {
        on.onRead(payload.content)
      }
    })

    // 连接被关：标离线；不是用户自己关的就重连
    task.onClose(() => {
      state.connected = false
      if (on.onClose) on.onClose()
      if (!state.closedByUser) scheduleReconnect()
    })

    // 出错同样标离线并重连
    task.onError(() => {
      state.connected = false
      if (!state.closedByUser) scheduleReconnect()
    })
  }

  // 给协同群页面用的开关
  return {
    /** 打开连接；用户之前关过的也会重新允许自动重连 */
    open() {
      state.closedByUser = false
      connect()
    },
    /** 用户离开页面时主动关掉，不要再自动连 */
    close() {
      state.closedByUser = true
      clearTimers()
      state.connected = false
      if (state.task) {
        state.task.close({ code: 1000, fail: () => {} })
        state.task = null
      }
    },
    /** 现在有没有连上，页面用来显示「在线/补拉」 */
    isConnected() {
      return state.connected
    }
  }
}

// 协同群页面创建长连接时用
module.exports = { createCollabSocket }
