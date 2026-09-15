const request = require('../../utils/request')
const locationUtil = require('../../utils/location')
const auth = require('../../utils/auth')

function displayAreaText(text) {
  return String(text || '').replace(/座场区/g, '区').replace(/座/g, '区')
}

const DEFAULT_WORK_TYPES = [
  { value: 'pickup_empty', label: '提空', needCntr: true },
  { value: 'pickup_full', label: '提重', needCntr: true },
  { value: 'return_empty', label: '还空', needCntr: false },
  { value: 'return_full', label: '还重', needCntr: false }
]

Page({
  data: {
    target: null,
    sourceType: 0,
    starting: false,
    lookingUp: false,
    yardName: '',
    equipmentOptions: [],
    equipmentIndex: 0,
    workTypeOptions: DEFAULT_WORK_TYPES,
    workTypeIndex: 0,
    workTypeLabel: '提空',
    needCntrNo: true,
    carrierOptions: [],
    carrierIndex: 0,
    cntrNo: '',
    cntrSize: '',
    cntrHint: '',
    taskOptionsLoaded: false
  },

  onLoad() {
    const selection = getApp().globalData.selectedTarget
    if (!selection) {
      wx.showToast({ title: '请先选择目的贝位', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1200)
      return
    }
    const user = auth.getUser() || {}
    const target = selection.target ? {
      ...selection.target,
      targetName: displayAreaText(selection.target.targetName),
      blockName: displayAreaText(selection.target.blockName)
    } : selection.target
    this.setData({
      ...selection,
      target,
      yardName: user.currentCyName || user.yardName || '',
      workTypeLabel: DEFAULT_WORK_TYPES[0].label,
      needCntrNo: DEFAULT_WORK_TYPES[0].needCntr
    })
    this.loadTaskOptions()
  },

  async loadTaskOptions() {
    try {
      const [equipment, carriers, workTypes] = await Promise.all([
        request({ url: '/navigation/mobile/equipment' }),
        request({ url: '/navigation/mobile/carriers' }),
        request({ url: '/navigation/mobile/work-types' })
      ])
      const equipmentOptions = (equipment || []).map(item => item.label || item.value).filter(Boolean)
      const carrierOptions = (carriers || []).map(item => item.value || item.label).filter(Boolean)
      const workTypeOptions = (workTypes && workTypes.length ? workTypes : DEFAULT_WORK_TYPES).map(item => ({
        value: item.value,
        label: item.label,
        needCntr: item.needCntr !== false && item.needCntr !== 'false' && (
          item.needCntr === true || item.needCntr === 'true' || String(item.value || '').startsWith('pickup_')
        )
      }))
      const patch = { workTypeOptions, workTypeIndex: 0 }
      patch.workTypeLabel = workTypeOptions[0].label
      patch.needCntrNo = workTypeOptions[0].needCntr
      if (equipmentOptions.length) {
        patch.equipmentOptions = equipmentOptions
        patch.equipmentIndex = 0
      }
      if (carrierOptions.length) {
        patch.carrierOptions = carrierOptions
        patch.carrierIndex = 0
      }
      patch.taskOptionsLoaded = true
      this.setData(patch)
    } catch (error) {
      this.setData({ taskOptionsLoaded: true })
      wx.showToast({ title: error.message || '作业选项加载失败', icon: 'none' })
    }
  },

  onEquipmentChange(event) {
    this.setData({ equipmentIndex: Number(event.detail.value) })
  },

  onWorkTypeChange(event) {
    const workTypeIndex = Number(event.detail.value)
    const work = this.data.workTypeOptions[workTypeIndex]
    this.setData({
      workTypeIndex,
      workTypeLabel: work.label,
      needCntrNo: work.needCntr,
      cntrHint: work.needCntr ? this.data.cntrHint : '',
      cntrSize: work.needCntr ? this.data.cntrSize : ''
    })
  },

  onCarrierChange(event) {
    this.setData({ carrierIndex: Number(event.detail.value) })
  },

  onCntrInput(event) {
    this.setData({ cntrNo: (event.detail.value || '').trim().toUpperCase() })
  },

  async lookupCntr() {
    if (this.data.lookingUp) return
    const cntrNo = this.data.cntrNo
    if (!cntrNo || cntrNo.length < 4) {
      wx.showToast({ title: '请输入完整箱号', icon: 'none' })
      return
    }
    this.setData({ lookingUp: true })
    try {
      const result = await request({
        url: `/navigation/mobile/containers/${encodeURIComponent(cntrNo)}`
      })
      const target = result.target || result
      const patch = {
        cntrHint: `已定位到 ${displayAreaText(target.blockName || '')} · ${target.slot || ''}贝`,
        cntrSize: result.cntrSize || target.cntrSize || ''
      }
      if (target && target.id) {
        patch.target = {
          ...target,
          targetName: displayAreaText(target.targetName),
          blockName: displayAreaText(target.blockName)
        }
      }
      if (result.carrierCode) {
        const code = String(result.carrierCode).toUpperCase()
        const options = this.data.carrierOptions.slice()
        if (options.indexOf(code) < 0) options.push(code)
        patch.carrierOptions = options
        patch.carrierIndex = options.indexOf(code)
      }
      this.setData(patch)
      wx.showToast({ title: '已反显贝位', icon: 'success' })
    } catch (error) {
      this.setData({ cntrHint: '' })
      wx.showToast({ title: error.message || '未找到该箱', icon: 'none' })
    } finally {
      this.setData({ lookingUp: false })
    }
  },

  async startNavigation() {
    if (!this.data.target || !this.data.target.id) {
      wx.showToast({ title: '请先确认目的贝位', icon: 'none' })
      return
    }
    if (!this.data.equipmentOptions.length) {
      wx.showToast({ title: '当前堆场尚未配置作业机械', icon: 'none' })
      return
    }
    if (!this.data.carrierOptions.length) {
      wx.showToast({ title: '当前堆场没有在场船公司数据', icon: 'none' })
      return
    }
    this.setData({ starting: true })
    try {
      const location = await locationUtil.getCurrentLocation()
      const session = await request({
        url: '/navigation/mobile/sessions',
        method: 'POST',
        data: {
          targetId: this.data.target.id,
          sourceType: this.data.sourceType,
          purpose: 'job',
          workType: this.data.workTypeOptions[this.data.workTypeIndex].value,
          workTypeLabel: this.data.workTypeLabel,
          equipmentName: this.data.equipmentOptions[this.data.equipmentIndex],
          carrierCode: this.data.carrierOptions[this.data.carrierIndex],
          cntrNo: this.data.cntrNo || '',
          cntrSize: this.data.cntrSize || '',
          cntrCondition: '好箱',
          longitude: location.longitude,
          latitude: location.latitude
        }
      })
      getApp().globalData.selectedTarget = null
      wx.redirectTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
    } catch (error) {
      if (/未完成|进行中/.test(error.message || '')) {
        try {
          const current = await request({ url: '/navigation/mobile/sessions/current' })
          if (current && current.id) {
            wx.redirectTo({ url: `/pages/navigation/index?sessionId=${current.id}` })
            return
          }
        } catch (ignore) {
          // 回落到下方提示
        }
        wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
        return
      }
      const message = error.message || '无法开始导航'
      const needSetting = /位置|定位|权限|auth deny/i.test(message)
      wx.showModal({
        title: '无法开始导航',
        content: message,
        confirmText: needSetting ? '打开设置' : '知道了',
        showCancel: needSetting,
        success: result => {
          if (needSetting && result.confirm) {
            wx.openSetting()
          }
        }
      })
    } finally {
      this.setData({ starting: false })
    }
  },

  goBack() {
    wx.navigateBack()
  }
})
