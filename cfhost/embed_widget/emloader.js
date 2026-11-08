;(function () {
  'use strict'

  var LOADER_NAME = 'csvc-chat-emloader'
  var DEFAULT_VERSION = '91'
  var STORAGE_KEY = 'embed_app_version'

  // Locate this loader script element to resolve the embed.js path from the same origin.
  var loaderEl = document.currentScript
  if (!loaderEl) {
    var scripts = document.getElementsByTagName('script')
    loaderEl = scripts[scripts.length - 1]
  }
  if (!loaderEl) return

  // Compare dotted numeric versions. Returns >0 if a>b, <0 if a<b, 0 if equal.
  function compareVersions (a, b) {
    var pa = String(a).split('.')
    var pb = String(b).split('.')
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i], 10) || 0
      var y = parseInt(pb[i], 10) || 0
      if (x !== y) return x > y ? 1 : -1
    }
    return 0
  }

  // Determine the version to load: the stored version (set by the server's version-check event) is only used when it
  // is newer than DEFAULT_VERSION, so a stale value left in localStorage can never pin visitors to an old build.
  var version = DEFAULT_VERSION
  try {
    var saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved != null && /\d/.test(String(saved)) && compareVersions(saved, DEFAULT_VERSION) > 0) {
      version = String(saved)
    }
  } catch (err) {
    console.warn('[' + LOADER_NAME + '] Unable to read stored version:', err)
  }

  // Resolve embed.js URL relative to this loader's origin.
  var embedUrl = '/embed.min.js'
  try {
    var loaderUrl = new URL(loaderEl.src, window.location.href)
    embedUrl = loaderUrl.origin + '/embed.min.js'
  } catch (err) {
    console.warn('[' + LOADER_NAME + '] Invalid loader src, falling back to relative path:', err)
  }

  var finalUrl = embedUrl + '?v=' + encodeURIComponent(version)
  console.log('[' + LOADER_NAME + '] Loading embed: ' + finalUrl)

  var s = document.createElement('script')
  s.charset = 'utf-8'
  s.src = finalUrl
  s.defer = true
  s.onerror = function () {
    console.error('[' + LOADER_NAME + '] Failed to load embed script: ' + finalUrl)
  }
  ;(document.head || document.documentElement).appendChild(s)
})()
