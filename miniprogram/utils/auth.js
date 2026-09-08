const TOKEN_KEY = 'satoken'
const USER_KEY = 'navigation_user'

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || ''
}

function setSession(user) {
  wx.setStorageSync(TOKEN_KEY, user.token)
  wx.setStorageSync(USER_KEY, user)
}

function clearSession() {
  wx.removeStorageSync(TOKEN_KEY)
  wx.removeStorageSync(USER_KEY)
}

function getUser() {
  return wx.getStorageSync(USER_KEY) || null
}

function isLoggedIn() {
  return Boolean(getToken())
}

module.exports = {
  clearSession,
  getToken,
  getUser,
  isLoggedIn,
  setSession
}
