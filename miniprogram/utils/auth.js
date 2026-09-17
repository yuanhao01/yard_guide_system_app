/**
 * 登录态：把微信里记住的令牌和用户信息取出来、存进去、清掉。
 * 用来判断现在有没有人登录、是不是现场岗位、能不能换堆场。
 */
// 登录令牌在手机里的存放名字，请求后台时要带上
const TOKEN_KEY = 'satoken'
// 当前登录用户资料在手机里的存放名字
const USER_KEY = 'navigation_user'

/** 取出当前登录令牌，没有登录就返回空字符串 */
function getToken() {
  // 从手机本地读出令牌，没有就当未登录
  return wx.getStorageSync(TOKEN_KEY) || ''
}

/** 登录成功后把令牌和用户信息记在手机里，下次打开不用再登 */
function setSession(user) {
  // 把登录令牌存到手机
  wx.setStorageSync(TOKEN_KEY, user.token)
  // 把用户资料（姓名、堆场、岗位等）存到手机
  wx.setStorageSync(USER_KEY, user)
}

/** 退出登录时清掉手机里的令牌和用户资料 */
function clearSession() {
  // 删掉登录令牌
  wx.removeStorageSync(TOKEN_KEY)
  // 删掉用户资料
  wx.removeStorageSync(USER_KEY)
}

/** 取出当前登录用户；没登录返回空 */
function getUser() {
  // 从手机本地读出用户资料
  return wx.getStorageSync(USER_KEY) || null
}

/** 判断现在有没有登录（有令牌就算已登录） */
function isLoggedIn() {
  // 有令牌就是已登录
  return Boolean(getToken())
}

/** 判断是不是现场岗位（堆高机/道口/调度），用来决定首页显示协同还是导航 */
function isFieldRole() {
  // 先取出当前用户
  const user = getUser()
  // 没登录就不是现场岗位
  if (!user) return false
  // 电脑端岗位账号或现场人员账号才往下看岗位类型
  if (user.userKind === 'role' || user.userKind === 'staff') {
    // 岗位类型：1 堆高机、2 道口、3 调度
    const roleType = Number(user.roleType)
    // 这三种现场岗位返回是
    return roleType === 1 || roleType === 2 || roleType === 3
  }
  // 司机账号不是现场岗位
  return false
}

/** 判断这个人能不能在首页切换堆场（能进两个以上堆场才显示切换） */
function canSwitchYard() {
  const user = getUser() || {}
  // 车牌进场时堆场已经定死
  if (user.plateLogin) return false
  const yards = user.accessibleYards || []
  return yards.length > 1
}

// 给各页面用的登录相关方法
module.exports = {
  clearSession, // 退出时清本地登录态
  getToken, // 取令牌给请求带头
  getUser, // 取当前用户资料
  canSwitchYard, // 是否显示切换堆场
  isFieldRole, // 是否现场岗位
  isLoggedIn, // 是否已登录
  setSession // 登录成功后写入本地
}
