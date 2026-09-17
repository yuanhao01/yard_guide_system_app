/**
 * 场内导航：跟车画蓝线、报下一句、上报位置、到了跳到位确认。
 * 依赖：config、request、auth、location、yardScene、voice、routeInstruction、heading。
 */
const config = require('../../config')
const request = require('../../utils/request')
const auth = require('../../utils/auth')
const locationUtil = require('../../utils/location')
const yardScene = require('../../utils/yardScene')
const voice = require('../../utils/voice')
const routeInstruction = require('../../utils/routeInstruction')
const headingSensor = require('../../utils/heading')
const yardSocket = require('../../utils/yardSocket')

/**
 * 从转向文案里挑一个箭头，和高保真 02 屏的提示条一致。
 */
function displayAreaText(text) {
  return routeInstruction.displayAreaName(text) // 场区名改成「区」
}

/** 沿场图蓝线还剩多少米 */
function remainingAlongRoute(self, points, blocks) {
  return routeInstruction.remainingAlongRoute(self, points, blocks)
}

/** 优先用场图上已画蓝线报下一句，没有再按规划折线 */
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

/** 挑一个给司机看的剩余米数：车还在另一条路时不能用短折线报「即将到达」 */
function pickRemainingMeters(page, session, route) {
  const blocks = page.yardMapData && page.yardMapData.blocks
  const along = remainingAlongRoute(page.self, page.routePoints, blocks) // 沿折线剩余
  const planned = Number((route && route.distanceMeters)
    || (session && session.route && session.route.distanceMeters)) // 规划全长
  const painted = page.scene && page.scene.getPaintedRoute && page.scene.getPaintedRoute()
  const paintedRemain = routeInstruction.remainingAlongWorld(painted) // 已画蓝线剩余
  const fromSession = Number(session && session.remainingDistanceMeters) // 后台给的剩余
  const p0 = page.routePoints && page.routePoints[0]
  const gapToRoute = page.self && p0 && page.self.x != null && p0.x != null
    ? Math.hypot(page.self.x - p0.x, page.self.y - p0.y)
    : 0 // 车离规划起点多远
  const toTarget = page.self && page.targetPoint
    ? Math.hypot(page.self.x - page.targetPoint.x, page.self.y - page.targetPoint.y)
    : 0 // 车离目的地直线距离
  // 车还在另一条路上、折线只剩终点 4 米时，不能用这段短线报剩余/即将到达
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

/** 按剩余米数估几分钟（场内大约按 10 公里/小时） */
function estimateMinutes(meters) {
  const seconds = Math.max(0, Number(meters) || 0) / 2.78
  if (seconds < 90) return 1
  return Math.max(1, Math.round(seconds / 60))
}

/** 车头是不是和这条单行道规定方向相反 */
function headingAgainstOneWay(self, road) {
  if (!self || !road || !road.path || road.path.length < 2) return false
  const dir = Number(road.directionType) // 1、2 才是单行
  if (dir !== 1 && dir !== 2) return false
  const a = road.path[0]
  const b = road.path[road.path.length - 1]
  // 场图 Y 南增，北向分量取反后才能和罗盘航向（0 正北）对齐
  let allowed = Math.atan2(b.x - a.x, a.y - b.y) * 180 / Math.PI
  if (dir === 2) allowed += 180 // 反向单行
  const heading = self.heading == null ? null : Number(self.heading)
  if (heading == null || Number.isNaN(heading)) return false
  const diff = Math.abs(((heading - allowed + 540) % 360) - 180)
  return diff > 100 // 差超过 100 度当逆行
}

/** 指南针圆盘要转多少度，让「北」对着场图北方 */
function compassRotateOf(status) {
  return status && typeof status.bearingDeg === 'number' ? status.bearingDeg : 0
}

/** 把车吸到最近车道上（本页上报时用来对照路，不再本地改坐标） */
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

/** 车已经开到另一条路，记下要强制后台重算路线 */
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

/** 从转向文案里挑提示条左边的箭头 */
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

/** 两指距离，捏合缩放用 */
function touchDistance(touches) {
  return Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y)
}

/** 两指中点 */
function touchMidpoint(touches) {
  return {
    x: (touches[0].x + touches[1].x) / 2,
    y: (touches[0].y + touches[1].y) / 2
  }
}

/** 两指连线角度 */
function touchAngle(touches) {
  return Math.atan2(touches[1].y - touches[0].y, touches[1].x - touches[0].x)
}

/** 转角收到正负半圈 */
function normalizeAngleDelta(delta) {
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

Page({
  data: {
    session: {}, // 这一趟导航
    instruction: '正在准备路线', // 下一句提示
    instructionIcon: '↑', // 提示条箭头
    remainingDistance: '--', // 剩余米数
    estimatedMinutes: '--', // 预计分钟
    locationQuality: '等待定位', // 定位好不好
    locationQualityClass: '', // 绿点/橙点
    arrivalSuggestion: false, // 后台认为到了
    voiceOn: true, // 语音开着
    followMode: true, // 镜头跟车
    speedLimit: '', // 当前路限速
    overspeed: false, // 当前车速是否超过所在路限速
    oneWayHint: '', // 单行/逆行提示
    offYardHint: '', // 车在场外多远
    mapError: '', // 场图失败原因
    mapLoading: true, // 场图加载中
    viewAdjusted: false, // 司机是否手势挪过镜头
    locating: false, // 正在点「定位自己」
    statusBarHeight: 20,
    flatMode: true, // 默认俯视
    compassRotate: 0 // 指南针圆盘转角
  },

  /** 进页：建场图、订指南针、拉会话并开始跟车 */
  onLoad(options) {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20 })
    this.sessionId = options.sessionId // 这一趟编号
    this.lastReportTime = 0 // 上次上报时间
    this.yardMapData = null // 堆场道路、箱区
    this.routePoints = [] // 规划折线
    this.routeLaneOffset = false // 路线是否已按车道偏过
    this.targetPoint = null // 目的地场图坐标
    // self 是场区米制坐标（后端 selfPoint），gps 是原始定位，只用于上报
    this.self = null
    this.gps = null
    this.scene = null
    this.locationListener = location => this.handleLocation(location)
    this.compassHeading = null // 指南针朝向
    this.offHeading = headingSensor.onChange((deg, from) => this.handleCompass({ direction: deg, from }))
    this.ended = false // 结束后不再上报
    this._spokenSessionId = null // 已经播过目的地的会话
    this._spokenDestKey = null // 目的地+用途变了才重播「前往某某」
    this.liveForklifts = {} // forkliftId -> 场区点
    this._spokenSpeedRoad = null // 已经播过限速的路+限速
    this.yardWs = null
    this.truckDragEnabled = false // 只认数据字典 nav_truck_drag，页面上不出现开关
    voice.resetPhase()
    this.initScene().then(() => this.loadSession())
  },

  onShow() {
    headingSensor.start()
  },

  onReady() {
    headingSensor.start()
  },

  /** 离开页：停定位、停语音、拆场图 */
  onUnload() {
    this.ended = true
    this.stopLocationUpdates()
    if (this.offHeading) this.offHeading()
    headingSensor.stop()
    voice.resetPhase()
    this.closeYardSocket()
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
              this.scene.setFlatMode(true) // 进页先俯视，好认路
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
      this.scene.setMap(this.yardMapData) // 只在拉到新场图时重建
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
    const off = status.offYardMeters // 车在场外多少米
    const offYardHint = off === null || off <= 80
      ? ''
      : `当前定位在场外约 ${off >= 1000 ? (off / 1000).toFixed(1) + ' km' : Math.round(off) + ' m'}`
    const patch = {}
    if (offYardHint !== this.data.offYardHint) patch.offYardHint = offYardHint
    if (status.viewAdjusted !== this.data.viewAdjusted) patch.viewAdjusted = status.viewAdjusted
    if (this.data.followMode && status.viewAdjusted) patch.followMode = false // 手势挪过就退出跟车
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

  /** 拉会话、场图，取一次定位后开始持续上报 */
  async loadSession() {
    try {
      const session = await request({ url: `/navigation/mobile/sessions/${this.sessionId}` })
      this.applySession(session)
      await this.loadYardMap(session.cyId)
      await this.primeLocation()
      this._forceRerouteOnce = true // 第一次上报要求按最新位置重算
      this.startLocationUpdates()
      this.loadFeatures()
      this.startYardLocations(session.cyId)
      if (this.gps) {
        this.lastReportTime = 0
        await this.handleLocation(this.gps)
      }
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  /** 出场导航时把固定道口锚点告诉场图 */
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

  /** 拉这个堆场的道路和箱区画到场图上 */
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
          this.setData({ mapLoading: false }) // 8 秒还没建完也先揭开，避免一直转圈
        }
      }, 8000)
    } catch (error) {
      this.setData({ mapError: error.message })
    }
  },

  /** 后台返回新会话或新路线时，刷新蓝线、提示、语音，到了就跳确认页 */
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
      voice.resetPhase() // 换了目的地，允许再播「前往某某」
      this._spokenDestKey = destKey
      this._spokenSessionId = sessionId
      this.speakNav(targetName ? `前往${targetName}，${instruction}` : instruction)
    } else {
      this.speakNav(instruction)
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

  /** 这次上报没有新路线，只刷新提示和剩余 */
  applyLocationTick(response) {
    const targetName = (this.data.session && this.data.session.targetName) || ''
    this.syncScene()
    const instruction = pickLocalInstruction(
      this,
      targetName,
      response.nextInstruction || this.data.instruction
    )
    this.speakNav(instruction)
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

  currentRoad() {
    return yardScene.nearestRoad(this.yardMapData && this.yardMapData.roads, this.self)
  },

  /** 换路时补一句限速，和转向提示拼成一句，避免两句互相打断 */
  speakNav(instruction) {
    const road = this.currentRoad()
    const kmh = road && road.speedLimitKmh ? Math.round(Number(road.speedLimitKmh)) : 0
    const roadName = displayAreaText((road && (road.edgeName || road.roadName)) || '当前路段')
    const roadKey = (road && (road.edgeCode || road.edgeName || road.roadName)) || ''
    const speedKey = kmh > 0 ? `${roadKey}|${kmh}` : ''
    if (speedKey && this._spokenSpeedRoad !== speedKey) {
      this._spokenSpeedRoad = speedKey
      const limit = `进入${roadName}，该道路限速${kmh}公里每小时，注意减速慢行`
      this.speak(instruction ? `${instruction}。${limit}` : limit)
      return
    }
    if (instruction) this.speak(instruction)
  },

  /** 开关语音；重新打开时当前这句再播一次 */
  toggleVoice() {
    const voiceOn = !this.data.voiceOn
    this.setData({ voiceOn })
    if (!voiceOn) {
      voice.stop()
      return
    }
    // 重新打开时允许再播当前阶段一次
    voice.resetPhase()
    this._spokenSpeedRoad = null
    this.speakNav(this.data.instruction)
  },

  /** 切换跟车 / 全场 */
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

  /** 点「校准朝向」：要用户手势才能开传感器的机型在这里打开，并按指南针对齐 */
  calibrateHeading() {
    if (headingSensor.startFromTap) headingSensor.startFromTap()
    else headingSensor.start({ force: true, fromTap: true })
    if (headingSensor.calibrate) headingSensor.calibrate()
  },

  /** 只读数据字典，页面上不露出任何开关 */
  async loadFeatures() {
    try {
      const features = await request({ url: '/navigation/mobile/features' })
      this.truckDragEnabled = Boolean(features && features.truckDragEnabled)
    } catch (error) {
      this.truckDragEnabled = false
    }
  },

  /** 拉堆高机快照并听 WS 实时位置 */
  async startYardLocations(cyId) {
    const user = auth.getUser() || {}
    const yardId = cyId || user.currentCyId
    if (!yardId) return
    try {
      const rows = await request({ url: `/navigation/mobile/yards/${yardId}/forklifts` })
      ;(rows || []).forEach(item => this.applyLiveForklift(item, yardId))
      this.syncLiveForklifts()
    } catch (error) {
      console.warn('[nav-forklift] snapshot fail', error && error.message)
    }
    this.closeYardSocket()
    this.yardWs = yardSocket.createYardSocket({
      cyId: yardId,
      onGpsLocation: payload => this.applyLiveForklift(payload, yardId)
    })
    this.yardWs.open()
  },

  closeYardSocket() {
    if (this.yardWs) {
      this.yardWs.close()
      this.yardWs = null
    }
  },

  applyLiveForklift(payload, yardId) {
    if (!payload || payload.forkliftId == null) return
    if (payload.sceneX == null || payload.sceneY == null) return
    if (payload.cyId != null && yardId != null && String(payload.cyId) !== String(yardId)) return
    this.liveForklifts[String(payload.forkliftId)] = {
      id: String(payload.forkliftId),
      code: payload.forkliftCode || '',
      name: payload.forkliftName || payload.forkliftCode || '',
      x: Number(payload.sceneX),
      y: Number(payload.sceneY),
      heading: payload.direction == null ? undefined : Number(payload.direction)
    }
    this.syncLiveForklifts()
  },

  syncLiveForklifts() {
    if (!this.scene || !this.scene.setLiveForklifts) return
    const items = Object.keys(this.liveForklifts).map(id => this.liveForklifts[id])
    this.scene.setLiveForklifts(items)
  },

  /** 手指按下：第一次顺便校准朝向，并记下拖/捏起点 */
  onCanvasTouchStart(event) {
    if (!this._headingTapped) {
      this._headingTapped = true
      this.calibrateHeading()
    }
    const touches = event.touches || []
    this.gestureMode = null
    this.truckGrabbed = false
    this.dragging = false
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
      if (this.truckDragEnabled && this.isTouchOnTruck(touches[0])) {
        this.truckGrabbed = true
        this.dragLastYard = this.self ? { x: this.self.x, y: this.self.y } : null
        this.dragGrabYard = this.scene && this.scene.screenToYard
          ? this.scene.screenToYard(touches[0].x, touches[0].y)
          : null
        this.dragSelfAtGrab = this.self ? { x: this.self.x, y: this.self.y } : null
      }
    }
  },

  /** 手指移动：双指缩放/旋转/俯仰，单指拖场图 */
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
      this.truckGrabbed = false
      return
    }

    if (this.truckDragEnabled && this.truckGrabbed && touches.length === 1) {
      const start = this.panLast || touches[0]
      const moved = Math.hypot(touches[0].x - start.x, touches[0].y - start.y)
      if (!this.dragging && moved < 6) return
      if (!this.dragging) {
        this.dragging = true
        this.gestureMode = 'truck'
        if (this.scene.freezeView) this.scene.freezeView()
        this.setData({ followMode: false, viewAdjusted: true })
      }
      this.moveTruckByGrab(touches[0])
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
    const shouldReport = this.truckDragEnabled && this.dragging && this.self
    this.panLast = null
    this.pinchDistance = 0
    this.pinchMid = null
    this.pinchAngle = null
    this.gestureMode = null
    this.dragging = false
    this.truckGrabbed = false
    this.dragGrabYard = null
    this.dragSelfAtGrab = null
    if (shouldReport) this.reportDragLocation()
  },

  /** 手指是否按在本车上：屏幕 64px 内，或场区 16 米内 */
  isTouchOnTruck(touch) {
    if (!this.scene || !this.self || touch == null || this.self.x == null) return false
    if (this.scene.yardToScreen) {
      const screen = this.scene.yardToScreen(this.self.x, this.self.y)
      if (screen && Math.hypot(touch.x - screen.x, touch.y - screen.y) <= 64) return true
    }
    if (!this.scene.screenToYard) return false
    const yard = this.scene.screenToYard(touch.x, touch.y)
    if (!yard) return false
    return Math.hypot(yard.x - this.self.x, yard.y - this.self.y) <= 16
  },

  /** 按住车上再拖：车跟着位移走，不瞬移到指尖 */
  moveTruckByGrab(touch) {
    if (!this.scene || !this.scene.screenToYard || !touch) return
    const yard = this.scene.screenToYard(touch.x, touch.y)
    if (!yard || yard.x == null || yard.y == null) return
    let nextX = yard.x
    let nextY = yard.y
    if (this.dragGrabYard && this.dragSelfAtGrab) {
      nextX = this.dragSelfAtGrab.x + (yard.x - this.dragGrabYard.x)
      nextY = this.dragSelfAtGrab.y + (yard.y - this.dragGrabYard.y)
    }
    let heading = this.self && this.self.heading
    if (this.dragLastYard) {
      const dx = nextX - this.dragLastYard.x
      const dy = nextY - this.dragLastYard.y
      if (Math.hypot(dx, dy) > 0.4) {
        heading = Math.atan2(dx, -dy) * 180 / Math.PI
        if (heading < 0) heading += 360
      }
    }
    this.dragLastYard = { x: nextX, y: nextY }
    this.self = {
      ...(this.self || {}),
      x: nextX,
      y: nextY,
      heading,
      accuracy: 5,
      speed: 0
    }
    if (this.scene.setSelfImmediate) this.scene.setSelfImmediate(this.self, { skipRoute: true })
    else this.scene.setSelf(this.self)
  },

  moveTruckByTouch(touch) {
    if (!this.scene || !this.scene.screenToYard || !touch) return
    const yard = this.scene.screenToYard(touch.x, touch.y)
    if (!yard || yard.x == null || yard.y == null) return
    let heading = this.self && this.self.heading
    if (this.dragLastYard) {
      const dx = yard.x - this.dragLastYard.x
      const dy = yard.y - this.dragLastYard.y
      if (Math.hypot(dx, dy) > 0.4) {
        heading = Math.atan2(dx, -dy) * 180 / Math.PI
        if (heading < 0) heading += 360
      }
    }
    this.dragLastYard = { x: yard.x, y: yard.y }
    this.self = {
      ...(this.self || {}),
      x: yard.x,
      y: yard.y,
      heading,
      accuracy: 5,
      speed: 0
    }
    if (this.scene.setSelfImmediate) this.scene.setSelfImmediate(this.self, { skipRoute: true })
    else this.scene.setSelf(this.self)
  },

  async reportDragLocation() {
    if (!this.self || this.ended || this.reporting) return
    this.reporting = true
    try {
      const roads = this.yardMapData && this.yardMapData.roads
      const onRoad = roads && roads.length
        ? yardScene.snapPositionToRoad(roads, this.self.x, this.self.y)
        : null
      maybeForceRerouteIfRoadMismatch(this)
      const response = await request({
        url: `/navigation/mobile/sessions/${this.sessionId}/locations`,
        method: 'POST',
        data: locationUtil.toReport(this.gps || { accuracy: 5, speed: 0 }, this.self.heading, {
          forceReroute: true,
          dragTest: true,
          sceneX: this.self.x,
          sceneY: this.self.y,
          snapEdgeCode: onRoad && onRoad.road && onRoad.road.edgeCode,
          snapEdgeName: onRoad && onRoad.road && onRoad.road.name
        })
      })
      if (this.ended) return
      if (response.selfPoint) this.applySelfPoint(response.selfPoint, { immediate: true })
      if (response.route) this.applySession(response)
      else this.applyLocationTick(response)
    } catch (error) {
      if (this.ended || /已结束/.test(error.message || '')) return
      wx.showToast({ title: error.message, icon: 'none' })
    } finally {
      this.reporting = false
    }
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

  /** 俯视和斜视对调 */
  toggleFlatMode() {
    if (!this.scene) return
    const flatMode = !this.data.flatMode
    this.scene.setFlatMode(flatMode)
    this.setData({ flatMode })
  },

  /** 镜头回到跟车斜视 */
  resetView() {
    if (!this.scene) return
    this.scene.enableFollow()
    this.setData({ viewAdjusted: false, followMode: true, flatMode: false, compassRotate: 0 })
    this.syncScene()
  },

  /** 把镜头对准自己这辆车 */
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

  /** 进页先取一次点，场图上马上能画上车 */
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
  applySelfPoint(point, options) {
    if (!point || point.x == null || point.y == null) return
    const next = {
      ...(this.self || {}),
      x: Number(point.x),
      y: Number(point.y)
    }
    // 弱定位下的小幅跳点不挪车，减轻「一直在抖」；拖拽松手后要立刻落到上报点
    if (!options || !options.immediate) {
      if (this.self && this.self.x != null) {
        const dist = Math.hypot(next.x - this.self.x, next.y - this.self.y)
        const accuracy = next.accuracy || 50
        if (dist < 1.2 || (accuracy > 35 && dist < 6)) {
          next.x = this.self.x
          next.y = this.self.y
        }
      }
    }
    this.self = next
    if (options && options.immediate && this.scene && this.scene.setSelfImmediate) {
      this.scene.setSelfImmediate(this.self)
      return
    }
    this.syncScene()
  },

  /** 刷新定位好坏、限速、单行/逆行和当前提示 */
  refreshLocationUi(location) {
    const road = yardScene.nearestRoad(this.yardMapData && this.yardMapData.roads, this.self)
    const against = headingAgainstOneWay(this.self, road)
    const remainM = pickRemainingMeters(this, this.data.session, null)
    const accuracy = (location && location.accuracy) || 99
    const patch = {
      locationQuality: accuracy <= 30 ? '正常' : '较弱',
      locationQualityClass: accuracy <= 30 ? 'quality-good' : 'quality-weak',
      speedLimit: road && road.speedLimitKmh ? String(Math.round(road.speedLimitKmh)) : '',
      overspeed: Boolean(road && road.speedLimitKmh && (() => {
        const speed = location && location.speed != null ? location.speed : (this.self && this.self.speed)
        return speed > 0 && (Number(speed) * 3.6) > Number(road.speedLimitKmh) + 0.5
      })()),
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
      this.speakNav(instruction)
    } else {
      this.speakNav('')
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

  /** 指南针有新朝向：转车头，并偶尔转一下指南针圆盘 */
  handleCompass(res) {
    if (!res || res.direction == null) return
    this.compassHeading = res.direction
    if (this.self) {
      this.self.heading = res.direction
      this.self.headingFrom = res.from || 'sensor'
    }
    if (this.scene && this.scene.setHeading) this.scene.setHeading(res.direction)
    const now = Date.now()
    if (this._lastCompassUi && now - this._lastCompassUi < 400) return // 圆盘不必每帧都刷
    this._lastCompassUi = now
    const status = this.scene && this.scene.getStatus ? this.scene.getStatus() : null
    const compassRotate = compassRotateOf(status)
    if (compassRotate !== this.data.compassRotate) this.setData({ compassRotate })
  },

  /** 位置变了：刷新朝向，并按间隔把 GPS 报给后台 */
  async handleLocation(location) {
    if (this.ended) return
    if (this.dragging) return
    if (this.truckDragEnabled) {
      this.applySelf(location)
      return
    }
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

  /** 司机点「我已到达」：先问还剩多远，确认后再进到位页 */
  confirmArrival() {
    const purpose = (this.data.session && this.data.session.purpose) || 'job'
    const name = (this.data.session && this.data.session.targetName) || '目的贝位'
    const remain = Number(this.data.remainingDistance)
    const remainText = Number.isFinite(remain) && remain > 0
      ? `目前距离${name}还有约${Math.round(remain)}米，是否确认到达？`
      : `是否确认已到达${name}？`
    wx.showModal({
      title: '确认到达',
      content: remainText,
      confirmText: '确认到达',
      cancelText: '取消',
      success: result => {
        if (!result.confirm) return
        if (purpose === 'safety') {
          wx.redirectTo({ url: `/pages/safety-zone/index?sessionId=${this.sessionId}` })
          return
        }
        wx.redirectTo({
          url: `/pages/arrive-confirm/index?sessionId=${this.sessionId}&targetName=${encodeURIComponent(name)}`
        })
      }
    })
  },

  /** 路上遇到封闭、找不到目标等，选一类报给后台 */
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

  /** 结束这一趟，停止上报并回首页 */
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
