<template>
  <div class="chat-room" ref="chatRoomRef" :class="{ 'kb-open': showKnowledgeBase }">
    <header>
      <div class="header-row header-top-row">
        <div class="back-area">
          <button @click="goBack" class="back-btn">&lt; 返回</button>
          <span v-if="socketState.totalUnreadCount > 0" class="total-unread-badge">{{ socketState.totalUnreadCount }}</span>
        </div>
        <div v-if="safePageUrl" class="current-page">
          <a :href="safePageUrl" target="_blank" rel="noopener noreferrer">{{ safePageUrl }}</a>
        </div>
      </div>

      <div class="header-row header-bottom-row">
        <div class="header-info">
          <div class="title">{{ visitorName }}</div>
        </div>
        <div class="status-control">
          <button 
            @click="updateRoomStatus('active')" 
            :class="['status-btn', { active: roomStatus === 'active' }]"
          >服务中</button>
          <button 
            @click="updateRoomStatus('done')" 
            :class="['status-btn', { active: roomStatus === 'done' }]"
          >已完成</button>
        </div>
      </div>
    </header>
    
    <div class="message-container" ref="container" @scroll="handleMessageScroll">
      <div class="message-list">
        <div v-for="(msg, index) in messages" :key="index" :class="['message', msg.senderType]">
          <div class="content">
            <div class="msg-meta">
              <span class="sender-name">{{ msg.senderName || (msg.senderType === 'visitor' ? '访客' : '客服') }}</span>
              <span class="msg-time">{{ formatTime(msg.timestamp) }}</span>
            </div>
            <div class="bubble-row">
            <div class="bubble">
              <template v-if="msg.type === 'image'">
                <img :src="`${API_URL}${msg.imageUrl}`" class="chat-img" @load="handleMessageImageLoad(msg)" @click="viewFullImage(`${API_URL}${msg.imageUrl}`)" title="点击在新窗口查看大图" />
              </template>
              <template v-else>
                <span v-html="formatLinks(msg.content)"></span>
              </template>
            </div>
            <div v-if="msg.senderType === 'visitor' && msg.type !== 'image'" class="message-actions">
              <button
                class="copy-msg-btn"
                @click="copyMessage(msg.content, getMessageKey(msg, index))"
                :aria-label="copiedMessageIndex === getMessageKey(msg, index) ? '已复制' : '复制消息'"
              >
                {{ copiedMessageIndex === getMessageKey(msg, index) ? '已复制' : '复制' }}
              </button>
              <button
                class="translate-msg-btn"
                :disabled="getTranslationState(msg, index).status === 'loading'"
                @click="toggleTranslation(msg, index)"
                :aria-label="getTranslationButtonLabel(msg, index)"
              >
                {{ getTranslationButtonLabel(msg, index) }}
              </button>
            </div>
            </div>
            <div
              v-if="shouldShowTranslation(msg, index)"
              class="translation-panel"
            >
              <div class="translation-text">
                <span v-if="getTranslationState(msg, index).sourceLanguage" class="translation-lang">
                  {{ getTranslationState(msg, index).sourceLanguage }}
                </span>
                <span>
                  {{ getTranslationState(msg, index).translatedText || getTranslationState(msg, index).error }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showKnowledgeBase" class="knowledge-panel">
      <div class="knowledge-header">
        <strong>知识库</strong>
        <div class="knowledge-actions">
          <button class="ghost-btn" @click="addCategory">+ 一级分类</button>
          <button class="ghost-btn" @click="saveKnowledgeBase" :disabled="kbSaving">{{ kbSaving ? '保存中...' : '保存' }}</button>
          <button class="ghost-btn" @click="showKnowledgeBase = false">收起</button>
        </div>
      </div>

      <div class="knowledge-body">
        <div class="kb-tree">
          <div v-for="(category, cIndex) in knowledgeCategories" :key="`cat-${cIndex}`" class="kb-category">
            <div class="kb-category-row">
              <button class="kb-toggle" @click="category.expanded = !category.expanded">{{ category.expanded ? '▾' : '▸' }}</button>
              <input v-model="category.name" class="kb-category-input" placeholder="分类名" />
              <button class="mini-btn" @click="addItem(cIndex)">+ 内容</button>
              <button class="mini-btn danger" @click="removeCategory(cIndex)">删</button>
            </div>

            <div v-show="category.expanded" class="kb-item-list">
              <button
                v-for="(item, iIndex) in category.items"
                :key="`item-${cIndex}-${iIndex}`"
                :class="['kb-item-chip', { active: selectedCategoryIndex === cIndex && selectedItemIndex === iIndex }]"
                @click="selectItem(cIndex, iIndex)"
              >
                {{ item.title || '未命名内容' }}
              </button>
              <div v-if="category.items.length === 0" class="kb-empty-tip">暂无内容，点击“+ 内容”创建</div>
            </div>
          </div>
        </div>

        <div class="kb-editor" v-if="selectedItem">
          <div class="editor-row">
            <label>标题</label>
            <input v-model="selectedItem.title" placeholder="例如：退款规则" />
          </div>
          <div class="editor-row">
            <label>具体内容</label>
            <textarea v-model="selectedItem.content" rows="6" placeholder="点击左侧内容后，文本会自动预输入到聊天框"></textarea>
          </div>
          <div class="editor-actions">
            <button class="ghost-btn" @click="prefillSelectedItem">预输入到聊天框</button>
            <button class="ghost-btn danger" @click="removeSelectedItem">删除当前内容</button>
          </div>
        </div>
        <div v-else class="kb-editor-empty">先在左侧选择或新增一条具体内容</div>
      </div>
    </div>

    <div class="input-area" :class="{ 'kb-open': showKnowledgeBase }" :style="inputAreaStyle">
      <label class="upload-label" title="上传图片">
        <input type="file" accept="image/*" @change="handleImageUpload" style="display: none" />
        <svg viewBox="0 0 24 24" width="24" height="24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z" fill="#999"/></svg>
      </label>
      <div class="tool-stack">
        <button class="kb-entry-btn" @click="showKnowledgeBase = !showKnowledgeBase">wiki</button>
        <select v-model="outgoingLanguage" class="language-select" aria-label="发送语言选择器">
          <option value="">空</option>
          <option value="en">en</option>
          <option value="th">th</option>
          <option value="zh-Hant">zh-Hant</option>
        </select>
      </div>
      <div class="compose-area">
        <div v-if="outgoingLanguage && !showKnowledgeBase" class="outgoing-translation-panel">
          <div class="outgoing-translation-line">
            <span class="translation-lang">{{ outgoingTranslation.targetLanguage || outgoingLanguage }}</span>
            <span v-if="outgoingTranslation.status === 'loading'">正在翻译...</span>
            <span v-else-if="outgoingTranslation.status === 'error'">{{ outgoingTranslation.error }}</span>
            <span v-else>{{ outgoingTranslation.translatedText }}</span>
          </div>
        </div>
        <textarea
          ref="messageInputRef"
          v-model="input"
          class="chat-input"
          rows="3"
          maxlength="4000"
          placeholder="输入回复内容...（Enter 换行，Ctrl+Enter 发送）"
          @focus="handleInputFocus"
          @blur="handleInputBlur"
          @keydown.ctrl.enter.exact.prevent="sendMessage"
          @keydown.meta.enter.exact.prevent="sendMessage"
        ></textarea>
      </div>
      <button @click="sendMessage">发送</button>
    </div>

    <!-- 图片预览弹窗 -->
    <div v-if="previewUrl" class="image-modal" @click="closePreview">
      <div class="modal-wrapper">
        <button class="close-preview-btn" @click.stop="closePreview">&times;</button>
        <img :src="previewUrl" class="modal-content" @click.stop />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import socket, { socketState } from '../socket';
import axios from 'axios';
import Compressor from 'compressorjs';

const props = defineProps(['roomId']);
const router = useRouter();
const messages = ref([]);
const input = ref('');
const visitorName = ref('访客');
const currentPage = ref('');
// The page URL is supplied by the visitor's browser: only ever link http(s) URLs (never javascript: / data:).
const safePageUrl = computed(() => (/^https?:\/\//i.test(currentPage.value) ? currentPage.value : ''));
const roomStatus = ref('active');
const container = ref(null);
const previewUrl = ref(null);
const messageInputRef = ref(null);
const chatRoomRef = ref(null);
const agentInfo = JSON.parse(localStorage.getItem('agent') || '{}');
const API_URL = window.location.origin;
const showKnowledgeBase = ref(false);
const kbSaving = ref(false);
const knowledgeCategories = ref([]);
// Version of the knowledge base this editor was loaded from (the server rejects saves based on a stale one).
let knowledgeVersion;
const selectedCategoryIndex = ref(-1);
const selectedItemIndex = ref(-1);
const historyPageSize = 20;
const historyLoading = ref(false);
const historyHasMore = ref(true);
const keyboardOffset = ref(0);
const inputFocused = ref(false);
const copiedMessageIndex = ref(-1);
const translationState = ref({});
const outgoingLanguage = ref('');
const outgoingTranslation = ref({
  status: 'idle',
  translatedText: '',
  error: '',
  sourceLanguage: 'zh-Hans',
  targetLanguage: '',
  inputText: ''
});

let outgoingTranslationSeq = 0;
let outgoingTranslationTimer = null;
let restorePageScrollStyles = null;
let keyboardSyncRaf = 0;
let keyboardSyncTimer = null;
const IMAGE_COMPRESS_SKIP_SIZE = 200 * 1024;
const IMAGE_COMPRESS_CONVERT_SIZE = 1000 * 1000;

const getOutgoingLanguageStorageKey = (roomId = props.roomId) => {
  const agentId = agentInfo.agentId || 'anonymous';
  return `chat-agent-outgoing-language:${agentId}:${roomId || 'unknown-room'}`;
};

const loadOutgoingLanguagePreference = (roomId = props.roomId) => {
  try {
    const saved = localStorage.getItem(getOutgoingLanguageStorageKey(roomId)) || '';
    outgoingLanguage.value = saved;
  } catch (err) {
    console.error('Failed to load outgoing language preference', err);
    outgoingLanguage.value = '';
  }
};

const saveOutgoingLanguagePreference = (roomId = props.roomId, language = outgoingLanguage.value) => {
  try {
    const key = getOutgoingLanguageStorageKey(roomId);
    if (language) {
      localStorage.setItem(key, language);
    } else {
      localStorage.removeItem(key);
    }
  } catch (err) {
    console.error('Failed to save outgoing language preference', err);
  }
};

const inputAreaStyle = computed(() => ({
  '--keyboard-offset': `${keyboardOffset.value}px`
}));

const selectedItem = computed(() => {
  const category = knowledgeCategories.value[selectedCategoryIndex.value];
  if (!category) return null;
  return category.items[selectedItemIndex.value] || null;
});

const normalizeLanguageCode = (value) => {
  const code = String(value || '').trim();
  if (!code) return '';

  const lower = code.toLowerCase();
  if (['zh', 'zh-cn', 'zh-hans', 'zh-sg'].includes(lower)) return 'zh-Hans';
  if (['zh-tw', 'zh-hant', 'zh-hk', 'zh-mo'].includes(lower)) return 'zh-Hant';
  return code;
};

const mapToGoogleLanguage = (value) => {
  const code = String(value || '').trim();
  if (!code) return '';

  const lower = code.toLowerCase();
  if (['zh', 'zh-cn', 'zh-hans', 'zh-sg'].includes(lower)) return 'zh-CN';
  if (['zh-tw', 'zh-hant', 'zh-hk', 'zh-mo'].includes(lower)) return 'zh-TW';
  return code;
};

const googleTranslateText = async (text, targetLanguage) => {
  const trimmedText = String(text || '').trim();
  const mappedTarget = mapToGoogleLanguage(targetLanguage);

  if (!trimmedText || !mappedTarget) {
    throw new Error('Missing translation input');
  }

  const res = await axios.post(`${API_URL}/api/translate`, {
    q: trimmedText,
    source: 'auto',
    target: mappedTarget,
    format: 'text'
  }, {
    withCredentials: true
  });

  const translatedText = String(res.data?.translatedText || '').trim();
  const detectedSourceLanguage = normalizeLanguageCode(res.data?.detectedLanguage || 'auto') || 'auto';

  if (!translatedText) {
    throw new Error('Empty translation');
  }

  return {
    translatedText,
    detectedSourceLanguage
  };
};

const ensureKnowledgeShape = (categories) => {
  return (Array.isArray(categories) ? categories : []).map((category) => ({
    name: String(category?.name || '').trim(),
    expanded: true,
    items: (Array.isArray(category?.items) ? category.items : []).map((item) => ({
      title: String(item?.title || '').trim(),
      content: String(item?.content || '')
    }))
  }));
};

const loadKnowledgeBase = async () => {
  try {
    const res = await axios.get(`${API_URL}/api/knowledge-base`, { withCredentials: true });
    knowledgeCategories.value = ensureKnowledgeShape(res.data?.categories);
    knowledgeVersion = typeof res.data?.version === 'number' ? res.data.version : undefined;
  } catch (err) {
    console.error('Failed to load knowledge base', err);
    knowledgeCategories.value = [];
  }
};

const addCategory = () => {
  knowledgeCategories.value.push({
    name: '新分类',
    expanded: true,
    items: []
  });
};

const removeCategory = (categoryIndex) => {
  knowledgeCategories.value.splice(categoryIndex, 1);
  if (selectedCategoryIndex.value === categoryIndex) {
    selectedCategoryIndex.value = -1;
    selectedItemIndex.value = -1;
    return;
  }

  if (selectedCategoryIndex.value > categoryIndex) {
    selectedCategoryIndex.value -= 1;
  }
};

const addItem = (categoryIndex) => {
  const category = knowledgeCategories.value[categoryIndex];
  if (!category) return;

  category.expanded = true;
  category.items.push({
    title: '新内容',
    content: ''
  });
  selectItem(categoryIndex, category.items.length - 1);
};

const selectItem = async (categoryIndex, itemIndex) => {
  selectedCategoryIndex.value = categoryIndex;
  selectedItemIndex.value = itemIndex;
  await prefillSelectedItem();
};

const prefillSelectedItem = async () => {
  if (!selectedItem.value) return;
  input.value = selectedItem.value.content || '';
  await nextTick();
  if (messageInputRef.value) {
    messageInputRef.value.focus();
  }
};

const removeSelectedItem = () => {
  const category = knowledgeCategories.value[selectedCategoryIndex.value];
  if (!category) return;

  category.items.splice(selectedItemIndex.value, 1);
  selectedItemIndex.value = -1;
};

const saveKnowledgeBase = async () => {
  kbSaving.value = true;
  try {
    const payload = {
      baseVersion: knowledgeVersion,
      categories: knowledgeCategories.value.map((category) => ({
        name: String(category.name || '').trim(),
        items: category.items.map((item) => ({
          title: String(item.title || '').trim(),
          content: String(item.content || '')
        }))
      }))
    };

    await axios.put(`${API_URL}/api/knowledge-base`, payload, { withCredentials: true });
    await loadKnowledgeBase();
    alert('知识库已保存');
  } catch (err) {
    console.error('Failed to save knowledge base', err);
    if (err?.response?.status === 409) {
      alert('知识库已被其他客服修改，将重新加载最新内容，请检查后重新编辑。');
      await loadKnowledgeBase();
    } else {
      alert('知识库保存失败');
    }
  } finally {
    kbSaving.value = false;
  }
};

const scrollToBottom = async () => {
  await nextTick();
  if (container.value) {
    container.value.scrollTop = container.value.scrollHeight;
  }
};

const syncBottomAfterKeyboardChange = () => {
  if (!inputFocused.value) return;

  if (keyboardSyncRaf) {
    cancelAnimationFrame(keyboardSyncRaf);
  }
  keyboardSyncRaf = requestAnimationFrame(() => {
    scrollToBottom();
    keyboardSyncRaf = 0;
  });

  if (keyboardSyncTimer) {
    clearTimeout(keyboardSyncTimer);
  }
  keyboardSyncTimer = setTimeout(() => {
    scrollToBottom();
  }, 120);
};

const updateViewportHeight = () => {
  if (!chatRoomRef.value) return;
  const viewport = window.visualViewport;
  const viewportHeight = viewport ? viewport.height : window.innerHeight;
  const viewportTop = viewport ? Math.max(0, viewport.offsetTop || 0) : 0;
  chatRoomRef.value.style.setProperty('--vv-top', `${Math.round(viewportTop)}px`);
  chatRoomRef.value.style.setProperty('--app-height', `${Math.max(320, Math.round(viewportHeight))}px`);

  if (inputFocused.value) {
    syncBottomAfterKeyboardChange();
  }
};

const lockPageScroll = () => {
  const htmlEl = document.documentElement;
  const bodyEl = document.body;
  if (!htmlEl || !bodyEl || restorePageScrollStyles) return;

  restorePageScrollStyles = {
    htmlOverflow: htmlEl.style.overflow,
    htmlOverscrollBehavior: htmlEl.style.overscrollBehavior,
    bodyOverflow: bodyEl.style.overflow,
    bodyOverscrollBehavior: bodyEl.style.overscrollBehavior,
    bodyHeight: bodyEl.style.height
  };

  htmlEl.style.overflow = 'hidden';
  htmlEl.style.overscrollBehavior = 'none';
  bodyEl.style.overflow = 'hidden';
  bodyEl.style.overscrollBehavior = 'none';
  bodyEl.style.height = '100%';
};

const unlockPageScroll = () => {
  if (!restorePageScrollStyles) return;

  const htmlEl = document.documentElement;
  const bodyEl = document.body;
  if (htmlEl && bodyEl) {
    htmlEl.style.overflow = restorePageScrollStyles.htmlOverflow;
    htmlEl.style.overscrollBehavior = restorePageScrollStyles.htmlOverscrollBehavior;
    bodyEl.style.overflow = restorePageScrollStyles.bodyOverflow;
    bodyEl.style.overscrollBehavior = restorePageScrollStyles.bodyOverscrollBehavior;
    bodyEl.style.height = restorePageScrollStyles.bodyHeight;
  }

  restorePageScrollStyles = null;
};

const updateKeyboardOffset = () => {
  if (!inputFocused.value || !window.visualViewport) {
    keyboardOffset.value = 0;
    return;
  }

  const viewport = window.visualViewport;
  const keyboardHeight = Math.max(0, window.innerHeight - (viewport.height + viewport.offsetTop));
  keyboardOffset.value = keyboardHeight > 0 ? keyboardHeight : 0;
  syncBottomAfterKeyboardChange();
};

const handleInputFocus = async () => {
  inputFocused.value = true;
  await nextTick();
  updateKeyboardOffset();
  scrollToBottom();
  setTimeout(() => {
    updateKeyboardOffset();
  }, 120);
};

const handleInputBlur = () => {
  inputFocused.value = false;
  keyboardOffset.value = 0;

  if (keyboardSyncRaf) {
    cancelAnimationFrame(keyboardSyncRaf);
    keyboardSyncRaf = 0;
  }
  if (keyboardSyncTimer) {
    clearTimeout(keyboardSyncTimer);
    keyboardSyncTimer = null;
  }
};

const viewFullImage = (url) => {
  previewUrl.value = url;
};

const closePreview = () => {
  previewUrl.value = null;
};

const handleMessageImageLoad = (msg) => {
  if (msg?._suppressAutoScrollOnImageLoad) {
    return;
  }
  scrollToBottom();
};

const resetOutgoingTranslation = () => {
  outgoingTranslationSeq += 1;

  if (outgoingTranslationTimer) {
    clearTimeout(outgoingTranslationTimer);
    outgoingTranslationTimer = null;
  }

  outgoingTranslation.value = {
    status: 'idle',
    translatedText: '',
    error: '',
    sourceLanguage: 'zh-Hans',
    targetLanguage: '',
    inputText: ''
  };
};

const translateOutgoingText = async (text, targetLanguage, { updateState = true } = {}) => {
  const trimmedText = String(text || '').trim();
  const trimmedTarget = String(targetLanguage || '').trim();

  if (!trimmedText || !trimmedTarget) {
    resetOutgoingTranslation();
    return null;
  }

  const requestId = ++outgoingTranslationSeq;

  if (updateState) {
    outgoingTranslation.value = {
      status: 'loading',
      translatedText: '',
      error: '',
      sourceLanguage: 'zh-Hans',
      targetLanguage: trimmedTarget,
      inputText: trimmedText
    };
  }

  try {
    const translation = await googleTranslateText(trimmedText, trimmedTarget);

    if (requestId !== outgoingTranslationSeq) return null;

    const nextState = {
      status: 'loaded',
      translatedText: translation.translatedText,
      error: '',
      sourceLanguage: translation.detectedSourceLanguage,
      targetLanguage: trimmedTarget,
      inputText: trimmedText
    };

    if (updateState) {
      outgoingTranslation.value = nextState;
    }

    return nextState;
  } catch (err) {
    if (requestId !== outgoingTranslationSeq) return null;

    const nextState = {
      status: 'error',
      translatedText: '',
      error: '翻译失败，请重试',
      sourceLanguage: 'zh-Hans',
      targetLanguage: trimmedTarget,
      inputText: trimmedText
    };

    if (updateState) {
      outgoingTranslation.value = nextState;
    }

    throw err;
  }
};

const copyMessage = async (content, messageKey) => {
  const textToCopy = String(content || '');
  if (!textToCopy) return;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(textToCopy);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = textToCopy;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }

    copiedMessageIndex.value = messageKey;
    setTimeout(() => {
      if (copiedMessageIndex.value === messageKey) {
        copiedMessageIndex.value = -1;
      }
    }, 1200);
  } catch (err) {
    console.error('Copy failed', err);
    alert('复制失败，请重试');
  }
};

const getMessageKey = (msg, index) => {
  return msg.messageId || `${msg.timestamp || 'message'}-${index}`;
};

const getTranslationState = (msg, index) => {
  const key = getMessageKey(msg, index);
  return translationState.value[key] || { status: 'idle', translatedText: '', error: '', expanded: false, sourceLanguage: '' };
};

const getTranslationButtonLabel = (msg, index) => {
  const state = getTranslationState(msg, index);
  if (state.status === 'loading') return '翻译中...';
  if (state.status === 'loaded' && state.expanded) return '收起译文';
  if (state.status === 'loaded' && !state.expanded) return '展开译文';
  if (state.status === 'error') return '重试翻译';
  return '翻译';
};

const shouldShowTranslation = (msg, index) => {
  const state = getTranslationState(msg, index);
  return (
    (state.status === 'loaded' && state.expanded) ||
    state.status === 'loading' ||
    (state.status === 'error' && state.expanded)
  );
};

const toggleTranslation = async (msg, index) => {
  const text = String(msg.content || '').trim();
  if (!text) return;

  const key = getMessageKey(msg, index);
  const current = translationState.value[key] || { status: 'idle', translatedText: '', error: '', expanded: false, sourceLanguage: '' };

  if (current.status === 'loaded') {
    translationState.value = {
      ...translationState.value,
      [key]: {
        ...current,
        expanded: !current.expanded
      }
    };
    return;
  }

  translationState.value = {
    ...translationState.value,
    [key]: {
      ...current,
      status: 'loading',
      error: '',
        sourceLanguage: '',
      expanded: true
    }
  };

  try {
    const translation = await googleTranslateText(text, 'zh-CN');

    translationState.value = {
      ...translationState.value,
      [key]: {
        status: 'loaded',
        translatedText: translation.translatedText,
        error: '',
        expanded: true,
        sourceLanguage: translation.detectedSourceLanguage
      }
    };
  } catch (err) {
    console.error('Translate failed', err);
    translationState.value = {
      ...translationState.value,
      [key]: {
        status: 'error',
        translatedText: '',
        error: '翻译失败，请重试',
        expanded: true,
        sourceLanguage: ''
      }
    };
  }
};

const formatTime = (ts) => {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatLinks = (text) => {
  if (!text) return '';
  
  // 1. Escape HTML to prevent XSS
  const escapedText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  // 2. Safely linkify URLs
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return escapedText.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color: #1890ff; text-decoration: underline;">$1</a>');
};

const goBack = () => {
  router.push('/rooms');
};

// Every history response is tagged with the room / request it belongs to. A response that arrives after the
// agent moved on to another room is dropped, so one room's messages can never show up in another room's view.
let historySeq = 0;

const hasMessage = (messageId) => !!messageId && messages.value.some((m) => m.messageId === messageId);

const loadHistory = async () => {
  const roomId = props.roomId;
  const seq = ++historySeq;
  try {
    historyLoading.value = true;
    historyHasMore.value = true;

    const res = await axios.get(`${API_URL}/api/history/${roomId}`, {
      params: { limit: historyPageSize },
      withCredentials: true
    });
    if (seq !== historySeq || roomId !== props.roomId) return;

    const firstBatch = Array.isArray(res.data?.messages)
      ? res.data.messages.map((msg) => ({ ...msg, _suppressAutoScrollOnImageLoad: false }))
      : [];
    // Keep messages that arrived live while the request was in flight.
    const known = new Set(firstBatch.map((m) => m.messageId));
    const live = messages.value.filter((m) => m.messageId && !known.has(m.messageId));
    messages.value = [...firstBatch, ...live];
    historyHasMore.value = firstBatch.length === historyPageSize;
    visitorName.value = res.data.visitorName || '访客';
    currentPage.value = res.data.currentPage || '';
    roomStatus.value = res.data.status || 'active';
    scrollToBottom();
  } catch (err) {
    console.error('Failed to load history', err);
  } finally {
    if (seq === historySeq) historyLoading.value = false;
  }
};

// After a reconnect: fetch the newest page and append whatever was missed while the socket was down.
const syncLatestMessages = async () => {
  const roomId = props.roomId;
  try {
    const res = await axios.get(`${API_URL}/api/history/${roomId}`, {
      params: { limit: historyPageSize },
      withCredentials: true
    });
    if (roomId !== props.roomId) return;
    const missed = (Array.isArray(res.data?.messages) ? res.data.messages : []).filter((m) => m.messageId && !hasMessage(m.messageId));
    if (!missed.length) return;
    messages.value.push(...missed.map((msg) => ({ ...msg, _suppressAutoScrollOnImageLoad: false })));
    scrollToBottom();
    socket.emit('mark-read', roomId);
  } catch (err) {
    console.error('Failed to sync messages after reconnect', err);
  }
};

const loadOlderHistory = async () => {
  if (historyLoading.value || !historyHasMore.value || !container.value || messages.value.length === 0) {
    return;
  }

  const roomId = props.roomId;
  const seq = historySeq;
  const oldest = messages.value[0];
  const before = oldest?.timestamp;
  if (!before) {
    historyHasMore.value = false;
    return;
  }

  const previousScrollHeight = container.value.scrollHeight;
  historyLoading.value = true;

  try {
    const res = await axios.get(`${API_URL}/api/history/${roomId}`, {
      params: {
        limit: historyPageSize,
        before
      },
      withCredentials: true
    });
    if (seq !== historySeq || roomId !== props.roomId) return;

    const older = Array.isArray(res.data?.messages)
      ? res.data.messages.map((msg) => ({ ...msg, _suppressAutoScrollOnImageLoad: true }))
      : [];
    if (older.length === 0) {
      historyHasMore.value = false;
      return;
    }

    messages.value = [...older, ...messages.value];
    historyHasMore.value = older.length === historyPageSize;

    await nextTick();
    const nextScrollHeight = container.value.scrollHeight;
    container.value.scrollTop += nextScrollHeight - previousScrollHeight;
  } catch (err) {
    console.error('Failed to load older history', err);
  } finally {
    if (seq === historySeq) historyLoading.value = false;
  }
};

const handleMessageScroll = () => {
  if (!container.value || historyLoading.value || !historyHasMore.value) return;
  if (container.value.scrollTop <= 40) {
    loadOlderHistory();
  }
};

const updateRoomStatus = (status) => {
  const oldStatus = roomStatus.value;
  roomStatus.value = status;
  socket.emit('update-room-status', { roomId: props.roomId, status });
  
  if (status === 'done') {
    // 延迟检查是否发生了错误而导致状态未改变
    const timeout = setTimeout(() => {
      goBack();
    }, 400);

    // 监听一次性错误事件
    const errorHandler = (msg) => {
      clearTimeout(timeout);
      roomStatus.value = oldStatus; // 恢复旧状态
      alert(msg);
      socket.off('error', errorHandler);
    };
    socket.on('error', errorHandler);
    
    // 5秒后自动关闭错误监听，防止内存泄露
    setTimeout(() => socket.off('error', errorHandler), 5000);
  }
};

// Only messages of the room on screen are shown (agents receive every room's messages), and a message that is
// already on screen (e.g. also returned by a history sync) is never added twice.
const handleReceiveMessage = (msg) => {
  if (!msg || msg.roomId !== props.roomId) return;
  if (hasMessage(msg.messageId)) return;

  messages.value.push({ ...msg, _suppressAutoScrollOnImageLoad: false });
  scrollToBottom();

  // Anything that arrives while the room is open counts as read.
  socket.emit('mark-read', props.roomId);
};

onMounted(() => {
  loadOutgoingLanguagePreference();
  loadHistory();
  loadKnowledgeBase();
  lockPageScroll();
  updateViewportHeight();

  window.addEventListener('resize', updateViewportHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateViewportHeight);
    window.visualViewport.addEventListener('scroll', updateViewportHeight);
    window.visualViewport.addEventListener('resize', updateKeyboardOffset);
    window.visualViewport.addEventListener('scroll', updateKeyboardOffset);
  }

  socket.emit('join-room', props.roomId);

  socket.on('receive-message', handleReceiveMessage);
  socket.on('connect', syncLatestMessages);
});

onUnmounted(() => {
  socket.emit('leave-room', props.roomId);
  // Remove only this view's handlers: socket.off(event) with no handler would also remove the global listeners
  // registered in socket.js (new-message sound, ...).
  socket.off('receive-message', handleReceiveMessage);
  socket.off('connect', syncLatestMessages);
  unlockPageScroll();
  window.removeEventListener('resize', updateViewportHeight);
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', updateViewportHeight);
    window.visualViewport.removeEventListener('scroll', updateViewportHeight);
    window.visualViewport.removeEventListener('resize', updateKeyboardOffset);
    window.visualViewport.removeEventListener('scroll', updateKeyboardOffset);
  }
  if (outgoingTranslationTimer) {
    clearTimeout(outgoingTranslationTimer);
    outgoingTranslationTimer = null;
  }
  if (keyboardSyncRaf) {
    cancelAnimationFrame(keyboardSyncRaf);
    keyboardSyncRaf = 0;
  }
  if (keyboardSyncTimer) {
    clearTimeout(keyboardSyncTimer);
    keyboardSyncTimer = null;
  }
});

watch(() => props.roomId, (newRoomId, oldRoomId) => {
  if (oldRoomId) {
    saveOutgoingLanguagePreference(oldRoomId);
  }

  loadOutgoingLanguagePreference(newRoomId);
  resetOutgoingTranslation();
});

watch(
  () => socketState.rooms,
  (rooms) => {
    const activeRoom = Array.isArray(rooms)
      ? rooms.find((room) => room.roomId === props.roomId)
      : null;

    if (!activeRoom) {
      return;
    }

    visitorName.value = activeRoom.visitorName || visitorName.value || '访客';
    currentPage.value = activeRoom.currentPage || '';
    roomStatus.value = activeRoom.status || roomStatus.value || 'active';
  },
  { deep: false }
);

watch(outgoingLanguage, (newValue) => {
  saveOutgoingLanguagePreference(props.roomId, newValue);
});

watch(() => props.roomId, () => {
  messages.value = [];
  historyHasMore.value = true;
  historyLoading.value = false;
  loadHistory();
});

watch([input, outgoingLanguage], () => {
  if (outgoingTranslationTimer) {
    clearTimeout(outgoingTranslationTimer);
    outgoingTranslationTimer = null;
  }

  const text = input.value.trim();
  const targetLanguage = outgoingLanguage.value;

  if (!text || !targetLanguage) {
    resetOutgoingTranslation();
    return;
  }

  outgoingTranslationTimer = setTimeout(() => {
    translateOutgoingText(text, targetLanguage, { updateState: true }).catch((err) => {
      console.error('Outgoing translation failed', err);
    });
  }, 350);
});

const sendMessage = async () => {
  const originalText = input.value.trim();
  if (!originalText) return;

  // Pinned now: the translation below is asynchronous and the message must go to the room it was typed in.
  const roomId = props.roomId;
  let textToSend = originalText;

  if (outgoingLanguage.value) {
    try {
      const cached = outgoingTranslation.value;
      if (
        cached.status === 'loaded' &&
        cached.inputText === originalText &&
        cached.targetLanguage === outgoingLanguage.value
      ) {
        textToSend = cached.translatedText;
      } else {
        const translated = await translateOutgoingText(originalText, outgoingLanguage.value, { updateState: true });
        if (!translated?.translatedText) {
          throw new Error('Translation missing');
        }
        textToSend = translated.translatedText;
      }
    } catch (err) {
      console.error('Send translation failed', err);
      alert('翻译失败，请重试后再发送');
      return;
    }

    // The agent left this room while the translation was running: do not send into the wrong conversation.
    if (roomId !== props.roomId) return;
  }

  if (textToSend.length > 4000) {
    alert('消息过长（最多 4000 字），请缩短后再发送');
    return;
  }

  const msgData = {
    roomId,
    content: textToSend,
    senderType: 'agent',
    senderId: agentInfo.agentId,
    senderName: agentInfo.name
  };

  socket.emit('send-message', msgData, (ack) => {
    if (ack && ack.success === true) return;
    // Not delivered (disconnected, rate limited, session expired, ...): give the text back instead of losing it.
    if (!input.value && roomId === props.roomId) input.value = originalText;
    alert(ack?.error ? `发送失败：${ack.error}` : '发送失败，请检查网络后重试');
  });
  input.value = '';
  resetOutgoingTranslation();
};

const compressImageIfNeeded = async (file) => {
  if (!file || !file.type || !file.type.startsWith('image/')) {
    return file;
  }

  if (file.size < IMAGE_COMPRESS_SKIP_SIZE) {
    return file;
  }

  return new Promise((resolve) => {
    new Compressor(file, {
      quality: 0.8,
      maxWidth: 1920,
      maxHeight: 1920,
      mimeType: 'image/jpeg',
      convertSize: IMAGE_COMPRESS_CONVERT_SIZE,
      success: (compressedBlob) => {
        const compressedFile = new File([compressedBlob], file.name || 'image.jpg', {
          type: compressedBlob.type || 'image/jpeg',
          lastModified: Date.now()
        });
        resolve(compressedFile);
      },
      error: (err) => {
        console.warn('Image compression failed, use original file', err);
        resolve(file);
      }
    });
  });
};

const handleImageUpload = async (e) => {
  const fileInput = e?.target;
  const originalFile = fileInput?.files?.[0];
  if (!originalFile) return;

  // Pinned now: compression / upload are asynchronous and the image must go to the room it was chosen in.
  const roomId = props.roomId;

  let fileToUpload = originalFile;
  try {
    fileToUpload = await compressImageIfNeeded(originalFile);
  } catch (err) {
    console.warn('Unexpected compression error, use original file', err);
    fileToUpload = originalFile;
  }

  const formData = new FormData();
  formData.append('image', fileToUpload);
  formData.append('roomId', roomId);

  try {
    const res = await axios.post(`${API_URL}/api/upload`, formData, {
      withCredentials: true
    });
    
    const msgData = {
      roomId,
      senderType: 'agent',
      senderId: agentInfo.agentId,
      senderName: agentInfo.name,
      type: 'image',
      imageUrl: res.data.url
    };
    
    socket.emit('send-message', msgData, (ack) => {
      if (ack && ack.success === true) return;
      alert(ack?.error ? `图片发送失败：${ack.error}` : '图片发送失败');
    });
  } catch (err) {
    console.error('Upload failed', err);
    alert(err?.response?.data?.error || '图片发送失败');
  } finally {
    if (fileInput) {
      fileInput.value = '';
    }
  }
};
</script>

<style scoped>
.chat-room { 
  display: flex; 
  flex-direction: column; 
  height: 100vh;
  width: 100%;
  max-width: 100vw;
  position: relative;
  overflow: hidden;
  overscroll-behavior: none;
}

/* Image Modal */
.image-modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 9999;
}
.modal-wrapper {
  position: relative;
  max-width: 95vw;
  max-height: 95vh;
  display: flex;
  justify-content: center;
  align-items: center;
}
.modal-content {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  box-shadow: 0 0 30px rgba(0, 0, 0, 0.5);
  border-radius: 4px;
}
.close-preview-btn {
  position: absolute;
  top: -40px;
  right: -40px;
  width: 40px;
  height: 40px;
  background: rgba(255, 255, 255, 0.2);
  border: none;
  border-radius: 50%;
  color: white;
  font-size: 30px;
  line-height: 40px;
  text-align: center;
  cursor: pointer;
  transition: background 0.2s;
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10000;
}
.close-preview-btn:hover {
  background: rgba(255, 255, 255, 0.4);
}

@media screen and (max-width: 768px) {
  .close-preview-btn {
    top: -50px;
    right: 10px;
  }
}

header { 
  display: flex; 
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  padding: 10px; 
  border-bottom: 1px solid #eee; 
  background: #fff;
  flex-shrink: 0;
  width: 100%;
  max-width: 100vw;
  overflow: hidden;
}

.header-row {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
}

.header-top-row {
  justify-content: space-between;
  gap: 8px;
}

.header-bottom-row {
  justify-content: space-between;
  gap: 10px;
  margin-top: 6px;
}

.back-area { 
  position: relative; 
  display: flex; 
  align-items: center; 
  flex-shrink: 0;
}

.total-unread-badge {
  position: absolute;
  top: -8px;
  right: -8px;
  background: #ff4d4f;
  color: white;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

.header-info { 
  display: flex; 
  flex-direction: column; 
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.back-btn { 
  border: none; 
  background: none; 
  color: #0088cc; 
  cursor: pointer; 
  white-space: nowrap;
  font-size: 14px;
  padding: 4px 8px;
}

.status-control { 
  display: flex; 
  gap: 6px;
  flex-shrink: 0;
}

.status-btn {
  padding: 5px 10px;
  border: 1px solid #ddd;
  background: white;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #666;
  transition: all 0.2s;
  white-space: nowrap;
}

.status-btn:hover { 
  background: #f5f5f5; 
}

.status-btn.active {
  background: #0088cc;
  color: white;
  border-color: #0088cc;
}

.title { 
  font-weight: bold; 
  font-size: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.current-page { 
  font-size: 12px; 
  color: #666;
  flex: 1;
  min-width: 0;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.current-page a { 
  color: #0088cc; 
  text-decoration: none; 
}

.current-page a:hover { 
  text-decoration: underline; 
}

.message-container { 
  flex: 1; 
  display: flex;
  flex-direction: column;
  overflow-y: auto; 
  overflow-x: hidden;
  padding: 15px; 
  background: #f9f9f9;
  width: 100%;
  max-width: 100vw;
  min-height: 0;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
}

.message-list {
  margin-top: auto;
  width: 100%;
}

.message { 
  display: flex; 
  margin-bottom: 15px;
  width: 100%;
}

.message.visitor { 
  justify-content: flex-start; 
}

.message.agent { 
  justify-content: flex-end; 
}

.content { 
  max-width: 85%; 
  display: flex; 
  flex-direction: column;
  min-width: 0;
}

.agent .content { 
  align-items: flex-end; 
}

.msg-meta { 
  font-size: 11px; 
  color: #999; 
  margin-bottom: 4px; 
  display: flex; 
  gap: 8px; 
}

.visitor .msg-meta { 
  justify-content: flex-start; 
}

.agent .msg-meta { 
  flex-direction: row-reverse; 
}

.bubble { 
  padding: 10px 15px; 
  border-radius: 12px; 
  font-size: 14px; 
  position: relative; 
  word-break: break-word;
  white-space: pre-wrap;
  text-align: left;
  max-width: 100%;
}

.bubble-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  max-width: 100%;
}

.message-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
}

.copy-msg-btn {
  padding: 4px 8px;
  font-size: 12px;
  color: #3d6f8f;
  background: #f0f6fb;
  border: 1px solid #c8dced;
  border-radius: 6px;
  margin-top: 2px;
  min-width: 44px;
}

.copy-msg-btn:active {
  opacity: 0.85;
}

.translate-msg-btn {
  padding: 4px 8px;
  font-size: 12px;
  color: #2f6d4f;
  background: #eef8f1;
  border: 1px solid #cce7d5;
  border-radius: 6px;
  min-width: 44px;
}

.translate-msg-btn:disabled {
  opacity: 0.7;
  cursor: wait;
}

.translation-panel {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #d7e2ea;
  background: #f6fbff;
  color: #34515f;
  max-width: 100%;
}

.translation-text {
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.translation-lang {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(15, 94, 141, 0.12);
  color: #0f5e8d;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.2px;
  flex-shrink: 0;
}

.translation-lang {
  margin-right: 6px;
  color: #6d7d87;
  font-weight: 700;
}

.chat-img { 
  max-width: 200px;
  max-width: min(200px, 60vw);
  border-radius: 4px; 
  display: block; 
  cursor: zoom-in; 
}

.visitor .bubble { 
  background: #fff; 
  border: 1px solid #ddd; 
  border-top-left-radius: 4px; 
}

.agent .bubble { 
  background: #effdde; 
  color: #000; 
  border-top-right-radius: 4px; 
}

.agent .bubble-row {
  justify-content: flex-end;
}

.knowledge-panel {
  border-top: 1px solid #e9e9e9;
  border-bottom: 1px solid #e9e9e9;
  background: #ffffff;
  padding: 10px;
  position: relative;
  z-index: 12;
  max-height: min(60dvh, 460px);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.knowledge-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.knowledge-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.ghost-btn {
  background: #f5f7fa;
  color: #333;
  border: 1px solid #d8dee4;
  padding: 6px 10px;
  font-size: 12px;
}

.ghost-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.knowledge-body {
  display: grid;
  grid-template-columns: minmax(220px, 36%) 1fr;
  gap: 10px;
}

.kb-tree {
  border: 1px solid #edf0f3;
  border-radius: 6px;
  background: #fbfdff;
  padding: 8px;
  max-height: 260px;
  overflow-y: auto;
}

.kb-category {
  margin-bottom: 8px;
}

.kb-category-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.kb-toggle {
  background: transparent;
  color: #666;
  border: none;
  padding: 0 4px;
  min-width: 18px;
}

.kb-category-input {
  flex: 1;
  min-width: 0;
  padding: 6px;
  font-size: 13px;
}

.mini-btn {
  background: #f7f7f7;
  color: #333;
  border: 1px solid #d9d9d9;
  padding: 4px 8px;
  font-size: 12px;
}

.danger {
  color: #c62828;
}

.kb-item-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  padding-left: 24px;
}

.kb-item-chip {
  background: #eef5ff;
  color: #1b4f7a;
  border: 1px solid #cddff3;
  padding: 4px 8px;
  font-size: 12px;
  border-radius: 999px;
}

.kb-item-chip.active {
  background: #0088cc;
  color: #fff;
  border-color: #0088cc;
}

.kb-empty-tip {
  font-size: 12px;
  color: #999;
}

.kb-editor {
  border: 1px solid #edf0f3;
  border-radius: 6px;
  background: #fff;
  padding: 10px;
}

.editor-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.editor-row label {
  font-size: 12px;
  color: #666;
}

.editor-row textarea {
  width: 100%;
  border: 1px solid #ddd;
  border-radius: 4px;
  padding: 8px;
  resize: vertical;
  font-size: 13px;
}

.editor-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.kb-editor-empty {
  border: 1px dashed #d9d9d9;
  border-radius: 6px;
  background: #fafafa;
  color: #999;
  font-size: 13px;
  padding: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.input-area { 
  display: flex; 
  align-items: center; 
  padding: 10px; 
  border-top: 1px solid #eee; 
  background: #fff;
  flex-shrink: 0;
  width: 100%;
  max-width: 100vw;
  gap: 5px;
}

.compose-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tool-stack {
  width: 60px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.upload-label { 
  cursor: pointer; 
  padding: 5px; 
  display: flex; 
  align-items: center;
  flex-shrink: 0;
}

.kb-entry-btn {
  background: #f0f7ff;
  color: #0f5e8d;
  border: 1px solid #bfdaee;
  padding: 7px 4px;
  width: 100%;
  font-size: 12px;
  line-height: 1;
}

.language-select {
  width: 100%;
  padding: 7px 4px;
  border: 1px solid #bfdaee;
  border-radius: 4px;
  background: #fff;
  color: #0f5e8d;
  font-size: 12px;
  flex-shrink: 0;
  text-align: center;
  text-align-last: center;
}

.outgoing-translation-panel {
  padding: 10px 12px;
  border: 1px solid #cfe0ec;
  border-radius: 10px;
  background: linear-gradient(180deg, #f6fbff 0%, #eef7ff 100%);
  color: #23475f;
  box-shadow: 0 6px 18px rgba(9, 45, 70, 0.06);
}

.outgoing-translation-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-input {
  flex: 1; 
  padding: 10px; 
  border: 1px solid #ddd; 
  border-radius: 4px; 
  outline: none;
  font-size: 16px;
  min-width: 0;
  min-height: 44px;
  max-height: 160px;
  resize: vertical;
  line-height: 1.4;
  font-family: inherit;
}

button { 
  padding: 10px 20px; 
  background: #0088cc; 
  color: white; 
  border: none; 
  border-radius: 4px; 
  cursor: pointer;
  flex-shrink: 0;
  font-size: 14px;
}

button:active {
  opacity: 0.8;
}

/* 移动端适配 */
@media screen and (max-width: 768px) {
  .chat-room {
    position: fixed;
    top: var(--vv-top, 0px);
    left: 0;
    right: 0;
    width: 100vw;
    max-width: 100vw;
    height: var(--app-height, 100dvh);
    min-height: var(--app-height, 100dvh);
    max-height: var(--app-height, 100dvh);
    background: #fff;
    z-index: 1000;
  }

  header {
    padding: 8px;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .header-top-row {
    align-items: center;
  }

  .header-bottom-row {
    margin-top: 6px;
    align-items: center;
  }
  
  .back-area {
    margin-right: 0;
  }
  
  .back-btn {
    font-size: 13px;
    padding: 3px 6px;
  }
  
  .status-control {
    gap: 4px;
    width: auto;
    margin-top: 0;
  }
  
  .status-btn {
    padding: 4px 8px;
    font-size: 11px;
  }
  
  .title {
    font-size: 14px;
  }
  
  .current-page {
    font-size: 11px;
  }
  
  .message-container {
    padding: 10px;
    padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    flex: 1 1 auto;
  }
  
  .content {
    max-width: 90%;
  }
  
  .bubble {
    padding: 8px 12px;
    font-size: 13px;
  }

  .copy-msg-btn {
    padding: 4px 7px;
    font-size: 11px;
    min-width: 40px;
  }
  
  .input-area {
    padding: 8px;
    gap: 4px;
    position: static;
    z-index: 10;
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
    transform: none;
  }

  .input-area.kb-open {
    position: static;
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
    transform: none;
  }

  .knowledge-body {
    grid-template-columns: 1fr;
  }

  .knowledge-panel {
    max-height: min(55dvh, 460px);
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .chat-room.kb-open .message-container {
    display: none;
  }

  .chat-room.kb-open .knowledge-panel {
    flex: 1 1 auto;
    min-height: 0;
    max-height: none;
    border-bottom: none;
  }

  .kb-tree {
    max-height: 180px;
  }
  
  .upload-label {
    padding: 3px;
  }
  
  .chat-input {
    padding: 8px;
    font-size: 16px; /* 防止iOS自动放大 */
  }
  
  button {
    padding: 8px 15px;
    font-size: 13px;
  }
}

@media screen and (max-width: 480px) {
  .chat-room {
    height: var(--app-height, 100dvh);
    min-height: var(--app-height, 100dvh);
  }

  .content {
    max-width: 95%;
  }
  
  button {
    padding: 8px 12px;
  }
}
</style>
