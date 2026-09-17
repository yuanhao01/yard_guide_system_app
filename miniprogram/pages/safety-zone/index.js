/**
 * 安全操作区：作业完成后导航去验箱，停稳确认后再开出场。
 * 依赖：request、location、yardScene、specialNav、routeInstruction、heading、config。
 */
const request = require('../../utils/request')
const locationUtil = require('../../utils/location')
const yardScene = require('../../utils/yardScene')
const specialNav = require('../../utils/specialNav')
const routeInstruction = require('../../utils/routeInstruction')
const headingSensor = require('../../utils/heading')
const config = require('../../config')

/** 两根手指之间的距离，用来判断捏合缩放 */
function touchDistance(touches) {
  return Math.hypot(touches[0].x - touches[1].x, touches[0].y - touches[1].y)
}

/** 两根手指的中点，用来判断双指平移/俯仰 */
function touchMidpoint(touches) {
  return {
    x: (touches[0].x + touches[1].x) / 2, // 中点左右
    y: (touches[0].y + touches[1].y) / 2 // 中点上下
  }
}

/** 两根手指连线的角度，用来判断拧转 */
function touchAngle(touches) {
  return Math.atan2(touches[1].y - touches[0].y, touches[1].x - touches[0].x)
}

/** 把转角收到正负半圈以内，避免从 359 跳到 1 被当成大转 */
function normalizeAngleDelta(delta) {
  while (delta > Math.PI) delta -= Math.PI * 2
  while (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

/** 优先按场图上已画蓝线报下一句，没有蓝线再按规划折线 */
function pickSafetyInstruction(page, fallback) {
  const targetName = (page.session && page.session.targetName) || '安全操作区'
  const painted = page.scene && page.scene.getPaintedRoute && page.scene.getPaintedRoute() // 已画蓝线
  const selfWorld = page.scene && page.scene.getSelfWorld && page.scene.getSelfWorld() // 车在三维里的位置
  const fromPainted = painted
    ? routeInstruction.describeWorldInstruction(selfWorld, painted, targetName)
    : ''
  if (fromPainted) return fromPainted
  const blocks = page.yardMapData && page.yardMapData.blocks // 箱区，用来丢掉箱区内引线
  return routeInstruction.describeNextInstruction(page.self, page.routePoints, targetName, blocks)
    || fallback
    || '沿当前道路直行'
}

Page({
  data: {
    statusBarHeight: 20, // 避开手机状态栏
    subtitle: '提箱完成 · 请前往验箱', // 顶栏副标题
    instruction: '正在规划前往安全操作区', // 转向提示
    mapLoading: true, // 场图还在加载
    mapError: '', // 场图失败原因
    confirming: false, // 正在提交验箱
    equipmentName: '', // 作业机械
    workTypeLabel: '', // 作业类型
    carrierCode: '', // 船公司
    cntrNo: '', // 箱号
    cntrSize: '', // 箱型
    followMode: true, // 镜头是否跟车
    followIcon: '+', // 跟车按钮图标
    followLabel: '跟车', // 跟车按钮文字
    flatMode: false, // 是否俯视 2D
    flatLabel: '2D' // 2D/3D 按钮字（点下去变成另一种）
  },

  /** 进页：建场图、开指南针、拉或新开验箱会话 */
  onLoad(options) {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: (windowInfo && windowInfo.statusBarHeight) || 20 })
    this.jobSessionId = options.jobSessionId || '' // 原来的作业会话
    this.sessionId = options.sessionId || '' // 已有验箱会话就直接用
    // self 是场区米制坐标（后端 selfPoint），gps 是原始定位，只用于上报
    this.self = null
    this.gps = null
    this.heading = null // 车头朝向
    this.scene = null // 三维场图
    this.ended = false // 离开页后不再上报
    this.lastReportTime = 0 // 上次上报时间
    this.locationListener = location => this.handleLocation(location) // 位置变化回调
    this.offHeading = headingSensor.onChange(deg => {
      this.heading = deg
      if (this.self) this.self = { ...this.self, heading: deg, headingFrom: 'compass' }
      if (this.scene && this.scene.setHeading) this.scene.setHeading(deg)
    })
    headingSensor.start() // 打开指南针
    setTimeout(() => headingSensor.start(), 600) // 有的机型第一次开不起来，再试一次
    this.initScene().then(() => this.bootstrap())
  },

  /** 回到前台再开一次指南针 */
  onShow() {
    headingSensor.start()
  },

  /** 页面画好后再开一次指南针 */
  onReady() {
    headingSensor.start()
  },

  /** 离开页：停定位、停指南针、拆场图 */
  onUnload() {
    this.ended = true
    locationUtil.unwatchLocation(this.locationListener, this.locationWatcher)
    this.locationWatcher = null
    if (this.offHeading) this.offHeading()
    headingSensor.stop()
    if (this.scene) {
      this.scene.dispose()
      this.scene = null
    }
  },

  /** 在画布上建三维堆场 */
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

  /** 有验箱会话就接着走，没有就新开一趟去验箱区 */
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
          task: job,
          heading: headingSensor.get()
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
      if (this.session.selfPoint) this.applySelfPoint(this.session.selfPoint)
      const location = await locationUtil.getCurrentLocation()
      this.applySelf(location)
      locationUtil.startLocationUpdate()
        .then(() => {
          this.locationWatcher = locationUtil.watchLocation(this.locationListener)
        })
        .catch(() => {})
      this.lastReportTime = 0
      await this.handleLocation(location) // 立刻报一次，马上出路线
    } catch (error) {
      this.setData({ mapError: error.message || '无法进入安全操作区', mapLoading: false })
    }
  },

  /** 拉堆场地图、路线和验箱区目标，画到场图上 */
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

  /** 只更新航向；场区坐标等后端 selfPoint 回来再落图。 */
  applySelf(location) {
    if (headingSensor.get() == null && location.direction > 0 && headingSensor.seed) {
      headingSensor.seed(location.direction) // 指南针还没出数，先用 GPS 方向
    }
    this.gps = location
    this.heading = headingSensor.get() != null
      ? headingSensor.get()
      : (location.direction > 0 ? location.direction : (this.heading != null ? this.heading : 0))
    if (this.self) this.applySelfPoint(this.self) // 有场区坐标就刷新朝向
  },

  /** @param {{x:number, y:number}} point 后端按三点定标换算出的场区米制坐标 */
  applySelfPoint(point) {
    if (!point || point.x == null || point.y == null) return
    this.self = {
      x: Number(point.x),
      y: Number(point.y),
      heading: this.heading || 0,
      accuracy: this.gps && this.gps.accuracy,
      speed: this.gps && this.gps.speed
    }
    if (this.scene) this.scene.setSelf(this.self)
    const instruction = pickSafetyInstruction(this, this.data.instruction)
    if (instruction && instruction !== this.data.instruction) {
      this.setData({ instruction })
    }
  },

  /** 位置变了：刷新朝向，并按间隔上报后台要新路线 */
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
        data: locationUtil.toReport(location, this.heading)
      })
      if (response.selfPoint) this.applySelfPoint(response.selfPoint)
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

  /** 手势挪过镜头后，跟车改成全场 */
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

  /** 手指按下：记下单指拖或双指捏合的起点 */
  onCanvasTouchStart(event) {
    headingSensor.start() // 摸屏幕时再开一次指南针（有的机要用户手势）
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

  /** 手指移动：双指缩放/旋转/俯仰，单指拖动场图 */
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

      const dDist = distance - this.pinchDistance // 两指距离变化
      const dMidY = mid.y - (this.pinchMid ? this.pinchMid.y : mid.y) // 中点上下
      const dMidX = mid.x - (this.pinchMid ? this.pinchMid.x : mid.x) // 中点左右
      const dAngle = normalizeAngleDelta(angle - (this.pinchAngle != null ? this.pinchAngle : angle))
      const scaleChange = Math.abs(dDist)
      const parallelMove = Math.hypot(dMidX, dMidY)
      const rotateMove = Math.abs(dAngle) * Math.max(distance, 1)

      // 还没判定手势时，按谁动得更多来认：拧转 / 捏合 / 上下滑俯仰
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
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return // 抖动忽略
      this.panLast = { x: touches[0].x, y: touches[0].y }
      this.scene.pan(dx, dy)
      if (this.data.followMode) this.markMapAdjusted()
    }
  },

  /** 手指抬起，清掉这次手势 */
  onCanvasTouchEnd() {
    this.panLast = null
    this.pinchDistance = 0
    this.pinchMid = null
    this.pinchAngle = null
    this.gestureMode = null
  },

  /** 切换跟车 / 全场 */
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

  /** 俯视 2D 和斜视 3D 对调 */
  toggleFlatMode() {
    if (!this.scene) return
    const flatMode = !this.data.flatMode
    this.scene.setFlatMode(flatMode)
    this.setData({
      flatMode,
      flatLabel: flatMode ? '3D' : '2D'
    })
  },

  /** 放大场图，同时退出跟车 */
  zoomIn() {
    if (!this.scene) return
    this.scene.zoom(1.35)
    this.setData({ followMode: false, followIcon: '#', followLabel: '全场' })
  },

  /** 缩小场图，同时退出跟车 */
  zoomOut() {
    if (!this.scene) return
    this.scene.zoom(1 / 1.35)
    this.setData({ followMode: false, followIcon: '#', followLabel: '全场' })
  },

  /** 镜头回到跟车 */
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

  /** 返回；没有上一页就回首页 */
  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/home/index' }) })
  },

  /** 打开这一趟作业的协同群 */
  openCollab() {
    const sid = this.jobSessionId || this.sessionId
    if (!sid) {
      wx.showToast({ title: '协同群尚未建立', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/collab-group/index?sessionId=${sid}` })
  },

  /** 验箱区有问题时，引导去协同群找调度 */
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

  /** 验箱完成，开一趟出场导航 */
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
