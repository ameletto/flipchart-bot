import 'dotenv/config'

function required(name, hint) {
	const value = process.env[name]
	if (!value) {
		throw new Error(`${name} is not set — copy .env.example to .env and fill it in.${hint ? ` ${hint}` : ''}`)
	}
	return value
}

/**
 * Where people reach the whiteboard, e.g. https://flipchart.example.com
 *
 * On Railway the domain isn't known until after the first deploy, so there is no way to
 * set FLIPCHART_PUBLIC_URL up front — fall back to the domain Railway injects. An explicit
 * value always wins, which is what a custom domain needs.
 */
function resolvePublicUrl() {
	const explicit = process.env.FLIPCHART_PUBLIC_URL
	if (explicit) return explicit.replace(/\/+$/, '')

	if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`

	throw new Error(
		'FLIPCHART_PUBLIC_URL is not set — copy .env.example to .env and fill it in. ' +
			'It must be the public address contributors will open in a browser.'
	)
}

export const config = {
	token: required('DISCORD_TOKEN'),
	clientId: required('DISCORD_CLIENT_ID'),
	guildId: process.env.DISCORD_GUILD_ID || '',

	publicUrl: resolvePublicUrl(),
	/** Signs contribution links and derives every pseudonym. Rotating it logs everyone out. */
	secret: required('FLIPCHART_SECRET', 'Generate one with: openssl rand -hex 32'),

	// Railway and most other platforms inject PORT and expect the app to bind it on all
	// interfaces. FLIPCHART_PORT stays as the local override.
	port: Number(process.env.PORT || process.env.FLIPCHART_PORT || 3000),
	host: process.env.FLIPCHART_HOST || '0.0.0.0',

	// RAILWAY_VOLUME_MOUNT_PATH is set automatically when a volume is attached. Without a
	// volume, a deploy would quietly reset every flipchart, so this is worth getting right.
	dataDir: process.env.FLIPCHART_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || './data',

	/**
	 * Register slash commands on boot. Handy on a platform where running a one-off command
	 * is awkward; locally `npm run deploy` is the better habit.
	 */
	syncCommands: process.env.FLIPCHART_SYNC_COMMANDS === 'true',

	/** How long a personal contribution link stays valid. */
	linkTtlMinutes: Number(process.env.FLIPCHART_LINK_TTL_MINUTES || 60 * 24 * 7),
	/** Minimum gap between edits to a flipchart's Discord message. */
	previewIntervalSeconds: Number(process.env.FLIPCHART_PREVIEW_INTERVAL_SECONDS || 90),
	/** How long an empty room stays in memory before its snapshot is flushed and unloaded. */
	roomIdleMinutes: Number(process.env.FLIPCHART_ROOM_IDLE_MINUTES || 10),
	/** Hard ceiling on an uploaded preview or pasted image, in megabytes. */
	maxUploadMb: Number(process.env.FLIPCHART_MAX_UPLOAD_MB || 8),
}

if (!config.publicUrl.startsWith('http')) {
	throw new Error(`FLIPCHART_PUBLIC_URL must start with http:// or https:// (got "${config.publicUrl}")`)
}

/** wss:// for https:// deployments, ws:// for a plain-http local run. */
export const websocketUrl = config.publicUrl.replace(/^http/, 'ws')
