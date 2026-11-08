;(function () {
  'use strict'

  var SCRIPT_NAME = 'csvc-chat-embed'
  var scriptEl = document.currentScript

  if (!scriptEl) {
    var scripts = document.getElementsByTagName('script')
    scriptEl = scripts[scripts.length - 1]
  }

  if (!scriptEl) return
  if (window.__EFX_CHAT_EMBED_LOADED__) return
  window.__EFX_CHAT_EMBED_LOADED__ = true

  // Compare two version strings. Returns >0 if a>b, <0 if a<b, 0 if equal.
  // Supports plain numeric ('29') and dotted numeric ('1.2.3') versions.
  function compareVersions (a, b) {
    var pa = String(a == null ? '' : a).split('.')
    var pb = String(b == null ? '' : b).split('.')
    var len = Math.max(pa.length, pb.length)
    for (var i = 0; i < len; i++) {
      var na = parseInt(pa[i], 10) || 0
      var nb = parseInt(pb[i], 10) || 0
      if (na > nb) return 1
      if (na < nb) return -1
    }
    return 0
  }

  var scriptUrl
  try {
    scriptUrl = new URL(scriptEl.src, window.location.href)
  } catch (err) {
    console.error('[' + SCRIPT_NAME + '] Invalid script src:', err)
    return
  }

  var scriptOrigin = scriptUrl.origin
  // Version passed by emloader.js (embed.min.js?v=<version>). Sub-resources reuse it as a cache-buster, so they can be
  // cached for a long time and are refetched only when the version changes.
  var assetVersion = scriptUrl.searchParams.get('v')
  function assetUrl(path) {
    return scriptOrigin + path + (assetVersion ? '?v=' + encodeURIComponent(assetVersion) : '')
  }
  var currentHostname = (window.location.hostname || '').toLowerCase()
  var socketScriptPromise = null
  var compressorScriptPromise = null

  var defaultConfig = {
    enabled: true,
    apiUrl: window.location.origin,
    desktop: {
      right: 20,
      bottom: 20
    },
    mobile: {
      right: 0,
      bottom: 0
    }
  }

  var I18N = {
    'zh-Hans': {
      onlineSupport: '在线客服',
      inputPlaceholder: '请输入消息...',
      reconnectingInputPrefix: '聊天服务中断,尝试重连中',
      loadingMore: '加载中...',
      imageSendFailed: '图片发送失败',
      compressingImage: '图片压缩中',
      uploadingImage: '图片上传中',
      serviceTemporaryError: '在线聊天连接失败,请尝试刷新网页重新连接',
      connectionReconnecting: '连接已断开，正在尝试自动重连...',
      cannotSendWhileOffline: '当前连接不可用，消息暂未发送，请等待重连或刷新页面。',
      visitorPrefix: '访客',
      welcomeMessage: '如果在线客服未能及时回复,请留下您的Email和留言, 我们会尽快联络您.',
      persistSessionHint: '保留会话, 下次接着聊'
    },
    'zh-Hant': {
      onlineSupport: '线上客服',
      inputPlaceholder: '请输入消息...',
      reconnectingInputPrefix: '聊天服務中斷,嘗試重連中',
      loadingMore: '加载中...',
      imageSendFailed: '图片发送失败',
      compressingImage: '圖片壓縮中',
      uploadingImage: '圖片上傳中',
      serviceTemporaryError: '線上聊天連線失敗,請嘗試重新整理網頁再重新連線',
      connectionReconnecting: '連線已中斷，正在嘗試自動重連...',
      cannotSendWhileOffline: '目前連線不可用，訊息尚未送出，請等待重連或重新整理頁面。',
      visitorPrefix: '访客',
      welcomeMessage: '如果在線客服未能及時回覆,請留下您的Email和留言, 我們會盡快聯絡您.',
      persistSessionHint: '保留會話, 下次接著聊'
    },
    en: {
      onlineSupport: 'Online Support',
      inputPlaceholder: 'Type your message...',
      reconnectingInputPrefix: 'Chat service interrupted, attempting reconnection',
      loadingMore: 'Loading...',
      imageSendFailed: 'Failed to send image',
      compressingImage: 'Compressing image',
      uploadingImage: 'Uploading image',
      serviceTemporaryError: 'Chat service is temporarily unavailable. Reconnecting automatically...',
      connectionReconnecting: 'Connection lost. Reconnecting automatically...',
      cannotSendWhileOffline: 'Connection is unavailable. Your message was not sent. Please wait for reconnection or refresh the page.',
      visitorPrefix: 'Visitor',
      welcomeMessage: 'If our online support cannot reply in time, please leave your Email and message. We will contact you as soon as possible.',
      persistSessionHint: 'Keep this session and continue next time'
    },
    th: {
      onlineSupport: 'ฝ่ายบริการสนับสนุนออนไลน์', 
      inputPlaceholder: 'พิมพ์ข้อความของคุณ...', 
      reconnectingInputPrefix: 'บริการแชตขัดข้อง กำลังพยายามเชื่อมต่อใหม่',
      loadingMore: 'กำลังโหลดเพิ่มเติม...', 
      imageSendFailed: 'ส่งรูปภาพไม่สำเร็จ', 
      compressingImage: 'กำลังบีบอัดรูปภาพ',
      uploadingImage: 'กำลังอัปโหลดรูปภาพ', 
      serviceTemporaryError: 'การเชื่อมต่อแชทออนไลน์ล้มเหลว กรุณารีเฟรชหน้าเว็บและลองเชื่อมต่อใหม่อีกครั้ง', 
      connectionReconnecting: 'การเชื่อมต่อหลุด กำลังพยายามเชื่อมต่อใหม่อัตโนมัติ...',
      cannotSendWhileOffline: 'ขณะนี้ไม่สามารถเชื่อมต่อได้ ข้อความยังไม่ถูกส่ง กรุณารอให้เชื่อมต่อใหม่หรือรีเฟรชหน้า',
      visitorPrefix: 'ผู้เยี่ยมชม', 
      welcomeMessage: 'หากฝ่ายบริการสนับสนุนออนไลน์ของเราไม่สามารถตอบกลับได้ทันเวลา กรุณาทิ้งอีเมลและข้อความของคุณไว้ เราจะติดต่อกลับโดยเร็วที่สุด', 
      persistSessionHint: 'คงเซสชันนี้ไว้เพื่อดำเนินการต่อในครั้งถัดไป'
    }
  }

  function normalizeLang(lang) {
    var value = String(lang || '').toLowerCase()
    if (value.indexOf('th') === 0) return 'th'
    if (
      value.indexOf('zh-tw') === 0 ||
      value.indexOf('zh-hant') === 0 ||
      value.indexOf('zh-hk') === 0 ||
      value.indexOf('zh-mo') === 0
    ) {
      return 'zh-Hant'
    }
    if (
      value.indexOf('zh-cn') === 0 ||
      value.indexOf('zh-hans') === 0 ||
      value.indexOf('zh-sg') === 0 ||
      value.indexOf('zh-my') === 0
    ) {
      return 'zh-Hans'
    }
    if (value.indexOf('zh') === 0) {
      return 'zh-Hans'
    }
    return 'en'
  }

  function resolveLang() {
    var params = new URLSearchParams(window.location.search)
    var queryLang = params.get('lang') || params.get('locale')
    if (queryLang) return normalizeLang(queryLang)
    if (document.documentElement && document.documentElement.lang) {
      return normalizeLang(document.documentElement.lang)
    }
    return normalizeLang(navigator.language || 'en')
  }

  function ensureMobileViewportMeta() {
    var ua = String(navigator.userAgent || '').toLowerCase()
    var isMobileUA = /android|iphone|ipad|ipod|mobile|windows phone/.test(ua)
    if (!isMobileUA) return

    var head = document.head || document.getElementsByTagName('head')[0]
    if (!head) return

    var viewportMeta = document.querySelector('meta[name="viewport"]')
    if (viewportMeta) return

    viewportMeta = document.createElement('meta')
    viewportMeta.setAttribute('name', 'viewport')
    // Added maximum-scale=1 and user-scalable=no to prevent Safari from auto-scrolling/zooming which causes the gap
    viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover')
    head.appendChild(viewportMeta)
  }

  function text(lang, key) {
    return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key
  }

  function ensureStyles() {
    if (document.getElementById('efx-chat-widget-style')) return
    var style = document.createElement('style')
    style.id = 'efx-chat-widget-style'
    style.textContent =
      '.efx-chat-widget{position:fixed !important;z-index:2147483000 !important;right:20px !important;bottom:20px !important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif !important;font-size:16px !important;-webkit-text-size-adjust:100% !important;text-size-adjust:100% !important;box-sizing:border-box !important;line-height:1.2 !important}'+
      '.efx-chat-widget *{box-sizing:border-box !important;font-family:inherit !important}'+
      '.efx-chat-launcher{width:60px !important;height:60px !important;background:#0088cc !important;border-radius:50% !important;display:flex !important;align-items:center !important;justify-content:center !important;cursor:pointer !important;box-shadow:0 4px 12px rgba(0,0,0,.15) !important;position:relative !important;border:0 !important;padding:0 !important;margin:0 !important}'+
      '.efx-chat-launcher svg{width:30px !important;height:30px !important;fill:#fff !important;display:block !important}'+
      '.efx-chat-unread{position:absolute;top:-5px;right:-5px;background:#ff4444;color:#fff;border-radius:12px;min-width:20px;height:20px;padding:0 6px;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center}'+
      '.efx-chat-window{width:350px !important;height:500px !important;background:#fff !important;border-radius:12px !important;box-shadow:0 8px 24px rgba(0,0,0,.15) !important;display:flex !important;flex-direction:column !important;overflow:hidden !important;position:absolute !important;bottom:80px !important;right:0 !important;margin:0 !important;border:0 !important}'+
      '.efx-chat-hidden{display:none !important}'+
      '.efx-chat-header{background:#0088cc !important;color:#fff !important;padding:15px !important;margin:0 !important;border:0 !important}'+
      '.efx-chat-header-main{display:flex !important;flex-direction:column !important;gap:6px !important;min-width:0 !important;width:100% !important}'+
      '.efx-chat-header-top{display:flex !important;align-items:center !important;justify-content:space-between !important;gap:10px !important;width:100% !important}'+
      '.efx-chat-header h3{margin:0 !important;padding:0 !important;font-size:16px !important;line-height:1.2 !important;font-weight:600 !important;color:#fff !important;display:block !important;float:none !important;text-transform:none !important;letter-spacing:normal !important;text-align:left !important}'+
      '.efx-chat-persist-row{display:flex !important;align-items:center !important;gap:6px !important;font-size:12px !important;color:rgba(255,255,255,.92) !important;cursor:pointer !important;line-height:1.2 !important;margin:0 !important;padding:0 !important;float:none !important}'+
      '.efx-chat-conn-tip{margin:0 10px 8px !important;padding:6px 8px !important;border-radius:6px !important;font-size:12px !important;line-height:1.3 !important;background:#fff5e6 !important;color:#ad6800 !important;border:1px solid #ffd591 !important}'+
      '.efx-chat-persist-checkbox{margin:0 !important;cursor:pointer !important;width:14px !important;height:14px !important;display:inline-block !important;vertical-align:middle !important}'+
      '.efx-chat-close{background:none !important;border:0 !important;color:#fff !important;font-size:20px !important;cursor:pointer !important;line-height:1 !important;display:inline-flex !important;align-items:center !important;justify-content:center !important;margin:0 !important;padding:0 !important;width:auto !important;height:auto !important;min-width:20px !important;min-height:20px !important;float:none !important;text-decoration:none !important;box-shadow:none !important}'+
      '.efx-chat-messages{flex:1;min-height:0;padding:15px;overflow-y:auto !important;overflow-x:hidden !important;-webkit-overflow-scrolling:touch;background:#f7f7f7;display:flex;flex-direction:column;gap:10px}'+
      '.efx-chat-messages::before{content:"";display:block;flex:1 0 auto}'+
      '.efx-chat-loading{text-align:center;font-size:12px;color:#999;padding:5px}'+
      '.efx-chat-message{max-width:90%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.4;word-wrap:break-word;white-space:pre-wrap;text-align:left}'+
      '.efx-chat-message.visitor{align-self:flex-end;background:#effdde;color:#000;border-bottom-right-radius:2px}'+
      '.efx-chat-message.agent{align-self:flex-start;background:#fff;color:#333;border:1px solid #ddd;border-bottom-left-radius:2px}'+
      '.efx-chat-message.welcome{align-self:center;max-width:100%;text-align:center;background:#fffbe6;color:#8a6d3b;border:1px dashed #f0d58c}'+
      '.efx-chat-image{max-width:100%;border-radius:4px;cursor:zoom-in;display:block}'+
      '.efx-chat-input-wrap{padding:10px;border-top:1px solid #eee;display:flex;align-items:center;gap:8px}'+
      '.efx-chat-upload{cursor:pointer;display:flex;align-items:center;justify-content:center;padding:4px}'+
      '.efx-chat-upload svg{width:24px;height:24px;fill:#999}'+
      '.efx-chat-upload.efx-chat-upload-disabled{opacity:.45 !important;pointer-events:none !important;cursor:not-allowed !important}'+
      '.efx-chat-input-form{flex:1;display:flex;align-items:center}'+
      '.efx-chat-input{flex:1;padding:10px;border:1px solid #ddd;border-radius:20px;outline:none;font-size:16px !important;line-height:1.4 !important}'+
      '.efx-chat-input:disabled{background:#f3f3f3 !important;color:#999 !important;cursor:not-allowed !important}'+
      '.efx-chat-upload-progress{padding:8px 10px;border-top:1px solid #f0f0f0;background:#fff;display:flex;flex-direction:column;gap:6px}'+
      '.efx-chat-upload-progress-text{font-size:12px;color:#666;line-height:1.2}'+
      '.efx-chat-upload-progress-bar{height:4px;background:#e8e8e8;border-radius:999px;overflow:hidden}'+
      '.efx-chat-upload-progress-fill{display:block;height:100%;width:0;background:#0088cc;transition:width .2s ease}'+
      '.efx-chat-send{-webkit-appearance:none;appearance:none;padding:0;margin:0 0 0 8px;background:#0088cc;color:#fff;border:0;border-radius:50%;width:36px;height:36px;min-width:36px;min-height:36px;max-width:36px;max-height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:0 0 36px;line-height:0;position:relative;vertical-align:middle}'+
      '.efx-chat-send:disabled{background:#b7d7ea !important;cursor:not-allowed !important}'+
      '.efx-chat-send::before{content:"";display:block;width:0;height:0;border-top:6px solid transparent;border-bottom:6px solid transparent;border-left:12px solid #fff;transform:translateX(1px);pointer-events:none}'+
      '.efx-chat-preview{position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;width:100vw !important;height:100vh !important;background:rgba(0,0,0,.85) !important;display:flex !important;align-items:center !important;justify-content:center !important;z-index:2147483646 !important;overflow:hidden !important;touch-action:none !important}'+
      '.efx-chat-preview img{max-width:92vw !important;max-height:92vh !important;margin:auto !important;border-radius:8px !important;user-select:none !important;-webkit-user-select:none !important;-webkit-user-drag:none !important;-webkit-touch-callout:none !important;touch-action:none !important;transform-origin:center center !important;will-change:transform !important;cursor:zoom-in !important;transition:transform .15s ease !important;display:block !important}'+
      '.efx-chat-preview-close{position:absolute !important;top:16px !important;right:16px !important;width:36px !important;height:36px !important;border-radius:50% !important;background:rgba(255,255,255,.15) !important;color:#fff !important;border:0 !important;padding:0 !important;margin:0 !important;font-size:22px !important;line-height:1 !important;cursor:pointer !important;display:flex !important;align-items:center !important;justify-content:center !important;z-index:2147483647 !important}'+
      '.efx-chat-widget.efx-chat-mobile{right:0 !important;bottom:0 !important;position:fixed !important;top:auto !important;left:auto !important;width:auto !important;height:auto !important;overflow:visible !important}'+
      '.efx-chat-widget.efx-chat-mobile .efx-chat-window{position:fixed !important;inset:auto !important;top:var(--efx-mobile-top,0px) !important;left:var(--efx-mobile-left,0px) !important;width:var(--efx-mobile-width,100vw) !important;height:var(--efx-mobile-height,100dvh) !important;border-radius:0 !important;box-shadow:none !important;bottom:auto !important;right:auto !important}'+
      'html.efx-chat-open,body.efx-chat-open{overflow:hidden !important;height:100% !important;position:fixed !important;width:100% !important}'
    document.head.appendChild(style)
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script')
      s.src = src
      s.async = true
      s.onload = function () { resolve() }
      s.onerror = reject
      document.head.appendChild(s)
    })
  }

  function loadSocketClient() {
    if (window.__EFX_CHAT_IO__) return Promise.resolve()
    if (socketScriptPromise) return socketScriptPromise
    socketScriptPromise = loadScript(assetUrl('/rt-client.js'))
    return socketScriptPromise
  }

  function loadCompressor() {
    if (window.Compressor) return Promise.resolve()
    if (compressorScriptPromise) return compressorScriptPromise
    compressorScriptPromise = loadScript(assetUrl('/compressor.min.js'))
    return compressorScriptPromise
  }

  function loadConfig() {
    if (window.__EFX_CHAT_EMBED_CONFIG__) {
      return Promise.resolve(Object.assign({}, defaultConfig, window.__EFX_CHAT_EMBED_CONFIG__))
    }

    return new Promise(function (resolve) {
      var configScript = document.createElement('script')
      configScript.src = assetUrl('/embed-settings.js')
      configScript.async = true

      configScript.onload = function () {
        var externalConfig = window.__EFX_CHAT_EMBED_CONFIG__ || {}
        resolve(Object.assign({}, defaultConfig, externalConfig))
      }

      configScript.onerror = function () {
        console.warn('[' + SCRIPT_NAME + '] embed-settings.js load failed, fallback to defaults')
        resolve(defaultConfig)
      }

      document.head.appendChild(configScript)
    })
  }

  function escapeHtml(input) {
    return String(input || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  function linkify(input) {
    var safe = escapeHtml(input)
    var withLinks = safe.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#1890ff;text-decoration:underline;">$1</a>')
    return withLinks.replace(/\r\n|\r|\n/g, '<br />')
  }

  function initWidget(config) {
    ensureMobileViewportMeta()
    ensureStyles()

    var lang = resolveLang()
    var apiUrl = String(config.apiUrl || defaultConfig.apiUrl).replace(/\/$/, '')
    var SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
    var visitorStorageKey = 'efx_chat_visitor_id'
    var tokenStorageKey = 'efx_chat_visitor_token'
    var persistOptInKey = 'efx_chat_persist_opt_in'
    var persistDataKey = 'efx_chat_persist_data'
    var draftStorageKey = 'efx_chat_input_draft'

    function readPersistentSession() {
      try {
        var raw = localStorage.getItem(persistDataKey)
        if (!raw) return null
        var parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.visitorToken !== 'string' || !parsed.visitorToken.trim()) {
          localStorage.removeItem(persistDataKey)
          return null
        }
        if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) {
          localStorage.removeItem(persistDataKey)
          return null
        }
        return {
          visitorId: parsed.visitorId,
          visitorToken: typeof parsed.visitorToken === 'string' ? parsed.visitorToken : ''
        }
      } catch (err) {
        return null
      }
    }

    function clearPersistentSession() {
      try {
        localStorage.removeItem(persistDataKey)
        localStorage.removeItem(persistOptInKey)
      } catch (err) {
        // ignore storage errors
      }
    }

    function isPersistentOptedIn() {
      try {
        return localStorage.getItem(persistOptInKey) === '1'
      } catch (err) {
        return false
      }
    }

    var state = {
      open: false,
      visitorId: '',
      visitorToken: '',
      persistSession: isPersistentOptedIn(),
      visitorName: '',
      roomId: '',
      currentPage: window.location.href,
      uploadInProgress: false,
      socket: null,
      isAuthReady: false,
      isLoadingMore: false,
      hasMore: true,
      unreadCount: 0,
      messages: [],
      messageIdSet: {},
      hasInjectedWelcome: false,
      connectionNoticeShown: false,
      disconnectHintTimer: null,
      reauthInProgress: false,
      reconnectWatchdogTimer: null,
      lastReauthAt: 0,
      connectErrorCount: 0,
      reconnectInFlight: false,
      nextReauthAt: 0,
      reconnectTipTimer: null,
      reconnectTipFrame: 0,
      bootstrapRetryTimer: null,
      bootstrapInProgress: false,
      bootstrapRequested: false,
      hasConnectedOnce: false,
      pageTrackingBound: false
    }

    var FALLBACK_POLL_INTERVAL_MS = 15000
    var fallbackPollTimer = null

    // Visitors that already have a chat room reconnect on page load (they may receive agent replies while browsing).
    // Everybody else stays completely offline until the launcher is opened for the first time.
    var hasRoomKey = 'efx_chat_has_room'
    // Result of the last /api/visitor-auth call, kept for this tab session so page navigations do not repeat it.
    // The server-side token lives 30 days; a week is a conservative reuse window.
    var authCacheKey = 'efx_chat_auth_cache'
    var AUTH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

    var persistedSession = state.persistSession ? readPersistentSession() : null
    if (persistedSession) {
      state.visitorId = persistedSession.visitorId
      state.visitorToken = persistedSession.visitorToken
    } else {
      state.visitorId = sessionStorage.getItem(visitorStorageKey) || ''
      state.visitorToken = sessionStorage.getItem(tokenStorageKey) || ''
    }

    function readHasRoomFlag() {
      try {
        return localStorage.getItem(hasRoomKey) === '1'
      } catch (err) {
        return false
      }
    }

    // Keeps the "has a room" flag and the cached auth result in step with state.roomId (set after the first message).
    function rememberRoom() {
      try {
        if (state.roomId) localStorage.setItem(hasRoomKey, '1')
        var raw = sessionStorage.getItem(authCacheKey)
        if (!raw) return
        var cached = JSON.parse(raw)
        if (cached && cached.roomId !== state.roomId) {
          cached.roomId = state.roomId
          sessionStorage.setItem(authCacheKey, JSON.stringify(cached))
        }
      } catch (err) {
        // ignore storage errors
      }
    }

    function readAuthCache() {
      try {
        var raw = sessionStorage.getItem(authCacheKey)
        if (!raw) return null
        var cached = JSON.parse(raw)
        if (!cached || typeof cached.at !== 'number' || Date.now() - cached.at > AUTH_CACHE_TTL_MS) return null
        if (!cached.visitorId || !cached.visitorToken) return null
        // The cache only counts while it still describes the identity this tab is using.
        if (cached.visitorToken !== state.visitorToken) return null
        return cached
      } catch (err) {
        return null
      }
    }

    function writeAuthCache() {
      try {
        sessionStorage.setItem(authCacheKey, JSON.stringify({
          visitorId: state.visitorId,
          visitorName: state.visitorName,
          roomId: state.roomId,
          visitorToken: state.visitorToken,
          at: Date.now()
        }))
      } catch (err) {
        // ignore storage errors
      }
    }

    function persistSessionData() {
      rememberRoom()
      if (!state.persistSession) return
      try {
        var payload = {
          visitorId: state.visitorId,
          visitorToken: state.visitorToken || '',
          expiresAt: Date.now() + SESSION_TTL_MS
        }
        localStorage.setItem(persistDataKey, JSON.stringify(payload))
        localStorage.setItem(persistOptInKey, '1')
      } catch (err) {
        // ignore storage errors
      }
    }

    sessionStorage.setItem(visitorStorageKey, state.visitorId)
    sessionStorage.setItem(tokenStorageKey, state.visitorToken || '')
    state.roomId = ''
    state.visitorName = text(lang, 'visitorPrefix')

    if (state.persistSession) {
      persistSessionData()
    }

    var root = document.createElement('div')
    root.className = 'efx-chat-widget'
    root.style.right = ((config.desktop && config.desktop.right) || 20) + 'px'
    root.style.bottom = ((config.desktop && config.desktop.bottom) || 20) + 'px'

    function isMobileViewport() {
      var ua = String(navigator.userAgent || '').toLowerCase()
      var uaMobile = /android|iphone|ipad|ipod|mobile|windows phone/.test(ua)
      var coarse = false
      try {
        coarse = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches)
      } catch (err) {
        coarse = false
      }
      var viewportWidth = 0
      try {
        viewportWidth = Math.min(
          window.innerWidth || 9999,
          (window.visualViewport && window.visualViewport.width) || 9999,
          document.documentElement ? (document.documentElement.clientWidth || 9999) : 9999
        )
      } catch (err) {
        viewportWidth = window.innerWidth || 9999
      }

      return uaMobile || (coarse && viewportWidth <= 1024) || viewportWidth <= 768
    }

    function isSafari() {
      var ua = navigator.userAgent || ''
      return /Safari/i.test(ua) && !/Chrome/i.test(ua) && !/CriOS/i.test(ua) && !/FxiOS/i.test(ua)
    }

    function applyViewportLayout() {
      if (isMobileViewport()) {
        root.classList.add('efx-chat-mobile')
        root.style.right = ((config.mobile && typeof config.mobile.right === 'number') ? config.mobile.right : 0) + 'px'
        root.style.bottom = ((config.mobile && typeof config.mobile.bottom === 'number') ? config.mobile.bottom : 0) + 'px'
        syncMobileViewportVars()
      } else {
        root.classList.remove('efx-chat-mobile')
        root.style.right = ((config.desktop && typeof config.desktop.right === 'number') ? config.desktop.right : 20) + 'px'
        root.style.bottom = ((config.desktop && typeof config.desktop.bottom === 'number') ? config.desktop.bottom : 20) + 'px'
        root.style.removeProperty('--efx-mobile-top')
        root.style.removeProperty('--efx-mobile-left')
        root.style.removeProperty('--efx-mobile-width')
        root.style.removeProperty('--efx-mobile-height')
      }
    }

    function syncMobileViewportVars() {
      if (!root.classList.contains('efx-chat-mobile')) return

      var vv = window.visualViewport
      var width = vv && vv.width ? vv.width : window.innerWidth
      var height = vv && vv.height ? vv.height : window.innerHeight
      var top = vv && typeof vv.offsetTop === 'number' ? vv.offsetTop : 0
      var left = vv && typeof vv.offsetLeft === 'number' ? vv.offsetLeft : 0

      // Safari 特殊处理：使用 document.documentElement.clientHeight 作为后备
      if (isSafari() && (!height || height === 0)) {
        height = document.documentElement.clientHeight || window.innerHeight
      }

      root.style.setProperty('--efx-mobile-top', Math.max(0, Math.round(top)) + 'px')
      root.style.setProperty('--efx-mobile-left', Math.max(0, Math.round(left)) + 'px')
      root.style.setProperty('--efx-mobile-width', Math.max(1, Math.round(width)) + 'px')
      root.style.setProperty('--efx-mobile-height', Math.max(1, Math.ceil(height)) + 'px')
    }

    var launcher = document.createElement('div')
    launcher.className = 'efx-chat-launcher'
    launcher.innerHTML = '<div class="efx-chat-unread efx-chat-hidden">0</div><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>'

    var panel = document.createElement('div')
    panel.className = 'efx-chat-window efx-chat-hidden'
    panel.innerHTML =
      '<div class="efx-chat-header"><div class="efx-chat-header-main"><div class="efx-chat-header-top"><h3>' + text(lang, 'onlineSupport') + '</h3><button class="efx-chat-close" type="button">&times;</button></div><label class="efx-chat-persist-row"><input class="efx-chat-persist-checkbox" type="checkbox" /><span>' + text(lang, 'persistSessionHint') + '</span></label></div></div>' +
      '<div class="efx-chat-messages"></div>' +
      '<div class="efx-chat-conn-tip efx-chat-hidden"></div>' +
      '<div class="efx-chat-input-wrap">' +
      '  <label class="efx-chat-upload">' +
      '    <input type="file" accept="image/*" style="display:none" />' +
      '    <svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>' +
      '  </label>' +
      '  <form class="efx-chat-input-form">' +
      '    <input class="efx-chat-input" type="text" maxlength="4000" placeholder="' + text(lang, 'inputPlaceholder') + '" />' +
      '    <button class="efx-chat-send" type="submit" aria-label="Send"></button>' +
      '  </form>' +
      '</div>' +
      '<div class="efx-chat-upload-progress efx-chat-hidden"><div class="efx-chat-upload-progress-text"></div><div class="efx-chat-upload-progress-bar"><span class="efx-chat-upload-progress-fill"></span></div></div>'

    root.appendChild(panel)
    root.appendChild(launcher)
    ;(document.documentElement || document.body).appendChild(root)
    applyViewportLayout()
    window.addEventListener('resize', applyViewportLayout)
    window.addEventListener('orientationchange', applyViewportLayout)
    if (window.visualViewport && window.visualViewport.addEventListener) {
      window.visualViewport.addEventListener('resize', applyViewportLayout)
      window.visualViewport.addEventListener('scroll', applyViewportLayout)
      
      // Safari 需要监听更多事件以确保正确更新
      if (isSafari()) {
        var safariViewportUpdate = function() {
          if (state.open && root.classList.contains('efx-chat-mobile')) {
            window.scrollTo(0, 0)
          }
          setTimeout(applyViewportLayout, 0)
          setTimeout(applyViewportLayout, 100)
        }
        window.addEventListener('scroll', safariViewportUpdate)
        document.addEventListener('touchmove', safariViewportUpdate)
      }
    }

    var unreadEl = launcher.querySelector('.efx-chat-unread')
    var closeBtn = panel.querySelector('.efx-chat-close')
    var connTipEl = panel.querySelector('.efx-chat-conn-tip')
    var msgList = panel.querySelector('.efx-chat-messages')
    var uploadLabel = panel.querySelector('.efx-chat-upload')
    var fileInput = panel.querySelector('input[type="file"]')
    var form = panel.querySelector('.efx-chat-input-form')
    var input = panel.querySelector('.efx-chat-input')
    var sendBtn = panel.querySelector('.efx-chat-send')
    var persistCheckbox = panel.querySelector('.efx-chat-persist-checkbox')
    var uploadProgressWrap = panel.querySelector('.efx-chat-upload-progress')
    var uploadProgressText = panel.querySelector('.efx-chat-upload-progress-text')
    var uploadProgressFill = panel.querySelector('.efx-chat-upload-progress-fill')

    if (persistCheckbox) {
      persistCheckbox.checked = !!state.persistSession
      persistCheckbox.addEventListener('change', function () {
        state.persistSession = !!persistCheckbox.checked
        if (state.persistSession) {
          persistSessionData()
        } else {
          clearPersistentSession()
        }
      })
    }

    function loadDraft() {
      try {
        return localStorage.getItem(draftStorageKey) || ''
      } catch (err) {
        return ''
      }
    }

    function saveDraft(value) {
      try {
        localStorage.setItem(draftStorageKey, String(value || ''))
      } catch (err) {
        // ignore storage errors
      }
    }

    function clearDraft() {
      try {
        localStorage.removeItem(draftStorageKey)
      } catch (err) {
        // ignore storage errors
      }
    }

    function setInputPlaceholder(value) {
      if (!input) return
      input.setAttribute('placeholder', value || text(lang, 'inputPlaceholder'))
    }

    function stopReconnectTipAnimation() {
      if (state.reconnectTipTimer) {
        clearInterval(state.reconnectTipTimer)
        state.reconnectTipTimer = null
      }
      state.reconnectTipFrame = 0
      setConnectionTip('', false)
    }

    function startReconnectTipAnimation() {
      if (state.reconnectTipTimer) return

      var base = text(lang, 'reconnectingInputPrefix')
      var frames = ['.', '..', '...']

      state.reconnectTipFrame = 0
      setConnectionTip(base + frames[state.reconnectTipFrame], true)

      state.reconnectTipTimer = setInterval(function () {
        state.reconnectTipFrame = (state.reconnectTipFrame + 1) % frames.length
        setConnectionTip(base + frames[state.reconnectTipFrame], true)
      }, 500)
    }

    setInputPlaceholder(text(lang, 'inputPlaceholder'))
    input.value = loadDraft()

    function visitorHeaders() {
      var token = (state.visitorToken || '').trim()
      return token ? { 'x-visitor-token': token } : {}
    }

    function withVisitorToken(url) {
      var token = (state.visitorToken || '').trim()
      if (!token) return url
      var sep = url.indexOf('?') >= 0 ? '&' : '?'
      return url + sep + 'vt=' + encodeURIComponent(token)
    }

    function updateUnread() {
      if (!state.unreadCount) {
        unreadEl.classList.add('efx-chat-hidden')
        unreadEl.textContent = '0'
        return
      }
      unreadEl.classList.remove('efx-chat-hidden')
      unreadEl.textContent = state.unreadCount > 99 ? '99+' : String(state.unreadCount)
    }

    function setUploadProgress(percent, status) {
      if (!uploadProgressWrap || !uploadProgressText || !uploadProgressFill) return
      var safe = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
      uploadProgressWrap.classList.remove('efx-chat-hidden')
      var message = status === 'compressing' ? text(lang, 'compressingImage') : text(lang, 'uploadingImage')
      uploadProgressText.textContent = message + ' ' + safe + '%'
      uploadProgressFill.style.width = safe + '%'
    }

    function hideUploadProgress() {
      if (!uploadProgressWrap || !uploadProgressText || !uploadProgressFill) return
      uploadProgressWrap.classList.add('efx-chat-hidden')
      uploadProgressText.textContent = ''
      uploadProgressFill.style.width = '0%'
    }

    function scrollToBottom() {
      msgList.scrollTop = msgList.scrollHeight
    }

    function getCurrentPageUrl() {
      return String(window.location.href || '').trim()
    }

    function syncCurrentPage(notifyServer) {
      var nextPage = getCurrentPageUrl()
      if (!nextPage || nextPage === state.currentPage) return
      state.currentPage = nextPage

      if (!notifyServer || !state.socket) return
      state.socket.emit('visitor-page-change', {
        roomId: state.roomId,
        currentPage: state.currentPage
      })
    }

    function bindPageChangeTracking() {
      if (state.pageTrackingBound) return
      state.pageTrackingBound = true

      var originalPushState = window.history && window.history.pushState
      var originalReplaceState = window.history && window.history.replaceState

      function notifyPageChange() {
        syncCurrentPage(true)
      }

      if (typeof originalPushState === 'function') {
        window.history.pushState = function () {
          var result = originalPushState.apply(this, arguments)
          notifyPageChange()
          return result
        }
      }

      if (typeof originalReplaceState === 'function') {
        window.history.replaceState = function () {
          var result = originalReplaceState.apply(this, arguments)
          notifyPageChange()
          return result
        }
      }

      window.addEventListener('popstate', notifyPageChange)
      window.addEventListener('hashchange', notifyPageChange)
    }

    function injectWelcomeIfNeeded() {
      if (state.hasInjectedWelcome || state.messages.length > 0) return

      state.hasInjectedWelcome = true
      appendMessage({
        messageId: 'welcome-' + state.visitorId,
        senderType: 'agent',
        senderId: 'system',
        senderName: text(lang, 'onlineSupport'),
        content: text(lang, 'welcomeMessage'),
        type: 'text',
        timestamp: new Date().toISOString()
      }, false)
    }

    function appendServiceErrorMessage(content) {
      appendMessage({
        messageId: 'service-error-' + String(Date.now()) + '-' + String(state.messages.length),
        senderType: 'agent',
        senderId: 'system',
        senderName: text(lang, 'onlineSupport'),
        content: content || text(lang, 'serviceTemporaryError'),
        type: 'text',
        timestamp: new Date().toISOString()
      }, false)
      if (state.open) {
        scrollToBottom()
      }
    }

    function clearDisconnectHintTimer() {
      if (!state.disconnectHintTimer) return
      clearTimeout(state.disconnectHintTimer)
      state.disconnectHintTimer = null
    }

    function stopReconnectWatchdog() {
      if (!state.reconnectWatchdogTimer) return
      clearInterval(state.reconnectWatchdogTimer)
      state.reconnectWatchdogTimer = null
    }

    function recreateSocketConnection() {
      if (state.socket) {
        try { state.socket.removeAllListeners() } catch (err) {}
        try { state.socket.close() } catch (err) {}
      }
      state.socket = null
      connectSocket()
    }

    function startReconnectWatchdog() {
      if (state.reconnectWatchdogTimer) return

      state.reconnectWatchdogTimer = setInterval(function () {
        if (state.socket && state.socket.connected) {
          stopReconnectWatchdog()
          return
        }

        if (state.reconnectInFlight) return
        state.reconnectInFlight = true

        if (!state.socket) {
          connectSocket()
          state.reconnectInFlight = false
          return
        }

        if (state.connectErrorCount >= 5) {
          console.warn('[' + SCRIPT_NAME + '] recreating socket after repeated reconnect failures')
          state.connectErrorCount = 0
          recreateSocketConnection()
          state.reconnectInFlight = false
          return
        }

        ensureSocketConnected('watchdog')

        // Re-auth at low frequency only; avoid hammering /api/visitor-auth during gateway recovery.
        if (Date.now() >= state.nextReauthAt) {
          state.nextReauthAt = Date.now() + 15000
          tryReAuthAndReconnect()
        }

        state.reconnectInFlight = false
      }, 4000)
    }

    function setConnectionTip(message, visible) {
      if (!connTipEl) return
      connTipEl.textContent = message || ''
      if (visible) {
        connTipEl.classList.remove('efx-chat-hidden')
      } else {
        connTipEl.classList.add('efx-chat-hidden')
      }
    }

    function updateComposerInteractivity() {
      var isReady = !!state.isAuthReady
      var canSend = !!(state.socket && state.socket.connected && isReady)
      if (input) input.disabled = !isReady
      if (sendBtn) sendBtn.disabled = !canSend
      if (uploadLabel) {
        uploadLabel.classList.toggle('efx-chat-upload-disabled', !canSend)
      }
    }

    function handleDisconnectedState(reason) {
      console.warn('[' + SCRIPT_NAME + '] visitor socket disconnected (' + reason + ')')
      state.connectErrorCount += 1
      startReconnectTipAnimation()
      updateComposerInteractivity()
      startReconnectWatchdog()
      startFallbackPolling()
    }

    function handleConnectedState() {
      clearDisconnectHintTimer()
      stopReconnectWatchdog()
      stopReconnectTipAnimation()
      state.connectErrorCount = 0
      state.reconnectInFlight = false
      state.connectionNoticeShown = false
      stopFallbackPolling()
      updateComposerInteractivity()
    }

    function handleOfflineSendAttempt() {
      handleDisconnectedState('send-attempt')
      if (!state.connectionNoticeShown) {
        state.connectionNoticeShown = true
        appendServiceErrorMessage(text(lang, 'cannotSendWhileOffline'))
      }
    }

    function tryReAuthAndReconnect() {
      if (state.reauthInProgress) return
      if (Date.now() - state.lastReauthAt < 3500) return

      state.lastReauthAt = Date.now()
      state.reauthInProgress = true

      authVisitor(true)
        .then(function () {
          if (!state.socket) {
            connectSocket()
            return
          }
          state.socket.auth = state.visitorToken ? { visitorToken: state.visitorToken } : undefined
          ensureSocketConnected('reauth')
        })
        .catch(function (err) {
          console.warn('[' + SCRIPT_NAME + '] reauth failed:', err && err.message ? err.message : err)
        })
        .finally(function () {
          state.reauthInProgress = false
        })
    }

    function setOpen(open) {
      state.open = !!open
      if (state.open) {
        applyViewportLayout()
        panel.classList.remove('efx-chat-hidden')
        launcher.classList.add('efx-chat-hidden')
        state.unreadCount = 0
        updateUnread()
        injectWelcomeIfNeeded()
        scrollToBottom()
        startBootstrap()
        updateComposerInteractivity()
        if (state.socket && state.roomId) {
          state.socket.emit('mark-read', state.roomId)
        }
        if (isMobileViewport()) {
          try {
            document.documentElement.classList.add('efx-chat-open')
            document.body.classList.add('efx-chat-open')
          } catch (e) {}
        }
      } else {
        panel.classList.add('efx-chat-hidden')
        launcher.classList.remove('efx-chat-hidden')
        try {
          document.documentElement.classList.remove('efx-chat-open')
          document.body.classList.remove('efx-chat-open')
          if (isMobileViewport()) {
            window.scrollTo(0, 0)
          }
        } catch (e) {}
      }
    }

    var viewportUpdateTimer = null
    var focusRetryCount = 0
    var maxFocusRetries = 15

    function updateViewportWithRetry() {
      if (focusRetryCount >= maxFocusRetries) {
        focusRetryCount = 0
        return
      }
      focusRetryCount++
      applyViewportLayout()
      scrollToBottom()
      
      // Safari 需要持续更新直到键盘完全显示
      if (isSafari()) {
        viewportUpdateTimer = setTimeout(updateViewportWithRetry, focusRetryCount < 5 ? 100 : 300)
      }
    }

    input.addEventListener('focus', function () {
      if (!root.classList.contains('efx-chat-mobile')) return
      focusRetryCount = 0
      if (viewportUpdateTimer) {
        clearTimeout(viewportUpdateTimer)
        viewportUpdateTimer = null
      }
      
      // Force scroll to top to prevent Safari's automatic scrolling from messing up position:fixed calculations
      window.scrollTo(0, 0)
      document.body.scrollTop = 0

      // 立即更新一次
      applyViewportLayout()
      scrollToBottom()
      
      // Safari 需要多次延迟更新，因为键盘显示是渐进的
      if (isSafari()) {
        setTimeout(updateViewportWithRetry, 50)
        setTimeout(function() {
          // Manual scroll reset again as Safari often tries to auto-scroll on its own
          window.scrollTo(0, 0)
          applyViewportLayout()
        }, 300)
      } else {
        setTimeout(function () {
          applyViewportLayout()
          scrollToBottom()
        }, 30)
        setTimeout(function () {
          applyViewportLayout()
          scrollToBottom()
        }, 220)
      }
    })

    input.addEventListener('blur', function () {
      if (!root.classList.contains('efx-chat-mobile')) return
      focusRetryCount = 0
      if (viewportUpdateTimer) {
        clearTimeout(viewportUpdateTimer)
        viewportUpdateTimer = null
      }
      setTimeout(function () {
        applyViewportLayout()
        // Reset scroll when keyboard is hidden
        window.scrollTo(0, 0)
      }, 80)
    })

    function openImagePreview(src) {
      var overlay = document.createElement('div')
      overlay.className = 'efx-chat-preview'

      var previewImg = document.createElement('img')
      previewImg.src = src
      previewImg.alt = 'preview'
      previewImg.draggable = false

      var closeBtn = document.createElement('button')
      closeBtn.type = 'button'
      closeBtn.className = 'efx-chat-preview-close'
      closeBtn.innerHTML = '&times;'

      overlay.appendChild(previewImg)
      overlay.appendChild(closeBtn)
      ;(document.documentElement || document.body).appendChild(overlay)

      var MIN_SCALE = 1
      var MAX_SCALE = 4
      var scale = 1
      var translateX = 0
      var translateY = 0
      var didDrag = false
      var isPointerDown = false
      var lastPointer = null
      var pinchStartDist = 0
      var pinchStartScale = 1
      var lastTapTime = 0
      var lastTapPoint = null

      function distance (t0, t1) {
        var dx = t0.clientX - t1.clientX
        var dy = t0.clientY - t1.clientY
        return Math.sqrt(dx * dx + dy * dy)
      }

      function setTransitionEnabled (enabled) {
        previewImg.style.transition = enabled ? 'transform .15s ease' : 'none'
      }

      function applyTransform () {
        // When at default scale and position, remove transform to let CSS handle centering
        if (scale === 1 && translateX === 0 && translateY === 0) {
          previewImg.style.transform = ''
        } else {
          previewImg.style.transform = 'translate(' + translateX + 'px, ' + translateY + 'px) scale(' + scale + ')'
        }
        previewImg.style.cursor = scale > 1 ? 'grab' : 'zoom-in'
      }

      function clampScale (value) {
        return Math.max(MIN_SCALE, Math.min(MAX_SCALE, value))
      }

      function zoomAtPoint (nextScale, pointX, pointY) {
        var cx = window.innerWidth / 2
        var cy = window.innerHeight / 2
        var px = pointX - cx
        var py = pointY - cy
        var imgX = (px - translateX) / scale
        var imgY = (py - translateY) / scale
        scale = clampScale(nextScale)
        if (scale <= 1) {
          scale = 1
          translateX = 0
          translateY = 0
        } else {
          translateX = px - imgX * scale
          translateY = py - imgY * scale
        }
        applyTransform()
      }

      function toggleZoomAt (x, y) {
        setTransitionEnabled(true)
        if (scale > 1) {
          scale = 1
          translateX = 0
          translateY = 0
          applyTransform()
        } else {
          zoomAtPoint(2.5, x, y)
        }
      }

      function closePreview () {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        overlay.remove()
      }

      function onWheel (e) {
        e.preventDefault()
        setTransitionEnabled(true)
        var delta = e.deltaY < 0 ? 0.25 : -0.25
        zoomAtPoint(scale + delta, e.clientX, e.clientY)
      }

      function onMouseDown (e) {
        if (scale <= 1) return
        isPointerDown = true
        didDrag = false
        setTransitionEnabled(false)
        lastPointer = { x: e.clientX, y: e.clientY }
        e.preventDefault()
      }

      function onMouseMove (e) {
        if (!isPointerDown) return
        var dx = e.clientX - lastPointer.x
        var dy = e.clientY - lastPointer.y
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didDrag = true
        translateX += dx
        translateY += dy
        lastPointer = { x: e.clientX, y: e.clientY }
        applyTransform()
      }

      function onMouseUp () {
        isPointerDown = false
      }

      overlay.addEventListener('wheel', onWheel, { passive: false })
      overlay.addEventListener('mousedown', onMouseDown)
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)

      overlay.addEventListener('dblclick', function (e) {
        e.preventDefault()
        toggleZoomAt(e.clientX, e.clientY)
      })

      overlay.addEventListener('click', function (e) {
        if (didDrag) { didDrag = false; return }
        if (e.target === closeBtn) return
        if (e.target === previewImg && scale > 1) return
        closePreview()
      })

      closeBtn.addEventListener('click', function (e) {
        e.preventDefault()
        closePreview()
      })

      overlay.addEventListener('touchstart', function (e) {
        didDrag = false
        setTransitionEnabled(false)
        if (e.touches.length === 2) {
          pinchStartDist = distance(e.touches[0], e.touches[1])
          pinchStartScale = scale
        } else if (e.touches.length === 1) {
          var now = Date.now()
          var point = { x: e.touches[0].clientX, y: e.touches[0].clientY }
          if (now - lastTapTime < 300 && lastTapPoint && Math.abs(point.x - lastTapPoint.x) < 30 && Math.abs(point.y - lastTapPoint.y) < 30) {
            toggleZoomAt(point.x, point.y)
            lastTapTime = 0
            lastTapPoint = null
          } else {
            lastTapTime = now
            lastTapPoint = point
          }
          lastPointer = point
          isPointerDown = true
        }
      }, { passive: true })

      overlay.addEventListener('touchmove', function (e) {
        if (e.touches.length === 2) {
          e.preventDefault()
          var dist = distance(e.touches[0], e.touches[1])
          if (pinchStartDist > 0) {
            var mid = {
              x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
              y: (e.touches[0].clientY + e.touches[1].clientY) / 2
            }
            zoomAtPoint(pinchStartScale * (dist / pinchStartDist), mid.x, mid.y)
            didDrag = true
          }
        } else if (e.touches.length === 1 && isPointerDown) {
          if (scale <= 1) return
          e.preventDefault()
          var point = { x: e.touches[0].clientX, y: e.touches[0].clientY }
          var dx = point.x - lastPointer.x
          var dy = point.y - lastPointer.y
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didDrag = true
          translateX += dx
          translateY += dy
          lastPointer = point
          applyTransform()
        }
      }, { passive: false })

      overlay.addEventListener('touchend', function (e) {
        if (e.touches.length === 0) {
          isPointerDown = false
          pinchStartDist = 0
        }
      })

      applyTransform()
    }

    function appendMessage(msg, prepend) {
      if (!msg) return
      if (msg.messageId && state.messageIdSet[msg.messageId]) return
      if (msg.messageId) state.messageIdSet[msg.messageId] = true

      if (prepend) {
        state.messages.unshift(msg)
      } else {
        state.messages.push(msg)
      }

      var item = document.createElement('div')
      item.className = 'efx-chat-message ' + (msg.senderType === 'agent' ? 'agent' : 'visitor')
      if (msg.senderId === 'system' && msg.messageId && msg.messageId.indexOf('welcome-') === 0) {
        item.className += ' welcome'
      }

      if (msg.type === 'image' && msg.imageUrl) {
        var img = document.createElement('img')
        img.className = 'efx-chat-image'
        img.src = withVisitorToken(apiUrl + msg.imageUrl)
        img.alt = 'image'
        img.addEventListener('load', function () {
          if (state.open) {
            scrollToBottom()
          }
        })
        img.addEventListener('click', function () {
          openImagePreview(withVisitorToken(apiUrl + msg.imageUrl))
        })
        item.appendChild(img)
      } else {
        item.innerHTML = linkify(msg.content || '')
      }

      if (prepend) {
        msgList.insertBefore(item, msgList.firstChild)
      } else {
        msgList.appendChild(item)
      }
    }

    function renderHistory(messages, prepend) {
      if (!Array.isArray(messages) || !messages.length) return
      if (prepend) {
        for (var i = messages.length - 1; i >= 0; i -= 1) {
          appendMessage(messages[i], true)
        }
      } else {
        msgList.innerHTML = ''
        state.messageIdSet = {}
        state.messages = []
        for (var j = 0; j < messages.length; j += 1) {
          appendMessage(messages[j], false)
        }
      }
      scrollToBottom()
    }

    // Without `force`, a recent result for the same token is reused (no request at all). Reconnect trouble and
    // `auth-failed` pass force=true to get a fresh identity from the server.
    function authVisitor(force) {
      if (!force) {
        var cached = readAuthCache()
        if (cached) {
          state.visitorId = String(cached.visitorId)
          state.visitorName = String(cached.visitorName || state.visitorName)
          state.roomId = String(cached.roomId || '')
          return Promise.resolve()
        }
      }

      var headers = { 'Content-Type': 'application/json' }
      var authToken = (state.visitorToken || '').trim()
      if (authToken) headers['x-visitor-token'] = authToken

      return fetch(apiUrl + '/api/visitor-auth', {
        method: 'POST',
        credentials: 'include',
        headers: headers,
        body: JSON.stringify({
          visitorId: state.visitorId || undefined,
          visitorToken: authToken || undefined
        })
      })
        .then(function (res) {
          if (!res.ok) throw new Error('visitor-auth failed')
          return res.json()
        })
        .then(function (payload) {
          if (!payload) throw new Error('visitor-auth empty payload')

          state.visitorId = String(payload.visitorId || state.visitorId || '')
          state.visitorName = String(payload.visitorName || state.visitorName || text(lang, 'visitorPrefix'))
          state.roomId = String(payload.roomId || '')

          if (payload.visitorToken) {
            state.visitorToken = String(payload.visitorToken)
          }

          if (!state.roomId) {
            try { localStorage.removeItem(hasRoomKey) } catch (err) {}
          }
          writeAuthCache()

          sessionStorage.setItem(visitorStorageKey, state.visitorId)
          sessionStorage.setItem(tokenStorageKey, state.visitorToken || '')
          persistSessionData()
        })
    }

    function loadHistory(before) {
      if (!state.isAuthReady || !state.roomId) return Promise.resolve()
      if (before && (state.isLoadingMore || !state.hasMore)) return Promise.resolve()
      state.isLoadingMore = !!before

      var loading = document.createElement('div')
      loading.className = 'efx-chat-loading'
      loading.textContent = text(lang, 'loadingMore')
      if (before) msgList.insertBefore(loading, msgList.firstChild)

      var url = apiUrl + '/api/history/' + state.roomId + '?limit=20'
      if (before) url += '&before=' + encodeURIComponent(before)

      return fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: visitorHeaders()
      })
        .then(function (res) {
          if (!res.ok) throw new Error('history failed ' + res.status)
          return res.json()
        })
        .then(function (data) {
          var rows = (data && data.messages) || []
          if (rows.length < 20) state.hasMore = false
          if (before) {
            var prevHeight = msgList.scrollHeight
            renderHistory(rows, true)
            msgList.scrollTop = msgList.scrollHeight - prevHeight
          } else {
            renderHistory(rows, false)
          }
        })
        .catch(function (err) {
          console.error('[' + SCRIPT_NAME + '] load history failed:', err)
        })
        .finally(function () {
          state.isLoadingMore = false
          if (loading.parentNode) loading.parentNode.removeChild(loading)
        })
    }

    function fetchLatestHistoryForFallback() {
      if (!state.isAuthReady || !state.roomId) return Promise.resolve()

      var url = apiUrl + '/api/history/' + state.roomId + '?limit=20'
      return fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: visitorHeaders()
      })
        .then(function (res) {
          if (!res.ok) throw new Error('history fallback failed ' + res.status)
          return res.json()
        })
        .then(function (data) {
          var rows = (data && data.messages) || []
          if (!rows.length) return

          var hasMissedMessage = false
          var newAgentCount = 0
          rows.forEach(function (msg) {
            if (!msg) return
            if (msg.messageId && state.messageIdSet[msg.messageId]) return
            hasMissedMessage = true
            if (!state.open && msg.senderType === 'agent') {
              newAgentCount += 1
            }
          })

          if (!hasMissedMessage) return

          // If polling confirms missed messages, reset viewport to latest 20 rows
          // so we never keep a gap in the middle of the visible timeline.
          renderHistory(rows, false)

          if (newAgentCount > 0) {
            state.unreadCount += newAgentCount
            updateUnread()
          }

          if (state.open) {
            scrollToBottom()
            if (state.socket && state.roomId) {
              state.socket.emit('mark-read', state.roomId)
            }
          }
        })
        .catch(function (err) {
          console.warn('[' + SCRIPT_NAME + '] fallback history poll failed:', err.message || err)
        })
    }

    function ensureSocketConnected(reason) {
      if (!state.socket || state.socket.connected) return
      try {
        console.warn('[' + SCRIPT_NAME + '] reconnect socket (' + reason + ')')
        state.socket.auth = state.visitorToken ? { visitorToken: state.visitorToken } : undefined
        state.socket.connect()
      } catch (err) {
        console.warn('[' + SCRIPT_NAME + '] socket reconnect failed:', err.message || err)
      }
    }

    function stopFallbackPolling() {
      if (!fallbackPollTimer) return
      clearInterval(fallbackPollTimer)
      fallbackPollTimer = null
    }

    // Safety net only: runs while the socket is down, never in a background tab. Once the socket is back,
    // a single catch-up fetch (see the `connect` handler) replaces the polling.
    function startFallbackPolling() {
      if (fallbackPollTimer) return
      fallbackPollTimer = setInterval(function () {
        if (state.socket && state.socket.connected) {
          stopFallbackPolling()
          return
        }
        if (document.hidden) return
        fetchLatestHistoryForFallback()
      }, FALLBACK_POLL_INTERVAL_MS)
    }

    function stopBootstrapRetry() {
      if (!state.bootstrapRetryTimer) return
      clearTimeout(state.bootstrapRetryTimer)
      state.bootstrapRetryTimer = null
    }

    function scheduleBootstrapRetry() {
      if (state.bootstrapRetryTimer) return
      state.bootstrapRetryTimer = setTimeout(function () {
        state.bootstrapRetryTimer = null
        bootstrapConnection()
      }, 3000)
    }

    function bootstrapConnection() {
      if (state.bootstrapInProgress) return Promise.resolve()
      state.bootstrapInProgress = true

      startReconnectTipAnimation()
      updateComposerInteractivity()

      return authVisitor()
        .then(function () {
          state.isAuthReady = true
          updateComposerInteractivity()
          bindPageChangeTracking()
          return loadSocketClient()
        })
        .then(function () {
          if (!state.socket) {
            connectSocket()
          } else if (!state.socket.connected) {
            ensureSocketConnected('bootstrap')
          }

          return loadHistory().then(function () {
            stopBootstrapRetry()
          })
        })
        .catch(function (err) {
          console.warn('[' + SCRIPT_NAME + '] bootstrap failed, retrying:', err && err.message ? err.message : err)
          state.isAuthReady = false
          updateComposerInteractivity()
          startReconnectTipAnimation()
          scheduleBootstrapRetry()
        })
        .finally(function () {
          state.bootstrapInProgress = false
        })
    }

    function startBootstrap() {
      if (state.bootstrapRequested) return
      state.bootstrapRequested = true
      bootstrapConnection()
    }

    function sendVisitorJoin() {
      if (!state.socket) return
      state.socket.emit('visitor-join', {
        visitorId: state.visitorId,
        visitorName: state.visitorName,
        roomId: state.roomId,
        currentPage: state.currentPage,
        lang: lang,
        visitorToken: state.visitorToken || undefined
      })
    }

    function connectSocket() {
      if (!window.__EFX_CHAT_IO__) {
        console.error('[' + SCRIPT_NAME + '] realtime client not loaded')
        return
      }

      // Native WebSocket client (shared/rt-client.js). Credentials travel in the visitor-join payload.
      state.socket = window.__EFX_CHAT_IO__(apiUrl, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 8000,
        timeout: 12000
      })

      updateComposerInteractivity()
      startReconnectTipAnimation()

      state.socket.on('version-check', function (serverVersion) {
        var localVersion = localStorage.getItem('embed_app_version')
        console.log('[' + SCRIPT_NAME + '] Version check: local=' + localVersion + ', server=' + serverVersion)
        if (compareVersions(serverVersion, localVersion) > 0) {
          // Remember the new version: emloader.js requests embed.min.js?v=<version>, so the next page view of the
          // host site loads the new widget. The host page itself is never reloaded (that would throw away
          // whatever the visitor is typing on the host site, e.g. a checkout form).
          console.log('[' + SCRIPT_NAME + '] New embed version detected, it will be used on the next page load.')
          localStorage.setItem('embed_app_version', serverVersion)
        } else {
          localStorage.setItem('embed_app_version', serverVersion)
        }
      })

      state.socket.on('new-message', function (data) {
        if (!data) return
        appendMessage(data, false)
        if (!state.open && data.senderType === 'agent') {
          state.unreadCount += 1
          updateUnread()
        }
        if (state.open) scrollToBottom()
      })

      state.socket.on('connect', function () {
        var isReconnect = state.hasConnectedOnce
        state.hasConnectedOnce = true
        handleConnectedState()
        syncCurrentPage(false)
        sendVisitorJoin()
        // Messages pushed while the socket was down are not replayed: fetch them once (the first connect already
        // loads the history through bootstrapConnection).
        if (isReconnect) fetchLatestHistoryForFallback()
      })

      // The server could not tie this connection to the claimed visitor id (expired token, cookie / token mismatch):
      // refresh the identity through /visitor-auth and join again instead of sitting unauthenticated.
      state.socket.on('auth-failed', function () {
        if (Date.now() - (state.lastAuthFailedAt || 0) < 5000) return
        state.lastAuthFailedAt = Date.now()
        authVisitor(true)
          .then(function () {
            if (state.socket && state.socket.connected) sendVisitorJoin()
          })
          .catch(function (err) {
            console.warn('[' + SCRIPT_NAME + '] re-auth after auth-failed failed:', err && err.message ? err.message : err)
          })
      })

      state.socket.on('disconnect', function (reason) {
        handleDisconnectedState(reason || 'disconnect')
      })

      state.socket.on('connect_error', function (err) {
        var errorMessage = err && err.message ? String(err.message) : ''
        console.warn('[' + SCRIPT_NAME + '] socket connect error:', errorMessage || err)
        state.connectErrorCount += 1
        handleDisconnectedState('connect_error')

        // If websocket transport repeatedly fails after backend restart,
        // rebuild socket and force polling-first handshakes.
        if (state.connectErrorCount >= 3 && /websocket|transport|502|503/i.test(errorMessage)) {
          recreateSocketConnection()
        }
      })
    }

    function sendTextMessage() {
      var content = (input.value || '').trim()
      if (!content || !state.socket) return

      if (!state.socket.connected) {
        ensureSocketConnected('send-message')
        handleOfflineSendAttempt()
        return
      }

      var ackHandled = false
      var ackTimer = setTimeout(function () {
        if (ackHandled) return
        ackHandled = true
        handleOfflineSendAttempt()
      }, 10000)

      state.socket.emit('send-message', {
        roomId: state.roomId,
        senderType: 'visitor',
        senderId: state.visitorId,
        senderName: state.visitorName,
        content: content,
        type: 'text',
        timestamp: new Date().toISOString()
      }, function (ack) {
        if (ackHandled) return
        ackHandled = true
        clearTimeout(ackTimer)

        if (!ack || ack.success !== true) {
          if (ack && ack.code === 'ROOM_CREATE_FAILED') {
            appendServiceErrorMessage()
          } else {
            appendServiceErrorMessage(text(lang, 'cannotSendWhileOffline'))
          }
          return
        }

        input.value = ''
        clearDraft()
        input.focus()

        if (ack.roomId && ack.roomId !== state.roomId) {
          state.roomId = String(ack.roomId)
          persistSessionData()
        }
      })
    }

    function uploadImage(file) {
      if (!file || state.uploadInProgress) return
      if (!state.socket || !state.socket.connected) {
        ensureSocketConnected('send-image')
        handleOfflineSendAttempt()
        return
      }

      state.uploadInProgress = true
      setUploadProgress(0, 'compressing')

      // Compress image before upload
      loadCompressor()
        .then(function () {
          return new Promise(function (resolve, reject) {
            // Skip compression for small files (< 200KB)
            if (file.size < 200 * 1024) {
              resolve(file)
              return
            }

            if (!window.Compressor) {
              resolve(file)
              return
            }

            new window.Compressor(file, {
              quality: 0.8,
              maxWidth: 1920,
              maxHeight: 1920,
              mimeType: 'image/jpeg',
              convertSize: 1000000,
              success: function (compressedBlob) {
                console.log('[' + SCRIPT_NAME + '] Image compressed: ' + Math.round(file.size / 1024) + 'KB -> ' + Math.round(compressedBlob.size / 1024) + 'KB')
                // Convert Blob to File to preserve filename
                var compressedFile = new File([compressedBlob], file.name || 'image.jpg', {
                  type: compressedBlob.type || 'image/jpeg',
                  lastModified: Date.now()
                })
                resolve(compressedFile)
              },
              error: function (err) {
                console.warn('[' + SCRIPT_NAME + '] Compression failed, using original:', err.message || err)
                resolve(file)
              }
            })
          })
        })
        .catch(function (err) {
          console.warn('[' + SCRIPT_NAME + '] loadCompressor failed:', err)
          return Promise.resolve(file)
        })
        .then(function (fileToUpload) {
          // Now upload the file (compressed or original)
          console.log('[' + SCRIPT_NAME + '] Uploading file:', fileToUpload.name, 'size:', Math.round(fileToUpload.size / 1024) + 'KB', 'type:', fileToUpload.type)
          
          var fd = new FormData()
          fd.append('image', fileToUpload)
          fd.append('roomId', state.roomId)

          function uploadWithProgress(formData) {
            return new Promise(function (resolve, reject) {
              var xhr = new XMLHttpRequest()
              xhr.open('POST', apiUrl + '/api/upload', true)
              xhr.withCredentials = true

              var token = (state.visitorToken || '').trim()
              if (token) {
                xhr.setRequestHeader('x-visitor-token', token)
              }

              xhr.upload.onprogress = function (evt) {
                if (!evt || !evt.lengthComputable || !evt.total) return
                setUploadProgress((evt.loaded / evt.total) * 100, 'uploading')
              }

              xhr.onerror = function () {
                reject(new Error('upload failed'))
              }

              xhr.onreadystatechange = function () {
                if (xhr.readyState !== 4) return

                var payload = {}
                if (xhr.responseText) {
                  try {
                    payload = JSON.parse(xhr.responseText)
                  } catch (err) {
                    payload = {}
                  }
                }

                if (xhr.status >= 200 && xhr.status < 300) {
                  setUploadProgress(100, 'uploading')
                  resolve(payload)
                  return
                }

                console.error('[' + SCRIPT_NAME + '] Upload failed with status:', xhr.status, 'response:', xhr.responseText)
                var error = new Error('upload failed')
                error.code = payload && payload.code ? String(payload.code) : ''
                error.status = xhr.status
                reject(error)
              }

              xhr.send(formData)
            })
          }

          return uploadWithProgress(fd)
        })
        .then(function (data) {
          console.log('[' + SCRIPT_NAME + '] Upload response:', data)
          
          if (!state.socket) {
            console.error('[' + SCRIPT_NAME + '] Socket not available')
            hideUploadProgress()
            state.uploadInProgress = false
            window.alert(text(lang, 'imageSendFailed'))
            return
          }
          
          if (!data || !data.url) {
            console.error('[' + SCRIPT_NAME + '] Upload response missing URL')
            hideUploadProgress()
            state.uploadInProgress = false
            window.alert(text(lang, 'imageSendFailed'))
            return
          }

          if (!state.socket.connected) {
            handleOfflineSendAttempt()
            hideUploadProgress()
            state.uploadInProgress = false
            return
          }
          
          if (data && data.roomId) {
            state.roomId = String(data.roomId)
            persistSessionData()
          }

          state.socket.emit('send-message', {
            roomId: state.roomId,
            senderType: 'visitor',
            senderId: state.visitorId,
            senderName: state.visitorName,
            type: 'image',
            imageUrl: data.url,
            timestamp: new Date().toISOString()
          }, function (ack) {
            console.log('[' + SCRIPT_NAME + '] send-message ack:', ack)
            
            if (!ack || ack.success !== true) {
              console.error('[' + SCRIPT_NAME + '] send-message failed:', ack)
              if (ack && ack.code === 'ROOM_CREATE_FAILED') {
                appendServiceErrorMessage()
              }
              hideUploadProgress()
              state.uploadInProgress = false
              window.alert(text(lang, 'imageSendFailed'))
              return
            }
            if (ack.roomId && ack.roomId !== state.roomId) {
              state.roomId = String(ack.roomId)
              persistSessionData()
            }
            hideUploadProgress()
            state.uploadInProgress = false
          })
        })
        .catch(function (err) {
          console.error('[' + SCRIPT_NAME + '] upload failed:', err)
          hideUploadProgress()
          state.uploadInProgress = false
          if (err && err.code === 'ROOM_CREATE_FAILED') {
            appendServiceErrorMessage()
            return
          }
          window.alert(text(lang, 'imageSendFailed'))
        })
    }

    launcher.addEventListener('click', function () {
      setOpen(true)
    })

    closeBtn.addEventListener('click', function () {
      setOpen(false)
    })

    form.addEventListener('submit', function (e) {
      e.preventDefault()
      sendTextMessage()
    })

    input.addEventListener('input', function () {
      saveDraft(input.value)
    })

    fileInput.addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0]
      uploadImage(file)
      e.target.value = ''
    })

    msgList.addEventListener('scroll', function () {
      if (msgList.scrollTop > 30 || !state.messages.length) return
      var first = state.messages[0]
      if (!first || !first.timestamp) return
      loadHistory(first.timestamp)
    })

    // Lazy: visitors without a room cost nothing until they open the launcher (see setOpen).
    if (readHasRoomFlag()) startBootstrap()
  }

  function init() {
    loadConfig().then(function (config) {
      if (!config.enabled) {
        console.warn('[' + SCRIPT_NAME + '] disabled by config')
        return
      }

      initWidget(config)
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()