import { config } from './config.js'
import { startBot } from './discord/bot.js'
import { registerCommands } from './discord/register.js'
import { closeAllRooms } from './web/rooms.js'
import { startWebServer } from './web/server.js'

// Registering before login, so a bad token fails here rather than halfway through boot.
if (config.syncCommands) {
	const { count, scope } = await registerCommands()
	console.log(`registered ${count} command(s) ${scope === 'globally' ? 'globally' : `to ${scope}`}`)
}

const server = await startWebServer()
await startBot()

console.log('flipchart up.')

let shuttingDown = false

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		if (shuttingDown) return
		shuttingDown = true

		console.log(`\n${signal} — flushing boards.`)
		// Rooms hold the only in-memory copy of very recent edits, so they close first.
		closeAllRooms()
		server.close(() => process.exit(0))
		setTimeout(() => process.exit(0), 5000).unref()
	})
}
