/**
 * 导航语音播报。
 *
 * 只在「导航阶段」变化时播一次：同一句左转/右转不会因距离从 220m 变成 217m 而重播。
 * 等过了这个弯、指令换成直行/下一弯/到达，再播下一句。
 * 依赖：config（接口地址）、auth（令牌）。
 */
const config = require('../config')
const auth = require('./auth')

let audio = null // 微信里用来播 mp3 的播放器，全程共用一个
let lastPhaseKey = '' // 上一句已经播过的阶段（去掉数字后的文案），用来避免同一弯重复播
let speaking = false // 现在是不是正在出声
let playToken = 0 // 每一次新播报加一，用来作废还没播完的旧音频

/**
 * 抽掉距离数字，得到阶段键。
 * 「前方路口左转 · 220m」和「前方路口左转 · 217m」视为同一阶段。
 */
function phaseKey(text) {
  // 没有文案就没有阶段
  if (!text) return ''
  // 去掉空格、间隔点和米数，只留「左转/直行/到达」这类阶段
  return String(text)
    .replace(/\s+/g, '')
    .replace(/[·・]/g, '')
    .replace(/\d+(\.\d+)?\s*(m|米|km|公里)?/gi, '')
    .replace(/即将/g, '')
}

/** 还没有播放器就建一个；静音开关打开时也要出声，方便司机戴耳塞听 */
function ensureAudio() {
  // 已经有播放器就直接用
  if (audio) return audio
  // 新建一个小程序内置播放器
  audio = wx.createInnerAudioContext()
  // 即使手机开了静音键也要播，导航不能被静音挡掉
  audio.obeyMuteSwitch = false
  // 播完后标记不在说话
  audio.onEnded(() => { speaking = false })
  // 被中途停掉也标记不在说话
  audio.onStop(() => { speaking = false })
  // 播失败时记下日志，避免卡住后续句子
  audio.onError(err => {
    speaking = false
    console.warn('[voice] play error', err)
  })
  // 把播放器交出去
  return audio
}

/** 立刻停掉当前正在播的那一句 */
function stop() {
  // 先标成没在说话
  speaking = false
  // 还没建播放器就不用停
  if (!audio) return
  try {
    // 停掉当前音频
    audio.stop()
  } catch (error) {
    // ignore
  }
}

/** 把后台返回的语音二进制写成临时 mp3，再交给播放器出声 */
function playBuffer(arrayBuffer, token) {
  // 已经有更新的一句要播，这包旧音频作废
  if (token !== playToken) return
  // 用微信文件系统把音频落到手机
  const fs = wx.getFileSystemManager()
  // 每次用不同文件名，避免旧文件还没写完就被覆盖
  const path = `${wx.env.USER_DATA_PATH}/nav_tts_${token}.mp3`
  try {
    // 把二进制写成 mp3 文件
    fs.writeFileSync(path, arrayBuffer)
  } catch (error) {
    console.warn('[voice] write file failed', error)
    return
  }
  // 写文件期间又来了新一句，这份也不播
  if (token !== playToken) return
  // 拿到播放器
  const player = ensureAudio()
  try {
    // 先停掉上一句，避免两句叠在一起
    player.stop()
  } catch (error) {
    // ignore
  }
  // 标记正在出声
  speaking = true
  // 指定刚写好的 mp3
  player.src = path
  // 开始播
  player.play()
}

/** 向后台要这一句的语音文件，回来后再播 */
function fetchAndPlay(text, token) {
  // 记下这次请求对应哪一句，回来时用来核对
  const requestToken = token
  // 取出登录令牌，后台要认人
  const satoken = auth.getToken()
  // 请求语音合成接口
  wx.request({
    url: `${config.apiBaseUrl}/navigation/mobile/tts`,
    method: 'GET',
    data: { text }, // 要合成的中文句子
    header: satoken ? { satoken } : {}, // 有令牌才带头
    responseType: 'arraybuffer', // 要的是音频二进制，不是 JSON
    timeout: 10000, // 语音合成超过 10 秒就放弃，不能卡住导航
    success(res) {
      // 已经换成更新的一句，这份不要了
      if (requestToken !== playToken) return
      // 状态不对或内容太短，不是有效音频
      if (res.statusCode !== 200 || !res.data || res.data.byteLength < 64) {
        console.warn('[voice] tts http', res.statusCode)
        return
      }
      // 看第一个字节是不是 { 或 [，那种是后台报错 JSON，不是声音
      const head = new Uint8Array(res.data.slice(0, 1))[0]
      if (head === 0x7b || head === 0x5b) {
        console.warn('[voice] tts returned json, not audio')
        return
      }
      // 是音频就拿去播
      playBuffer(res.data, requestToken)
    },
    fail(err) {
      console.warn('[voice] tts request fail', err)
    }
  })
}

/** 导航页调用：语音开着且句子换了阶段才播；同一弯只播一次 */
function speak(text, enabled) {
  // 关了语音或没有文案就不播
  if (!enabled || !text) return
  // 抽出阶段键，判断是不是同一弯
  const key = phaseKey(text)
  // 空阶段或还是上一句，不重播
  if (!key || key === lastPhaseKey) return
  // 记下这一阶段，后面同一弯不再播
  lastPhaseKey = key
  // 作废上一句还在路上的音频
  playToken += 1
  // 记下这一句的编号
  const token = playToken

  // 轻轻震一下，提醒司机听语音
  wx.vibrateShort({ type: 'light', fail: () => {} })
  // 停掉上一句
  stop()
  // 句子太长只取前 48 个字，避免合成超时
  fetchAndPlay(String(text).slice(0, 80), token)
}

/** 结束导航或切换会话时清掉阶段，避免下一趟被挡住 */
function resetPhase() {
  // 清空已播阶段
  lastPhaseKey = ''
  // 作废进行中的音频
  playToken += 1
  // 立刻停声
  stop()
}

// 导航页开关语音、结束导航时用
module.exports = { speak, stop, resetPhase, phaseKey }
