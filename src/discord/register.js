import { REST, Routes } from 'discord.js'
import { config } from '../config.js'
import { commands } from './bot.js'

/**
 * Pushes the slash command definitions to Discord. Idempotent — it's a PUT of the whole
 * set, so running it twice changes nothing.
 */
export async function registerCommands() {
	const rest = new REST().setToken(config.token)
	const body = commands.map((command) => command.data.toJSON())

	const route = config.guildId
		? Routes.applicationGuildCommands(config.clientId, config.guildId)
		: Routes.applicationCommands(config.clientId)

	await rest.put(route, { body })

	return {
		count: body.length,
		scope: config.guildId ? `guild ${config.guildId}` : 'globally',
	}
}
