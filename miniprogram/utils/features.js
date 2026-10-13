/**
 * 后台下发的司机端开关：模拟定位点（字典 nav_mock_location）、拖车测试（字典 nav_truck_drag）。
 * 模拟点按当前堆场下发，缓存在手机里，定位模块同步读取；改字典即可切换，不用发版。
 * 依赖：request（问后台）、auth（登录态、缓存名）。
 */
const request = require('./request')
const auth = require('./auth')

/** 读缓存的模拟点；没有就是用手机真实 GPS */
function getCachedMockLocation() {
  try {
    return wx.getStorageSync(auth.MOCK_LOCATION_KEY) || null
  } catch (error) {
    return null
  }
}

/**
 * 向后台要最新开关并刷新缓存。登录、切堆场、回到前台、进导航页时调用。
 * 网络失败就保留旧缓存，免得一次抖动把模拟点丢了又变回真实 GPS。
 */
async function refresh() {
  // 没登录不知道是哪个堆场，模拟点也不该留着
  if (!auth.isLoggedIn()) {
    wx.removeStorageSync(auth.MOCK_LOCATION_KEY)
    return {}
  }
  const features = (await request({ url: '/navigation/mobile/features', skipUnauthorizedRedirect: true })) || {}
  if (features.mockLocation && features.mockLocation.longitude != null && features.mockLocation.latitude != null) {
    wx.setStorageSync(auth.MOCK_LOCATION_KEY, features.mockLocation)
  } else {
    wx.removeStorageSync(auth.MOCK_LOCATION_KEY)
  }
  return features
}

/** 不关心结果的刷新：失败只打日志 */
function refreshQuietly() {
  return refresh().catch(error => {
    console.warn('[features] 刷新司机端开关失败，沿用缓存', error.message)
    return null
  })
}

module.exports = {
  getCachedMockLocation, // 定位模块同步读
  refresh, // 要拿到开关结果时用（导航页）
  refreshQuietly // 登录、切堆场、回前台时顺手刷新
}
