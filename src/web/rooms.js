import Database from 'better-sqlite3'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { createTLSchema } from '@tldraw/tlschema'
import { config } from '../config.js'
import { boardDbPath } from '../db.js'

// One SQLite file per flipchart, under data/boards/. tldraw's own storage layer owns the
// schema inside it, which keeps a board's contents entirely separate from the bot's
// metadata database — a board can be copied, backed up or deleted as a single file.

const schema = createTLSchema()
const rooms = new Map()

function open(boardId) {
	const db = new Database(boardDbPath(boardId))
	db.pragma('journal_mode = WAL')

	const storage = new SQLiteSyncStorage({ sql: new NodeSqliteWrapper(db) })
	const entry = { db, unloadTimer: null }

	entry.room = new TLSocketRoom({
		schema,
		storage,
		onSessionRemoved(_room, { numSessionsRemaining }) {
			if (numSessionsRemaining === 0) scheduleUnload(boardId)
		},
	})

	rooms.set(boardId, entry)
	return entry
}

/** Loads the board into memory if it isn't already, and cancels any pending unload. */
export function getRoom(boardId) {
	const entry = rooms.get(boardId) ?? open(boardId)
	if (entry.unloadTimer) {
		clearTimeout(entry.unloadTimer)
		entry.unloadTimer = null
	}
	return entry.room
}

/**
 * Drop an idle board after a grace period. Every edit is already durable in SQLite by
 * this point; unloading just frees the memory, so a flipchart nobody has opened in a
 * week costs nothing to keep around.
 */
function scheduleUnload(boardId) {
	const entry = rooms.get(boardId)
	if (!entry || entry.unloadTimer) return

	entry.unloadTimer = setTimeout(() => {
		if (entry.room.getNumActiveSessions() > 0) {
			entry.unloadTimer = null
			return
		}
		entry.room.close()
		entry.db.close()
		rooms.delete(boardId)
	}, config.roomIdleMinutes * 60_000)

	entry.unloadTimer.unref?.()
}

export function activeSessionCount(boardId) {
	return rooms.get(boardId)?.room.getNumActiveSessions() ?? 0
}

/** Flush and release everything — called on shutdown so no board is left mid-write. */
export function closeAllRooms() {
	for (const [boardId, entry] of rooms) {
		clearTimeout(entry.unloadTimer)
		try {
			entry.room.close()
			entry.db.close()
		} catch {
			// Already closed; nothing to salvage.
		}
		rooms.delete(boardId)
	}
}
