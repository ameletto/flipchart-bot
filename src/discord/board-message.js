import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js'
import { config } from '../config.js'
import { boards } from '../db.js'
import { client } from './client.js'

const OPEN_COLOR = 0x4c8dd6
const CLOSED_COLOR = 0x6b7280

/**
 * The flipchart as it appears in the channel. The bot is always the author, so a board
 * posted anonymously carries no trace of who started it — the only attribution is
 * whatever the creator opted into.
 */
export function renderBoard(board) {
	const closed = Boolean(board.closed_at)
	const count = boards.contributorCount(board.id)

	const embed = new EmbedBuilder()
		.setColor(closed ? CLOSED_COLOR : OPEN_COLOR)
		.setTitle(`📋 ${board.title}`)

	if (board.preview_version > 0) {
		// The ?v= is what makes Discord fetch the new image instead of its cached copy.
		embed.setImage(`${config.publicUrl}/p/${board.id}.png?v=${board.preview_version}`)
		if (board.prompt) embed.setDescription(board.prompt)
	} else {
		const blank = '*Nothing on it yet — be the first.*'
		embed.setDescription(board.prompt ? `${board.prompt}\n\n${blank}` : blank)
	}

	const contributors = count === 1 ? '1 contributor' : `${count} contributors`
	embed.setFooter({
		text: closed
			? `Closed · ${contributors}`
			: `${contributors} · anyone here can add to it, anonymously`,
	})

	const buttons = new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`fc:open:${board.id}`)
			.setLabel(closed ? 'Closed' : 'Add to this flipchart')
			.setEmoji('🖊️')
			.setStyle(ButtonStyle.Primary)
			.setDisabled(closed),
		new ButtonBuilder()
			.setCustomId(`fc:view:${board.id}`)
			.setLabel('Just look')
			.setStyle(ButtonStyle.Secondary)
	)

	return { embeds: [embed], components: [buttons] }
}

/** Posts a new flipchart into its channel and records the message id for later edits. */
export async function publishBoard(board, { signedBy } = {}) {
	const channel = await client.channels.fetch(board.channel_id)
	const payload = renderBoard(board)

	if (signedBy) {
		payload.embeds[0].setFooter({
			text: `${payload.embeds[0].data.footer.text} · started by ${signedBy}`,
		})
	}

	const message = await channel.send(payload)
	boards.setMessageId(board.id, message.id)
	return message
}

/**
 * Re-renders a flipchart's message in place. Called on a timer as previews arrive, so it
 * has to tolerate the message having been deleted in the meantime.
 */
export async function refreshBoardMessage(boardId) {
	const board = boards.get(boardId)
	if (!board?.message_id) return

	try {
		const channel = await client.channels.fetch(board.channel_id)
		const message = await channel.messages.fetch(board.message_id)
		await message.edit(renderBoard(board))
	} catch (error) {
		// 10008 Unknown Message / 10003 Unknown Channel — someone tidied up. Stop trying.
		if (error.code === 10008 || error.code === 10003) {
			boards.setMessageId(boardId, null)
			return
		}
		throw error
	}
}
