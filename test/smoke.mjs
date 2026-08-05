// Smoke test — exercises everything that doesn't need a live Discord login: the anonymity
// model, the embed and link rendering, every web route, and a real tldraw sync connection.
//
//   npm test
//
// Nothing here talks to Discord or the network, so it supplies its own throwaway config
// below and writes to a temporary directory that it cleans up on the way in.
import { existsSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import WebSocket from 'ws'

// Set before importing config.js, which reads the environment as it loads. These override
// any real .env so a developer's live credentials are never involved in a test run.
const dataDir = mkdtempSync(join(tmpdir(), 'flipchart-test-'))
Object.assign(process.env, {
	DISCORD_TOKEN: 'test',
	DISCORD_CLIENT_ID: '0',
	DISCORD_GUILD_ID: '',
	FLIPCHART_PUBLIC_URL: 'http://localhost:31245',
	FLIPCHART_SECRET: randomBytes(32).toString('hex'),
	FLIPCHART_PORT: '31245',
	FLIPCHART_DATA_DIR: dataDir,
})

const { config } = await import('../src/config.js')
const { boards, blocklist, newBoardId, boardDbPath } = await import('../src/db.js')
const { participantKey, memberKey, pseudonym, signToken, verifyToken } = await import('../src/identity.js')
const { startWebServer } = await import('../src/web/server.js')
const { renderBoard } = await import('../src/discord/board-message.js')
const { linkPayload, isBlocked } = await import('../src/discord/links.js')

const base = `http://localhost:${config.port}`
let failures = 0
let passes = 0

function check(name, ok, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
	if (ok) passes++
	else failures++
}

// --- identity -------------------------------------------------------------------
const boardId = newBoardId()
const alice = participantKey(boardId, '111')
const bob = participantKey(boardId, '222')

check('participant keys are stable', alice === participantKey(boardId, '111'))
check('different people get different keys', alice !== bob)
check('same person unlinkable across boards', alice !== participantKey(newBoardId(), '111'))
check('pseudonyms deterministic', pseudonym(alice).name === pseudonym(alice).name, pseudonym(alice).name)
check('valid token verifies', verifyToken(signToken({ b: boardId, exp: Date.now() + 1000 }))?.b === boardId)
check('expired token rejected', verifyToken(signToken({ b: boardId, exp: Date.now() - 1 })) === null)
check('tampered token rejected', verifyToken(`${signToken({ b: boardId, exp: Date.now() + 1e3 })}x`) === null)
check('garbage token rejected', verifyToken('nonsense') === null)

// --- board lifecycle ------------------------------------------------------------
const board = boards.create({
	id: boardId,
	guildId: 'g1',
	channelId: 'c1',
	title: 'Retro: what should we stop doing?',
	prompt: 'Add a sticky whenever something occurs to you.',
	creatorKey: alice,
})
check('board created', board.id === boardId)
check('creator recognised by recomputation', board.creator_key === participantKey(boardId, '111'))
check('someone else is not the creator', board.creator_key !== participantKey(boardId, '999'))

// --- discord rendering (no login needed) ----------------------------------------
const blank = renderBoard(board)
const blankJson = JSON.stringify(blank.embeds[0].toJSON())
check('blank board renders', blank.embeds.length === 1 && blank.components.length === 1)
check('blank board says it is empty', blankJson.includes('Nothing on it yet'))
check('blank board keeps the prompt', blankJson.includes('sticky'))
check('open board has an enabled button', blank.components[0].toJSON().components[0].disabled === false)

const payload = linkPayload(board, '111')
const button = payload.components[0].toJSON().components[0]
check('link payload builds', typeof payload.content === 'string' && payload.content.length > 0)
check('link payload has no ephemeral flag', payload.flags === undefined)
check('link button is a URL button', button.style === 5 && button.url.includes('#t='))
check('link button URL within Discord limit', button.url.length < 512, `${button.url.length} chars`)
check('link tells you your pseudonym', payload.content.includes(pseudonym(alice).name))

const closed = { ...board, closed_at: Date.now() }
check('closed board disables its button', renderBoard(closed).components[0].toJSON().components[0].disabled === true)
check('closed board forces read-only link', linkPayload(closed, '111').content.includes('read-only'))

blocklist.add('g1', memberKey('g1', '333'))
check('blocked member detected', isBlocked('g1', '333'))
check('unblocked member not detected', !isBlocked('g1', '111'))
check('block is server-scoped', !isBlocked('g2', '333'))

// --- server ---------------------------------------------------------------------
const server = await startWebServer()

const token = signToken({
	b: boardId, k: alice, n: pseudonym(alice).name, c: pseudonym(alice).color,
	ro: false, exp: Date.now() + 60_000,
})
const auth = { Authorization: `Bearer ${token}` }

check('healthz', (await fetch(`${base}/healthz`)).ok)
check('board page served', (await fetch(`${base}/b/${boardId}`)).ok)
check('unknown board page 404s', (await fetch(`${base}/b/nope`)).status === 404)

const meta = await (await fetch(`${base}/api/boards/${boardId}`, { headers: auth })).json()
check('metadata returns title', meta.title === board.title)
check('metadata returns pseudonym', meta.you.name === pseudonym(alice).name, meta.you.name)
check('metadata leaks no discord id', !JSON.stringify(meta).includes('111'))
check('no token is 401', (await fetch(`${base}/api/boards/${boardId}`)).status === 401)

const otherToken = signToken({ b: 'otherboard', k: bob, ro: false, exp: Date.now() + 60_000 })
check('cross-board token is 403',
	(await fetch(`${base}/api/boards/${boardId}`, { headers: { Authorization: `Bearer ${otherToken}` } })).status === 403)
check('traversal in previews blocked', (await fetch(`${base}/p/..%2F..%2Fflipchart.db`)).status >= 400)
check('traversal in uploads blocked', (await fetch(`${base}/uploads/..%2F..%2Fflipchart.db`)).status >= 400)

// --- uploads + previews ---------------------------------------------------------
const png = Buffer.from(
	'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
		'05fe02fea7d4e2120000000049454e44ae426082', 'hex')

check('asset upload accepted',
	(await fetch(`${base}/api/uploads/test.png`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/png' }, body: png })).ok)
check('asset served back', (await fetch(`${base}/uploads/test.png`)).ok)

const before = boards.get(boardId).preview_version
check('preview accepted',
	(await fetch(`${base}/api/boards/${boardId}/preview`, { method: 'POST', headers: { ...auth, 'Content-Type': 'image/png' }, body: png })).status === 204)
check('preview version bumped', boards.get(boardId).preview_version === before + 1)
check('preview served', (await fetch(`${base}/p/${boardId}.png`)).ok)

const withPreview = renderBoard(boards.get(boardId))
check('board with a preview shows the image',
	withPreview.embeds[0].toJSON().image.url.includes(`/p/${boardId}.png?v=`))

const roToken = signToken({ b: boardId, k: bob, ro: true, exp: Date.now() + 60_000 })
check('read-only cannot post previews',
	(await fetch(`${base}/api/boards/${boardId}/preview`, {
		method: 'POST', headers: { Authorization: `Bearer ${roToken}`, 'Content-Type': 'image/png' }, body: png,
	})).status === 403)

// --- websocket sync -------------------------------------------------------------
const connect = (t, label) =>
	new Promise((resolve) => {
		const ws = new WebSocket(`ws://localhost:${config.port}/sync/${boardId}?t=${encodeURIComponent(t)}&sessionId=${label}`)
		ws.on('open', () => resolve({ ok: true, ws }))
		ws.on('error', () => resolve({ ok: false }))
		ws.on('unexpected-response', () => resolve({ ok: false }))
	})

const good = await connect(token, 'sess-a')
check('websocket accepts a valid token', good.ok)
check('websocket rejects a bad token', !(await connect('garbage', 'sess-b')).ok)

await new Promise((r) => setTimeout(r, 500))
check('board got its own sqlite file', existsSync(boardDbPath(boardId)))
check('connecting registered a contributor', boards.contributorCount(boardId) === 1)
check('contributor count reaches the embed',
	renderBoard(boards.get(boardId)).embeds[0].toJSON().footer.text.includes('1 contributor'))

// --- platform config resolution -------------------------------------------------
// config.js reads the environment once at import, so these run in subprocesses. They
// guard the Railway path, where getting the public URL wrong breaks every link silently.
function configUnder(env) {
	const result = spawnSync(
		process.execPath,
		['-e', 'import("./src/config.js").then(m => console.log(JSON.stringify(m.config)), e => console.log(JSON.stringify({ error: e.message })))'],
		{
			cwd: new URL('..', import.meta.url).pathname,
			encoding: 'utf8',
			env: { PATH: process.env.PATH, DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: '1', FLIPCHART_SECRET: 's', ...env },
		}
	)
	return JSON.parse(result.stdout.trim().split('\n').pop())
}

const railway = configUnder({
	PORT: '8080',
	RAILWAY_PUBLIC_DOMAIN: 'flipchart-production.up.railway.app',
	RAILWAY_VOLUME_MOUNT_PATH: '/data',
})
check('railway: public url derived from its domain', railway.publicUrl === 'https://flipchart-production.up.railway.app')
check('railway: injected PORT wins', railway.port === 8080)
check('railway: binds all interfaces', railway.host === '0.0.0.0')
check('railway: volume used for data', railway.dataDir === '/data')

const custom = configUnder({
	FLIPCHART_PUBLIC_URL: 'https://flipchart.example.com/',
	RAILWAY_PUBLIC_DOMAIN: 'ignored.up.railway.app',
})
check('explicit url beats the railway domain', custom.publicUrl === 'https://flipchart.example.com')

check('missing url fails loudly', configUnder({}).error?.includes('FLIPCHART_PUBLIC_URL'))

good.ws?.close()
server.close()
rmSync(dataDir, { recursive: true, force: true })

console.log(failures === 0 ? `\nall good — ${passes} checks.` : `\n${failures} failing.`)
process.exit(failures === 0 ? 0 : 1)
