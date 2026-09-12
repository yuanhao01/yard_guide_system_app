/**
 * 堆场真三维场景（Three.js / WebGL）。
 *
 * 不用 canvas 2d 假倾斜。相机是透视投影，箱垛是真实 Box 网格，
 * 观感对齐高德地图那种挤出建筑：能看见侧面、有透视远近、能俯仰缩放。
 *
 * 世界坐标：X 东、Y 上、Z 南（-Z 为北），单位米。
 */
const { createScopedThreejs } = require('../libs/threejs/index.js')
const vehicleLoader = require('./vehicleLoader')
const headingSensor = require('./heading')

const M_PER_DEG_LAT = 111320
const STACK_HEIGHT = 7.8
/** 单层集装箱高度（米），箱垛高度按堆放层数叠出来。 */
const CNTR_LAYER_H = 2.75
/** 俯仰角：相对水平面抬起的角度。越大越接近正俯视，越小越接近侧视（像高德 3D）。 */
const DEFAULT_PITCH = 55 * Math.PI / 180
const MIN_PITCH = 18 * Math.PI / 180
const MAX_PITCH = 88 * Math.PI / 180
const FLAT_PITCH = 86 * Math.PI / 180
const MIN_DISTANCE = 40
const MAX_DISTANCE = 900

function clampPitch(pitch) {
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch))
}

function metersPerDegLon(lat) {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
}

function boundsOf(points) {
  let minLng = Infinity
  let maxLng = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  points.forEach(p => {
    minLng = Math.min(minLng, p.longitude)
    maxLng = Math.max(maxLng, p.longitude)
    minLat = Math.min(minLat, p.latitude)
    maxLat = Math.max(maxLat, p.latitude)
  })
  return { minLng, maxLng, minLat, maxLat }
}

function yardBounds(map) {
  const points = []
  ;(map.blocks || []).forEach(b => (b.polygon || []).forEach(p => points.push(p)))
  ;(map.roads || []).forEach(r => (r.path || []).forEach(p => points.push(p)))
  return points.length ? boundsOf(points) : null
}

/**
 * 到场区包围盒边缘的距离（米）。padMeters 把判定范围外扩，
 * 演示场几何比真实小区小一圈时，避免站在 C 座仍被报「场外两百米」。
 */
function distanceToBounds(bounds, self, padMeters) {
  if (!bounds || !self) return null
  const pad = padMeters || 0
  const mLon = metersPerDegLon(self.latitude)
  const padLon = pad / mLon
  const padLat = pad / M_PER_DEG_LAT
  const dx = Math.max(
    (bounds.minLng - padLon) - self.longitude,
    0,
    self.longitude - (bounds.maxLng + padLon)
  ) * mLon
  const dy = Math.max(
    (bounds.minLat - padLat) - self.latitude,
    0,
    self.latitude - (bounds.maxLat + padLat)
  ) * M_PER_DEG_LAT
  return Math.hypot(dx, dy)
}

/**
 * @param {HTMLCanvasElement} canvas 小程序 webgl canvas 节点
 * @param {number} width 逻辑像素宽
 * @param {number} height 逻辑像素高
 * @param {number} dpr 设备像素比
 */
function createYardScene(canvas, width, height, dpr) {
  const THREE = createScopedThreejs(canvas)
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false
  })
  renderer.setPixelRatio(dpr || 2)
  renderer.setSize(width, height, false)
  renderer.setClearColor(0xe4e9ef, 1)
  // 小程序 WebGL 开阴影 + 大量 Mesh 容易卡死主线程，关闭阴影保流畅
  renderer.shadowMap.enabled = false

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0xe4e9ef, 620, 1700)

  const camera = new THREE.PerspectiveCamera(48, width / height, 0.2, 4000)

  const hemi = new THREE.HemisphereLight(0xffffff, 0xb4bcc6, 1.05)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xfff4e6, 0.62)
  sun.position.set(140, 240, 90)
  scene.add(sun)

  const root = new THREE.Group()
  scene.add(root)

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    new THREE.MeshLambertMaterial({ color: 0xc8ced6 })
  )
  ground.rotation.x = -Math.PI / 2
  ground.position.y = -0.05
  root.add(ground)

  let mapGroup = new THREE.Group()
  root.add(mapGroup)
  let routeGroup = new THREE.Group()
  root.add(routeGroup)
  let dynamicGroup = new THREE.Group()
  root.add(dynamicGroup)
  // 本车单独挂，指南针刷新只改位置/航向，不要拆掉重建
  let selfTruck = null

  const state = {
    width,
    height,
    map: null,
    route: [],
    target: null,
    targetLabel: '',
    targetBlockId: null,
    targetSlot: null,
    self: null,
    followMode: true,
    userView: null,
    // lookAt 用经纬度；distance 相机距离；pitch 俯仰；bearing 方位（弧度，0=从南望北）
    view: { centerLng: 0, centerLat: 0, distance: 220, pitch: DEFAULT_PITCH, bearing: 0 },
    fitDistance: 220,
    originLng: 0,
    originLat: 0,
    offYardMeters: null,
    dirty: true,
    running: true,
    mapBuilding: false,
    mapBuildToken: 0,
    demoContainer: false,
    demoContainerAnchor: null,
    routeEnd: null,
    routeLine: null,
    purpose: 'job',
    // 北朝上。车头跟手机转，和右上角高德小人一致；拧地图才改 bearing
    headingUp: false,
    vehicleParts: {},
    containerTemplates: {
      c20: vehicleLoader.createTemplate(THREE, vehicleLoader.getContainerParts(20)),
      c40: vehicleLoader.createTemplate(THREE, vehicleLoader.getContainerParts(40))
    }
  }

  function toWorld(lng, lat, y) {
    const mLon = metersPerDegLon(state.originLat || lat)
    const x = (lng - state.originLng) * mLon
    // Z 向南：纬度越大（北）Z 越小
    const z = -(lat - state.originLat) * M_PER_DEG_LAT
    return new THREE.Vector3(x, y || 0, z)
  }

  function fromWorld(x, z) {
    const lat0 = state.originLat || 0
    const mLon = metersPerDegLon(lat0) || 1
    return {
      longitude: state.originLng + x / mLon,
      latitude: lat0 - z / M_PER_DEG_LAT
    }
  }

  function polylineLength(points) {
    if (!points || points.length < 2) return 0
    let n = 0
    for (let i = 1; i < points.length; i += 1) n += points[i - 1].distanceTo(points[i])
    return n
  }

  function remainingAfter(points, index, onPoint) {
    if (!points || points.length < 2) return 0
    if (index >= points.length - 1) return 0
    let n = onPoint.distanceTo(points[index + 1])
    for (let i = index + 2; i < points.length; i += 1) n += points[i - 1].distanceTo(points[i])
    return n
  }

  function setOriginFromBounds(bounds) {
    state.originLng = (bounds.minLng + bounds.maxLng) / 2
    state.originLat = (bounds.minLat + bounds.maxLat) / 2
  }

  function disposeObject(obj) {
    obj.traverse(child => {
      if (child.geometry) child.geometry.dispose()
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose())
        else child.material.dispose()
      }
    })
  }

  function clearGroup(group) {
    while (group.children.length) {
      const child = group.children.pop()
      disposeObject(child)
      group.remove(child)
    }
  }

  function makeBox(w, h, d, color, opts) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshLambertMaterial({ color, ...(opts || {}) })
    )
    mesh.castShadow = false
    mesh.receiveShadow = false
    return mesh
  }

  /** 不受光照染色，场区底板必须用这个，Lambert 白会渲成灰。 */
  function makeUnlitBox(w, h, d, color) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color })
    )
    mesh.castShadow = false
    mesh.receiveShadow = false
    return mesh
  }

  function buildPavement() {
    // 不再抬一块整场浅色垫：俯视时中间会像一块白色遮挡，把场区和路盖住
  }

  function buildRoadSegment(a, b, widthM, color, group, y, extraLen) {
    const targetGroup = group || mapGroup
    const mid = a.clone().add(b).multiplyScalar(0.5)
    const len = a.distanceTo(b)
    if (len < 0.2) return null
    const pad = extraLen == null ? Math.min(widthM * 0.35, 2.4) : extraLen
    const mesh = makeBox(widthM, 0.1, len + pad, color)
    mesh.position.copy(mid)
    mesh.position.y = y != null ? y : 0.12
    const angle = Math.atan2(b.x - a.x, b.z - a.z)
    mesh.rotation.y = angle
    targetGroup.add(mesh)
    return mesh
  }

  function buildRoadJoint(p, widthM, color, y, group) {
    const joint = makeBox(widthM, 0.12, widthM, color)
    joint.position.set(p.x, y != null ? y : 0.24, p.z)
    ;(group || mapGroup).add(joint)
  }

  function buildDashedCenterLine(a, b, group, colorHex) {
    const len = a.distanceTo(b)
    if (len < 4) return
    const angle = Math.atan2(b.x - a.x, b.z - a.z)
    const dashLen = 2.6
    const gap = 2.0
    let t = 1.5
    while (t + dashLen < len - 1.5) {
      const p0 = a.clone().lerp(b, t / len)
      const p1 = a.clone().lerp(b, (t + dashLen) / len)
      const mid = p0.clone().add(p1).multiplyScalar(0.5)
      const dash = makeBox(0.22, 0.04, dashLen, colorHex == null ? 0xf0b429 : colorHex)
      dash.position.set(mid.x, 0.3, mid.z)
      dash.rotation.y = angle
      ;(group || mapGroup).add(dash)
      t += dashLen + gap
    }
  }

  /** 单向路画路面箭头，不再画中心黄虚线。 */
  function buildOneWayArrows(a, b, group) {
    const len = a.distanceTo(b)
    if (len < 5) return
    const tangent = b.clone().sub(a)
    tangent.y = 0
    if (tangent.length() < 0.2) return
    tangent.normalize()
    const angle = Math.atan2(tangent.x, tangent.z)
    const side = new THREE.Vector3(-tangent.z, 0, tangent.x)
    let t = 3
    while (t < len - 3) {
      const p = a.clone().lerp(b, t / len)
      for (let s = -1; s <= 1; s += 2) {
        const wing = makeBox(0.2, 0.05, 1.05, 0xf5f0d8)
        wing.position.set(
          p.x + side.x * s * 0.26 - tangent.x * 0.16,
          0.32,
          p.z + side.z * s * 0.26 - tangent.z * 0.16
        )
        wing.rotation.y = angle + s * 0.55
        ;(group || mapGroup).add(wing)
      }
      t += 8
    }
  }

  function buildRoads(roads) {
    ;(roads || []).forEach(road => {
      const path = road.path || []
      const widthM = Number(road.speedLimitKmh) >= 15 ? 9 : 6.5
      const dir = Number(road.directionType)
      const twoWay = !(dir === 1 || dir === 2)
      const points = []
      for (let i = 0; i < path.length; i += 1) {
        points.push(toWorld(path[i].longitude, path[i].latitude, 0))
      }
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i]
        const b = points[i + 1]
        buildRoadSegment(a, b, widthM + 2.2, 0x5f6874, mapGroup, 0.16)
        buildRoadSegment(a, b, widthM + 0.9, 0xd9dee5, mapGroup, 0.2)
        buildRoadSegment(a, b, widthM, 0x7a8490, mapGroup, 0.24)
        if (twoWay) {
          buildDashedCenterLine(a, b, mapGroup)
        } else {
          const from = dir === 2 ? b : a
          const to = dir === 2 ? a : b
          buildOneWayArrows(from, to, mapGroup)
        }
      }
      points.forEach(p => {
        buildRoadJoint(p, widthM + 2.2, 0x5f6874, 0.16)
        buildRoadJoint(p, widthM, 0x7a8490, 0.24)
      })
    })
  }

  function lerp2(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }

  const CNTR_COLORS = [0x1e3a8a, 0xb42318, 0xf4f4f5, 0xdb2777, 0x1d4ed8, 0x111827, 0x0e7490, 0x365314]

  function stackColor(stack) {
    const key = `${(stack && stack.cntrNo) || ''}|${(stack && stack.slot) || ''}|${(stack && stack.rowIndex) || ''}`
    let hash = 0
    for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
    const side = CNTR_COLORS[hash % CNTR_COLORS.length]
    return { side, top: side }
  }

  function blockPalette(block) {
    const raw = `${(block && block.blockCode) || ''}${(block && block.blockName) || ''}`.toUpperCase()
    if (raw.indexOf('A') >= 0) {
      return { label: '#1a5c40', deck: 0xd5dce4, grid: 0x8b96a2 }
    }
    if (raw.indexOf('B') >= 0) {
      return { label: '#1e3a5f', deck: 0xd5dce4, grid: 0x8b96a2 }
    }
    if (raw.indexOf('C') >= 0) {
      return { label: '#5c401a', deck: 0xd5dce4, grid: 0x8b96a2 }
    }
    return { label: '#33415c', deck: 0xd5dce4, grid: 0x8b96a2 }
  }

  function shortBlockLabel(block) {
    const name = (block && block.blockName) || ''
    const code = (block && block.blockCode) || ''
    if (/[A-Za-z]区/.test(name)) return name.match(/[A-Za-z]区/)[0]
    if (/[A-Za-z]座/.test(name)) return name.match(/[A-Za-z]座/)[0].replace('座', '区')
    if (code) return `${code}区`
    return name.slice(0, 4) || '场区'
  }

  function makeTextSprite(text, colorHex, opts) {
    try {
      const option = opts || {}
      const plate = option.plate !== false
      const w = 192
      const h = 48
      let canvas = null
      if (typeof wx !== 'undefined' && wx.createOffscreenCanvas) {
        canvas = wx.createOffscreenCanvas({ type: '2d', width: w, height: h })
      } else if (typeof document !== 'undefined' && document.createElement) {
        canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
      }
      if (!canvas || !canvas.getContext) return null
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, w, h)
      if (plate) {
        ctx.fillStyle = 'rgba(255,255,255,0.94)'
        const r = 8
        ctx.beginPath()
        ctx.moveTo(r, 4)
        ctx.lineTo(w - r, 4)
        ctx.quadraticCurveTo(w - 4, 4, w - 4, r)
        ctx.lineTo(w - 4, h - r)
        ctx.quadraticCurveTo(w - 4, h - 4, w - r, h - 4)
        ctx.lineTo(r, h - 4)
        ctx.quadraticCurveTo(4, h - 4, 4, h - r)
        ctx.lineTo(4, r)
        ctx.quadraticCurveTo(4, 4, r, 4)
        ctx.closePath()
        ctx.fill()
      }
      ctx.font = 'bold 22px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = colorHex || '#334155'
      ctx.fillText(text, w / 2, h / 2 + 1)
      const texture = new THREE.CanvasTexture(canvas)
      texture.needsUpdate = true
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
        depthWrite: false
      }))
      const sx = option.scaleX || 11
      const sy = option.scaleY || 2.8
      sprite.scale.set(sx, sy, 1)
      sprite.userData.scaleWithView = true
      sprite.userData.baseScale = { x: sx, y: sy, z: 1 }
      return sprite
    } catch (error) {
      return null
    }
  }

  function simplifyRoutePoints(points) {
    if (!points || points.length < 2) return points || []
    const kept = [points[0].clone()]
    for (let i = 1; i < points.length; i += 1) {
      if (kept[kept.length - 1].distanceTo(points[i]) >= 1.6) {
        kept.push(points[i].clone())
      } else if (i === points.length - 1) {
        kept[kept.length - 1].copy(points[i])
      }
    }
    if (kept.length < 3) return kept
    const out = [kept[0]]
    for (let i = 1; i < kept.length - 1; i += 1) {
      const a = kept[i].clone().sub(kept[i - 1]).setY(0)
      const b = kept[i + 1].clone().sub(kept[i]).setY(0)
      if (a.length() < 0.2 || b.length() < 0.2) continue
      a.normalize()
      b.normalize()
      if (a.dot(b) > 0.992) continue
      out.push(kept[i])
    }
    out.push(kept[kept.length - 1])
    return out
  }

  /**
   * 折线拐角切成等宽圆弧，对齐高保真 02 那种小圆角蓝线。
   * 不用二次贝塞尔：那会在弯里忽胖忽瘦，放大后像鼓包。
   */
  function filletPolyline(points, radius) {
    if (!points || points.length < 3) return (points || []).map(p => p.clone())
    const out = [points[0].clone()]
    for (let i = 1; i < points.length - 1; i += 1) {
      const prev = points[i - 1]
      const curr = points[i]
      const next = points[i + 1]
      const inDir = new THREE.Vector3(curr.x - prev.x, 0, curr.z - prev.z)
      const outDir = new THREE.Vector3(next.x - curr.x, 0, next.z - curr.z)
      const dIn = inDir.length()
      const dOut = outDir.length()
      if (dIn < 0.3 || dOut < 0.3) {
        out.push(curr.clone())
        continue
      }
      inDir.multiplyScalar(1 / dIn)
      outDir.multiplyScalar(1 / dOut)
      const cross = inDir.x * outDir.z - inDir.z * outDir.x
      const dot = Math.max(-1, Math.min(1, inDir.x * outDir.x + inDir.z * outDir.z))
      const turn = Math.atan2(cross, dot)
      if (Math.abs(turn) < 0.12) {
        out.push(curr.clone())
        continue
      }
      const half = Math.abs(turn) / 2
      let r = radius
      let dist = r / Math.tan(half)
      const maxDist = Math.min(dIn, dOut) * 0.38
      if (dist > maxDist) {
        dist = maxDist
        r = dist * Math.tan(half)
      }
      if (r < 0.45) {
        out.push(curr.clone())
        continue
      }
      const p1 = new THREE.Vector3(curr.x - inDir.x * dist, curr.y, curr.z - inDir.z * dist)
      const p2 = new THREE.Vector3(curr.x + outDir.x * dist, curr.y, curr.z + outDir.z * dist)
      const sign = turn > 0 ? 1 : -1
      const nIn = new THREE.Vector3(-inDir.z * sign, 0, inDir.x * sign)
      const center = new THREE.Vector3(p1.x + nIn.x * r, curr.y, p1.z + nIn.z * r)
      let a0 = Math.atan2(p1.z - center.z, p1.x - center.x)
      let a1 = Math.atan2(p2.z - center.z, p2.x - center.x)
      let sweep = a1 - a0
      while (sweep > Math.PI) sweep -= Math.PI * 2
      while (sweep < -Math.PI) sweep += Math.PI * 2
      if (sign > 0 && sweep < 0) sweep += Math.PI * 2
      if (sign < 0 && sweep > 0) sweep -= Math.PI * 2
      const steps = Math.max(12, Math.ceil(Math.abs(sweep) * r / 0.28))
      out.push(p1)
      for (let s = 1; s < steps; s += 1) {
        const a = a0 + sweep * (s / steps)
        out.push(new THREE.Vector3(
          center.x + Math.cos(a) * r,
          curr.y,
          center.z + Math.sin(a) * r
        ))
      }
      out.push(p2)
    }
    out.push(points[points.length - 1].clone())
    return out
  }

  /** 把默认沿 +Y 的圆柱转到 XZ 地面方向，避免用方盒子在拐角挤出菱形凸起。 */
  function alignCylinderToXZ(mesh, nx, nz) {
    const dir = new THREE.Vector3(nx, 0, nz)
    if (dir.length() < 1e-4) return
    dir.normalize()
    if (mesh.quaternion && typeof mesh.quaternion.setFromUnitVectors === 'function') {
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      return
    }
    mesh.rotation.x = Math.PI / 2
    mesh.rotation.y = Math.atan2(dir.x, dir.z)
  }

  function addRouteCap(point, radius, y, color, group) {
    try {
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 8, 6),
        new THREE.MeshBasicMaterial({ color })
      )
      cap.position.set(point.x, y, point.z)
      group.add(cap)
    } catch (error) {
      buildRoundJoint(point, radius, color, y, group)
    }
  }

  /**
   * 蓝色导航带：圆柱接圆球，拐角圆润，不再铺白套管。
   */
  function buildRouteRibbon(points, width, y, color, group, capPoints) {
    if (!points || points.length < 2) return
    const radius = width * 0.5
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      const dx = b.x - a.x
      const dz = b.z - a.z
      const len = Math.hypot(dx, dz)
      if (len < 0.08) continue
      try {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(radius, radius, len, 8),
          new THREE.MeshBasicMaterial({ color })
        )
        mesh.position.set((a.x + b.x) / 2, y, (a.z + b.z) / 2)
        alignCylinderToXZ(mesh, dx / len, dz / len)
        group.add(mesh)
      } catch (error) {
        buildRoadSegment(a, b, width, color, group, y, 0)
      }
    }
    addRouteCap(points[0], radius, y, color, group)
    addRouteCap(points[points.length - 1], radius, y, color, group)
  }

  function addRouteArrow(p, tangent, y, group) {
    const dir = tangent.clone().setY(0)
    if (dir.length() < 0.01) return
    dir.normalize()
    const yaw = Math.atan2(dir.x, dir.z)
    const side = new THREE.Vector3(-dir.z, 0, dir.x)
    // 扁箭头嵌在蓝线顶面：两翼收在线宽内，厚度几乎贴管，不再悬空
    for (let s = -1; s <= 1; s += 2) {
      const wing = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, 0.045, 0.48),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      )
      wing.position.set(
        p.x + side.x * s * 0.12 - dir.x * 0.02,
        y,
        p.z + side.z * s * 0.12 - dir.z * 0.02
      )
      wing.rotation.y = yaw + s * 0.68
      group.add(wing)
    }
  }

  /** 路线偏到行驶方向右侧车道，避开路心黄虚线。 */
  function offsetPolylineRight(points, offsetM) {
    if (!points || points.length < 2 || !offsetM) return points || []
    const rawOff = []
    for (let i = 0; i < points.length; i += 1) {
      rawOff.push(typeof offsetM === 'function' ? Number(offsetM(i, points[i])) || 0 : Number(offsetM) || 0)
    }
    for (let i = 1; i < rawOff.length; i += 1) {
      const delta = rawOff[i] - rawOff[i - 1]
      if (Math.abs(delta) > 0.5) rawOff[i] = rawOff[i - 1] + (delta > 0 ? 0.5 : -0.5)
    }
    const out = []
    for (let i = 0; i < points.length; i += 1) {
      let tan
      if (i === 0) tan = points[1].clone().sub(points[0])
      else if (i === points.length - 1) tan = points[i].clone().sub(points[i - 1])
      else tan = points[i + 1].clone().sub(points[i - 1])
      tan.y = 0
      if (tan.length() < 0.01) {
        out.push(points[i].clone())
        continue
      }
      tan.normalize()
      const off = rawOff[i]
      if (!off) {
        out.push(points[i].clone())
        continue
      }
      // 右手交通：right = forward × up = (-tz, 0, tx)
      const right = new THREE.Vector3(-tan.z, 0, tan.x)
      out.push(new THREE.Vector3(
        points[i].x + right.x * off,
        points[i].y,
        points[i].z + right.z * off
      ))
    }
    return out
  }

  function isOneWayNear(worldPoint) {
    const roads = (state.map && state.map.roads) || []
    let best = null
    let bestD = 14
    roads.forEach(road => {
      const path = road.path || []
      for (let i = 0; i < path.length - 1; i += 1) {
        const a = toWorld(path[i].longitude, path[i].latitude, 0)
        const b = toWorld(path[i + 1].longitude, path[i + 1].latitude, 0)
        const dx = b.x - a.x
        const dz = b.z - a.z
        const len2 = dx * dx + dz * dz
        const t = len2 < 1e-6 ? 0 : Math.max(0, Math.min(1, ((worldPoint.x - a.x) * dx + (worldPoint.z - a.z) * dz) / len2))
        const d = Math.hypot(worldPoint.x - (a.x + t * dx), worldPoint.z - (a.z + t * dz))
        if (d < bestD) {
          bestD = d
          best = road
        }
      }
    })
    if (!best) return false
    const dir = Number(best.directionType)
    return dir === 1 || dir === 2
  }

  /** 把 (u, v) 归一化坐标换算成世界坐标，u 沿贝方向、v 沿排方向。 */
  function cornerAt(corners, u, v) {
    const p = lerp2(lerp2(corners.sw, corners.se, u), lerp2(corners.nw, corners.ne, u), v)
    return toWorld(p[0], p[1], 0)
  }

  /**
   * 场区箱位格网。不用 LineSegments：小程序这套 Three.js 对 BufferAttribute
   * 支持不完整，整段建图会在这里抛错，后面的箱子就全画不出来。
   */
  function buildSlotGrid(corners, slots, rows, colorHex) {
    for (let i = 0; i <= slots; i += 1) {
      const a = cornerAt(corners, i / slots, 0)
      const b = cornerAt(corners, i / slots, 1)
      const line = makeUnlitBox(0.16, 0.05, Math.max(a.distanceTo(b), 0.4), colorHex)
      const mid = a.clone().add(b).multiplyScalar(0.5)
      line.position.set(mid.x, 0.18, mid.z)
      line.rotation.y = Math.atan2(b.x - a.x, b.z - a.z)
      mapGroup.add(line)
    }
    for (let j = 0; j <= rows; j += 1) {
      const a = cornerAt(corners, 0, j / rows)
      const b = cornerAt(corners, 1, j / rows)
      const line = makeUnlitBox(0.16, 0.05, Math.max(a.distanceTo(b), 0.4), colorHex)
      const mid = a.clone().add(b).multiplyScalar(0.5)
      line.position.set(mid.x, 0.18, mid.z)
      line.rotation.y = Math.atan2(b.x - a.x, b.z - a.z)
      mapGroup.add(line)
    }
  }

  function addIsoContainer(center, yaw, alongU, alongV, layerH, floor, forty, color) {
    const template = state.containerTemplates && (forty ? state.containerTemplates.c40 : state.containerTemplates.c20)
    const model = template && vehicleLoader.instantiateTemplate(THREE, template, color)
    const y = 0.2 + layerH * (floor + 0.5) + floor * 0.04
    if (model) {
      const nativeL = forty ? 12.192 : 6.058
      const nativeW = 2.438
      const nativeH = 2.591
      model.scale.set(alongV / nativeW, layerH / nativeH, alongU / nativeL)
      model.position.set(center.x, 0.2 + floor * (layerH + 0.04), center.z)
      model.rotation.y = yaw
      mapGroup.add(model)
      return
    }
    const box = makeBox(alongV, layerH, alongU, color)
    box.position.set(center.x, y, center.z)
    box.rotation.y = yaw
    mapGroup.add(box)
  }

  /**
   * 箱区渲染：对齐 Web 端场位图——白色地坪 + 箱位格网，
   * 有箱的格子才立一个彩色箱块，高度按实际堆放层数，空箱位只留格线。
   */
  function buildBlocksClean(blocks, targetBlockId, targetSlot) {
    ;(blocks || []).forEach(block => {
      try {
        buildOneBlock(block, targetBlockId, targetSlot)
      } catch (error) {
        console.error('[yardScene] build block failed', (block && block.blockCode) || '', error)
      }
    })
  }

  function buildOneBlock(block, targetBlockId, targetSlot) {
      const polygon = block.polygon || []
      if (polygon.length < 4) return
      const corners = {
        sw: [polygon[0].longitude, polygon[0].latitude],
        se: [polygon[1].longitude, polygon[1].latitude],
        ne: [polygon[2].longitude, polygon[2].latitude],
        nw: [polygon[3].longitude, polygon[3].latitude]
      }
      const slots = Math.max(block.slotCount || 1, 1)
      const rows = Math.max(block.rowCount || 1, 1)
      const palette = blockPalette(block)

      let psw = toWorld(corners.sw[0], corners.sw[1], 0)
      let pse = toWorld(corners.se[0], corners.se[1], 0)
      let pnw = toWorld(corners.nw[0], corners.nw[1], 0)
      // 长边必须是贝、短边是排；若接口多边形对调了，这里把 u/v 拧回来
      if (psw.distanceTo(pse) + 0.5 < psw.distanceTo(pnw)) {
        corners.se = [polygon[3].longitude, polygon[3].latitude]
        corners.nw = [polygon[1].longitude, polygon[1].latitude]
        psw = toWorld(corners.sw[0], corners.sw[1], 0)
        pse = toWorld(corners.se[0], corners.se[1], 0)
        pnw = toWorld(corners.nw[0], corners.nw[1], 0)
      }
      const baseW = Math.max(psw.distanceTo(pse), 1)
      const baseD = Math.max(psw.distanceTo(pnw), 1)
      const baseCenter = toWorld(
        (corners.sw[0] + corners.se[0] + corners.ne[0] + corners.nw[0]) / 4,
        (corners.sw[1] + corners.se[1] + corners.ne[1] + corners.nw[1]) / 4,
        0
      )
      const yaw = Math.atan2(pse.x - psw.x, pse.z - psw.z)

      // yaw 让局部 +Z 对准贝方向(U)。BoxGeometry 的 x=排向、z=贝向，不能对调。
      const deck = makeUnlitBox(baseD + 0.4, 0.08, baseW + 0.4, palette.deck)
      deck.position.set(baseCenter.x, 0.08, baseCenter.z)
      deck.rotation.y = yaw
      mapGroup.add(deck)

      const maxFloor = Math.max(block.maxFloor || 4, 1)
      const stacks = block.stacks || []
      const occupied = {}

      for (let si = 1; si <= slots; si += 1) {
        for (let ri = 1; ri <= rows; ri += 1) {
          const u0 = (si - 1) / slots
          const u1 = si / slots
          const v0 = (ri - 1) / rows
          const v1 = ri / rows
          const w0 = cornerAt(corners, u0, v0)
          const w1 = cornerAt(corners, u1, v0)
          const w3 = cornerAt(corners, u0, v1)
          const center = cornerAt(corners, (u0 + u1) / 2, (v0 + v1) / 2)
          const cellU = Math.max(w0.distanceTo(w1), 0.6)
          const cellV = Math.max(w0.distanceTo(w3), 0.6)
          const cellYaw = Math.atan2(w1.x - w0.x, w1.z - w0.z)
          const plate = makeUnlitBox(cellV * 0.94, 0.05, cellU * 0.94, 0xffffff)
          plate.position.set(center.x, 0.14, center.z)
          plate.rotation.y = cellYaw
          mapGroup.add(plate)
        }
      }

      stacks.forEach(stack => {
        const ri = normalizeCellIndex(stack.rowIndex, rows)
        const forty = isFortyFoot(stack)
        const startSi = startCellIndex(stack, slots, forty)
        if (ri < 1 || startSi < 1) return
        const span = forty ? 2 : 1
        if (startSi + span - 1 > slots) return
        const key = `${startSi}-${ri}`
        if (occupied[key]) return
        occupied[key] = true
        if (span === 2) occupied[`${startSi + 1}-${ri}`] = true

        const u0 = (startSi - 1) / slots
        const u1 = (startSi + span - 1) / slots
        const v0 = (ri - 1) / rows
        const v1 = ri / rows
        const w0 = cornerAt(corners, u0, v0)
        const w1 = cornerAt(corners, u1, v0)
        const w3 = cornerAt(corners, u0, v1)
        const center = cornerAt(corners, (u0 + u1) / 2, (v0 + v1) / 2)
        const cellU = Math.max(w0.distanceTo(w1), 0.6)
        const cellV = Math.max(w0.distanceTo(w3), 0.6)
        const cellYaw = Math.atan2(w1.x - w0.x, w1.z - w0.z)
        const floors = Math.min(Math.max(Number(stack.floors) || 1, 1), maxFloor)
        const alongU = cellU * (span === 2 ? 0.96 : 0.92)
        const alongV = cellV * 0.86
        const layerH = CNTR_LAYER_H * 0.96
        const color = stackColor(stack)
        for (let floor = 0; floor < floors; floor += 1) {
          addIsoContainer(center, cellYaw, alongU, alongV, layerH, floor, forty, color.side)
        }
      })

      for (let i = 1; i <= slots; i += 1) {
        const slotNo = String(i * 2 - 1).padStart(2, '0')
        const mark = cornerAt(corners, (i - 0.5) / slots, -0.14)
        const spriteBay = makeTextSprite(slotNo, '#5b6570', { scaleX: 5.2, scaleY: 1.35, plate: false })
        if (spriteBay) {
          spriteBay.position.set(mark.x, 0.55, mark.z)
          mapGroup.add(spriteBay)
        }
      }

      const labelText = shortBlockLabel(block)
      const sprite = makeTextSprite(labelText, palette.label, { scaleX: 10, scaleY: 2.5 })
      if (sprite) {
        sprite.position.set(baseCenter.x, CNTR_LAYER_H * maxFloor + 3.2, baseCenter.z)
        mapGroup.add(sprite)
      }
  }

  /** 贝位号：奇数 01/03 是 20 尺小贝；偶数 02 是 01+03 合并的 40 尺大贝。 */
  function slotIndexOf(block, slot) {
    const hit = (block.stacks || []).find(item => String(item.slot) === String(slot))
    if (hit && hit.slotIndex) return Number(hit.slotIndex)
    const numeric = parseInt(String(slot), 10)
    if (!numeric) return -1
    const index = Math.floor((numeric + 1) / 2)
    return index >= 1 && index <= (block.slotCount || 0) ? index : -1
  }

  function isFortyFoot(stack) {
    const size = String((stack && stack.sizeCode) || '').toUpperCase()
    if (size.indexOf('40') >= 0) return true
    const n = parseInt(String(stack && stack.slot), 10)
    return Boolean(n && n % 2 === 0)
  }

  function normalizeCellIndex(value, count) {
    const n = Number(value)
    if (!count) return -1
    if (n === 0) return 1
    if (n >= 1 && n <= count) return n
    return -1
  }

  function startCellIndex(stack, slotCount, forty) {
    const n = parseInt(String(stack && stack.slot), 10)
    if (n) {
      const startBay = n % 2 === 0 ? n - 1 : n
      return Math.floor((startBay + 1) / 2)
    }
    const idx = normalizeCellIndex(stack && stack.slotIndex, slotCount)
    if (idx < 1) return -1
    return forty && idx > 1 ? idx - 1 : idx
  }

  function rebuildMapSync() {
    clearGroup(mapGroup)
    const map = state.map
    if (!map) return
    const bounds = yardBounds(map)
    if (!bounds) return
    setOriginFromBounds(bounds)
    buildPavement()
    buildRoads(map.roads)
    buildBlocksClean(map.blocks, state.targetBlockId, state.targetSlot)
    // 原点刚定下来，路线/车模必须按新原点重算，否则会飞到场外看不见
    rebuildRoute()
    rebuildDynamic()
    state.dirty = true
  }

  /** 异步分帧建图，避免进入导航页时主线程长时间阻塞导致白屏、按钮无响应。 */
  function rebuildMap() {
    state.mapBuildToken += 1
    const token = state.mapBuildToken
    state.mapBuilding = true
    const run = () => {
      if (token !== state.mapBuildToken) return
      try {
        rebuildMapSync()
      } catch (error) {
        console.error('[yardScene] rebuildMap failed', error)
      } finally {
        if (token === state.mapBuildToken) state.mapBuilding = false
      }
    }
    if (typeof wx !== 'undefined' && wx.nextTick) {
      wx.nextTick(run)
    } else {
      setTimeout(run, 0)
    }
  }

  function trimDestinationStub(points) {
    if (!points || points.length < 3) return points || []
    const a = points[points.length - 3]
    const b = points[points.length - 2]
    const c = points[points.length - 1]
    const ab = b.clone().sub(a)
    const bc = c.clone().sub(b)
    ab.y = 0
    bc.y = 0
    if (bc.length() < 20 && ab.length() > 0.8) {
      const cos = ab.normalize().dot(bc.normalize())
      if (cos < 0.4) return points.slice(0, -1)
    }
    return points
  }

  /** 丢掉「定位点连到路」的垂直短线，那一段不能当车头，也不能画进场区。 */
  function dropLeadStub(points) {
    if (!points || points.length < 3) return points || []
    const ab = points[1].clone().sub(points[0])
    const bc = points[2].clone().sub(points[1])
    ab.y = 0
    bc.y = 0
    if (ab.length() > 0.8 && bc.length() > 0.8 && ab.normalize().dot(bc.normalize()) < 0.5) {
      return points.slice(1)
    }
    return points
  }

  function pointInConvex(p, ring) {
    let sign = 0
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      const cross = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x)
      if (Math.abs(cross) < 1e-6) continue
      const s = cross > 0 ? 1 : -1
      if (!sign) sign = s
      else if (s !== sign) return false
    }
    return sign !== 0
  }

  function insetRing(ring, insetM) {
    const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length
    const cz = ring.reduce((s, p) => s + p.z, 0) / ring.length
    return ring.map(p => {
      const dx = p.x - cx
      const dz = p.z - cz
      const len = Math.hypot(dx, dz) || 1
      const t = Math.max(0, 1 - insetM / len)
      return new THREE.Vector3(cx + dx * t, p.y, cz + dz * t)
    })
  }

  function insideYardBlock(worldPos) {
    const blocks = (state.map && state.map.blocks) || []
    for (let i = 0; i < blocks.length; i += 1) {
      const polygon = blocks[i].polygon || []
      if (polygon.length < 4) continue
      const ring = polygon.map(pt => toWorld(pt.longitude, pt.latitude, 0))
      if (pointInConvex(worldPos, insetRing(ring, 2.2))) return true
    }
    return false
  }

  /** 蓝线只留马路上的点，掐掉穿进箱区的头尾。 */
  function keepOnRoads(points) {
    if (!points || points.length < 2) return points || []
    let start = 0
    let end = points.length
    while (start < end - 1 && insideYardBlock(points[start])) start += 1
    while (end > start + 1 && insideYardBlock(points[end - 1])) end -= 1
    return points.slice(start, end)
  }

  function buildRoundJoint(p, radius, color, y, group) {
    try {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, 0.08, 14),
        new THREE.MeshLambertMaterial({ color })
      )
      mesh.position.set(p.x, y, p.z)
      ;(group || mapGroup).add(mesh)
    } catch (error) {
      buildRoadJoint(p, radius * 2, color, y, group)
    }
  }

  function nearestRoadSnap(worldPos) {
    const roads = (state.map && state.map.roads) || []
    let best = null
    let bestDist = Infinity
    for (let r = 0; r < roads.length; r += 1) {
      const path = roads[r].path || []
      for (let i = 0; i < path.length - 1; i += 1) {
        const a = toWorld(path[i].longitude, path[i].latitude, 0)
        const b = toWorld(path[i + 1].longitude, path[i + 1].latitude, 0)
        const dx = b.x - a.x
        const dz = b.z - a.z
        const len2 = dx * dx + dz * dz
        const t = len2 < 1e-8 ? 0 : Math.max(0, Math.min(1, ((worldPos.x - a.x) * dx + (worldPos.z - a.z) * dz) / len2))
        const on = new THREE.Vector3(a.x + t * dx, 0, a.z + t * dz)
        const dist = Math.hypot(worldPos.x - on.x, worldPos.z - on.z)
        if (dist < bestDist) {
          bestDist = dist
          best = on
        }
      }
    }
    state.roadSnapM = Number.isFinite(bestDist) ? bestDist : null
    return best && bestDist < 48 ? { pos: best, dist: bestDist } : null
  }

  function selfOnRoadPos() {
    if (!state.self) return null
    const gps = toWorld(state.self.longitude, state.self.latitude, 0)
    const snap = nearestRoadSnap(gps)
    return snap ? snap.pos : gps
  }

  /** 在规划折线上找本车应接入的那一段（含绕场时 C 通道出现两次的情况）。 */
  function pickRouteProgress(points, selfPos) {
    const candidates = []
    let minDist = Infinity
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      const dx = b.x - a.x
      const dz = b.z - a.z
      const len2 = dx * dx + dz * dz
      const t = len2 < 1e-8 ? 0 : Math.max(0, Math.min(1, ((selfPos.x - a.x) * dx + (selfPos.z - a.z) * dz) / len2))
      const on = new THREE.Vector3(a.x + t * dx, a.y, a.z + t * dz)
      const dist = Math.hypot(selfPos.x - on.x, selfPos.z - on.z)
      const rest = remainingAfter(points, i, on)
      candidates.push({ index: i, on, dist, rest })
      if (dist < minDist) minDist = dist
    }
    if (!candidates.length) return null
    const close = candidates.filter(c => c.dist <= minDist + 18)
    let chosen = close.reduce((best, c) => (c.dist < best.dist ? c : best), close[0])
    const total = polylineLength(points)
    const rests = close.map(c => c.rest)
    const minR = Math.min(...rests)
    const maxR = Math.max(...rests)
    // 绕场一圈：离 01 贝很近时最近投影只剩 1m，但还要走东→南→北→东，应接剩余更长的那段
    if (total > 350 && maxR - minR > 120 && chosen.rest < 120) {
      const wide = candidates.filter(c => c.dist <= Math.max(55, minDist + 22))
      const alt = wide.reduce((best, c) => (c.rest > best.rest ? c : best), chosen)
      if (alt.rest > chosen.rest + 200) chosen = alt
    }
    return chosen
  }

  /**
   * 剩余蓝线：从集卡贴路位置接入规划折线，画到终点（完整东→南→北→东，不是直线到贝位）。
   */
  function clipWorldRouteToSelf(points) {
    if (!points || points.length < 2 || !state.self) return points
    const truck = selfOnRoadPos() || toWorld(state.self.longitude, state.self.latitude, 0)
    const chosen = pickRouteProgress(points, truck)
    if (!chosen) return points
    const out = [truck.clone()]
    if (truck.distanceTo(chosen.on) > 0.8) out.push(chosen.on.clone())
    for (let i = chosen.index + 1; i < points.length; i += 1) {
      if (out[out.length - 1].distanceTo(points[i]) > 0.8) out.push(points[i].clone())
    }
    return out.length >= 2 ? out : points
  }

  function rebuildRoute() {
    clearGroup(routeGroup)
    state.routeEnd = null
    state.routeLine = null
    const route = state.route || []
    if (route.length < 2) return
    try {
      const raw = []
      for (let i = 0; i < route.length; i += 1) {
        raw.push(toWorld(route[i].longitude, route[i].latitude, 0.86))
      }
      const dedup = [raw[0]]
      for (let i = 1; i < raw.length; i += 1) {
        if (dedup[dedup.length - 1].distanceTo(raw[i]) > 0.8) dedup.push(raw[i])
      }
      if (dedup.length < 2) return
      const onRoad = keepOnRoads(dropLeadStub(simplifyRoutePoints(trimDestinationStub(dedup))))
      const clipped = clipWorldRouteToSelf(onRoad.length >= 2 ? onRoad : dedup)
      const offset = offsetPolylineRight(clipped, (idx, point) => {
        if (idx === 0) return 0
        const prev = clipped[Math.max(0, idx - 1)]
        const next = clipped[Math.min(clipped.length - 1, idx + 1)]
        const a = isOneWayNear(prev)
        const b = isOneWayNear(point)
        const c = isOneWayNear(next)
        if (a === b && b === c) return b ? 0 : 2.3
        return 0
      })
      const smoothed = filletPolyline(offset, 5.5)
      const blueW = 0.95
      const routeY = 0.52
      buildRouteRibbon(smoothed, blueW, routeY, 0x1d6fe8, routeGroup)
      state.routeEnd = smoothed[smoothed.length - 1]
      state.routeLine = smoothed
      const total = smoothed.reduce((sum, p, idx) => (
        idx === 0 ? 0 : sum + smoothed[idx - 1].distanceTo(p)
      ), 0)
      const arrowCount = Math.min(18, Math.max(4, Math.floor(total / 16)))
      const arrowY = routeY + blueW * 0.5 + 0.018
      for (let i = 1; i <= arrowCount; i += 1) {
        const want = (total * i) / (arrowCount + 1)
        let acc = 0
        for (let k = 0; k < smoothed.length - 1; k += 1) {
          const seg = smoothed[k].distanceTo(smoothed[k + 1])
          if (acc + seg >= want || k === smoothed.length - 2) {
            const t = seg < 0.01 ? 0 : (want - acc) / seg
            const p = smoothed[k].clone().lerp(smoothed[k + 1], Math.max(0, Math.min(1, t)))
            const tangent = smoothed[k + 1].clone().sub(smoothed[k])
            addRouteArrow(p, tangent, arrowY, routeGroup)
            break
          }
          acc += seg
        }
      }
    } catch (error) {
      console.error('[yardScene] rebuildRoute failed', error)
    }
    state.dirty = true
  }

  function buildSelfTruck(origin, yaw) {
    const truck = vehicleLoader.instantiate(THREE, vehicleLoader.getTruckParts())
    truck.traverse(child => {
      child.frustumCulled = false
      if (child.isMesh) child.renderOrder = 6
    })
    truck.position.set(origin.x, 0.26, origin.z)
    truck.rotation.y = yaw
    return truck
  }

  function buildStacker(origin, yaw) {
    const model = vehicleLoader.instantiate(THREE, vehicleLoader.getStackerParts())
    model.position.set(origin.x, 0, origin.z)
    model.rotation.y = -yaw
    return model
  }

  function destPoint() {
    if (state.target && state.target.longitude != null && state.target.latitude != null) {
      return toWorld(state.target.longitude, state.target.latitude, 0)
    }
    if (state.routeEnd) return state.routeEnd.clone()
    return null
  }

  /** 堆高机朝向用进终点的最后一段路，不跟本车车头转。 */
  function lastRouteApproach() {
    const raw = routeWorldPoints()
    const line = raw.length >= 2
      ? keepOnRoads(dropLeadStub(raw))
      : (state.routeLine || [])
    if (!line || line.length < 2) return new THREE.Vector3(1, 0, 0)
    const a = line[line.length - 2]
    const b = line[line.length - 1]
    const t = new THREE.Vector3(b.x - a.x, 0, b.z - a.z)
    if (t.length() < 0.01) return new THREE.Vector3(1, 0, 0)
    return t.normalize()
  }

  function routeWorldPoints() {
    const route = state.route || []
    const points = []
    for (let i = 0; i < route.length; i += 1) {
      if (route[i] && route[i].longitude != null) {
        points.push(toWorld(route[i].longitude, route[i].latitude, 0))
      }
    }
    return points
  }

  function projectOnRoute(worldPos, points) {
    let bestOn = points[0]
    let bestDist = Infinity
    let bestTan = new THREE.Vector3(0, 0, -1)
    let bestIndex = 0
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      const dx = b.x - a.x
      const dz = b.z - a.z
      const len2 = dx * dx + dz * dz
      const t = len2 < 1e-8 ? 0 : Math.max(0, Math.min(1, ((worldPos.x - a.x) * dx + (worldPos.z - a.z) * dz) / len2))
      const onx = a.x + t * dx
      const onz = a.z + t * dz
      const dist = Math.hypot(worldPos.x - onx, worldPos.z - onz)
      if (dist < bestDist) {
        bestDist = dist
        bestIndex = i
        bestOn = new THREE.Vector3(onx, 0, onz)
        const len = Math.hypot(dx, dz) || 1
        bestTan = new THREE.Vector3(dx / len, 0, dz / len)
      }
    }
    return { pos: bestOn, tangent: bestTan, dist: bestDist, index: bestIndex }
  }

  /** 沿剩余蓝线往前看一段，车头只跟折线箭头，不瞄目的地直线方位。 */
  function remainingForward(points, fromPos) {
    const snap = projectOnRoute(fromPos, points)
    const want = 16
    let acc = 0
    let cursor = snap.pos.clone()
    let ahead = null
    for (let i = snap.index; i < points.length - 1; i += 1) {
      const dest = points[i + 1]
      const seg = dest.clone().sub(cursor)
      seg.y = 0
      const len = seg.length()
      if (len < 0.05) continue
      if (acc + len >= want) {
        const t = (want - acc) / len
        ahead = cursor.clone().add(seg.multiplyScalar(t))
        break
      }
      acc += len
      cursor = dest
    }
    if (!ahead) ahead = cursor
    let forward = new THREE.Vector3(ahead.x - snap.pos.x, 0, ahead.z - snap.pos.z)
    if (forward.length() < 0.3) forward = snap.tangent.clone()
    if (forward.length() < 0.001) return snap.tangent.clone()
    return forward.normalize()
  }

  function yawForTruck(forward) {
    // 模型车头在局部 -Z，蓝线箭头沿 +Z；车头要比箭头再转 180° 才同向
    return Math.atan2(-forward.x, -forward.z)
  }

  function liveHeadingDeg() {
    const sensor = headingSensor.get()
    if (sensor != null && !Number.isNaN(Number(sensor))) return Number(sensor)
    if (state.self && state.self.heading != null && !Number.isNaN(Number(state.self.heading))) {
      return Number(state.self.heading)
    }
    return 0
  }

  function selfDisplayPose() {
    const gps = toWorld(state.self.longitude, state.self.latitude, 0)
    const headingDeg = liveHeadingDeg()
    const heading = (headingDeg * Math.PI) / 180
    const yaw = yawForTruck(new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading)))
    const snap = nearestRoadSnap(gps)
    if (snap) return { pos: snap.pos.clone(), yaw }
    return { pos: gps, yaw }
  }

  function ensureSelfTruck() {
    if (selfTruck) return selfTruck
    selfTruck = buildSelfTruck(new THREE.Vector3(0, 0, 0), 0)
    selfTruck.visible = false
    root.add(selfTruck)
    return selfTruck
  }

  const poseSmooth = { x: null, z: null, yaw: null, at: 0 }

  function applySelfPose() {
    if (!state.self) {
      if (selfTruck) selfTruck.visible = false
      poseSmooth.x = null
      return
    }
    const headingDeg = liveHeadingDeg()
    state.self.heading = headingDeg
    const pose = selfDisplayPose()
    const truck = ensureSelfTruck()
    truck.visible = true
    const now = Date.now()
    const dt = poseSmooth.at ? Math.min(0.08, (now - poseSmooth.at) / 1000) : 0.016
    poseSmooth.at = now
    if (poseSmooth.yaw == null) {
      poseSmooth.x = pose.pos.x
      poseSmooth.z = pose.pos.z
      poseSmooth.yaw = pose.yaw
    } else {
      let dyaw = pose.yaw - poseSmooth.yaw
      while (dyaw > Math.PI) dyaw -= Math.PI * 2
      while (dyaw < -Math.PI) dyaw += Math.PI * 2
      const maxTurn = Math.PI * 2.4 * dt
      if (Math.abs(dyaw) > maxTurn) dyaw = (dyaw > 0 ? 1 : -1) * maxTurn
      poseSmooth.yaw += dyaw * (Math.abs(dyaw) > 0.2 ? 0.48 : 0.22)
      const pdx = pose.pos.x - poseSmooth.x
      const pdz = pose.pos.z - poseSmooth.z
      const pdist = Math.hypot(pdx, pdz)
      const pt = pdist > 20 ? 0.55 : 0.18
      poseSmooth.x += pdx * pt
      poseSmooth.z += pdz * pt
    }
    truck.position.set(poseSmooth.x, 0.26, poseSmooth.z)
    truck.rotation.y = poseSmooth.yaw
  }

  function rebuildDynamic() {
    clearGroup(dynamicGroup)
    const dest = destPoint()
    if (dest) {
      const pin = new THREE.Group()
      const tail = new THREE.Mesh(
        new THREE.ConeGeometry(0.78, 2.5, 20),
        new THREE.MeshLambertMaterial({ color: 0x16a34a })
      )
      tail.position.y = 1.35
      tail.rotation.x = Math.PI
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.95, 20, 16),
        new THREE.MeshLambertMaterial({ color: 0x16a34a })
      )
      head.position.y = 2.85
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.38, 14, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      )
      dot.position.y = 2.85
      pin.add(tail)
      pin.add(head)
      pin.add(dot)
      pin.position.set(dest.x, 0, dest.z)
      pin.userData.scaleWithView = true
      pin.userData.baseScale = { x: 1, y: 1, z: 1 }
      dynamicGroup.add(pin)
      if (state.targetLabel) {
        const tag = makeTextSprite(state.targetLabel, '#166534', { scaleX: 12, scaleY: 3 })
        if (tag) {
          tag.position.set(dest.x, 5.2, dest.z)
          dynamicGroup.add(tag)
        }
      }
      if (state.purpose === 'safety' || /出场|出口|EXIT|安全操作区|验箱|S-02/i.test(state.targetLabel || '')) {
        const inspect = state.purpose === 'safety' || /安全操作区|验箱|S-02/i.test(state.targetLabel || '')
        const pad = makeUnlitBox(inspect ? 32 : 16, 0.14, inspect ? 24 : 12, inspect ? 0x86efac : 0x4ade80)
        pad.position.set(dest.x, 0.3, dest.z)
        dynamicGroup.add(pad)
        if (inspect) {
          ;[-1, 0, 1].forEach(i => {
            const bay = makeUnlitBox(3.4, 0.05, 16, 0xbbf7d0)
            bay.position.set(dest.x + i * 6.2, 0.36, dest.z)
            dynamicGroup.add(bay)
          })
          const tag = makeTextSprite('验箱区 S-02', '#166534', { scaleX: 16, scaleY: 3.2 })
          if (tag) {
            tag.position.set(dest.x, 6.2, dest.z)
            dynamicGroup.add(tag)
          }
        }
      }
    }
    if (state.self && state.purpose === 'job' && destPoint()) {
      const dest = destPoint()
      const tan = lastRouteApproach()
      const side = new THREE.Vector3(-tan.z, 0, tan.x).multiplyScalar(7.5)
      const yaw = yawForTruck(new THREE.Vector3(-tan.x, 0, -tan.z))
      const stacker = buildStacker(
        { x: dest.x + side.x, y: 0, z: dest.z + side.z },
        yaw
      )
      if (stacker) dynamicGroup.add(stacker)
    }
    applySelfPose()
    state.dirty = true
  }

  function computeAutoView() {
    const bounds = state.map ? yardBounds(state.map) : null
    const base = state.userView || state.view
    const currentPitch = base.pitch != null ? base.pitch : DEFAULT_PITCH
    const currentBearing = base.bearing != null ? base.bearing : 0
    if (!bounds) {
      return {
        centerLng: state.view.centerLng,
        centerLat: state.view.centerLat,
        distance: state.view.distance,
        pitch: currentPitch,
        bearing: currentBearing
      }
    }
    const self = state.self
    // TEST 演示场已按真机定位对齐，只留 40m 余量消化普通 GPS 抖动
    const off = distanceToBounds(bounds, self, 40)
    state.offYardMeters = off
    const framed = off !== null && off <= 400
      ? boundsOf([
        { longitude: bounds.minLng, latitude: bounds.minLat },
        { longitude: bounds.maxLng, latitude: bounds.maxLat },
        self
      ])
      : bounds
    const centerLng = (framed.minLng + framed.maxLng) / 2
    const centerLat = (framed.minLat + framed.maxLat) / 2
    const mLon = metersPerDegLon(centerLat)
    const spanX = Math.max((framed.maxLng - framed.minLng) * mLon, 60)
    const spanY = Math.max((framed.maxLat - framed.minLat) * M_PER_DEG_LAT, 60)
    const span = Math.max(spanX, spanY)
    const fitDistance = Math.max(80, Math.min(MAX_DISTANCE, span * 1.35))
    state.fitDistance = fitDistance

    const inYard = off !== null && off <= 80
    if (state.followMode && !state.userView && inYard && self) {
      let centerLng = self.longitude
      let centerLat = self.latitude
      if (poseSmooth.x != null && poseSmooth.z != null) {
        const geo = fromWorld(poseSmooth.x, poseSmooth.z)
        centerLng = geo.longitude
        centerLat = geo.latitude
      }
      return {
        centerLng,
        centerLat,
        distance: 110,
        pitch: currentPitch,
        bearing: currentBearing
      }
    }
    return { centerLng, centerLat, distance: fitDistance, pitch: currentPitch, bearing: currentBearing }
  }

  function applyCamera() {
    const view = state.userView || computeAutoView()
    if (view.pitch == null) view.pitch = DEFAULT_PITCH
    if (view.bearing == null) view.bearing = 0
    state.view = view
    const target = toWorld(view.centerLng, view.centerLat, 0)
    const dist = view.distance
    const pitch = clampPitch(view.pitch)
    let bearing = view.bearing
    if (state.headingUp) {
      bearing = -liveHeadingDeg() * Math.PI / 180
      view.bearing = bearing
      if (state.userView) state.userView.bearing = bearing
      state.view.bearing = bearing
    }
    const horizontal = dist * Math.cos(pitch)
    const vertical = dist * Math.sin(pitch)
    // bearing=0：相机在目标南侧；正值绕竖直轴逆时针转到东侧
    camera.position.set(
      target.x + horizontal * Math.sin(bearing),
      vertical,
      target.z + horizontal * Math.cos(bearing)
    )
    // 接近正俯视时默认 up=(0,1,0) 会和视线平行，lookAt 会把左右翻掉；
    // 掺一点地面朝前，保证拧北之后相机左右轴仍和滑动一致。
    camera.up.set(-Math.sin(bearing), 1, -Math.cos(bearing))
    camera.up.normalize()
    camera.lookAt(target.x, 0, target.z)
    camera.updateProjectionMatrix()
  }

  function applyOverlayScale() {
    const dist = ((state.userView || state.view) || {}).distance || 95
    const k = Number.isFinite(dist) ? Math.max(0.5, Math.min(2.1, dist / 110)) : 1
    const apply = obj => {
      if (obj.userData && obj.userData.scaleWithView && obj.userData.baseScale) {
        const s = obj.userData.baseScale
        obj.scale.set(s.x * k, s.y * k, s.z * k)
      }
      if (obj.children) obj.children.forEach(apply)
    }
    apply(mapGroup)
    apply(dynamicGroup)
  }

  function renderFrame() {
    if (!state.running) return
    applySelfPose()
    applyCamera()
    applyOverlayScale()
    renderer.render(scene, camera)
    state.dirty = false
  }

  function loop() {
    if (!state.running) return
    canvas.requestAnimationFrame(loop)
    if (state.dirty || state.mapBuilding || state.followMode || state.self) {
      renderFrame()
    }
  }
  canvas.requestAnimationFrame(loop)

  function setMap(map) {
    state.map = map
    rebuildMap()
    rebuildRoute()
    rebuildDynamic()
  }

  function setRoute(route) {
    state.route = route || []
    rebuildRoute()
  }

  function setTarget(target, label, targetBlockId, targetSlot) {
    const sameTarget = state.target && target
      && Number(state.target.longitude) === Number(target.longitude)
      && Number(state.target.latitude) === Number(target.latitude)
      && state.targetLabel === (label || '')
      && state.targetBlockId === targetBlockId
      && state.targetSlot === targetSlot
    const blockChanged = targetBlockId !== state.targetBlockId || targetSlot !== state.targetSlot
    state.target = target
    state.targetLabel = label || ''
    if (blockChanged) {
      state.targetBlockId = targetBlockId
      state.targetSlot = targetSlot
      rebuildMap()
    }
    if (!sameTarget) rebuildDynamic()
    else applySelfPose()
  }

  function setSelf(self) {
    // 视觉平滑：小幅度抖动不瞬移车模
    let moved = !state.self
    if (state.self && self) {
      const prev = state.self
      const mLon = metersPerDegLon(self.latitude || prev.latitude || 0)
      const dx = ((self.longitude || 0) - (prev.longitude || 0)) * mLon
      const dy = ((self.latitude || 0) - (prev.latitude || 0)) * M_PER_DEG_LAT
      const dist = Math.hypot(dx, dy)
      moved = dist > 10
      const alpha = dist > 12 ? 0.85 : dist > 4 ? 0.55 : 0.28
      state.self = {
        longitude: prev.longitude + ((self.longitude || prev.longitude) - prev.longitude) * alpha,
        latitude: prev.latitude + ((self.latitude || prev.latitude) - prev.latitude) * alpha,
        heading: self.heading != null && !Number.isNaN(Number(self.heading))
          ? Number(self.heading)
          : (prev.heading != null ? prev.heading : 0),
        headingFrom: self.headingFrom,
        accuracy: self.accuracy,
        speed: self.speed
      }
    } else {
      state.self = self
    }
    if (state.demoContainer && !state.demoContainerAnchor && state.self) {
      state.demoContainerAnchor = {
        longitude: state.self.longitude,
        latitude: state.self.latitude,
        heading: state.self.heading || 0
      }
      rebuildDynamic()
    }
    if ((state.route || []).length >= 2) rebuildRoute()
    applySelfPose()
    state.dirty = true
  }

  function setHeading(deg) {
    if (!state.self) return
    const value = Number(deg)
    if (Number.isNaN(value)) return
    state.self.heading = value
    applySelfPose()
    state.dirty = true
  }

  function setDemoContainer(enabled) {
    state.demoContainer = Boolean(enabled)
    if (!state.demoContainer) state.demoContainerAnchor = null
    rebuildDynamic()
  }

  function setFollowMode(followMode) {
    state.followMode = Boolean(followMode)
    state.dirty = true
  }

  /** 主动回到跟车：清掉手动视角。 */
  function enableFollow() {
    state.followMode = true
    state.headingUp = false
    state.userView = null
    state.view.pitch = DEFAULT_PITCH
    state.dirty = true
  }

  function setUserView(view) {
    state.userView = view
    // 手势拖动后退出跟车，否则下一帧自动跟车会把视角拽回去
    state.followMode = false
    state.dirty = true
  }

  function currentPitch(view) {
    return clampPitch(view && view.pitch != null ? view.pitch : DEFAULT_PITCH)
  }

  function currentBearing(view) {
    return view && view.bearing != null ? view.bearing : 0
  }

  function snapshotView(view, patch) {
    return Object.assign({
      centerLng: view.centerLng,
      centerLat: view.centerLat,
      distance: view.distance,
      pitch: currentPitch(view),
      bearing: currentBearing(view)
    }, patch || {})
  }

  function pan(dxPx, dyPx) {
    const view = state.userView || state.view
    const pitch = currentPitch(view)
    const metersPerPx = (view.distance * 0.0018) + 0.08
    const mLon = metersPerDegLon(view.centerLat)
    applyCamera()
    const target = toWorld(view.centerLng, view.centerLat, 0)
    // 直接用当前相机在地面上的右/前，避免拧北后滑动还按「北朝上」换算
    const look = new THREE.Vector3(target.x - camera.position.x, 0, target.z - camera.position.z)
    let right
    if (look.lengthSq() < 0.0001) {
      const bearing = currentBearing(view)
      look.set(-Math.sin(bearing), 0, -Math.cos(bearing))
      right = new THREE.Vector3(Math.cos(bearing), 0, -Math.sin(bearing))
    } else {
      look.normalize()
      right = new THREE.Vector3().crossVectors(look, new THREE.Vector3(0, 1, 0)).normalize()
    }
    // 抓住地图：手指右滑，图往右走 → 视点沿屏幕左移
    const moveX = (-dxPx * right.x + dyPx * look.x) * metersPerPx
    const moveZ = (-dxPx * right.z + dyPx * look.z) * metersPerPx
    const next = snapshotView(view, {
      centerLng: view.centerLng + moveX / mLon,
      centerLat: view.centerLat - moveZ / M_PER_DEG_LAT,
      pitch
    })
    setUserView(next)
    return next
  }

  function zoom(factor) {
    const view = state.userView || state.view
    const distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, view.distance / factor))
    const next = snapshotView(view, { distance })
    setUserView(next)
    return next
  }

  /**
   * 高德式倾斜：双指同向上/下滑。
   * deltaY > 0（手指下移）→ 更侧视（俯仰变小）；上移 → 更俯视。
   */
  function tilt(deltaYPx) {
    if (!deltaYPx) return state.userView || state.view
    const view = state.userView || state.view
    const pitch = clampPitch(currentPitch(view) - deltaYPx * (Math.PI / 180) * 0.32)
    const next = snapshotView(view, { pitch })
    setUserView(next)
    return next
  }

  /**
   * 高德式拧地图：双指旋转。
   * deltaAngle 为两指连线角度变化（弧度，屏幕坐标）；手指顺时针拧 → 地图顺时针转。
   */
  function rotate(deltaAngle) {
    if (!deltaAngle) return state.userView || state.view
    const view = state.userView || state.view
    let bearing = currentBearing(view) - deltaAngle
    // 归一化到 (-π, π]
    bearing = ((bearing + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI
    const next = snapshotView(view, { bearing })
    state.headingUp = false
    setUserView(next)
    return next
  }

  /** 一键切到接近正俯视（2D）或默认 3D 斜视；不退出跟车/朝向跟随 */
  function setFlatMode(flat) {
    const view = state.userView || state.view || computeAutoView()
    const pitch = flat ? FLAT_PITCH : DEFAULT_PITCH
    if (state.userView) {
      state.userView = snapshotView(state.userView, { pitch })
    } else {
      state.view = snapshotView(view, { pitch })
    }
    state.dirty = true
    return state.userView || state.view
  }

  function isFlatMode() {
    return currentPitch(state.userView || state.view) >= (FLAT_PITCH - 4 * Math.PI / 180)
  }

  function resetView() {
    state.userView = null
    state.headingUp = false
    state.view.pitch = DEFAULT_PITCH
    state.dirty = true
  }

  function locateSelf() {
    if (!state.self) return null
    const view = state.userView || state.view
    const next = snapshotView(view, {
      centerLng: state.self.longitude,
      centerLat: state.self.latitude,
      distance: Math.min(view.distance || 120, 120)
    })
    setUserView(next)
    return next
  }

  function resize(nextWidth, nextHeight, nextDpr) {
    state.width = nextWidth
    state.height = nextHeight
    camera.aspect = nextWidth / nextHeight
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(nextDpr || 2)
    renderer.setSize(nextWidth, nextHeight, false)
    state.dirty = true
  }

  function getStatus() {
    computeAutoView()
    const view = state.userView || state.view
    const bearing = currentBearing(view)
    return {
      view: state.view,
      offYardMeters: state.offYardMeters,
      fitDistance: state.fitDistance,
      viewAdjusted: Boolean(state.userView),
      flatMode: isFlatMode(),
      pitchDeg: Math.round(currentPitch(view) * 180 / Math.PI),
      bearingDeg: Math.round(bearing * 180 / Math.PI),
      mapBuilding: state.mapBuilding,
      roadSnapM: state.roadSnapM
    }
  }

  function dispose() {
    state.running = false
    if (selfTruck) {
      root.remove(selfTruck)
      disposeObject(selfTruck)
      selfTruck = null
    }
    clearGroup(mapGroup)
    clearGroup(routeGroup)
    clearGroup(dynamicGroup)
    disposeObject(ground)
    renderer.dispose()
  }

  return {
    setMap,
    setRoute,
    setTarget,
    setSelf,
    setHeading,
    setDemoContainer,
    setFollowMode,
    setPurpose(purpose) {
      state.purpose = purpose || 'job'
      rebuildDynamic()
    },
    enableFollow,
    setUserView,
    pan,
    zoom,
    tilt,
    rotate,
    setFlatMode,
    isFlatMode,
    resetView,
    locateSelf,
    resize,
    getStatus,
    getPaintedRoute() {
      return state.routeLine && state.routeLine.length >= 2 ? state.routeLine : null
    },
    renderFrame,
    dispose,
    MAX_SCALE: MAX_DISTANCE
  }
}

module.exports = {
  createYardScene,
  nearestRoad(roads, self) {
    if (!self || !roads || !roads.length) return null
    const mLon = metersPerDegLon(self.latitude)
    let best = null
    let bestDistance = Infinity
    roads.forEach(road => {
      (road.path || []).forEach(point => {
        const dx = (point.longitude - self.longitude) * mLon
        const dy = (point.latitude - self.latitude) * M_PER_DEG_LAT
        const distance = Math.hypot(dx, dy)
        if (distance < bestDistance) {
          bestDistance = distance
          best = road
        }
      })
    })
    return bestDistance <= 60 ? best : null
  }
}
