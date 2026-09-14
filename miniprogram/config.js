/**
 * 小程序运行配置。
 * 正式发布前需在微信公众平台配置对应 request 合法域名。
 */
module.exports = {
  apiBaseUrl: 'http://117.72.38.68/guide',
  wsBaseUrl: 'ws://117.72.38.68/guide',

  /**
   * 高精度模型的下载地址。小程序主包上限 2MB，集卡高模单个就 1.5MB+，
   * 放不进包，只能运行时下载后缓存到本地。包内的低模负责首屏不空场。
   *
   * 开发阶段用 http + IP，需要在开发者工具勾选「不校验合法域名」。
   * 正式发布必须换成 https 域名，并在公众平台配置 downloadFile 合法域名。
   * 置空则完全禁用远端模型，只用包内低模。
   */
  modelBaseUrl: 'http://117.72.38.68/models',
  // 本机联调（电脑和真机同一 Wi-Fi，端口不能省）
  // apiBaseUrl: 'http://10.249.196.198:19207/guide',
  // wsBaseUrl: 'ws://10.249.196.198:19207/guide',
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
  coordinateSystem: 'wgs84'
}
