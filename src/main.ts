import { createApp } from 'vue'
import App from './App.vue'
import { installBrowserGuards } from './platform/browserGuard'
import './ui/tokens.css'
import './ui/ui.css'
import './style.css'

installBrowserGuards()
createApp(App).mount('#app')
