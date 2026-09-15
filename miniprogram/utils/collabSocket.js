const config = require('../config')

/**
 * 协同群 WebSocket 客户端。
 *
 * 在线状态由连接本身决定：连上即在线，退出小程序、切后台超过 5 秒、
 * 页面卸载都会断开连接，服务端 onClose 立刻判离线。
 * 断网这类服务端收不到关闭事件的情况，靠这里的定时心跳过期兜底。
 */
const HEARTBEAT_INTERVAL_MS = 20000
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 30000

function createCollabSocket(memberCode, handlers) {
  const on = handlers || {}
  const state = {
    memberCode,
    memberId: on.memberId,
    task: null,
    heartbeatTimer: null,
    reconnectTimer: null,
    retries: 0,
    closedByUser: false,
    connected: false
  }

  function clearTimers() {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer)
      state.heartbeatTimer = null
    }
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
  }

  function scheduleReconnect() {
    if (state.closedByUser || state.reconnectTimer) return
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, state.retries), RECONNECT_MAX_MS)
    state.retries += 1
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null
      connect()
    }, delay)
  }

  function startHeartbeat() {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
    state.heartbeatTimer = setInterval(() => {
      if (!state.task || !state.connected) return
      state.task.send({
        data: JSON.stringify({ type: 'PING', content: 'ping', timestamp: Date.now() }),
        fail: () => {}
      })
    }, HEARTBEAT_INTERVAL_MS)
  }

  function wsBase() {
    const fromApi = String(config.apiBaseUrl || '').replace(/^http/i, 'ws')
    return (fromApi || config.wsBaseUrl || '').replace(/\/$/, '')
  }

  function connect() {
    if (state.closedByUser || (!state.memberCode && !state.memberId)) return
    if (state.task) {
      try { state.task.close({ code: 1000, fail: () => {} }) } catch (error) { /* ignore */ }
      state.task = null
    }
    // 车牌含中文时直接放路径，微信模拟器经常握不上手；有成员 id 就走纯 ASCII
    const userId = state.memberId
      ? 'NAVCOLLAB:id:' + state.memberId
      : 'NAVCOLLAB:' + state.memberCode
    const auth = require('./auth')
    const token = auth.getToken()
    const tokenQuery = token ? `?satoken=${encodeURIComponent(token)}` : ''
    const url = `${wsBase()}/websocket/${encodeURIComponent(userId)}${tokenQuery}`
    const task = wx.connectSocket({ url, fail: () => scheduleReconnect() })
    state.task = task
    if (!task) {
      scheduleReconnect()
      return
    }

    task.onOpen(() => {
      state.connected = true
      state.retries = 0
      startHeartbeat()
      if (on.onOpen) on.onOpen()
    })

    task.onMessage(res => {
      let payload = null
      try {
        payload = JSON.parse(res.data)
      } catch (error) {
        return
      }
      if (!payload || !payload.type) return
      if (payload.type === 'COLLAB_MESSAGE' && on.onMessage) {
        on.onMessage(payload.content)
      } else if (payload.type === 'COLLAB_PRESENCE' && on.onPresence) {
        on.onPresence(payload.content)
      } else if (payload.type === 'COLLAB_READ' && on.onRead) {
        on.onRead(payload.content)
      }
    })

    task.onClose(() => {
      state.connected = false
      if (on.onClose) on.onClose()
      if (!state.closedByUser) scheduleReconnect()
    })

    task.onError(() => {
      state.connected = false
      if (!state.closedByUser) scheduleReconnect()
    })
  }

  return {
    open() {
      state.closedByUser = false
      connect()
    },
    close() {
      state.closedByUser = true
      clearTimers()
      state.connected = false
      if (state.task) {
        state.task.close({ code: 1000, fail: () => {} })
        state.task = null
      }
    },
    isConnected() {
      return state.connected
    }
  }
}

module.exports = { createCollabSocket }
