<template>
  <!-- Keyed by the full path: moving between rooms always builds a fresh ChatRoom (no draft, translation or
       history state can carry over from one conversation to another). -->
  <router-view :key="$route.fullPath"></router-view>
</template>

<script setup>
</script>

<style>
* {
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}

body { 
  margin: 0; 
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  overflow-x: hidden;
  width: 100%;
  max-width: 100vw;
}

#app { 
  height: 100vh;
  width: 100%;
  max-width: 100vw;
  overflow-x: hidden;
}

/* 防止移动端双击放大 */
button, input, select, textarea {
  touch-action: manipulation;
}
</style>

