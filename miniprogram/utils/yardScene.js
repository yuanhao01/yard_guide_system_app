/**
 * 堆场真三维场景（Three.js / WebGL）。
 *
 * 不用 canvas 2d 假倾斜。相机是透视投影，箱垛是真实 Box 网格，
 * 观感对齐高德地图那种挤出建筑：能看见侧面、有透视远近、能俯仰缩放。
 *
 * 坐标系：接口下发的 {x, y} 就是场图绘制米制坐标（X 东增、Y 南增），
 * 与场图编辑器 position.set(startX, 0, startY) 完全一致，1 单位 = 1 米。
 * 世界坐标直接取 (x, 高度, y)，不做任何经纬度投影——经纬度只在后端按
 * 堆场三点定标换算，司机端不参与。
 */
const { createScopedThreejs } = require('../libs/threejs/index.js')
const vehicleLoader = require('./vehicleLoader')
const headingSensor = require('./heading')

const STACK_HEIGHT = 7.8
/** 单层集装箱高度（米），箱垛高度按堆放层数叠出来。 */
const CNTR_LAYER_H = 2.75
/** 俯仰角：相对水平面抬起的角度。越大越接近正俯视，越小越接近侧视（像高德 3D）。 */
const MIN_PITCH = 18 * Math.PI / 180
const MAX_PITCH = 88 * Math.PI / 180
const FLAT_PITCH = 86 * Math.PI / 180
/** 默认接近正俯视，便于辨认场区/道路/空地；导航页可切 3D */
const DEFAULT_PITCH = FLAT_PITCH
const MIN_DISTANCE = 40
const MAX_DISTANCE = 900

function clampPitch(pitch) {
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch))
}

/** 接口点 → 场图米制 {x, y}，缺 x/y 的点一律丢弃，不再拿经纬度顶替。 */
function xyOf(point) {
  if (!point) return null
  const x = Number(point.x)
  const y = Number(point.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function boundsOf(points) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  points.forEach(p => {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  })
  return { minX, maxX, minY, maxY }
}

function yardBounds(map) {
  const points = []
  const push = p => {
    const xy = xyOf(p)
    if (xy) points.push(xy)
  }
  ;(map.blocks || []).forEach(b => (b.polygon || []).forEach(push))
  ;(map.roads || []).forEach(r => (r.path || []).forEach(push))
  return points.length ? boundsOf(points) : null
}

/**
 * 到场区包围盒边缘的距离（米）。padMeters 把判定范围外扩，
 * 演示场几何比真实小区小一圈时，避免站在 C 座仍被报「场外两百米」。
 */
function distanceToBounds(bounds, self, padMeters) {
  if (!bounds || !self) return null
  const pad = padMeters || 0
  const dx = Math.max((bounds.minX - pad) - self.x, 0, self.x - (bounds.maxX + pad))
  const dy = Math.max((bounds.minY - pad) - self.y, 0, self.y - (bounds.maxY + pad))
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
  // 贴图按 sRGB 采样后必须在输出端转回去，否则烘焙贴图整体发灰发暗
  if (THREE.sRGBEncoding != null) renderer.outputEncoding = THREE.sRGBEncoding

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0xe4e9ef, 620, 1700)

  const camera = new THREE.PerspectiveCamera(48, width / height, 0.2, 4000)

  // 环境光压低、主光提高：明暗对比拉开，模型才有体积感
  const hemi = new THREE.HemisphereLight(0xdfe8f2, 0x9aa3ad, 0.72)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xfff2df, 0.95)
  sun.position.set(140, 240, 90)
  scene.add(sun)
  // 逆光补一盏弱光，避免背面死黑
  const fill = new THREE.DirectionalLight(0xcfe0f5, 0.38)
  fill.position.set(-120, 90, -140)
  scene.add(fill)

  /** 传给 vehicleLoader：无 IBL 户外场景，玻璃不透明、双面渲染，避免集卡/箱发黑镂空 */
  const materialOpts = { canvas, outdoor: true, forceDoubleSide: true, opaqueGlass: true }

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
  // 道口属静态场景，但 GLB 晚于建图就绪，留个引用便于就绪后单独补挂
  let crossing = null

  const state = {
    width,
    height,
    map: null,
    // 场区包围盒，建图时算出，道口等按场区边缘定位的物体要用
    bounds: null,
    route: [],
    target: null,
    targetLabel: '',
    targetBlockId: null,
    targetSlot: null,
    self: null,
    followMode: true,
    userView: null,
    // lookAt 用场图米制 (x, y)；distance 相机距离；pitch 俯仰；bearing 方位（弧度，0=从南望北）
    view: { centerX: 0, centerY: 0, distance: 220, pitch: DEFAULT_PITCH, bearing: 0 },
    fitDistance: 220,
    offYardMeters: null,
    dirty: true,
    running: true,
    mapBuilding: false,
    mapBuildToken: 0,
    demoContainer: false,
    demoContainerAnchor: null,
    routeEnd: null,
    routeLine: null,
    /** 出场道口固定锚点（导航配置 entry 的场图坐标），与当前任务终点无关 */
    gateAnchor: null,
    purpose: 'job',
    // 北朝上。车头跟手机转，和右上角高德小人一致；拧地图才改 bearing
    headingUp: false,
    vehicleParts: {},
    containerTemplates: {
      c20: vehicleLoader.createTemplate(THREE, vehicleLoader.getContainerParts(20)),
      c40: vehicleLoader.createTemplate(THREE, vehicleLoader.getContainerParts(40))
    }
  }

  /** 场图米制点 → 世界坐标。场图 Y 南增，世界 Z 也朝南，直接同号。 */
  function toWorld(point, height) {
    const xy = xyOf(point)
    if (!xy) return new THREE.Vector3(0, height || 0, 0)
    return new THREE.Vector3(xy.x, height || 0, xy.y)
  }

  function fromWorld(x, z) {
    return { x, y: z }
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
      // 场图维护的真实路宽；旧数据没有时才按限速粗估
      const widthM = Number(road.widthM) > 0
        ? Number(road.widthM)
        : (Number(road.speedLimitKmh) >= 15 ? 9 : 6.5)
      const dir = Number(road.directionType)
      const twoWay = !(dir === 1 || dir === 2)
      const points = []
      for (let i = 0; i < path.length; i += 1) {
        points.push(toWorld(path[i], 0))
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

  /* 船公司常见箱色。这是当作固有色用的，亮度得比 UI 取色高一档：
     打光衰减后还要再暗一截，背光面尤其明显，
     照搬 Tailwind 那套深色系会整片糊成黑的。 */
  const CNTR_COLORS = [
    0x2f6fb5, 0xc0392b, 0xe9e9e4, 0xd9772b,
    0x2f7d55, 0x1a8fa8, 0x8c95a0, 0xb8873a
  ]

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
      ctx.font = option.font || 'bold 22px sans-serif'
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
      if (!option.fixed) {
        sprite.userData.scaleWithView = true
        sprite.userData.baseScale = { x: sx, y: sy, z: 1 }
      }
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
      // 只走劣弧。旧逻辑按转向符号硬加 2π，90° 右转会被画成 270° 绕到黄虚线外侧。
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
  function unitXZ(from, to) {
    const v = new THREE.Vector3(to.x - from.x, 0, to.z - from.z)
    if (v.length() < 1e-4) return null
    return v.normalize()
  }

  function rightOf(tan) {
    return new THREE.Vector3(-tan.z, 0, tan.x)
  }

  /** 两段偏右车道的交点，直角弯会落在「进段右侧 ∩ 出段右侧」，不会收到路心黄线上。 */
  function miterLanePoint(pivot, inTan, inOff, outTan, outOff) {
    const inR = rightOf(inTan)
    const outR = rightOf(outTan)
    const ax = pivot.x + inR.x * inOff
    const az = pivot.z + inR.z * inOff
    const bx = pivot.x + outR.x * outOff
    const bz = pivot.z + outR.z * outOff
    const cross = inTan.x * outTan.z - inTan.z * outTan.x
    if (Math.abs(cross) < 0.08) {
      const off = Math.abs(outOff) >= Math.abs(inOff) ? outOff : inOff
      const r = Math.abs(outOff) >= Math.abs(inOff) ? outR : inR
      return new THREE.Vector3(pivot.x + r.x * off, pivot.y, pivot.z + r.z * off)
    }
    const t = ((bx - ax) * outTan.z - (bz - az) * outTan.x) / cross
    const miterX = ax + inTan.x * t
    const miterZ = az + inTan.z * t
    const maxMiter = Math.max(inOff, outOff, 0) * 2.4 + 1
    if (Math.hypot(miterX - pivot.x, miterZ - pivot.z) > maxMiter) {
      return new THREE.Vector3(
        pivot.x + inR.x * inOff + outR.x * outOff,
        pivot.y,
        pivot.z + inR.z * inOff + outR.z * outOff
      )
    }
    return new THREE.Vector3(miterX, pivot.y, miterZ)
  }

  function offsetPolylineRight(points, offsetM) {
    if (!points || points.length < 2 || !offsetM) return points || []
    const n = points.length
    const segOff = []
    for (let i = 0; i < n - 1; i += 1) {
      const mid = new THREE.Vector3(
        (points[i].x + points[i + 1].x) * 0.5,
        0,
        (points[i].z + points[i + 1].z) * 0.5
      )
      const off = typeof offsetM === 'function' ? Number(offsetM(i, mid)) || 0 : Number(offsetM) || 0
      segOff.push(off)
    }
    const out = []
    for (let i = 0; i < n; i += 1) {
      const inTan = i > 0 ? unitXZ(points[i - 1], points[i]) : unitXZ(points[i], points[i + 1])
      const outTan = i < n - 1 ? unitXZ(points[i], points[i + 1]) : inTan
      if (!inTan || !outTan) {
        out.push(points[i].clone())
        continue
      }
      const inOff = i > 0 ? segOff[i - 1] : segOff[0]
      const outOff = i < n - 1 ? segOff[i] : segOff[n - 2]
      if (!inOff && !outOff) {
        out.push(points[i].clone())
        continue
      }
      out.push(miterLanePoint(points[i], inTan, inOff, outTan, outOff))
    }
    return out
  }

  function projectToRoadPath(worldPoint, path) {
    let best = null
    let bestD = Infinity
    for (let i = 0; i < path.length - 1; i += 1) {
      const a = toWorld(path[i], 0)
      const b = toWorld(path[i + 1], 0)
      const dx = b.x - a.x
      const dz = b.z - a.z
      const len2 = dx * dx + dz * dz
      const t = len2 < 1e-8 ? 0 : Math.max(0, Math.min(1, ((worldPoint.x - a.x) * dx + (worldPoint.z - a.z) * dz) / len2))
      const on = new THREE.Vector3(a.x + t * dx, 0, a.z + t * dz)
      const d = Math.hypot(worldPoint.x - on.x, worldPoint.z - on.z)
      if (d < bestD) {
        bestD = d
        const tan = new THREE.Vector3(dx, 0, dz)
        if (tan.length() > 1e-4) tan.normalize()
        best = { on, dist: d, tangent: tan, a, b }
      }
    }
    return best
  }

  function nearestRoadHit(worldPoint, maxDist, twoWayOnly) {
    const roads = (state.map && state.map.roads) || []
    let best = null
    let bestD = maxDist == null ? 8 : maxDist
    roads.forEach(road => {
      const dir = Number(road.directionType)
      const oneWay = dir === 1 || dir === 2
      if (twoWayOnly && oneWay) return
      const hit = projectToRoadPath(worldPoint, road.path || [])
      if (hit && hit.dist < bestD) {
        bestD = hit.dist
        best = Object.assign({ road, oneWay }, hit)
      }
    })
    return best
  }

  function isOneWayNear(worldPoint) {
    const hit = nearestRoadHit(worldPoint, 7, false)
    return !!(hit && hit.oneWay)
  }

  /** 把 (u, v) 归一化坐标换算成世界坐标，u 沿贝方向、v 沿排方向。 */
  function cornerAt(corners, u, v) {
    const p = lerp2(lerp2(corners.sw, corners.se, u), lerp2(corners.nw, corners.ne, u), v)
    return toWorld({ x: p[0], y: p[1] }, 0)
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
    const model = template && vehicleLoader.instantiateTemplate(THREE, template, color, materialOpts)
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
      const polygon = (block.polygon || []).map(xyOf)
      if (polygon.length < 4 || polygon.some(p => !p)) return
      const corners = {
        sw: [polygon[0].x, polygon[0].y],
        se: [polygon[1].x, polygon[1].y],
        ne: [polygon[2].x, polygon[2].y],
        nw: [polygon[3].x, polygon[3].y]
      }
      const slots = Math.max(block.slotCount || 1, 1)
      const rows = Math.max(block.rowCount || 1, 1)
      const palette = blockPalette(block)

      const cornerWorld = c => toWorld({ x: c[0], y: c[1] }, 0)
      let psw = cornerWorld(corners.sw)
      let pse = cornerWorld(corners.se)
      let pnw = cornerWorld(corners.nw)
      // 长边必须是贝、短边是排；若接口多边形对调了，这里把 u/v 拧回来
      if (psw.distanceTo(pse) + 0.5 < psw.distanceTo(pnw)) {
        corners.se = [polygon[3].x, polygon[3].y]
        corners.nw = [polygon[1].x, polygon[1].y]
        psw = cornerWorld(corners.sw)
        pse = cornerWorld(corners.se)
        pnw = cornerWorld(corners.nw)
      }
      const baseW = Math.max(psw.distanceTo(pse), 1)
      const baseD = Math.max(psw.distanceTo(pnw), 1)
      const baseCenter = toWorld({
        x: (corners.sw[0] + corners.se[0] + corners.ne[0] + corners.nw[0]) / 4,
        y: (corners.sw[1] + corners.se[1] + corners.ne[1] + corners.nw[1]) / 4
      }, 0)
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

      const outDir = Number(block.outDirection)
      const roadOnLowV = outDir === 2 || outDir === 0 || Number.isNaN(outDir)
      const vMark = roadOnLowV ? -0.058 : 1.058
      for (let i = 1; i <= slots; i += 1) {
        const slotNo = String(i * 2 - 1).padStart(2, '0')
        const mark = cornerAt(corners, (i - 0.5) / slots, vMark)
        const spriteBay = makeTextSprite(slotNo, '#111827', {
          scaleX: 5.6,
          scaleY: 1.42,
          plate: false,
          fixed: true,
          font: 'bold 32px sans-serif'
        })
        if (spriteBay) {
          spriteBay.position.set(mark.x, 0.34, mark.z)
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
    state.bounds = bounds
    buildPavement()
    buildRoads(map.roads)
    buildBlocksClean(map.blocks, state.targetBlockId, state.targetSlot)
    buildCrossing()
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

  /**
   * 丢掉「定位点垂直接上路」或 180° 回头，90° 路口转弯必须留着。
   * 旧逻辑 dot<0.5 会把东向单行接到东主通道的右转也掐掉，蓝线就会吸到 20m 外的南通道、斜穿空地。
   */
  function dropLeadStub(points) {
    if (!points || points.length < 3) return points || []
    const ab = points[1].clone().sub(points[0])
    const bc = points[2].clone().sub(points[1])
    ab.y = 0
    bc.y = 0
    const abLen = ab.length()
    const bcLen = bc.length()
    if (abLen < 0.8 || bcLen < 0.8) return points
    const dot = ab.normalize().dot(bc.normalize())
    const stubIntoBlock = insideYardBlock(points[0]) && !insideYardBlock(points[1])
    if (dot < -0.5 || (stubIntoBlock && abLen < 18 && dot < 0.2)) {
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
      const ring = polygon.map(pt => toWorld(pt, 0))
      if (pointInConvex(worldPos, insetRing(ring, 2.2))) return true
    }
    return false
  }

  /** 丢掉不沿道路的第一段（定位点斜接到旧折线、穿空地的飞线）。 */
  function dropOffRoadChords(points) {
    if (!points || points.length < 2) return points || []
    let start = 0
    while (start < points.length - 1 && chordOffRoad(points[start], points[start + 1])) {
      start += 1
    }
    let end = points.length
    while (end > start + 1 && chordOffRoad(points[end - 2], points[end - 1])) {
      end -= 1
    }
    const trimmed = points.slice(start, end)
    if (trimmed.length < 2) return points
    const filtered = [trimmed[0].clone ? trimmed[0].clone() : trimmed[0]]
    for (let i = 1; i < trimmed.length; i += 1) {
      const prev = filtered[filtered.length - 1]
      const cur = trimmed[i]
      if (chordOffRoad(prev, cur)) {
        if (i === trimmed.length - 1) break
        continue
      }
      if (prev.distanceTo(cur) > 0.6) {
        filtered.push(cur.clone ? cur.clone() : cur)
      }
    }
    return filtered.length >= 2 ? filtered : trimmed
  }

  function chordOffRoad(a, b) {
    if (!a || !b) return false
    const hop = a.distanceTo(b)
    if (segmentHitsBlock(a, b)) return true
    if (hop <= 6) return false
    const mid = a.clone().lerp(b, 0.5)
    const snap = nearestRoadSnap(mid)
    if (!snap || snap.dist > 5.5) return true
    const aSnap = nearestRoadSnap(a)
    const bSnap = nearestRoadSnap(b)
    if (!aSnap || !bSnap || aSnap.dist > 8 || bSnap.dist > 8) return true
    if (aSnap.road && bSnap.road && aSnap.road !== bSnap.road && hop > 10) {
      const samePath = (aSnap.road.edgeCode && aSnap.road.edgeCode === bSnap.road.edgeCode)
      if (!samePath) return true
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
    let bestRoad = null
    let bestTan = null
    for (let r = 0; r < roads.length; r += 1) {
      const path = roads[r].path || []
      for (let i = 0; i < path.length - 1; i += 1) {
        const a = toWorld(path[i], 0)
        const b = toWorld(path[i + 1], 0)
        const dx = b.x - a.x
        const dz = b.z - a.z
        const len2 = dx * dx + dz * dz
        const t = len2 < 1e-8 ? 0 : Math.max(0, Math.min(1, ((worldPos.x - a.x) * dx + (worldPos.z - a.z) * dz) / len2))
        const on = new THREE.Vector3(a.x + t * dx, 0, a.z + t * dz)
        const dist = Math.hypot(worldPos.x - on.x, worldPos.z - on.z)
        if (dist < bestDist) {
          bestDist = dist
          best = on
          bestRoad = roads[r]
          const len = Math.hypot(dx, dz) || 1
          bestTan = new THREE.Vector3(dx / len, 0, dz / len)
        }
      }
    }
    state.roadSnapM = Number.isFinite(bestDist) ? bestDist : null
    return best && bestDist < 48
      ? { pos: best, dist: bestDist, road: bestRoad, tangent: bestTan }
      : null
  }

  function roadCorridorKey(road) {
    if (!road) return ''
    const tag = `${road.edgeCode || ''}|${road.edgeName || ''}|${road.roadName || ''}`
    if (/R-EAST|Road03|东主/i.test(tag)) return 'MAIN-E'
    if (/R-WEST|Road02|西主/i.test(tag)) return 'MAIN-W'
    return tag || 'other'
  }

  /** 折线段是否与集卡在同一条路上（优先比 edgeCode，避免只认 truck 那一条路的对象引用） */
  function segmentOnTruckRoad(a, b, truckPos) {
    const truckHit = nearestRoadSnap(truckPos)
    if (!truckHit || !truckHit.road) return true
    const mid = new THREE.Vector3((a.x + b.x) * 0.5, 0, (a.z + b.z) * 0.5)
    const segHit = nearestRoadSnap(mid)
    if (!segHit || !segHit.road) return false
    const tk = roadCorridorKey(truckHit.road)
    const sk = roadCorridorKey(segHit.road)
    if (tk && sk && tk === sk) return true
    if (truckHit.road.edgeCode && segHit.road.edgeCode
        && truckHit.road.edgeCode === segHit.road.edgeCode) {
      return true
    }
    const onRoad = projectToRoadPath(mid, truckHit.road.path || [])
    return onRoad && onRoad.dist <= 12
  }

  function selfWorld() {
    return state.self ? toWorld(state.self, 0) : null
  }

  function selfOnRoadPos() {
    const pos = selfWorld()
    if (!pos) return null
    const snap = nearestRoadSnap(pos)
    return snap ? snap.pos : pos
  }

  function segmentHitsBlock(a, b) {
    if (!a || !b) return false
    const hop = Math.hypot(b.x - a.x, b.z - a.z)
    const samples = Math.max(8, Math.ceil(hop / 4))
    for (let i = 1; i < samples; i += 1) {
      const t = i / samples
      const p = new THREE.Vector3(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t)
      if (insideYardBlock(p)) return true
    }
    return false
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
    const total = polylineLength(points)
    const sameRoad = candidates.filter(c => {
      const a = points[c.index]
      const b = points[c.index + 1]
      return segmentOnTruckRoad(a, b, selfPos)
    })
    const pool = sameRoad.length ? sameRoad : candidates
    // 已经压在某段上（<8m）：用这段。C 与南通道只隔约 20m，18m 容差会把后半圈平行路算进来。
    const onRoad = pool.filter(c => c.dist <= Math.max(8, minDist + 3))
    let chosen = (onRoad.length ? onRoad : pool.filter(c => c.dist <= minDist + 8))
      .reduce((best, c) => (c.dist < best.dist ? c : best), pool[0])
    // 车已贴在某段路上（≤12m）：若存在与车同路的段，禁止接到平行主通道
    if (minDist <= 12) {
      if (sameRoad.length) {
        const nearSame = sameRoad.filter(c => c.dist <= Math.max(12, minDist + 4))
        if (nearSame.length) {
          chosen = nearSame.reduce((best, c) => (c.dist < best.dist ? c : best), nearSame[0])
        }
      }
      return chosen
    }
    const close = candidates.filter(c => c.dist <= Math.max(chosen.dist + 6, 12))
    const rests = close.map(c => c.rest)
    const minR = Math.min(...rests)
    const maxR = Math.max(...rests)
    // 还在东向单行上、离后半圈平行路 20m：选剩余更长的前半段，蓝线先向东再右转。
    if (maxR - minR > 80 && chosen.dist > 8) {
      const earlier = close.reduce((best, c) => (c.rest > best.rest ? c : best), chosen)
      if (earlier.rest > chosen.rest + 40) chosen = earlier
    }
    // 绕场一圈：离 01 贝很近时最近投影只剩 1m，但还要走东→南→北→东，应接剩余更长的那段
    if (total > 350 && maxR - minR > 120 && chosen.rest < 120) {
      const wide = candidates.filter(c => c.dist <= Math.max(55, minDist + 22))
      const alt = wide.reduce((best, c) => (c.rest > best.rest ? c : best), chosen)
      if (alt.rest > chosen.rest + 200) chosen = alt
    }
    return chosen
  }

  /**
   * 剩余路段：只沿后端路网折线画，禁止集卡→折线投影点的直线（会斜穿箱区）。
   * 仅当车已在同一段路上且短线段贴马路时，才把集卡点接在折线前面。
   */
  function clipWorldRouteToSelf(points) {
    if (!points || points.length < 2 || !state.self) return points
    const truck = selfOnRoadPos() || selfWorld()
    const chosen = pickRouteProgress(points, truck)
    if (!chosen) return points
    const segA = points[chosen.index]
    const segB = points[chosen.index + 1]
    const onSameRoad = segmentOnTruckRoad(segA, segB, truck)
    const gap = truck.distanceTo(chosen.on)
    const canStitchTruck = onSameRoad
      && gap <= 10
      && !chordOffRoad(truck, chosen.on)
    const truckSnap = nearestRoadSnap(truck)
    try {
      console.log('[nav-route-draw]', JSON.stringify({
        truck: state.self ? [state.self.x, state.self.y] : null,
        truckRoad: truckSnap && truckSnap.road
          ? (truckSnap.road.edgeCode || truckSnap.road.edgeName || truckSnap.road.roadName || '')
          : '',
        segIdx: chosen.index,
        distToSegM: Math.round(chosen.dist * 10) / 10,
        gapToOnM: Math.round(gap * 10) / 10,
        onSameRoad,
        canStitchTruck,
        polyFirst: points[0] ? [points[0].x, points[0].z] : null
      }))
    } catch (logErr) {
      // ignore
    }
    const out = []
    if (canStitchTruck) {
      out.push(truck.clone())
      if (gap > 0.8) out.push(chosen.on.clone())
    } else {
      out.push(chosen.on.clone())
    }
    for (let i = chosen.index + 1; i < points.length; i += 1) {
      if (out[out.length - 1].distanceTo(points[i]) > 0.8) out.push(points[i].clone())
    }
    return dropOffRoadChords(out.length >= 2 ? out : points)
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
        raw.push(toWorld(route[i], 0.86))
      }
      const dedup = [raw[0]]
      for (let i = 1; i < raw.length; i += 1) {
        if (dedup[dedup.length - 1].distanceTo(raw[i]) > 0.8) dedup.push(raw[i])
      }
      if (dedup.length < 2) return
      const onRoad = dropOffRoadChords(keepOnRoads(dropLeadStub(simplifyRoutePoints(trimDestinationStub(dedup)))))
      const clipped = clipWorldRouteToSelf(onRoad.length >= 2 ? onRoad : dedup)
      if (!clipped || clipped.length < 2) {
        state.dirty = true
        return
      }
      const offset = offsetPolylineRight(clipped, (idx, mid) => (
        isOneWayNear(mid) ? 0 : 2.7
      ))
      const cornerSafe = dropOffRoadChords(offset)
      const smoothed = filletPolyline(cornerSafe.length >= 2 ? cornerSafe : offset, 2.2)
      let painted = dropOffRoadChords(smoothed)
      if (painted.length < 2) painted = dropOffRoadChords(cornerSafe.length >= 2 ? cornerSafe : offset)
      const linePts = painted.length >= 2 ? painted : smoothed
      const blueW = 0.95
      const routeY = 0.52
      buildRouteRibbon(linePts, blueW, routeY, 0x1d6fe8, routeGroup)
      state.routeEnd = linePts[linePts.length - 1]
      state.routeLine = linePts
      const total = linePts.reduce((sum, p, idx) => (
        idx === 0 ? 0 : sum + linePts[idx - 1].distanceTo(p)
      ), 0)
      const arrowCount = Math.min(18, Math.max(4, Math.floor(total / 16)))
      const arrowY = routeY + blueW * 0.5 + 0.018
      for (let i = 1; i <= arrowCount; i += 1) {
        const want = (total * i) / (arrowCount + 1)
        let acc = 0
        for (let k = 0; k < linePts.length - 1; k += 1) {
          const seg = linePts[k].distanceTo(linePts[k + 1])
          if (acc + seg >= want || k === linePts.length - 2) {
            const t = seg < 0.01 ? 0 : (want - acc) / seg
            const p = linePts[k].clone().lerp(linePts[k + 1], Math.max(0, Math.min(1, t)))
            const tangent = linePts[k + 1].clone().sub(linePts[k])
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
    // GLB 还没解析完就先不画，onModelReady 会回来补
    const parts = vehicleLoader.getTruckParts()
    if (!parts || !parts.length) return null
    const truck = vehicleLoader.instantiate(THREE, parts, materialOpts)
    truck.traverse(child => {
      child.frustumCulled = false
      if (child.isMesh) child.renderOrder = 6
    })
    truck.position.set(origin.x, 0.26, origin.z)
    truck.rotation.y = yaw
    return truck
  }

  /** 与 buildRoads 主路面层 y=0.24 一致，道口底座贴齐行车面 */
  const ROAD_SURFACE_Y = 0.24

  /**
   * dualChannelCrossing 源模左右车道岛底面 Y 不一致（约 0.11m），
   * 右侧更低，整体贴地时右侧会像陷进地面；按水平方向分侧把低侧抬到与高侧一致。
   */
  function levelCrossingPedestals(model) {
    const items = []
    model.traverse(child => {
      if (!child.isMesh || !child.geometry) return
      if (typeof child.geometry.computeBoundingBox === 'function') {
        child.geometry.computeBoundingBox()
      }
      const box = child.geometry.boundingBox
      if (!box) return
      const sx = child.scale.x || 1
      const sy = child.scale.y || 1
      const sz = child.scale.z || 1
      const cx = child.position.x + (box.min.x + box.max.x) * 0.5 * sx
      const cz = child.position.z + (box.min.z + box.max.z) * 0.5 * sz
      const footY = child.position.y + box.min.y * sy
      items.push({ child, cx, cz, footY })
    })
    if (!items.length) return

    const xs = items.map(item => item.cx)
    const zs = items.map(item => item.cz)
    const spanX = Math.max(...xs) - Math.min(...xs)
    const spanZ = Math.max(...zs) - Math.min(...zs)
    const useX = spanX >= spanZ
    const coordOf = item => (useX ? item.cx : item.cz)
    const coords = items.map(coordOf)
    const mid = (Math.max(...coords) + Math.min(...coords)) / 2
    const half = Math.max((Math.max(...coords) - Math.min(...coords)) / 2, 0.01)
    const edge = Math.max(0.06, half * 0.18)

    let leftFoot = Infinity
    let rightFoot = Infinity
    items.forEach((item, index) => {
      const c = coords[index]
      if (c <= mid - edge) leftFoot = Math.min(leftFoot, item.footY)
      if (c >= mid + edge) rightFoot = Math.min(rightFoot, item.footY)
    })
    if (!Number.isFinite(leftFoot)) {
      leftFoot = Math.min(...items.map(item => item.footY))
    }
    if (!Number.isFinite(rightFoot)) {
      rightFoot = leftFoot
    }
    const lift = leftFoot - rightFoot
    if (lift <= 0.005) return
    items.forEach((item, index) => {
      if (coords[index] >= mid + edge) {
        item.child.position.y += lift
      }
    })
  }

  function alignModelFootToRoad(model, footY) {
    const target = footY != null ? footY : ROAD_SURFACE_Y
    model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(model)
    if (!box || !Number.isFinite(box.min.y)) return
    model.position.y += target - box.min.y
  }

  function isExitPurpose() {
    return state.purpose === 'exit' || /出场|出口|EXIT/i.test(state.targetLabel || '')
  }

  function pickExitNodeFromMap() {
    const nodes = (state.map && state.map.nodes) || []
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]
      const label = `${node.nodeName || ''}${node.nodeCode || ''}`
      if (!/出场|出口|exit|gate/i.test(label)) continue
      const xy = xyOf(node)
      if (xy) return xy
    }
    return null
  }

  /**
   * 道口只认固定出场锚点，绝不使用当前路线终点/任务终点。
   * 场图没维护道口时返回 null —— 不能退到场区包围盒角上凭空立一个，
   * 那会让司机以为那里有出场口。
   */
  function resolveCrossingAnchor() {
    const anchor = xyOf(state.gateAnchor)
    if (anchor) return toWorld(anchor, 0)
    const fromMap = pickExitNodeFromMap()
    return fromMap ? toWorld(fromMap, 0) : null
  }

  function crossingTangentAt(anchor) {
    const hit = nearestRoadHit(anchor, 28, false)
    if (hit && hit.tangent && hit.tangent.length() > 0.05) return hit.tangent
    return new THREE.Vector3(0, 0, 1)
  }

  function updateCrossingVisibility() {
    if (!crossing) return
    if (!isExitPurpose()) {
      crossing.visible = true
      return
    }
    const stop = destPoint()
    if (!stop || !state.self) {
      crossing.visible = true
      return
    }
    const truck = selfWorld()
    crossing.visible = truck.distanceTo(stop) > 8
  }

  function buildCrossing() {
    if (crossing) {
      mapGroup.remove(crossing)
      disposeObject(crossing)
      crossing = null
    }
    const parts = vehicleLoader.getCrossingParts()
    if (!parts || !parts.length || !state.bounds) return
    const anchor = resolveCrossingAnchor()
    if (!anchor) return
    const model = vehicleLoader.instantiate(THREE, parts, materialOpts)
    levelCrossingPedestals(model)
    const tangent = crossingTangentAt(anchor)
    model.position.set(anchor.x, 0, anchor.z)
    model.rotation.y = Math.atan2(tangent.x, tangent.z)
    alignModelFootToRoad(model, ROAD_SURFACE_Y)
    model.traverse(child => {
      if (child.isMesh) child.renderOrder = 3
    })
    crossing = model
    mapGroup.add(model)
    updateCrossingVisibility()
  }

  function buildStacker(origin, yaw) {
    const parts = vehicleLoader.getStackerParts()
    if (!parts || !parts.length) return null
    const model = vehicleLoader.instantiate(THREE, parts, materialOpts)
    model.position.set(origin.x, 0, origin.z)
    model.rotation.y = -yaw
    return model
  }

  function destPoint() {
    if (xyOf(state.target)) {
      return toWorld(state.target, 0)
    }
    if (state.routeEnd) return state.routeEnd.clone()
    return null
  }

  /** 堆高机朝向用进终点的最后一段路，不跟本车车头转。 */
  function lastRouteApproach() {
    const raw = routeWorldPoints()
    const line = raw.length >= 2
      ? dropOffRoadChords(keepOnRoads(dropLeadStub(raw)))
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
      if (xyOf(route[i])) {
        points.push(toWorld(route[i], 0))
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

  function routeForwardAt(pos) {
    const painted = state.routeLine && state.routeLine.length >= 2 ? state.routeLine : null
    if (painted) {
      const forward = remainingForward(painted, pos)
      if (forward && forward.length() > 0.01) return forward
    }
    const raw = routeWorldPoints()
    if (raw && raw.length >= 2) {
      const forward = remainingForward(raw, pos)
      if (forward && forward.length() > 0.01) return forward
    }
    return null
  }

  /**
   * 车位直接用后端吸附好的场区坐标，不再本地贴路——双向路的靠右偏移
   * 一旦被 nearestRoadSnap 拉回中心线，车就会画在两车道中间。
   * 道路切线只用来兜底车头朝向。
   */
  function selfDisplayPose() {
    const pos = selfWorld()
    let forward = routeForwardAt(pos)
    if (!forward || forward.length() < 0.05) {
      const snap = nearestRoadSnap(pos)
      forward = (snap && snap.tangent) ? snap.tangent.clone() : new THREE.Vector3(0, 0, -1)
    }
    return { pos, yaw: yawForTruck(forward) }
  }

  function ensureSelfTruck() {
    if (selfTruck) return selfTruck
    const truck = buildSelfTruck(new THREE.Vector3(0, 0, 0), 0)
    if (!truck) return null
    selfTruck = truck
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
    const pose = selfDisplayPose()
    const truck = ensureSelfTruck()
    if (!truck) return
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
      const maxTurn = Math.PI * 4.2 * dt
      if (Math.abs(dyaw) > maxTurn) dyaw = (dyaw > 0 ? 1 : -1) * maxTurn
      poseSmooth.yaw += dyaw * (Math.abs(dyaw) > 0.12 ? 0.72 : 0.42)
      const pdx = pose.pos.x - poseSmooth.x
      const pdz = pose.pos.z - poseSmooth.z
      const pdist = Math.hypot(pdx, pdz)
      const pt = pdist > 20 ? 0.55 : 0.18
      poseSmooth.x += pdx * pt
      poseSmooth.z += pdz * pt
    }
    truck.position.set(poseSmooth.x, 0.26, poseSmooth.z)
    truck.rotation.y = poseSmooth.yaw
    updateCrossingVisibility()
  }

  function rebuildDynamic() {
    clearGroup(dynamicGroup)
    const dest = destPoint()
    if (dest) {
      const exitDest = state.purpose === 'exit' || /出场|出口|EXIT/i.test(state.targetLabel || '')
      // 出场口由道口模型标识；贴近时不要再叠高大图钉和「出场口」飘字（会糊在脸上）
      if (!exitDest) {
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
      }
      if (state.targetLabel && state.purpose !== 'safety' && !exitDest) {
        const tag = makeTextSprite(state.targetLabel, '#166534', { scaleX: 12, scaleY: 3 })
        if (tag) {
          tag.position.set(dest.x, 5.2, dest.z)
          dynamicGroup.add(tag)
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
        centerX: state.view.centerX,
        centerY: state.view.centerY,
        distance: state.view.distance,
        pitch: currentPitch,
        bearing: currentBearing
      }
    }
    const self = xyOf(state.self)
    // TEST 演示场已按真机定位对齐，只留 40m 余量消化普通 GPS 抖动
    const off = distanceToBounds(bounds, self, 40)
    state.offYardMeters = off
    const framed = off !== null && off <= 400
      ? boundsOf([
        { x: bounds.minX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.maxY },
        self
      ])
      : bounds
    const centerX = (framed.minX + framed.maxX) / 2
    const centerY = (framed.minY + framed.maxY) / 2
    const spanX = Math.max(framed.maxX - framed.minX, 60)
    const spanY = Math.max(framed.maxY - framed.minY, 60)
    const span = Math.max(spanX, spanY)
    const fitDistance = Math.max(80, Math.min(MAX_DISTANCE, span * 1.35))
    state.fitDistance = fitDistance

    const inYard = off !== null && off <= 80
    if (state.followMode && !state.userView && inYard && self) {
      const center = poseSmooth.x != null && poseSmooth.z != null
        ? fromWorld(poseSmooth.x, poseSmooth.z)
        : self
      return {
        centerX: center.x,
        centerY: center.y,
        distance: 110,
        pitch: currentPitch,
        bearing: currentBearing
      }
    }
    return { centerX, centerY, distance: fitDistance, pitch: currentPitch, bearing: currentBearing }
  }

  function applyCamera() {
    const view = state.userView || computeAutoView()
    if (view.pitch == null) view.pitch = DEFAULT_PITCH
    if (view.bearing == null) view.bearing = 0
    state.view = view
    const target = toWorld({ x: view.centerX, y: view.centerY }, 0)
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
      && Number(state.target.x) === Number(target.x)
      && Number(state.target.y) === Number(target.y)
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

  /**
   * @param {{x:number, y:number, heading?:number}} self 后端按三点定标换算出的场区米制坐标
   */
  function setSelf(self) {
    const next = xyOf(self)
    // 视觉平滑：小幅度抖动不瞬移车模
    if (state.self && next) {
      const prev = state.self
      const dist = Math.hypot(next.x - prev.x, next.y - prev.y)
      const alpha = dist > 12 ? 0.85 : dist > 4 ? 0.55 : 0.28
      state.self = {
        x: prev.x + (next.x - prev.x) * alpha,
        y: prev.y + (next.y - prev.y) * alpha,
        heading: self.heading != null && !Number.isNaN(Number(self.heading))
          ? Number(self.heading)
          : (prev.heading != null ? prev.heading : 0),
        headingFrom: self.headingFrom,
        accuracy: self.accuracy,
        speed: self.speed
      }
    } else if (next) {
      state.self = Object.assign({}, self, next)
    } else {
      state.self = null
    }
    if (state.demoContainer && !state.demoContainerAnchor && state.self) {
      state.demoContainerAnchor = {
        x: state.self.x,
        y: state.self.y,
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
      centerX: view.centerX,
      centerY: view.centerY,
      distance: view.distance,
      pitch: currentPitch(view),
      bearing: currentBearing(view)
    }, patch || {})
  }

  function pan(dxPx, dyPx) {
    const view = state.userView || state.view
    const pitch = currentPitch(view)
    const metersPerPx = (view.distance * 0.0018) + 0.08
    applyCamera()
    const target = toWorld({ x: view.centerX, y: view.centerY }, 0)
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
      centerX: view.centerX + moveX,
      centerY: view.centerY + moveZ,
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
    state.view.pitch = FLAT_PITCH
    state.dirty = true
  }

  function locateSelf() {
    if (!state.self) return null
    const view = state.userView || state.view
    const next = snapshotView(view, {
      centerX: state.self.x,
      centerY: state.self.y,
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

  /**
   * models/*.glb 解析要几十毫秒，不能挡在启动路径上，
   * 因此先建场景，模型就绪后再各自补挂。
   */
  const offModelReady = vehicleLoader.onModelReady(name => {
    if (name === 'truck') {
      if (selfTruck) {
        root.remove(selfTruck)
        disposeObject(selfTruck)
        selfTruck = null
      }
      applySelfPose()
    } else if (name === 'container20' || name === 'container40') {
      state.containerTemplates = {
        c20: vehicleLoader.createTemplate(THREE, vehicleLoader.getContainerParts(20)),
        c40: vehicleLoader.createTemplate(THREE, vehicleLoader.getContainerParts(40))
      }
      rebuildDynamic()
    } else if (name === 'crossing') {
      buildCrossing()
    } else {
      rebuildDynamic()
    }
    state.dirty = true
  })
  vehicleLoader.preload()

  function dispose() {
    state.running = false
    offModelReady()
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

  /** @param {{x:number, y:number}} anchor 出场道口的场图米制坐标 */
  function setExitGateAnchor(anchor) {
    const next = xyOf(anchor)
    if (!next) return
    const prev = state.gateAnchor
    const same = prev && prev.x === next.x && prev.y === next.y
    state.gateAnchor = next
    if (!same) buildCrossing()
  }

  return {
    setMap,
    setRoute,
    setTarget,
    setExitGateAnchor,
    setSelf,
    setHeading,
    setDemoContainer,
    setFollowMode,
    setPurpose(purpose) {
      state.purpose = purpose || 'job'
      updateCrossingVisibility()
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
    getSelfWorld() {
      if (!state.self) return null
      const pos = selfOnRoadPos() || selfWorld()
      return pos ? { x: pos.x, y: pos.y, z: pos.z } : null
    },
    renderFrame,
    dispose,
    MAX_SCALE: MAX_DISTANCE
  }
}

/**
 * 把场区米制点投影到最近道路中心线，供上报规划与画面集卡贴路一致。
 * 入参出参都是场图坐标，不再做经纬度换算。
 */
function snapPositionToRoad(roads, x, y, maxDistMeters) {
  const self = xyOf({ x, y })
  if (!self || !roads || !roads.length) {
    return { x, y, snapped: false }
  }
  const maxDist = maxDistMeters == null ? 48 : maxDistMeters
  let bestDist = Infinity
  let bestX = self.x
  let bestY = self.y
  let bestRoad = null
  roads.forEach(road => {
    const path = road.path || []
    for (let i = 0; i < path.length - 1; i += 1) {
      const a = xyOf(path[i])
      const b = xyOf(path[i + 1])
      if (!a || !b) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((self.x - a.x) * dx + (self.y - a.y) * dy) / len2))
      const onx = a.x + t * dx
      const ony = a.y + t * dy
      const dist = Math.hypot(self.x - onx, self.y - ony)
      if (dist < bestDist) {
        bestDist = dist
        bestX = onx
        bestY = ony
        bestRoad = road
      }
    }
  })
  const roadLabel = bestRoad ? {
    edgeCode: bestRoad.edgeCode || '',
    name: bestRoad.edgeName || bestRoad.roadName || ''
  } : null
  if (bestDist > maxDist) {
    return { x: self.x, y: self.y, snapped: false, distM: bestDist, road: roadLabel }
  }
  return {
    x: bestX,
    y: bestY,
    snapped: true,
    distM: bestDist,
    road: roadLabel
  }
}

module.exports = {
  createYardScene,
  snapPositionToRoad,
  nearestRoad(roads, self) {
    if (!self || !roads || !roads.length) return null
    const snap = snapPositionToRoad(roads, self.x, self.y, 60)
    if (!snap.road) return null
    const hit = roads.find(r => (r.edgeCode && r.edgeCode === snap.road.edgeCode)
      || ((r.edgeName || r.roadName) === snap.road.name))
    return hit || null
  }
}
