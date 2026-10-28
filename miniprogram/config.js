/**
 * 小程序运行配置。
 * 正式发布前需在微信公众平台配置对应 request 合法域名。
 */
module.exports = {
  /**
   * 本机联调：IP 换成你电脑在局域网里的地址，端口必须是 application-local.yml 里的 19207。
   * 开发者工具：详情 → 本地设置 → 勾选「不校验合法域名、web-view、TLS…」。
   * 真机调试：手机与电脑同一 Wi-Fi；Windows 防火墙放行 19207；后端需已启动且能连上 local 里的 MySQL/Redis。
   */
  apiBaseUrl: 'https://dct.hturing.com/guide',
  wsBaseUrl: 'wss://dct.hturing.com/guide',
  // apiBaseUrl: 'http://10.196.1.136:19207/guide',
  // wsBaseUrl: 'ws://10.196.1.136:19207/guide',

  /**
   * 远端高精度模型的下载目录，目前不用：导航页本车是定位圆点，到位页用包内 models/*.glb 低模。
   * 要恢复下载时填 https 地址（需在公众平台配置 downloadFile 合法域名），并在 utils/vehicleLoader.js 的 REMOTE_MODELS 登记文件。
   */
  modelBaseUrl: '',
  // 导航页本地跟车已是 onLocationChange（约 1Hz）；这里是上报后端的间隔，对齐 WTRTK 1Hz
  locationReportIntervalMs: 1000,

  /**
   * 定位坐标系，必须和堆场三点定标控制点所用的坐标系一致，否则整体偏差约 460 米。
   *
   * 'wgs84' —— WTRTK 等 RTK-GNSS 设备实测的控制点就是这个系，当前全系统采用。
   * 'gcj02' —— 控制点取自国内地图服务时才用。
   *
   * 注意两个定位接口的默认值是相反的：wx.getLocation 默认 wgs84，
   * wx.startLocationUpdate 默认 gcj02，所以两处都必须显式传值，见 utils/location.js。
   * 自绘 canvas 堆场图不依赖任何地图底图，不存在为了对齐底图而用 GCJ-02 的理由。
   */
  coordinateSystem: 'wgs84',
}
