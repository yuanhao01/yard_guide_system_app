/**
 * 小程序总入口：一打开就恢复上次登录的人，并给后面各页准备共用数据。
 * 依赖：utils/auth（读本地登录态）。
 */
const auth = require('./utils/auth')
const collabUnread = require('./utils/collabUnread')

// 字面量路径给微信打包器用，真机才会带上 GLB；不要改成变量拼接
void '/models/truck.glb'
void '/models/stacker.glb'
void '/models/container20.glb'
void '/models/container40.glb'

// 注册整个小程序，下面的方法所有页面都能用到
App({
  /** 小程序刚启动时执行：把上次登录的用户读回来，首页才能显示姓名/堆场 */
  onLaunch() {
    // 从手机本地取出已登录用户，放到全局，各页不用再各自去读
    this.globalData.user = auth.getUser()
  },

  /** 回到前台：已登录就开始对未读，写底部 tab 数字 */
  onShow() {
    if (auth.isLoggedIn()) {
      collabUnread.start()
    } else {
      collabUnread.stop()
    }
  },

  /** 切到后台：停轮询，徽章先留着 */
  onHide() {
    collabUnread.pause()
  },

  // 全小程序共用的一份数据，页面之间靠它传递「当前用户」和「刚选的目的地」
  globalData: {
    user: null, // 当前登录的司机或现场人员，没登录就是空
    selectedTarget: null // 选贝位后暂存在这里，确认任务页再取走
  }
})
