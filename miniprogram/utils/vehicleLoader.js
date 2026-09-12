/**
 * 从代码包读取 GLB，解析成与 Three 实例无关的网格数据，再实例化。
 * 微信小程序每个 webgl canvas 都有自己的 THREE，不能跨 canvas clone。
 */
function readPackageBin(name) {
  // 路径必须是源码里的字面量，微信 ignoreUploadUnusedFiles 才认，变量拼出来的 .glb 真机不会打进包
  const candidates = name === 'truck'
    ? ['/models/truck.glb', 'models/truck.glb']
    : name === 'stacker'
      ? ['/models/stacker.glb', 'models/stacker.glb']
      : name === 'container20'
        ? ['/models/container20.glb', 'models/container20.glb']
        : ['/models/container40.glb', 'models/container40.glb']
  return new Promise((resolve, reject) => {
    const tryRead = index => {
      if (index >= candidates.length) {
        reject(new Error('无法读取模型文件 ' + name))
        return
      }
      wx.getFileSystemManager().readFile({
        filePath: candidates[index],
        success: res => resolve(res.data),
        fail: () => tryRead(index + 1)
      })
    }
    tryRead(0)
  })
}

function packColor(factor) {
  const r = Math.round((factor[0] || 0) * 255)
  const g = Math.round((factor[1] || 0) * 255)
  const b = Math.round((factor[2] || 0) * 255)
  return (r << 16) | (g << 8) | b
}

function asArrayBuffer(buffer) {
  if (buffer instanceof ArrayBuffer) return buffer
  if (buffer && buffer.buffer instanceof ArrayBuffer) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  }
  throw new Error('无法读取模型二进制')
}

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

function parseGlb(buffer) {
  const data = asArrayBuffer(buffer)
  const view = new DataView(data)
  if (view.getUint32(0, true) !== 0x46546c67) {
    throw new Error('不是有效的 GLB')
  }
  const jsonLen = view.getUint32(12, true)
  const jsonStart = 20
  const jsonText = decodeUtf8(new Uint8Array(data, jsonStart, jsonLen))
  const gltf = JSON.parse(jsonText)
  let binOffset = jsonStart + jsonLen
  if (binOffset % 4) binOffset += 4 - (binOffset % 4)
  const binLen = view.getUint32(binOffset, true)
  const binStart = binOffset + 8
  const bin = data.slice(binStart, binStart + binLen)

  function copyBytes(start, byteLength) {
    const src = new Uint8Array(bin, start, byteLength)
    const aligned = new ArrayBuffer(byteLength)
    new Uint8Array(aligned).set(src)
    return aligned
  }

  function accessorArray(index) {
    const acc = gltf.accessors[index]
    const viewInfo = gltf.bufferViews[acc.bufferView]
    const start = (viewInfo.byteOffset || 0) + (acc.byteOffset || 0)
    const size = acc.type === 'VEC3' ? 3 : 1
    const count = acc.count * size
    if (acc.componentType === 5126) {
      return new Float32Array(copyBytes(start, count * 4))
    }
    if (acc.componentType === 5123) {
      return new Uint16Array(copyBytes(start, count * 2))
    }
    return new Uint32Array(copyBytes(start, count * 4))
  }

  const meshes = []
  ;(gltf.meshes || []).forEach(mesh => {
    (mesh.primitives || []).forEach(prim => {
      const positions = accessorArray(prim.attributes.POSITION)
      const normals = prim.attributes.NORMAL != null ? accessorArray(prim.attributes.NORMAL) : null
      const indices = prim.indices != null ? accessorArray(prim.indices) : null
      const mat = (gltf.materials || [])[prim.material] || {}
      const factor = (((mat.pbrMetallicRoughness || {}).baseColorFactor) || [0.7, 0.7, 0.7, 1])
      meshes.push({
        positions: new Float32Array(positions),
        normals: normals ? new Float32Array(normals) : null,
        indices: indices ? (indices instanceof Uint16Array ? new Uint16Array(indices) : new Uint32Array(indices)) : null,
        color: packColor(factor)
      })
    })
  })
  return meshes
}

const cache = {}
const TRUCK_PARTS = require('../models/truckParts.js')
const STACKER_PARTS = require('../models/stackerParts.js')
const CONTAINER20_PARTS = require('../models/container20Parts.js')
const CONTAINER40_PARTS = require('../models/container40Parts.js')

function loadVehicleData(name) {
  if (name === 'truck') return Promise.resolve(TRUCK_PARTS)
  if (name === 'stacker') return Promise.resolve(STACKER_PARTS)
  if (name === 'container20') return Promise.resolve(CONTAINER20_PARTS)
  if (name === 'container40') return Promise.resolve(CONTAINER40_PARTS)
  if (!cache[name]) {
    cache[name] = readPackageBin(name).then(parseGlb).catch(error => {
      console.warn('[vehicleLoader] 读取失败', name, error && error.message)
      return null
    })
  }
  return cache[name]
}

function attachAttr(geo, name, attr) {
  if (typeof geo.setAttribute === 'function') {
    geo.setAttribute(name, attr)
    return
  }
  geo.addAttribute(name, attr)
}

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

function instantiate(THREE, parts) {
  if (!parts || !parts.length) {
    throw new Error('模型网格为空')
  }
  const group = new THREE.Group()
  parts.forEach(part => {
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
    if (part.indices) {
      geo.setIndex(toIndexAttr(THREE, part.indices))
    }
    if (typeof geo.computeBoundingBox === 'function') geo.computeBoundingBox()
    if (typeof geo.computeBoundingSphere === 'function') geo.computeBoundingSphere()
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: part.color,
      side: THREE.DoubleSide
    }))
    mesh.frustumCulled = false
    group.add(mesh)
  })
  return group
}

function createVignette(canvas, width, height, dpr, THREE, parts, kind) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
  renderer.setPixelRatio(dpr || 2)
  renderer.setSize(width, height, false)
  renderer.setClearColor(kind === 'arrive' ? 0xdbe4ee : 0xfff4eb, 1)
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb0b8c2, 1.05))
  const sun = new THREE.DirectionalLight(0xfff4e6, 0.7)
  sun.position.set(8, 16, 10)
  scene.add(sun)
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.2, 80)
  const root = new THREE.Group()
  scene.add(root)

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(28, 22),
    new THREE.MeshBasicMaterial({ color: kind === 'arrive' ? 0xe8edf2 : 0xf3e6d4 })
  )
  ground.rotation.x = -Math.PI / 2
  root.add(ground)

  if (kind === 'arrive') {
    const lane = new THREE.Mesh(
      new THREE.PlaneGeometry(7.4, 18),
      new THREE.MeshBasicMaterial({ color: 0xd5dce4 })
    )
    lane.rotation.x = -Math.PI / 2
    lane.position.y = 0.02
    root.add(lane)
    const highlight = new THREE.Mesh(
      new THREE.PlaneGeometry(4.4, 12),
      new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.14 })
    )
    highlight.rotation.x = -Math.PI / 2
    highlight.position.set(-1.8, 0.04, 0)
    root.add(highlight)
    const truck = instantiate(THREE, parts.truck)
    truck.position.set(-1.8, 0, 0.4)
    truck.rotation.y = 0
    truck.scale.setScalar(0.55)
    root.add(truck)
    ;[-6.6, 6.6].forEach(x => {
      for (let i = 0; i < 3; i += 1) {
        for (let t = 0; t < 3; t += 1) {
          const box = new THREE.Mesh(
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

  let running = true
  let spin = 0
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
      running = false
      renderer.dispose()
    }
  }
}

function createTemplate(THREE, parts) {
  if (!parts || !parts.length) return null
  return parts.map(part => {
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
    } else if (typeof geo.computeVertexNormals === 'function') {
      geo.computeVertexNormals()
    }
    if (part.indices) {
      geo.setIndex(toIndexAttr(THREE, part.indices))
    }
    return { geo, color: part.color }
  })
}

function instantiateTemplate(THREE, template, tint) {
  if (!template) return null
  const group = new THREE.Group()
  template.forEach((part, index) => {
    const color = (index === 0 || index === 2) && tint != null ? tint : part.color
    group.add(new THREE.Mesh(part.geo, new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide
    })))
  })
  return group
}

module.exports = {
  loadVehicleData,
  getTruckParts() {
    return TRUCK_PARTS
  },
  getStackerParts() {
    return STACKER_PARTS
  },
  getContainerParts(size) {
    return size === 20 ? CONTAINER20_PARTS : CONTAINER40_PARTS
  },
  instantiate,
  createTemplate,
  instantiateTemplate,
  createVignette,
  loadPair() {
    return Promise.all([
      loadVehicleData('truck'),
      loadVehicleData('stacker'),
      loadVehicleData('container20'),
      loadVehicleData('container40')
    ]).then(pair => ({
      truck: pair[0],
      stacker: pair[1],
      container20: pair[2],
      container40: pair[3]
    }))
  }
}
