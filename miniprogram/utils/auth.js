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

function isFieldRole() {
  const user = getUser()
  if (!user) return false
  if (user.userKind === 'role' || user.userKind === 'staff') {
    const roleType = Number(user.roleType)
    return roleType === 1 || roleType === 2 || roleType === 3
  }
  return false
}

function canSwitchYard() {
  const yards = (getUser() || {}).accessibleYards || []
  return yards.length > 1
}

module.exports = {
  clearSession,
  getToken,
  getUser,
  canSwitchYard,
  isFieldRole,
  isLoggedIn,
  setSession
}
