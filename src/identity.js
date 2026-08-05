import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from './config.js'

// Anonymity model
// ---------------
// The bot never stores a Discord user ID next to anything a person drew. Instead it
// stores one-way HMACs:
//
//   participant key  HMAC(secret, "participant:<boardId>:<userId>")
//   member key       HMAC(secret, "member:<guildId>:<userId>")
//
// A participant key is scoped to a single board, so the same person is a stable
// pseudonym *within* one flipchart and unlinkable *across* two of them — even to
// whoever runs the server. Nothing can be reversed: to check whether a given member
// is blocked, or owns a board, we recompute their key from their ID and compare.
// That means moderation works without ever keeping a table that maps back to people.

// 128 bits of HMAC output, which is ample for identity and keeps signed links comfortably
// inside Discord's 512-character limit for button URLs.
function hmac(input) {
	return createHmac('sha256', config.secret).update(input).digest('hex').slice(0, 32)
}

/** Stable within one board, unlinkable across boards. */
export function participantKey(boardId, userId) {
	return hmac(`participant:${boardId}:${userId}`)
}

/** Stable within one server. Used for blocklists and board ownership only. */
export function memberKey(guildId, userId) {
	return hmac(`member:${guildId}:${userId}`)
}

const ADJECTIVES = [
	'amber', 'brisk', 'candid', 'dusky', 'eager', 'fleet', 'gentle', 'hazy',
	'idle', 'jaunty', 'keen', 'lucid', 'mellow', 'nimble', 'opal', 'plucky',
	'quiet', 'rustic', 'sunlit', 'tidal', 'umber', 'velvet', 'wry', 'zesty',
]

const ANIMALS = [
	'otter', 'heron', 'lynx', 'marten', 'finch', 'badger', 'ibex', 'plover',
	'weasel', 'grebe', 'stoat', 'kestrel', 'vole', 'shrike', 'tapir', 'wren',
	'gannet', 'pika', 'civet', 'osprey', 'dunlin', 'ferret', 'quail', 'raven',
]

/**
 * Derives a display name and cursor colour from a participant key. Deterministic, so
 * a person keeps the same identity across a week of visits to the same flipchart
 * without the bot storing anything about them.
 */
export function pseudonym(key) {
	const seed = Number.parseInt(key.slice(0, 12), 16)
	const adjective = ADJECTIVES[seed % ADJECTIVES.length]
	const animal = ANIMALS[Math.floor(seed / ADJECTIVES.length) % ANIMALS.length]
	const hue = Number.parseInt(key.slice(12, 16), 16) % 360
	return { name: `${adjective} ${animal}`, color: `hsl(${hue}, 68%, 45%)` }
}

function sign(body) {
	return createHmac('sha256', config.secret).update(body).digest('base64url')
}

/**
 * Mints the token that gates a websocket connection. It is handed out in an ephemeral
 * Discord reply, so only the person who clicked ever sees it.
 */
export function signToken(payload) {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
	return `${body}.${sign(body)}`
}

export function verifyToken(token) {
	if (typeof token !== 'string') return null
	const [body, signature] = token.split('.')
	if (!body || !signature) return null

	const expected = Buffer.from(sign(body))
	const actual = Buffer.from(signature)
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null

	let payload
	try {
		payload = JSON.parse(Buffer.from(body, 'base64url').toString())
	} catch {
		return null
	}
	if (typeof payload?.exp !== 'number' || payload.exp < Date.now()) return null
	return payload
}
