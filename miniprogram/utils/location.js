const config = require('../config')

/**
 * wx.getLocation 的 type 默认是 wgs84，gcj02 会带上国测局的加密偏移，
 * 两者在青岛差约 460 米。这里统一由 config.coordinateSystem 决定，
 * 必须和堆场三点定标控制点的坐标系一致。
 */
function locationType() {
  return config.coordinateSystem === 'wgs84' ? 'wgs84' : 'gcj02'
}

/** 调试固定点，见 config.mockLocation；未配置时返回 null 走真实定位。 */
function mockLocation() {
  const mock = config.mockLocation
  if (!mock || mock.longitude == null || mock.latitude == null) return null
  return {
    longitude: Number(mock.longitude),
    latitude: Number(mock.latitude),
    accuracy: mock.accuracy == null ? 5 : Number(mock.accuracy),
    speed: mock.speed == null ? 0 : Number(mock.speed),
    direction: mock.direction == null ? -1 : Number(mock.direction)
  }
}

function getCurrentLocation() {
  const mock = mockLocation()
  if (mock) return Promise.resolve(mock)
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: locationType(),
      isHighAccuracy: true,
      highAccuracyExpireTime: 5000,
      success: resolve,
      fail(error) {
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
  if (mockLocation()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    wx.startLocationUpdate({
      type: locationType(),
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
  const mock = mockLocation()
  if (!mock) {
    wx.onLocationChange(listener)
    return null
  }
  listener(mock)
  return setInterval(() => listener(mockLocation()), config.locationReportIntervalMs || 1000)
}

function unwatchLocation(listener, handle) {
  if (handle) {
    clearInterval(handle)
    return
  }
  if (listener) wx.offLocationChange(listener)
  wx.stopLocationUpdate()
}

/**
 * 车头朝向，0 正北、顺时针为正。静止时微信的 direction 常是 0 或 -1，
 * 这种情况返回 undefined，让后端按路段走向兜底。
 */
function headingOf(location, headingDeg) {
  const preferred = Number(headingDeg)
  if (!Number.isNaN(preferred) && preferred >= 0) return preferred
  const fromGps = Number(location && location.direction)
  return !Number.isNaN(fromGps) && fromGps > 0 ? fromGps : undefined
}

/**
 * 上报经纬度和航向。
 * direction：正北 0°，顺时针为正。优先用指南针/已算好的航向，
 * 没有时才用微信 GPS 的 direction（静止时常为 0 或 -1）。
 */
function toReport(location, headingDeg, extra) {
  let direction = headingDeg
  if (direction == null || direction < 0 || Number.isNaN(Number(direction))) {
    direction = location.direction < 0 ? null : location.direction
  }
  const payload = {
    longitude: location.longitude,
    latitude: location.latitude,
    accuracy: location.accuracy,
    speed: location.speed < 0 ? 0 : location.speed,
    direction,
    locationTime: formatLocalDateTime(new Date())
  }
  if (extra && extra.forceReroute) payload.forceReroute = true
  if (extra && extra.snapEdgeCode) payload.snapEdgeCode = extra.snapEdgeCode
  if (extra && extra.snapEdgeName) payload.snapEdgeName = extra.snapEdgeName
  return payload
}

/**
 * 后端 Jackson 全局配的是 yyyy-MM-dd HH:mm:ss（Jackson2ObjectConfig），
 * 用 ISO 的 T 作分隔符会直接反序列化失败，这里必须是空格。
 */
function formatLocalDateTime(date) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

module.exports = {
  getCurrentLocation,
  startLocationUpdate,
  watchLocation,
  unwatchLocation,
  toReport,
  headingOf,
  locationType
}
