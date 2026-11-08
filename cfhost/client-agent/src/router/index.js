import { createRouter, createWebHistory } from 'vue-router';
import Login from '../views/Login.vue';
import RoomList from '../views/RoomList.vue';
import ChatRoom from '../views/ChatRoom.vue';
import axios from 'axios';
import { updateSocketToken } from '../socket';

const routes = [
  { path: '/', redirect: '/login' },
  { path: '/login', component: Login },
  { path: '/rooms', component: RoomList },
  { path: '/chat/:roomId', component: ChatRoom, props: true }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

// Helper function to restore session from cookie
async function restoreSession() {
  const sessionId = localStorage.getItem('sessionId');

  try {
    const API_URL = window.location.origin;
    const response = await axios.get(`${API_URL}/api/verify-token`, {
      withCredentials: true,
      headers: {
        'x-session-id': sessionId
      }
    });
    
    if (response.data.agent) {
      localStorage.setItem('agent', JSON.stringify(response.data.agent));
      if (response.data.sessionId) {
        localStorage.setItem('sessionId', response.data.sessionId);
        updateSocketToken(response.data.sessionId);
      }
      return true;
    }
  } catch (error) {
    console.log('Session verification failed, logging out...');
    localStorage.removeItem('agent');
    localStorage.removeItem('sessionId');
  }
  return false;
}

// Basic Navigation Guard
router.beforeEach(async (to) => {
  const isValid = await restoreSession();

  if (to.path === '/login' && isValid) {
    return '/rooms';
  }

  if (to.path !== '/login' && !isValid) {
    return '/login';
  }

  return true;
});

export default router;
