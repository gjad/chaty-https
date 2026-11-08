<template>
  <div class="login-container">
    <form @submit.prevent="handleLogin">
      <h2>客服登录</h2>
      <input v-model="username" type="text" placeholder="用户名" required />
      <input v-model="password" type="password" placeholder="密码" required />
      <div ref="turnstileEl" class="turnstile-box"></div>
      <p class="tip">登录后将永久保持，PC端和移动端各允许一个设备在线</p>
      <button type="submit" :disabled="loading || !turnstileToken">{{ loading ? '登录中...' : '登录' }}</button>
      <p v-if="error" class="error">{{ error }}</p>
    </form>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import axios from 'axios';
import { updateSocketToken } from '../socket';

const TURNSTILE_SITE_KEY = '0x4AAAAAADxRGZfDBSTtzIp7';
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);
const router = useRouter();
const turnstileEl = ref(null);
const turnstileToken = ref('');
let turnstileWidgetId = null;

const loadTurnstile = () => new Promise((resolve, reject) => {
  if (window.turnstile) return resolve(window.turnstile);
  let s = document.querySelector('script[data-turnstile]');
  if (!s) {
    s = document.createElement('script');
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.defer = true;
    s.dataset.turnstile = '1';
    document.head.appendChild(s);
  }
  s.addEventListener('load', () => resolve(window.turnstile));
  s.addEventListener('error', () => reject(new Error('turnstile load failed')));
});

const resetTurnstile = () => {
  turnstileToken.value = '';
  if (window.turnstile && turnstileWidgetId !== null) window.turnstile.reset(turnstileWidgetId);
};

onMounted(async () => {
  try {
    const ts = await loadTurnstile();
    turnstileWidgetId = ts.render(turnstileEl.value, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token) => { turnstileToken.value = token; },
      'expired-callback': () => { turnstileToken.value = ''; },
      'error-callback': () => { turnstileToken.value = ''; }
    });
  } catch (e) {
    error.value = '人机验证加载失败，请刷新页面重试';
  }
});

onBeforeUnmount(() => {
  if (window.turnstile && turnstileWidgetId !== null) window.turnstile.remove(turnstileWidgetId);
});

const handleLogin = async () => {
  loading.value = true;
  error.value = '';
  try {
    console.log('Login attempt from:', window.location.href);
    console.log('isPWA:', window.matchMedia('(display-mode: standalone)').matches);
    
    const API_URL = window.location.origin;
    const response = await axios.post(`${API_URL}/api/login`, {
      username: username.value,
      password: password.value,
      turnstileToken: turnstileToken.value
    }, {
      withCredentials: true // Enable cookies
    });
    
    localStorage.setItem('sessionId', response.data.sessionId);
    localStorage.setItem('agent', JSON.stringify(response.data.agent));
    updateSocketToken(response.data.sessionId);
    router.push('/rooms');
  } catch (err) {
    console.error('Login error:', err.response?.data || err.message);
    error.value = err.response?.data?.error || '登录失败，请检查用户名和密码';
    resetTurnstile();
  } finally {
    loading.value = false;
  }
};
</script>

<style scoped>
.login-container { 
  display: flex; 
  justify-content: center; 
  align-items: center; 
  min-height: 100vh;
  padding: 20px;
  width: 100%;
  overflow-x: hidden;
}

form { 
  display: flex; 
  flex-direction: column; 
  gap: 15px; 
  width: 100%;
  max-width: 400px;
  padding: 30px; 
  background: white;
  border: none;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.1);
}

form h2 {
  margin: 0 0 10px 0;
  text-align: center;
  color: #333;
  font-size: 24px;
}

input[type="text"], input[type="password"] { 
  padding: 14px 16px; 
  font-size: 16px;
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  width: 100%;
  transition: border-color 0.2s, box-shadow 0.2s;
  background: #fcfcfc;
  color: #333;
}

input[type="text"]:focus, input[type="password"]:focus {
  border-color: #0088cc;
  box-shadow: 0 0 0 3px rgba(0, 136, 204, 0.1);
  outline: none;
  background: white;
}

button { 
  padding: 14px; 
  background-color: #0088cc; 
  color: white; 
  border: none; 
  border-radius: 8px; 
  cursor: pointer;
  font-size: 16px;
  font-weight: 600;
  transition: background 0.2s, transform 0.1s;
  margin-top: 5px;
}

button:hover {
  background-color: #0077b3;
}

button:active {
  transform: translateY(1px);
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.turnstile-box {
  display: flex;
  justify-content: center;
  min-height: 65px;
}

.tip { 
  font-size: 13px; 
  color: #888; 
  margin: 5px 0; 
  text-align: center;
  line-height: 1.5;
}

.error { 
  color: #ff4d4f; 
  font-size: 14px;
  margin: 0;
  text-align: center;
  background: #fff2f0;
  padding: 10px;
  border-radius: 6px;
  border: 1px solid #ffccc7;
}

/* 移动端适配 */
@media screen and (max-width: 768px) {
  .login-container {
    padding: 20px;
    background: #f5f7fa;
    align-items: flex-start;
    padding-top: 15vh;
  }
  
  form {
    padding: 30px 20px;
    max-width: 100%;
    box-shadow: 0 4px 12px rgba(0,0,0,0.05);
  }
  
  input[type="text"], input[type="password"] {
    font-size: 16px; /* 防止iOS自动放大 */
    padding: 12px 14px;
  }
}

/* 处理小屏幕设备 */
@media screen and (max-height: 600px) {
  .login-container {
    padding-top: 10px;
    align-items: flex-start;
  }
}
</style>
