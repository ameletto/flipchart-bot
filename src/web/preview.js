import { writeFile } from 'node:fs/promises'
import { config } from '../config.js'
import { boards, previewPath } from '../db.js'
import { refreshBoardMessage } from '../discord/board-message.js'

// Contributors' browsers export the canvas to PNG and post it here, which is why the bot
// needs no headless browser of its own. Discord message edits are then rate-limited to
// one per FLIPCHART_PREVIEW_INTERVAL_SECONDS per board, so a busy afternoon of drawing
// doesn't turn into a burst of API calls.

const pending = new Map()

export async function savePreview(boardId, png) {
	await writeFile(previewPath(boardId), png)
	boards.bumpPreview(boardId)
	scheduleRefresh(boardId)
}

function scheduleRefresh(boardId) {
	const state = pending.get(boardId) ?? { lastSentAt: 0, timer: null }
	pending.set(boardId, state)
	if (state.timer) return

	const wait = Math.max(0, state.lastSentAt + config.previewIntervalSeconds * 1000 - Date.now())
	state.timer = setTimeout(async () => {
		state.timer = null
		state.lastSentAt = Date.now()
		try {
			await refreshBoardMessage(boardId)
		} catch (error) {
			console.error(`[preview] could not refresh ${boardId}:`, error.message)
		}
	}, wait)

	state.timer.unref?.()
}
