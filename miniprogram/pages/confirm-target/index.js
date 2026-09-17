/**
 * 作业任务确认：选机械、作业类型、船公司，可选箱号反查贝位，然后开导航。
 * 依赖：request、location（取起点）、auth。
 */
const request = require('../../utils/request')
const locationUtil = require('../../utils/location')
const auth = require('../../utils/auth')

/** 场区名改成「区」 */
function displayAreaText(text) {
  return String(text || '').replace(/座场区/g, '区').replace(/座/g, '区')
}

// 四种作业：提空/提重要箱号，还空/还重可以不填
const DEFAULT_WORK_TYPES = [
  { value: 'pickup_empty', label: '提空', needCntr: true },
  { value: 'pickup_full', label: '提重', needCntr: true },
  { value: 'return_empty', label: '还空', needCntr: false },
  { value: 'return_full', label: '还重', needCntr: false }
]

Page({
  data: {
    target: null, // 目的贝位
    sourceType: 0, // 0 手动选，1 扫码
    starting: false, // 正在开导航
    lookingUp: false, // 正在按箱号反查
    yardName: '', // 当前堆场名
    equipmentOptions: [], // 作业机械名单
    equipmentIndex: 0, // 选中第几台机械
    workTypeOptions: DEFAULT_WORK_TYPES, // 作业类型
    workTypeIndex: 0, // 选中第几种作业
    workTypeLabel: '提空', // 作业中文名
    needCntrNo: true, // 这种作业要不要填箱号
    carrierOptions: [], // 在场船公司
    carrierIndex: 0, // 选中哪家船公司
    cntrNo: '', // 箱号
    cntrSize: '', // 箱型
    cntrHint: '', // 反查成功后的贝位提示
    taskOptionsLoaded: false, // 机械和船公司有没有拉完
    forkliftInfo: null // 这块场区负责的叉车
  },

  /** 从全局取出刚选的贝位；没有就退回去 */
  onLoad() {
    const selection = getApp().globalData.selectedTarget
    if (!selection) {
      wx.showToast({ title: '请先选择目的贝位', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1200)
      return
    }
    const user = auth.getUser() || {}
    // 场区名改成「区」再显示
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
    this.loadTaskOptions() // 拉机械和船公司
    this.loadForkliftInfo(target && target.blockId) // 拉这块场区的叉车
  },

  /** 按场区查负责的叉车，给司机看联系谁 */
  async loadForkliftInfo(blockId) {
    if (!blockId) {
      this.setData({ forkliftInfo: null })
      return
    }
    try {
      const forklifts = await request({ url: `/basics/forklift/by-block/${encodeURIComponent(blockId)}` })
      this.setData({ forkliftInfo: (forklifts && forklifts.length) ? forklifts[0] : null })
    } catch (error) {
      this.setData({ forkliftInfo: null })
    }
  },

  /** 同时拉作业机械和在场船公司 */
  async loadTaskOptions() {
    try {
      const [equipment, carriers, workTypes] = await Promise.all([
        request({ url: '/navigation/mobile/equipment' }),
        request({ url: '/navigation/mobile/carriers' }),
        request({ url: '/navigation/mobile/work-types' }).catch(() => null)
      ])
      const equipmentOptions = (equipment || []).map(item => item.label || item.value).filter(Boolean)
      const carrierOptions = (carriers || []).map(item => item.value || item.label).filter(Boolean)
      const workTypeOptions = (workTypes || [])
        .map(item => ({
          value: item.value,
          label: item.label || item.value,
          needCntr: item.needCntr !== false
        }))
        .filter(item => item.value)
      const patch = {}
      if (equipmentOptions.length) {
        patch.equipmentOptions = equipmentOptions
        patch.equipmentIndex = 0
      }
      if (carrierOptions.length) {
        patch.carrierOptions = carrierOptions
        patch.carrierIndex = 0
      }
      if (workTypeOptions.length) {
        patch.workTypeOptions = workTypeOptions
        patch.workTypeIndex = 0
        patch.workTypeLabel = workTypeOptions[0].label
        patch.needCntrNo = !!workTypeOptions[0].needCntr
      }
      patch.taskOptionsLoaded = true
      this.setData(patch)
    } catch (error) {
      this.setData({ taskOptionsLoaded: true })
      wx.showToast({ title: error.message || '作业选项加载失败', icon: 'none' })
    }
  },

  /** 换了作业机械 */
  onEquipmentChange(event) {
    this.setData({ equipmentIndex: Number(event.detail.value) })
  },

  /** 换了作业类型：提空/提重要箱号，还空/还重可以不填 */
  onWorkTypeChange(event) {
    const workTypeIndex = Number(event.detail.value)
    const work = this.data.workTypeOptions[workTypeIndex]
    this.setData({
      workTypeIndex,
      workTypeLabel: work.label,
      needCntrNo: work.needCntr,
      cntrHint: work.needCntr ? this.data.cntrHint : '', // 不需要箱号就清提示
      cntrSize: work.needCntr ? this.data.cntrSize : ''
    })
  },

  /** 换了船公司 */
  onCarrierChange(event) {
    this.setData({ carrierIndex: Number(event.detail.value) })
  },

  /** 输入箱号，自动转大写 */
  onCntrInput(event) {
    this.setData({ cntrNo: (event.detail.value || '').trim().toUpperCase() })
  },

  /** 按箱号反查贝位，提空时常用 */
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
      const target = result.target || result // 箱子所在贝位
      const patch = {
        cntrHint: `已定位到 ${displayAreaText(target.blockName || '')} · ${target.slot || ''}贝`,
        cntrSize: result.cntrSize || target.cntrSize || ''
      }
      // 后台给了贝位就换成这个目的地
      if (target && target.id) {
        patch.target = {
          ...target,
          targetName: displayAreaText(target.targetName),
          blockName: displayAreaText(target.blockName)
        }
      }
      // 箱子带了船公司，自动选上；名单里没有就补进去
      if (result.carrierCode) {
        const code = String(result.carrierCode).toUpperCase()
        const options = this.data.carrierOptions.slice()
        if (options.indexOf(code) < 0) options.push(code)
        patch.carrierOptions = options
        patch.carrierIndex = options.indexOf(code)
      }
      this.setData(patch)
      if (target && target.blockId) {
        this.loadForkliftInfo(target.blockId)
      }
      wx.showToast({ title: '已反显贝位', icon: 'success' })
    } catch (error) {
      this.setData({ cntrHint: '' })
      wx.showToast({ title: error.message || '未找到该箱', icon: 'none' })
    } finally {
      this.setData({ lookingUp: false })
    }
  },

  /** 取当前位置并开一趟作业导航 */
  async startNavigation() {
    if (!this.data.target || !this.data.target.id) {
      wx.showToast({ title: '请先确认目的贝位', icon: 'none' })
      return
    }
    if (!this.data.equipmentOptions.length) {
      wx.showToast({ title: '当前堆场尚未配置作业机械，请在管理端叉车管理中维护', icon: 'none' })
      return
    }
    if (!this.data.carrierOptions.length) {
      wx.showToast({ title: '当前堆场没有船公司，请在管理端基础资料中维护', icon: 'none' })
      return
    }
    this.setData({ starting: true })
    try {
      const location = await locationUtil.getCurrentLocation() // 规划起点
      const session = await request({
        url: '/navigation/mobile/sessions',
        method: 'POST',
        data: {
          targetId: this.data.target.id, // 目的贝位
          sourceType: this.data.sourceType, // 手动或扫码
          purpose: 'job', // 作业导航
          workType: this.data.workTypeOptions[this.data.workTypeIndex].value,
          workTypeLabel: this.data.workTypeLabel,
          equipmentName: this.data.equipmentOptions[this.data.equipmentIndex],
          carrierCode: this.data.carrierOptions[this.data.carrierIndex],
          cntrNo: this.data.cntrNo || '',
          cntrSize: this.data.cntrSize || '',
          cntrCondition: '好箱',
          longitude: location.longitude,
          latitude: location.latitude,
          direction: locationUtil.headingOf(location)
        }
      })
      getApp().globalData.selectedTarget = null // 用完清掉，避免下次误用
      wx.redirectTo({ url: `/pages/navigation/index?sessionId=${session.id}` })
    } catch (error) {
      // 已有进行中任务：直接接着那一趟走
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
      const needSetting = /定位权限|定位服务|请在设置中允许|auth deny/i.test(message)
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

  /** 回上一页重新选贝位 */
  goBack() {
    wx.navigateBack()
  }
})
