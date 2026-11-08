import { io } from './rt-client.js';
import { reactive } from 'vue';

export const socketState = reactive({
  totalUnreadCount: 0,
  activeRoomCount: 0,
  rooms: []
});

const NEW_MESSAGE_SOUND_SRC = '/sound/chat_coming.mp3';
const UNREAD_ALERT_SOUND_SRC = '/sound/chat_alart.mp3';
const UNREAD_ALERT_INTERVAL_MS = 10000;
const audioUnlockEvents = ['pointerdown', 'touchstart', 'keydown'];
let previousRoomSnapshot = new Map();
let hasInitializedRoomSnapshot = false;
let lastSoundAt = 0;
let unreadAlertTimer = null;

const newMessageAudio = typeof Audio !== 'undefined' ? new Audio(NEW_MESSAGE_SOUND_SRC) : null;
const unreadAlertAudio = typeof Audio !== 'undefined' ? new Audio(UNREAD_ALERT_SOUND_SRC) : null;
let isNewMessageAudioUnlocked = false;

if (newMessageAudio) {
  newMessageAudio.preload = 'auto';
}
if (unreadAlertAudio) {
  unreadAlertAudio.preload = 'auto';
}

const warmUpAudio = async (audio) => {
  if (!audio) return;
  const previousMuted = audio.muted;
  try {
    audio.muted = true;
    audio.currentTime = 0;
    await audio.play();
    audio.pause();
    audio.currentTime = 0;
    audio.muted = previousMuted;
  } catch (err) {
    audio.muted = previousMuted;
    console.debug('Failed to unlock audio', err);
    throw err;
  }
};

const unlockNewMessageAudio = async () => {
  if (isNewMessageAudioUnlocked) return;

  try {
    // Warm-up playback after user gesture to satisfy autoplay policy after refresh.
    await warmUpAudio(newMessageAudio);
    await warmUpAudio(unreadAlertAudio);
    isNewMessageAudioUnlocked = true;
  } catch (err) {
    console.debug('Failed to unlock new message audio', err);
  }
};

audioUnlockEvents.forEach((eventName) => {
  window.addEventListener(eventName, unlockNewMessageAudio, { once: true, passive: true });
});

const playUnreadAlertSound = () => {
  if (!unreadAlertAudio) return;
  unreadAlertAudio.currentTime = 0;
  unreadAlertAudio.play().catch((err) => {
    console.debug('Unread alert sound blocked by browser policy', err);
  });
};

const updateUnreadAlertLoop = () => {
  const hasUnread = socketState.totalUnreadCount > 0;

  if (hasUnread && !unreadAlertTimer) {
    // Wait one interval (5s) before first alert, then repeat every interval while unread remains.
    unreadAlertTimer = setInterval(() => {
      if (socketState.totalUnreadCount > 0) {
        playUnreadAlertSound();
      } else {
        clearInterval(unreadAlertTimer);
        unreadAlertTimer = null;
      }
    }, UNREAD_ALERT_INTERVAL_MS);
  } else if (!hasUnread && unreadAlertTimer) {
    clearInterval(unreadAlertTimer);
    unreadAlertTimer = null;
  }
};

const playGlobalNewMessageSound = () => {
  if (!newMessageAudio) return;

  const now = Date.now();
  // Throttle very close consecutive triggers from different socket events.
  if (now - lastSoundAt < 250) {
    return;
  }

  lastSoundAt = now;
  newMessageAudio.currentTime = 0;
  newMessageAudio.play().catch((err) => {
    console.debug('New message sound blocked by browser policy', err);
  });
};

const buildRoomSnapshot = (rooms) => {
  const snapshot = new Map();
  (Array.isArray(rooms) ? rooms : []).forEach((room) => {
    snapshot.set(room.roomId, {
      unreadCount: Number(room.unreadCount || 0),
      lastTimestamp: room.lastTimestamp || null,
      lastMessage: room.lastMessage || ''
    });
  });
  return snapshot;
};

const shouldPlaySoundForRoomListUpdate = (rooms) => {
  const nextSnapshot = buildRoomSnapshot(rooms);

  if (!hasInitializedRoomSnapshot) {
    previousRoomSnapshot = nextSnapshot;
    hasInitializedRoomSnapshot = true;
    return false;
  }

  for (const [roomId, room] of nextSnapshot.entries()) {
    const prev = previousRoomSnapshot.get(roomId);
    if (!prev) {
      if (room.unreadCount > 0) {
        previousRoomSnapshot = nextSnapshot;
        return true;
      }
      continue;
    }

    if (room.unreadCount > prev.unreadCount) {
      previousRoomSnapshot = nextSnapshot;
      return true;
    }
  }

  previousRoomSnapshot = nextSnapshot;
  return false;
};

// Same-origin API: in production a Worker route serves /api, /ws and /chatuploads on this host
// (see ../../plan.md); in dev the Vite proxy forwards them to `wrangler dev`.
const API_URL = window.location.origin;
const socket = io(API_URL, {
  withCredentials: true,
  autoConnect: false
});

socket.on('connect', () => {
  const sessionId = localStorage.getItem('sessionId');
  if (!sessionId) {
    // Nothing to log in with (e.g. on the login page): do not keep an unauthenticated socket open, the server
    // would close it after a few seconds and the reconnect loop would start over.
    socket.disconnect();
    return;
  }
  socket.emit('agent-login', { sessionId });
});

socket.on('connect_error', (err) => {
  if (err.message === 'Authentication error' || err.data === 'Authentication error') {
    localStorage.removeItem('agent');
    localStorage.removeItem('sessionId');
    window.location.href = '/login';
  }
});

socket.on('error', (err) => {
  if (err === 'Authentication error' || err === 'Invalid token') {
    localStorage.removeItem('agent');
    localStorage.removeItem('sessionId');
    window.location.href = '/login';
  }
});

socket.on('force-logout', (data) => {
  const currentSessionId = localStorage.getItem('sessionId');
  if (data?.sessionId) {
    if (!currentSessionId || data.sessionId !== currentSessionId) {
      console.log('Ignored stale force-logout for old session:', data.sessionId);
      return;
    }
  }

  alert(data.reason || '您的账号在另一台设备上登录，即将退出');
  
  // Clear all storage
  localStorage.removeItem('agent');
  localStorage.removeItem('sessionId');
  
  // Clear cookies with all possible variants to be sure
  const clearCookie = (name) => {
    document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;`;
    document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT; secure; samesite=lax`;
    document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT; secure; samesite=none`;
  };
  
  clearCookie('agent_token');
  clearCookie('agent_session');
  clearCookie('agent_info');
  
  window.location.href = '/login';
});

socket.on('room-list', (rooms) => {
  if (shouldPlaySoundForRoomListUpdate(rooms)) {
    playGlobalNewMessageSound();
  }

  socketState.rooms = rooms;
  socketState.totalUnreadCount = rooms.reduce((sum, room) => sum + (room.unreadCount || 0), 0);
  socketState.activeRoomCount = rooms.filter(r => r.status === 'active').length;

  updateUnreadAlertLoop();
});

socket.on('receive-message', (msg) => {
  if (msg?.senderType === 'visitor') {
    playGlobalNewMessageSound();
  }
});

socket.on('version-check', (serverVersion) => {
  const localVersion = localStorage.getItem('agent_app_version');
  if (localVersion && localVersion !== serverVersion) {
    console.log('New agent version detected, reloading...');
    localStorage.setItem('agent_app_version', serverVersion);
    setTimeout(() => {
      window.location.reload(true);
    }, 1000);
  } else {
    localStorage.setItem('agent_app_version', serverVersion);
  }
});

// Notify socket layer after login/session changes.
export const updateSocketToken = (sessionId) => {
  const sid = sessionId || localStorage.getItem('sessionId');
  if (!sid) {
    return;
  }
  if (socket.connected) {
    socket.emit('agent-login', { sessionId: sid });
  } else {
    socket.connect();
  }
};

export default socket;
