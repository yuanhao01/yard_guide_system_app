/**
 * 下一句导航提示只跟「路上的蓝线」，不跟场区里的 GPS 吸路折线。
 * 定位落在箱区内时，规划会先连到路边，那一下常被误报成左转。
 */

function displayAreaName(name) {
  return String(name || '').replace(/座场区/g, '区').replace(/座/g, '区')
}

function pointInRing(x, y, ring) {
  if (!ring || ring.length < 3) return false
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = Number(ring[i].x)
    const yi = Number(ring[i].y)
    const xj = Number(ring[j].x)
    const yj = Number(ring[j].y)
    const hit = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi)
    if (hit) inside = !inside
  }
  return inside
}

function isInsideBlocks(point, blocks) {
  if (!point || !blocks || !blocks.length) return false
  const x = Number(point.x)
  const y = Number(point.y)
  if (Number.isNaN(x) || Number.isNaN(y)) return false
  for (let i = 0; i < blocks.length; i += 1) {
    if (pointInRing(x, y, blocks[i] && blocks[i].polygon)) return true
  }
  return false
}

function dropInBlockLead(points, blocks) {
  if (!points || points.length < 2 || !blocks || !blocks.length) return points || []
  let start = 0
  while (start < points.length - 1 && isInsideBlocks(points[start], blocks)) start += 1
  if (start >= points.length - 1) return points.slice(-2)
  return points.slice(start)
}

/** 场图坐标 X 东、Y 南，换成东/北后再算叉积。 */
function turnAtYard(prev, pivot, next) {
  const inE = pivot.x - prev.x
  const inN = prev.y - pivot.y
  const outE = next.x - pivot.x
  const outN = pivot.y - next.y
  return signedTurn(inE, inN, outE, outN)
}

/** 世界坐标 X 东、Z 南，换成东/北后再算叉积。 */
function turnAtWorld(prev, pivot, next) {
  const inE = pivot.x - prev.x
  const inN = prev.z - pivot.z
  const outE = next.x - pivot.x
  const outN = pivot.z - next.z
  return signedTurn(inE, inN, outE, outN)
}

function signedTurn(inE, inN, outE, outN) {
  const inLen = Math.hypot(inE, inN)
  const outLen = Math.hypot(outE, outN)
  if (inLen < 0.4 || outLen < 0.4) return { degrees: 0, maneuver: '' }
  const cross = inE * outN - inN * outE
  const dot = inE * outE + inN * outN
  const degrees = Math.atan2(cross, dot) * (180 / Math.PI)
  return {
    degrees,
    maneuver: cross < 0 ? '右转' : '左转'
  }
}

function isFakeSnapTurn(degrees) {
  const abs = Math.abs(degrees)
  return abs < 8 || abs > 150
}

function stripBacktrack(points, turnFn) {
  if (!points || points.length < 3) return points || []
  const out = points.slice()
  while (out.length >= 3) {
    const turn = turnFn(out[0], out[1], out[2])
    if (Math.abs(turn.degrees) > 150) {
      out.shift()
      continue
    }
    break
  }
  return out
}

function formatDriveToTurn(straightM, maneuver) {
  const m = Math.max(1, Math.round(straightM))
  if (m <= 8) return `即将${maneuver}`
  return `直行${m}米后${maneuver}`
}

function formatStraight(remain, targetName) {
  if (remain <= 28) return `即将到达${displayAreaName(targetName || '目的地')}`
  return `沿当前道路直行 · ${Math.max(1, Math.round(remain))}米`
}

function headingEastNorth(east, north) {
  return (Math.atan2(east, north) * 180) / Math.PI
}

function headingYard(from, to) {
  return headingEastNorth(to.x - from.x, from.y - to.y)
}

function yardDistance(from, to) {
  return Math.hypot(to.x - from.x, to.y - from.y)
}

function headingWorld(from, to) {
  return headingEastNorth(to.x - from.x, from.z - to.z)
}

function normalizeDelta(delta) {
  let d = delta
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return d
}

/**
 * 直走能到目的地就不要报左右转；只有前方必须拐弯才报「前方 Xm 左转/右转」。
 * 航向：0 正北、顺时针为正。东行再北上 delta&lt;0 是左转，东行再南下是右转。
 */
function firstRequiredTurn(points, headingFn, distFn) {
  if (!points || points.length < 2) return null
  const startHeading = headingFn(points[0], points[1])
  let accDist = 0
  for (let i = 1; i < points.length; i += 1) {
    accDist += distFn(points[i - 1], points[i])
    if (i >= points.length - 1) break
    const heading = headingFn(points[i], points[i + 1])
    const delta = normalizeDelta(heading - startHeading)
    if (Math.abs(delta) >= 25 && accDist > 2) {
      return {
        distance: accDist,
        maneuver: delta > 0 ? '右转' : '左转'
      }
    }
  }
  return null
}

function projectRoute(self, points) {
  const px = self.x
  const py = self.y
  let best = 0
  let bestRatio = 0
  let bestDist = Infinity
  const segLen = []
  const snaps = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const ax = points[i].x
    const ay = points[i].y
    const bx = points[i + 1].x
    const by = points[i + 1].y
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const len = Math.sqrt(len2)
    segLen[i] = len
    const ratio = len2 < 1e-6 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
    const dist = Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy))
    snaps.push({ i, ratio, dist })
    if (dist < bestDist) {
      bestDist = dist
      best = i
      bestRatio = ratio
    }
  }
  const close = snaps.filter(s => s.dist <= bestDist + 18)
  let pick = close.length ? close.reduce((a, b) => (a.dist <= b.dist ? a : b)) : snaps[0]
  const rests = close.map(s => {
    let rest = (1 - s.ratio) * (segLen[s.i] || 0)
    for (let j = s.i + 1; j < segLen.length; j += 1) rest += segLen[j]
    return rest
  })
  const total = segLen.reduce((s, n) => s + n, 0)
  if (close.length > 1 && total > 350) {
    const minR = Math.min(...rests)
    const maxR = Math.max(...rests)
    if (maxR - minR > 120 && minR < 120) {
      let bestRest = -1
      let bestIdx = pick.i
      let bestRat = pick.ratio
      for (let k = 0; k < close.length; k += 1) {
        if (rests[k] > bestRest + 200) {
          bestRest = rests[k]
          bestIdx = close[k].i
          bestRat = close[k].ratio
        }
      }
      if (bestRest > 0) {
        pick = { i: bestIdx, ratio: bestRat, dist: close.find(s => s.i === bestIdx).dist }
      }
    }
  }
  best = pick.i
  bestRatio = pick.ratio
  let remain = (1 - bestRatio) * (segLen[best] || 0)
  for (let i = best + 1; i < segLen.length; i += 1) remain += segLen[i]
  const clipped = [Object.assign({}, points[best], {
    x: points[best].x + (points[best + 1].x - points[best].x) * bestRatio,
    y: points[best].y + (points[best + 1].y - points[best].y) * bestRatio
  })]
  for (let i = best + 1; i < points.length; i += 1) clipped.push(points[i])
  return { points: clipped, remain }
}

function prepareYardRoute(self, points, blocks) {
  const onRoad = dropInBlockLead(points, blocks)
  const stripped = stripBacktrack(onRoad, turnAtYard)
  if (!self || stripped.length < 2) return { points: stripped, remain: 0 }
  return projectRoute(self, stripped)
}

function remainingAlongRoute(self, points, blocks) {
  if (!self || !points || points.length < 2) return 0
  return prepareYardRoute(self, points, blocks).remain
}

function describeNextInstruction(self, points, targetName, blocks) {
  if (!self || !points || points.length < 2) return ''
  const hit = prepareYardRoute(self, points, blocks)
  if (!hit.points || hit.points.length < 2) return ''
  const gap = points[0] && self.x != null
    ? Math.hypot(self.x - points[0].x, self.y - points[0].y)
    : 0
  if (hit.remain <= 28 && gap <= 20) return formatStraight(hit.remain, targetName)
  if (hit.remain <= 28 && gap > 20) return formatStraight(Math.max(gap + hit.remain, 1), targetName)
  const turn = firstRequiredTurn(hit.points, headingYard, yardDistance)
  if (!turn) return formatStraight(Math.max(hit.remain, gap), targetName)
  return formatDriveToTurn(turn.distance, turn.maneuver)
}

function projectWorldRoute(selfWorld, points) {
  if (!selfWorld || !points || points.length < 2) {
    return { points: points || [], remain: 0 }
  }
  let bestI = 0
  let bestT = 0
  let bestD = Infinity
  const segLen = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len2 = dx * dx + dz * dz
    const len = Math.sqrt(len2)
    segLen[i] = len
    const t = len2 < 1e-6 ? 0 : Math.max(0, Math.min(1, ((selfWorld.x - a.x) * dx + (selfWorld.z - a.z) * dz) / len2))
    const px = a.x + t * dx
    const pz = a.z + t * dz
    const d = Math.hypot(selfWorld.x - px, selfWorld.z - pz)
    if (d < bestD) {
      bestD = d
      bestI = i
      bestT = t
    }
  }
  const a = points[bestI]
  const b = points[bestI + 1]
  const clipped = [{
    x: a.x + (b.x - a.x) * bestT,
    y: a.y,
    z: a.z + (b.z - a.z) * bestT
  }]
  for (let i = bestI + 1; i < points.length; i += 1) clipped.push(points[i])
  let remain = 0
  for (let i = 1; i < clipped.length; i += 1) {
    remain += clipped[i].distanceTo(clipped[i - 1])
  }
  return { points: clipped, remain }
}

/** 沿蓝线找第一个真实拐弯（叉积判定，与路线箭头同几何）。 */
function firstTurnOnWorld(points) {
  if (!points || points.length < 3) return null
  let acc = 0
  for (let i = 1; i < points.length - 1; i += 1) {
    acc += points[i].distanceTo(points[i - 1])
    const turn = turnAtWorld(points[i - 1], points[i], points[i + 1])
    if (isFakeSnapTurn(turn.degrees) || Math.abs(turn.degrees) < 25 || acc <= 2) continue
    return { distance: acc, maneuver: turn.maneuver }
  }
  return null
}

/**
 * 用已画蓝线 + 当前车位算下一句（从投影点往前找第一个弯，避免「全文相对起点」报反左右转）。
 */
function describeWorldInstruction(selfWorld, worldPoints, targetName) {
  if (!worldPoints || worldPoints.length < 2) return ''
  const hit = selfWorld
    ? projectWorldRoute(selfWorld, worldPoints)
    : { points: worldPoints, remain: remainingAlongWorld(worldPoints) }
  if (!hit.points || hit.points.length < 2) return ''
  const gap = selfWorld && worldPoints[0]
    ? Math.hypot(selfWorld.x - worldPoints[0].x, selfWorld.z - worldPoints[0].z)
    : 0
  if (hit.remain <= 28 && gap <= 20) return formatStraight(hit.remain, targetName)
  if (hit.remain <= 28 && gap > 20) {
    return formatStraight(Math.max(gap + hit.remain, 1), targetName)
  }
  const turn = firstTurnOnWorld(hit.points)
  if (!turn) return formatStraight(Math.max(hit.remain, gap), targetName)
  return formatDriveToTurn(turn.distance, turn.maneuver)
}

function remainingAlongWorld(worldPoints) {
  if (!worldPoints || worldPoints.length < 2) return 0
  let remain = 0
  for (let i = 1; i < worldPoints.length; i += 1) remain += worldPoints[i].distanceTo(worldPoints[i - 1])
  return remain
}

module.exports = {
  displayAreaName,
  remainingAlongRoute,
  remainingAlongWorld,
  describeNextInstruction,
  describeWorldInstruction
}
