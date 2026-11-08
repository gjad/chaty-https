<template>
  <div class="room-list">
    <header>
      <div class="header-left">
        <h3>待处理咨询 ({{ socketState.activeRoomCount }})</h3>
        <span v-if="socketState.totalUnreadCount > 0" class="total-unread-badge">{{ socketState.totalUnreadCount }}</span>
      </div>
      <div class="header-actions">
        <button @click="openAuditModal" class="change-password-btn">日志</button>
        <button @click="openChangePasswordModal" class="change-password-btn">改密</button>
        <button @click="logout" class="logout-btn">退出</button>
      </div>
    </header>
    <div v-if="socketState.rooms.length === 0" class="no-rooms">目前没有新的咨询</div>
    <ul>
      <li v-for="room in socketState.rooms" :key="room.roomId" @click="joinRoom(room.roomId)" :class="{ 'room-active': room.status === 'active' }">
        <div class="room-info">
          <div class="room-top">
            <span class="visitor-name">{{ room.visitorName }}</span>
            <span class="last-time" v-if="room.lastTimestamp">{{ formatTime(room.lastTimestamp) }}</span>
          </div>
          <div class="room-bottom">
            <div class="last-msg-preview" v-if="room.lastMessage">
              <span class="last-sender" v-if="room.lastSenderName">{{ room.lastSenderName }}: </span>
              {{ room.lastMessage }}
            </div>
            <div class="last-msg-preview" v-else>暂无消息</div>
            <span v-if="room.unreadCount > 0" class="badge">{{ room.unreadCount }}</span>
          </div>
        </div>
      </li>
    </ul>

    <div v-if="auditVisible" class="modal-overlay" @click.self="auditVisible = false">
      <div class="modal-card audit-card">
        <h4>操作日志</h4>
        <p v-if="auditError" class="modal-error">{{ auditError }}</p>
        <p v-else-if="auditLoading" class="audit-hint">加载中...</p>
        <p v-else-if="auditRows.length === 0" class="audit-hint">暂无日志</p>
        <div v-else class="audit-list">
          <div v-for="row in auditRows" :key="row.id" class="audit-item">
            <div class="audit-line">
              <span class="audit-action">{{ actionLabel(row.action) }}</span>
              <span :class="row.result === 'ok' ? 'audit-ok' : 'audit-fail'">{{ row.result === 'ok' ? '成功' : '失败' }}</span>
              <span class="audit-time">{{ formatFullTime(row.ts) }}</span>
            </div>
            <div class="audit-meta">
              {{ actorLabel(row) }}<template v-if="row.ip"> · {{ row.ip }}<template v-if="row.country"> ({{ row.country }})</template></template>
              <template v-if="row.target"> · {{ row.target }}</template>
              <template v-if="row.detail"> · {{ row.detail }}</template>
            </div>
          </div>
        </div>
        <div class="audit-pager">
          <button type="button" class="cancel-btn" :disabled="auditPage <= 1 || auditLoading" @click="loadAudit(auditPage - 1)">上一页</button>
          <span>第 {{ auditPage }} / {{ auditMaxPages }} 页</span>
          <button type="button" class="cancel-btn" :disabled="!auditHasMore || auditLoading" @click="loadAudit(auditPage + 1)">下一页</button>
        </div>
        <p class="audit-hint">仅显示最新 {{ auditMaxPages * 100 }} 条，更早的记录请由管理员在 Cloudflare 查询。</p>
        <div class="modal-actions">
          <button type="button" class="cancel-btn" @click="auditVisible = false">关闭</button>
        </div>
      </div>
    </div>

    <div v-if="changePasswordVisible" class="modal-overlay" @click.self="closeChangePasswordModal">
      <div class="modal-card">
        <h4>修改密码</h4>
        <form @submit.prevent="submitChangePassword">
          <input v-model="currentPassword" type="password" placeholder="当前密码" autocomplete="current-password" required />
          <input v-model="newPassword" type="password" placeholder="新密码" autocomplete="new-password" required />
          <input v-model="confirmPassword" type="password" placeholder="确认新密码" autocomplete="new-password" required />
          <p v-if="changePasswordError" class="modal-error">{{ changePasswordError }}</p>
          <div class="modal-actions">
            <button type="button" class="cancel-btn" @click="closeChangePasswordModal">取消</button>
            <button type="submit" class="confirm-btn" :disabled="changePasswordLoading">
              {{ changePasswordLoading ? '提交中...' : '确认修改' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import socket, { socketState } from '../socket';
import axios from 'axios';

const router = useRouter();
const changePasswordVisible = ref(false);
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const changePasswordError = ref('');
const changePasswordLoading = ref(false);

const auditVisible = ref(false);
const auditRows = ref([]);
const auditPage = ref(1);
const auditMaxPages = ref(5);
const auditHasMore = ref(false);
const auditLoading = ref(false);
const auditError = ref('');

const ACTION_LABELS = {
  login: '登录',
  logout: '退出登录',
  change_password: '修改密码',
  kb_update: '修改知识库',
  admin_create_agent: '管理员创建客服',
  admin_import: '管理员导入数据',
  admin_put_file: '管理员写入文件'
};
const actionLabel = (action) => ACTION_LABELS[action] || action;
const actorLabel = (row) => row.actorName || (row.actorType === 'admin' ? '管理员' : row.actorId || '系统');
const formatFullTime = (ts) => (ts ? new Date(ts).toLocaleString([], { hour12: false }) : '');

const loadAudit = async (page) => {
  auditLoading.value = true;
  auditError.value = '';
  try {
    const sessionId = localStorage.getItem('sessionId');
    const { data } = await axios.get(`${window.location.origin}/api/audit-log`, {
      params: { page },
      withCredentials: true,
      headers: sessionId ? { 'x-session-id': sessionId } : undefined
    });
    auditRows.value = data.rows || [];
    auditPage.value = data.page || page;
    auditMaxPages.value = data.maxPages || 5;
    auditHasMore.value = !!data.hasMore;
  } catch (error) {
    auditError.value = error?.response?.data?.error || '日志加载失败，请稍后重试';
  } finally {
    auditLoading.value = false;
  }
};

const openAuditModal = () => {
  auditVisible.value = true;
  auditRows.value = [];
  loadAudit(1);
};

const formatTime = (ts) => {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

onMounted(() => {
  // Request latest room list after a short delay to ensure socket is authenticated
  setTimeout(() => {
    socket.emit('request-room-list');
  }, 100);
});

// Note: this view registers no socket listeners. socket.off(event) without a handler would remove the global
// listeners owned by socket.js (room-list, error, ...), so nothing is torn down on unmount.

const joinRoom = (roomId) => {
  router.push(`/chat/${roomId}`);
};

const openChangePasswordModal = () => {
  changePasswordVisible.value = true;
  changePasswordError.value = '';
  currentPassword.value = '';
  newPassword.value = '';
  confirmPassword.value = '';
};

const closeChangePasswordModal = () => {
  if (changePasswordLoading.value) return;
  changePasswordVisible.value = false;
  changePasswordError.value = '';
};

const submitChangePassword = async () => {
  if (newPassword.value !== confirmPassword.value) {
    changePasswordError.value = '两次输入的新密码不一致';
    return;
  }

  if (newPassword.value.length < 8) {
    changePasswordError.value = '新密码长度至少 8 位';
    return;
  }

  changePasswordLoading.value = true;
  changePasswordError.value = '';

  try {
    const API_URL = window.location.origin;
    const sessionId = localStorage.getItem('sessionId');
    await axios.post(
      `${API_URL}/api/change-password`,
      {
        currentPassword: currentPassword.value,
        newPassword: newPassword.value
      },
      {
        withCredentials: true,
        headers: sessionId ? { 'x-session-id': sessionId } : undefined
      }
    );

    changePasswordVisible.value = false;
    alert('密码修改成功');
  } catch (error) {
    changePasswordError.value = error?.response?.data?.error || '密码修改失败，请稍后重试';
  } finally {
    changePasswordLoading.value = false;
  }
};

const logout = async () => {
  try {
    const API_URL = window.location.origin;
    const sessionId = localStorage.getItem('sessionId');
    await axios.post(`${API_URL}/api/logout`, {}, {
      withCredentials: true,
      headers: sessionId ? { 'x-session-id': sessionId } : undefined
    });
  } catch (error) {
    console.warn('Server logout failed:', error?.response?.data || error.message);
  }

  localStorage.removeItem('agent');
  localStorage.removeItem('sessionId');
  socket.disconnect();
  router.push('/login');
};
</script>

<style scoped>
.room-list { 
  width: 100%;
  max-width: 100vw;
  margin: 0; 
  padding: 15px;
  overflow-x: hidden;
}

header { 
  display: flex; 
  justify-content: space-between; 
  align-items: center; 
  border-bottom: 2px solid #eee; 
  margin-bottom: 15px; 
  padding-bottom: 10px;
  flex-wrap: wrap;
  gap: 10px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.header-left { 
  display: flex; 
  align-items: center; 
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.header-left h3 {
  margin: 0;
  font-size: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.total-unread-badge {
  background: #ff4d4f;
  color: white;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: bold;
  flex-shrink: 0;
}

.no-rooms {
  text-align: center;
  color: #999;
  padding: 40px 20px;
  font-size: 14px;
}

ul { 
  list-style: none; 
  padding: 0;
  margin: 0;
  width: 100%;
}

li { 
  padding: 12px; 
  border: 1px solid #ddd; 
  border-radius: 8px; 
  margin-bottom: 10px; 
  cursor: pointer; 
  transition: background 0.2s;
  width: 100%;
}

li:hover { 
  background-color: #f5f5f5; 
}

li.room-active { 
  background-color: #fff0f6; 
  border-color: #ffadd2; 
}

li.room-active:hover { 
  background-color: #ffe7f0; 
}

.room-info { 
  display: flex; 
  flex-direction: column; 
  gap: 5px;
  width: 100%;
  min-width: 0;
}

.room-top { 
  display: flex; 
  justify-content: space-between; 
  align-items: center;
  gap: 10px;
}

.visitor-name { 
  font-weight: bold; 
  font-size: 16px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.last-time { 
  font-size: 12px; 
  color: #999;
  flex-shrink: 0;
  white-space: nowrap;
}

.room-bottom { 
  display: flex; 
  justify-content: space-between; 
  align-items: center;
  gap: 8px;
}

.last-msg-preview { 
  font-size: 13px; 
  color: #666; 
  white-space: nowrap; 
  overflow: hidden; 
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.last-sender { 
  color: #888; 
}

.badge { 
  background: #ff4d4f; 
  color: white; 
  padding: 2px 6px; 
  border-radius: 10px; 
  font-size: 11px; 
  min-width: 18px; 
  text-align: center;
  flex-shrink: 0;
}

.logout-btn { 
  color: #666; 
  background: none; 
  border: 1px solid #ccc; 
  padding: 6px 12px; 
  cursor: pointer;
  border-radius: 4px;
  font-size: 14px;
  flex-shrink: 0;
}

.change-password-btn {
  color: #0088cc;
  background: #f5fbff;
  border: 1px solid #bfe3f5;
  padding: 6px 12px;
  cursor: pointer;
  border-radius: 4px;
  font-size: 14px;
  flex-shrink: 0;
}

.change-password-btn:active {
  background-color: #e9f7ff;
}

.logout-btn:active {
  background-color: #f5f5f5;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  z-index: 1000;
}

.modal-card {
  width: 100%;
  max-width: 360px;
  background: #fff;
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
}

.modal-card h4 {
  margin: 0 0 16px;
  font-size: 18px;
  color: #333;
}

.modal-card form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-card input {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid #d9d9d9;
  border-radius: 8px;
  font-size: 14px;
}

.modal-card input:focus {
  outline: none;
  border-color: #0088cc;
  box-shadow: 0 0 0 3px rgba(0, 136, 204, 0.1);
}

.modal-error {
  margin: 0;
  color: #ff4d4f;
  font-size: 13px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.cancel-btn,
.confirm-btn {
  min-width: 88px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
  border: 1px solid transparent;
}

.cancel-btn {
  background: #f5f5f5;
  color: #666;
  border-color: #d9d9d9;
}

.confirm-btn {
  background: #0088cc;
  color: #fff;
}

.confirm-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.cancel-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.audit-card {
  max-width: 560px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.audit-list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.audit-item {
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
  cursor: default;
}

.audit-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.audit-action {
  font-weight: 600;
  color: #333;
}

.audit-ok {
  color: #52c41a;
  font-size: 12px;
}

.audit-fail {
  color: #ff4d4f;
  font-size: 12px;
}

.audit-time {
  margin-left: auto;
  color: #999;
  font-size: 12px;
}

.audit-meta {
  margin-top: 2px;
  color: #888;
  font-size: 12px;
  word-break: break-all;
}

.audit-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: #666;
}

.audit-pager .cancel-btn {
  min-width: 72px;
  padding: 6px 10px;
}

.audit-hint {
  margin: 8px 0;
  color: #999;
  font-size: 12px;
  text-align: center;
}

/* 移动端适配 */
@media screen and (max-width: 768px) {
  .room-list { 
    padding: 10px;
  }
  
  header {
    margin-bottom: 10px;
  }
  
  .header-left h3 {
    font-size: 16px;
  }
  
  li {
    padding: 10px;
  }
  
  .visitor-name {
    font-size: 15px;
  }
  
  .last-msg-preview {
    font-size: 12px;
  }
}

@media screen and (max-width: 480px) {
  .room-list {
    padding: 8px;
  }
  
  header {
    gap: 8px;
  }
  
  .header-left h3 {
    font-size: 15px;
  }
  
  .logout-btn {
    padding: 5px 10px;
    font-size: 13px;
  }

  .change-password-btn {
    padding: 5px 10px;
    font-size: 13px;
  }
}
</style>
