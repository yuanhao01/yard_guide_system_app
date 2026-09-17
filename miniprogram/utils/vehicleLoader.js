/**
 * 读取 GLB（包内或远端），解析成与 Three 实例无关的网格数据，再实例化。
 * 微信小程序每个 webgl canvas 都有自己的 THREE，不能跨 canvas clone。
 * 用来在场图上画出集卡、堆高机、箱子，到位页再画一小段车道小景。
 * 依赖：config（远端高模地址）。
 */
const config = require('../config.js')

// 路径必须是源码里的字面量，微信 ignoreUploadUnusedFiles 才认，变量拼出来的 .glb 真机不会打进包
const MODEL_FILES = {
  truck: ['/models/truck.glb', 'models/truck.glb'], // 集卡，两种路径兼容不同打包
  stacker: ['/models/stacker.glb', 'models/stacker.glb'], // 堆高机
  container20: ['/models/container20.glb', 'models/container20.glb'], // 20 尺箱
  container40: ['/models/container40.glb', 'models/container40.glb'], // 40 尺箱
  crossing: ['/models/crossing.glb', 'models/crossing.glb'] // 路口地面
}

/** 从安装包里读出某个模型的二进制，第一种路径失败再试第二种 */
function readPackageBin(name) {
  const candidates = MODEL_FILES[name] // 这个模型登记的路径
  if (!candidates) return Promise.reject(new Error('未登记的模型 ' + name))
  return new Promise((resolve, reject) => {
    const tryRead = index => {
      if (index >= candidates.length) {
        reject(new Error('无法读取模型文件 ' + name))
        return
      }
      wx.getFileSystemManager().readFile({
        filePath: candidates[index],
        success: res => resolve(res.data), // 读到了就交给解析
        fail: () => tryRead(index + 1) // 这条路径没有就试下一条
      })
    }
    tryRead(0)
  })
}

/** 把模型里的红绿蓝小数收成一个整数颜色，后面上色用 */
function packColor(factor) {
  const r = Math.round((factor[0] || 0) * 255) // 红
  const g = Math.round((factor[1] || 0) * 255) // 绿
  const b = Math.round((factor[2] || 0) * 255) // 蓝
  return (r << 16) | (g << 8) | b
}

/** 统一成 ArrayBuffer，微信读文件有时给的是带偏移的视图 */
function asArrayBuffer(buffer) {
  if (buffer instanceof ArrayBuffer) return buffer
  if (buffer && buffer.buffer instanceof ArrayBuffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  }
  throw new Error('无法读取模型二进制')
}

/** 把模型文件头里的 UTF-8 字节读成文字（小程序不一定有 TextDecoder） */
function decodeUtf8(bytes) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes)
  }
  let text = ''
  for (let i = 0; i < bytes.length; i += 1) {
    text += String.fromCharCode(bytes[i])
  }
  try {
    return decodeURIComponent(escape(text))
  } catch (error) {
    return text
  }
}

/** glTF type -> 分量个数 */
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

/** glTF componentType -> [TypedArray, 字节宽度] */
const COMPONENT = {
  5120: [Int8Array, 1],
  5121: [Uint8Array, 1],
  5122: [Int16Array, 2],
  5123: [Uint16Array, 2],
  5125: [Uint32Array, 4],
  5126: [Float32Array, 4]
}

/** 把一个 GLB 文件拆成可画的网格：顶点、法线、贴图、颜色 */
function parseGlb(buffer) {
  const data = asArrayBuffer(buffer) // 整份文件
  const view = new DataView(data)
  if (view.getUint32(0, true) !== 0x46546c67) {
    throw new Error('不是有效的 GLB')
  }
  const jsonLen = view.getUint32(12, true) // 前面说明段有多长
  const jsonStart = 20
  const jsonText = decodeUtf8(new Uint8Array(data, jsonStart, jsonLen)) // 模型结构说明
  const gltf = JSON.parse(jsonText)
  let binOffset = jsonStart + jsonLen
  if (binOffset % 4) binOffset += 4 - (binOffset % 4) // 按 4 字节对齐
  const binLen = view.getUint32(binOffset, true)
  const binStart = binOffset + 8
  const bin = data.slice(binStart, binStart + binLen) // 后面的顶点、贴图二进制

  /**
   * 读取访问器。Unity / Blender 导出的 glTF 常用交错缓冲（byteStride），
   * 按紧凑排列去切会把 UV 和法线读串，所以必须按 stride 逐元素取。
   */
  function accessorArray(index) {
    const acc = gltf.accessors[index] // 这一组顶点/法线/UV 的说明
    if (!acc) return null
    const size = TYPE_SIZE[acc.type] || 1 // 每个点几个数
    const spec = COMPONENT[acc.componentType] // 每个数几个字节
    if (!spec) throw new Error('不支持的 componentType ' + acc.componentType)
    const Ctor = spec[0]
    const bytes = spec[1]
    const total = acc.count * size
    if (acc.bufferView == null) return new Ctor(total)
    const viewInfo = gltf.bufferViews[acc.bufferView] || {}
    const base = (viewInfo.byteOffset || 0) + (acc.byteOffset || 0) // 从哪一段二进制开始
    const stride = viewInfo.byteStride || 0 // 交错存放时每个点隔多远
    const packed = size * bytes
    if (!stride || stride === packed) {
      const aligned = new ArrayBuffer(total * bytes)
      new Uint8Array(aligned).set(new Uint8Array(bin, base, total * bytes))
      return new Ctor(aligned)
    }
    const out = new Ctor(total)
    for (let i = 0; i < acc.count; i += 1) {
      const src = new Ctor(bin.slice(base + i * stride, base + i * stride + packed))
      for (let k = 0; k < size; k += 1) out[i * size + k] = src[k]
    }
    return out
  }

  /** 归一化整型属性（UV/颜色可能存成 u8/u16） */
  function toFloatNormalized(arr, componentType, normalized) {
    if (!normalized || arr instanceof Float32Array) return new Float32Array(arr)
    const max = componentType === 5121 ? 255
      : componentType === 5123 ? 65535
        : componentType === 5120 ? 127
          : 32767
    const out = new Float32Array(arr.length)
    for (let i = 0; i < arr.length; i += 1) out[i] = Math.max(arr[i] / max, -1)
    return out
  }

  /** 内嵌图片：抽出原始字节，之后按需解码成纹理 */
  function imageBytes(imageIndex) {
    const image = (gltf.images || [])[imageIndex]
    if (!image || image.bufferView == null) return null
    const viewInfo = gltf.bufferViews[image.bufferView] || {}
    const start = viewInfo.byteOffset || 0
    const length = viewInfo.byteLength || 0
    if (!length) return null
    const out = new ArrayBuffer(length)
    new Uint8Array(out).set(new Uint8Array(bin, start, length))
    return { mime: image.mimeType || 'image/png', bytes: out }
  }

  /** 取出一张贴图的字节和如何重复铺，用来给集卡/箱子上色 */
  function textureRef(info) {
    if (!info || info.index == null) return null
    const tex = (gltf.textures || [])[info.index]
    if (!tex || tex.source == null) return null
    const img = imageBytes(tex.source)
    if (!img) return null
    const sampler = (gltf.samplers || [])[tex.sampler] || {}
    return {
      mime: img.mime, // png 或 jpg
      bytes: img.bytes, // 图片原文
      wrapS: sampler.wrapS || 10497, // 横向怎么铺
      wrapT: sampler.wrapT || 10497, // 纵向怎么铺
      uv: info.texCoord || 0 // 用第几套 UV
    }
  }

  /* 节点变换：glTF 的顶点在节点局部空间，必须按场景层级烘焙到世界空间。
     顶点量化也靠它——位置存成归一化 int16，再用节点 scale/translation 还原。 */

  /** 把一个零件的位移、旋转、缩放收成一张变换表，用来摆到正确位置 */
  function trsMatrix(node) {
    if (node.matrix) return node.matrix // 文件里已经给了整表就直接用
    const t = node.translation || [0, 0, 0] // 位移
    const q = node.rotation || [0, 0, 0, 1]
    const s = node.scale || [1, 1, 1]
    const x = q[0], y = q[1], z = q[2], w = q[3]
    const x2 = x + x, y2 = y + y, z2 = z + z
    const xx = x * x2, xy = x * y2, xz = x * z2
    const yy = y * y2, yz = y * z2, zz = z * z2
    const wx = w * x2, wy = w * y2, wz = w * z2
    return [
      (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
      (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
      (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
      t[0], t[1], t[2], 1
    ]
  }

  /** 两张变换表相乘：子零件叠在父零件上 */
  function matMul(a, b) {
    const out = new Array(16)
    for (let c = 0; c < 4; c += 1) {
      for (let r = 0; r < 4; r += 1) {
        out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
      }
    }
    return out
  }

  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] // 不移动、不旋转、不缩放

  /** 这张表是不是「什么都没变」 */
  function isIdentity(m) {
    for (let i = 0; i < 16; i += 1) {
      if (Math.abs(m[i] - IDENTITY[i]) > 1e-9) return false
    }
    return true
  }

  /** 按变换表把顶点和法线搬到堆场世界坐标，集卡零件才对得上 */
  function applyMatrix(m, positions, normals) {
    if (isIdentity(m)) return
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2]
      positions[i] = m[0] * x + m[4] * y + m[8] * z + m[12]
      positions[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
      positions[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
      if (!normals) continue
      const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2]
      const tx = m[0] * nx + m[4] * ny + m[8] * nz
      const ty = m[1] * nx + m[5] * ny + m[9] * nz
      const tz = m[2] * nx + m[6] * ny + m[10] * nz
      const len = Math.hypot(tx, ty, tz) || 1
      normals[i] = tx / len
      normals[i + 1] = ty / len
      normals[i + 2] = tz / len
    }
  }

  const meshes = [] // 拆出来的一块块网格，后面用来画车

  /** 把模型里的一块零件（顶点、贴图、颜色）收进 meshes */
  function collectMesh(meshIndex, matrix) {
    const mesh = (gltf.meshes || [])[meshIndex]
    if (!mesh) return
    ;(mesh.primitives || []).forEach(prim => {
      const attrs = prim.attributes || {}
      const posAcc = gltf.accessors[attrs.POSITION] || {}
      let positions = accessorArray(attrs.POSITION)
      if (!positions) return
      // 量化模型的位置是归一化整型，先还原成 [-1,1] 再由节点矩阵缩放回真实尺寸
      positions = toFloatNormalized(positions, posAcc.componentType, posAcc.normalized)
      let normals = null
      if (attrs.NORMAL != null) {
        const nAcc = gltf.accessors[attrs.NORMAL] || {}
        normals = toFloatNormalized(accessorArray(attrs.NORMAL), nAcc.componentType, nAcc.normalized)
      }
      applyMatrix(matrix, positions, normals)
      let uvs = null
      if (attrs.TEXCOORD_0 != null) {
        const uvAcc = gltf.accessors[attrs.TEXCOORD_0] || {}
        uvs = toFloatNormalized(accessorArray(attrs.TEXCOORD_0), uvAcc.componentType, uvAcc.normalized)
      }
      const indices = prim.indices != null ? accessorArray(prim.indices) : null
      const mat = (gltf.materials || [])[prim.material] || {}
      const pbr = mat.pbrMetallicRoughness || {}
      const factor = pbr.baseColorFactor || [0.7, 0.7, 0.7, 1]
      meshes.push({
        positions: new Float32Array(positions), // 顶点坐标
        normals: normals ? new Float32Array(normals) : null, // 法线，用来受光
        uvs, // 贴图坐标
        indices: indices
          ? (indices instanceof Uint16Array ? new Uint16Array(indices) : new Uint32Array(indices))
          : null, // 三角形怎么连
        color: packColor(factor), // 底色
        opacity: factor[3] != null ? factor[3] : 1, // 透明度
        // 与 obj_to_glb 一致：无 IBL 时默认金属度不能为 1，否则侧面死黑
        metalness: pbr.metallicFactor != null ? pbr.metallicFactor : 0.08,
        roughness: pbr.roughnessFactor != null ? pbr.roughnessFactor : 0.62,
        doubleSided: mat.doubleSided !== false,
        alphaMode: mat.alphaMode || 'OPAQUE',
        maps: {
          base: textureRef(pbr.baseColorTexture), // 颜色贴图
          metalRough: textureRef(pbr.metallicRoughnessTexture), // 金属/粗糙
          normal: textureRef(mat.normalTexture), // 凹凸
          occlusion: textureRef(mat.occlusionTexture), // 阴影遮挡
          emissive: textureRef(mat.emissiveTexture) // 自发光
        },
        emissive: mat.emissiveFactor ? packColor(mat.emissiveFactor) : 0,
        normalScale: (mat.normalTexture && mat.normalTexture.scale != null)
          ? mat.normalTexture.scale
          : 1,
        boundsMin: posAcc.min || null,
        boundsMax: posAcc.max || null
      })
    })
  }

  const scene = (gltf.scenes || [])[gltf.scene || 0] // 文件里的主场景
  if (scene && scene.nodes && gltf.nodes) {
    const walk = (nodeIndex, parent) => { // 按父子关系把零件摆到世界坐标
      const node = gltf.nodes[nodeIndex]
      if (!node) return
      const m = matMul(parent, trsMatrix(node))
      if (node.mesh != null) collectMesh(node.mesh, m)
      ;(node.children || []).forEach(child => walk(child, m))
    }
    scene.nodes.forEach(root => walk(root, IDENTITY))
  } else {
    // 没有场景描述就退化成平铺读取，等价于旧行为
    ;(gltf.meshes || []).forEach((_, i) => collectMesh(i, IDENTITY))
  }
  return meshes
}

const cache = {} // 正在读或已经读完的包内模型，避免同一辆车读两遍

/**
 * 模型只有 models/*.glb 一个来源。
 * 早先那套 *Parts.js 是同一份网格的 JS 顶点数组副本，GLB 直读打通后纯属重复占包体，
 * 而且贴图也塞不进 JS 数组，已移除。GLB 未就绪时该物体先不出现，解析完自动补上。
 */
function fallbackParts() {
  return null
}

/** GLB 解析完成的高模，按名字缓存 */
const loaded = {}
const readyListeners = [] // 场图等模型好了再把低模换成高模

/** 取出已经解析好的网格；还没有就空着，场图先不画这个物体 */
function partsOf(name) {
  return loaded[name] || fallbackParts(name)
}

/** GLB 就绪回调：场景据此把兜底低模换成高模 */
function onModelReady(fn) {
  if (typeof fn !== 'function' || readyListeners.indexOf(fn) >= 0) return () => {}
  readyListeners.push(fn)
  return () => {
    const i = readyListeners.indexOf(fn)
    if (i >= 0) readyListeners.splice(i, 1)
  }
}

/** 告诉场图：这个名字的高模已经可以换上去了 */
function notifyReady(name, parts) {
  readyListeners.forEach(fn => {
    try { fn(name, parts) } catch (error) { /* ignore */ }
  })
}

/** 先读包内低模保证场图不空，再去下远端高模 */
function preload() {
  const local = Promise.all(
    Object.keys(MODEL_FILES).map(n => loadVehicleData(n).catch(() => null))
  )
  // 包内低模先到位保证有东西可看，再去拉远端高模，不和首屏抢带宽
  return local.then(parts => {
    preloadRemote()
    return parts
  })
}

/** 读并解析包内某个模型，解析完缓存起来给场图用 */
function loadVehicleData(name) {
  if (loaded[name]) return Promise.resolve(loaded[name])
  if (!cache[name]) {
    cache[name] = readPackageBin(name)
      .then(buf => {
        const parts = parseGlb(buf)
        if (!parts || !parts.length) throw new Error('网格为空')
        // 远端高模可能已经先到，别被包内低模顶掉
        if (remoteLoaded[name]) return loaded[name]
        loaded[name] = parts
        notifyReady(name, parts)
        return parts
      })
      .catch(error => {
        console.warn('[vehicleLoader] GLB 读取失败', name, error && error.message)
        return fallbackParts(name)
      })
  }
  return cache[name]
}

/* ------------------------------------------------------------------ *
 * 远端高模
 *
 * 小程序主包上限 2MB，集卡高模单个就 1.5MB+，放不进包。
 * 这里按「本地缓存 → 远端下载 → 包内低模」三级回退，
 * 任何一级失败都只是精度下降，不影响功能。
 * 文件名带 version，换模型时递增即可让所有客户端重新下载。
 * ------------------------------------------------------------------ */

/* 服务端文件名拼成 <base>_v<version>.glb。
   版本号进文件名，新旧版本共存、CDN 可以长缓存；换模型时上传新文件并把 version 加一即可。 */
const REMOTE_MODELS = {
  truck: { base: 'truck_hd', version: 2 } // 目前只下集卡高模，换模型时把 version 加一
}

/** 远端文件名：名字_版本.glb */
function remoteFileOf(name) {
  const meta = REMOTE_MODELS[name]
  return `${meta.base}_v${meta.version}.glb`
}

/** 已由远端覆盖的模型，防止包内低模回头把它盖掉 */
const remoteLoaded = {}

/** 微信给这台手机划的本地目录，用来缓存下好的高模 */
function userDataDir() {
  return (typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH) || ''
}

/** 这台手机上这份高模该存在哪 */
function cachePathOf(name) {
  return `${userDataDir()}/model_${name}_v${REMOTE_MODELS[name].version}.glb`
}

/** 从手机本地读已经缓存的高模 */
function readLocalFile(fsm, filePath) {
  return new Promise((resolve, reject) => {
    fsm.readFile({ filePath, success: res => resolve(res.data), fail: reject })
  })
}

/** 从配置的地址下载高模，超时 60 秒 */
function downloadRemote(name) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: `${config.modelBaseUrl}/${remoteFileOf(name)}`,
      timeout: 60000,
      success: res => {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode))
          return
        }
        resolve(res.tempFilePath)
      },
      fail: err => reject(new Error((err && err.errMsg) || '下载失败'))
    })
  })
}

/** 落盘失败（存储满等）不算致命，这次下载的临时文件还能用，下次再试 */
function persist(fsm, tempFilePath, target) {
  return new Promise(resolve => {
    fsm.saveFile({
      tempFilePath,
      filePath: target,
      success: () => resolve(target),
      fail: () => resolve(tempFilePath)
    })
  })
}

/** 本地缓存 → 远端下载 → 失败就沿用包内低模 */
function loadRemoteModel(name) {
  if (!REMOTE_MODELS[name] || !config.modelBaseUrl || !userDataDir()) {
    return Promise.resolve(null)
  }
  const fsm = wx.getFileSystemManager()
  const cached = cachePathOf(name)
  return readLocalFile(fsm, cached)
    .catch(() => downloadRemote(name)
      .then(tmp => persist(fsm, tmp, cached))
      .then(path => readLocalFile(fsm, path)))
    .then(buf => {
      const parts = parseGlb(buf)
      if (!parts || !parts.length) throw new Error('网格为空')
      loaded[name] = parts
      remoteLoaded[name] = true
      notifyReady(name, parts)
      return parts
    })
    .catch(error => {
      console.warn('[vehicleLoader] 远端高模不可用，沿用包内低模', name, error && error.message)
      return null
    })
}

/** 清掉版本号对不上的旧缓存，否则每次升版都会在本地留一份废文件 */
function sweepCache() {
  const dir = userDataDir()
  if (!dir) return
  const fsm = wx.getFileSystemManager()
  let files = []
  try {
    files = fsm.readdirSync(dir)
  } catch (error) {
    return
  }
  const keep = {} // 当前版本该留下的文件名
  Object.keys(REMOTE_MODELS).forEach(n => {
    keep[`model_${n}_v${REMOTE_MODELS[n].version}.glb`] = true
  })
  files.forEach(f => {
    if (f.indexOf('model_') !== 0 || keep[f]) return
    try {
      fsm.unlinkSync(`${dir}/${f}`)
    } catch (error) { /* 删不掉就算了，不影响功能 */ }
  })
}

/** 清掉旧版缓存后再去拉远端高模 */
function preloadRemote() {
  sweepCache()
  return Promise.all(Object.keys(REMOTE_MODELS).map(n => loadRemoteModel(n)))
}

/** 给几何体挂上一组顶点/法线/UV，兼容新旧 Three 接口 */
function attachAttr(geo, name, attr) {
  if (typeof geo.setAttribute === 'function') {
    geo.setAttribute(name, attr)
    return
  }
  geo.addAttribute(name, attr)
}

/* ------------------------------------------------------------------ *
 * 贴图：GLB 内嵌图片 → THREE.Texture
 * 小程序没有全局 Image，必须用 canvas.createImage()；图片字节先落临时文件，
 * 比 base64 data URI 省一大截内存。
 * ------------------------------------------------------------------ */

/** 图片文件路径可跨 canvas 复用 */
const texFileCache = new Map()
/** Texture 不能跨 canvas（每个 canvas 有自己的 THREE），按 THREE 实例分开存 */
const texStore = typeof WeakMap === 'function' ? new WeakMap() : null

/** 用文件长度和开头几个字节当钥匙，同一张贴图不写两遍 */
function texKey(ref) {
  const len = ref.bytes.byteLength
  const head = new Uint8Array(ref.bytes, 0, Math.min(12, len))
  let sig = ''
  for (let i = 0; i < head.length; i += 1) sig += head[i].toString(16)
  return len + '_' + sig
}

/** 把贴图字节落到手机临时文件，给 canvas.createImage 去读 */
function writeTexFile(key, ref) {
  if (texFileCache.has(key)) return texFileCache.get(key)
  const ext = ref.mime === 'image/jpeg' ? 'jpg' : 'png'
  const path = `${wx.env.USER_DATA_PATH}/glbtex_${key}.${ext}`
  try {
    wx.getFileSystemManager().writeFileSync(path, ref.bytes)
    texFileCache.set(key, path)
    return path
  } catch (error) {
    console.warn('[vehicleLoader] 贴图落盘失败', error && error.message)
    texFileCache.set(key, null)
    return null
  }
}

/** 贴图铺不满时怎么重复：夹边、镜像、还是平铺 */
function wrapMode(THREE, code) {
  if (code === 33071) return THREE.ClampToEdgeWrapping
  if (code === 33648) return THREE.MirroredRepeatWrapping
  return THREE.RepeatWrapping
}

/** 把 GLB 里的图片变成这块画布能用的贴图；同一张按画布复用 */
function makeTexture(THREE, canvas, ref, srgb) {
  if (!ref || !ref.bytes || !canvas || typeof canvas.createImage !== 'function') return null
  let store = texStore && texStore.get(THREE)
  if (texStore && !store) {
    store = new Map()
    texStore.set(THREE, store)
  }
  const base = texKey(ref)
  const key = base + (srgb ? '#s' : '#l')
  if (store && store.has(key)) return store.get(key)

  const texture = new THREE.Texture()
  texture.wrapS = wrapMode(THREE, ref.wrapS)
  texture.wrapT = wrapMode(THREE, ref.wrapT)
  // glTF 的 UV 原点在左上，与 Three 默认的 flipY 相反
  texture.flipY = false
  if (srgb && THREE.sRGBEncoding != null) texture.encoding = THREE.sRGBEncoding
  if (store) store.set(key, texture)

  const path = writeTexFile(base, ref)
  if (!path) return texture
  const img = canvas.createImage()
  img.onload = () => {
    texture.image = img
    texture.needsUpdate = true
  }
  img.onerror = () => console.warn('[vehicleLoader] 贴图解码失败', path)
  img.src = path
  return texture
}

/**
 * 堆场 canvas 无环境贴图，PBR 金属度/透明参数需压到户外可视范围。
 */
function resolveMaterialParams(part, opts) {
  const options = opts || {}
  const outdoor = options.outdoor !== false && !options.envMap
  let opacity = part.opacity != null ? part.opacity : 1
  let alphaMode = part.alphaMode || 'OPAQUE'
  if (options.opaqueGlass && alphaMode !== 'OPAQUE') {
    alphaMode = 'OPAQUE'
    opacity = 1
  }
  let metalness = part.metalness != null ? part.metalness : 0.08
  let roughness = part.roughness != null ? part.roughness : 0.62
  if (outdoor) {
    metalness = Math.min(Math.max(metalness, 0), 0.28)
    if (metalness > 0.14) metalness = 0.1
    roughness = Math.min(1, Math.max(roughness, 0.4))
  }
  let doubleSided = part.doubleSided !== false
  if (options.forceDoubleSide) doubleSided = true
  const transparent = alphaMode === 'BLEND' || (opacity < 0.98 && alphaMode !== 'OPAQUE')
  return { opacity, alphaMode, metalness, roughness, doubleSided, transparent }
}

/**
 * 建材质。
 * 带贴图/PBR 参数的走 MeshStandardMaterial；
 * 没有贴图的老烘焙模型退到 MeshLambertMaterial——至少受光，有明暗过渡，
 * 不再是以前 MeshBasicMaterial 那种完全死平的色块。
 */
function buildMaterial(THREE, part, options) {
  const opts = options || {}
  const canvas = opts.canvas
  const maps = part.maps || {}
  const hasTexture = Boolean(maps.base || maps.normal || maps.metalRough || maps.emissive)
  const params = resolveMaterialParams(part, opts)
  const common = { color: part.color }
  if (params.transparent) {
    common.transparent = true
    common.opacity = params.opacity
  }

  if (!hasTexture) {
    common.side = params.doubleSided ? THREE.DoubleSide : THREE.FrontSide
    if (opts.unlit) return new THREE.MeshBasicMaterial(common)
    return new THREE.MeshLambertMaterial(common)
  }

  common.side = params.doubleSided ? THREE.DoubleSide : THREE.FrontSide
  const outdoor = opts.outdoor !== false && !opts.envMap
  const mat = new THREE.MeshStandardMaterial(Object.assign(common, {
    metalness: params.metalness,
    roughness: params.roughness
  }))
  const baseMap = makeTexture(THREE, canvas, maps.base, true)
  if (baseMap) mat.map = baseMap
  const normalMap = makeTexture(THREE, canvas, maps.normal, false)
  if (normalMap) {
    mat.normalMap = normalMap
    const s = part.normalScale != null ? part.normalScale : 1
    if (mat.normalScale && mat.normalScale.set) mat.normalScale.set(s, s)
  }
  const mrMap = makeTexture(THREE, canvas, maps.metalRough, false)
  if (mrMap) {
    // glTF 把金属度存在 B 通道、粗糙度存在 G 通道，共用一张图
    mat.roughnessMap = mrMap
    if (!outdoor) mat.metalnessMap = mrMap
  }
  const aoMap = makeTexture(THREE, canvas, maps.occlusion, false)
  if (aoMap) mat.aoMap = aoMap
  const emissiveMap = makeTexture(THREE, canvas, maps.emissive, true)
  if (emissiveMap) {
    mat.emissiveMap = emissiveMap
    if (mat.emissive && mat.emissive.setHex) mat.emissive.setHex(0xffffff)
  } else if (part.emissive && mat.emissive && mat.emissive.setHex) {
    mat.emissive.setHex(part.emissive)
  }
  if (opts.envMap && !mat.envMap) mat.envMap = opts.envMap
  return mat
}

/** 建几何体，顺带把 aoMap 需要的第二套 UV 补上 */
function buildGeometry(THREE, part) {
  const geo = new THREE.BufferGeometry()
  const positions = part.positions instanceof Float32Array
    ? part.positions
    : new Float32Array(part.positions)
  attachAttr(geo, 'position', new THREE.BufferAttribute(positions, 3))
  if (part.normals) {
    const normals = part.normals instanceof Float32Array
      ? part.normals
      : new Float32Array(part.normals)
    attachAttr(geo, 'normal', new THREE.BufferAttribute(normals, 3))
  }
  if (part.uvs) {
    const uvs = part.uvs instanceof Float32Array ? part.uvs : new Float32Array(part.uvs)
    const uvAttr = new THREE.BufferAttribute(uvs, 2)
    attachAttr(geo, 'uv', uvAttr)
    // Three 的 aoMap 读 uv2，glTF 通常只给一套 UV
    if (part.maps && part.maps.occlusion) {
      attachAttr(geo, 'uv2', new THREE.BufferAttribute(uvs, 2))
    }
  }
  if (part.indices) {
    geo.setIndex(toIndexAttr(THREE, part.indices))
  }
  if (!part.normals && typeof geo.computeVertexNormals === 'function') {
    geo.computeVertexNormals()
  }
  return geo
}

/** 三角形编号：点少用 16 位，点多用 32 位 */
function toIndexAttr(THREE, raw) {
  if (raw instanceof Uint16Array || raw instanceof Uint32Array) {
    return new THREE.BufferAttribute(raw, 1)
  }
  let max = 0
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] > max) max = raw[i]
  }
  const typed = max > 65535 ? new Uint32Array(raw) : new Uint16Array(raw)
  return new THREE.BufferAttribute(typed, 1)
}

/** 用解析好的网格在这块画布上真正拼出一辆车/一台堆高机 */
function instantiate(THREE, parts, options) {
  if (!parts || !parts.length) {
    throw new Error('模型网格为空')
  }
  const opts = options || {}
  const group = new THREE.Group()
  parts.forEach(part => {
    const geo = buildGeometry(THREE, part)
    if (typeof geo.computeBoundingBox === 'function') geo.computeBoundingBox()
    if (typeof geo.computeBoundingSphere === 'function') geo.computeBoundingSphere()
    const mesh = new THREE.Mesh(geo, buildMaterial(THREE, part, opts))
    mesh.frustumCulled = false
    if (opts.shadow) {
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
    group.add(mesh)
  })
  return group
}

/** 到位页小景：车道上停一辆集卡，或堆高机慢慢转一下 */
function createVignette(canvas, width, height, dpr, THREE, parts, kind) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
  renderer.setPixelRatio(dpr || 2)
  renderer.setSize(width, height, false)
  renderer.setClearColor(kind === 'arrive' ? 0xdbe4ee : 0xfff4eb, 1) // 到位偏蓝灰，其它偏暖
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb0b8c2, 1.05)) // 天光
  const sun = new THREE.DirectionalLight(0xfff4e6, 0.7) // 太阳
  sun.position.set(8, 16, 10)
  scene.add(sun)
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.2, 80)
  const root = new THREE.Group()
  scene.add(root)

  const ground = new THREE.Mesh( // 地面
    new THREE.PlaneGeometry(28, 22),
    new THREE.MeshBasicMaterial({ color: kind === 'arrive' ? 0xe8edf2 : 0xf3e6d4 })
  )
  ground.rotation.x = -Math.PI / 2
  root.add(ground)

  if (kind === 'arrive') {
    const lane = new THREE.Mesh( // 中间车道
      new THREE.PlaneGeometry(7.4, 18),
      new THREE.MeshBasicMaterial({ color: 0xd5dce4 })
    )
    lane.rotation.x = -Math.PI / 2
    lane.position.y = 0.02
    root.add(lane)
    const centerLine = new THREE.Mesh( // 车道黄线
      new THREE.PlaneGeometry(0.18, 16),
      new THREE.MeshBasicMaterial({ color: 0xfacc15 })
    )
    centerLine.rotation.x = -Math.PI / 2
    centerLine.position.set(0, 0.03, 0)
    root.add(centerLine)
    const highlight = new THREE.Mesh( // 停车位浅蓝高亮
      new THREE.PlaneGeometry(4.4, 12),
      new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.12 })
    )
    highlight.rotation.x = -Math.PI / 2
    highlight.position.set(0, 0.04, 1.2)
    root.add(highlight)
    const truck = instantiate(THREE, parts.truck) // 停在车道上的集卡
    truck.position.set(0, 0, 1.6)
    truck.rotation.y = 0
    truck.scale.setScalar(0.5)
    root.add(truck)
    if (parts.stacker && parts.stacker.length) {
      try {
        const stacker = instantiate(THREE, parts.stacker) // 贝位前方作业的堆高机
        stacker.position.set(0.2, 0, -5.2)
        stacker.rotation.y = Math.PI
        stacker.scale.setScalar(0.38)
        root.add(stacker)
      } catch (e) {
        // 堆高机模型未就绪时仅展示集卡
      }
    }
    ;[-6.6, 6.6].forEach(x => {
      for (let i = 0; i < 3; i += 1) {
        for (let t = 0; t < 3; t += 1) {
          const box = new THREE.Mesh( // 两侧示意箱堆
            new THREE.BoxGeometry(2.44, 2.59, 6.06),
            new THREE.MeshBasicMaterial({ color: 0xe8edf2 })
          )
          box.position.set(x, 1.3 + t * 2.62, (i - 1) * 6.3)
          root.add(box)
        }
      }
    })
    camera.position.set(0, 24, 0.2)
    camera.lookAt(0, 0, 0)
  } else {
    const stacker = instantiate(THREE, parts.stacker)
    stacker.position.set(0, 0, 0)
    stacker.scale.setScalar(0.72)
    root.add(stacker)
    camera.position.set(11, 9.5, 12)
    camera.lookAt(0, 4.2, -0.8)
  }

  let running = true // 页还在就继续画
  let spin = 0 // 堆高机小景左右轻摇
  function loop() {
    if (!running) return
    canvas.requestAnimationFrame(loop)
    if (kind !== 'arrive') {
      spin += 0.008
      root.rotation.y = Math.sin(spin) * 0.18
    }
    renderer.render(scene, camera)
  }
  loop()
  return {
    dispose() {
      running = false // 离开到位页停画
      renderer.dispose()
    }
  }
}

/** 堆场里成百上千个同色箱子，先做好一份几何模板再上色复用 */
function createTemplate(THREE, parts) {
  if (!parts || !parts.length) return null
  return parts.map(part => ({
    geo: buildGeometry(THREE, part),
    part,
    color: part.color,
    mat: null,
    tintMats: null
  }))
}

/** 用模板再变出一个箱子，车体零件按颜色复用材质 */
function instantiateTemplate(THREE, template, tint, options) {
  if (!template) return null
  const opts = options || {}
  const group = new THREE.Group()
  template.forEach((item, index) => {
    const tinted = (index === 0 || index === 2) && tint != null
    let mat
    if (tinted) {
      // 堆场里同色箱子成百上千，材质按颜色复用，别一个箱子一份
      if (!item.tintMats) item.tintMats = new Map()
      mat = item.tintMats.get(tint)
      if (!mat) {
        mat = buildMaterial(THREE, Object.assign({}, item.part, { color: tint }), opts)
        item.tintMats.set(tint, mat)
      }
    } else {
      if (!item.mat) item.mat = buildMaterial(THREE, item.part, opts)
      mat = item.mat
    }
    const mesh = new THREE.Mesh(item.geo, mat)
    if (opts.shadow) {
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
    group.add(mesh)
  })
  return group
}

module.exports = {
  parseGlb, // 拆 GLB
  loadVehicleData, // 读包内模型
  preload, // 进导航前先热身
  onModelReady, // 高模好了通知场图
  getTruckParts() {
    return partsOf('truck') // 集卡网格
  },
  getStackerParts() {
    return partsOf('stacker') // 堆高机网格
  },
  getContainerParts(size) {
    return partsOf(size === 20 ? 'container20' : 'container40') // 20/40 尺箱
  },
  getCrossingParts() {
    return partsOf('crossing') // 路口
  },
  instantiate, // 在画布上拼出一辆
  createTemplate, // 箱子模板
  instantiateTemplate, // 按颜色复用箱子
  createVignette, // 到位页小景
  loadPair() {
    return Promise.all([
      loadVehicleData('truck'),
      loadVehicleData('stacker'),
      loadVehicleData('container20'),
      loadVehicleData('container40')
    ]).then(pair => ({
      truck: pair[0], // 集卡
      stacker: pair[1], // 堆高机
      container20: pair[2], // 20 尺箱
      container40: pair[3] // 40 尺箱
    }))
  }
}
