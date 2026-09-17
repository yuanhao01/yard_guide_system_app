/**
 * 协同群未读：轮询各群未读、写底部 tab 数字、通知页面刷新卡片。
 * 不把聊天长连接提到全局，避免「打开小程序就算在线」。
 * 依赖：request、auth。
 */
const request = require('./request')
const auth = require('./auth')

const POLL_MS = 5000 // 前台每隔 5 秒对一次未读
const TAB_INDEX = 0 // 底部「导航/协同」那一栏

const state = {
  ready: false, // 是否已经拉过第一轮，用来避免一进页就弹「来消息」
  groups: [], // 当前各群摘要
  total: 0, // 全部未读合计，给 tab 用
  activeGroupId: null, // 正在看的那个群，这个群不弹来消息提示
  timer: null, // 轮询定时器
  refreshing: false, // 防止上一次还没回来又发一次
  listeners: [] // 首页等页面的订阅
}

/** 未读数字写成 tab 能显示的短字，超过 99 显示 99+ */
function badgeText(count) {
  const n = Number(count) || 0
  if (n <= 0) return ''
  return n > 99 ? '99+' : String(n)
}

/** 把合计写到底部第一栏；没有未读就摘掉数字 */
function syncTabBar() {
  const text = badgeText(state.total)
  if (text) {
    wx.setTabBarBadge({
      index: TAB_INDEX,
      text,
      fail() {}
    })
    return
  }
  wx.removeTabBarBadge({
    index: TAB_INDEX,
    fail() {}
  })
}

/** 通知已订阅的页面，让卡片右上角跟着变 */
function emit() {
  const snapshot = {
    groups: state.groups,
    total: state.total,
    activeGroupId: state.activeGroupId
  }
  state.listeners.forEach(fn => {
    try {
      fn(snapshot)
    } catch (error) {
      // 某个页面回调失败不影响其它页
    }
  })
}

/** 当前栈顶是哪一页，用来决定要不要弹「来消息」 */
function currentRoute() {
  const pages = getCurrentPages()
  const page = pages.length ? pages[pages.length - 1] : null
  return page && page.route ? page.route : ''
}

/** 不在这个群里时，未读增加就短震，必要时再提一句最新内容 */
function notifyIncoming(group) {
  const groupId = group && group.id != null ? String(group.id) : ''
  if (groupId && groupId === String(state.activeGroupId || '')) return
  if (wx.vibrateShort) {
    wx.vibrateShort({ type: 'medium' })
  }
  const route = currentRoute()
  // 首页卡片已经会亮数字，不再弹窗抢视线
  if (route === 'pages/home/index') return
  const preview = String(group.lastMsgPreview || '收到新群消息').trim()
  wx.showToast({
    title: preview.length > 16 ? `${preview.slice(0, 16)}…` : preview,
    icon: 'none',
    duration: 1800
  })
}

/** 用后台列表重算合计，并判断有没有新未读 */
function applyGroups(list, options) {
  const groups = Array.isArray(list) ? list : []
  const silent = options && options.silent
  const prevMap = {}
  state.groups.forEach(item => {
    if (item && item.id != null) prevMap[String(item.id)] = item
  })
  let total = 0
  let incoming = null
  groups.forEach(item => {
    const unread = Number(item && item.unreadCount) || 0
    total += unread
    if (!item || item.id == null) return
    const id = String(item.id)
    const prev = prevMap[id]
    const prevUnread = prev ? (Number(prev.unreadCount) || 0) : 0
    if (unread > prevUnread) incoming = item
  })
  const firstLoad = !state.ready
  state.ready = true
  state.groups = groups
  state.total = total
  syncTabBar()
  emit()
  if (!silent && !firstLoad && incoming) {
    notifyIncoming(incoming)
  }
}

/** 向后台拉自己的进行中群和未读 */
async function refresh(options) {
  if (!auth.isLoggedIn()) {
    clear(true)
    return []
  }
  if (state.refreshing) return state.groups
  state.refreshing = true
  try {
    const groups = await request({ url: '/navigation/mobile/collab/my-groups' })
    applyGroups(groups || [], options)
    return state.groups
  } catch (error) {
    return state.groups
  } finally {
    state.refreshing = false
  }
}

/** 开始前台轮询；已在轮询则只补拉一次 */
function start() {
  if (!auth.isLoggedIn()) {
    stop()
    return
  }
  refresh({ silent: !state.ready })
  if (state.timer) return
  state.timer = setInterval(() => refresh(), POLL_MS)
}

/** 停轮询，退出登录时连徽章一起清 */
function stop() {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
  clear(true)
}

/** 切到后台时只停轮询，徽章先留着 */
function pause() {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
}

/** 正在看某个群：这个群来消息不再弹提示 */
function setActiveGroup(groupId) {
  state.activeGroupId = groupId == null ? null : String(groupId)
}

/** 进群看完后本地先把该群未读清掉，等下一轮轮询对齐 */
function zeroGroup(groupId) {
  if (groupId == null) return
  const id = String(groupId)
  const groups = state.groups.map(item => (
    item && String(item.id) === id
      ? Object.assign({}, item, { unreadCount: 0 })
      : item
  ))
  applyGroups(groups, { silent: true })
}

/** 清空未读状态；clearBadge 为真时摘掉 tab 数字 */
function clear(clearBadge) {
  state.ready = false
  state.groups = []
  state.total = 0
  state.activeGroupId = null
  if (clearBadge) syncTabBar()
  emit()
}

/** 页面订阅未读变化，返回取消订阅函数 */
function subscribe(fn) {
  if (typeof fn !== 'function') return () => {}
  state.listeners.push(fn)
  fn({
    groups: state.groups,
    total: state.total,
    activeGroupId: state.activeGroupId
  })
  return () => {
    state.listeners = state.listeners.filter(item => item !== fn)
  }
}

function getGroups() {
  return state.groups
}

function getTotal() {
  return state.total
}

function isReady() {
  return state.ready
}

module.exports = {
  badgeText,
  clear,
  getGroups,
  getTotal,
  isReady,
  pause,
  refresh,
  setActiveGroup,
  start,
  stop,
  subscribe,
  zeroGroup
}
