/**
 * 手机朝向：正北 0°，顺时针为正。
 */

let heading = null
let source = ''
let started = false
let listenersBound = false
let platform = ''
let sdk = ''
let lastBeta = 25
let lastGamma = 0
let lastAlpha = null
let lastMotionAt = 0
let lastGyroAt = 0
let lastCompassAt = 0
let lastCompass = null
let fused = null
let headingOffset = null
let prevMotionH = null
let lastAccel = { x: 0, y: 0, z: 1 }
const listeners = []

const debug = {
  platform: '',
  sdk: '',
  started: false,
  heading: null,
  source: '',
  published: 0,
  compass: { n: 0, drop: 0, last: null, acc: '', ok: '', fail: '', reason: '' },
  motion: { n: 0, drop: 0, last: '', ok: '', fail: '', reason: '' },
  gyro: { n: 0, drop: 0, last: '', ok: '', fail: '', reason: '' },
  accel: { n: 0, ok: '', fail: '', last: '' },
  privacy: '',
  mode: '-',
  device: ''
}

function log() {}

function normalize(deg) {
  let value = Number(deg)
  if (Number.isNaN(value)) return null
  while (value < 0) value += 360
  while (value >= 360) value -= 360
  return value
}

function shortestDiff(from, to) {
  return ((to - from + 540) % 360) - 180
}

function lerpAngle(from, to, t) {
  return normalize(from + shortestDiff(from, to) * t)
}

function round1(value) {
  const n = Number(value)
  if (Number.isNaN(n)) return '-'
  return Math.round(n * 10) / 10
}

function publish(next, from) {
  const value = normalize(next)
  if (value == null) return
  const prev = heading
  heading = value
  source = from
  debug.heading = value
  debug.source = from
  if (prev != null && Math.abs(shortestDiff(prev, value)) < 1.2) return
  debug.published += 1
  listeners.forEach(fn => {
    try { fn(value, from) } catch (error) { /* ignore */ }
  })
}

function setFused(next, from) {
  const value = normalize(next)
  if (value == null) return
  fused = value
  if (heading == null) {
    publish(value, from)
    return
  }
  const err = Math.abs(shortestDiff(heading, value))
  const t = err > 40 ? 0.5 : err > 15 ? 0.28 : 0.14
  publish(lerpAngle(heading, value, t), from)
}

function onCompass(res) {
  debug.compass.n += 1
  if (debug.compass.n <= 3) log('compass raw', res)
  if (!res || res.direction == null) {
    debug.compass.drop += 1
    debug.compass.reason = 'no-direction'
    return
  }
  const dir = normalize(res.direction)
  debug.compass.last = dir
  debug.compass.acc = res.accuracy == null ? '' : String(res.accuracy)
  if (dir == null) {
    debug.compass.drop += 1
    debug.compass.reason = 'nan'
    return
  }
  if (res.accuracy === 'unreliable' || res.accuracy === 'no-contact') {
    debug.compass.drop += 1
    debug.compass.reason = 'acc=' + res.accuracy
    return
  }
  const first = lastCompass == null
  const delta = first ? 0 : Math.abs(shortestDiff(lastCompass, dir))
  lastCompass = dir
  // 东南西北大转向要收下；只丢掉接近对穿的坏值
  if (!first && delta > 175) {
    debug.compass.drop += 1
    debug.compass.reason = 'flip ' + round1(delta)
    return
  }
  if (!first && delta < 0.4) {
    debug.compass.drop += 1
    debug.compass.reason = 'delta ' + round1(delta)
    return
  }
  lastCompassAt = Date.now()
  debug.compass.reason = first ? 'first' : 'ok'
  fuseFromSensors()
}

/**
 * 设备顶边在水平面的朝向。平放时退回 alpha；倾斜时用姿态补偿，转手机就会变。
 */
function headingFromMotion(alpha, beta, gamma) {
  if (alpha == null || Number.isNaN(Number(alpha))) return null
  const tilt = Math.hypot(Number(beta) || 0, Number(gamma) || 0)
  if (tilt < 8) return normalize(alpha)
  const toRad = Math.PI / 180
  const x = (Number(beta) || 0) * toRad
  const y = (Number(gamma) || 0) * toRad
  const z = Number(alpha) * toRad
  const cX = Math.cos(x)
  const cY = Math.cos(y)
  const cZ = Math.cos(z)
  const sX = Math.sin(x)
  const sY = Math.sin(y)
  const sZ = Math.sin(z)
  const vx = -cZ * sY - sZ * sX * cY
  const vy = -sZ * sY + cZ * sX * cY
  if (Math.abs(vx) < 1e-6 && Math.abs(vy) < 1e-6) return normalize(alpha)
  let heading = Math.atan2(vx, vy) * 180 / Math.PI
  if (heading < 0) heading += 360
  return normalize(heading)
}

function onMotion(res) {
  debug.motion.n += 1
  if (!res) return
  debug.motion.last = 'a' + round1(res.alpha) + ' b' + round1(res.beta) + ' g' + round1(res.gamma)
  if (res.beta != null && !Number.isNaN(Number(res.beta))) lastBeta = Number(res.beta)
  if (res.gamma != null && !Number.isNaN(Number(res.gamma))) lastGamma = Number(res.gamma)
  if (res.alpha != null && !Number.isNaN(Number(res.alpha))) {
    lastAlpha = normalize(res.alpha)
    lastMotionAt = Date.now()
  }
  fuseFromSensors()
}

/**
 * 平放才信指南针（真北）。一倾斜，小米 compass 会随俯仰漂（02=283°、03=232°、04=241°），
 * 车头不能再跟 compass。倾斜后用姿态角 + 锁定偏置，只改倾斜角时车头不变。
 */
function fuseFromSensors() {
  const motionH = headingFromMotion(lastAlpha, lastBeta, lastGamma)
  const tilt = tiltFromFlatDeg()
  const compassOk = lastCompass != null && lastCompassAt && (Date.now() - lastCompassAt < 800)
  debug.mode = tilt < 22 ? 'flat-compass' : (tilt > 62 ? 'upright-lock' : 'tilt-lock')

  if (motionH != null && prevMotionH != null && headingOffset != null) {
    const jump = Math.abs(shortestDiff(prevMotionH, motionH))
    if (jump > 35) {
      headingOffset = shortestDiff(0, headingOffset + shortestDiff(motionH, prevMotionH))
      debug.motion.reason = 'alpha-jump ' + round1(jump)
    }
  }
  if (motionH != null) prevMotionH = motionH

  if (tilt < 22 && compassOk) {
    if (motionH != null) headingOffset = shortestDiff(motionH, lastCompass)
    debug.motion.reason = 'flat-cmp'
    setFused(lastCompass, 'compass')
    return
  }

  if (motionH == null) {
    debug.motion.reason = 'no-heading'
    if (compassOk && tilt < 50) setFused(lastCompass, 'compass')
    return
  }

  if (headingOffset == null && lastCompass != null) {
    headingOffset = shortestDiff(motionH, lastCompass)
  }
  const locked = headingOffset == null ? motionH : normalize(motionH + headingOffset)
  debug.motion.reason = 'lock ' + (headingOffset == null ? '-' : round1(headingOffset))
  setFused(locked, 'motion-h')
}

function tiltFromFlatDeg() {
  return Math.min(90, Math.hypot(lastBeta || 0, lastGamma || 0))
}

function phoneUpright() {
  return tiltFromFlatDeg() > 62
}

function phoneInPortrait() {
  return phoneUpright()
}

function phoneIsFlat() {
  if (phoneUpright()) return false
  const n = Math.hypot(lastAccel.x, lastAccel.y, lastAccel.z)
  if (n >= 0.35) return Math.abs(lastAccel.z) / n > 0.82 && tiltFromFlatDeg() < 28
  return tiltFromFlatDeg() < 28
}

function gravityYawRate(wx, wy, wz) {
  let ax = lastAccel.x
  let ay = lastAccel.y
  let az = lastAccel.z
  const n = Math.hypot(ax, ay, az)
  if (n >= 0.35) {
    return -(wx * ax + wy * ay + wz * az) / n
  }
  const tilt = Math.min(90, Math.abs(lastBeta) || 50) / 90
  return -(wz * (1 - tilt) + wy * tilt)
}

function onGyro(res) {
  debug.gyro.n += 1
  if (debug.gyro.n <= 3) log('gyro raw', res)
  if (!res) {
    debug.gyro.drop += 1
    debug.gyro.reason = 'empty'
    return
  }
  const wz = Number(res.z) || 0
  const wy = Number(res.y) || 0
  const wx = Number(res.x) || 0
  debug.gyro.last = 'x' + round1(wx) + ' y' + round1(wy) + ' z' + round1(wz)
  const now = Date.now()
  const dt = lastGyroAt ? Math.min(0.08, (now - lastGyroAt) / 1000) : 0
  lastGyroAt = now
  if (!dt) {
    debug.gyro.drop += 1
    debug.gyro.reason = 'no-dt'
    return
  }
  const rateDeg = gravityYawRate(wx, wy, wz) * 180 / Math.PI
  if (lastMotionAt && now - lastMotionAt < 280) {
    debug.gyro.drop += 1
    debug.gyro.reason = 'motion-h'
    return
  }
  if (phoneIsFlat() && lastCompassAt && now - lastCompassAt < 500) {
    debug.gyro.drop += 1
    debug.gyro.reason = 'flat-cmp'
    return
  }
  if (Math.abs(rateDeg) < 1.2) {
    debug.gyro.drop += 1
    debug.gyro.reason = 'rate ' + round1(rateDeg)
    return
  }
  debug.gyro.reason = 'yaw ' + round1(rateDeg)
  const base = fused != null ? fused : (lastCompass != null ? lastCompass : heading || 0)
  fused = normalize(base + rateDeg * dt)
  setFused(fused, 'gyro')
}

function detectPlatform() {
  try {
    const info = wx.getSystemInfoSync() || {}
    platform = info.platform || ''
    sdk = info.SDKVersion || ''
    debug.device = [info.brand, info.model, info.system, 'wx' + (info.version || '')].filter(Boolean).join(' ')
  } catch (error) {
    platform = ''
    sdk = ''
    debug.device = ''
  }
  debug.platform = platform
  debug.sdk = sdk
}

function onAccel(res) {
  debug.accel.n += 1
  if (!res) return
  lastAccel.x = Number(res.x) || 0
  lastAccel.y = Number(res.y) || 0
  lastAccel.z = Number(res.z) || 0
  debug.accel.last = 'x' + round1(res.x) + ' y' + round1(res.y) + ' z' + round1(res.z)
}

function bindListeners() {
  if (listenersBound) return
  listenersBound = true
  log('bind', {
    compass: typeof wx.onCompassChange,
    motion: typeof wx.onDeviceMotionChange,
    gyro: typeof wx.onGyroscopeChange
  })
  if (wx.onCompassChange) wx.onCompassChange(onCompass)
  if (wx.onDeviceMotionChange) wx.onDeviceMotionChange(onMotion)
  if (wx.onGyroscopeChange) wx.onGyroscopeChange(onGyro)
  if (wx.onAccelerometerChange) wx.onAccelerometerChange(onAccel)
}

function failMsg(err) {
  const msg = (err && (err.errMsg || err.message)) || 'fail'
  if (err && err.errno != null) return msg + ' e' + err.errno
  return msg
}

function stopHardware() {
  try { if (wx.stopCompass) wx.stopCompass() } catch (error) { /* ignore */ }
  try { if (wx.stopDeviceMotionListening) wx.stopDeviceMotionListening() } catch (error) { /* ignore */ }
  try { if (wx.stopGyroscope) wx.stopGyroscope() } catch (error) { /* ignore */ }
  try { if (wx.stopAccelerometer) wx.stopAccelerometer() } catch (error) { /* ignore */ }
}

function startOne(name, api, extra, slot) {
  return new Promise(resolve => {
    if (!api) {
      slot.fail = 'no-api'
      log(name + ' no-api')
      resolve(false)
      return
    }
    const opts = Object.assign({}, extra || {}, {
      success() {
        slot.ok = extra && extra.interval ? extra.interval : 'ok'
        slot.fail = ''
        everStartedOk = true
        log(name + ' start ok', slot.ok)
        resolve(true)
      },
      fail(err) {
        slot.fail = failMsg(err)
        log(name + ' start fail', slot.fail)
        resolve(false)
      }
    })
    try {
      api(opts)
    } catch (error) {
      slot.fail = error.message || 'throw'
      resolve(false)
    }
  })
}

function withPrivacy() {
  return new Promise(resolve => {
    if (!wx.requirePrivacyAuthorize) {
      debug.privacy = 'no-api'
      resolve()
      return
    }
    wx.requirePrivacyAuthorize({
      success() {
        debug.privacy = 'ok'
        log('privacy ok')
        resolve()
      },
      fail(err) {
        debug.privacy = failMsg(err)
        log('privacy fail', debug.privacy)
        resolve()
      }
    })
  })
}

let starting = false
let hardwareReady = false
let everStartedOk = false

function startSequential() {
  return startOne('compass', wx.startCompass, {}, debug.compass)
    .then(ok => {
      if (!ok && wx.startCompass) {
        return new Promise(resolve => setTimeout(resolve, 120))
          .then(() => startOne('compass', wx.startCompass, {}, debug.compass))
      }
      return ok
    })
    .then(() => new Promise(resolve => setTimeout(resolve, 160)))
    .then(() => startOne('motion', wx.startDeviceMotionListening, { interval: 'normal' }, debug.motion))
    .then(ok => {
      if (ok) return true
      return startOne('motion', wx.startDeviceMotionListening, {}, debug.motion)
    })
    .then(() => new Promise(resolve => setTimeout(resolve, 160)))
    .then(() => startOne('gyro', wx.startGyroscope, { interval: 'normal' }, debug.gyro))
    .then(ok => {
      if (ok) return true
      return startOne('gyro', wx.startGyroscope, {}, debug.gyro)
    })
    .then(() => new Promise(resolve => setTimeout(resolve, 160)))
    .then(() => startOne('accel', wx.startAccelerometer, { interval: 'normal' }, debug.accel))
    .then(() => {
      hardwareReady = debug.compass.ok || debug.motion.ok || debug.gyro.ok || debug.accel.ok
      starting = false
      log('start done', {
        compass: debug.compass.ok || debug.compass.fail,
        motion: debug.motion.ok || debug.motion.fail,
        gyro: debug.gyro.ok || debug.gyro.fail,
        accel: debug.accel.ok || debug.accel.fail
      })
      return hardwareReady
    })
}

function start(opts) {
  const options = opts || {}
  detectPlatform()
  bindListeners()
  if (!started) {
    started = true
    debug.started = true
    lastGyroAt = 0
    lastCompassAt = 0
    lastCompass = null
    fused = null
    headingOffset = null
    prevMotionH = null
  }
  if (starting) return
  if (hardwareReady && !options.force) return
  starting = true
  debug.mode = options.fromTap ? 'tap' : 'auto'
  log('start', { platform, sdk, mode: debug.mode })
  const run = () => {
    if (everStartedOk) stopHardware()
    setTimeout(() => startSequential(), everStartedOk ? 160 : 0)
  }
  if (options.fromTap) withPrivacy().then(run)
  else run()
}

function startFromTap() {
  hardwareReady = false
  start({ force: true, fromTap: true })
}

function stop() {
  starting = false
  hardwareReady = false
  if (!started) return
  started = false
  debug.started = false
  listenersBound = false
  log('stop')
  if (wx.offCompassChange) wx.offCompassChange(onCompass)
  if (wx.offDeviceMotionChange) wx.offDeviceMotionChange(onMotion)
  if (wx.offGyroscopeChange) wx.offGyroscopeChange(onGyro)
  if (wx.offAccelerometerChange) wx.offAccelerometerChange(onAccel)
  stopHardware()
}

function get() {
  return heading
}

function getSource() {
  return source
}

function seed(deg) {
  if (heading != null && source && source !== 'gps') return
  const value = normalize(deg)
  if (value == null) return
  heading = value
  fused = value
  source = 'gps'
  debug.heading = value
  debug.source = 'gps'
  log('seed', value)
}

function dump() {
  return {
    platform: debug.platform,
    sdk: debug.sdk,
    started: debug.started,
    heading: debug.heading,
    source: debug.source,
    published: debug.published,
    compass: Object.assign({}, debug.compass),
    motion: Object.assign({}, debug.motion),
    gyro: Object.assign({}, debug.gyro),
    accel: Object.assign({}, debug.accel),
    privacy: debug.privacy,
    mode: debug.mode
  }
}

function formatDebug() {
  const c = debug.compass
  const m = debug.motion
  const g = debug.gyro
  const a = debug.accel
  const hd = debug.heading == null ? null : round1(debug.heading)
  const cmp = c.last == null ? null : round1(c.last)
  const delta = hd != null && cmp != null ? round1(shortestDiff(cmp, hd)) : '-'
  const tilt = tiltFromFlatDeg()
  const mode = tilt < 22 ? '平放跟指南针' : '倾斜锁姿态(不跟指南针漂)'
  return [
    'hd ' + (hd == null ? '空' : hd) + ' src=' + (debug.source || '-') + ' α=' + (lastAlpha == null ? '-' : round1(lastAlpha)),
    'cmp=' + (cmp == null ? '-' : cmp) + ' Δhd=' + delta + ' tilt=' + round1(tilt) + ' off=' + (headingOffset == null ? '-' : round1(headingOffset)),
    mode,
    'yaw=' + (g.reason || '-') + ' gyrZ=' + (g.last ? String(g.last).replace(/^.*z/, 'z') : '-') + ' gam=' + round1(lastGamma),
    'mot n=' + m.n + ' ' + (m.last || '-') + ' ' + (m.ok || m.fail || '-'),
    'gyr n=' + g.n + ' drop=' + g.drop + ' ' + (g.last || '-'),
    'acc n=' + a.n + ' ' + (a.last || '-') + ' pub=' + debug.published,
    'privacy=' + (debug.privacy || '-') + ' sdk' + (debug.sdk || '-'),
    debug.device || (debug.platform + '')
  ].join('\n')
}

function calibrate() {
  const value = lastCompass != null ? lastCompass : heading
  if (value == null) return false
  heading = value
  fused = value
  if (prevMotionH != null) headingOffset = shortestDiff(prevMotionH, value)
  source = 'calib'
  debug.heading = value
  debug.source = 'calib'
  debug.published += 1
  listeners.forEach(fn => {
    try { fn(value, 'calib') } catch (error) { /* ignore */ }
  })
  log('calibrate', value)
  return true
}

function onChange(fn) {
  if (typeof fn === 'function' && listeners.indexOf(fn) < 0) listeners.push(fn)
  return () => {
    const index = listeners.indexOf(fn)
    if (index >= 0) listeners.splice(index, 1)
  }
}

module.exports = {
  start,
  startFromTap,
  stop,
  get,
  getSource,
  seed,
  calibrate,
  dump,
  formatDebug,
  onChange
}
