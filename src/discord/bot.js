import { Events, MessageFlags } from 'discord.js'
import { config } from '../config.js'
import { client } from './client.js'
import * as flipchart from './commands/flipchart.js'
import { replyWithLink } from './links.js'

// One command today. Adding another means dropping a module in commands/ that exports
// `data` and `execute`, listing it here, and re-running `npm run deploy`.
export const commands = [flipchart]

const byName = new Map(commands.map((command) => [command.data.name, command]))

client.once(Events.ClientReady, (ready) => {
	console.log(`flipchart bot ready as ${ready.user.tag}`)
})

client.on(Events.InteractionCreate, async (interaction) => {
	try {
		if (interaction.isAutocomplete()) {
			await byName.get(interaction.commandName)?.autocomplete?.(interaction)
			return
		}

		if (!interaction.guildId) {
			return interaction.reply({
				content: 'Flipcharts live in servers, not DMs.',
				flags: MessageFlags.Ephemeral,
			})
		}

		if (interaction.isChatInputCommand()) {
			await byName.get(interaction.commandName)?.execute(interaction)
			return
		}

		if (interaction.isButton()) {
			const [namespace, action, boardId] = interaction.customId.split(':')
			if (namespace !== 'fc') return
			await replyWithLink(interaction, boardId, { readonly: action === 'view' })
		}
	} catch (error) {
		console.error('[interaction]', error)

		const apology = {
			content: 'Something went wrong at my end. Try again in a moment.',
			flags: MessageFlags.Ephemeral,
		}
		try {
			if (interaction.isAutocomplete()) return
			if (interaction.deferred || interaction.replied) await interaction.followUp(apology)
			else await interaction.reply(apology)
		} catch {
			// The interaction token expired too; nothing more we can do.
		}
	}
})

export function startBot() {
	return client.login(config.token)
}
