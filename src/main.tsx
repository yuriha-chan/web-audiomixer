import { createRoot } from 'react-dom/client'
import './index.css'
import AudioMixer from './AudioMixer.tsx'

createRoot(document.getElementById('root')!).render(
  <AudioMixer />
)
