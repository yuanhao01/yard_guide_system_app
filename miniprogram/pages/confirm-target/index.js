/**
 * 作业任务确认：选作业类型，可选箱号反查贝位，然后开导航。
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
    workTypeOptions: DEFAULT_WORK_TYPES, // 作业类型
    workTypeIndex: 0, // 选中第几种作业
    workTypeLabel: '提空', // 作业中文名
    needCntrNo: true, // 这种作业要不要填箱号
    carrierCode: '', // 箱号反查带回的船公司，不让司机选，只随任务上报
    cntrNo: '', // 箱号
    cntrSize: '', // 箱型
    cntrHint: '', // 反查成功后的贝位提示
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
    this.loadTaskOptions() // 拉作业类型
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

  /** 拉后台配置的作业类型；拉不到就用默认四种 */
  async loadTaskOptions() {
    try {
      const workTypes = await request({ url: '/navigation/mobile/work-types' })
      const workTypeOptions = (workTypes || [])
        .map(item => ({
          value: item.value,
          label: item.label || item.value,
          needCntr: item.needCntr !== false
        }))
        .filter(item => item.value)
      if (workTypeOptions.length) {
        this.setData({
          workTypeOptions,
          workTypeIndex: 0,
          workTypeLabel: workTypeOptions[0].label,
          needCntrNo: !!workTypeOptions[0].needCntr
        })
      }
    } catch (error) {
      // 拉不到就沿用默认四种作业类型
    }
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
      // 箱子带了船公司就记下，开导航时随任务上报
      patch.carrierCode = result.carrierCode ? String(result.carrierCode).toUpperCase() : ''
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
          carrierCode: this.data.carrierCode || '',
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
