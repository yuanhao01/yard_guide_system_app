/**
 * 导航页堆高机定位长连接。
 * 连上后收 GPS_LOCATION，按 cyId / forkliftId 区分不同堆场、不同车。
 * 依赖：config（接口/长连接地址）、auth（登录令牌）。
 */
const config = require('../config')

const HEARTBEAT_INTERVAL_MS = 20000
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 30000

function createYardSocket(options) {
  const on = options || {}
  const state = {
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

  function parsePayload(raw) {
    if (!raw) return null
    if (typeof raw === 'object') return raw
    try {
      return JSON.parse(raw)
    } catch (error) {
      return null
    }
  }

  function connect() {
    if (state.closedByUser) return
    if (state.task) {
      try { state.task.close({ code: 1000, fail: () => {} }) } catch (error) { /* ignore */ }
      state.task = null
    }
    const auth = require('./auth')
    const user = auth.getUser() || {}
    const token = auth.getToken()
    const driverId = user.driverId || user.id || 'guest'
    const cyId = on.cyId || user.currentCyId || ''
    const query = []
    if (token) query.push(`satoken=${encodeURIComponent(token)}`)
    if (cyId) query.push(`cyId=${encodeURIComponent(cyId)}`)
    const url = `${wsBase()}/websocket/${encodeURIComponent('NAVLOC:' + driverId)}${query.length ? '?' + query.join('&') : ''}`
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
      if (payload.type === 'GPS_LOCATION' && on.onGpsLocation) {
        const content = parsePayload(payload.content)
        if (content) on.onGpsLocation(content)
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

module.exports = { createYardSocket }
