/**
 * 定位：取当前位置、持续跟车、把经纬度整理成后台要的格式。
 * 调试时若 config 里填了固定点，就完全不读手机 GPS。
 * 依赖：config（坐标系、调试点、上报间隔）。
 */
const config = require('../config')

/**
 * wx.getLocation 的 type 默认是 wgs84，gcj02 会带上国测局的加密偏移，
 * 两者在青岛差约 460 米。这里统一由 config.coordinateSystem 决定，
 * 必须和堆场三点定标控制点的坐标系一致。
 */
function locationType() {
  // 和堆场控制点同一套：wgs84 或国测局 gcj02
  return config.coordinateSystem === 'wgs84' ? 'wgs84' : 'gcj02'
}

/** 调试固定点，见 config.mockLocation；未配置时返回 null 走真实定位。 */
function mockLocation() {
  // 读出配置里的固定点
  const mock = config.mockLocation
  // 没配经纬度就当没有调试点
  if (!mock || mock.longitude == null || mock.latitude == null) return null
  // 整理成和微信定位一样的结构，后面上报、跟车都能直接用
  return {
    longitude: Number(mock.longitude), // 经度
    latitude: Number(mock.latitude), // 纬度
    accuracy: mock.accuracy == null ? 5 : Number(mock.accuracy), // 精度（米），没填就当 5 米
    speed: mock.speed == null ? 0 : Number(mock.speed), // 车速，没填就当停着
    direction: mock.direction == null ? -1 : Number(mock.direction) // 车头朝向，没填给 -1 让后台按路段兜底
  }
}

/** 取一次当前位置：有调试点就直接用调试点，否则问手机 GPS */
function getCurrentLocation() {
  // 先看有没有办公室调试点
  const mock = mockLocation()
  // 有就立刻返回，不打扰手机定位
  if (mock) return Promise.resolve(mock)
  // 向微信要一次高精度定位
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: locationType(), // 必须和堆场控制点同一坐标系
      isHighAccuracy: true, // 尽量用高精度，场内车道窄
      highAccuracyExpireTime: 5000, // 高精度等 5 秒，再等就太慢
      success: resolve, // 拿到点就交给页面
      fail(error) {
        // 用户拒绝权限和定位服务关了，提示不一样
        const message = error.errMsg && error.errMsg.includes('auth deny')
          ? '请在设置中允许使用位置信息'
          : '暂时无法获取当前位置，请检查定位服务'
        reject(new Error(message))
      }
    })
  })
}

/**
 * 开启持续定位。
 *
 * wx.startLocationUpdate 的 type 同样默认 wgs84，必须和单次定位取同一个坐标系，
 * 否则页面上的车会在两种坐标系之间来回跳 460 米。
 */
function startLocationUpdate() {
  // 调试固定点不需要开系统持续定位
  if (mockLocation()) return Promise.resolve()
  // 向微信申请持续上报位置
  return new Promise((resolve, reject) => {
    wx.startLocationUpdate({
      type: locationType(), // 和单次定位同一坐标系，避免车来回跳
      success: resolve,
      fail: reject
    })
  })
}

/**
 * 订阅位置变化。配了调试固定点时不碰系统定位，改成按同样的节奏回放那个点，
 * 上报、吸附、重规划的链路和真机完全一致。
 */
function watchLocation(listener) {
  // 取出调试点
  const mock = mockLocation()
  // 没有调试点就听手机真实位置变化
  if (!mock) {
    wx.onLocationChange(listener)
    return null
  }
  // 先立刻回放一次，页面马上能画上车
  listener(mock)
  // 再按上报间隔反复回放，模拟 1 秒一次跟车
  return setInterval(() => listener(mockLocation()), config.locationReportIntervalMs || 1000)
}

/** 结束跟车：调试点停掉定时器，真机取消监听并关掉持续定位 */
function unwatchLocation(listener, handle) {
  // 调试回放用的是定时器
  if (handle) {
    clearInterval(handle)
    return
  }
  // 真机：取消位置变化回调
  if (listener) wx.offLocationChange(listener)
  // 真机：关掉持续定位，省电
  wx.stopLocationUpdate()
}

/**
 * 车头朝向，0 正北、顺时针为正。静止时微信的 direction 常是 0 或 -1，
 * 这种情况返回 undefined，让后端按路段走向兜底。
 */
function headingOf(location, headingDeg) {
  // 优先用页面已经算好的指南针朝向
  const preferred = Number(headingDeg)
  // 是有效角度就直接用
  if (!Number.isNaN(preferred) && preferred >= 0) return preferred
  // 退回微信 GPS 自带的方向
  const fromGps = Number(location && location.direction)
  // GPS 方向大于 0 才信，0/-1 多半是停车时的假值
  return !Number.isNaN(fromGps) && fromGps > 0 ? fromGps : undefined
}

/**
 * 上报经纬度和航向。
 * direction：正北 0°，顺时针为正。优先用指南针/已算好的航向，
 * 没有时才用微信 GPS 的 direction（静止时常为 0 或 -1）。
 */
function toReport(location, headingDeg, extra) {
  // 先用页面传来的朝向
  let direction = headingDeg
  // 没朝向或是无效值，再看 GPS
  if (direction == null || direction < 0 || Number.isNaN(Number(direction))) {
    // GPS 给 -1 表示没有方向，改成空让后台按路段兜底
    direction = location.direction < 0 ? null : location.direction
  }
  // 整理成后台要的一包定位
  const payload = {
    accuracy: location && location.accuracy, // 精度（米）
    speed: location && location.speed < 0 ? 0 : (location && location.speed), // 负速度当停车
    direction, // 车头朝向
    locationTime: formatLocalDateTime(new Date()) // 这次定位的本地时间
  }
  if (location && location.longitude != null) payload.longitude = location.longitude
  if (location && location.latitude != null) payload.latitude = location.latitude
  if (extra && extra.sceneX != null) payload.sceneX = extra.sceneX
  if (extra && extra.sceneY != null) payload.sceneY = extra.sceneY
  if (extra && extra.dragTest) payload.dragTest = true
  // 司机已经开到另一条路，要求后台立刻重算路线
  if (extra && extra.forceReroute) payload.forceReroute = true
  // 画面上车贴在哪条路，让规划起点和画面一致
  if (extra && extra.snapEdgeCode) payload.snapEdgeCode = extra.snapEdgeCode
  // 路名，后台日志和规划对照用
  if (extra && extra.snapEdgeName) payload.snapEdgeName = extra.snapEdgeName
  // 交给导航页去 POST
  return payload
}

/**
 * 后端 Jackson 全局配的是 yyyy-MM-dd HH:mm:ss（Jackson2ObjectConfig），
 * 用 ISO 的 T 作分隔符会直接反序列化失败，这里必须是空格。
 */
function formatLocalDateTime(date) {
  // 个位数前面补 0，例如 9 变成 09
  const pad = value => String(value).padStart(2, '0')
  // 拼成后台能认的「年-月-日 时:分:秒」
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// 导航页、确认任务、验箱页取点、跟车、上报都走这里
module.exports = {
  getCurrentLocation, // 取一次当前位置
  startLocationUpdate, // 打开持续定位
  watchLocation, // 订阅位置变化
  unwatchLocation, // 结束跟车
  toReport, // 整理上报内容
  headingOf, // 算出车头朝向
  locationType // 当前用的坐标系
}
