const config = require('../../config')
const request = require('../../utils/request')
const locationUtil = require('../../utils/location')

Page({
  data: {
    session: {},
    longitude: 0,
    latitude: 0,
    markers: [],
    polyline: [],
    instruction: '正在准备路线',
    remainingDistance: '--',
    estimatedMinutes: '--',
    locationQuality: '等待定位',
    locationQualityClass: 'quality-weak',
    arrivalSuggestion: false
  },

  onLoad(options) {
    this.sessionId = options.sessionId
    this.lastReportTime = 0
    this.locationListener = location => this.handleLocation(location)
    this.loadSession()
  },

  onUnload() {
    this.stopLocationUpdates()
  },

  async loadSession() {
    try {
      const session = await request({ url: `/navigation/mobile/sessions/${this.sessionId}` })
      this.applySession(session)
      this.startLocationUpdates()
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  applySession(session) {
    const route = session.route
    const points = route && route.polyline ? route.polyline : []
    const target = route && route.target ? route.target : points[points.length - 1]
    const first = points[0] || target || { longitude: 0, latitude: 0 }
    this.setData({
      session,
      longitude: first.longitude,
      latitude: first.latitude,
      markers: target ? [{
        id: 1,
        longitude: target.longitude,
        latitude: target.latitude,
        title: session.targetName,
        width: 34,
        height: 34,
        callout: { content: session.targetName, display: 'ALWAYS', padding: 8, borderRadius: 8 }
      }] : [],
      polyline: points.length ? [{ points, color: '#147D55', width: 7, arrowLine: true, borderColor: '#FFFFFF', borderWidth: 2 }] : [],
      instruction: session.nextInstruction || (route && route.instructions && route.instructions[0]) || '沿推荐路线行驶',
      remainingDistance: Math.round(session.remainingDistanceMeters || (route && route.distanceMeters) || 0),
      estimatedMinutes: route ? Math.max(1, Math.ceil(route.estimatedSeconds / 60)) : '--',
      arrivalSuggestion: Boolean(session.arrivalSuggestion)
    })
  },

  startLocationUpdates() {
    wx.startLocationUpdate({
      success: () => wx.onLocationChange(this.locationListener),
      fail: () => wx.showModal({
        title: '需要定位权限',
        content: '导航期间需要持续获取当前位置，请允许定位权限。',
        success: result => result.confirm && wx.openSetting()
      })
    })
  },

  stopLocationUpdates() {
    if (this.locationListener) {
      wx.offLocationChange(this.locationListener)
    }
    wx.stopLocationUpdate()
  },

  async handleLocation(location) {
    const now = Date.now()
    this.setData({
      longitude: location.longitude,
      latitude: location.latitude,
      locationQuality: location.accuracy <= 30 ? '良好' : '较弱',
      locationQualityClass: location.accuracy <= 30 ? 'quality-good' : 'quality-weak'
    })
    if (now - this.lastReportTime < config.locationReportIntervalMs || this.reporting) {
      return
    }
    this.lastReportTime = now
    this.reporting = true
    try {
      const response = await request({
        url: `/navigation/mobile/sessions/${this.sessionId}/locations`,
        method: 'POST',
        data: locationUtil.toReport(location)
      })
      if (response.route) {
        this.applySession({ ...response, route: response.route })
        wx.showToast({ title: '路线已重新规划', icon: 'none' })
      } else {
        this.setData({
          session: response,
          instruction: response.nextInstruction || this.data.instruction,
          remainingDistance: Math.round(response.remainingDistanceMeters || 0),
          arrivalSuggestion: Boolean(response.arrivalSuggestion)
        })
      }
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    } finally {
      this.reporting = false
    }
  },

  centerLocation() {
    wx.createMapContext('navigationMap', this).moveToLocation()
  },

  confirmArrival() {
    wx.showModal({
      title: '确认到达',
      content: `确认已经抵达${this.data.session.targetName}吗？`,
      success: async result => {
        if (!result.confirm) return
        try {
          await request({ url: `/navigation/mobile/sessions/${this.sessionId}/arrive`, method: 'POST' })
          this.stopLocationUpdates()
          wx.showToast({ title: '导航已完成', icon: 'success' })
          setTimeout(() => wx.switchTab({ url: '/pages/home/index' }), 1200)
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none' })
        }
      }
    })
  },

  reportException() {
    const items = ['道路封闭', '目标位置错误', '找不到目标', '定位信号弱', '其他问题']
    const types = ['ROAD_BLOCKED', 'TARGET_ERROR', 'TARGET_NOT_FOUND', 'LOCATION_WEAK', 'OTHER']
    wx.showActionSheet({
      itemList: items,
      success: async result => {
        try {
          await request({
            url: `/navigation/mobile/sessions/${this.sessionId}/exceptions`,
            method: 'POST',
            data: {
              exceptionType: types[result.tapIndex],
              description: items[result.tapIndex],
              longitude: this.data.longitude,
              latitude: this.data.latitude
            }
          })
          wx.showToast({ title: '异常已上报', icon: 'success' })
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none' })
        }
      }
    })
  },

  cancelNavigation() {
    wx.showModal({
      title: '结束导航',
      content: '结束后将停止位置上报，确定继续吗？',
      confirmColor: '#b42318',
      success: async result => {
        if (!result.confirm) return
        try {
          await request({ url: `/navigation/mobile/sessions/${this.sessionId}/cancel`, method: 'POST' })
          this.stopLocationUpdates()
          wx.switchTab({ url: '/pages/home/index' })
        } catch (error) {
          wx.showToast({ title: error.message, icon: 'none' })
        }
      }
    })
  }
})
