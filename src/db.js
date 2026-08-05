import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

mkdirSync(join(config.dataDir, 'boards'), { recursive: true })
mkdirSync(join(config.dataDir, 'previews'), { recursive: true })
mkdirSync(join(config.dataDir, 'assets'), { recursive: true })

const db = new Database(join(config.dataDir, 'flipchart.db'))
db.pragma('journal_mode = WAL')

// Note what is deliberately absent: no Discord user IDs. `creator_key` and every row
// in `contributors` and `blocks` is a one-way HMAC — see src/identity.js.
db.exec(`
	CREATE TABLE IF NOT EXISTS boards (
		id               TEXT PRIMARY KEY,
		guild_id         TEXT NOT NULL,
		channel_id       TEXT NOT NULL,
		message_id       TEXT,
		title            TEXT NOT NULL,
		prompt           TEXT,
		creator_key      TEXT NOT NULL,
		created_at       INTEGER NOT NULL,
		closed_at        INTEGER,
		preview_version  INTEGER NOT NULL DEFAULT 0,
		last_activity_at INTEGER
	);

	CREATE TABLE IF NOT EXISTS contributors (
		board_id       TEXT NOT NULL,
		participant_key TEXT NOT NULL,
		first_seen_at  INTEGER NOT NULL,
		PRIMARY KEY (board_id, participant_key)
	);

	CREATE TABLE IF NOT EXISTS blocks (
		guild_id   TEXT NOT NULL,
		member_key TEXT NOT NULL,
		PRIMARY KEY (guild_id, member_key)
	);

	CREATE INDEX IF NOT EXISTS boards_by_channel ON boards (channel_id, closed_at);
`)

export function newBoardId() {
	return randomBytes(12).toString('base64url')
}

export function boardDbPath(boardId) {
	return join(config.dataDir, 'boards', `${boardId}.db`)
}

export function previewPath(boardId) {
	return join(config.dataDir, 'previews', `${boardId}.png`)
}

const statements = {
	insertBoard: db.prepare(`
		INSERT INTO boards (id, guild_id, channel_id, title, prompt, creator_key, created_at)
		VALUES (@id, @guildId, @channelId, @title, @prompt, @creatorKey, @createdAt)
	`),
	setMessageId: db.prepare(`UPDATE boards SET message_id = ? WHERE id = ?`),
	getBoard: db.prepare(`SELECT * FROM boards WHERE id = ?`),
	listOpen: db.prepare(`
		SELECT * FROM boards WHERE guild_id = ? AND closed_at IS NULL
		ORDER BY COALESCE(last_activity_at, created_at) DESC LIMIT ?
	`),
	closeBoard: db.prepare(`UPDATE boards SET closed_at = ? WHERE id = ?`),
	reopenBoard: db.prepare(`UPDATE boards SET closed_at = NULL WHERE id = ?`),
	touch: db.prepare(`UPDATE boards SET last_activity_at = ? WHERE id = ?`),
	bumpPreview: db.prepare(`
		UPDATE boards SET preview_version = preview_version + 1, last_activity_at = ? WHERE id = ?
	`),
	addContributor: db.prepare(`
		INSERT OR IGNORE INTO contributors (board_id, participant_key, first_seen_at) VALUES (?, ?, ?)
	`),
	countContributors: db.prepare(`SELECT COUNT(*) AS n FROM contributors WHERE board_id = ?`),
	block: db.prepare(`INSERT OR IGNORE INTO blocks (guild_id, member_key) VALUES (?, ?)`),
	unblock: db.prepare(`DELETE FROM blocks WHERE guild_id = ? AND member_key = ?`),
	isBlocked: db.prepare(`SELECT 1 FROM blocks WHERE guild_id = ? AND member_key = ?`),
}

export const boards = {
	create(board) {
		statements.insertBoard.run({ ...board, createdAt: Date.now() })
		return this.get(board.id)
	},
	get(id) {
		return statements.getBoard.get(id)
	},
	listOpen(guildId, limit = 20) {
		return statements.listOpen.all(guildId, limit)
	},
	setMessageId(id, messageId) {
		statements.setMessageId.run(messageId, id)
	},
	close(id) {
		statements.closeBoard.run(Date.now(), id)
	},
	reopen(id) {
		statements.reopenBoard.run(id)
	},
	touch(id) {
		statements.touch.run(Date.now(), id)
	},
	bumpPreview(id) {
		statements.bumpPreview.run(Date.now(), id)
	},
	addContributor(boardId, participantKey) {
		return statements.addContributor.run(boardId, participantKey, Date.now()).changes > 0
	},
	contributorCount(boardId) {
		return statements.countContributors.get(boardId).n
	},
}

export const blocklist = {
	add(guildId, key) {
		return statements.block.run(guildId, key).changes > 0
	},
	remove(guildId, key) {
		return statements.unblock.run(guildId, key).changes > 0
	},
	has(guildId, key) {
		return Boolean(statements.isBlocked.get(guildId, key))
	},
}

export default db
