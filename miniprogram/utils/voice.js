/**
 * 导航语音播报。
 *
 * 只在「导航阶段」变化时播一次：同一句左转/右转不会因距离从 220m 变成 217m 而重播。
 * 等过了这个弯、指令换成直行/下一弯/到达，再播下一句。
 */
const config = require('../config')
const auth = require('./auth')

let audio = null
let lastPhaseKey = ''
let speaking = false
let playToken = 0

/**
 * 抽掉距离数字，得到阶段键。
 * 「前方路口左转 · 220m」和「前方路口左转 · 217m」视为同一阶段。
 */
function phaseKey(text) {
  if (!text) return ''
  return String(text)
    .replace(/\s+/g, '')
    .replace(/[·・]/g, '')
    .replace(/\d+(\.\d+)?\s*(m|米|km|公里)?/gi, '')
    .replace(/即将/g, '')
}

function ensureAudio() {
  if (audio) return audio
  audio = wx.createInnerAudioContext()
  audio.obeyMuteSwitch = false
  audio.onEnded(() => { speaking = false })
  audio.onStop(() => { speaking = false })
  audio.onError(err => {
    speaking = false
    console.warn('[voice] play error', err)
  })
  return audio
}

function stop() {
  speaking = false
  if (!audio) return
  try {
    audio.stop()
  } catch (error) {
    // ignore
  }
}

function playBuffer(arrayBuffer, token) {
  if (token !== playToken) return
  const fs = wx.getFileSystemManager()
  const path = `${wx.env.USER_DATA_PATH}/nav_tts_${token}.mp3`
  try {
    fs.writeFileSync(path, arrayBuffer)
  } catch (error) {
    console.warn('[voice] write file failed', error)
    return
  }
  if (token !== playToken) return
  const player = ensureAudio()
  try {
    player.stop()
  } catch (error) {
    // ignore
  }
  speaking = true
  player.src = path
  player.play()
}

function fetchAndPlay(text, token) {
  const requestToken = token
  const satoken = auth.getToken()
  wx.request({
    url: `${config.apiBaseUrl}/navigation/mobile/tts`,
    method: 'GET',
    data: { text },
    header: satoken ? { satoken } : {},
    responseType: 'arraybuffer',
    timeout: 10000,
    success(res) {
      if (requestToken !== playToken) return
      if (res.statusCode !== 200 || !res.data || res.data.byteLength < 64) {
        console.warn('[voice] tts http', res.statusCode)
        return
      }
      const head = new Uint8Array(res.data.slice(0, 1))[0]
      if (head === 0x7b || head === 0x5b) {
        console.warn('[voice] tts returned json, not audio')
        return
      }
      playBuffer(res.data, requestToken)
    },
    fail(err) {
      console.warn('[voice] tts request fail', err)
    }
  })
}

function speak(text, enabled) {
  if (!enabled || !text) return
  const key = phaseKey(text)
  if (!key || key === lastPhaseKey) return
  lastPhaseKey = key
  playToken += 1
  const token = playToken

  wx.vibrateShort({ type: 'light', fail: () => {} })
  stop()
  fetchAndPlay(String(text).slice(0, 48), token)
}

/** 结束导航或切换会话时清掉阶段，避免下一趟被挡住 */
function resetPhase() {
  lastPhaseKey = ''
  playToken += 1
  stop()
}

module.exports = { speak, stop, resetPhase, phaseKey }
