import http from 'http';
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is awake!');
}).listen(process.env.PORT || 8080, '0.0.0.0');
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  GuildMember,
  Interaction,
  ModalBuilder,
  ModalSubmitInteraction,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
} from "discord.js";

// ============================================================
// CONFIGURATION
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VERIFIED_TESTER_ROLE_NAME = "Verified Tester";

if (!TOKEN) {
  console.error("DISCORD_TOKEN environment variable is required.");
  process.exit(1);
}

// ============================================================
// IN-MEMORY QUEUE DATABASE
// ============================================================

interface QueuePlayer {
  id: string;
  username: string;
  displayName: string;
  mcUsername: string;
  region: string;
  preferredServer: string;
  tier: string;
}

interface QueueState {
  name: string;
  status: "open" | "closed";
  testerId: string;
  testerName: string;
  players: QueuePlayer[];
  controlPanelChannelId: string;
  controlPanelMessageId: string;
  // The PUBLIC channel where the player interface lives — never wiped, set once at /setupcontrol
  playerPanelChannelId: string | null;
  // The current player interface message — nulled when queue closes, set when it opens
  playerPanelMessageId: string | null;
  // The @everyone ping message — deleted when queue closes
  pingMessageId: string | null;
}

const queues = new Map<string, QueueState>();

function getQueue(name: string): QueueState | undefined {
  return queues.get(name);
}

function setQueue(name: string, state: QueueState): void {
  queues.set(name, state);
}

function createQueue(
  name: string,
  controlPanelChannelId: string,
  controlPanelMessageId: string,
  playerPanelChannelId: string
): QueueState {
  const state: QueueState = {
    name,
    status: "closed",
    testerId: "",
    testerName: "",
    players: [],
    controlPanelChannelId,
    controlPanelMessageId,
    playerPanelChannelId,
    playerPanelMessageId: null,
    pingMessageId: null,
  };
  queues.set(name, state);
  return state;
}

function addPlayer(name: string, player: QueuePlayer): boolean {
  const queue = queues.get(name);
  if (!queue) return false;
  if (queue.players.some((p) => p.id === player.id)) return false;
  queue.players.push(player);
  return true;
}

function removePlayer(name: string, playerId: string): boolean {
  const queue = queues.get(name);
  if (!queue) return false;
  const index = queue.players.findIndex((p) => p.id === playerId);
  if (index === -1) return false;
  queue.players.splice(index, 1);
  return true;
}

function pullFirstPlayer(name: string): QueuePlayer | null {
  const queue = queues.get(name);
  if (!queue || queue.players.length === 0) return null;
  return queue.players.shift() ?? null;
}

// ============================================================
// EMBED & BUTTON BUILDERS
// ============================================================

const OPEN_COLOR = 0x2ecc71;
const CLOSED_COLOR = 0xe74c3c;
const PLAYER_COLOR = 0x3498db;
const OFFLINE_COLOR = 0x95a5a6;

function encodeQueueId(name: string): string {
  return name.replace(/:/g, "\u2236");
}

function decodeQueueId(id: string): string {
  return id.replace(/\u2236/g, ":");
}

function buildControlPanelEmbed(queue: QueueState): EmbedBuilder {
  const isOpen = queue.status === "open";
  return new EmbedBuilder()
    .setTitle(`⚙️ ${queue.name} — Control Panel`)
    .setColor(isOpen ? OPEN_COLOR : CLOSED_COLOR)
    .addFields(
      { name: "Status", value: isOpen ? "🟢 Open" : "🔴 Closed", inline: true },
      { name: "Active Tester", value: isOpen && queue.testerName ? queue.testerName : "None", inline: true },
      { name: "Players in Queue", value: String(queue.players.length), inline: true }
    )
    .setFooter({ text: "Apex Tiers — Staff Control Panel" })
    .setTimestamp();
}

function buildControlPanelButtons(queueName: string): ActionRowBuilder<ButtonBuilder> {
  const id = encodeQueueId(queueName);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`open_queue::${id}`).setLabel("Open Queue").setStyle(ButtonStyle.Success).setEmoji("🟢"),
    new ButtonBuilder().setCustomId(`close_queue::${id}`).setLabel("Close Queue").setStyle(ButtonStyle.Danger).setEmoji("🔴"),
    new ButtonBuilder().setCustomId(`pull_player::${id}`).setLabel("Pull Player").setStyle(ButtonStyle.Primary).setEmoji("⬆️"),
    new ButtonBuilder().setCustomId(`ping_queue::${id}`).setLabel("Ping Queue").setStyle(ButtonStyle.Secondary).setEmoji("🔔")
  );
}

function buildPlayerInterfaceEmbed(queue: QueueState): EmbedBuilder {
  const isOpen = queue.status === "open";

  let playerList = "No players in queue.";
  if (queue.players.length > 0) {
    playerList = queue.players
      .map((p, i) =>
        `**#${i + 1} ${p.displayName}**\n` +
        `⚔️ MC: \`${p.mcUsername}\` · 🌍 ${p.region} · 🖥️ ${p.preferredServer} · 📊 ${p.tier}`
      )
      .join("\n\n");
  }

  return new EmbedBuilder()
    .setTitle(`🎮 ${queue.name}`)
    .setColor(isOpen ? PLAYER_COLOR : OFFLINE_COLOR)
    .setDescription(
      isOpen
        ? `**Active Tester:** ${queue.testerName}\n\n**Queue:**\n${playerList}`
        : "No testers are online right now."
    )
    .addFields(
      { name: "Status", value: isOpen ? "🟢 Open" : "🔴 Closed", inline: true },
      { name: "Waiting", value: String(queue.players.length), inline: true }
    )
    .setFooter({ text: "Apex Tiers • Join the queue below" })
    .setTimestamp();
}

function buildPlayerInterfaceButtons(queueName: string): ActionRowBuilder<ButtonBuilder> {
  const id = encodeQueueId(queueName);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`join_queue::${id}`).setLabel("Join Queue").setStyle(ButtonStyle.Success).setEmoji("✅"),
    new ButtonBuilder().setCustomId(`leave_queue::${id}`).setLabel("Leave Queue").setStyle(ButtonStyle.Danger).setEmoji("❌")
  );
}

function buildOfflineEmbed(queueName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`🎮 ${queueName}`)
    .setColor(OFFLINE_COLOR)
    .setDescription("No testers are online right now.\nCheck back later!")
    .setFooter({ text: "Apex Tiers" })
    .setTimestamp();
}

function buildJoinModal(queueName: string): ModalBuilder {
  const id = encodeQueueId(queueName);
  return new ModalBuilder()
    .setCustomId(`join_modal::${id}`)
    .setTitle("Join Queue — Player Info")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("mc_username")
          .setLabel("Minecraft Username")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. Steve")
          .setRequired(true)
          .setMaxLength(32)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("region")
          .setLabel("Region")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. NA, EU, AS, OCE")
          .setRequired(true)
          .setMaxLength(20)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("preferred_server")
          .setLabel("Preferred Server")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. Hypixel, Minemen, PotPvP")
          .setRequired(true)
          .setMaxLength(50)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("tier")
          .setLabel("Current Tier")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. HT1, HT2, LT1, LT2, Unranked")
          .setRequired(true)
          .setMaxLength(20)
      )
    );
}

// ============================================================
// PERMISSION CHECK
// ============================================================

function isStaffMember(member: GuildMember | null): boolean {
  if (!member) return false;
  if (member.permissions.has("Administrator")) return true;
  return member.roles.cache.some((r) => r.name === VERIFIED_TESTER_ROLE_NAME);
}

// ============================================================
// HELPERS — refresh remote messages (client-based, usable from any context)
// ============================================================

async function refreshPlayerPanel(client: Client, queueName: string): Promise<void> {
  const queue = getQueue(queueName);
  if (!queue?.playerPanelMessageId || !queue?.playerPanelChannelId) return;
  try {
    const channel = await client.channels.fetch(queue.playerPanelChannelId);
    if (!channel || !(channel instanceof TextChannel)) return;
    const msg = await channel.messages.fetch(queue.playerPanelMessageId);
    await msg.edit({
      embeds: [buildPlayerInterfaceEmbed(queue)],
      components: queue.status === "open" ? [buildPlayerInterfaceButtons(queue.name)] : [],
    });
  } catch { }
}

async function refreshControlPanel(client: Client, queueName: string): Promise<void> {
  const queue = getQueue(queueName);
  if (!queue?.controlPanelMessageId || !queue?.controlPanelChannelId) return;
  try {
    const channel = await client.channels.fetch(queue.controlPanelChannelId);
    if (!channel || !(channel instanceof TextChannel)) return;
    const msg = await channel.messages.fetch(queue.controlPanelMessageId);
    await msg.edit({ embeds: [buildControlPanelEmbed(queue)] });
  } catch { }
}

// ============================================================
// COMMAND HANDLER — /setupcontrol
// ============================================================

async function handleSetupControl(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({
      content: "You need the **Verified Tester** role or Administrator permission to use this command.",
      ephemeral: true,
    });
    return;
  }

  const queueName = interaction.options.getString("name", true);
  const targetChannel =
    (interaction.options.getChannel("channel") as TextChannel | null) ??
    (interaction.channel as TextChannel);

  if (!targetChannel) {
    await interaction.reply({ content: "Could not resolve the queue channel.", ephemeral: true });
    return;
  }

  if (getQueue(queueName)) {
    await interaction.reply({
      content: `A queue named **${queueName}** already exists. Close and re-create it if needed.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const stub = createQueue(queueName, interaction.channelId, "", targetChannel.id);
  const controlMsg = await (interaction.channel as TextChannel).send({
    embeds: [buildControlPanelEmbed(stub)],
    components: [buildControlPanelButtons(queueName)],
  });

  stub.controlPanelMessageId = controlMsg.id;
  stub.controlPanelChannelId = controlMsg.channelId;
  setQueue(queueName, stub);

  await interaction.editReply({
    content: `✅ Control panel for **${queueName}** is ready! Player interface will post to ${targetChannel} when you open the queue.`,
  });
}

// ============================================================
// BUTTON HANDLERS
// ============================================================

async function handleOpenQueue(interaction: ButtonInteraction, encodedName: string): Promise<void> {
  const queueName = decodeQueueId(encodedName);

  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({ content: "You need the **Verified Tester** role or Administrator permission to do that.", ephemeral: true });
    return;
  }

  const queue = getQueue(queueName);
  if (!queue) { await interaction.reply({ content: "Queue not found.", ephemeral: true }); return; }
  if (queue.status === "open") { await interaction.reply({ content: "Queue is already open.", ephemeral: true }); return; }
  if (!queue.playerPanelChannelId) { await interaction.reply({ content: "No player channel configured. Please run `/setupcontrol` again.", ephemeral: true }); return; }

  const member = interaction.member as GuildMember;
  queue.status = "open";
  queue.testerId = interaction.user.id;
  queue.testerName = member.displayName;
  queue.players = [];
  queue.playerPanelMessageId = null;
  queue.pingMessageId = null;
  setQueue(queueName, queue);

  await interaction.update({ embeds: [buildControlPanelEmbed(queue)] });

  const publicChannel = await interaction.client.channels.fetch(queue.playerPanelChannelId) as TextChannel;

  // Send @everyone ping and store the message ID so we can delete it on close
  const pingMsg = await publicChannel.send({
    content: `@everyone The **${queueName}** queue is now **open**! 🟢 Tester: **${queue.testerName}**`,
  });
  queue.pingMessageId = pingMsg.id;

  // Edit the existing player interface message if it exists, otherwise post a new one
  // This prevents a new "offline" message piling up every time the queue cycles
  if (queue.playerPanelMessageId) {
    try {
      const existing = await publicChannel.messages.fetch(queue.playerPanelMessageId);
      await existing.edit({
        embeds: [buildPlayerInterfaceEmbed(queue)],
        components: [buildPlayerInterfaceButtons(queueName)],
      });
    } catch {
      // Message was deleted externally — send a fresh one
      const playerMsg = await publicChannel.send({
        embeds: [buildPlayerInterfaceEmbed(queue)],
        components: [buildPlayerInterfaceButtons(queueName)],
      });
      queue.playerPanelMessageId = playerMsg.id;
    }
  } else {
    const playerMsg = await publicChannel.send({
      embeds: [buildPlayerInterfaceEmbed(queue)],
      components: [buildPlayerInterfaceButtons(queueName)],
    });
    queue.playerPanelMessageId = playerMsg.id;
  }

  setQueue(queueName, queue);
}

async function handleCloseQueue(interaction: ButtonInteraction, encodedName: string): Promise<void> {
  const queueName = decodeQueueId(encodedName);

  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({ content: "You need the **Verified Tester** role or Administrator permission to do that.", ephemeral: true });
    return;
  }

  const queue = getQueue(queueName);
  if (!queue) { await interaction.reply({ content: "Queue not found.", ephemeral: true }); return; }

  // Snapshot IDs we need to clean up BEFORE wiping state
  const prevPlayerChannelId = queue.playerPanelChannelId; // Keep the channel reference — needed to re-open later
  const prevPlayerMessageId = queue.playerPanelMessageId;
  const prevPingMessageId = queue.pingMessageId;

  queue.status = "closed";
  queue.testerId = "";
  queue.testerName = "";
  queue.players = [];
  queue.pingMessageId = null;
  // NOTE: playerPanelChannelId and playerPanelMessageId are intentionally NOT wiped —
  // they persist so re-open edits the existing message instead of posting a new one
  setQueue(queueName, queue);

  await interaction.update({ embeds: [buildControlPanelEmbed(queue)] });

  if (prevPlayerChannelId) {
    try {
      const ch = await interaction.client.channels.fetch(prevPlayerChannelId) as TextChannel;

      // Delete the @everyone ping message
      if (prevPingMessageId) {
        try {
          const pingMsg = await ch.messages.fetch(prevPingMessageId);
          await pingMsg.delete();
        } catch { }
      }

      // Update the player interface to "offline"
      if (prevPlayerMessageId) {
        try {
          const playerMsg = await ch.messages.fetch(prevPlayerMessageId);
          await playerMsg.edit({ embeds: [buildOfflineEmbed(queueName)], components: [] });
        } catch { }
      }
    } catch { }
  }
}

async function handlePullPlayer(interaction: ButtonInteraction, encodedName: string): Promise<void> {
  const queueName = decodeQueueId(encodedName);

  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({ content: "You need the **Verified Tester** role or Administrator permission to do that.", ephemeral: true });
    return;
  }

  const queue = getQueue(queueName);
  if (!queue) { await interaction.reply({ content: "Queue not found.", ephemeral: true }); return; }
  if (queue.status !== "open") { await interaction.reply({ content: "Queue is not open.", ephemeral: true }); return; }

  const player = pullFirstPlayer(queueName);
  if (!player) { await interaction.reply({ content: "No players in the queue.", ephemeral: true }); return; }

  setQueue(queueName, queue);
  await interaction.update({ embeds: [buildControlPanelEmbed(queue)] });
  await refreshPlayerPanel(interaction.client, queueName);

  const publicChannel = await interaction.client.channels.fetch(queue.playerPanelChannelId!) as TextChannel;

  try {
    const thread = await publicChannel.threads.create({
      name: `test-${player.username}`.slice(0, 100),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      type: ChannelType.PrivateThread,
      reason: `Apex Tiers test session for ${player.username}`,
    });
    await thread.members.add(queue.testerId);
    await thread.members.add(player.id);

    const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("close_thread")
        .setLabel("Close Thread")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("🔒")
    );

    await thread.send({
      content:
        `Hey <@${player.id}>! You've been pulled from the **${queueName}** queue.\n` +
        `Your tester is <@${queue.testerId}>. Get ready! ⚔️\n\n` +
        `📋 **Player Info:**\n` +
        `⚔️ MC Username: \`${player.mcUsername}\`\n` +
        `🌍 Region: ${player.region}\n` +
        `🖥️ Preferred Server: ${player.preferredServer}\n` +
        `📊 Tier: ${player.tier}`,
      components: [closeRow],
    });
  } catch (err) {
    console.error("Failed to create private thread:", err);
    await interaction.followUp({
      content: `Pulled **${player.displayName}** but could not create a private thread. Check that the bot has the correct permissions.`,
      ephemeral: true,
    });
  }
}

async function handlePingQueue(interaction: ButtonInteraction, encodedName: string): Promise<void> {
  const queueName = decodeQueueId(encodedName);

  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({ content: "You need the **Verified Tester** role or Administrator permission to do that.", ephemeral: true });
    return;
  }

  const queue = getQueue(queueName);
  if (!queue) { await interaction.reply({ content: "Queue not found.", ephemeral: true }); return; }
  if (queue.players.length === 0) { await interaction.reply({ content: "No players in the queue to ping.", ephemeral: true }); return; }

  const mentions = queue.players.map((p) => `<@${p.id}>`).join(" ");
  const publicChannel = await interaction.client.channels.fetch(queue.playerPanelChannelId!) as TextChannel;

  await publicChannel.send({
    content: `🔔 Attention queue members for **${queueName}**: ${mentions}\nYour tester **${queue.testerName}** is still active — get ready!`,
    allowedMentions: { users: queue.players.map((p) => p.id) },
  });

  await interaction.reply({ content: "✅ Pinged all players in the queue.", ephemeral: true });
}

// Shows the modal — the actual joining happens in handleJoinQueueModal
async function handleJoinQueue(interaction: ButtonInteraction, encodedName: string): Promise<void> {
  const queueName = decodeQueueId(encodedName);
  const queue = getQueue(queueName);

  if (!queue) { await interaction.reply({ content: "Queue not found.", ephemeral: true }); return; }
  if (queue.status !== "open") { await interaction.reply({ content: "This queue is currently closed.", ephemeral: true }); return; }
  if (queue.players.some((p) => p.id === interaction.user.id)) {
    await interaction.reply({ content: "You're already in the queue!", ephemeral: true });
    return;
  }

  await interaction.showModal(buildJoinModal(queueName));
}

async function handleLeaveQueue(interaction: ButtonInteraction, encodedName: string): Promise<void> {
  const queueName = decodeQueueId(encodedName);
  const queue = getQueue(queueName);

  if (!queue) { await interaction.reply({ content: "Queue not found.", ephemeral: true }); return; }

  const removed = removePlayer(queueName, interaction.user.id);
  if (!removed) { await interaction.reply({ content: "You're not in the queue.", ephemeral: true }); return; }

  await interaction.update({
    embeds: [buildPlayerInterfaceEmbed(queue)],
    components: [buildPlayerInterfaceButtons(queueName)],
  });

  await refreshControlPanel(interaction.client, queueName);
}

async function handleCloseThread(interaction: ButtonInteraction): Promise<void> {
  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({ content: "Only **Verified Testers** can close threads.", ephemeral: true });
    return;
  }

  const thread = interaction.channel;
  if (!thread || !thread.isThread()) {
    await interaction.reply({ content: "This button can only be used inside a thread.", ephemeral: true });
    return;
  }

  await interaction.reply({ content: "🔒 Test session complete. Thread closed." });
  await thread.setArchived(true);
}

// ============================================================
// MODAL SUBMIT HANDLER — Join Queue form
// ============================================================

async function handleJoinQueueModal(interaction: ModalSubmitInteraction): Promise<void> {
  const encodedName = interaction.customId.split("::")[1];
  if (!encodedName) { await interaction.reply({ content: "Something went wrong.", ephemeral: true }); return; }

  const queueName = decodeQueueId(encodedName);
  const queue = getQueue(queueName);

  if (!queue) { await interaction.reply({ content: "Queue not found.", ephemeral: true }); return; }
  if (queue.status !== "open") { await interaction.reply({ content: "The queue closed while you were filling in the form.", ephemeral: true }); return; }

  const mcUsername = interaction.fields.getTextInputValue("mc_username").trim();
  const region = interaction.fields.getTextInputValue("region").trim();
  const preferredServer = interaction.fields.getTextInputValue("preferred_server").trim();
  const tier = interaction.fields.getTextInputValue("tier").trim();

  const member = interaction.member as GuildMember;
  const added = addPlayer(queueName, {
    id: interaction.user.id,
    username: interaction.user.username,
    displayName: member.displayName,
    mcUsername,
    region,
    preferredServer,
    tier,
  });

  if (!added) {
    await interaction.reply({ content: "You're already in the queue!", ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `✅ You've joined the **${queueName}** queue!\n📋 **Your info:** MC: \`${mcUsername}\` · ${region} · ${preferredServer} · ${tier}`,
    ephemeral: true,
  });

  // Update both panels from the client since modal submits can't call .update()
  await refreshPlayerPanel(interaction.client, queueName);
  await refreshControlPanel(interaction.client, queueName);
}

// ============================================================
// DISCORD CLIENT & EVENT ROUTING
// ============================================================

const commands = [
  new SlashCommandBuilder()
    .setName("setupcontrol")
    .setDescription("Set up an Apex Tiers queue control panel in this channel.")
    .addStringOption((opt) =>
      opt.setName("name").setDescription('Queue name (e.g. "sword waitlist")').setRequired(true)
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
      await rest.put(Routes.applicationGuildCommands(readyClient.user.id, GUILD_ID), { body: commands });
      console.log("Guild commands registered.");
    } else {
      console.log("Registering global slash commands (may take up to 1 hour to appear)...");
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands });
      console.log("Global commands registered.");
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
});

client.on("interactionCreate", async (interaction: Interaction) => {
  // ── Slash commands ──────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
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

  // ── Modal submits ───────────────────────────────────────────
  } else if (interaction.isModalSubmit()) {
    try {
      if (interaction.customId.startsWith("join_modal::")) {
        await handleJoinQueueModal(interaction);
      }
    } catch (err) {
      console.error("Error handling modal:", err);
      const msg = { content: "An error occurred while processing your submission.", ephemeral: true };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(msg).catch(console.error);
      } else {
        await interaction.reply(msg).catch(console.error);
      }
    }

  // ── Button clicks ───────────────────────────────────────────
  } else if (interaction.isButton()) {
    const [action, encodedName] = interaction.customId.split("::");

    try {
      switch (action) {
        case "open_queue":   await handleOpenQueue(interaction, encodedName!); break;
        case "close_queue":  await handleCloseQueue(interaction, encodedName!); break;
        case "pull_player":  await handlePullPlayer(interaction, encodedName!); break;
        case "ping_queue":   await handlePingQueue(interaction, encodedName!); break;
        case "join_queue":   await handleJoinQueue(interaction, encodedName!); break;
        case "leave_queue":  await handleLeaveQueue(interaction, encodedName!); break;
        case "close_thread": await handleCloseThread(interaction); break;
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
});

client.login(TOKEN).catch((err) => {
  console.error("Failed to log in:", err);
  process.exit(1);
});
