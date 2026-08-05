import { registerCommands } from './register.js'

const { count, scope } = await registerCommands()

console.log(
	scope === 'globally'
		? `Registered ${count} command(s) globally — allow up to an hour for them to appear.`
		: `Registered ${count} command(s) to ${scope}.`
)

process.exit(0)
