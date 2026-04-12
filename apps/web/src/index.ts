import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import './styles.css'

const container = document.getElementById('app')
if (!container) {
  throw new Error('app_root_not_found')
}

createRoot(container).render(createElement(App))
