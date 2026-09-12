const auth = require('./utils/auth')

// 字面量路径给微信打包器用，真机才会带上 GLB；不要改成变量拼接
void '/models/truck.glb'
void '/models/stacker.glb'
void '/models/container20.glb'
void '/models/container40.glb'

App({
  onLaunch() {
    this.globalData.user = auth.getUser()
  },

  globalData: {
    user: null,
    selectedTarget: null
  }
})
