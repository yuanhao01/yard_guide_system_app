/**
 * 特殊导航：作业完成后去验箱区，或验箱后再去出场口。
 * 依赖：request（问后台要目的地并开新会话）、location（取当前位置）。
 */
const request = require('./request')
const locationUtil = require('./location')

/** 把当前作业任务上的箱号、机械、作业类型抄到新会话上，验箱/出场页才能继续显示 */
function copyTaskFields(session) {
  // 没有会话就抄不出东西
  if (!session) return {}
  // 把作业相关字段原样带过去
  return {
    workType: session.workType, // 作业类型代码，如提空/还重
    workTypeLabel: session.workTypeLabel, // 作业类型中文名
    equipmentName: session.equipmentName, // 负责这票活的堆高机
    carrierCode: session.carrierCode, // 船公司
    cntrNo: session.cntrNo, // 箱号
    cntrSize: session.cntrSize, // 箱型尺寸
    cntrCondition: session.cntrCondition // 箱况，如好箱
  }
}

/** 向后台要这个堆场已配置好的验箱区或出场口，没有配置就直接报错给司机看 */
async function resolveConfiguredTarget(purpose, task) {
  // 从任务上取出堆场编号
  const yardId = task && task.cyId
  // 不知道是哪个堆场就无法问配置
  if (!yardId) {
    // 按用途给出不同提示
    throw new Error(purpose === 'safety' ? '尚未配置验箱区' : '尚未配置出场口')
  }
  // 验箱走验箱接口，出场走出场口接口
  const path = purpose === 'safety' ? 'safety-target' : 'exit-target'
  // 向后台查配置好的目的地
  const target = await request({
    url: `/navigation/mobile/${path}?yardId=${yardId}`
  })
  // 后台没配这个点
  if (!target || !target.id) {
    throw new Error(purpose === 'safety' ? '尚未配置验箱区' : '尚未配置出场口')
  }
  // 返回验箱区或出场口
  return target
}

/** 用当前位置开一趟去验箱区或出场口的导航，成功后返回新会话 */
async function startSpecialNav(options) {
  // 这一趟是去验箱还是去出场
  const purpose = options.purpose
  // 先问清目的地
  const target = await resolveConfiguredTarget(purpose, options.task || options)
  // 取手机当前经纬度，作为规划起点
  const location = await locationUtil.getCurrentLocation()
  // 让后台开一个新导航会话并算出路线
  const session = await request({
    url: '/navigation/mobile/sessions',
    method: 'POST',
    data: {
      targetId: target.id, // 验箱区或出场口的编号
      sourceType: 0, // 0 表示按配置点开导航，不是扫码
      purpose, // safety 验箱 / exit 出场
      parentSessionId: options.parentSessionId, // 挂在原来的作业会话下，协同群才能对上
      longitude: location.longitude, // 当前经度
      latitude: location.latitude, // 当前纬度
      direction: locationUtil.headingOf(location, options.heading), // 车头朝向，双向路靠哪侧用它
      ...copyTaskFields(options.task) // 带上箱号、机械等作业信息
    }
  })
  // 把新开的这一趟交给页面去跳导航
  return session
}

/** 协同群要挂在作业会话上：验箱/出场会话本身不是作业，要回查父会话编号 */
function collabSessionId(session) {
  // 没有会话就没有群
  if (!session) return ''
  // 作业会话直接用自己的编号
  if (!session.purpose || session.purpose === 'job') return session.id
  // 验箱/出场用父会话编号，没有父会话再退回自己
  return session.parentSessionId || session.id
}

// 给到位确认、验箱页、首页出场按钮用
module.exports = {
  copyTaskFields, // 抄作业字段
  startSpecialNav, // 开验箱或出场导航
  collabSessionId // 算出协同群该挂哪一趟
}
