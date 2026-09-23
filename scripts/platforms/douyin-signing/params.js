// Query-string helpers + Douyin default param sets.
//
// Two serializers, matching the upstream project exactly:
//   - urlencode()  : Python urllib.parse.urlencode (quote_plus). Used
//     by the a_bogus path (params_dict -> urlencode -> sign the SAME
//     string that goes in the URL).
//   - rawJoin()    : plain "k=v&k=v" with NO escaping. Used by the
//     X-Bogus path (BogusManager.xb_model_2_endpoint joins raw).
//
// Param object insertion order mirrors the pydantic model field order
// so the signed string matches what the upstream produces.

// Python quote_plus: safe = A-Za-z0-9 and _.-~ ; space -> '+';
// everything else -> %XX over utf-8 bytes (uppercase hex).
const SAFE = /[A-Za-z0-9_.\-~]/
export function quotePlus (value) {
  const s = String(value)
  let out = ''
  for (const ch of s) {
    if (SAFE.test(ch)) out += ch
    else if (ch === ' ') out += '+'
    else {
      for (const b of new TextEncoder().encode(ch)) {
        out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
      }
    }
  }
  return out
}

export function urlencode (obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`)
    .join('&')
}

export function rawJoin (obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

// BaseRequestModel — the default query params on every Douyin web
// call. Field order matches crawlers/douyin/web/models.py. msToken is
// passed in (a_bogus path sets it to '', X-Bogus path uses a real or
// fake msToken).
export function baseRequestParams (msToken = '') {
  return {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '1',
    version_code: '290100',
    version_name: '29.1.0',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '130.0.0.0',
    browser_online: 'true',
    engine_name: 'Blink',
    engine_version: '130.0.0.0',
    os_name: 'Windows',
    os_version: '10',
    cpu_core_num: '12',
    device_memory: '8',
    platform: 'PC',
    downlink: '10',
    effective_type: '4g',
    from_user_page: '1',
    locate_query: 'false',
    need_time_list: '1',
    pc_libra_divert: 'Windows',
    publish_video_strategy_type: '2',
    round_trip_time: '0',
    show_live_replay_strategy: '1',
    time_list_query: '0',
    whale_cut_token: '',
    update_version_code: '170400',
    msToken
  }
}

// BaseLiveModel — for live room enter (fetch_user_live_videos).
export function baseLiveParams () {
  return {
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Edge',
    browser_version: '119.0.0.0',
    enter_source: '',
    is_need_double_stream: 'false'
  }
}

// BaseLiveModel2 — for room reflow (fetch_user_live_videos_by_room_id).
export function baseLive2Params (verifyFp, msToken) {
  return {
    verifyFp,
    type_id: '0',
    live_id: '1',
    sec_user_id: '',
    version_code: '99.99.99',
    app_id: '1128',
    msToken
  }
}
