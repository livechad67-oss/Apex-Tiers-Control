import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import {
  handleCloseQueue,
  handleJoinQueue,
  handleLeaveQueue,
  handleOpenQueue,
  handlePingQueue,
  handlePullPlayer,
} from "./handlers/buttons.js";
import { handleSetupControl } from "./handlers/commands.js";

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN) {
  console.error("DISCORD_TOKEN environment variable is required.");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("setupcontrol")
    .setDescription("Set up an Apex Tiers queue control panel in this channel.")
    .addStringOption((opt) =>
      opt
        .setName("name")
        .setDescription('Queue name (e.g. "sword waitlist")')
        .setRequired(true)
    )
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel where the player interface will be posted (defaults to this one)")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(null)
    .toJSON(),
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  const rest = new REST().setToken(TOKEN!);

  try {
    if (GUILD_ID) {
      console.log(`Registering slash commands to guild ${GUILD_ID}...`);
      await rest.put(
        Routes.applicationGuildCommands(readyClient.user.id, GUILD_ID),
        { body: commands }
      );
      console.log("Guild commands registered.");
    } else {
      console.log("Registering global slash commands (may take up to 1 hour to appear)...");
      await rest.put(Routes.applicationCommands(readyClient.user.id), {
        body: commands,
      });
      console.log("Global commands registered.");
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
});

client.on("interactionCreate", async (interaction: Interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleChatCommand(interaction);
  } else if (interaction.isButton()) {
    await handleButton(interaction);
  }
});

async function handleChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (interaction.commandName === "setupcontrol") {
      await handleSetupControl(interaction);
    }
  } catch (err) {
    console.error("Error handling command:", err);
    const msg = { content: "An error occurred while processing that command.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(console.error);
    } else {
      await interaction.reply(msg).catch(console.error);
    }
  }
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const [action, encodedName] = interaction.customId.split("::");

  if (!action || !encodedName) return;

  try {
    switch (action) {
      case "open_queue":
        await handleOpenQueue(interaction, encodedName);
        break;
      case "close_queue":
        await handleCloseQueue(interaction, encodedName);
        break;
      case "pull_player":
        await handlePullPlayer(interaction, encodedName);
        break;
      case "ping_queue":
        await handlePingQueue(interaction, encodedName);
        break;
      case "join_queue":
        await handleJoinQueue(interaction, encodedName);
        break;
      case "leave_queue":
        await handleLeaveQueue(interaction, encodedName);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error(`Error handling button [${interaction.customId}]:`, err);
    const msg = { content: "An error occurred while handling that button.", ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(console.error);
    } else {
      await interaction.reply(msg).catch(console.error);
    }
  }
}

client.login(TOKEN).catch((err) => {
  console.error("Failed to log in:", err);
  process.exit(1);
});
