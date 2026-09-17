/**
 * 手动选贝位：堆场 → 场区 → 贝位，确认后去任务确认页。
 * 依赖：request、auth（换堆场时改当前堆场）。
 */
const request = require('../../utils/request')
const auth = require('../../utils/auth')

/** 把「座场区/座」改成司机好认的「区」 */
function displayAreaText(text) {
  return String(text || '').replace(/座场区/g, '区').replace(/座/g, '区')
}

Page({
  data: {
    yards: [], // 堆场下拉
    blocks: [], // 场区下拉
    bays: [], // 贝位下拉
    yardIndex: -1, // 选中第几个堆场
    blockIndex: -1, // 选中第几个场区
    bayIndex: -1, // 选中第几个贝位
    loading: false, // 点确认时转圈
    loadingYard: false, // 正在拉场区
    loadingBlock: false, // 预留：拉场区中间态
    loadingBays: false, // 正在拉贝位
    lockYard: false, // 车牌进场后堆场不能改
    lockedYardName: '' // 锁定时显示的堆场名
  },

  /** 进页先拉堆场；只有一个或车牌进场就直接锁定 */
  async onLoad() {
    const user = auth.getUser() || {}
    try {
      const yards = await request({ url: '/navigation/mobile/yards' })
      const lockYard = Boolean(user.plateLogin) || user.userKind === 'driver' || yards.length === 1
      const currentId = user.currentCyId
      let yardIndex = yards.findIndex(item => String(item.value) === String(currentId))
      if (yardIndex < 0 && yards.length === 1) {
        yardIndex = 0
      }
      const locked = yards[yardIndex]
      this.setData({
        yards,
        lockYard,
        lockedYardName: (locked && locked.label) || user.yardName || ''
      })
      if (yardIndex >= 0) {
        await this.selectYard(yardIndex)
      }
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  /** 司机换了堆场 */
  onYardChange(event) {
    this.selectYard(Number(event.detail.value))
  },

  /** 选中某个堆场后拉场区；车牌进场不允许换堆场 */
  async selectYard(yardIndex) {
    const user = auth.getUser() || {}
    const yard = this.data.yards[yardIndex]
    if ((user.plateLogin || user.userKind === 'driver') && yard && String(user.currentCyId || '') !== String(yard.value)) {
      wx.showToast({ title: '进场堆场不能更换', icon: 'none' })
      return
    }
    this.setData({
      yardIndex,
      blockIndex: -1, // 换堆场后场区、贝位作废
      bayIndex: -1,
      blocks: [],
      bays: [],
      loadingYard: true
    })
    try {
      const blocks = (await request({ url: `/navigation/mobile/yards/${yard.value}/blocks` }) || []).map(item => ({
        ...item,
        label: displayAreaText(item.label)
      }))
      this.setData({ blocks })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
    } finally {
      this.setData({ loadingYard: false })
    }
  },

  /** 选中场区后拉贝位 */
  async onBlockChange(event) {
    const blockIndex = Number(event.detail.value)
    this.setData({ blockIndex, bayIndex: -1, bays: [], loadingBays: true })
    try {
      const block = this.data.blocks[blockIndex]
      const bays = await request({ url: `/navigation/mobile/blocks/${block.value}/bays` })
      this.setData({ bays })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
    } finally {
      this.setData({ loadingBays: false })
    }
  },

  /** 选中贝位 */
  onBayChange(event) {
    this.setData({ bayIndex: Number(event.detail.value) })
  },

  /** 用选中的场区+贝位去后台找导航入口，找到就去确认任务 */
  async confirmSelection() {
    const block = this.data.blocks[this.data.blockIndex]
    const bay = this.data.bays[this.data.bayIndex]
    this.setData({ loading: true })
    try {
      const targets = await request({
        url: `/navigation/mobile/targets?blockId=${encodeURIComponent(block.value)}&keyword=${encodeURIComponent(bay.value)}`
      })
      // 必须对上这个贝号，不能随便拿一个近似的
      const exactTarget = targets.find(item => String(item.slot) === String(bay.value))
      if (!exactTarget) {
        throw new Error('该贝位尚未配置导航入口，请联系管理员')
      }
      getApp().globalData.selectedTarget = { target: exactTarget, sourceType: 0 } // 0 手动选
      wx.navigateTo({ url: '/pages/confirm-target/index' })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none', duration: 2500 })
    } finally {
      this.setData({ loading: false })
    }
  }
})
