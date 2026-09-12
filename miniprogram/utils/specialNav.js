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

function pickTarget(list, pattern) {
  const items = list || []
  return items.find(item => pattern.test(`${item.targetName || ''}${item.targetCode || ''}`)) || items[0]
}

async function startSpecialNav(options) {
  const purpose = options.purpose
  const keyword = purpose === 'safety' ? '安全操作区' : '出场'
  const pattern = purpose === 'safety'
    ? /安全操作区|验箱|SAFETY|S-02/i
    : /出场|出口|门岗|EXIT|GATE/i
  const results = await request({
    url: '/navigation/mobile/targets?keyword=' + encodeURIComponent(keyword)
  })
  const target = pickTarget(results, pattern)
  if (!target) {
    throw new Error(purpose === 'safety' ? '尚未配置安全操作区' : '尚未配置出场口')
  }
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
