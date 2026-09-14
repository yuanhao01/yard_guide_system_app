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

async function startSpecialNav(options) {
  const purpose = options.purpose
  const keywords = purpose === 'safety' ? ['验箱', '安全操作'] : ['出场']
  const pattern = purpose === 'safety'
    ? /验箱|安全操作|SAFETY|^S\d+/i
    : /出场|出口|门岗|EXIT|GATE/i
  let target
  for (const keyword of keywords) {
    const results = await request({
      url: '/navigation/mobile/targets?keyword=' + encodeURIComponent(keyword)
    })
    target = (results || []).find(item => pattern.test(`${item.targetName || ''}${item.targetCode || ''}`))
    if (target) break
  }
  if (!target) {
    throw new Error(purpose === 'safety' ? '尚未配置验箱区' : '尚未配置出场口')
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
