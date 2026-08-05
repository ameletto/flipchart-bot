import { createServer } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer } from 'ws'
import { config } from '../config.js'
import { boards, previewPath } from '../db.js'
import { verifyToken } from '../identity.js'
import { savePreview } from './preview.js'
import { getRoom } from './rooms.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const clientDir = join(root, 'web', 'dist')

// Asset ids come from the browser, so they are checked against a strict allowlist before
// touching the filesystem — anything with a slash or a dot-segment is rejected outright.
const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/
const isSafeId = (id) => SAFE_ID.test(id) && !id.includes('..')

function bearer(req) {
	const header = req.get('authorization') ?? ''
	return header.startsWith('Bearer ') ? header.slice(7) : ''
}

/** Resolves the caller's session from a token, or answers 401/403 itself. */
function authorize(req, res, boardId) {
	const session = verifyToken(bearer(req))
	if (!session) {
		res.status(401).json({ error: 'invalid or expired link' })
		return null
	}
	if (boardId && session.b !== boardId) {
		res.status(403).json({ error: 'this link is for a different flipchart' })
		return null
	}
	return session
}

export function createApp() {
	const app = express()
	app.disable('x-powered-by')

	// The whiteboard bundle. Served under /app so it can never collide with a board id.
	app.use('/app', express.static(clientDir, { maxAge: '1y', index: false }))

	app.get('/healthz', (_req, res) => res.type('text').send('ok'))

	// The page a contributor lands on. It carries no board data of its own: the token
	// lives in the URL fragment, which browsers never send to the server, and the client
	// presents it over the websocket instead.
	app.get('/b/:boardId', (req, res) => {
		const board = boards.get(req.params.boardId)
		if (!board) return res.status(404).type('text').send('No such flipchart.')
		res.sendFile(join(clientDir, 'index.html'))
	})

	// Preview images, cache-busted by ?v= so Discord re-fetches after every update.
	app.get('/p/:file', (req, res) => {
		const boardId = req.params.file.replace(/\.png$/, '')
		if (!isSafeId(boardId)) return res.sendStatus(400)

		const path = previewPath(boardId)
		if (!existsSync(path)) return res.sendStatus(404)

		res.type('png').set('Cache-Control', 'public, max-age=31536000, immutable')
		createReadStream(path).pipe(res)
	})

	app.get('/uploads/:id', (req, res) => {
		if (!isSafeId(req.params.id)) return res.sendStatus(400)

		const path = join(config.dataDir, 'assets', req.params.id)
		if (!existsSync(path)) return res.sendStatus(404)

		res.set('Cache-Control', 'public, max-age=31536000, immutable')
		createReadStream(path).pipe(res)
	})

	// What the client needs to render its chrome: the title, the prompt, and who the
	// viewer is anonymously known as.
	app.get('/api/boards/:boardId', (req, res) => {
		const session = authorize(req, res, req.params.boardId)
		if (!session) return

		const board = boards.get(req.params.boardId)
		if (!board) return res.status(404).json({ error: 'no such flipchart' })

		res.json({
			id: board.id,
			title: board.title,
			prompt: board.prompt,
			closed: Boolean(board.closed_at),
			readonly: Boolean(session.ro || board.closed_at),
			// A slice of the board-scoped HMAC. Other contributors see it in presence, and
			// it reveals nothing — it is one-way and different on every board.
			you: { id: session.k.slice(0, 12), name: session.n, color: session.c },
			contributors: boards.contributorCount(board.id),
		})
	})

	const raw = express.raw({ type: '*/*', limit: `${config.maxUploadMb}mb` })

	app.post('/api/boards/:boardId/preview', raw, async (req, res) => {
		const session = authorize(req, res, req.params.boardId)
		if (!session) return
		if (session.ro) return res.status(403).json({ error: 'read-only' })
		if (!req.body?.length) return res.status(400).json({ error: 'empty body' })

		await savePreview(req.params.boardId, req.body)
		res.sendStatus(204)
	})

	app.put('/api/uploads/:id', raw, async (req, res) => {
		const session = authorize(req, res, null)
		if (!session) return
		if (session.ro) return res.status(403).json({ error: 'read-only' })
		if (!isSafeId(req.params.id)) return res.status(400).json({ error: 'bad id' })
		if (!req.body?.length) return res.status(400).json({ error: 'empty body' })

		await writeFile(join(config.dataDir, 'assets', req.params.id), req.body)
		res.json({ url: `${config.publicUrl}/uploads/${req.params.id}` })
	})

	return app
}

export function startWebServer() {
	const server = createServer(createApp())
	const wss = new WebSocketServer({ noServer: true })

	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url, config.publicUrl)
		const match = url.pathname.match(/^\/sync\/([A-Za-z0-9._-]{1,120})$/)
		if (!match) return socket.destroy()

		const boardId = match[1]
		const session = verifyToken(url.searchParams.get('t'))
		const board = boards.get(boardId)

		if (!session || session.b !== boardId || !board) {
			// 1008 is "policy violation" — the client shows this as an expired link.
			socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
			return socket.destroy()
		}

		const sessionId = url.searchParams.get('sessionId') || session.k.slice(0, 16)
		const isReadonly = Boolean(session.ro || board.closed_at)

		wss.handleUpgrade(req, socket, head, (socket) => {
			if (!isReadonly) {
				boards.addContributor(boardId, session.k)
				boards.touch(boardId)
			}
			getRoom(boardId).handleSocketConnect({ sessionId, socket, isReadonly })
		})
	})

	return new Promise((resolve) => {
		server.listen(config.port, config.host, () => {
			console.log(`flipchart web on ${config.host}:${config.port} (public: ${config.publicUrl})`)
			resolve(server)
		})
	})
}
