import { Client, GatewayIntentBits } from 'discord.js'

// Guilds is the only intent needed, and it isn't privileged: the bot never reads message
// content and never enumerates members. Nothing to switch on in the Developer Portal.
export const client = new Client({ intents: [GatewayIntentBits.Guilds] })
