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
/** 引入适配小程序 canvas 的 Three.js，用来画真三维堆场 */
const { createScopedThreejs } = require('../libs/threejs/index.js')
/** 引入集卡/箱子/道口/堆高机模型加载器 */
const vehicleLoader = require('./vehicleLoader')
/** 引入手机罗盘航向，跟车时车头跟手机转 */
const headingSensor = require('./heading')

/** 箱垛默认总高度（米），给旧逻辑/占位用 */
const STACK_HEIGHT = 7.8
/** 单层集装箱高度（米），箱垛高度按堆放层数叠出来。 */
const CNTR_LAYER_H = 2.75
/** 俯仰角：相对水平面抬起的角度。越大越接近正俯视，越小越接近侧视（像高德 3D）。 */
const MIN_PITCH = 18 * Math.PI / 180
/** 最大俯仰：几乎正俯视，再大相机会和视线打架 */
const MAX_PITCH = 88 * Math.PI / 180
/** 接近正俯视的“平面图”俯仰，用来当 2D 场图看 */
const FLAT_PITCH = 86 * Math.PI / 180
/** 默认接近正俯视，便于辨认场区/道路/空地；导航页可切 3D */
const DEFAULT_PITCH = FLAT_PITCH
/** 相机最近距离（米），再近会钻进箱子里 */
const MIN_DISTANCE = 40
/** 相机最远距离（米），再远场区会缩成一小块 */
const MAX_DISTANCE = 900

/** 把俯仰角限制在允许范围内，避免相机翻到地下或过度侧视 */
function clampPitch(pitch) {
  // 小于最小俯仰就抬到最小，大于最大就压到最大
  return Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch))
}

/** 接口点 → 场图米制 {x, y}，缺 x/y 的点一律丢弃，不再拿经纬度顶替。 */
function xyOf(point) {
  if (!point) return null // 没点就直接放弃
  const x = Number(point.x) // 转成数字，防止接口给字符串
  const y = Number(point.y) // 场图 Y，南增
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null // NaN/Infinity 不能用来画图
  return { x, y } // 只留下场图米制坐标
}

/** 算一堆点的最小包围盒，用来定场区范围、相机框选 */
function boundsOf(points) {
  let minX = Infinity // 先设成无穷大，后面逐点收紧
  let maxX = -Infinity // 最东，先从负无穷往大收
  let minY = Infinity // 场图 Y 最小值
  let maxY = -Infinity // 场图 Y 最大值
  points.forEach(p => { // 逐点更新四条边
    minX = Math.min(minX, p.x) // 最西
    maxX = Math.max(maxX, p.x) // 最东
    minY = Math.min(minY, p.y) // 最北（场图 Y 南增，这里只当数值最小）
    maxY = Math.max(maxY, p.y) // 最南
  })
  return { minX, maxX, minY, maxY } // 返回包围盒四角
}

/** 从场图的箱区和道路点算出整个堆场包围盒 */
function yardBounds(map) {
  const points = [] // 收集所有有效米制点
  const push = p => { // 把一个接口点转成米制后塞进列表
    const xy = xyOf(p) // 丢掉没有米制坐标的点
    if (xy) points.push(xy) // 只有带 x/y 的才算
  }
  ;(map.blocks || []).forEach(b => (b.polygon || []).forEach(push)) // 箱区四角
  ;(map.roads || []).forEach(r => (r.path || []).forEach(push)) // 道路折线点
  ;(map.marks || []).forEach(push) // 道口等建筑，避免落在箱区南侧时被裁出包围盒
  return points.length ? boundsOf(points) : null // 一个点都没有就没法定范围
}

/**
 * 到场区包围盒边缘的距离（米）。padMeters 把判定范围外扩，
 * 演示场几何比真实小区小一圈时，避免站在 C 座仍被报「场外两百米」。
 */
function distanceToBounds(bounds, self, padMeters) {
  if (!bounds || !self) return null // 没有场区或没有本车位置就算不了
  const pad = padMeters || 0 // 外扩多少米，消化 GPS 抖动或演示场偏小
  const dx = Math.max((bounds.minX - pad) - self.x, 0, self.x - (bounds.maxX + pad)) // 东西方向出界距离，在框内为 0
  const dy = Math.max((bounds.minY - pad) - self.y, 0, self.y - (bounds.maxY + pad)) // 南北方向出界距离
  return Math.hypot(dx, dy) // 斜着出界也按直线距离算
}

/**
 * @param {HTMLCanvasElement} canvas 小程序 webgl canvas 节点
 * @param {number} width 逻辑像素宽
 * @param {number} height 逻辑像素高
 * @param {number} dpr 设备像素比
 */
function createYardScene(canvas, width, height, dpr) {
  const THREE = createScopedThreejs(canvas) // 给这块 canvas 单独做一套 Three.js，避免小程序全局污染
  const renderer = new THREE.WebGLRenderer({ // WebGL 渲染器，真正往屏幕上画三维
    canvas, // 画到小程序传入的 webgl canvas
    antialias: true, // 开抗锯齿，箱子边缘不那么毛
    alpha: false // 不透明背景，用下面的清空色盖住
  })
  renderer.setPixelRatio(dpr || 2) // 按设备像素比画，没传就按 2 倍，视网膜屏才清晰
  renderer.setSize(width, height, false) // 逻辑宽高；第三个 false 表示不改 canvas 样式尺寸
  renderer.setClearColor(0xe4e9ef, 1) // 浅灰蓝背景，和雾、地面同一色系
  // 小程序 WebGL 开阴影 + 大量 Mesh 容易卡死主线程，关闭阴影保流畅
  renderer.shadowMap.enabled = false
  // 贴图按 sRGB 采样后必须在输出端转回去，否则烘焙贴图整体发灰发暗
  if (THREE.sRGBEncoding != null) renderer.outputEncoding = THREE.sRGBEncoding

  const scene = new THREE.Scene() // 三维世界容器：灯、地面、箱区、车都挂这里
  scene.fog = new THREE.Fog(0xe4e9ef, 620, 1700) // 远处渐隐进背景色，减轻远景糊成一片

  const camera = new THREE.PerspectiveCamera(48, width / height, 0.2, 4000) // 透视相机：48° 视场，近 0.2 远 4000 米

  // 环境光压低、主光提高：明暗对比拉开，模型才有体积感
  const hemi = new THREE.HemisphereLight(0xdfe8f2, 0x9aa3ad, 0.72) // 天空色 + 地面色的半球光，当环境底光
  scene.add(hemi) // 把环境光加进场景
  const sun = new THREE.DirectionalLight(0xfff2df, 0.95) // 主阳光，偏暖，照出箱子侧面
  sun.position.set(140, 240, 90) // 太阳在东偏南、高处
  scene.add(sun) // 挂上主光
  // 逆光补一盏弱光，避免背面死黑
  const fill = new THREE.DirectionalLight(0xcfe0f5, 0.38) // 冷色弱补光
  fill.position.set(-120, 90, -140) // 补光从相反方向打过来
  scene.add(fill) // 挂上补光

  /** 传给 vehicleLoader：无 IBL 户外场景，玻璃不透明、双面渲染，避免集卡/箱发黑镂空 */
  const materialOpts = { canvas, outdoor: true, forceDoubleSide: true, opaqueGlass: true }

  const root = new THREE.Group() // 场景根节点，地面和各图层都挂在它下面，方便整体管理
  scene.add(root) // 根节点进场景

  const ground = new THREE.Mesh( // 超大地面片，当堆场外的灰地
    new THREE.PlaneGeometry(4000, 4000), // 4000×4000 米平面
    new THREE.MeshLambertMaterial({ color: 0xc8ced6 }) // 浅灰地面，受光
  )
  ground.rotation.x = -Math.PI / 2 // 平面默认朝上，转到水平当地面
  ground.position.y = -0.05 // 略低于路面，避免和路/箱底板闪面
  root.add(ground) // 地面挂到根节点

  let mapGroup = new THREE.Group() // 静态场图层：路、箱区、道口
  root.add(mapGroup)
  let routeGroup = new THREE.Group() // 导航蓝线图层，换路线时整组清掉重画
  root.add(routeGroup)
  let dynamicGroup = new THREE.Group() // 动态图层：终点图钉、堆高机、标签
  root.add(dynamicGroup)
  let liveForkliftGroup = new THREE.Group() // 实时堆高机，不跟终点动态层一起清
  root.add(liveForkliftGroup)
  const liveForklifts = new Map() // forkliftId -> { model, label }
  // 本车单独挂，指南针刷新只改位置/航向，不要拆掉重建
  let selfTruck = null
  // 道口属静态场景，但 GLB 晚于建图就绪，留个引用便于就绪后单独补挂
  let crossing = null

  /** 场景运行时状态：场图、路线、本车、相机、建图进度都记在这里 */
  const state = {
    width, // 画布逻辑宽，resize 时会改
    height, // 画布逻辑高
    map: null, // 当前场图数据（箱区、道路、节点）
    // 场区包围盒，建图时算出，道口等按场区边缘定位的物体要用
    bounds: null,
    route: [], // 后端下发的导航折线（场图米制点）
    routeLaneOffset: false, // 路线是否已经偏到右侧车道，避免再偏一次叠到路心
    target: null, // 任务终点场图坐标
    targetLabel: '', // 终点飘字，如箱位号、出场口
    targetBlockId: null, // 目标箱区，用来高亮/重建该区
    targetSlot: null, // 目标贝位号
    self: null, // 本车场图坐标 + 航向
    followMode: true, // 是否跟车：相机跟着本车走
    userView: null, // 用户手势改过的视角；有值就不再自动算视野
    // lookAt 用场图米制 (x, y)；distance 相机距离；pitch 俯仰；bearing 方位（弧度，0=从南望北）
    view: { centerX: 0, centerY: 0, distance: 220, pitch: DEFAULT_PITCH, bearing: 0 },
    fitDistance: 220, // 把整场框进屏幕需要的相机距离
    offYardMeters: null, // 本车离场区包围盒多远，用来判断是否在场外
    dirty: true, // 下一帧要不要重画
    running: true, // 动画循环是否还在跑，dispose 后关掉
    mapBuilding: false, // 是否正在异步建图，建图中也要继续刷帧
    mapBuildToken: 0, // 建图代数，新的一次建图会作废上一趟
    demoContainer: false, // 演示用：要不要在本车旁假放一个箱子
    demoContainerAnchor: null, // 演示箱钉死的位置，避免跟着 GPS 抖
    routeEnd: null, // 画完后蓝线最后一个世界坐标点
    routeLine: null, // 实际画在地上的蓝线点列，供车头朝向/剩余路用
    /** 出场道口固定锚点（导航配置 entry 的场图坐标），与当前任务终点无关 */
    gateAnchor: null,
    purpose: 'job', // 当前用途：作业进场 / 出场 / 安全等，影响道口和终点图标
    // 北朝上。车头跟手机转，和右上角高德小人一致；拧地图才改 bearing
    headingUp: false,
    hasLiveForklifts: false, // 有实时堆高机时不再在终点旁摆装饰机
    liveForkliftItems: [], // 最近一次实时堆高机列表，模型就绪后重挂
    vehicleParts: {}, // 预留：车辆零件缓存
    containerTemplates: { // 20/40 尺箱子模板，建箱区时复制，避免每个箱子都重新解析 GLB
      c20: vehicleLoader.createTemplate(THREE, vehicleLoader.getContainerParts(20)), // 20 尺箱模板
      c40: vehicleLoader.createTemplate(THREE, vehicleLoader.getContainerParts(40)) // 40 尺箱模板
    }
  }

  /** 场图米制点 → 世界坐标。场图 Y 南增，世界 Z 也朝南，直接同号。 */
  function toWorld(point, height) {
    const xy = xyOf(point) // 先取出合法的 x/y
    if (!xy) return new THREE.Vector3(0, height || 0, 0) // 坏点落到原点，高度仍用传入值
    return new THREE.Vector3(xy.x, height || 0, xy.y) // X 东、Y 高、Z 南
  }

  /** 世界坐标 (x,z) 变回场图米制 {x,y}，给相机中心、跟车用 */
  function fromWorld(x, z) {
    return { x, y: z } // 世界 Z 就是场图 Y
  }

  /** 折线总长（米），用来均分箭头、判断绕场一圈 */
  function polylineLength(points) {
    if (!points || points.length < 2) return 0 // 不够一段就没长度
    let n = 0 // 累加各段长度
    for (let i = 1; i < points.length; i += 1) n += points[i - 1].distanceTo(points[i])
    return n
  }

  /** 从折线某段上的投影点算到终点还剩多少米 */
  function remainingAfter(points, index, onPoint) {
    if (!points || points.length < 2) return 0
    if (index >= points.length - 1) return 0 // 已经在最后一段之后
    let n = onPoint.distanceTo(points[index + 1]) // 先加上投影点到本段终点
    for (let i = index + 2; i < points.length; i += 1) n += points[i - 1].distanceTo(points[i]) // 再加后面整段
    return n
  }

  /** 释放一个三维物体占用的几何和材质，避免反复建图内存涨 */
  function disposeObject(obj) {
    obj.traverse(child => { // 连子节点一起清
      if (child.geometry) child.geometry.dispose() // 释放顶点缓冲
      if (child.material) { // 材质可能是一张或一组
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose()) // 多材质逐个释放
        else child.material.dispose() // 单材质直接释放
      }
    })
  }

  /** 清空一组子物体并释放资源，换场图/换路线时用 */
  function clearGroup(group) {
    while (group.children.length) { // 还有孩子就继续拆
      const child = group.children.pop() // 从末尾取出
      disposeObject(child) // 释放几何材质
      group.remove(child) // 从组里摘掉
    }
  }

  /** 做一个受光的长方体，路面、箱子占位、箭头翅膀都用它 */
  function makeBox(w, h, d, color, opts) {
    const mesh = new THREE.Mesh( // 网格 = 形状 + 材质
      new THREE.BoxGeometry(w, h, d), // 宽高深（米）
      new THREE.MeshLambertMaterial({ color, ...(opts || {}) }) // 受光照的漫反射材质
    )
    mesh.castShadow = false // 不投射阴影（渲染器也关了阴影）
    mesh.receiveShadow = false
    return mesh
  }

  /** 不受光照染色，场区底板必须用这个，Lambert 白会渲成灰。 */
  function makeUnlitBox(w, h, d, color) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color }) // 自发光色，不受灯影响
    )
    mesh.castShadow = false
    mesh.receiveShadow = false
    return mesh
  }

  /** 以前会铺整场浅色垫，现在空实现，避免俯视把路和箱区盖白 */
  function buildPavement() {
    // 不再抬一块整场浅色垫：俯视时中间会像一块白色遮挡，把场区和路盖住
  }

  /** 在两点之间铺一段路面长方体，首尾略加长用来盖住接缝 */
  function buildRoadSegment(a, b, widthM, color, group, y, extraLen) {
    const targetGroup = group || mapGroup // 没指定组就画到静态场图
    const mid = a.clone().add(b).multiplyScalar(0.5) // 路段中点，当盒子中心
    const len = a.distanceTo(b) // 这一段实际长度
    if (len < 0.2) return null // 太短不画，避免退化成一个点
    const pad = extraLen == null ? Math.min(widthM * 0.35, 2.4) : extraLen // 两端多伸出一点，路口不露缝
    const mesh = makeBox(widthM, 0.1, len + pad, color) // 薄盒子当地面层
    mesh.position.copy(mid) // 放到路段中点
    mesh.position.y = y != null ? y : 0.12 // 高度分层：底衬、灰边、主路面错开
    const angle = Math.atan2(b.x - a.x, b.z - a.z) // 绕竖直轴转到路的走向
    mesh.rotation.y = angle
    targetGroup.add(mesh) // 挂到目标组
    return mesh
  }

  /** 在折线拐点放一个方块，把两段路的接缝盖住 */
  function buildRoadJoint(p, widthM, color, y, group) {
    const joint = makeBox(widthM, 0.12, widthM, color) // 和路同宽的小方块
    joint.position.set(p.x, y != null ? y : 0.24, p.z) // 钉在拐点
    ;(group || mapGroup).add(joint)
  }

  /** 双向路中间画黄虚线，让司机看出是对向车道 */
  function buildDashedCenterLine(a, b, group, colorHex) {
    const len = a.distanceTo(b) // 这一段路有多长
    if (len < 4) return // 太短画虚线会挤成一团
    const angle = Math.atan2(b.x - a.x, b.z - a.z) // 虚线朝向跟路走
    const dashLen = 2.6 // 每一截黄线长度
    const gap = 2.0 // 虚线间隔
    let t = 1.5 // 两端各留一点空，不顶到路口
    while (t + dashLen < len - 1.5) { // 还能放下完整一截就继续
      const p0 = a.clone().lerp(b, t / len) // 这一截起点
      const p1 = a.clone().lerp(b, (t + dashLen) / len) // 这一截终点
      const mid = p0.clone().add(p1).multiplyScalar(0.5) // 截中点
      const dash = makeBox(0.22, 0.04, dashLen, colorHex == null ? 0xf0b429 : colorHex) // 细黄条
      dash.position.set(mid.x, 0.3, mid.z) // 略高于路面，避免闪面
      dash.rotation.y = angle
      ;(group || mapGroup).add(dash)
      t += dashLen + gap // 跳到下一截
    }
  }

  /** 单向路画路面箭头，不再画中心黄虚线。 */
  function buildOneWayArrows(a, b, group) {
    const len = a.distanceTo(b) // 路段长度
    if (len < 5) return // 太短放不下箭头
    const tangent = b.clone().sub(a) // 行驶方向向量
    tangent.y = 0 // 只看地面方向
    if (tangent.length() < 0.2) return // 退化段不画
    tangent.normalize() // 变成单位方向
    const angle = Math.atan2(tangent.x, tangent.z) // 箭头朝向
    const side = new THREE.Vector3(-tangent.z, 0, tangent.x) // 垂直于前进方向的左右轴
    let t = 3 // 从路段头空 3 米开始
    while (t < len - 3) { // 尾部也留空
      const p = a.clone().lerp(b, t / len) // 这一组箭头的中心
      for (let s = -1; s <= 1; s += 2) { // 左右两翼合成一个 V 形箭头
        const wing = makeBox(0.2, 0.05, 1.05, 0xf5f0d8) // 浅色细条当翼
        wing.position.set(
          p.x + side.x * s * 0.26 - tangent.x * 0.16, // 左右分开并略往后收
          0.32, // 略高于路面
          p.z + side.z * s * 0.26 - tangent.z * 0.16
        )
        wing.rotation.y = angle + s * 0.55 // 两翼向外撇开
        ;(group || mapGroup).add(wing)
      }
      t += 8 // 每隔 8 米一组
    }
  }

  /** 把场图道路画成三层路面 + 黄虚线或单向箭头 */
  function buildRoads(roads) {
    ;(roads || []).forEach(road => { // 逐条路画
      const path = road.path || [] // 这条路的折线点
      // 场图维护的真实路宽；旧数据没有时才按限速粗估
      const widthM = Number(road.widthM) > 0
        ? Number(road.widthM)
        : (Number(road.speedLimitKmh) >= 15 ? 9 : 6.5)
      const dir = Number(road.directionType) // 1/2 单向，其它当双向
      const twoWay = !(dir === 1 || dir === 2) // 不是单向就按双向画黄虚线
      const points = [] // 转成世界坐标
      for (let i = 0; i < path.length; i += 1) {
        points.push(toWorld(path[i], 0))
      }
      for (let i = 0; i < points.length - 1; i += 1) { // 每一段路
        const a = points[i] // 段起点
        const b = points[i + 1] // 段终点
        buildRoadSegment(a, b, widthM + 2.2, 0x5f6874, mapGroup, 0.16) // 最底层深灰边
        buildRoadSegment(a, b, widthM + 0.9, 0xd9dee5, mapGroup, 0.2) // 浅灰牙边
        buildRoadSegment(a, b, widthM, 0x7a8490, mapGroup, 0.24) // 主路面
        if (twoWay) {
          buildDashedCenterLine(a, b, mapGroup) // 双向画中心黄虚线
        } else {
          const from = dir === 2 ? b : a // directionType=2 表示反向走
          const to = dir === 2 ? a : b
          buildOneWayArrows(from, to, mapGroup) // 单向画地面箭头
        }
      }
      points.forEach(p => { // 每个拐点盖两层接缝块
        buildRoadJoint(p, widthM + 2.2, 0x5f6874, 0.16)
        buildRoadJoint(p, widthM, 0x7a8490, 0.24)
      })
    })
  }

  /** 二维点线性插值，用来在箱区四角之间取格子角点 */
  function lerp2(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] // t=0 在 a，t=1 在 b
  }

  /* 船公司常见箱色。这是当作固有色用的，亮度得比 UI 取色高一档：
     打光衰减后还要再暗一截，背光面尤其明显，
     照搬 Tailwind 那套深色系会整片糊成黑的。 */
  const CNTR_COLORS = [
    0x2f6fb5, 0xc0392b, 0xe9e9e4, 0xd9772b, // 蓝、红、白、橙
    0x2f7d55, 0x1a8fa8, 0x8c95a0, 0xb8873a // 绿、青、灰、棕
  ]

  /** 按箱号/贝位哈希选一种箱色，同一垛每次颜色稳定 */
  function stackColor(stack) {
    const key = `${(stack && stack.cntrNo) || ''}|${(stack && stack.slot) || ''}|${(stack && stack.rowIndex) || ''}` // 拼唯一键
    let hash = 0 // 累加哈希，同一垛永远同色
    for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0 // 简单字符串哈希
    const side = CNTR_COLORS[hash % CNTR_COLORS.length] // 落到调色板某一格
    return { side, top: side } // 侧面和顶面同色
  }

  /** 按箱区代号选标签字色；地坪和格网各区共用浅灰，避免花 */
  function blockPalette(block) {
    const raw = `${(block && block.blockCode) || ''}${(block && block.blockName) || ''}`.toUpperCase() // 代号+名称大写方便找字母
    if (raw.indexOf('A') >= 0) {
      return { label: '#1a5c40', deck: 0xd5dce4, grid: 0x8b96a2 } // A 区绿字
    }
    if (raw.indexOf('B') >= 0) {
      return { label: '#1e3a5f', deck: 0xd5dce4, grid: 0x8b96a2 } // B 区蓝字
    }
    if (raw.indexOf('C') >= 0) {
      return { label: '#5c401a', deck: 0xd5dce4, grid: 0x8b96a2 } // C 区棕字
    }
    return { label: '#33415c', deck: 0xd5dce4, grid: 0x8b96a2 } // 其它区默认深蓝灰
  }

  /** 场区飘字尽量短：优先「A区」，座改成区，否则用代号 */
  function shortBlockLabel(block) {
    const name = (block && block.blockName) || '' // 场区中文名
    const code = (block && block.blockCode) || '' // 场区代号 A/B/C
    if (/[A-Za-z]区/.test(name)) return name.match(/[A-Za-z]区/)[0] // 名称里已有 A区
    if (/[A-Za-z]座/.test(name)) return name.match(/[A-Za-z]座/)[0].replace('座', '区') // C座 → C区
    if (code) return `${code}区`
    return name.slice(0, 4) || '场区' // 实在没有就截名前 4 字
  }

  /** 把文字画到离屏 canvas 再做成始终朝向相机的精灵，当场区名、贝位号、终点标签 */
  function makeTextSprite(text, colorHex, opts) {
    try {
      const option = opts || {} // 可选：字号、缩放、要不要白底板
      const plate = option.plate !== false // 默认带白色圆角底板，贝位号可以关掉
      const w = 192 // 离屏画布宽
      const h = 48 // 离屏画布高
      let canvas = null // 离屏画布，小程序和浏览器各走一套
      if (typeof wx !== 'undefined' && wx.createOffscreenCanvas) {
        canvas = wx.createOffscreenCanvas({ type: '2d', width: w, height: h }) // 小程序离屏 2d
      } else if (typeof document !== 'undefined' && document.createElement) {
        canvas = document.createElement('canvas') // 浏览器调试时走 DOM canvas
        canvas.width = w
        canvas.height = h
      }
      if (!canvas || !canvas.getContext) return null // 环境不支持就放弃文字
      const ctx = canvas.getContext('2d') // 2d 画笔
      ctx.clearRect(0, 0, w, h) // 先擦干净
      if (plate) {
        ctx.fillStyle = 'rgba(255,255,255,0.94)' // 半透明白底板
        const r = 8 // 圆角半径
        ctx.beginPath()
        ctx.moveTo(r, 4) // 上边左圆角后
        ctx.lineTo(w - r, 4)
        ctx.quadraticCurveTo(w - 4, 4, w - 4, r) // 右上圆角
        ctx.lineTo(w - 4, h - r)
        ctx.quadraticCurveTo(w - 4, h - 4, w - r, h - 4) // 右下
        ctx.lineTo(r, h - 4)
        ctx.quadraticCurveTo(4, h - 4, 4, h - r) // 左下
        ctx.lineTo(4, r)
        ctx.quadraticCurveTo(4, 4, r, 4) // 左上
        ctx.closePath()
        ctx.fill() // 填白底板
      }
      ctx.font = option.font || 'bold 22px sans-serif'
      ctx.textAlign = 'center' // 水平居中
      ctx.textBaseline = 'middle' // 垂直居中
      ctx.fillStyle = colorHex || '#334155'
      ctx.fillText(text, w / 2, h / 2 + 1) // 略往下 1 像素视觉更居中
      const texture = new THREE.CanvasTexture(canvas) // 把 2d 画布当贴图
      texture.needsUpdate = true // 告诉 Three 这张图刚画完
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture, // 用刚画的字
        transparent: true, // 底板外透明
        depthTest: true, // 会被箱子挡住
        depthWrite: false // 不写深度，避免半透明排序花
      }))
      const sx = option.scaleX || 11 // 世界里的宽
      const sy = option.scaleY || 2.8 // 世界里的高
      sprite.scale.set(sx, sy, 1)
      if (!option.fixed) {
        sprite.userData.scaleWithView = true // 拉远相机时跟着放大，字不至于看不见
        sprite.userData.baseScale = { x: sx, y: sy, z: 1 }
      }
      return sprite
    } catch (error) {
      return null // 小程序偶发离屏失败，宁可不显示字
    }
  }

  /** 抽稀导航折线：丢掉挤在一起的点和几乎共线的中间点，圆角和偏车道才稳 */
  function simplifyRoutePoints(points) {
    if (!points || points.length < 2) return points || []
    const kept = [points[0].clone()] // 起点必须留
    for (let i = 1; i < points.length; i += 1) {
      if (kept[kept.length - 1].distanceTo(points[i]) >= 1.6) {
        kept.push(points[i].clone()) // 离上一点够远才留下
      } else if (i === points.length - 1) {
        kept[kept.length - 1].copy(points[i]) // 终点太近就覆盖最后一个，保证接到真终点
      }
    }
    if (kept.length < 3) return kept // 只剩两点没法再抽中间点
    const out = [kept[0]] // 第二遍：丢掉几乎共线的中间点
    for (let i = 1; i < kept.length - 1; i += 1) {
      const a = kept[i].clone().sub(kept[i - 1]).setY(0) // 进入方向
      const b = kept[i + 1].clone().sub(kept[i]).setY(0) // 离开方向
      if (a.length() < 0.2 || b.length() < 0.2) continue // 退化段跳过
      a.normalize()
      b.normalize()
      if (a.dot(b) > 0.992) continue // 几乎一条直线，中间拐点可以扔
      out.push(kept[i]) // 有明显转弯才留拐点
    }
    out.push(kept[kept.length - 1]) // 终点必须留
    return out
  }

  /**
   * 折线拐角切成等宽圆弧，对齐高保真 02 那种小圆角蓝线。
   * 不用二次贝塞尔：那会在弯里忽胖忽瘦，放大后像鼓包。
   */
  function filletPolyline(points, radius) {
    if (!points || points.length < 3) return (points || []).map(p => p.clone()) // 不够三个点就原样克隆
    const out = [points[0].clone()] // 新折线从原起点开始
    for (let i = 1; i < points.length - 1; i += 1) { // 每个中间拐点切一截圆弧
      const prev = points[i - 1] // 前一点
      const curr = points[i] // 当前拐点
      const next = points[i + 1] // 后一点
      const inDir = new THREE.Vector3(curr.x - prev.x, 0, curr.z - prev.z) // 进入向量（贴地）
      const outDir = new THREE.Vector3(next.x - curr.x, 0, next.z - curr.z) // 离开向量
      const dIn = inDir.length() // 进入段长度
      const dOut = outDir.length() // 离开段长度
      if (dIn < 0.3 || dOut < 0.3) {
        out.push(curr.clone()) // 段太短切不了圆，保留尖角
        continue
      }
      inDir.multiplyScalar(1 / dIn) // 单位化进入方向
      outDir.multiplyScalar(1 / dOut) // 单位化离开方向
      const cross = inDir.x * outDir.z - inDir.z * outDir.x // 叉积：左转正、右转负
      const dot = Math.max(-1, Math.min(1, inDir.x * outDir.x + inDir.z * outDir.z)) // 夹角余弦，夹紧防 NaN
      const turn = Math.atan2(cross, dot) // 带符号转角
      if (Math.abs(turn) < 0.12) {
        out.push(curr.clone()) // 几乎直走，不用圆角
        continue
      }
      const half = Math.abs(turn) / 2 // 转角一半，用来算切点距离
      let r = radius // 希望的圆角半径
      let dist = r / Math.tan(half) // 从拐点沿两边后退多少才能切上圆
      const maxDist = Math.min(dIn, dOut) * 0.38 // 最多吃掉邻边 38%，别把短边吃没
      if (dist > maxDist) {
        dist = maxDist // 邻边不够长就缩小圆角
        r = dist * Math.tan(half)
      }
      if (r < 0.45) {
        out.push(curr.clone()) // 缩完太小就不切了
        continue
      }
      const p1 = new THREE.Vector3(curr.x - inDir.x * dist, curr.y, curr.z - inDir.z * dist) // 进入切点
      const p2 = new THREE.Vector3(curr.x + outDir.x * dist, curr.y, curr.z + outDir.z * dist) // 离开切点
      const sign = turn > 0 ? 1 : -1 // 圆弧在哪一侧
      const nIn = new THREE.Vector3(-inDir.z * sign, 0, inDir.x * sign) // 进入方向的内侧法线
      const center = new THREE.Vector3(p1.x + nIn.x * r, curr.y, p1.z + nIn.z * r) // 圆心
      let a0 = Math.atan2(p1.z - center.z, p1.x - center.x) // 起点极角
      let a1 = Math.atan2(p2.z - center.z, p2.x - center.x) // 终点极角
      let sweep = a1 - a0 // 扫过的角度
      while (sweep > Math.PI) sweep -= Math.PI * 2 // 收到 (-π, π]
      while (sweep < -Math.PI) sweep += Math.PI * 2
      // 只走劣弧。旧逻辑按转向符号硬加 2π，90° 右转会被画成 270° 绕到黄虚线外侧。
      const steps = Math.max(12, Math.ceil(Math.abs(sweep) * r / 0.28)) // 按弧长分段，弯越大点越多
      out.push(p1) // 先接到进入切点
      for (let s = 1; s < steps; s += 1) { // 中间采样圆弧
        const a = a0 + sweep * (s / steps) // 当前极角
        out.push(new THREE.Vector3(
          center.x + Math.cos(a) * r, // 圆弧上的 x
          curr.y, // 高度跟着拐点
          center.z + Math.sin(a) * r
        ))
      }
      out.push(p2) // 接到离开切点
    }
    out.push(points[points.length - 1].clone()) // 最后接上原终点
    return out
  }

  /** 把默认沿 +Y 的圆柱转到 XZ 地面方向，避免用方盒子在拐角挤出菱形凸起。 */
  function alignCylinderToXZ(mesh, nx, nz) {
    const dir = new THREE.Vector3(nx, 0, nz) // 希望圆柱轴线躺在地面上的方向
    if (dir.length() < 1e-4) return // 零向量转不了
    dir.normalize()
    if (mesh.quaternion && typeof mesh.quaternion.setFromUnitVectors === 'function') {
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir) // 从竖直转到地面方向
      return
    }
    mesh.rotation.x = Math.PI / 2 // 旧环境没有四元数就先躺倒
    mesh.rotation.y = Math.atan2(dir.x, dir.z) // 再转到路的走向
  }

  /** 蓝线两端加圆球帽，看起来是圆头不是平切 */
  function addRouteCap(point, radius, y, color, group) {
    try {
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 8, 6), // 低面数球就够
        new THREE.MeshBasicMaterial({ color })
      )
      cap.position.set(point.x, y, point.z)
      group.add(cap)
    } catch (error) {
      buildRoundJoint(point, radius, color, y, group) // 球几何失败就改用圆柱墩
    }
  }

  /**
   * 蓝色导航带：圆柱接圆球，拐角圆润，不再铺白套管。
   */
  function buildRouteRibbon(points, width, y, color, group, capPoints) {
    if (!points || points.length < 2) return // 不够一段不画
    const radius = width * 0.5 // 圆柱半径 = 线宽一半
    for (let i = 0; i < points.length - 1; i += 1) { // 每两点一根圆柱
      const a = points[i] // 段起点
      const b = points[i + 1] // 段终点
      const dx = b.x - a.x // 东西分量
      const dz = b.z - a.z // 南北分量
      const len = Math.hypot(dx, dz) // 这一段地面长度
      if (len < 0.08) continue // 极短段跳过，避免零长度圆柱
      try {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(radius, radius, len, 8), // 等半径圆柱
          new THREE.MeshBasicMaterial({ color }) // 不受光，蓝色始终鲜
        )
        mesh.position.set((a.x + b.x) / 2, y, (a.z + b.z) / 2) // 放在段中点
        alignCylinderToXZ(mesh, dx / len, dz / len) // 躺到这段方向
        group.add(mesh)
      } catch (error) {
        buildRoadSegment(a, b, width, color, group, y, 0) // 圆柱失败就退回方盒子
      }
    }
    addRouteCap(points[0], radius, y, color, group) // 起点圆头
    addRouteCap(points[points.length - 1], radius, y, color, group) // 终点圆头
  }

  /** 在蓝线上嵌一个白色扁箭头，指示行驶方向 */
  function addRouteArrow(p, tangent, y, group) {
    const dir = tangent.clone().setY(0) // 只取地面方向
    if (dir.length() < 0.01) return
    dir.normalize()
    const yaw = Math.atan2(dir.x, dir.z) // 箭头朝向
    const side = new THREE.Vector3(-dir.z, 0, dir.x) // 左右轴
    // 扁箭头嵌在蓝线顶面：两翼收在线宽内，厚度几乎贴管，不再悬空
    for (let s = -1; s <= 1; s += 2) { // 左右两翼
      const wing = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, 0.045, 0.48),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      )
      wing.position.set(
        p.x + side.x * s * 0.12 - dir.x * 0.02, // 左右分开并略往后
        y,
        p.z + side.z * s * 0.12 - dir.z * 0.02
      )
      wing.rotation.y = yaw + s * 0.68 // 两翼撇成 V
      group.add(wing)
    }
  }

  /** 两点之间贴地单位方向；重合点返回 null。路线偏到行驶方向右侧车道，避开路心黄虚线。 */
  function unitXZ(from, to) {
    const v = new THREE.Vector3(to.x - from.x, 0, to.z - from.z) // 水平向量
    if (v.length() < 1e-4) return null // 两点几乎重合
    return v.normalize() // 长度变成 1
  }

  /** 行驶方向的右侧单位向量（右手系：前进 × 上 = 右） */
  function rightOf(tan) {
    return new THREE.Vector3(-tan.z, 0, tan.x)
  }

  /** 两段偏右车道的交点，直角弯会落在「进段右侧 ∩ 出段右侧」，不会收到路心黄线上。 */
  function miterLanePoint(pivot, inTan, inOff, outTan, outOff) {
    const inR = rightOf(inTan) // 进段右侧
    const outR = rightOf(outTan) // 出段右侧
    const ax = pivot.x + inR.x * inOff // 进段偏置后的一条线经过的点
    const az = pivot.z + inR.z * inOff // 进段偏置点的 Z
    const bx = pivot.x + outR.x * outOff // 出段偏置后的一条线经过的点
    const bz = pivot.z + outR.z * outOff // 出段偏置点的 Z
    const cross = inTan.x * outTan.z - inTan.z * outTan.x // 两切线是否平行
    if (Math.abs(cross) < 0.08) {
      const off = Math.abs(outOff) >= Math.abs(inOff) ? outOff : inOff // 几乎共线就取较大偏置
      const r = Math.abs(outOff) >= Math.abs(inOff) ? outR : inR // 对应那条右侧法线
      return new THREE.Vector3(pivot.x + r.x * off, pivot.y, pivot.z + r.z * off) // 沿法线偏开
    }
    const t = ((bx - ax) * outTan.z - (bz - az) * outTan.x) / cross // 沿进段走到交点的参数
    const miterX = ax + inTan.x * t // 斜接交点
    const miterZ = az + inTan.z * t
    const maxMiter = Math.max(inOff, outOff, 0) * 2.4 + 1 // 尖角不能飞出太远
    if (Math.hypot(miterX - pivot.x, miterZ - pivot.z) > maxMiter) {
      return new THREE.Vector3( // 交点太尖就改成两偏置相加的折中点
        pivot.x + inR.x * inOff + outR.x * outOff,
        pivot.y,
        pivot.z + inR.z * inOff + outR.z * outOff
      )
    }
    return new THREE.Vector3(miterX, pivot.y, miterZ) // 正常斜接点
  }

  /** 整条折线按段偏到右侧车道；offsetM 可以是固定米数，也可以按段回调 */
  function offsetPolylineRight(points, offsetM) {
    if (!points || points.length < 2 || !offsetM) return points || [] // 没点或偏置为 0 就原样
    const n = points.length // 折线点数
    const segOff = [] // 每一段该偏多少米
    for (let i = 0; i < n - 1; i += 1) {
      const mid = new THREE.Vector3( // 段中点，用来查这段在哪条路上
        (points[i].x + points[i + 1].x) * 0.5,
        0,
        (points[i].z + points[i + 1].z) * 0.5
      )
      const off = typeof offsetM === 'function' ? Number(offsetM(i, mid)) || 0 : Number(offsetM) || 0 // 回调按段算，或固定米数
      segOff.push(off) // 记下这一段偏置
    }
    const out = [] // 偏置后的新折线
    for (let i = 0; i < n; i += 1) { // 每个顶点用斜接算出偏置后位置
      const inTan = i > 0 ? unitXZ(points[i - 1], points[i]) : unitXZ(points[i], points[i + 1]) // 起点用出段方向
      const outTan = i < n - 1 ? unitXZ(points[i], points[i + 1]) : inTan // 终点用进段方向
      if (!inTan || !outTan) {
        out.push(points[i].clone()) // 退化点不偏
        continue
      }
      const inOff = i > 0 ? segOff[i - 1] : segOff[0] // 进段偏置；起点借用第一段
      const outOff = i < n - 1 ? segOff[i] : segOff[n - 2] // 出段偏置；终点借用最后一段
      if (!inOff && !outOff) {
        out.push(points[i].clone()) // 两段都是单向路心，不用偏
        continue
      }
      out.push(miterLanePoint(points[i], inTan, inOff, outTan, outOff))
    }
    return out
  }

  /** 把一个世界点垂到某条路折线上，返回最近点、距离、切线 */
  function projectToRoadPath(worldPoint, path) {
    let best = null // 目前最近的投影
    let bestD = Infinity
    for (let i = 0; i < path.length - 1; i += 1) { // 逐段投影
      const a = toWorld(path[i], 0) // 段起点世界坐标
      const b = toWorld(path[i + 1], 0)
      const dx = b.x - a.x
      const dz = b.z - a.z
      const len2 = dx * dx + dz * dz // 段长平方
      const t = len2 < 1e-8 ? 0 : Math.max(0, Math.min(1, ((worldPoint.x - a.x) * dx + (worldPoint.z - a.z) * dz) / len2)) // 夹到 [0,1]
      const on = new THREE.Vector3(a.x + t * dx, 0, a.z + t * dz) // 段上最近点
      const d = Math.hypot(worldPoint.x - on.x, worldPoint.z - on.z) // 点到这段的距离
      if (d < bestD) {
        bestD = d
        const tan = new THREE.Vector3(dx, 0, dz)
        if (tan.length() > 1e-4) tan.normalize() // 这段的单位切线
        best = { on, dist: d, tangent: tan, a, b }
      }
    }
    return best
  }

  /** 在全场道路里找离该点最近的一条，可限制最大距离、只要双向 */
  function nearestRoadHit(worldPoint, maxDist, twoWayOnly) {
    const roads = (state.map && state.map.roads) || [] // 当前场图全部道路
    let best = null
    let bestD = maxDist == null ? 8 : maxDist // 默认 8 米内才算上路
    roads.forEach(road => {
      const dir = Number(road.directionType) // 1/2 单向
      const oneWay = dir === 1 || dir === 2
      if (twoWayOnly && oneWay) return // 只要双向时跳过单行
      const hit = projectToRoadPath(worldPoint, road.path || [])
      if (hit && hit.dist < bestD) {
        bestD = hit.dist
        best = Object.assign({ road, oneWay }, hit) // 带上路对象
      }
    })
    return best
  }

  /** 场图 directionType 为 1 或 2 就是单向 */
  function isOneWayRoad(road) {
    const dir = Number(road && road.directionType) // 场图方向类型
    return dir === 1 || dir === 2 // 1、2 都当单向
  }

  /** 单向路心 0；双向行驶方向右侧，偏该路路宽的 1/4。 */
  function laneOffsetOfRoad(road) {
    if (!road || isOneWayRoad(road)) return 0
    const width = Number(road.widthM) // 场图维护的路宽（米）
    return width >= 2 ? width * 0.25 : 2.7 // 没路宽就按 2.7 米偏
  }

  /** 按「离得近 + 走向一致」选本车正在走的那条路 */
  function roadAlongTravel(worldPoint, tan) {
    const roads = (state.map && state.map.roads) || []
    let best = null
    let bestScore = Infinity
    const ux = tan && tan.x != null ? tan.x : 0 // 行驶方向 x
    const uz = tan && tan.z != null ? tan.z : 0
    roads.forEach(road => {
      const hit = projectToRoadPath(worldPoint, road.path || [])
      if (!hit || hit.dist > 22) return // 超过 22 米不当这条
      const t = hit.tangent
      const align = t ? Math.abs(t.x * ux + t.z * uz) : 0 // 1=同向或反向平行
      const score = hit.dist + (1 - align) * 10 // 方向差要加罚分
      if (score < bestScore) {
        bestScore = score
        best = Object.assign({ road, oneWay: isOneWayRoad(road) }, hit)
      }
    })
    return best
  }

  /** 蓝线某段中点该偏多少：先按行驶方向认路，认不到再就近 */
  function laneOffsetAlong(mid, tan) {
    const hit = roadAlongTravel(mid, tan) || nearestRoadHit(mid, 12, false) // 先认行驶路，再就近
    return hit ? laneOffsetOfRoad(hit.road) : 0 // 认不到路就不偏
  }

  /** 路心交点按进出路单/双向偏到该走的车道，双向接双向不会被拉回黄虚线。 */
  function offsetJunction(center, fromPt, toPt, fromRoad, toRoad) {
    if (!center) return center
    const inTan = unitXZ(fromPt, center) || unitXZ(fromPt, toPt) // 进路口方向
    const outTan = unitXZ(center, toPt) || inTan // 出路口方向
    if (!inTan || !outTan) return center
    const inOff = laneOffsetOfRoad(fromRoad) // 进路该偏多少
    const outOff = laneOffsetOfRoad(toRoad)
    if (!inOff && !outOff) return center // 都是单向就停在路心交点
    return miterLanePoint(center, inTan, inOff, outTan, outOff)
  }

  /** 把 (u, v) 归一化坐标换算成世界坐标，u 沿贝方向、v 沿排方向。 */
  function cornerAt(corners, u, v) {
    const p = lerp2(lerp2(corners.sw, corners.se, u), lerp2(corners.nw, corners.ne, u), v) // 先沿贝插，再沿排插
    return toWorld({ x: p[0], y: p[1] }, 0)
  }

  /**
   * 场区箱位格网。不用 LineSegments：小程序这套 Three.js 对 BufferAttribute
   * 支持不完整，整段建图会在这里抛错，后面的箱子就全画不出来。
   */
  function buildSlotGrid(corners, slots, rows, colorHex) {
    for (let i = 0; i <= slots; i += 1) { // 沿贝方向的竖格线（含两边）
      const a = cornerAt(corners, i / slots, 0) // 路边一端
      const b = cornerAt(corners, i / slots, 1) // 另一边
      const line = makeUnlitBox(0.16, 0.05, Math.max(a.distanceTo(b), 0.4), colorHex) // 细条当线
      const mid = a.clone().add(b).multiplyScalar(0.5) // 竖线中点
      line.position.set(mid.x, 0.18, mid.z)
      line.rotation.y = Math.atan2(b.x - a.x, b.z - a.z) // 转到格线走向
      mapGroup.add(line)
    }
    for (let j = 0; j <= rows; j += 1) { // 沿排方向的横格线
      const a = cornerAt(corners, 0, j / rows) // 横线一端
      const b = cornerAt(corners, 1, j / rows)
      const line = makeUnlitBox(0.16, 0.05, Math.max(a.distanceTo(b), 0.4), colorHex) // 同样用细盒子当线
      const mid = a.clone().add(b).multiplyScalar(0.5)
      line.position.set(mid.x, 0.18, mid.z)
      line.rotation.y = Math.atan2(b.x - a.x, b.z - a.z)
      mapGroup.add(line)
    }
  }

  /** 在格子中心立一层集装箱：优先用 GLB 模板，没有就用彩色方块顶上 */
  function addIsoContainer(center, yaw, alongU, alongV, layerH, floor, forty, color) {
    const template = state.containerTemplates && (forty ? state.containerTemplates.c40 : state.containerTemplates.c20) // 按尺码取模板
    const model = template && vehicleLoader.instantiateTemplate(THREE, template, color, materialOpts) // 复制一份上色
    const y = 0.2 + layerH * (floor + 0.5) + floor * 0.04 // 方块占位时的中心高度
    if (model) {
      const nativeL = forty ? 12.192 : 6.058 // GLB 原始长度（米）
      const nativeW = 2.438 // 原始宽
      const nativeH = 2.591 // 原始高
      model.scale.set(alongV / nativeW, layerH / nativeH, alongU / nativeL) // 缩放到格子大小
      model.position.set(center.x, 0.2 + floor * (layerH + 0.04), center.z) // 按层叠高，层间留缝
      model.rotation.y = yaw // 对齐贝方向
      mapGroup.add(model)
      return
    }
    const box = makeBox(alongV, layerH, alongU, color) // 模型没就绪就用盒子
    box.position.set(center.x, y, center.z)
    box.rotation.y = yaw
    mapGroup.add(box)
  }

  /**
   * 箱区渲染：对齐 Web 端场位图——白色地坪 + 箱位格网，
   * 有箱的格子才立一个彩色箱块，高度按实际堆放层数，空箱位只留格线。
   */
  /** 遍历全部箱区画地坪和箱子；某个区报错只打日志，不拖垮整张图 */
  function buildBlocksClean(blocks, targetBlockId, targetSlot) {
    ;(blocks || []).forEach(block => { // 逐个箱区画，单个失败不影响其它区
      try {
        buildOneBlock(block, targetBlockId, targetSlot)
      } catch (error) {
        console.error('[yardScene] build block failed', (block && block.blockCode) || '', error)
      }
    })
  }

  /** 画一个箱区：地坪、空箱位白板、有箱的格子叠箱、贝位号、区名 */
  function buildOneBlock(block, targetBlockId, targetSlot) {
      const polygon = (block.polygon || []).map(xyOf) // 四个角转成米制
      if (polygon.length < 4 || polygon.some(p => !p)) return // 缺角就不画这个区
      const corners = { // 约定顺序：西南、东南、东北、西北
        sw: [polygon[0].x, polygon[0].y],
        se: [polygon[1].x, polygon[1].y],
        ne: [polygon[2].x, polygon[2].y],
        nw: [polygon[3].x, polygon[3].y]
      }
      const slots = Math.max(block.slotCount || 1, 1) // 贝数，至少 1
      const rows = Math.max(block.rowCount || 1, 1) // 排数
      const palette = block.isSafetyArea
        ? { label: '#166534', deck: 0xc7ebd6, grid: 0x7a9a86 }
        : blockPalette(block) // 验箱区用淡绿地坪，其它区按代号配色

      const cornerWorld = c => toWorld({ x: c[0], y: c[1] }, 0) // 角点转世界坐标
      let psw = cornerWorld(corners.sw)
      let pse = cornerWorld(corners.se)
      let pnw = cornerWorld(corners.nw)
      // 长边必须是贝、短边是排；若接口多边形对调了，这里把 u/v 拧回来
      if (psw.distanceTo(pse) + 0.5 < psw.distanceTo(pnw)) {
        corners.se = [polygon[3].x, polygon[3].y] // 交换东南/西北，把长边拧到贝向
        corners.nw = [polygon[1].x, polygon[1].y]
        psw = cornerWorld(corners.sw)
        pse = cornerWorld(corners.se)
        pnw = cornerWorld(corners.nw)
      }
      const addDeckSpan = (u0, u1) => {
        if (u1 - u0 < 0.012) return
        const a = cornerAt(corners, u0, 0)
        const b = cornerAt(corners, u1, 0)
        const c = cornerAt(corners, u0, 1)
        const center = cornerAt(corners, (u0 + u1) / 2, 0.5)
        const deck = makeUnlitBox(Math.max(a.distanceTo(c), 1) + 0.4, 0.08, Math.max(a.distanceTo(b), 1) + 0.4, palette.deck)
        deck.position.set(center.x, 0.08, center.z)
        deck.rotation.y = Math.atan2(b.x - a.x, b.z - a.z)
        mapGroup.add(deck)
      }
      const corridor = corridorSlotRange(block)
      if (corridor) {
        addDeckSpan(0, (corridor.fromIdx - 1) / corridor.slots) // 通道西侧地坪
        addDeckSpan(corridor.toIdx / corridor.slots, 1) // 通道东侧地坪，中间留路
      } else {
        addDeckSpan(0, 1)
      }

      const maxFloor = Math.max(block.maxFloor || 4, 1) // 最多堆几层，用来限高和挂区名
      const stacks = block.stacks || [] // 有箱的垛
      const occupied = {} // 已画过的格子，40 尺占两格只画一次

      if (!block.isSafetyArea) {
      for (let si = 1; si <= slots; si += 1) { // 每个贝
        if (corridor && si >= corridor.fromIdx && si <= corridor.toIdx) continue // 穿区通道不画箱位
        for (let ri = 1; ri <= rows; ri += 1) { // 每个排
          const u0 = (si - 1) / slots // 格子贝向起点比例
          const u1 = si / slots
          const v0 = (ri - 1) / rows // 格子排向起点比例
          const v1 = ri / rows
          const w0 = cornerAt(corners, u0, v0) // 格子一角
          const w1 = cornerAt(corners, u1, v0)
          const w3 = cornerAt(corners, u0, v1)
          const center = cornerAt(corners, (u0 + u1) / 2, (v0 + v1) / 2) // 格心
          const cellU = Math.max(w0.distanceTo(w1), 0.6) // 贝向边长
          const cellV = Math.max(w0.distanceTo(w3), 0.6) // 排向边长
          const cellYaw = Math.atan2(w1.x - w0.x, w1.z - w0.z) // 格子朝向
          const plate = makeUnlitBox(cellV * 0.94, 0.05, cellU * 0.94, 0xffffff) // 空箱位白底板，略缩小露出缝
          plate.position.set(center.x, 0.14, center.z)
          plate.rotation.y = cellYaw
          mapGroup.add(plate)
        }
      }
      }

      stacks.forEach(stack => { // 有箱才立彩色箱块
        if (block.isSafetyArea) return
        const ri = normalizeCellIndex(stack.rowIndex, rows) // 排号归一到 1..rows
        const forty = isFortyFoot(stack) // 40 尺要占两个 20 尺小贝
        const startSi = startCellIndex(stack, slots, forty) // 从哪个小贝开始
        if (ri < 1 || startSi < 1) return // 排/贝对不上就不画
        if (corridor && startSi >= corridor.fromIdx && startSi <= corridor.toIdx) return
        const span = forty ? 2 : 1 // 占几格
        if (startSi + span - 1 > slots) return // 超出贝数
        const key = `${startSi}-${ri}`
        if (occupied[key]) return // 这格已经画过（大贝重复上报）
        occupied[key] = true
        if (span === 2) occupied[`${startSi + 1}-${ri}`] = true // 40 尺把下一格也占掉

        const u0 = (startSi - 1) / slots
        const u1 = (startSi + span - 1) / slots // 40 尺跨到下一贝末尾
        const v0 = (ri - 1) / rows
        const v1 = ri / rows
        const w0 = cornerAt(corners, u0, v0)
        const w1 = cornerAt(corners, u1, v0)
        const w3 = cornerAt(corners, u0, v1)
        const center = cornerAt(corners, (u0 + u1) / 2, (v0 + v1) / 2)
        const cellU = Math.max(w0.distanceTo(w1), 0.6)
        const cellV = Math.max(w0.distanceTo(w3), 0.6)
        const cellYaw = Math.atan2(w1.x - w0.x, w1.z - w0.z)
        const floors = Math.min(Math.max(Number(stack.floors) || 1, 1), maxFloor) // 层数夹在 1..maxFloor
        const alongU = cellU * (span === 2 ? 0.96 : 0.92) // 箱子比格子略小，露出白边
        const alongV = cellV * 0.86
        const layerH = CNTR_LAYER_H * 0.96 // 单层略矮，堆起来不顶死
        const color = stackColor(stack)
        for (let floor = 0; floor < floors; floor += 1) { // 从下往上叠
          addIsoContainer(center, cellYaw, alongU, alongV, layerH, floor, forty, color.side)
        }
      })

      if (!block.isSafetyArea) {
      const outDir = Number(block.outDirection) // 通道在哪一侧，贝位号写在靠路那边
      const roadOnLowV = outDir === 2 || outDir === 0 || Number.isNaN(outDir)
      const vMark = roadOnLowV ? -0.058 : 1.058 // 略伸出地坪外，写在路边
      for (let i = 1; i <= slots; i += 1) {
        if (corridor && i >= corridor.fromIdx && i <= corridor.toIdx) continue
        const slotNo = String(i * 2 - 1).padStart(2, '0') // 小贝号 01/03/05...
        const mark = cornerAt(corners, (i - 0.5) / slots, vMark) // 该贝路边中点
        const spriteBay = makeTextSprite(slotNo, '#111827', {
          scaleX: 5.6,
          scaleY: 1.42,
          plate: false, // 贝位号不带白底板，避免挡路
          fixed: true, // 不随相机缩放，近看才清楚
          font: 'bold 32px sans-serif'
        })
        if (spriteBay) {
          spriteBay.position.set(mark.x, 0.34, mark.z)
          mapGroup.add(spriteBay)
        }
      }
      }

      const baseCenter = cornerAt(corners, 0.5, 0.5)
      const labelText = block.isSafetyArea ? '验箱区' : shortBlockLabel(block)
      const sprite = makeTextSprite(labelText, palette.label, { scaleX: 10, scaleY: 2.5 })
      if (sprite) {
        sprite.position.set(baseCenter.x, CNTR_LAYER_H * maxFloor + 3.2, baseCenter.z) // 挂在最高箱之上
        mapGroup.add(sprite)
      }
      addSafetyGates(block)
  }

  /** 贝位号：奇数 01/03 是 20 尺小贝；偶数 02 是 01+03 合并的 40 尺大贝。 */
  function slotIndexOf(block, slot) {
    const hit = (block.stacks || []).find(item => String(item.slot) === String(slot)) // 先看垛上有没有现成格子序号
    if (hit && hit.slotIndex) return Number(hit.slotIndex)
    const numeric = parseInt(String(slot), 10)
    if (!numeric) return -1 // 不是数字贝号
    const index = Math.floor((numeric + 1) / 2) // 01/02→1，03/04→2
    return index >= 1 && index <= (block.slotCount || 0) ? index : -1
  }

  /** 判断这垛是不是 40 尺：尺寸码带 40，或贝号是偶数大贝 */
  function isFortyFoot(stack) {
    const size = String((stack && stack.sizeCode) || '').toUpperCase()
    if (size.indexOf('40') >= 0) return true
    const n = parseInt(String(stack && stack.slot), 10)
    return Boolean(n && n % 2 === 0)
  }

  /** 把排号/贝序号收成 1..count；0 当 1，越界返回 -1 */
  function normalizeCellIndex(value, count) {
    const n = Number(value)
    if (!count) return -1
    if (n === 0) return 1 // 有的接口从 0 起
    if (n >= 1 && n <= count) return n
    return -1
  }

  /** 这垛从第几个小贝格子开始画；40 尺偶数贝要退到奇数小贝 */
  function startCellIndex(stack, slotCount, forty) {
    const n = parseInt(String(stack && stack.slot), 10)
    if (n) {
      const startBay = n % 2 === 0 ? n - 1 : n // 02→01，04→03
      return Math.floor((startBay + 1) / 2) // 再换成格子序号
    }
    const idx = normalizeCellIndex(stack && stack.slotIndex, slotCount)
    if (idx < 1) return -1
    return forty && idx > 1 ? idx - 1 : idx // 只有格子序号时，40 尺往前占一格
  }

  /** 同步重建整张场图：清静态层，再画路、箱区、道口、蓝线、动态物 */
  function rebuildMapSync() {
    clearGroup(mapGroup) // 先拆掉旧路旧箱
    const map = state.map
    if (!map) return // 还没下场图
    const bounds = yardBounds(map)
    if (!bounds) return // 没有有效点
    state.bounds = bounds // 记下包围盒给道口/场外判断用
    buildPavement() // 目前是空实现
    buildRoads(map.roads) // 画路
    buildBlocksClean(map.blocks, state.targetBlockId, state.targetSlot) // 画箱区
    buildCrossing() // 画出场道口，优先用场图建筑坐标
    rebuildRoute() // 重画蓝线
    rebuildDynamic() // 重画终点钉、堆高机、本车
    state.dirty = true // 下一帧刷新
  }

  /** 异步分帧建图，避免进入导航页时主线程长时间阻塞导致白屏、按钮无响应。 */
  function rebuildMap() {
    state.mapBuildToken += 1 // 新一代建图，作废还在排队的旧任务
    const token = state.mapBuildToken
    state.mapBuilding = true // 建图中也要继续刷帧，避免白屏
    const run = () => {
      if (token !== state.mapBuildToken) return // 已被更新的建图取代
      try {
        rebuildMapSync()
      } catch (error) {
        console.error('[yardScene] rebuildMap failed', error)
      } finally {
        if (token === state.mapBuildToken) state.mapBuilding = false // 只有自己这趟结束才清标志
      }
    }
    if (typeof wx !== 'undefined' && wx.nextTick) {
      wx.nextTick(run) // 小程序下一拍再干重活
    } else {
      setTimeout(run, 0) // 其它环境丢到宏任务
    }
  }

  /** 掐掉终点前那截又短又急拐的尾巴，那是规划接到箱位里的 stub */
  function trimDestinationStub(points) {
    if (!points || points.length < 3) return points || []
    const a = points[points.length - 3] // 倒数第三点
    const b = points[points.length - 2]
    const c = points[points.length - 1] // 终点
    const ab = b.clone().sub(a)
    const bc = c.clone().sub(b)
    ab.y = 0
    bc.y = 0
    if (bc.length() < 20 && ab.length() > 0.8) { // 最后一段很短
      const cos = ab.normalize().dot(bc.normalize())
      if (cos < 0.4) return points.slice(0, -1) // 夹角太大就丢掉终点 stub
    }
    return points
  }

  /**
   * 丢掉「定位点垂直接上路」或 180° 回头，90° 路口转弯必须留着。
   * 旧逻辑 dot<0.5 会把东向单行接到东主通道的右转也掐掉，蓝线就会吸到 20m 外的南通道、斜穿空地。
   */
  function dropLeadStub(points) {
    if (!points || points.length < 3) return points || []
    const ab = points[1].clone().sub(points[0]) // 第一段
    const bc = points[2].clone().sub(points[1]) // 第二段
    ab.y = 0
    bc.y = 0
    const abLen = ab.length()
    const bcLen = bc.length()
    if (abLen < 0.8 || bcLen < 0.8) return points // 段太短不敢删
    const dot = ab.normalize().dot(bc.normalize()) // 1 同向，-1 回头
    const stubIntoBlock = insideYardBlock(points[0]) && !insideYardBlock(points[1]) // 起点在箱区里、第二点已上路
    if (dot < -0.5 || (stubIntoBlock && abLen < 18 && dot < 0.2)) {
      return points.slice(1) // 掉头或从箱区垂直接上路，丢掉起点
    }
    return points
  }

  /** 点是否在凸多边形内（看每条边叉积符号是否一致） */
  function pointInConvex(p, ring) {
    let sign = 0 // 0 表示还没定左右
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length] // 闭环到第一个点
      const cross = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x)
      if (Math.abs(cross) < 1e-6) continue // 几乎在边上，不判
      const s = cross > 0 ? 1 : -1
      if (!sign) sign = s // 记下第一边的左右
      else if (s !== sign) return false // 有一边在对面，点在多边形外
    }
    return sign !== 0 // 全在同一侧且不是退化成一条线
  }

  /** 多边形往中心缩一圈，避免路边点被算进箱区 */
  function insetRing(ring, insetM) {
    const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length // 几何中心 x
    const cz = ring.reduce((s, p) => s + p.z, 0) / ring.length
    return ring.map(p => {
      const dx = p.x - cx
      const dz = p.z - cz
      const len = Math.hypot(dx, dz) || 1 // 到中心距离
      const t = Math.max(0, 1 - insetM / len) // 沿半径往里收 insetM 米
      return new THREE.Vector3(cx + dx * t, p.y, cz + dz * t)
    })
  }

  /** 这个世界坐标是不是落在某个箱区地坪里（内缩后） */
  function insideYardBlock(worldPos) {
    if (pointOnMaintainedRoad(worldPos)) return false // 路优先于箱区：画在箱区边上的路不当穿箱
    const blocks = (state.map && state.map.blocks) || []
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].isSafetyArea) continue // 验箱区是空地，蓝线可以贴边
      if (pointInBlockCorridor(blocks[i], worldPos)) continue // 穿区通道是路，不是箱垛
      const polygon = blocks[i].polygon || []
      if (polygon.length < 4) continue
      const ring = polygon.map(pt => toWorld(pt, 0))
      if (pointInConvex(worldPos, insetRing(ring, 2.2))) return true // 内缩 2.2 米再判
    }
    return false
  }

  /** 已维护道路上的点不算穿箱 */
  function pointOnMaintainedRoad(worldPos) {
    const snap = nearestRoadSnap(worldPos)
    if (!snap) return false
    const width = Number(snap.road && snap.road.widthM)
    const limit = Number.isFinite(width) && width > 0 ? Math.max(4, width * 0.55) : 8
    return snap.dist <= limit
  }

  /** 穿区通道贝号区间换成地坪上的一条带，点落在带里就不算箱区 */
  function pointInBlockCorridor(block, worldPos) {
    const ring = corridorWorldRing(block)
    return Boolean(ring && pointInConvex(worldPos, ring))
  }

  function corridorSlotRange(block) {
    const from = Number(block && block.corridorFromSlot)
    const to = Number(block && block.corridorToSlot)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null
    const slots = Math.max(Number(block.slotCount) || 1, 1)
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    const fromIdx = Math.max(1, Math.round((lo + 1) / 2))
    const toIdx = Math.max(fromIdx, Math.round((hi + 1) / 2))
    return { fromIdx, toIdx, slots }
  }

  function corridorWorldRing(block) {
    const range = corridorSlotRange(block)
    const polygon = (block && block.polygon) || []
    if (!range || polygon.length < 4) return null
    const sw = xyOf(polygon[0])
    const se = xyOf(polygon[1])
    const ne = xyOf(polygon[2])
    const nw = xyOf(polygon[3])
    if (!sw || !se || !ne || !nw) return null
    const corners = {
      sw: [sw.x, sw.y],
      se: [se.x, se.y],
      ne: [ne.x, ne.y],
      nw: [nw.x, nw.y]
    }
    const u0 = (range.fromIdx - 1) / range.slots
    const u1 = range.toIdx / range.slots
    return [
      cornerAt(corners, u0, 0),
      cornerAt(corners, u1, 0),
      cornerAt(corners, u1, 1),
      cornerAt(corners, u0, 1)
    ]
  }

  /** 飞线不直接丢掉：两端都在路上时，沿马路补拐点（芦潮港 Road1→Road6→Road3）。 */
  function dropOffRoadChords(points) {
    if (!points || points.length < 2) return points || []
    let start = 0
    while (start < points.length - 1 && !pointOnRoad(points[start]) && chordOffRoad(points[start], points[start + 1])) {
      start += 1 // 从前往后丢掉不在路上的飞线头
    }
    let end = points.length
    while (end > start + 1 && !pointOnRoad(points[end - 1]) && chordOffRoad(points[end - 2], points[end - 1])) {
      end -= 1 // 从后往前丢掉飞线尾
    }
    const trimmed = points.slice(start, end)
    if (trimmed.length < 2) return points // 剪完不够一段就退回原折线
    const filtered = [cloneVec(trimmed[0])]
    for (let i = 1; i < trimmed.length; i += 1) {
      const prev = filtered[filtered.length - 1]
      const cur = trimmed[i]
      if (!chordOffRoad(prev, cur)) {
        if (prev.distanceTo(cur) > 0.6) filtered.push(cloneVec(cur)) // 这段贴路，直接接上
        continue
      }
      const via = viaAlongRoads(prev, cur) // 飞线：沿马路补路口拐点
      if (via && via.length) {
        for (let v = 0; v < via.length; v += 1) {
          if (filtered[filtered.length - 1].distanceTo(via[v]) > 0.8) {
            filtered.push(cloneVec(via[v])) // 补上路口点
          }
        }
        if (filtered[filtered.length - 1].distanceTo(cur) > 0.8) filtered.push(cloneVec(cur))
        continue
      }
      if (pointOnRoad(prev) && pointOnRoad(cur)) {
        if (prev.distanceTo(cur) > 0.6) filtered.push(cloneVec(cur)) // 两端都在路上但找不到中转，仍接上避免断线
      }
    }
    return filtered.length >= 2 ? filtered : trimmed
  }

  /** 克隆三维点，没有 clone 方法就按 xyz 新建 */
  function cloneVec(p) {
    return p.clone ? p.clone() : new THREE.Vector3(p.x, p.y, p.z)
  }

  /** 点离最近路中心线 8 米内就算在路上 */
  function pointOnRoad(p) {
    const snap = nearestRoadSnap(p)
    return Boolean(snap && snap.dist <= 8)
  }

  /** 两条路记录是不是同一条走廊（比对象引用、edgeCode、路名） */
  function sameNamedRoad(a, b) {
    if (!a || !b) return false
    if (a === b) return true // 同一个对象
    if (a.edgeCode && b.edgeCode && a.edgeCode === b.edgeCode) return true
    if ((a.edgeName || a.roadName) && (a.edgeName || a.roadName) === (b.edgeName || b.roadName)) return true
    return false
  }

  /** 同一条命名路可能被拆成多段，求交时要把碎片都拿来 */
  function roadPieces(road) {
    const roads = (state.map && state.map.roads) || []
    const pieces = roads.filter(item => sameNamedRoad(item, road))
    return pieces.length ? pieces : (road ? [road] : [])
  }

  /** 点到线段的最近点（只看 XZ 地面） */
  function projectToSegXZ(p, a, b) {
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len2 = dx * dx + dz * dz
    const t = len2 < 1e-8 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2))
    const on = new THREE.Vector3(a.x + t * dx, 0, a.z + t * dz)
    return { on, dist: Math.hypot(p.x - on.x, p.z - on.z), t }
  }

  /** 两段地面线段求交；平行时看端点是否贴在 2.2 米内 */
  function segmentIntersectXZ(a0, a1, b0, b1) {
    const ax = a1.x - a0.x
    const az = a1.z - a0.z
    const bx = b1.x - b0.x
    const bz = b1.z - b0.z
    const den = ax * bz - az * bx // 行列式，接近 0 就是平行
    if (Math.abs(den) < 1e-8) {
      const hits = [projectToSegXZ(a0, b0, b1), projectToSegXZ(a1, b0, b1),
        projectToSegXZ(b0, a0, a1), projectToSegXZ(b1, a0, a1)] // 四个端点互相投影
      const near = hits.filter(h => h.dist <= 2.2).sort((l, r) => l.dist - r.dist)[0]
      return near ? near.on : null // 贴得够近就算相交（路口错开一点点）
    }
    const dx = b0.x - a0.x
    const dz = b0.z - a0.z
    const t = (dx * bz - dz * bx) / den // 在第一段上的参数
    const u = (dx * az - dz * ax) / den // 在第二段上的参数
    if (t < -0.02 || t > 1.02 || u < -0.02 || u > 1.02) return null // 交点不在两段上（略放宽端点）
    const tt = Math.max(0, Math.min(1, t))
    return new THREE.Vector3(a0.x + tt * ax, 0, a0.z + tt * az)
  }

  /** 两条不同名的路在地面上的交点（取离路网最近的那个） */
  function roadIntersection(roadA, roadB) {
    if (!roadA || !roadB || sameNamedRoad(roadA, roadB)) return null // 同一条路没有「交点」
    const left = roadPieces(roadA)
    const right = roadPieces(roadB)
    let best = null
    let bestDist = Infinity
    for (let i = 0; i < left.length; i += 1) {
      const pa = left[i].path || []
      for (let ia = 0; ia < pa.length - 1; ia += 1) {
        const a0 = toWorld(pa[ia], 0)
        const a1 = toWorld(pa[ia + 1], 0)
        for (let j = 0; j < right.length; j += 1) {
          const pb = right[j].path || []
          for (let ib = 0; ib < pb.length - 1; ib += 1) { // 两段两段求交
            const hit = segmentIntersectXZ(a0, a1, toWorld(pb[ib], 0), toWorld(pb[ib + 1], 0))
            if (!hit) continue
            const d = nearestRoadSnap(hit)
            if (d && d.dist < bestDist) {
              bestDist = d.dist
              best = hit
            }
          }
        }
      }
    }
    return best
  }

  /** 两点不在同一条路时，沿路网补 1～2 个路口，避免蓝线斜穿空地 */
  function viaAlongRoads(a, b) {
    const aSnap = nearestRoadSnap(a)
    const bSnap = nearestRoadSnap(b)
    if (!aSnap || !bSnap || aSnap.dist > 10 || bSnap.dist > 10) return null // 端点不在路上没法补
    if (sameNamedRoad(aSnap.road, bSnap.road)) return [] // 已在同一条路，不用中转
    const direct = roadIntersection(aSnap.road, bSnap.road)
    if (direct) return [offsetJunction(direct, a, b, aSnap.road, bSnap.road)] // 直接相交，补一个偏置路口
    const roads = (state.map && state.map.roads) || []
    let best = null
    let bestLen = Infinity
    const seen = new Set() // 同名路只试一次
    for (let i = 0; i < roads.length; i += 1) {
      const mid = roads[i] // 尝试当中转路
      const key = mid.edgeCode || mid.edgeName || mid.id || i
      if (seen.has(key) || sameNamedRoad(mid, aSnap.road) || sameNamedRoad(mid, bSnap.road)) continue
      seen.add(key)
      const ia = roadIntersection(aSnap.road, mid)
      const ib = roadIntersection(mid, bSnap.road)
      if (!ia || !ib) continue // 中转路必须两头都能接上
      const len = a.distanceTo(ia) + ia.distanceTo(ib) + ib.distanceTo(b)
      if (len < bestLen) {
        bestLen = len
        const ja = offsetJunction(ia, a, ib, aSnap.road, mid) // 路口偏到该走的车道
        const jb = offsetJunction(ib, ia, b, mid, bSnap.road)
        best = ja.distanceTo(jb) > 0.8 ? [ja, jb] : [ja] // 两个路口太近就合成一个
      }
    }
    return best
  }

  /** 两点连线是不是「飞线」：穿箱区、中点离路远、或两端不在同一条走廊 */
  function chordOffRoad(a, b) {
    if (!a || !b) return false
    const hop = a.distanceTo(b)
    if (segmentHitsBlock(a, b)) return true // 穿过箱区地坪
    if (hop <= 6) return false // 很短的一跳不当飞线
    const mid = a.clone().lerp(b, 0.5)
    const snap = nearestRoadSnap(mid)
    if (!snap || snap.dist > 5.5) return true // 中点不在路上
    const aSnap = nearestRoadSnap(a)
    const bSnap = nearestRoadSnap(b)
    if (!aSnap || !bSnap || aSnap.dist > 8 || bSnap.dist > 8) return true // 端点也不上路
    if (aSnap.road && bSnap.road && aSnap.road !== bSnap.road && hop > 10) {
      const samePath = (aSnap.road.edgeCode && aSnap.road.edgeCode === bSnap.road.edgeCode)
      if (!samePath) return true // 跳到另一条路且超过 10 米
    }
    return false
  }

  /** 蓝线只留马路上的点，掐掉穿进箱区的头尾。 */
  function keepOnRoads(points) {
    if (!points || points.length < 2) return points || []
    let start = 0
    let end = points.length
    while (start < end - 1 && insideYardBlock(points[start])) start += 1 // 丢掉箱区里的起点
    while (end > start + 1 && insideYardBlock(points[end - 1])) end -= 1 // 丢掉箱区里的终点
    return points.slice(start, end)
  }

  /** 竖直小圆柱当圆角接缝，几何失败就退回方块 */
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

  /** 把世界点吸到最近路中心线；超过 48 米当不在路上。同时记下距离给状态栏 */
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
          bestTan = new THREE.Vector3(dx / len, 0, dz / len) // 这段单位切线
        }
      }
    }
    state.roadSnapM = Number.isFinite(bestDist) ? bestDist : null // 给 getStatus 看离路多远
    return best && bestDist < 48
      ? { pos: best, dist: bestDist, road: bestRoad, tangent: bestTan }
      : null
  }

  /** 把东/西主通道的多种命名收成同一个走廊键，避免平行路被当成同一条 */
  function roadCorridorKey(road) {
    if (!road) return ''
    const tag = `${road.edgeCode || ''}|${road.edgeName || ''}|${road.roadName || ''}`
    if (/R-EAST|Road03|东主/i.test(tag)) return 'MAIN-E' // 东主通道一家
    if (/R-WEST|Road02|西主/i.test(tag)) return 'MAIN-W'
    return tag || 'other'
  }

  /** 折线段是否与集卡在同一条路上（优先比 edgeCode，避免只认 truck 那一条路的对象引用） */
  function segmentOnTruckRoad(a, b, truckPos) {
    const truckHit = nearestRoadSnap(truckPos)
    if (!truckHit || !truckHit.road) return true // 车还没吸上路，先当同路，避免蓝线全被滤掉
    const mid = new THREE.Vector3((a.x + b.x) * 0.5, 0, (a.z + b.z) * 0.5) // 这段中点
    const segHit = nearestRoadSnap(mid)
    if (!segHit || !segHit.road) return false
    const tk = roadCorridorKey(truckHit.road)
    const sk = roadCorridorKey(segHit.road)
    if (tk && sk && tk === sk) return true // 同一条主通道走廊
    if (truckHit.road.edgeCode && segHit.road.edgeCode
        && truckHit.road.edgeCode === segHit.road.edgeCode) {
      return true // edgeCode 对得上
    }
    const onRoad = projectToRoadPath(mid, truckHit.road.path || [])
    return onRoad && onRoad.dist <= 12 // 或者就落在本车那条路 12 米内
  }

  /** 本车场图坐标转世界坐标 */
  function selfWorld() {
    return state.self ? toWorld(state.self, 0) : null
  }

  /** 本车吸到最近路心的位置；吸不上就用原位置 */
  function selfOnRoadPos() {
    const pos = selfWorld()
    if (!pos) return null
    const snap = nearestRoadSnap(pos)
    return snap ? snap.pos : pos
  }

  /** 两点连线中间是否穿进箱区（每隔约 4 米采样） */
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
    const candidates = [] // 每一段上的投影候选
    let minDist = Infinity
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      const dx = b.x - a.x
      const dz = b.z - a.z
      const len2 = dx * dx + dz * dz
      const t = len2 < 1e-8 ? 0 : Math.max(0, Math.min(1, ((selfPos.x - a.x) * dx + (selfPos.z - a.z) * dz) / len2))
      const on = new THREE.Vector3(a.x + t * dx, a.y, a.z + t * dz) // 本车在这段上的垂足
      const dist = Math.hypot(selfPos.x - on.x, selfPos.z - on.z)
      const rest = remainingAfter(points, i, on) // 从垂足到终点还剩多少米
      candidates.push({ index: i, on, dist, rest })
      if (dist < minDist) minDist = dist
    }
    if (!candidates.length) return null
    const total = polylineLength(points) // 整条折线长，用来判断是不是绕场一圈
    const sameRoad = candidates.filter(c => {
      const a = points[c.index]
      const b = points[c.index + 1]
      return segmentOnTruckRoad(a, b, selfPos) // 只留和本车同路的段
    })
    const pool = sameRoad.length ? sameRoad : candidates // 有同路段就只在同路里挑
    // 已经压在某段上（<8m）：用这段。C 与南通道只隔约 20m，18m 容差会把后半圈平行路算进来。
    const onRoad = pool.filter(c => c.dist <= Math.max(8, minDist + 3))
    let chosen = (onRoad.length ? onRoad : pool.filter(c => c.dist <= minDist + 8))
      .reduce((best, c) => (c.dist < best.dist ? c : best), pool[0]) // 先取最近的
    // 车已贴在某段路上（≤12m）：若存在与车同路的段，禁止接到平行主通道
    if (minDist <= 12) {
      if (sameRoad.length) {
        const nearSame = sameRoad.filter(c => c.dist <= Math.max(12, minDist + 4))
        if (nearSame.length) {
          chosen = nearSame.reduce((best, c) => (c.dist < best.dist ? c : best), nearSame[0])
        }
      }
      return chosen // 已经贴路就不用后面「剩余更长」的绕场逻辑
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
  function clipWorldRouteToSelf(points, skipChordRepair) {
    if (!points || points.length < 2 || !state.self) return points // 没车或没线就不裁
    const truck = selfWorld() || selfOnRoadPos() // 本车世界坐标
    const chosen = pickRouteProgress(points, truck) // 该从哪一段接上
    if (!chosen) return points
    const segA = points[chosen.index]
    const segB = points[chosen.index + 1]
    const onSameRoad = segmentOnTruckRoad(segA, segB, truck)
    const gap = truck.distanceTo(chosen.on) // 车到垂足的距离
    const canStitchTruck = onSameRoad
      && gap <= 10
      && !chordOffRoad(truck, chosen.on) // 同路、够近、中间不飞线，才把车点接到蓝线头
    const truckSnap = nearestRoadSnap(truck)
    try {
      console.log('[nav-route-draw]', JSON.stringify({ // 调试：本车在哪条路、接到第几段
        truck: state.self ? [state.self.x, state.self.y] : null,
        truckRoad: truckSnap && truckSnap.road
          ? (truckSnap.road.edgeCode || truckSnap.road.edgeName || truckSnap.road.roadName || '')
          : '',
        segIdx: chosen.index,
        distToSegM: Math.round(chosen.dist * 10) / 10,
        gapToOnM: Math.round(gap * 10) / 10,
        onSameRoad,
        canStitchTruck,
        laneOffsetApplied: state.routeLaneOffset === true,
        polyFirst: points[0] ? [points[0].x, points[0].z] : null
      }))
    } catch (logErr) {
      // ignore 日志序列化失败不影响画线
    }
    const out = []
    if (canStitchTruck) {
      out.push(truck.clone()) // 蓝线从车头开始
      if (gap > 0.8) out.push(chosen.on.clone()) // 再接到折线垂足
    } else {
      out.push(chosen.on.clone()) // 不能直连就从垂足画，避免斜穿箱区
    }
    for (let i = chosen.index + 1; i < points.length; i += 1) {
      if (out[out.length - 1].distanceTo(points[i]) > 0.8) out.push(points[i].clone()) // 后面的点原样接上
    }
    if (skipChordRepair) return out.length >= 2 ? out : points // 已经偏过车道就不要再补路心拐点
    return dropOffRoadChords(out.length >= 2 ? out : points) // 再修一遍飞线
  }

  /** 根据当前路线重画蓝色导航带和方向箭头 */
  function rebuildRoute() {
    clearGroup(routeGroup) // 先拆掉旧蓝线
    state.routeEnd = null
    state.routeLine = null
    const route = state.route || []
    if (route.length < 2) return // 不够两点画不成线
    try {
      const raw = []
      for (let i = 0; i < route.length; i += 1) {
        raw.push(toWorld(route[i], 0.86)) // 提到约 0.86 米高，后面画线用 0.52
      }
      const dedup = [raw[0]]
      for (let i = 1; i < raw.length; i += 1) {
        if (dedup[dedup.length - 1].distanceTo(raw[i]) > 0.8) dedup.push(raw[i]) // 丢掉挤在一起的点
      }
      if (dedup.length < 2) return
      const alreadyLane = state.routeLaneOffset === true // 后端已经偏过右侧车道
      const cleaned = keepOnRoads(dropLeadStub(simplifyRoutePoints(trimDestinationStub(dedup)))) // 掐头去尾抽稀
      const onRoad = alreadyLane ? cleaned : dropOffRoadChords(cleaned) // 未偏置的再补马路拐点
      const clipped = clipWorldRouteToSelf(onRoad.length >= 2 ? onRoad : dedup, alreadyLane) // 只画车前面的剩余路
      if (!clipped || clipped.length < 2) {
        state.dirty = true
        return
      }
      // 偏置后再走 dropOffRoadChords 会把路口补成路心黄线，直角弯和东向路都会塌到路中间
      const offset = alreadyLane ? clipped : offsetPolylineRight(clipped, (idx, mid) => {
        const tan = unitXZ(clipped[idx], clipped[idx + 1])
        return laneOffsetAlong(mid, tan) // 按这段所在路决定偏多少
      })
      const smoothed = filletPolyline(offset, 2.2) // 拐角切成 2.2 米半径圆角
      const linePts = smoothed.length >= 2 ? smoothed : offset
      const blueW = 0.95 // 蓝线宽度（米）
      const routeY = 0.52 // 蓝线离地高度，压在路面上
      buildRouteRibbon(linePts, blueW, routeY, 0x1d6fe8, routeGroup)
      state.routeEnd = linePts[linePts.length - 1] // 记下终点给堆高机/图钉
      state.routeLine = linePts // 记下整条已画折线给车头朝向
      const total = linePts.reduce((sum, p, idx) => (
        idx === 0 ? 0 : sum + linePts[idx - 1].distanceTo(p)
      ), 0) // 蓝线总长
      const arrowCount = Math.min(18, Math.max(4, Math.floor(total / 16))) // 大约每 16 米一个箭头
      const arrowY = routeY + blueW * 0.5 + 0.018 // 嵌在蓝线顶面
      for (let i = 1; i <= arrowCount; i += 1) {
        const want = (total * i) / (arrowCount + 1) // 第 i 个箭头应在总长的这个位置
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

  /** 用 GLB 零件拼出本车集卡；模型没好就返回 null */
  function buildSelfTruck(origin, yaw) {
    // GLB 还没解析完就先不画，onModelReady 会回来补
    const parts = vehicleLoader.getTruckParts()
    if (!parts || !parts.length) return null
    const truck = vehicleLoader.instantiate(THREE, parts, materialOpts) // 按户外材质实例化
    truck.traverse(child => {
      child.frustumCulled = false // 关视锥裁剪，避免近距离车身被切掉
      if (child.isMesh) child.renderOrder = 6 // 比路面后画，不被路盖住
    })
    truck.position.set(origin.x, 0.26, origin.z) // 略抬高，轮胎贴在路面上
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
      if (!child.isMesh || !child.geometry) return // 只看网格
      if (typeof child.geometry.computeBoundingBox === 'function') {
        child.geometry.computeBoundingBox() // 算出包围盒
      }
      const box = child.geometry.boundingBox
      if (!box) return
      const sx = child.scale.x || 1
      const sy = child.scale.y || 1
      const sz = child.scale.z || 1
      const cx = child.position.x + (box.min.x + box.max.x) * 0.5 * sx // 这块网格中心 x
      const cz = child.position.z + (box.min.z + box.max.z) * 0.5 * sz
      const footY = child.position.y + box.min.y * sy // 这块的脚底高度
      items.push({ child, cx, cz, footY })
    })
    if (!items.length) return

    const xs = items.map(item => item.cx)
    const zs = items.map(item => item.cz)
    const spanX = Math.max(...xs) - Math.min(...xs) // 左右铺开多少
    const spanZ = Math.max(...zs) - Math.min(...zs)
    const useX = spanX >= spanZ // 沿铺得更开的轴分左右
    const coordOf = item => (useX ? item.cx : item.cz)
    const coords = items.map(coordOf)
    const mid = (Math.max(...coords) + Math.min(...coords)) / 2 // 左右分界
    const half = Math.max((Math.max(...coords) - Math.min(...coords)) / 2, 0.01)
    const edge = Math.max(0.06, half * 0.18) // 中间带宽不算左/右岛

    let leftFoot = Infinity
    let rightFoot = Infinity
    items.forEach((item, index) => {
      const c = coords[index]
      if (c <= mid - edge) leftFoot = Math.min(leftFoot, item.footY) // 左侧最低脚
      if (c >= mid + edge) rightFoot = Math.min(rightFoot, item.footY)
    })
    if (!Number.isFinite(leftFoot)) {
      leftFoot = Math.min(...items.map(item => item.footY)) // 分不出左就用全局最低
    }
    if (!Number.isFinite(rightFoot)) {
      rightFoot = leftFoot
    }
    const lift = leftFoot - rightFoot // 右侧要抬多少才能和左侧齐
    if (lift <= 0.005) return // 已经齐或右侧更高就不动
    items.forEach((item, index) => {
      if (coords[index] >= mid + edge) {
        item.child.position.y += lift // 只抬右侧岛
      }
    })
  }

  /** 把整个模型的最低点对齐到路面高度 */
  function alignModelFootToRoad(model, footY) {
    const target = footY != null ? footY : ROAD_SURFACE_Y
    model.updateMatrixWorld(true) // 先更新世界矩阵再量包围盒
    const box = new THREE.Box3().setFromObject(model)
    if (!box || !Number.isFinite(box.min.y)) return
    model.position.y += target - box.min.y // 差多少抬多少
  }

  /** 当前任务是不是出场：用途字段或终点标签带「出场/出口」 */
  function isExitPurpose() {
    return state.purpose === 'exit' || /出场|出口|EXIT/i.test(state.targetLabel || '')
  }

  /** 从场图节点里找名叫出场/出口/gate 的点，当道口备用锚点 */
  function pickExitNodeFromMap() {
    const nodes = (state.map && state.map.nodes) || [] // 场图路网节点
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]
      const label = `${node.nodeName || ''}${node.nodeCode || ''}` // 名称+代号拼一起搜关键字
      if (!/出场|出口|exit|gate/i.test(label)) continue
      const xy = xyOf(node)
      if (xy) return xy
    }
    return null
  }

  /**
   * 道口只认场图建筑或固定出场锚点，绝不使用当前路线终点/任务终点。
   * 场图没维护道口时返回 null —— 不能退到场区包围盒角上凭空立一个，
   * 那会让司机以为那里有出场口。
   */
  function resolveCrossingAnchor() {
    const fromMark = pickCrossingFromMarks()
    if (fromMark) return fromMark
    const anchor = xyOf(state.gateAnchor)
    if (anchor) return toWorld(anchor, 0) // 其次用导航目标入口
    const fromMap = pickExitNodeFromMap()
    return fromMap ? toWorld(fromMap, 0) : null // 再其次用场图节点；都没有就不要瞎立
  }

  function pickCrossingFromMarks() {
    const marks = (state.map && state.map.marks) || []
    for (let i = 0; i < marks.length; i += 1) {
      const mark = marks[i]
      const material = String((mark && mark.material) || '')
      const name = String((mark && mark.name) || '')
      if (material !== 'dualChannelCrossing' && !/出场|道口|出口/i.test(name)) continue
      const xy = xyOf(mark)
      if (!xy) continue
      return {
        world: toWorld(xy, 0),
        size: Number(mark.size),
        rotation: Number(mark.rotation)
      }
    }
    return null
  }

  function addSafetyGates(block) {
    const gates = (block && block.gates) || []
    gates.forEach(gate => {
      const xy = xyOf(gate)
      if (!xy) return
      const world = toWorld(xy, 0)
      const out = gate.kind === 'out'
      const post = makeUnlitBox(1.4, 2.6, 1.4, out ? 0xdc2626 : 0x16a34a)
      post.position.set(world.x, 1.4, world.z)
      mapGroup.add(post)
      const tag = makeTextSprite(gate.label || (out ? '出口' : '入口'), out ? '#b91c1c' : '#166534', {
        scaleX: 8,
        scaleY: 2
      })
      if (tag) {
        tag.position.set(world.x, 3.3, world.z)
        mapGroup.add(tag)
      }
    })
  }

  /** 道口朝向：跟着附近道路切线，找不到就朝南 */
  function crossingTangentAt(anchor) {
    const hit = nearestRoadHit(anchor, 28, false)
    if (hit && hit.tangent && hit.tangent.length() > 0.05) return hit.tangent
    return new THREE.Vector3(0, 0, 1)
  }

  /** 出场任务贴近道口时隐藏模型，避免和终点糊在一起 */
  function updateCrossingVisibility() {
    if (!crossing) return
    if (!isExitPurpose()) {
      crossing.visible = true // 作业任务始终显示道口当参照
      return
    }
    const stop = destPoint()
    if (!stop || !state.self) {
      crossing.visible = true
      return
    }
    const truck = selfWorld()
    crossing.visible = truck.distanceTo(stop) > 8 // 离终点 8 米内藏起来
  }

  /** 在固定出场锚点立道口模型，对齐路面和道路方向 */
  function buildCrossing() {
    if (crossing) {
      mapGroup.remove(crossing) // 先拆旧的
      disposeObject(crossing)
      crossing = null
    }
    const parts = vehicleLoader.getCrossingParts() // 道口 GLB 零件
    if (!parts || !parts.length || !state.bounds) return // 模型没好或场图没范围
    const resolved = resolveCrossingAnchor()
    if (!resolved) return // 没有固定出场点就不立，避免司机看错口
    const anchor = resolved.world || resolved
    const model = vehicleLoader.instantiate(THREE, parts, materialOpts)
    levelCrossingPedestals(model) // 左右岛底面齐平
    const size = Number(resolved.size)
    if (Number.isFinite(size) && size > 0 && Math.abs(size - 1) > 0.01) {
      model.scale.set(size, size, size) // 跟场图缩放一致
    }
    if (Number.isFinite(Number(resolved.rotation))) {
      model.rotation.y = (-Number(resolved.rotation) * Math.PI) / 2 // 与场图绘制同一套旋转系数
    } else {
      const tangent = crossingTangentAt(anchor)
      model.rotation.y = Math.atan2(tangent.x, tangent.z) // 没记旋转就顺着路摆
    }
    model.position.set(anchor.x, 0, anchor.z)
    alignModelFootToRoad(model, ROAD_SURFACE_Y)
    model.traverse(child => {
      if (child.isMesh) child.renderOrder = 3 // 压在路面之上、集卡之下
    })
    crossing = model
    mapGroup.add(model)
    updateCrossingVisibility()
  }

  /** 在终点旁立一台堆高机，朝向与进终点的路相反（对着来车） */
  function buildStacker(origin, yaw, options) {
    const parts = vehicleLoader.getStackerParts() // 堆高机 GLB
    if (!parts || !parts.length) return null
    const model = vehicleLoader.instantiate(THREE, parts, materialOpts)
    model.position.set(origin.x, 0, origin.z) // 先放在终点旁，高度后面贴地
    const faceIncoming = !options || options.faceIncoming !== false
    model.rotation.y = faceIncoming ? -yaw : yaw
    return model
  }

  /** 罗盘航向（0 正北顺时针）→ 世界前进方向 */
  function headingToForward(headingDeg) {
    const rad = Number(headingDeg) * Math.PI / 180
    return new THREE.Vector3(Math.sin(rad), 0, -Math.cos(rad))
  }

  /** 当前终点：优先任务坐标，否则用蓝线最后一个点 */
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
    const cleaned = raw.length >= 2 ? keepOnRoads(dropLeadStub(raw)) : []
    const line = raw.length >= 2
      ? (state.routeLaneOffset ? cleaned : dropOffRoadChords(cleaned))
      : (state.routeLine || []) // 没有原始折线就用已画蓝线
    if (!line || line.length < 2) return new THREE.Vector3(1, 0, 0) // 兜底朝东
    const a = line[line.length - 2]
    const b = line[line.length - 1]
    const t = new THREE.Vector3(b.x - a.x, 0, b.z - a.z)
    if (t.length() < 0.01) return new THREE.Vector3(1, 0, 0)
    return t.normalize()
  }

  /** 把后端路线点转成世界坐标列表，丢掉没有 x/y 的点 */
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

  /** 把点垂到折线上，返回垂足、切线、距离、所在段号 */
  function projectOnRoute(worldPos, points) {
    let bestOn = points[0]
    let bestDist = Infinity
    let bestTan = new THREE.Vector3(0, 0, -1) // 默认朝北（世界 -Z）
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
    const snap = projectOnRoute(fromPos, points) // 先落到折线上
    const want = 16 // 往前看 16 米
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
        ahead = cursor.clone().add(seg.multiplyScalar(t)) // 刚好走到 16 米处
        break
      }
      acc += len
      cursor = dest // 这段走完，游标移到下一点
    }
    if (!ahead) ahead = cursor // 剩余不到 16 米就看终点
    let forward = new THREE.Vector3(ahead.x - snap.pos.x, 0, ahead.z - snap.pos.z)
    if (forward.length() < 0.3) forward = snap.tangent.clone() // 看太近就用当前切线
    if (forward.length() < 0.001) return snap.tangent.clone()
    return forward.normalize()
  }

  /** 世界前进方向 → 集卡模型绕 Y 的航向角 */
  function yawForTruck(forward) {
    // 模型车头在局部 -Z，蓝线箭头沿 +Z；车头要比箭头再转 180° 才同向
    return Math.atan2(-forward.x, -forward.z)
  }

  /** 当前航向（度）：优先手机罗盘，否则用本车上报的 heading */
  function liveHeadingDeg() {
    const sensor = headingSensor.get()
    if (sensor != null && !Number.isNaN(Number(sensor))) return Number(sensor)
    if (state.self && state.self.heading != null && !Number.isNaN(Number(state.self.heading))) {
      return Number(state.self.heading)
    }
    return 0
  }

  /** 在当前位置沿蓝线（或原始折线）往前看的单位方向 */
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
    const pos = selfWorld() // 车位用后端米制，不再本地吸到路心
    let forward = routeForwardAt(pos) // 车头跟蓝线走
    if (!forward || forward.length() < 0.05) {
      const snap = nearestRoadSnap(pos)
      forward = (snap && snap.tangent) ? snap.tangent.clone() : new THREE.Vector3(0, 0, -1) // 没蓝线就跟路，再没有朝北
    }
    return { pos, yaw: yawForTruck(forward) }
  }

  /** 本车模型只创建一次，后续只改位置航向 */
  function ensureSelfTruck() {
    if (selfTruck) return selfTruck
    const truck = buildSelfTruck(new THREE.Vector3(0, 0, 0), 0)
    if (!truck) return null
    selfTruck = truck
    selfTruck.visible = false // 还没定位时先藏着
    root.add(selfTruck)
    return selfTruck
  }

  /** 本车位置/航向平滑缓存，减轻 GPS 和罗盘抖动 */
  const poseSmooth = { x: null, z: null, yaw: null, at: 0 }

  /** 每帧把本车模型挪到平滑后的位置和航向 */
  function applySelfPose() {
    if (!state.self) {
      if (selfTruck) selfTruck.visible = false // 没定位就藏车
      poseSmooth.x = null // 下次来了重新初始化平滑
      return
    }
    const pose = selfDisplayPose()
    const truck = ensureSelfTruck()
    if (!truck) return
    truck.visible = true
    const now = Date.now()
    const dt = poseSmooth.at ? Math.min(0.08, (now - poseSmooth.at) / 1000) : 0.016 // 帧间隔，封顶 80ms
    poseSmooth.at = now
    if (poseSmooth.yaw == null) {
      poseSmooth.x = pose.pos.x // 第一帧直接贴上，不插值
      poseSmooth.z = pose.pos.z
      poseSmooth.yaw = pose.yaw
    } else {
      let dyaw = pose.yaw - poseSmooth.yaw
      while (dyaw > Math.PI) dyaw -= Math.PI * 2 // 走到最短旋转
      while (dyaw < -Math.PI) dyaw += Math.PI * 2
      const maxTurn = Math.PI * 4.2 * dt // 这一帧最多转这么多
      if (Math.abs(dyaw) > maxTurn) dyaw = (dyaw > 0 ? 1 : -1) * maxTurn
      poseSmooth.yaw += dyaw * (Math.abs(dyaw) > 0.12 ? 0.72 : 0.42) // 大转快跟、小转慢跟
      const pdx = pose.pos.x - poseSmooth.x
      const pdz = pose.pos.z - poseSmooth.z
      const pdist = Math.hypot(pdx, pdz)
      const pt = pdist > 20 ? 0.55 : 0.18 // 跳太远跟快一点，平时慢跟抗抖
      poseSmooth.x += pdx * pt
      poseSmooth.z += pdz * pt
    }
    truck.position.set(poseSmooth.x, 0.26, poseSmooth.z)
    truck.rotation.y = poseSmooth.yaw
    updateCrossingVisibility() // 车一动，出场口显隐可能要变
  }

  /** 重画终点图钉、标签、堆高机，并刷新本车姿态 */
  function rebuildDynamic() {
    clearGroup(dynamicGroup) // 动态物整组清掉重来
    const dest = destPoint()
    if (dest) {
      const exitDest = state.purpose === 'exit' || /出场|出口|EXIT/i.test(state.targetLabel || '')
      // 出场口由道口模型标识；贴近时不要再叠高大图钉和「出场口」飘字（会糊在脸上）
      if (!exitDest) {
        const pin = new THREE.Group() // 绿色水滴图钉
        const tail = new THREE.Mesh(
          new THREE.ConeGeometry(0.78, 2.5, 20),
          new THREE.MeshLambertMaterial({ color: 0x16a34a })
        )
        tail.position.y = 1.35
        tail.rotation.x = Math.PI // 圆锥尖朝下
        const head = new THREE.Mesh(
          new THREE.SphereGeometry(0.95, 20, 16),
          new THREE.MeshLambertMaterial({ color: 0x16a34a })
        )
        head.position.y = 2.85
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.38, 14, 12),
          new THREE.MeshBasicMaterial({ color: 0xffffff })
        )
        dot.position.y = 2.85 // 白点嵌在绿球中间
        pin.add(tail)
        pin.add(head)
        pin.add(dot)
        pin.position.set(dest.x, 0, dest.z)
        pin.userData.scaleWithView = true // 拉远相机时图钉跟着放大
        pin.userData.baseScale = { x: 1, y: 1, z: 1 }
        dynamicGroup.add(pin)
      }
      if (state.targetLabel && state.purpose !== 'safety' && !exitDest) {
        const tag = makeTextSprite(state.targetLabel, '#166534', { scaleX: 12, scaleY: 3 })
        if (tag) {
          tag.position.set(dest.x, 5.2, dest.z) // 飘在图钉上方
          dynamicGroup.add(tag)
        }
      }
    }
    if (state.self && state.purpose === 'job' && destPoint() && !state.hasLiveForklifts) {
      const dest = destPoint()
      const tan = lastRouteApproach() // 进终点的方向
      const side = new THREE.Vector3(-tan.z, 0, tan.x).multiplyScalar(7.5) // 路右侧 7.5 米
      const yaw = yawForTruck(new THREE.Vector3(-tan.x, 0, -tan.z)) // 堆高机对着来车
      const stacker = buildStacker(
        { x: dest.x + side.x, y: 0, z: dest.z + side.z },
        yaw
      )
      if (stacker) dynamicGroup.add(stacker)
    }
    applySelfPose()
    state.dirty = true
  }

  /** 自动算相机该看哪里：场外框整场，场内跟车看本车 */
  function computeAutoView() {
    const bounds = state.map ? yardBounds(state.map) : null
    const base = state.userView || state.view
    const currentPitch = base.pitch != null ? base.pitch : DEFAULT_PITCH // 保留用户俯仰
    const currentBearing = base.bearing != null ? base.bearing : 0
    if (!bounds) {
      return { // 还没场图就维持当前中心
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
      ? boundsOf([ // 车离场不太远时，框选要把车也包进来
        { x: bounds.minX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.maxY },
        self
      ])
      : bounds // 太远就只框场区，避免拉到几百米外
    const centerX = (framed.minX + framed.maxX) / 2
    const centerY = (framed.minY + framed.maxY) / 2
    const spanX = Math.max(framed.maxX - framed.minX, 60) // 最小当 60 米，避免缩太狠
    const spanY = Math.max(framed.maxY - framed.minY, 60)
    const span = Math.max(spanX, spanY)
    const fitDistance = Math.max(80, Math.min(MAX_DISTANCE, span * 1.35)) // 按跨度估相机距离
    state.fitDistance = fitDistance

    const inYard = off !== null && off <= 80
    if (state.followMode && !state.userView && inYard && self) {
      const center = poseSmooth.x != null && poseSmooth.z != null
        ? fromWorld(poseSmooth.x, poseSmooth.z) // 跟平滑后的车，画面不抖
        : self
      return {
        centerX: center.x,
        centerY: center.y,
        distance: 110, // 跟车时固定近一些
        pitch: currentPitch,
        bearing: currentBearing
      }
    }
    return { centerX, centerY, distance: fitDistance, pitch: currentPitch, bearing: currentBearing }
  }

  /** 按当前视角把透视相机摆到正确位置并看向中心 */
  function applyCamera(options) {
    // keepView：拖拽集卡时只用上一帧镜头，禁止再走「框整场」把图缩到角落
    const view = state.userView || ((options && options.keepView) ? state.view : computeAutoView())
    if (view.pitch == null) view.pitch = DEFAULT_PITCH
    if (view.bearing == null) view.bearing = 0
    state.view = view
    const target = toWorld({ x: view.centerX, y: view.centerY }, 0) // 看向的地面点
    const dist = view.distance
    const pitch = clampPitch(view.pitch)
    let bearing = view.bearing
    if (state.headingUp) {
      bearing = -liveHeadingDeg() * Math.PI / 180 // 北朝上：方位跟手机航向反号
      view.bearing = bearing
      if (state.userView) state.userView.bearing = bearing
      state.view.bearing = bearing
    }
    const horizontal = dist * Math.cos(pitch) // 水平拉开的距离
    const vertical = dist * Math.sin(pitch) // 相机离地高度
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

  /** 拉远/拉近时把区名、图钉按距离缩放，远了也能看见 */
  function applyOverlayScale() {
    const dist = ((state.userView || state.view) || {}).distance || 95
    const k = Number.isFinite(dist) ? Math.max(0.5, Math.min(2.1, dist / 110)) : 1 // 相对跟车距离 110 的比例
    const apply = obj => {
      if (obj.userData && obj.userData.scaleWithView && obj.userData.baseScale) {
        const s = obj.userData.baseScale
        obj.scale.set(s.x * k, s.y * k, s.z * k)
      }
      if (obj.children) obj.children.forEach(apply) // 递归子节点
    }
    apply(mapGroup)
    apply(dynamicGroup)
  }

  /** 画一帧：更新车、相机、叠加缩放，再真正渲染 */
  function renderFrame() {
    if (!state.running) return
    applySelfPose()
    applyCamera()
    applyOverlayScale()
    renderer.render(scene, camera)
    state.dirty = false
  }

  /** 小程序动画循环：脏了、建图中、跟车或有本车时才重画 */
  function loop() {
    if (!state.running) return
    canvas.requestAnimationFrame(loop) // 先预约下一帧
    if (state.dirty || state.mapBuilding || state.followMode || state.self) {
      renderFrame()
    }
  }
  canvas.requestAnimationFrame(loop) // 启动循环

  /** 页面传入新场图：存下来并异步重建场景 */
  function setMap(map) {
    state.map = map
    rebuildMap()
    rebuildRoute()
    rebuildDynamic()
  }

  /** 更新导航折线；laneOffsetApplied 表示后端已经偏到右侧车道 */
  function setRoute(route, options) {
    state.route = route || []
    state.routeLaneOffset = Boolean(options && options.laneOffsetApplied)
    rebuildRoute()
  }

  /** 更新任务终点和标签；目标箱区变了才整图重建 */
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
      rebuildMap() // 箱区高亮依赖目标贝，需要重画静态层
    }
    if (!sameTarget) rebuildDynamic() // 终点变了重画图钉/堆高机
    else applySelfPose() // 只刷新车
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
      const alpha = dist > 12 ? 0.85 : dist > 4 ? 0.55 : 0.28 // 跳得远跟得快
      state.self = {
        x: prev.x + (next.x - prev.x) * alpha, // 往新坐标靠一点
        y: prev.y + (next.y - prev.y) * alpha,
        heading: self.heading != null && !Number.isNaN(Number(self.heading))
          ? Number(self.heading)
          : (prev.heading != null ? prev.heading : 0), // 没新航向就沿用
        headingFrom: self.headingFrom, // 航向来源（罗盘/GPS）
        accuracy: self.accuracy,
        speed: self.speed
      }
    } else if (next) {
      state.self = Object.assign({}, self, next) // 第一次定位直接用
    } else {
      state.self = null // 坐标非法就清空本车
    }
    if (state.demoContainer && !state.demoContainerAnchor && state.self) {
      state.demoContainerAnchor = { // 演示箱钉在第一次出现的位置
        x: state.self.x,
        y: state.self.y,
        heading: state.self.heading || 0
      }
      rebuildDynamic()
    }
    if ((state.route || []).length >= 2) rebuildRoute() // 车动了，剩余蓝线要重裁
    applySelfPose()
    state.dirty = true
  }

  /** 单独改本车航向（指南针回调） */
  function setHeading(deg) {
    if (!state.self) return
    const value = Number(deg)
    if (Number.isNaN(value)) return
    state.self.heading = value
    applySelfPose()
    state.dirty = true
  }

  /** 开关演示箱；关掉时清掉钉死的锚点 */
  function setDemoContainer(enabled) {
    state.demoContainer = Boolean(enabled)
    if (!state.demoContainer) state.demoContainerAnchor = null
    rebuildDynamic()
  }

  /** 是否跟车；不改 userView，只标脏等下一帧 */
  function setFollowMode(followMode) {
    state.followMode = Boolean(followMode)
    state.dirty = true
  }

  /** 把当前镜头钉死，之后拖集卡不再自动框场/跟车 */
  function freezeView() {
    const view = snapshotView(state.userView || state.view)
    state.userView = view
    state.followMode = false
    state.dirty = true
    return view
  }

  /** 主动回到跟车：清掉手动视角。 */
  function enableFollow() {
    state.followMode = true
    state.headingUp = false // 回到默认北朝上的自动视野，不跟手机拧
    state.userView = null // 清掉手动视角
    state.view.pitch = DEFAULT_PITCH
    state.dirty = true
  }

  function setUserView(view) {
    state.userView = view
    // 手势拖动后退出跟车，否则下一帧自动跟车会把视角拽回去
    state.followMode = false
    state.dirty = true
  }

  /** 取出视角俯仰并夹到合法范围 */
  function currentPitch(view) {
    return clampPitch(view && view.pitch != null ? view.pitch : DEFAULT_PITCH)
  }

  /** 取出方位角，缺省为 0（从南望北） */
  function currentBearing(view) {
    return view && view.bearing != null ? view.bearing : 0
  }

  /** 复制一份视角并叠上补丁，给平移/缩放/倾斜用 */
  function snapshotView(view, patch) {
    return Object.assign({
      centerX: view.centerX,
      centerY: view.centerY,
      distance: view.distance,
      pitch: currentPitch(view),
      bearing: currentBearing(view)
    }, patch || {})
  }

  /** 单指拖地图：像素位移换成地面米制，抓住地图跟手走 */
  function pan(dxPx, dyPx) {
    const view = state.userView || state.view
    const pitch = currentPitch(view)
    const metersPerPx = (view.distance * 0.0018) + 0.08 // 相机越远，滑一点走得越远
    applyCamera() // 先摆好相机，才能取屏幕右/前
    const target = toWorld({ x: view.centerX, y: view.centerY }, 0)
    // 直接用当前相机在地面上的右/前，避免拧北后滑动还按「北朝上」换算
    const look = new THREE.Vector3(target.x - camera.position.x, 0, target.z - camera.position.z)
    let right
    if (look.lengthSq() < 0.0001) {
      const bearing = currentBearing(view)
      look.set(-Math.sin(bearing), 0, -Math.cos(bearing)) // 正俯视时用方位推前向
      right = new THREE.Vector3(Math.cos(bearing), 0, -Math.sin(bearing))
    } else {
      look.normalize()
      right = new THREE.Vector3().crossVectors(look, new THREE.Vector3(0, 1, 0)).normalize() // 前 × 上 = 右
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

  /** 双指捏合缩放：factor>1 拉近，距离夹在最小/最大之间 */
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
    if (!deltaYPx) return state.userView || state.view // 没滑就原样返回
    const view = state.userView || state.view
    const pitch = clampPitch(currentPitch(view) - deltaYPx * (Math.PI / 180) * 0.32) // 下移减俯仰=更侧视
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
    let bearing = currentBearing(view) - deltaAngle // 手指顺时针拧，地图顺时针转
    // 归一化到 (-π, π]
    bearing = ((bearing + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI
    const next = snapshotView(view, { bearing })
    state.headingUp = false // 拧过地图就不再跟手机航向
    setUserView(next)
    return next
  }

  /** 一键切到接近正俯视（2D）或默认 3D 斜视；不退出跟车/朝向跟随 */
  function setFlatMode(flat) {
    const view = state.userView || state.view || computeAutoView()
    const pitch = flat ? FLAT_PITCH : DEFAULT_PITCH // true=接近正俯视
    if (state.userView) {
      state.userView = snapshotView(state.userView, { pitch }) // 手势视角只改俯仰
    } else {
      state.view = snapshotView(view, { pitch })
    }
    state.dirty = true
    return state.userView || state.view
  }

  /** 当前是不是接近正俯视（允许差 4°） */
  function isFlatMode() {
    return currentPitch(state.userView || state.view) >= (FLAT_PITCH - 4 * Math.PI / 180)
  }

  /** 清掉手动视角，回到俯视自动框场 */
  function resetView() {
    state.userView = null
    state.headingUp = false
    state.view.pitch = FLAT_PITCH
    state.dirty = true
  }

  /** 一键把视野中心拉到本车，距离不超过 120 米 */
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

  /** 画布尺寸变了：改相机宽高比和渲染分辨率 */
  function resize(nextWidth, nextHeight, nextDpr) {
    state.width = nextWidth
    state.height = nextHeight
    camera.aspect = nextWidth / nextHeight
    camera.updateProjectionMatrix()
    renderer.setPixelRatio(nextDpr || 2)
    renderer.setSize(nextWidth, nextHeight, false)
    state.dirty = true
  }

  /** 给页面读的状态：场外距离、俯仰、是否在建图等 */
  function getStatus() {
    computeAutoView() // 顺带刷新 offYardMeters / fitDistance
    const view = state.userView || state.view
    const bearing = currentBearing(view)
    return {
      view: state.view, // 当前生效视角
      offYardMeters: state.offYardMeters, // 离场区多远
      fitDistance: state.fitDistance, // 框整场需要的距离
      viewAdjusted: Boolean(state.userView), // 用户是否拧过/拖过
      flatMode: isFlatMode(),
      pitchDeg: Math.round(currentPitch(view) * 180 / Math.PI), // 俯仰角度数
      bearingDeg: Math.round(bearing * 180 / Math.PI), // 方位角度数
      mapBuilding: state.mapBuilding,
      roadSnapM: state.roadSnapM // 本车离最近路心多少米
    }
  }

  /**
   * models/*.glb 解析要几十毫秒，不能挡在启动路径上，
   * 因此先建场景，模型就绪后再各自补挂。
   */
  const offModelReady = vehicleLoader.onModelReady(name => { // GLB 解析完按名字补挂
    if (name === 'truck') {
      if (selfTruck) {
        root.remove(selfTruck) // 扔掉占位/旧模型
        disposeObject(selfTruck)
        selfTruck = null
      }
      applySelfPose() // 用新模型重新挂本车
    } else if (name === 'container20' || name === 'container40') {
      state.containerTemplates = { // 箱子模板换新，下次建箱区用 GLB
        c20: vehicleLoader.createTemplate(THREE, vehicleLoader.getContainerParts(20)),
        c40: vehicleLoader.createTemplate(THREE, vehicleLoader.getContainerParts(40))
      }
      rebuildDynamic()
    } else if (name === 'crossing') {
      buildCrossing() // 道口模型好了再立
    } else if (name === 'stacker') {
      rebuildLiveForkliftModels()
      rebuildDynamic()
    } else {
      rebuildDynamic() // 其它模型
    }
    state.dirty = true
  })
  vehicleLoader.preload() // 后台开始解析 glb，不挡启动

  /** 页面销毁：停循环、退订模型、释放几何和渲染器 */
  function dispose() {
    state.running = false
    offModelReady() // 取消模型就绪回调
    if (selfTruck) {
      root.remove(selfTruck)
      disposeObject(selfTruck)
      selfTruck = null
    }
    clearGroup(mapGroup)
    clearGroup(routeGroup)
    clearGroup(dynamicGroup)
    clearLiveForklifts()
    disposeObject(ground)
    renderer.dispose()
  }

  /** @param {{x:number, y:number}} anchor 出场道口的场图米制坐标 */
  function setExitGateAnchor(anchor) {
    const next = xyOf(anchor) // 只要合法米制点
    if (!next) return
    const prev = state.gateAnchor
    const same = prev && prev.x === next.x && prev.y === next.y // 坐标没变就别拆模型
    state.gateAnchor = next
    if (!same) buildCrossing() // 锚点变了才重立道口
  }

  /** 屏幕坐标落到场区地面（米制），拖拽集卡用 */
  function screenToYard(sx, sy) {
    if (!camera || !state.width || !state.height) return null
    applyCamera({ keepView: true })
    if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld(true)
    const ndcX = (Number(sx) / state.width) * 2 - 1
    const ndcY = -(Number(sy) / state.height) * 2 + 1
    if (!isFinite(ndcX) || !isFinite(ndcY)) return null
    const near = new THREE.Vector3(ndcX, ndcY, 0)
    const far = new THREE.Vector3(ndcX, ndcY, 1)
    if (typeof near.unproject !== 'function') return null
    near.unproject(camera)
    far.unproject(camera)
    const dir = far.sub(near)
    if (Math.abs(dir.y) < 1e-8) return null
    const t = -near.y / dir.y
    if (!isFinite(t) || t < 0) return null
    const hit = fromWorld(near.x + dir.x * t, near.z + dir.z * t)
    if (!hit || !Number.isFinite(hit.x) || !Number.isFinite(hit.y)) return null
    // 反投影飞出堆场太远时丢掉，避免本车落到 (0,0) 把镜头框到角落
    const bounds = state.bounds || (state.map ? yardBounds(state.map) : null)
    if (bounds && state.self) {
      const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 80)
      const limit = Math.max(span * 2.5, 400)
      if (Math.hypot(hit.x - state.self.x, hit.y - state.self.y) > limit) return null
    }
    return hit
  }

  /** 场区米制点 → 画布像素，用来判断有没有按在集卡上 */
  function yardToScreen(x, y) {
    if (!camera || !state.width || !state.height) return null
    applyCamera({ keepView: true })
    if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld(true)
    const world = toWorld({ x, y }, 0.26)
    const vec = new THREE.Vector3(world.x, world.y, world.z)
    if (typeof vec.project !== 'function') return null
    vec.project(camera)
    if (!isFinite(vec.x) || !isFinite(vec.y)) return null
    return {
      x: (vec.x + 1) * 0.5 * state.width,
      y: (1 - vec.y) * 0.5 * state.height
    }
  }

  /** 拖拽时立刻把本车放到场区点，清掉平滑以免车还在旧点晃 */
  function setSelfImmediate(self, options) {
    const next = xyOf(self)
    if (!next) return
    state.self = Object.assign({}, self, next)
    poseSmooth.x = null
    poseSmooth.z = null
    poseSmooth.yaw = null
    if ((!options || !options.skipRoute) && (state.route || []).length >= 2) rebuildRoute()
    applySelfPose()
    state.dirty = true
  }

  function clearLiveForklifts() {
    liveForklifts.forEach(entry => {
      if (entry.model) {
        liveForkliftGroup.remove(entry.model)
        disposeObject(entry.model)
      }
    })
    liveForklifts.clear()
    clearGroup(liveForkliftGroup)
    state.hasLiveForklifts = false
  }

  function upsertLiveForklift(item) {
    const id = String(item.id)
    const world = toWorld({ x: Number(item.x), y: Number(item.y) }, 0)
    const heading = item.heading != null && !Number.isNaN(Number(item.heading))
      ? Number(item.heading)
      : null
    const yaw = heading == null
      ? 0
      : yawForTruck(headingToForward(heading))
    let entry = liveForklifts.get(id)
    if (!entry) {
      const model = buildStacker({ x: 0, y: 0, z: 0 }, yaw, { faceIncoming: false })
      if (!model) return
      const group = new THREE.Group()
      group.add(model)
      const labelText = item.name || item.code || id
      const tag = makeTextSprite(labelText, '#1d4ed8', { scaleX: 14, scaleY: 3.2 })
      if (tag) {
        tag.position.set(0, 6.2, 0)
        group.add(tag)
      }
      group.position.set(world.x, 0, world.z)
      liveForkliftGroup.add(group)
      entry = { model: group, heading }
      liveForklifts.set(id, entry)
    } else {
      const prev = entry.model.position
      const dx = world.x - prev.x
      const dz = world.z - prev.z
      const inner = entry.model.children && entry.model.children[0]
      if (inner) {
        if (heading == null && (Math.abs(dx) > 0.2 || Math.abs(dz) > 0.2)) {
          inner.rotation.y = yawForTruck(new THREE.Vector3(dx, 0, dz))
        } else if (heading != null) {
          inner.rotation.y = yaw
        }
      }
      entry.model.position.set(world.x, 0, world.z)
    }
  }

  function rebuildLiveForkliftModels() {
    const items = state.liveForkliftItems || []
    clearLiveForklifts()
    items.forEach(upsertLiveForklift)
    state.hasLiveForklifts = liveForklifts.size > 0
    state.dirty = true
  }

  /**
   * @param {Array<{id:string, x:number, y:number, heading?:number, name?:string, code?:string}>} items
   */
  function setLiveForklifts(items) {
    const list = (items || []).filter(item => item && item.id != null && item.x != null && item.y != null)
    state.liveForkliftItems = list
    const keep = {}
    list.forEach(item => {
      keep[String(item.id)] = true
      upsertLiveForklift(item)
    })
    liveForklifts.forEach((entry, id) => {
      if (!keep[id]) {
        liveForkliftGroup.remove(entry.model)
        disposeObject(entry.model)
        liveForklifts.delete(id)
      }
    })
    const had = state.hasLiveForklifts
    state.hasLiveForklifts = liveForklifts.size > 0
    if (had !== state.hasLiveForklifts) rebuildDynamic()
    state.dirty = true
  }

  return { // 暴露给页面的接口，页面只调这些，不直接碰 Three
    setMap, // 下场图
    setRoute, // 下导航折线
    setTarget, // 下任务终点
    setExitGateAnchor, // 下固定出场道口
    setSelf, // 下本车位置
    setSelfImmediate, // 拖拽时立刻落到场区点，不做平滑
    screenToYard, // 屏幕点 → 场区米制
    yardToScreen, // 场区米制 → 屏幕点
    setLiveForklifts, // 下实时堆高机
    setHeading, // 下本车航向
    setDemoContainer, // 演示箱开关
    setFollowMode, // 跟车开关
    freezeView, // 钉死当前镜头，拖集卡时用
    setPurpose(purpose) { // 作业/出场/安全，影响道口和终点图标
      state.purpose = purpose || 'job'
      updateCrossingVisibility()
      rebuildDynamic()
    },
    enableFollow, // 回到跟车
    setUserView, // 写入手势视角
    pan, // 拖
    zoom, // 捏合
    tilt, // 倾斜
    rotate, // 拧
    setFlatMode, // 2D/3D 俯仰
    isFlatMode,
    resetView, // 复位
    locateSelf, // 定位到本车
    resize, // 画布改尺寸
    getStatus, // 读状态给 UI
    getPaintedRoute() { // 实际画在地上的蓝线点，给导航页算剩余距离
      return state.routeLine && state.routeLine.length >= 2 ? state.routeLine : null
    },
    getSelfWorld() { // 本车世界坐标（优先路心），给外部叠加用
      if (!state.self) return null
      const pos = selfOnRoadPos() || selfWorld()
      return pos ? { x: pos.x, y: pos.y, z: pos.z } : null
    },
    renderFrame, // 必要时强制画一帧
    dispose, // 销毁
    MAX_SCALE: MAX_DISTANCE // 对外暴露最远距离常数
  }
}

/**
 * 把场区米制点投影到最近道路中心线，供上报规划与画面集卡贴路一致。
 * 入参出参都是场图坐标，不再做经纬度换算。
 */
function snapPositionToRoad(roads, x, y, maxDistMeters) {
  const self = xyOf({ x, y })
  if (!self || !roads || !roads.length) {
    return { x, y, snapped: false } // 没坐标或没路，原样返回
  }
  const maxDist = maxDistMeters == null ? 48 : maxDistMeters // 默认 48 米内才算吸上路
  let bestDist = Infinity
  let bestX = self.x
  let bestY = self.y
  let bestRoad = null
  roads.forEach(road => {
    const path = road.path || []
    for (let i = 0; i < path.length - 1; i += 1) { // 逐段投影
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
  const roadLabel = bestRoad ? { // 带回路名，方便调试/上报
    edgeCode: bestRoad.edgeCode || '',
    name: bestRoad.edgeName || bestRoad.roadName || ''
  } : null
  if (bestDist > maxDist) {
    return { x: self.x, y: self.y, snapped: false, distM: bestDist, road: roadLabel } // 太远不吸
  }
  return {
    x: bestX, // 路心上的点
    y: bestY,
    snapped: true,
    distM: bestDist,
    road: roadLabel
  }
}

module.exports = {
  createYardScene, // 创建三维堆场场景
  snapPositionToRoad, // 点吸到路心
  nearestRoad(roads, self) { // 本车最近的那条路对象
    if (!self || !roads || !roads.length) return null
    const snap = snapPositionToRoad(roads, self.x, self.y, 60) // 60 米内找
    if (!snap.road) return null
    const hit = roads.find(r => (r.edgeCode && r.edgeCode === snap.road.edgeCode)
      || ((r.edgeName || r.roadName) === snap.road.name))
    return hit || null
  }
}
