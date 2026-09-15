const config = require('../../config')
const request = require('../../utils/request')
const auth = require('../../utils/auth')
const locationUtil = require('../../utils/location')
const yardScene = require('../../utils/yardScene')
const voice = require('../../utils/voice')
const routeInstruction = require('../../utils/routeInstruction')
const headingSensor = require('../../utils/heading')

/**
 * 从转向文案里挑一个箭头，和高保真 02 屏的提示条一致。
 */
function displayAreaText(text) {
  return routeInstruction.displayAreaName(text)
}

function remainingAlongRoute(self, points, blocks) {
  return routeInstruction.remainingAlongRoute(self, points, blocks)
}

function pickLocalInstruction(page, targetName, fallback) {
  const painted = page.scene && page.scene.getPaintedRoute && page.scene.getPaintedRoute()
  const selfWorld = page.scene && page.scene.getSelfWorld && page.scene.getSelfWorld()
  const fromPainted = painted
    ? routeInstruction.describeWorldInstruction(selfWorld, painted, targetName)
    : ''
  if (fromPainted) return displayAreaText(fromPainted)
  const blocks = page.yardMapData && page.yardMapData.blocks
  const local = routeInstruction.describeNextInstruction(page.self, page.routePoints, targetName, blocks)
  return displayAreaText(local || fallback || '沿推荐路线行驶')
}

function pickRemainingMeters(page, session, route) {
  const blocks = page.yardMapData && page.yardMapData.blocks
  const along = remainingAlongRoute(page.self, page.routePoints, blocks)
  const planned = Number((route && route.distanceMeters)
    || (session && session.route && session.route.distanceMeters))
  const painted = page.scene && page.scene.getPaintedRoute && page.scene.getPaintedRoute()
  const paintedRemain = routeInstruction.remainingAlongWorld(painted)
  const fromSession = Number(session && session.remainingDistanceMeters)
  const p0 = page.routePoints && page.routePoints[0]
  const gapToRoute = page.self && p0 && page.self.x != null && p0.x != null
    ? Math.hypot(page.self.x - p0.x, page.self.y - p0.y)
    : 0
  const toTarget = page.self && page.targetPoint
    ? Math.hypot(page.self.x - page.targetPoint.x, page.self.y - page.targetPoint.y)
    : 0
  if (gapToRoute > 25 && toTarget > 25) {
    return Math.max(along, toTarget, 1)
  }
  // 路外飞线会把 along/planned 撑到数千米，优先用裁掉飞线后的画线长度
  if (paintedRemain > 8 && (along > paintedRemain * 2.5 || planned > paintedRemain * 2.5)) {
    return paintedRemain
  }
  if (planned > 500 && along > 150 && along < planned * 1.8) return along
  if (paintedRemain > 150 && (along <= 0.5 || paintedRemain >= along * 0.25)) return paintedRemain
  if (along > 150 && !(planned > along * 2.5)) return along
  if (fromSession > 150 && fromSession < 800) return fromSession
  if (paintedRemain > 0.5) return paintedRemain
  if (along > 0.5 && !(planned > along * 2.5)) return along
  if (planned > 0.5 && planned < 800) return planned
  if (fromSession >= 0 && fromSession < 800) return fromSession
  return 0
}

function estimateMinutes(meters) {
  const seconds = Math.max(0, Number(meters) || 0) / 2.78
  if (seconds < 90) return 1
  return Math.max(1, Math.round(seconds / 60))
}

function headingAgainstOneWay(self, road) {
  if (!self || !road || !road.path || road.path.length < 2) return false
  const dir = Number(road.directionType)
  if (dir !== 1 && dir !== 2) return false
  const a = road.path[0]
  const b = road.path[road.path.length - 1]
  // 场图 Y 南增，北向分量取反后才能和罗盘航向（0 正北）对齐
  let allowed = Math.atan2(b.x - a.x, a.y - b.y) * 180 / Math.PI
  if (dir === 2) allowed += 180
  const heading = self.heading == null ? null : Number(self.heading)
  if (heading == null || Number.isNaN(heading)) return false
  const diff = Math.abs(((heading - allowed + 540) % 360) - 180)
  return diff > 100
}

function compassRotateOf(status) {
  return status && typeof status.bearingDeg === 'number' ? status.bearingDeg : 0
}

function snapSelfToRoad(page, self) {
  const roads = page.yardMapData && page.yardMapData.roads
  if (!roads || !roads.length || !self || self.x == null || self.y == null) {
    return { self, snap: null }
  }
  const snap = yardScene.snapPositionToRoad(roads, self.x, self.y)
  if (!snap.snapped) return { self, snap }
  return {
    self: { ...self, x: snap.x, y: snap.y },
    snap
  }
}

function maybeForceRerouteIfRoadMismatch(page) {
  const roads = page.yardMapData && page.yardMapData.roads
  const p0 = page.routePoints && page.routePoints[0]
  if (!roads || !page.self || !p0) return
  const selfSnap = yardScene.snapPositionToRoad(roads, page.self.x, page.self.y)
  const routeSnap = yardScene.snapPositionToRoad(roads, p0.x, p0.y)
  const selfKey = selfSnap.road && (selfSnap.road.edgeCode || selfSnap.road.name)
  const routeKey = routeSnap.road && (routeSnap.road.edgeCode || routeSnap.road.name)
  if (selfKey && routeKey && selfKey !== routeKey) {
    page._forceRerouteOnce = true
    console.log('[nav-plan] roadMismatch', JSON.stringify({ selfRoad: selfKey, routeP0Road: routeKey }))
  }
}

function instructionArrow(text) {
  if (!text) return '↑'
  if (/直行[\d.]+米后右转|前方.*右转/.test(text)) return '↱'
  if (/直行[\d.]+米后左转|前方.*左转/.test(text)) return '↰'
  if (text.includes('右转')) return '↱'
  if (text.includes('左转')) return '↰'
  if (text.includes('掉头')) return '↷'
  if (text.includes('到达') || text.includes('抵达')) return '◉'
  if (text.includes('继续') || text.includes('沿推荐') || text.includes('直行')) return '↑'
  return '↑'
}

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

Page({
  data: {
    session: {},
    instruction: '正在准备路线',
    instructionIcon: '↑',
    remainingDistance: '--',
    estimatedMinutes: '--',
    locationQuality: '等待定位',
    locationQualityClass: '',
    arrivalSuggestion: false,
    voiceOn: true,
    followMode: true,
    speedLimit: '',
    oneWayHint: '',
    offYardHint: '',
    mapError: '',
    mapLoading: true,
    viewAdjusted: false,
    locating: false,
    statusBarHeight: 20,
    flatMode: true,
    compassRotate: 0
  },

  onLoad(options) {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20 })
    this.sessionId = options.sessionId
    this.lastReportTime = 0
    this.yardMapData = null
    this.routePoints = []
    this.routeLaneOffset = false
    this.targetPoint = null
    // self 是场区米制坐标（后端 selfPoint），gps 是原始定位，只用于上报
    this.self = null
    this.gps = null
    this.scene = null
    this.locationListener = location => this.handleLocation(location)
    this.compassHeading = null
    this.offHeading = headingSensor.onChange((deg, from) => this.handleCompass({ direction: deg, from }))
    this.ended = false
    this._spokenSessionId = null
    this._spokenDestKey = null
    voice.resetPhase()
    this.initScene().then(() => this.loadSession())
  },

  onShow() {
    headingSensor.start()
  },

  onReady() {
    headingSensor.start()
  },

  onUnload() {
    this.ended = true
    this.stopLocationUpdates()
    if (this.offHeading) this.offHeading()
    headingSensor.stop()
    voice.resetPhase()
    if (this.scene) {
      this.scene.dispose()
      this.scene = null
    }
  },

  /**
   * 用 WebGL + Three.js 建真三维场景，不再走 canvas 2d。
   */
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
          const canvas = item.node
          const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
          const dpr = Math.min((windowInfo && windowInfo.pixelRatio) || 2, 2.5)
          this.canvas = canvas
          this.canvasWidth = item.width
          this.canvasHeight = item.height
          try {
            this.scene = yardScene.createYardScene(canvas, item.width, item.height, dpr)
            if (this.scene.setFlatMode) {
              this.scene.setFlatMode(true)
              this.setData({ flatMode: true })
            }
          } catch (error) {
            this.setData({ mapError: '三维引擎初始化失败：' + (error.message || error) })
          }
          resolve()
        })
    })
  },

  /**
   * 把当前会话数据同步进三维场景，并刷新场外提示。
   * 注意：不要每次都 setFollowMode/setMap，否则会冲掉用户手势视角、反复重建网格。
   */
  syncScene(options) {
    if (!this.scene) return
    const opts = options || {}
    if (opts.rebuildMap && this.yardMapData) {
      this.scene.setMap(this.yardMapData)
    }
    this.scene.setTarget(
      this.targetPoint,
      this.data.session.targetName,
      this.data.session.targetBlockId,
      this.data.session.targetSlot
    )
    if (opts.route !== false) {
      this.scene.setRoute(this.routePoints, { laneOffsetApplied: this.routeLaneOffset })
    }
    if (this.scene.setPurpose) {
      this.scene.setPurpose(this.data.session.purpose || 'job')
    }
    if (this.self) this.scene.setSelf(this.self)
    const status = this.scene.getStatus()
    const off = status.offYardMeters
    const offYardHint = off === null || off <= 80
      ? ''
      : `当前定位在场外约 ${off >= 1000 ? (off / 1000).toFixed(1) + ' km' : Math.round(off) + ' m'}`
    const patch = {}
    if (offYardHint !== this.data.offYardHint) patch.offYardHint = offYardHint
    if (status.viewAdjusted !== this.data.viewAdjusted) patch.viewAdjusted = status.viewAdjusted
    if (this.data.followMode && status.viewAdjusted) patch.followMode = false
    if (typeof status.flatMode === 'boolean' && status.flatMode !== this.data.flatMode) {
      patch.flatMode = status.flatMode
    }
    if (typeof status.bearingDeg === 'number') {
      const compassRotate = compassRotateOf(status)
      if (compassRotate !== this.data.compassRotate) patch.compassRotate = compassRotate
    }
    if (typeof status.mapBuilding === 'boolean' && status.mapBuilding !== this.data.mapLoading) {
      patch.mapLoading = status.mapBuilding
    }
    if (Object.keys(patch).length) this.setData(patch)
  },

  async loadSession() {
    try {
      const session = await request({ url: `/navigation/mobile/sessions/${this.sessionId}` })
      this.applySession(session)
      await this.loadYardMap(session.cyId)
      await this.primeLocation()
      this._forceRerouteOnce = true
      this.startLocationUpdates()
      if (this.gps) {
        this.lastReportTime = 0
        await this.handleLocation(this.gps)
      }
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  async syncExitGateAnchor(yardId) {
    if (!this.scene || !this.scene.setExitGateAnchor || !yardId) return
    try {
      const exit = await request({ url: `/navigation/mobile/exit-target?yardId=${yardId}` })
      if (exit && exit.entryX != null && exit.entryY != null) {
        console.log('[nav-gate]', JSON.stringify({
          entry: [exit.entryX, exit.entryY],
          code: exit.targetCode || '',
          name: exit.targetName || ''
        }))
        this.scene.setExitGateAnchor({ x: exit.entryX, y: exit.entryY })
      }
    } catch (error) {
      // 未配置出场口时不画固定道口
    }
  },

  async loadYardMap(cyId) {
    const user = auth.getUser() || {}
    const yardId = cyId || user.currentCyId
    if (!yardId) {
      this.setData({ mapError: '未知堆场，无法加载场内地图' })
      return
    }
    try {
      this.yardMapData = await request({ url: `/navigation/mobile/yards/${yardId}/map` })
      await this.syncExitGateAnchor(yardId)
      this.setData({ mapError: '', mapLoading: true })
      this.syncScene({ rebuildMap: true })
      setTimeout(() => {
        if (this.scene && this.data.mapLoading) {
          this.setData({ mapLoading: false })
        }
      }, 8000)
    } catch (error) {
      this.setData({ mapError: error.message })
    }
  },

  applySession(session) {
    const route = session.route
    const points = route && route.polyline ? route.polyline : this.routePoints
    const target = (route && route.target) || this.targetPoint || points[points.length - 1]
    this.routePoints = points || []
    if (route) this.routeLaneOffset = Boolean(route.laneOffsetApplied)
    this.targetPoint = target && target.x != null && target.y != null
      ? { x: Number(target.x), y: Number(target.y) }
      : null
    if (session.selfPoint) this.applySelfPoint(session.selfPoint)
    maybeForceRerouteIfRoadMismatch(this)
    const roads = this.yardMapData && this.yardMapData.roads
    const p0 = points && points[0]
    const p1 = points && points[1]
    let snapSelf = null
    if (roads && this.self) {
      snapSelf = yardScene.snapPositionToRoad(roads, this.self.x, this.self.y)
    }
    console.log('[nav-route]', JSON.stringify({
      polyLen: points ? points.length : 0,
      p0: p0 ? [p0.x, p0.y] : null,
      p1: p1 ? [p1.x, p1.y] : null,
      target: this.targetPoint ? [this.targetPoint.x, this.targetPoint.y] : null,
      distM: route && route.distanceMeters,
      laneOffsetApplied: Boolean(this.routeLaneOffset),
      selfRoad: snapSelf && snapSelf.road ? snapSelf.road : null,
      selfSnapM: snapSelf && snapSelf.distM != null ? Math.round(snapSelf.distM * 10) / 10 : null
    }))

    const sessionId = session.id || this.sessionId
    const targetName = displayAreaText(session.targetName || '')
    const prev = this.data.session || {}
    const nextSession = {
      ...prev,
      ...session,
      id: sessionId,
      targetName: targetName || (session.purpose && session.purpose !== prev.purpose ? '' : prev.targetName),
      purpose: session.purpose || prev.purpose
    }
    this.setData({ session: nextSession })
    this.syncScene()
    const instruction = pickLocalInstruction(
      this,
      targetName,
      session.nextInstruction
        || (route && route.instructions && route.instructions[0])
        || '沿推荐路线行驶'
    )
    const destKey = `${sessionId}|${session.purpose || ''}|${targetName}`
    if (this._spokenDestKey !== destKey) {
      voice.resetPhase()
      this._spokenDestKey = destKey
      this._spokenSessionId = sessionId
      this.speak(targetName ? `前往${targetName}，${instruction}` : instruction)
    } else {
      this.speak(instruction)
    }

    const arrivalSuggestion = Boolean(session.arrivalSuggestion)
    const remainM = pickRemainingMeters(this, session, route)
    this.setData({
      session: nextSession,
      instruction,
      instructionIcon: instructionArrow(instruction),
      remainingDistance: Math.round(remainM),
      estimatedMinutes: estimateMinutes(remainM),
      arrivalSuggestion
    })
    // 首次判定到达：进入到位确认页（对齐 03）
    if (arrivalSuggestion && !this._arrivedRedirected) {
      this._arrivedRedirected = true
      const purpose = session.purpose || 'job'
      setTimeout(() => {
        if (purpose === 'safety') {
          wx.redirectTo({
            url: `/pages/safety-zone/index?sessionId=${this.sessionId}`
          })
          return
        }
        wx.redirectTo({
          url: `/pages/arrive-confirm/index?sessionId=${this.sessionId}&targetName=${encodeURIComponent(displayAreaText(session.targetName || ''))}`
        })
      }, 600)
    }
  },

  applyLocationTick(response) {
    const targetName = (this.data.session && this.data.session.targetName) || ''
    this.syncScene()
    const instruction = pickLocalInstruction(
      this,
      targetName,
      response.nextInstruction || this.data.instruction
    )
    this.speak(instruction)
    const remainM = pickRemainingMeters(this, this.data.session, null)
    const patch = {
      instruction,
      instructionIcon: instructionArrow(instruction),
      arrivalSuggestion: Boolean(response.arrivalSuggestion)
    }
    if (remainM > 0.5) {
      patch.remainingDistance = Math.round(remainM)
      patch.estimatedMinutes = estimateMinutes(remainM)
    }
    this.setData(patch)
    if (patch.arrivalSuggestion && !this._arrivedRedirected) {
      this.applySession({
        ...(this.data.session || {}),
        nextInstruction: instruction,
        arrivalSuggestion: true
      })
    }
  },

  speak(text) {
    voice.speak(text, this.data.voiceOn)
  },

  toggleVoice() {
    const voiceOn = !this.data.voiceOn
    this.setData({ voiceOn })
    if (!voiceOn) {
      voice.stop()
      return
    }
    // 重新打开时允许再播当前阶段一次
    voice.resetPhase()
    this.speak(this.data.instruction)
  },

  toggleFollow() {
    if (!this.scene) return
    const followMode = !this.data.followMode
    if (followMode) {
      // 主动跟车才清掉手动视角；拖动手势退出跟车后不会被 sync 拽回去
      this.scene.enableFollow()
    } else {
      this.scene.setFollowMode(false)
    }
    this.setData({ followMode, viewAdjusted: followMode ? false : this.data.viewAdjusted })
    this.syncScene()
  },

  calibrateHeading() {
    if (headingSensor.startFromTap) headingSensor.startFromTap()
    else headingSensor.start({ force: true, fromTap: true })
    if (headingSensor.calibrate) headingSensor.calibrate()
  },

  onCanvasTouchStart(event) {
    if (!this._headingTapped) {
      this._headingTapped = true
      this.calibrateHeading()
    }
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

      // 高德：捏合缩放 / 双指拧旋转 / 双指同向上下滑俯仰
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

      const markAdjusted = () => {
        const status = this.scene.getStatus()
        this.setData({
          viewAdjusted: true,
          followMode: false,
          flatMode: status.flatMode,
          compassRotate: compassRotateOf(status)
        })
      }

      if (this.gestureMode === 'zoom') {
        const factor = distance / this.pinchDistance
        if (isFinite(factor) && Math.abs(factor - 1) >= 0.008) {
          this.scene.zoom(factor)
          markAdjusted()
        }
      } else if (this.gestureMode === 'tilt') {
        if (Math.abs(dMidY) >= 1) {
          this.scene.tilt(dMidY)
          markAdjusted()
        }
      } else if (this.gestureMode === 'rotate') {
        if (Math.abs(dAngle) >= 0.004) {
          this.scene.rotate(dAngle)
          markAdjusted()
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
      if (this.data.followMode || !this.data.viewAdjusted) {
        this.setData({ viewAdjusted: true, followMode: false })
      }
    }
  },

  onCanvasTouchEnd() {
    this.panLast = null
    this.pinchDistance = 0
    this.pinchMid = null
    this.pinchAngle = null
    this.gestureMode = null
  },

  zoomIn() {
    if (!this.scene) return
    this.scene.zoom(1.35)
    this.setData({ viewAdjusted: true, followMode: false })
  },

  zoomOut() {
    if (!this.scene) return
    this.scene.zoom(1 / 1.35)
    this.setData({ viewAdjusted: true, followMode: false })
  },

  toggleFlatMode() {
    if (!this.scene) return
    const flatMode = !this.data.flatMode
    this.scene.setFlatMode(flatMode)
    this.setData({ flatMode })
  },

  resetView() {
    if (!this.scene) return
    this.scene.enableFollow()
    this.setData({ viewAdjusted: false, followMode: true, flatMode: false, compassRotate: 0 })
    this.syncScene()
  },

  async locateSelf() {
    if (this.locating) return
    this.locating = true
    this.setData({ locating: true })
    try {
      const location = await locationUtil.getCurrentLocation()
      this.applySelf(location)
    } catch (error) {
      if (!this.gps) {
        wx.showToast({ title: error.message, icon: 'none' })
        return
      }
    } finally {
      this.locating = false
      this.setData({ locating: false })
    }
    if (!this.self || !this.scene) return
    this.scene.locateSelf()
    this.setData({ viewAdjusted: true })
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
  },

  async primeLocation() {
    try {
      const location = await locationUtil.getCurrentLocation()
      this.applySelf(location)
    } catch (error) {
      this.setData({ locationQuality: '获取失败', locationQualityClass: 'quality-weak' })
    }
  },

  /**
   * 刷新航向与定位质量。定位点本身不在这里换算——场区坐标只认后端
   * 按三点定标算出来的 selfPoint，见 applySelfPoint。
   */
  applySelf(location) {
    const gpsHeading = location.direction > 0 ? location.direction : null
    const sensorHeading = headingSensor.get()
    if (sensorHeading != null) this.compassHeading = sensorHeading
    if (sensorHeading == null && gpsHeading != null && headingSensor.seed) headingSensor.seed(gpsHeading)
    const headingFrom = this.compassHeading != null ? 'compass' : 'gps'
    const heading = headingFrom === 'compass'
      ? this.compassHeading
      : (gpsHeading != null ? gpsHeading : (this.self && this.self.heading != null ? this.self.heading : 0))
    this.gps = {
      longitude: location.longitude,
      latitude: location.latitude,
      accuracy: location.accuracy,
      speed: location.speed,
      direction: location.direction
    }
    if (this.self) {
      this.self = {
        ...this.self,
        heading,
        headingFrom,
        accuracy: location.accuracy,
        speed: location.speed
      }
      this.syncScene()
    }
    this.refreshLocationUi(location)
  },

  /**
   * @param {{x:number, y:number}} point 后端已吸附到行驶方向右车道的场区米制坐标
   *
   * 这里不再本地贴路：后端按路线前进方向靠右，再吸一次会把偏移拉回路中间。
   */
  applySelfPoint(point) {
    if (!point || point.x == null || point.y == null) return
    const next = {
      ...(this.self || {}),
      x: Number(point.x),
      y: Number(point.y)
    }
    // 弱定位下的小幅跳点不挪车，减轻「一直在抖」
    if (this.self && this.self.x != null) {
      const dist = Math.hypot(next.x - this.self.x, next.y - this.self.y)
      const accuracy = next.accuracy || 50
      if (dist < 1.2 || (accuracy > 35 && dist < 6)) {
        next.x = this.self.x
        next.y = this.self.y
      }
    }
    this.self = next
    this.syncScene()
  },

  refreshLocationUi(location) {
    const road = yardScene.nearestRoad(this.yardMapData && this.yardMapData.roads, this.self)
    const against = headingAgainstOneWay(this.self, road)
    const remainM = pickRemainingMeters(this, this.data.session, null)
    const accuracy = (location && location.accuracy) || 99
    const patch = {
      locationQuality: accuracy <= 30 ? '正常' : '较弱',
      locationQualityClass: accuracy <= 30 ? 'quality-good' : 'quality-weak',
      speedLimit: road && road.speedLimitKmh ? String(Math.round(road.speedLimitKmh)) : '',
      oneWayHint: against
        ? `${road.edgeName || '当前路段'}逆行`
        : (road && (road.directionType === 1 || road.directionType === 2)
          ? `${road.edgeName || '当前路段'}单向`
          : '')
    }
    if (remainM > 0.5) {
      const meters = Math.round(remainM)
      const minutes = estimateMinutes(remainM)
      if (meters !== this.data.remainingDistance) patch.remainingDistance = meters
      if (minutes !== this.data.estimatedMinutes) patch.estimatedMinutes = minutes
    }
    const targetName = (this.data.session && this.data.session.targetName) || ''
    const instruction = pickLocalInstruction(this, targetName, this.data.instruction)
    if (instruction && instruction !== this.data.instruction) {
      patch.instruction = instruction
      patch.instructionIcon = instructionArrow(instruction)
      this.speak(instruction)
    }
    this.setData(patch)
  },

  startLocationUpdates() {
    locationUtil.startLocationUpdate()
      .then(() => {
        this.locationWatcher = locationUtil.watchLocation(this.locationListener)
      })
      .catch(() => wx.showModal({
        title: '需要定位权限',
        content: '导航期间需要持续获取当前位置，请允许定位权限。',
        success: result => result.confirm && wx.openSetting()
      }))
  },

  stopLocationUpdates() {
    locationUtil.unwatchLocation(this.locationListener, this.locationWatcher)
    this.locationWatcher = null
  },

  handleCompass(res) {
    if (!res || res.direction == null) return
    this.compassHeading = res.direction
    if (this.self) {
      this.self.heading = res.direction
      this.self.headingFrom = res.from || 'sensor'
    }
    if (this.scene && this.scene.setHeading) this.scene.setHeading(res.direction)
    const now = Date.now()
    if (this._lastCompassUi && now - this._lastCompassUi < 400) return
    this._lastCompassUi = now
    const status = this.scene && this.scene.getStatus ? this.scene.getStatus() : null
    const compassRotate = compassRotateOf(status)
    if (compassRotate !== this.data.compassRotate) this.setData({ compassRotate })
  },

  async handleLocation(location) {
    if (this.ended) return
    const now = Date.now()
    this.applySelf(location)

    if (now - this.lastReportTime < config.locationReportIntervalMs || this.reporting) {
      return
    }
    this.lastReportTime = now
    this.reporting = true
    try {
      if (this.ended) return
      const forceReroute = Boolean(this._forceRerouteOnce)
      this._forceRerouteOnce = false
      // 上报的是原始 GPS：换算成场区坐标是后端三点定标的事，客户端只补一条
      // 「我贴在哪条路上」，让规划起点和画面里的车保持同一段路。
      const roads = this.yardMapData && this.yardMapData.roads
      const onRoad = roads && roads.length && this.self
        ? yardScene.snapPositionToRoad(roads, this.self.x, this.self.y)
        : null
      maybeForceRerouteIfRoadMismatch(this)
      const rp0 = (this.routePoints || [])[0]
      const distToP0 = rp0 && this.self
        ? Math.hypot(rp0.x - this.self.x, rp0.y - this.self.y)
        : null
      console.log('[nav-plan]', JSON.stringify({
        gps: [location.longitude, location.latitude, location.accuracy],
        selfYard: this.self ? [this.self.x, this.self.y] : null,
        snap: onRoad ? {
          snapped: onRoad.snapped,
          distM: onRoad.distM != null ? Math.round(onRoad.distM * 10) / 10 : null,
          road: onRoad.road || null,
          sentEdge: (onRoad.road && (onRoad.road.edgeCode || onRoad.road.name)) || ''
        } : null,
        routeP0Yard: rp0 ? [rp0.x, rp0.y] : null,
        distToRouteP0M: distToP0 != null ? Math.round(distToP0) : null,
        forceReroute
      }))
      const response = await request({
        url: `/navigation/mobile/sessions/${this.sessionId}/locations`,
        method: 'POST',
        data: locationUtil.toReport(location, this.self && this.self.heading, {
          forceReroute,
          snapEdgeCode: onRoad && onRoad.road && onRoad.road.edgeCode,
          snapEdgeName: onRoad && onRoad.road && onRoad.road.name
        })
      })
      if (this.ended) return
      if (response.selfPoint) this.applySelfPoint(response.selfPoint)
      if (response.route) {
        this.applySession(response)
      } else {
        this.applyLocationTick(response)
      }
    } catch (error) {
      if (this.ended || /已结束/.test(error.message || '')) return
      wx.showToast({ title: error.message, icon: 'none' })
    } finally {
      this.reporting = false
    }
  },

  confirmArrival() {
    const purpose = (this.data.session && this.data.session.purpose) || 'job'
    if (purpose === 'safety') {
      wx.redirectTo({ url: `/pages/safety-zone/index?sessionId=${this.sessionId}` })
      return
    }
    wx.redirectTo({
      url: `/pages/arrive-confirm/index?sessionId=${this.sessionId}&targetName=${encodeURIComponent(this.data.session.targetName || '')}`
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
              longitude: this.gps ? this.gps.longitude : undefined,
              latitude: this.gps ? this.gps.latitude : undefined
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
        this.ended = true
        this.stopLocationUpdates()
        voice.resetPhase()
        try {
          await request({ url: `/navigation/mobile/sessions/${this.sessionId}/cancel`, method: 'POST' })
          wx.switchTab({ url: '/pages/home/index' })
        } catch (error) {
          if (/已结束/.test(error.message || '')) {
            wx.switchTab({ url: '/pages/home/index' })
            return
          }
          this.ended = false
          wx.showToast({ title: error.message, icon: 'none' })
        }
      }
    })
  }
})
