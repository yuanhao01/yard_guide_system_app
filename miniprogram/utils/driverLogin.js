/**
 * 司机车牌 + 堆场登录：登录页手动登录、扫作业小票自动登录共用。
 * 依赖：request、auth、features（模拟定位设置）、collabUnread（协同未读）。
 */
const request = require('./request')
const auth = require('./auth')
const collabUnread = require('./collabUnread')
const features = require('./features')

const LAST_PLATE_KEY = 'nav_last_plate' // 本机上次登录的车牌，微信识别没回来前先顶上
const LAST_YARD_KEY = 'nav_last_cy_id' // 本机上次登录的堆场

/** 用车牌和堆场编号登录，记住登录态并准备好首页要用的数据；失败抛出中文错误 */
async function loginDriver({ plateNumber, cyId, wxTicket }) {
  const user = await request({
    url: '/navigation/auth/driver-login',
    method: 'POST',
    data: { plateNumber, cyId, wxTicket: wxTicket || '' }, // 车牌、堆场编号、微信票据
    skipUnauthorizedRedirect: true // 账密错不要跳登录死循环
  })
  auth.setSession(user) // 把令牌和用户记到手机
  getApp().globalData.user = user // 同步到全局，各页马上能用
  wx.setStorageSync(LAST_PLATE_KEY, user.plateNumber || plateNumber) // 下次打开先填上
  wx.setStorageSync(LAST_YARD_KEY, cyId)
  await features.refreshQuietly() // 拿到本堆场的模拟定位设置
  collabUnread.start()
  return user
}

module.exports = { loginDriver, LAST_PLATE_KEY, LAST_YARD_KEY }
