import { useEffect, useMemo, useState } from 'react'
import { atom } from '@tldraw/state'
import { useSync } from '@tldraw/sync'
import { Tldraw, useEditor } from 'tldraw'
import 'tldraw/tldraw.css'

/** How long the canvas has to be quiet before we push a new preview to Discord. */
const PREVIEW_DEBOUNCE_MS = 6000

const socketBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

function Splash({ children }) {
	return (
		<div className="splash">
			<div className="splash-card">{children}</div>
		</div>
	)
}

export function Board({ boardId, token }) {
	const [state, setState] = useState({ status: 'loading' })

	useEffect(() => {
		if (!token) {
			setState({
				status: 'error',
				message: 'This page needs the private link the bot gave you. Run /flipchart link in Discord.',
			})
			return
		}

		let cancelled = false

		fetch(`/api/boards/${boardId}`, { headers: { Authorization: `Bearer ${token}` } })
			.then((response) => {
				if (response.status === 401) throw new Error('expired')
				if (!response.ok) throw new Error('missing')
				return response.json()
			})
			.then((board) => !cancelled && setState({ status: 'ready', board }))
			.catch((error) => {
				if (cancelled) return
				setState({
					status: 'error',
					message:
						error.message === 'expired'
							? 'That link has expired. Run /flipchart link in Discord for a fresh one.'
							: "That flipchart isn't here any more.",
				})
			})

		return () => {
			cancelled = true
		}
	}, [boardId, token])

	if (state.status === 'loading') return <Splash>Opening the flipchart…</Splash>
	if (state.status === 'error') return <Splash>{state.message}</Splash>
	return <Canvas boardId={boardId} token={token} board={state.board} />
}

function Canvas({ boardId, token, board }) {
	// tldraw takes the local user's identity as a signal. Everything in it is already
	// public to the room, and none of it can be traced back to a Discord account.
	const users = useMemo(
		() => ({
			currentUser: atom('currentUser', {
				id: `user:${board.you.id}`,
				typeName: 'user',
				name: board.you.name,
				color: board.you.color,
				imageUrl: '',
				meta: {},
			}),
		}),
		[board.you.id, board.you.name, board.you.color]
	)

	const assets = useMemo(() => createAssetStore(token), [token])

	const store = useSync({
		uri: `${socketBase()}/sync/${boardId}?t=${encodeURIComponent(token)}`,
		assets,
		users,
	})

	return (
		<div className="board">
			<header className="board-bar">
				<div className="board-titles">
					<h1>{board.title}</h1>
					{board.prompt && <p>{board.prompt}</p>}
				</div>
				<div className="board-who" style={{ borderColor: board.you.color }}>
					{board.readonly ? (
						<span className="board-readonly">Read-only</span>
					) : (
						<>
							<span className="board-dot" style={{ background: board.you.color }} />
							you are <strong>{board.you.name}</strong> here
						</>
					)}
				</div>
			</header>

			<div className="board-canvas">
				<Tldraw store={store} deepLinks={false}>
					{!board.readonly && <PreviewPublisher boardId={boardId} token={token} />}
				</Tldraw>
			</div>
		</div>
	)
}

/**
 * Renders the canvas to a PNG in the contributor's own browser and posts it to the bot,
 * which is what keeps the Discord message showing the current state. Doing it here rather
 * than server-side means no headless browser on the box.
 */
function PreviewPublisher({ boardId, token }) {
	const editor = useEditor()

	useEffect(() => {
		let timer
		let cancelled = false

		const publish = async () => {
			const ids = [...editor.getCurrentPageShapeIds()]
			if (ids.length === 0) return

			try {
				const { blob } = await editor.toImage(ids, {
					format: 'png',
					background: true,
					padding: 32,
					scale: 1,
				})
				if (cancelled) return

				await fetch(`/api/boards/${boardId}/preview`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
					body: blob,
				})
			} catch (error) {
				// A failed preview is cosmetic — the board itself is already saved.
				console.warn('[flipchart] preview upload failed:', error)
			}
		}

		const schedule = () => {
			clearTimeout(timer)
			timer = setTimeout(publish, PREVIEW_DEBOUNCE_MS)
		}

		// Once shortly after arriving, so a board someone drew on and abandoned still gets
		// its thumbnail, then after every lull in editing.
		timer = setTimeout(publish, 2500)
		const unlisten = editor.store.listen(schedule, { source: 'user', scope: 'document' })

		return () => {
			cancelled = true
			clearTimeout(timer)
			unlisten()
		}
	}, [editor, boardId, token])

	return null
}

function createAssetStore(token) {
	return {
		async upload(asset, file) {
			// Only the extension is kept. Original filenames leak more than people expect —
			// "screenshot-from-my-desk.png" or a real name in an exported chart.
			const extension = /\.[A-Za-z0-9]{1,8}$/.exec(file.name)?.[0]?.toLowerCase() ?? ''
			const id = `${crypto.randomUUID()}${extension}`

			const response = await fetch(`/api/uploads/${id}`, {
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': file.type || 'application/octet-stream',
				},
				body: file,
			})
			if (!response.ok) throw new Error(`upload failed (${response.status})`)

			const { url } = await response.json()
			return { src: url }
		},
	}
}
