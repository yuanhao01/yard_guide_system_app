const request = require('../../utils/request')
const locationUtil = require('../../utils/location')
const yardScene = require('../../utils/yardScene')
const specialNav = require('../../utils/specialNav')
const routeInstruction = require('../../utils/routeInstruction')
const headingSensor = require('../../utils/heading')
const config = require('../../config')

function touchDistance(touches) {
  return Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y)
}

function touchMidpoint(touches) {
  return {
    x: (touches[0].x + touches[1].x) / 2,
    y: (touches[0].y + touches[1].y) / 2
  }
}

function touchAngle(touches) {
  return Math.atan2(touches[1].y - touches[0].y, touches[1].x - touches[0].x)
}

function normalizeAngleDelta(delta) {
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

function pickSafetyInstruction(page, fallback) {
  const targetName = (page.session && page.session.targetName) || '安全操作区'
  const painted = page.scene && page.scene.getPaintedRoute && page.scene.getPaintedRoute()
  const selfWorld = page.scene && page.scene.getSelfWorld && page.scene.getSelfWorld()
  const fromPainted = painted
    ? routeInstruction.describeWorldInstruction(selfWorld, painted, targetName)
    : ''
  if (fromPainted) return fromPainted
  const blocks = page.yardMapData && page.yardMapData.blocks
  return routeInstruction.describeNextInstruction(page.self, page.routePoints, targetName, blocks)
    || fallback
    || '沿当前道路直行'
}

Page({
  data: {
    statusBarHeight: 20,
    subtitle: '提箱完成 · 请前往验箱',
    instruction: '正在规划前往安全操作区',
    mapLoading: true,
    mapError: '',
    confirming: false,
    equipmentName: '',
    workTypeLabel: '',
    carrierCode: '',
    cntrNo: '',
    cntrSize: '',
    followMode: true,
    followIcon: '+',
    followLabel: '跟车',
    flatMode: false,
    flatLabel: '2D'
  },

  onLoad(options) {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20 })
    this.jobSessionId = options.jobSessionId || ''
    this.sessionId = options.sessionId || ''
    this.self = null
    this.scene = null
    this.ended = false
    this.lastReportTime = 0
    this.locationListener = location => this.handleLocation(location)
    this.offHeading = headingSensor.onChange(deg => {
      if (this.self) this.self = { ...this.self, heading: deg, headingFrom: 'compass' }
      if (this.scene && this.scene.setHeading) this.scene.setHeading(deg)
    })
    headingSensor.start()
    setTimeout(() => headingSensor.start(), 600)
    this.initScene().then(() => this.bootstrap())
  },

  onShow() {
    headingSensor.start()
  },

  onReady() {
    headingSensor.start()
  },

  onUnload() {
    this.ended = true
    if (this.locationListener) wx.offLocationChange(this.locationListener)
    wx.stopLocationUpdate()
    if (this.offHeading) this.offHeading()
    headingSensor.stop()
    if (this.scene) {
      this.scene.dispose()
      this.scene = null
    }
  },

  initScene() {
    return new Promise(resolve => {
      wx.createSelectorQuery()
        .select('#yardCanvas')
        .fields({ node: true, size: true })
        .exec(result => {
          const item = result && result[0]
          if (!item || !item.node) {
            resolve()
            return
          }
          const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
          const dpr = Math.min((windowInfo && windowInfo.pixelRatio) || 2, 2.5)
          try {
            this.scene = yardScene.createYardScene(item.node, item.width, item.height, dpr)
          } catch (error) {
            this.setData({ mapError: '三维引擎初始化失败' })
          }
          resolve()
        })
    })
  },

  async bootstrap() {
    try {
      if (this.sessionId) {
        this.session = await request({ url: `/navigation/mobile/sessions/${this.sessionId}` })
      } else {
        const job = this.jobSessionId
          ? await request({ url: `/navigation/mobile/sessions/${this.jobSessionId}` })
          : await request({ url: '/navigation/mobile/sessions/current' })
        this.session = await specialNav.startSpecialNav({
          purpose: 'safety',
          parentSessionId: (job && (job.jobSessionId || job.id)) || this.jobSessionId,
          task: job
        })
        this.sessionId = this.session.id
        this.jobSessionId = this.session.jobSessionId || this.jobSessionId
      }
      this.setData({
        subtitle: (this.session.workTypeLabel ? `${this.session.workTypeLabel}完成 · ` : '') + '请前往验箱',
        instruction: pickSafetyInstruction(this, this.session.nextInstruction || '前方进入安全操作区'),
        equipmentName: this.session.equipmentName || '',
        workTypeLabel: this.session.workTypeLabel || '',
        carrierCode: this.session.carrierCode || '',
        cntrNo: this.session.cntrNo || '',
        cntrSize: this.session.cntrSize || ''
      })
      await this.loadYardMap(this.session.cyId)
      const location = await locationUtil.getCurrentLocation()
      this.applySelf(location)
      locationUtil.startLocationUpdate()
        .then(() => wx.onLocationChange(this.locationListener))
        .catch(() => {})
    } catch (error) {
      this.setData({ mapError: error.message || '无法进入安全操作区', mapLoading: false })
    }
  },

  async loadYardMap(cyId) {
    if (!cyId || !this.scene) return
    try {
      this.yardMapData = await request({ url: `/navigation/mobile/yards/${cyId}/map` })
      const route = this.session.route
      this.routePoints = route && route.polyline ? route.polyline : []
      this.targetPoint = (route && route.target) || this.routePoints[this.routePoints.length - 1]
      this.scene.setMap(this.yardMapData)
      this.scene.setRoute(this.routePoints)
      this.scene.setTarget(
        this.targetPoint,
        this.session.targetName,
        this.session.targetBlockId,
        this.session.targetSlot
      )
      if (this.scene.setPurpose) this.scene.setPurpose('safety')
      if (this.scene.enableFollow) this.scene.enableFollow()
      this.setData({
        mapLoading: false,
        mapError: '',
        followMode: true,
        followIcon: '+',
        followLabel: '跟车'
      })
    } catch (error) {
      this.setData({ mapError: error.message, mapLoading: false })
    }
  },

  applySelf(location) {
    if (headingSensor.get() == null && location.direction > 0 && headingSensor.seed) {
      headingSensor.seed(location.direction)
    }
    this.self = {
      longitude: location.longitude,
      latitude: location.latitude,
      heading: headingSensor.get() != null
        ? headingSensor.get()
        : (location.direction > 0 ? location.direction : (this.self && this.self.heading != null ? this.self.heading : 0)),
      accuracy: location.accuracy,
      speed: location.speed
    }
    if (this.scene) this.scene.setSelf(this.self)
    const instruction = pickSafetyInstruction(this, this.data.instruction)
    if (instruction && instruction !== this.data.instruction) {
      this.setData({ instruction })
    }
  },

  async handleLocation(location) {
    if (this.ended) return
    this.applySelf(location)
    const now = Date.now()
    if (!this.sessionId || now - this.lastReportTime < (config.locationReportIntervalMs || 3000) || this.reporting) {
      return
    }
    this.lastReportTime = now
    this.reporting = true
    try {
      const response = await request({
        url: `/navigation/mobile/sessions/${this.sessionId}/locations`,
        method: 'POST',
        data: locationUtil.toReport(location, this.self && this.self.heading)
      })
      if (response.route && this.scene) {
        this.routePoints = response.route.polyline || this.routePoints
        this.scene.setRoute(this.routePoints)
      }
      const instruction = pickSafetyInstruction(this, response.nextInstruction)
      if (instruction) {
        this.setData({ instruction })
      }
    } catch (error) {
      if (!/已结束/.test(error.message || '')) {
        console.warn('[safety-zone] report', error)
      }
    } finally {
      this.reporting = false
    }
  },

  markMapAdjusted() {
    const status = this.scene && this.scene.getStatus ? this.scene.getStatus() : {}
    this.setData({
      followMode: false,
      followIcon: '#',
      followLabel: '全场',
      flatMode: typeof status.flatMode === 'boolean' ? status.flatMode : this.data.flatMode,
      flatLabel: status.flatMode ? '3D' : '2D'
    })
  },

  onCanvasTouchStart(event) {
    headingSensor.start()
    const touches = event.touches || []
    this.gestureMode = null
    if (touches.length >= 2) {
      this.pinchDistance = touchDistance(touches)
      this.pinchMid = touchMidpoint(touches)
      this.pinchAngle = touchAngle(touches)
      this.panLast = null
    } else if (touches.length === 1) {
      this.panLast = { x: touches[0].x, y: touches[0].y }
      this.pinchDistance = 0
      this.pinchMid = null
      this.pinchAngle = null
    }
  },

  onCanvasTouchMove(event) {
    if (!this.scene) return
    const touches = event.touches || []

    if (touches.length >= 2) {
      const distance = touchDistance(touches)
      const mid = touchMidpoint(touches)
      const angle = touchAngle(touches)
      if (!this.pinchDistance) {
        this.pinchDistance = distance
        this.pinchMid = mid
        this.pinchAngle = angle
        return
      }

      const dDist = distance - this.pinchDistance
      const dMidY = mid.y - (this.pinchMid ? this.pinchMid.y : mid.y)
      const dMidX = mid.x - (this.pinchMid ? this.pinchMid.x : mid.x)
      const dAngle = normalizeAngleDelta(angle - (this.pinchAngle != null ? this.pinchAngle : angle))
      const scaleChange = Math.abs(dDist)
      const parallelMove = Math.hypot(dMidX, dMidY)
      const rotateMove = Math.abs(dAngle) * Math.max(distance, 1)

      if (!this.gestureMode) {
        if (rotateMove > 14 && rotateMove > scaleChange * 1.1 && rotateMove > parallelMove * 0.9) {
          this.gestureMode = 'rotate'
        } else if (scaleChange > 10 && scaleChange > parallelMove * 0.85 && scaleChange > rotateMove) {
          this.gestureMode = 'zoom'
        } else if (Math.abs(dMidY) > 8 && Math.abs(dMidY) > Math.abs(dMidX) * 1.15 && parallelMove > rotateMove) {
          this.gestureMode = 'tilt'
        } else if (scaleChange > 4 || parallelMove > 4 || rotateMove > 8) {
          const scores = [
            ['rotate', rotateMove],
            ['zoom', scaleChange],
            ['tilt', Math.abs(dMidY) > Math.abs(dMidX) ? parallelMove : 0]
          ]
          scores.sort((a, b) => b[1] - a[1])
          this.gestureMode = scores[0][0]
        }
      }

      if (this.gestureMode === 'zoom') {
        const factor = distance / this.pinchDistance
        if (isFinite(factor) && Math.abs(factor - 1) >= 0.008) {
          this.scene.zoom(factor)
          this.markMapAdjusted()
        }
      } else if (this.gestureMode === 'tilt') {
        if (Math.abs(dMidY) >= 1) {
          this.scene.tilt(dMidY)
          this.markMapAdjusted()
        }
      } else if (this.gestureMode === 'rotate') {
        if (Math.abs(dAngle) >= 0.004) {
          this.scene.rotate(dAngle)
          this.markMapAdjusted()
        }
      }

      this.pinchDistance = distance
      this.pinchMid = mid
      this.pinchAngle = angle
      this.panLast = null
      return
    }

    if (touches.length === 1 && this.panLast) {
      const dx = touches[0].x - this.panLast.x
      const dy = touches[0].y - this.panLast.y
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      this.panLast = { x: touches[0].x, y: touches[0].y }
      this.scene.pan(dx, dy)
      if (this.data.followMode) this.markMapAdjusted()
    }
  },

  onCanvasTouchEnd() {
    this.panLast = null
    this.pinchDistance = 0
    this.pinchMid = null
    this.pinchAngle = null
    this.gestureMode = null
  },

  toggleFollow() {
    if (!this.scene) return
    const followMode = !this.data.followMode
    if (followMode) this.scene.enableFollow()
    else this.scene.setFollowMode(false)
    this.setData({
      followMode,
      followIcon: followMode ? '+' : '#',
      followLabel: followMode ? '跟车' : '全场'
    })
  },

  toggleFlatMode() {
    if (!this.scene) return
    const flatMode = !this.data.flatMode
    this.scene.setFlatMode(flatMode)
    this.setData({
      flatMode,
      flatLabel: flatMode ? '3D' : '2D'
    })
  },

  zoomIn() {
    if (!this.scene) return
    this.scene.zoom(1.35)
    this.setData({ followMode: false, followIcon: '#', followLabel: '全场' })
  },

  zoomOut() {
    if (!this.scene) return
    this.scene.zoom(1 / 1.35)
    this.setData({ followMode: false, followIcon: '#', followLabel: '全场' })
  },

  resetView() {
    if (!this.scene) return
    this.scene.enableFollow()
    this.setData({
      followMode: true,
      followIcon: '+',
      followLabel: '跟车',
      flatMode: false,
      flatLabel: '2D'
    })
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
  },

  openCollab() {
    const sid = this.jobSessionId || this.sessionId
    if (!sid) {
      wx.showToast({ title: '协同群尚未建立', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/collab-group/index?sessionId=${sid}` })
  },

  callDispatch() {
    wx.showModal({
      title: '联系调度',
      content: '可打开现场协同群联系调度，由调度改派备用安全操作区。',
      confirmText: '打开协同群',
      success: result => {
        if (result.confirm) this.openCollab()
      }
    })
  },

  async confirmInspect() {
    if (!this.sessionId || this.data.confirming) return
    this.setData({ confirming: true })
    try {
      await request({
        url: `/navigation/mobile/sessions/${this.sessionId}/inspect`,
        method: 'POST'
      })
      wx.showLoading({ title: '规划出场' })
      const session = await specialNav.startSpecialNav({
        purpose: 'exit',
        parentSessionId: this.jobSessionId || (this.session && this.session.jobSessionId),
        task: this.session
      })
      wx.hideLoading()
      wx.redirectTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
    } catch (error) {
      wx.hideLoading()
      wx.showToast({ title: error.message || '验箱确认失败', icon: 'none' })
    } finally {
      this.setData({ confirming: false })
    }
  }
})
