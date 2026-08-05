import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Built to web/dist and served by Express under /app, so the bundle's own asset paths can
// never collide with a board id at /b/<id>.
export default defineConfig({
	root: 'web',
	base: '/app/',
	plugins: [react()],
	build: {
		outDir: 'dist',
		emptyOutDir: true,
	},
	server: {
		// `npm run dev:web` gives hot reload while the bot and sync server run on :3000.
		proxy: {
			'/api': 'http://localhost:3000',
			'/uploads': 'http://localhost:3000',
			'/sync': { target: 'ws://localhost:3000', ws: true },
		},
	},
})
