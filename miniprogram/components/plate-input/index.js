/**
 * 车牌引导式输入：第 1 位选省份简称，第 2 位选字母，后面字母数字混合；勾「新能源」多一位。
 * 用自带键盘，不弹系统输入法。对外和 input 一样：value 进，bind:change 出 { value }。
 */
const PROVINCES = '京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼'.split('')
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('') // 车牌不用 I、O
const DIGITS = '1234567890'.split('')
const NORMAL_LENGTH = 7
const NEW_ENERGY_LENGTH = 8

/** 把外面给的车牌拆成一格一格；位数是 8 就当新能源 */
function splitPlate(value) {
  const chars = String(value || '').replace(/\s/g, '').toUpperCase().split('').slice(0, NEW_ENERGY_LENGTH)
  return { chars, newEnergy: chars.length === NEW_ENERGY_LENGTH }
}

Component({
  properties: {
    value: { type: String, value: '' } // 当前车牌
  },

  data: {
    provinces: PROVINCES,
    letters: LETTERS,
    digits: DIGITS,
    cells: [], // 每一格显示的字
    newEnergy: false, // 新能源 8 位
    cursor: 0, // 正在填第几格
    keyboardShow: false
  },

  observers: {
    /** 外面改了车牌（比如自动填上次的车牌），同步成格子；自己发出去的不重复处理 */
    value(value) {
      if (value === this.emitted) return
      const { chars, newEnergy } = splitPlate(value)
      this.render(chars, newEnergy, Math.min(chars.length, newEnergy ? NEW_ENERGY_LENGTH - 1 : NORMAL_LENGTH - 1))
    }
  },

  lifetimes: {
    attached() {
      if (!this.data.cells.length) this.render([], false, 0)
    }
  },

  methods: {
    /** 按字和位数重画格子 */
    render(chars, newEnergy, cursor) {
      const length = newEnergy ? NEW_ENERGY_LENGTH : NORMAL_LENGTH
      const cells = []
      for (let i = 0; i < length; i += 1) cells.push(chars[i] || '')
      this.chars = chars.slice(0, length)
      this.setData({ cells, newEnergy, cursor: Math.max(0, Math.min(cursor, length - 1)) })
    },

    /** 把当前车牌发给页面 */
    emit() {
      this.emitted = this.chars.join('')
      this.triggerEvent('change', { value: this.emitted })
    },

    /** 点某一格：从这格开始改，弹出键盘 */
    onCellTap(event) {
      const index = Number(event.currentTarget.dataset.index)
      // 不能跳过空格往后填
      this.setData({ cursor: Math.min(index, this.chars.length), keyboardShow: true })
    },

    /** 勾 / 取消新能源：取消时去掉第 8 位 */
    toggleNewEnergy() {
      const newEnergy = !this.data.newEnergy
      const chars = newEnergy ? this.chars : this.chars.slice(0, NORMAL_LENGTH)
      this.render(chars, newEnergy, Math.min(chars.length, (newEnergy ? NEW_ENERGY_LENGTH : NORMAL_LENGTH) - 1))
      this.emit()
      this.setData({ keyboardShow: true })
    },

    /** 键盘上点了一个字；第 1 格只收省份，第 2 格只收字母 */
    onKeyTap(event) {
      const key = event.currentTarget.dataset.key
      const cursor = this.data.cursor
      if (!key || event.currentTarget.dataset.disabled) return
      const chars = this.chars.slice()
      chars[cursor] = key
      const length = this.data.cells.length
      this.render(chars, this.data.newEnergy, cursor + 1)
      this.emit()
      // 填满最后一格就收起键盘
      if (cursor >= length - 1) this.setData({ keyboardShow: false })
    },

    /** 退格：当前格有字删当前格，没有就删前一格 */
    onDelete() {
      const chars = this.chars.slice()
      let cursor = this.data.cursor
      if (!chars[cursor] && cursor > 0) cursor -= 1
      chars.splice(cursor, 1) // 只删这一格，后面的往前补
      this.render(chars, this.data.newEnergy, cursor)
      this.emit()
    },

    /** 收起键盘 */
    closeKeyboard() {
      this.setData({ keyboardShow: false })
    },

    noop() {}
  }
})
