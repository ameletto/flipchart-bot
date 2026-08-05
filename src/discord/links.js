import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js'
import { config } from '../config.js'
import { blocklist, boards } from '../db.js'
import { memberKey, participantKey, pseudonym, signToken } from '../identity.js'

/**
 * Mints a personal, signed link to a flipchart.
 *
 * The link is what carries identity, and it is only ever delivered in an ephemeral reply
 * — so the channel never learns who asked for one. The token goes in the URL *fragment*,
 * which browsers do not send to servers, keeping it out of access logs and referrers.
 */
export function buildLink(board, userId, { readonly = false } = {}) {
	const key = participantKey(board.id, userId)
	const { name, color } = pseudonym(key)

	const token = signToken({
		b: board.id,
		k: key,
		n: name,
		c: color,
		ro: readonly || Boolean(board.closed_at),
		exp: Date.now() + config.linkTtlMinutes * 60_000,
	})

	return { url: `${config.publicUrl}/b/${board.id}#t=${token}`, name, color }
}

/** The ephemeral message body that hands someone their link. */
export function linkPayload(board, userId, { readonly = false } = {}) {
	const viewOnly = readonly || Boolean(board.closed_at)
	const { url, name } = buildLink(board, userId, { readonly: viewOnly })

	const hours = Math.round(config.linkTtlMinutes / 60)
	const expiry = hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} hours`

	const body = viewOnly
		? `**${board.title}** — read-only.`
		: [
				`**${board.title}**`,
				`On this flipchart you are **${name}**. Nobody, including the bot, can connect that name to your account — and it's different on every flipchart.`,
				`Come back as often as you like; the board keeps everything.`,
			].join('\n\n')

	// No `flags` here on purpose: editReply() rejects MessageFlags.Ephemeral, since
	// ephemerality is fixed when the reply is first created. Callers add it to reply().
	return {
		content: `${body}\n\n-# This link is yours alone and works for the next ${expiry}. Don't share it.`,
		components: [
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setStyle(ButtonStyle.Link)
					.setURL(url)
					.setLabel(viewOnly ? 'Open read-only' : 'Open flipchart')
			),
		],
	}
}

/** True if this member has been blocked from contributing in this server. */
export function isBlocked(guildId, userId) {
	return blocklist.has(guildId, memberKey(guildId, userId))
}

/**
 * The single path by which anyone gets onto a board. Answers ephemerally in every case,
 * including the failures, so that clicking a flipchart button is never observable.
 */
export async function replyWithLink(interaction, boardId, { readonly = false } = {}) {
	const board = boards.get(boardId)
	if (!board || board.guild_id !== interaction.guildId) {
		return interaction.reply({
			content: "That flipchart doesn't exist any more.",
			flags: MessageFlags.Ephemeral,
		})
	}

	// A blocked member can still look, just not draw.
	const blocked = isBlocked(interaction.guildId, interaction.user.id)

	return interaction.reply({
		...linkPayload(board, interaction.user.id, { readonly: readonly || blocked }),
		flags: MessageFlags.Ephemeral,
	})
}
