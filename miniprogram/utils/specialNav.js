const request = require('./request')
const locationUtil = require('./location')

function copyTaskFields(session) {
  if (!session) return {}
  return {
    workType: session.workType,
    workTypeLabel: session.workTypeLabel,
    equipmentName: session.equipmentName,
    carrierCode: session.carrierCode,
    cntrNo: session.cntrNo,
    cntrSize: session.cntrSize,
    cntrCondition: session.cntrCondition
  }
}

async function resolveConfiguredTarget(purpose, task) {
  const yardId = task && task.cyId
  if (!yardId) {
    throw new Error(purpose === 'safety' ? '尚未配置验箱区' : '尚未配置出场口')
  }
  const path = purpose === 'safety' ? 'safety-target' : 'exit-target'
  const target = await request({
    url: `/navigation/mobile/${path}?yardId=${yardId}`
  })
  if (!target || !target.id) {
    throw new Error(purpose === 'safety' ? '尚未配置验箱区' : '尚未配置出场口')
  }
  return target
}

async function startSpecialNav(options) {
  const purpose = options.purpose
  const target = await resolveConfiguredTarget(purpose, options.task || options)
  const location = await locationUtil.getCurrentLocation()
  const session = await request({
    url: '/navigation/mobile/sessions',
    method: 'POST',
    data: {
      targetId: target.id,
      sourceType: 0,
      purpose,
      parentSessionId: options.parentSessionId,
      longitude: location.longitude,
      latitude: location.latitude,
      direction: locationUtil.headingOf(location, options.heading),
      ...copyTaskFields(options.task)
    }
  })
  return session
}

function collabSessionId(session) {
  if (!session) return ''
  if (!session.purpose || session.purpose === 'job') return session.id
  return session.parentSessionId || session.id
}

module.exports = {
  copyTaskFields,
  startSpecialNav,
  collabSessionId
}
