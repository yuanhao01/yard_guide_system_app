function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'gcj02',
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

function toReport(location) {
  return {
    longitude: location.longitude,
    latitude: location.latitude,
    accuracy: location.accuracy,
    speed: location.speed < 0 ? 0 : location.speed,
    direction: location.direction < 0 ? null : location.direction,
    locationTime: formatLocalDateTime(new Date())
  }
}

function formatLocalDateTime(date) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

module.exports = {
  getCurrentLocation,
  toReport
}
