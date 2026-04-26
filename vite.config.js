import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: './', // Using relative paths to make it easier for GitHub Pages sub-directories
  plugins: [react()],
})
