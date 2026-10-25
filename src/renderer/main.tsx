import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { BadgeProvider } from './shell/badges'
import './styles/theme.css'
import './styles/base.css'
import './styles/shell.css'
import './styles/layout.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到挂载节点 #root')

createRoot(container).render(
  <StrictMode>
    <BadgeProvider>
      <App />
    </BadgeProvider>
  </StrictMode>
)
