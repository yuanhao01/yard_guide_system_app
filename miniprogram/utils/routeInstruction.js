/**
 * 下一句导航提示只跟「路上的蓝线」，不跟场区里的 GPS 吸路折线。
 * 定位落在箱区内时，规划会先连到路边，那一下常被误报成左转。
 * 导航页和验箱页用这里算出「直行多少米后左转/右转」给司机看、给语音播。
 */

/** 把后台场区名里的「座场区/座」改成司机听得懂的「区」 */
function displayAreaName(name) {
  // 没有名字就当空；有就换成更短的叫法
  return String(name || '').replace(/座场区/g, '区').replace(/座/g, '区')
}

/** 判断一个点是不是落在某块场地的多边形里面（射线法），用来认出「车还在箱区内」 */
function pointInRing(x, y, ring) {
  // 顶点不够 3 个就围不成一块地
  if (!ring || ring.length < 3) return false
  let inside = false // 目前算不算在里面，每穿过一条边就翻转一次
  // 沿着多边形每一条边走一圈
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = Number(ring[i].x) // 当前顶点东向
    const yi = Number(ring[i].y) // 当前顶点南向
    const xj = Number(ring[j].x) // 上一个顶点东向
    const yj = Number(ring[j].y) // 上一个顶点南向
    // 这条边是否从点的上下两侧穿过一条水平射线
    const hit = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi)
    // 穿过一次就翻转里外
    if (hit) inside = !inside
  }
  return inside
}

/** 判断车是不是还停在某块箱区多边形里 */
function isInsideBlocks(point, blocks) {
  // 没点或没箱区数据就当不在里面
  if (!point || !blocks || !blocks.length) return false
  const x = Number(point.x) // 场图东向
  const y = Number(point.y) // 场图南向
  // 坐标坏了就不当在箱区
  if (Number.isNaN(x) || Number.isNaN(y)) return false
  // 任意一块箱区包住这个点就算在里面
  for (let i = 0; i < blocks.length; i += 1) {
    if (pointInRing(x, y, blocks[i] && blocks[i].polygon)) return true
  }
  return false
}

/** 丢掉路线开头还在箱区里的那段「连到路边」的折线，避免刚起步就误报左转 */
function dropInBlockLead(points, blocks) {
  // 点不够或没有箱区，原样返回
  if (!points || points.length < 2 || !blocks || !blocks.length) return points || []
  let start = 0 // 从第几个点开始才算出了箱区
  // 一直跳过还在箱区里的点
  while (start < points.length - 1 && isInsideBlocks(points[start], blocks)) start += 1
  // 整条线都在箱区里，至少留最后两个点还能画线
  if (start >= points.length - 1) return points.slice(-2)
  // 从出箱区的点开始留给后面算转弯
  return points.slice(start)
}

/** 场图坐标 X 东、Y 南，换成东/北后再算叉积。 */
function turnAtYard(prev, pivot, next) {
  const inE = pivot.x - prev.x // 驶入这一弯的东向分量
  const inN = prev.y - pivot.y // 驶入这一弯的北向分量（Y 南增所以取反）
  const outE = next.x - pivot.x // 驶出这一弯的东向分量
  const outN = pivot.y - next.y // 驶出这一弯的北向分量
  return signedTurn(inE, inN, outE, outN)
}

/** 世界坐标 X 东、Z 南，换成东/北后再算叉积。 */
function turnAtWorld(prev, pivot, next) {
  const inE = pivot.x - prev.x // 三维场景里驶入的东向
  const inN = prev.z - pivot.z // 三维场景 Z 南增，取反得到北向
  const outE = next.x - pivot.x // 驶出的东向
  const outN = pivot.z - next.z // 驶出的北向
  return signedTurn(inE, inN, outE, outN)
}

/** 用叉积判断这一弯是左转还是右转，以及转了多少度 */
function signedTurn(inE, inN, outE, outN) {
  const inLen = Math.hypot(inE, inN) // 驶入这段有多长
  const outLen = Math.hypot(outE, outN) // 驶出这段有多长
  // 太短的折线尖角不可信，当直行
  if (inLen < 0.4 || outLen < 0.4) return { degrees: 0, maneuver: '' }
  const cross = inE * outN - inN * outE // 叉积：负是右转，正是左转
  const dot = inE * outE + inN * outN // 点积：用来算转角大小
  const degrees = Math.atan2(cross, dot) * (180 / Math.PI) // 转了多少度
  return {
    degrees, // 带正负的转角
    maneuver: cross < 0 ? '右转' : '左转' // 给司机看的方向
  }
}

/** 吸路造成的假弯：几乎直走或接近掉头，都不该报给司机 */
function isFakeSnapTurn(degrees) {
  const abs = Math.abs(degrees) // 转角绝对值
  return abs < 8 || abs > 150
}

/** 去掉路线开头那种「先折回去再走」的回头点，避免第一句就报掉头 */
function stripBacktrack(points, turnFn) {
  // 点不够 3 个形不成弯
  if (!points || points.length < 3) return points || []
  const out = points.slice() // 复制一份再改，不伤原来的线
  // 开头如果是接近掉头的假弯，就丢掉第一个点
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

/** 把「还有多少米到弯」说成司机听得懂的一句 */
function formatDriveToTurn(straightM, maneuver) {
  const m = Math.max(1, Math.round(straightM)) // 至少报 1 米，避免说 0 米
  // 已经很近了就说即将转
  if (m <= 8) return `即将${maneuver}`
  // 还远就说直行多少米后再转
  return `直行${m}米后${maneuver}`
}

/** 前方不用转弯时，报直行剩余或即将到达 */
function formatStraight(remain, targetName) {
  // 剩不到 28 米就当快到了
  if (remain <= 28) return `即将到达${displayAreaName(targetName || '目的地')}`
  // 还远就报沿路直行和剩余米数
  return `沿当前道路直行 · ${Math.max(1, Math.round(remain))}米`
}

/** 把东/北两个分量换成罗盘角度：0 正北、顺时针为正 */
function headingEastNorth(east, north) {
  return (Math.atan2(east, north) * 180) / Math.PI
}

/** 场图上从一点到下一点的朝向 */
function headingYard(from, to) {
  return headingEastNorth(to.x - from.x, from.y - to.y)
}

/** 场图上两点之间的直线距离（米） */
function yardDistance(from, to) {
  return Math.hypot(to.x - from.x, to.y - from.y)
}

/** 三维场景里从一点到下一点的朝向 */
function headingWorld(from, to) {
  return headingEastNorth(to.x - from.x, from.z - to.z)
}

/** 把角度差收进 -180～180，方便判断左转还是右转 */
function normalizeDelta(delta) {
  let d = delta
  // 大于 180 就往回减一圈
  while (d > 180) d -= 360
  // 小于 -180 就往前加一圈
  while (d < -180) d += 360
  return d
}

/**
 * 直走能到目的地就不要报左右转；只有前方必须拐弯才报「前方 Xm 左转/右转」。
 * 航向：0 正北、顺时针为正。东行再北上 delta&lt;0 是左转，东行再南下是右转。
 */
function firstRequiredTurn(points, headingFn, distFn) {
  // 点不够就没有弯
  if (!points || points.length < 2) return null
  // 出发时这一段的朝向，后面和它比才知道要不要转
  const startHeading = headingFn(points[0], points[1])
  let accDist = 0 // 从现在走到这个弯已经累计多少米
  for (let i = 1; i < points.length; i += 1) {
    accDist += distFn(points[i - 1], points[i]) // 加上这一段长度
    // 已经到最后一个点，没有下一弯了
    if (i >= points.length - 1) break
    const heading = headingFn(points[i], points[i + 1]) // 下一段朝向
    const delta = normalizeDelta(heading - startHeading) // 相对出发朝向转了多少
    // 转过 25 度且已经走过 2 米，才算真要转弯
    if (Math.abs(delta) >= 25 && accDist > 2) {
      return {
        distance: accDist, // 还有多少米到这个弯
        maneuver: delta > 0 ? '右转' : '左转'
      }
    }
  }
  return null
}

/** 把车投影到场图蓝线上，裁掉已经走过的部分，并算出还剩多少米 */
function projectRoute(self, points) {
  const px = self.x // 车当前东向
  const py = self.y // 车当前南向
  let best = 0 // 离车最近的那段折线下标
  let bestRatio = 0 // 车落在这段上的比例（0 起点、1 终点）
  let bestDist = Infinity // 到这段的最短距离
  const segLen = [] // 每一段有多长
  const snaps = [] // 每一段上的投影结果
  // 逐段找离车最近的落点
  for (let i = 0; i < points.length - 1; i += 1) {
    const ax = points[i].x // 这段起点东向
    const ay = points[i].y // 这段起点南向
    const bx = points[i + 1].x // 这段终点东向
    const by = points[i + 1].y // 这段终点南向
    const dx = bx - ax // 这段东向长度
    const dy = by - ay // 这段南向长度
    const len2 = dx * dx + dy * dy // 长度的平方，后面除法用
    const len = Math.sqrt(len2) // 这段实际米数
    segLen[i] = len
    // 车在这段上的投影比例，限制在 0～1，避免投到线段外面
    const ratio = len2 < 1e-6 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
    const dist = Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy)) // 车到投影点的距离
    snaps.push({ i, ratio, dist })
    // 记下更近的一段
    if (dist < bestDist) {
      bestDist = dist
      best = i
      bestRatio = ratio
    }
  }
  // 和最近点差不多远的几段都留下，后面用来分辨「抄近路误投到终点附近」
  const close = snaps.filter(s => s.dist <= bestDist + 18)
  let pick = close.length ? close.reduce((a, b) => (a.dist <= b.dist ? a : b)) : snaps[0]
  // 这几段各自走到终点还剩多少米
  const rests = close.map(s => {
    let rest = (1 - s.ratio) * (segLen[s.i] || 0)
    for (let j = s.i + 1; j < segLen.length; j += 1) rest += segLen[j]
    return rest
  })
  const total = segLen.reduce((s, n) => s + n, 0) // 整条线总长
  // 路线很长、近处有两段、剩余差距又大：优先选「还很远」的那段，避免刚出发就被投到终点
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
  // 从投影点算到终点还剩多少米
  let remain = (1 - bestRatio) * (segLen[best] || 0)
  for (let i = best + 1; i < segLen.length; i += 1) remain += segLen[i]
  // 新折线从投影点开始，后面的点原样接上
  const clipped = [Object.assign({}, points[best], {
    x: points[best].x + (points[best + 1].x - points[best].x) * bestRatio,
    y: points[best].y + (points[best + 1].y - points[best].y) * bestRatio
  })]
  for (let i = best + 1; i < points.length; i += 1) clipped.push(points[i])
  return { points: clipped, remain }
}

/** 场图路线：先去掉箱区内引线、再去掉回头点，再按车位裁掉已走路段 */
function prepareYardRoute(self, points, blocks) {
  const onRoad = dropInBlockLead(points, blocks) // 丢掉箱区内那段
  const stripped = stripBacktrack(onRoad, turnAtYard) // 丢掉开头回头点
  // 没有车位或线太短，只返回处理后的点
  if (!self || stripped.length < 2) return { points: stripped, remain: 0 }
  return projectRoute(self, stripped)
}

/** 沿场图蓝线还剩多少米，给导航页剩余距离用 */
function remainingAlongRoute(self, points, blocks) {
  if (!self || !points || points.length < 2) return 0
  return prepareYardRoute(self, points, blocks).remain
}

/** 根据场图蓝线和当前车位，拼出下一句给司机看的提示 */
function describeNextInstruction(self, points, targetName, blocks) {
  if (!self || !points || points.length < 2) return ''
  const hit = prepareYardRoute(self, points, blocks) // 从车位往前看的剩余线
  if (!hit.points || hit.points.length < 2) return ''
  // 车离规划起点还有多远，用来判断是不是还在另一条路上
  const gap = points[0] && self.x != null
    ? Math.hypot(self.x - points[0].x, self.y - points[0].y)
    : 0
  // 剩余很短且已经贴着线，报即将到达
  if (hit.remain <= 28 && gap <= 20) return formatStraight(hit.remain, targetName)
  // 剩余很短但车还离线很远，把这段空档也算进剩余，避免刚出发就报到达
  if (hit.remain <= 28 && gap > 20) return formatStraight(Math.max(gap + hit.remain, 1), targetName)
  const turn = firstRequiredTurn(hit.points, headingYard, yardDistance) // 前方第一个真弯
  if (!turn) return formatStraight(Math.max(hit.remain, gap), targetName)
  return formatDriveToTurn(turn.distance, turn.maneuver)
}

/** 把车投影到三维场景已画好的蓝线上，裁掉走过的部分 */
function projectWorldRoute(selfWorld, points) {
  if (!selfWorld || !points || points.length < 2) {
    return { points: points || [], remain: 0 }
  }
  let bestI = 0 // 最近那段的下标
  let bestT = 0 // 落在这段上的比例
  let bestD = Infinity // 到这段的最短距离
  const segLen = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i] // 这段起点
    const b = points[i + 1] // 这段终点
    const dx = b.x - a.x // 东向
    const dz = b.z - a.z // 南向（三维用 z）
    const len2 = dx * dx + dz * dz
    const len = Math.sqrt(len2)
    segLen[i] = len
    // 车在这段上的投影比例
    const t = len2 < 1e-6 ? 0 : Math.max(0, Math.min(1, ((selfWorld.x - a.x) * dx + (selfWorld.z - a.z) * dz) / len2))
    const px = a.x + t * dx // 投影点东向
    const pz = a.z + t * dz // 投影点南向
    const d = Math.hypot(selfWorld.x - px, selfWorld.z - pz) // 车到投影点
    if (d < bestD) {
      bestD = d
      bestI = i
      bestT = t
    }
  }
  const a = points[bestI]
  const b = points[bestI + 1]
  // 从投影点开始接后面的蓝线
  const clipped = [{
    x: a.x + (b.x - a.x) * bestT,
    y: a.y,
    z: a.z + (b.z - a.z) * bestT
  }]
  for (let i = bestI + 1; i < points.length; i += 1) clipped.push(points[i])
  let remain = 0 // 投影点之后还剩多少米
  for (let i = 1; i < clipped.length; i += 1) {
    remain += clipped[i].distanceTo(clipped[i - 1])
  }
  return { points: clipped, remain }
}

/** 沿蓝线找第一个真实拐弯（叉积判定，与路线箭头同几何）。 */
function firstTurnOnWorld(points) {
  if (!points || points.length < 3) return null
  let acc = 0 // 走到这个弯累计多少米
  for (let i = 1; i < points.length - 1; i += 1) {
    acc += points[i].distanceTo(points[i - 1])
    const turn = turnAtWorld(points[i - 1], points[i], points[i + 1])
    // 假弯、转角太小、刚起步 2 米内，都跳过
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
  // 有车位就投影裁线，没有就按整条蓝线算
  const hit = selfWorld
    ? projectWorldRoute(selfWorld, worldPoints)
    : { points: worldPoints, remain: remainingAlongWorld(worldPoints) }
  if (!hit.points || hit.points.length < 2) return ''
  // 车离蓝线起点还有多远
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

/** 三维蓝线从头到尾有多长，没有车位时用来估剩余 */
function remainingAlongWorld(worldPoints) {
  if (!worldPoints || worldPoints.length < 2) return 0
  let remain = 0
  for (let i = 1; i < worldPoints.length; i += 1) remain += worldPoints[i].distanceTo(worldPoints[i - 1])
  return remain
}

// 导航页、验箱页拼提示和剩余距离时用
module.exports = {
  displayAreaName, // 场区名改成「区」
  remainingAlongRoute, // 场图蓝线剩余米数
  remainingAlongWorld, // 三维蓝线剩余米数
  describeNextInstruction, // 按场图算下一句
  describeWorldInstruction // 按已画蓝线算下一句
}
