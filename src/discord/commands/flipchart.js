import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js'
import { blocklist, boards, newBoardId } from '../../db.js'
import { memberKey, participantKey } from '../../identity.js'
import { publishBoard, refreshBoardMessage } from '../board-message.js'
import { isBlocked, linkPayload, replyWithLink } from '../links.js'

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral })

export const data = new SlashCommandBuilder()
	.setName('flipchart')
	.setDescription('Shared whiteboards that people fill in over time')
	.addSubcommand((sub) =>
		sub
			.setName('new')
			.setDescription('Put a blank flipchart in this channel')
			.addStringOption((o) =>
				o.setName('title').setDescription('What the flipchart is for').setRequired(true).setMaxLength(200)
			)
			.addStringOption((o) =>
				o.setName('prompt').setDescription('A line of instructions for contributors').setMaxLength(500)
			)
			.addBooleanOption((o) =>
				o.setName('sign').setDescription('Show that you started it (default: no, it stays anonymous)')
			)
	)
	.addSubcommand((sub) =>
		sub.setName('list').setDescription('Flipcharts still open in this server')
	)
	.addSubcommand((sub) =>
		sub
			.setName('link')
			.setDescription('Get your private link to a flipchart')
			.addStringOption((o) =>
				o.setName('flipchart').setDescription('Which one').setRequired(true).setAutocomplete(true)
			)
	)
	.addSubcommand((sub) =>
		sub
			.setName('close')
			.setDescription('Stop a flipchart accepting changes')
			.addStringOption((o) =>
				o.setName('flipchart').setDescription('Which one').setRequired(true).setAutocomplete(true)
			)
	)
	.addSubcommand((sub) =>
		sub
			.setName('reopen')
			.setDescription('Let people add to a closed flipchart again')
			.addStringOption((o) =>
				o.setName('flipchart').setDescription('Which one').setRequired(true).setAutocomplete(true)
			)
	)
	.addSubcommand((sub) =>
		sub
			.setName('block')
			.setDescription('Stop someone contributing to flipcharts in this server')
			.addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
	)
	.addSubcommand((sub) =>
		sub
			.setName('unblock')
			.setDescription('Let someone contribute again')
			.addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
	)

export async function autocomplete(interaction) {
	const query = interaction.options.getFocused().toLowerCase()
	const open = boards.listOpen(interaction.guildId, 25)

	await interaction.respond(
		open
			.filter((board) => board.title.toLowerCase().includes(query))
			.slice(0, 25)
			.map((board) => ({ name: board.title.slice(0, 100), value: board.id }))
	)
}

export async function execute(interaction) {
	const subcommand = interaction.options.getSubcommand()

	if (subcommand === 'new') return createFlipchart(interaction)
	if (subcommand === 'list') return listFlipcharts(interaction)
	if (subcommand === 'link') return replyWithLink(interaction, interaction.options.getString('flipchart'))
	if (subcommand === 'close' || subcommand === 'reopen') return setClosed(interaction, subcommand === 'close')
	if (subcommand === 'block' || subcommand === 'unblock') return setBlocked(interaction, subcommand === 'block')
}

async function createFlipchart(interaction) {
	// Deferred and ephemeral: posting the flipchart takes a moment, and the channel must
	// never show that this command was run.
	await interaction.deferReply({ flags: MessageFlags.Ephemeral })

	if (isBlocked(interaction.guildId, interaction.user.id)) {
		return interaction.editReply({ content: "You can't start flipcharts in this server." })
	}

	const id = newBoardId()
	const board = boards.create({
		id,
		guildId: interaction.guildId,
		channelId: interaction.channelId,
		title: interaction.options.getString('title'),
		prompt: interaction.options.getString('prompt'),
		creatorKey: participantKey(id, interaction.user.id),
	})

	try {
		await publishBoard(board, {
			signedBy: interaction.options.getBoolean('sign') ? interaction.user.username : null,
		})
	} catch (error) {
		console.error('[flipchart] could not post board:', error)
		return interaction.editReply({
			content: "I couldn't post in this channel — check I have **Send Messages** and **Embed Links** here.",
		})
	}

	return interaction.editReply(linkPayload(board, interaction.user.id))
}

async function listFlipcharts(interaction) {
	const open = boards.listOpen(interaction.guildId)
	if (open.length === 0) {
		return interaction.reply(ephemeral('No flipcharts open right now. `/flipchart new` starts one.'))
	}

	const lines = open.map((board) => {
		const count = boards.contributorCount(board.id)
		const where = board.message_id
			? `https://discord.com/channels/${board.guild_id}/${board.channel_id}/${board.message_id}`
			: `<#${board.channel_id}>`
		return `**${board.title}** — ${count === 1 ? '1 contributor' : `${count} contributors`}\n${where}`
	})

	return interaction.reply(ephemeral(lines.join('\n\n').slice(0, 1900)))
}

async function setClosed(interaction, closing) {
	const board = boards.get(interaction.options.getString('flipchart'))
	if (!board || board.guild_id !== interaction.guildId) {
		return interaction.reply(ephemeral("That flipchart doesn't exist."))
	}

	// Ownership is checked by recomputing the creator's board-scoped key, so the bot can
	// verify "you started this" without ever having stored who that was.
	const isCreator = board.creator_key === participantKey(board.id, interaction.user.id)
	const isModerator = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)
	if (!isCreator && !isModerator) {
		return interaction.reply(
			ephemeral('Only whoever started this flipchart, or someone who can manage messages, can do that.')
		)
	}

	if (closing) boards.close(board.id)
	else boards.reopen(board.id)

	await refreshBoardMessage(board.id)
	return interaction.reply(
		ephemeral(closing ? `**${board.title}** is closed. It stays visible.` : `**${board.title}** is open again.`)
	)
}

async function setBlocked(interaction, blocking) {
	if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
		return interaction.reply(ephemeral('You need permission to manage messages to do that.'))
	}

	const user = interaction.options.getUser('user')
	const key = memberKey(interaction.guildId, user.id)
	const changed = blocking ? blocklist.add(interaction.guildId, key) : blocklist.remove(interaction.guildId, key)

	if (!changed) {
		return interaction.reply(ephemeral(blocking ? 'They were already blocked.' : "They weren't blocked."))
	}

	return interaction.reply(
		ephemeral(
			blocking
				? `${user.username} can no longer contribute to flipcharts here. Anything they already drew stays — it isn't attributed, so there is nothing to sweep up.`
				: `${user.username} can contribute again.`
		)
	)
}
