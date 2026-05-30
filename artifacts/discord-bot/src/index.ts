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
  OverwriteType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

// ============================================================
// CONFIGURATION
// ============================================================

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VERIFIED_TESTER_ROLE_NAME = "Verified Tester";
const RESULTS_CHANNEL_NAME = "🏆・results";

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
  tier: string; // previous tier submitted by player
}

interface QueueState {
  name: string;
  status: "open" | "closed";
  testerId: string;
  testerName: string;
  players: QueuePlayer[];
  controlPanelChannelId: string;
  controlPanelMessageId: string;
  // PUBLIC channel — set once at /setupcontrol, never wiped
  playerPanelChannelId: string | null;
  // The CURRENT player interface message (open embed or offline embed)
  // Deleted and re-posted every open/close cycle so there's always exactly one message
  playerPanelMessageId: string | null;
  // The @everyone ping — deleted when queue closes
  pingMessageId: string | null;
}

interface TicketData {
  playerId: string;
  playerMcUsername: string;
  playerRegion: string;
  playerPreferredServer: string;
  playerPreviousTier: string;
  testerId: string;
  testerName: string;
  queueName: string;
}

const queues = new Map<string, QueueState>();
const tickets = new Map<string, TicketData>(); // key = ticket channelId

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
const TICKET_COLOR = 0x9b59b6;
const RESULTS_COLOR = 0xf39c12;

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
  let playerList = "No players in queue.";
  if (queue.players.length > 0) {
    // Show ONLY the mention — no private details visible in public channel
    playerList = queue.players
      .map((p, i) => `**#${i + 1}** <@${p.id}>`)
      .join("\n");
  }

  return new EmbedBuilder()
    .setTitle(`🎮 ${queue.name}`)
    .setColor(PLAYER_COLOR)
    .setDescription(`**Active Tester:** ${queue.testerName}\n\n**Queue:**\n${playerList}`)
    .addFields(
      { name: "Status", value: "🟢 Open", inline: true },
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
          .setLabel("Current Tier (your rank before this test)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("e.g. HT1, HT2, LT1, Unranked")
          .setRequired(true)
          .setMaxLength(20)
      )
    );
}

function buildGiveResultModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("give_result_modal")
    .setTitle("Give Result")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("earned_tier")
          .setLabel("Rank Earned (e.g. Crystal HT4, Sword LT2)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("gamemode")
          .setLabel("Gamemode (e.g. Sword, Crystal, SMP)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50)
      )
    );
}

function buildTicketButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("give_result")
      .setLabel("Give Result")
      .setStyle(ButtonStyle.Success)
      .setEmoji("🏆"),
    new ButtonBuilder()
      .setCustomId("close_ticket")
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔒")
  );
}

function buildResultsEmbed(data: TicketData, earnedTier: string, gamemode: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${data.playerMcUsername}'s Test Results 🏆`)
    .setColor(RESULTS_COLOR)
    .addFields(
      { name: "Tester:", value: `<@${data.testerId}>`, inline: false },
      { name: "Region:", value: data.playerRegion, inline: false },
      { name: "Gamemode:", value: gamemode, inline: false },
      { name: "Username:", value: data.playerMcUsername, inline: false },
      { name: "Previous Rank:", value: data.playerPreviousTier, inline: false },
      { name: "Rank Earned:", value: earnedTier, inline: false }
    )
    .setTimestamp();
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
// HELPERS — refresh remote messages
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
      components: [buildPlayerInterfaceButtons(queue.name)],
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

// Delete a message safely (ignores errors if already deleted)
async function tryDeleteMessage(channel: TextChannel, messageId: string | null): Promise<void> {
  if (!messageId) return;
  try {
    const msg = await channel.messages.fetch(messageId);
    await msg.delete();
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

  await interaction.update({ embeds: [buildControlPanelEmbed(queue)] });

  const publicChannel = await interaction.client.channels.fetch(queue.playerPanelChannelId) as TextChannel;

  // Delete the old offline embed (from previous close) — ensures only one message exists
  await tryDeleteMessage(publicChannel, queue.playerPanelMessageId);
  queue.playerPanelMessageId = null;

  // Send @everyone ping
  const pingMsg = await publicChannel.send({
    content: `@everyone The **${queueName}** queue is now **open**! 🟢 Tester: **${queue.testerName}**`,
  });
  queue.pingMessageId = pingMsg.id;

  // Post fresh open embed
  const playerMsg = await publicChannel.send({
    embeds: [buildPlayerInterfaceEmbed(queue)],
    components: [buildPlayerInterfaceButtons(queueName)],
  });
  queue.playerPanelMessageId = playerMsg.id;

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

  const prevPlayerChannelId = queue.playerPanelChannelId;
  const prevPlayerMessageId = queue.playerPanelMessageId;
  const prevPingMessageId = queue.pingMessageId;

  queue.status = "closed";
  queue.testerId = "";
  queue.testerName = "";
  queue.players = [];
  queue.playerPanelMessageId = null;
  queue.pingMessageId = null;

  await interaction.update({ embeds: [buildControlPanelEmbed(queue)] });

  if (prevPlayerChannelId) {
    try {
      const ch = await interaction.client.channels.fetch(prevPlayerChannelId) as TextChannel;

      // Delete the @everyone ping
      await tryDeleteMessage(ch, prevPingMessageId);

      // Delete the open embed — replace with fresh offline embed
      await tryDeleteMessage(ch, prevPlayerMessageId);

      const offlineMsg = await ch.send({
        embeds: [buildOfflineEmbed(queueName)],
      });
      queue.playerPanelMessageId = offlineMsg.id;
    } catch { }
  }

  setQueue(queueName, queue);
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

  const guild = interaction.guild;
  if (!guild) { await interaction.reply({ content: "Could not resolve guild.", ephemeral: true }); return; }

  setQueue(queueName, queue);
  await interaction.update({ embeds: [buildControlPanelEmbed(queue)] });
  await refreshPlayerPanel(interaction.client, queueName);

  try {
    // Create a private ticket channel — only the player, tester, and bot can see it
    const ticketChannel = await guild.channels.create({
      name: `test-${player.mcUsername.toLowerCase().replace(/[^a-z0-9-]/g, "")}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          type: OverwriteType.Role,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: player.id,
          type: OverwriteType.Member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: queue.testerId,
          type: OverwriteType.Member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: interaction.client.user!.id,
          type: OverwriteType.Member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
          ],
        },
      ],
    });

    // Store ticket data so we can reference it on Give Result / Close Ticket
    tickets.set(ticketChannel.id, {
      playerId: player.id,
      playerMcUsername: player.mcUsername,
      playerRegion: player.region,
      playerPreferredServer: player.preferredServer,
      playerPreviousTier: player.tier,
      testerId: queue.testerId,
      testerName: queue.testerName,
      queueName,
    });

    // Player info embed (private — visible only inside the ticket channel)
    const infoEmbed = new EmbedBuilder()
      .setTitle(`🎫 Test Session — ${player.mcUsername}`)
      .setColor(TICKET_COLOR)
      .setDescription(`Hey <@${player.id}>! You've been pulled from the **${queueName}** queue.\nYour tester is <@${queue.testerId}> — get ready! ⚔️`)
      .addFields(
        { name: "⚔️ MC Username", value: player.mcUsername, inline: true },
        { name: "🌍 Region", value: player.region, inline: true },
        { name: "🖥️ Preferred Server", value: player.preferredServer, inline: true },
        { name: "📊 Previous Tier", value: player.tier, inline: true }
      )
      .setFooter({ text: "Apex Tiers — Test Session" })
      .setTimestamp();

    await ticketChannel.send({
      content: `<@${player.id}> <@${queue.testerId}>`,
      embeds: [infoEmbed],
      components: [buildTicketButtons()],
    });
  } catch (err) {
    console.error("Failed to create ticket channel:", err);
    await interaction.followUp({
      content: `Pulled **${player.displayName}** but could not create a ticket channel. Make sure the bot has **Manage Channels** permission.`,
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

// Shows the join modal — actual joining happens in handleJoinQueueModal
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

async function handleGiveResult(interaction: ButtonInteraction): Promise<void> {
  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({ content: "Only **Verified Testers** can give results.", ephemeral: true });
    return;
  }

  const ticketData = tickets.get(interaction.channelId);
  if (!ticketData) {
    await interaction.reply({ content: "Could not find ticket data for this channel.", ephemeral: true });
    return;
  }

  await interaction.showModal(buildGiveResultModal());
}

async function handleCloseTicket(interaction: ButtonInteraction): Promise<void> {
  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({ content: "Only **Verified Testers** can close tickets.", ephemeral: true });
    return;
  }

  const channel = interaction.channel as TextChannel;
  if (!channel) {
    await interaction.reply({ content: "Could not resolve channel.", ephemeral: true });
    return;
  }

  tickets.delete(channel.id);

  await interaction.reply({ content: "🔒 Test session complete. Closing ticket in 5 seconds..." });
  setTimeout(async () => {
    try { await channel.delete("Ticket closed by tester"); } catch { }
  }, 5000);
}

// ============================================================
// MODAL SUBMIT HANDLERS
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
    content: `✅ You've joined the **${queueName}** queue! Your details have been saved privately — only your tester will see them.`,
    ephemeral: true,
  });

  await refreshPlayerPanel(interaction.client, queueName);
  await refreshControlPanel(interaction.client, queueName);
}

async function handleGiveResultModal(interaction: ModalSubmitInteraction): Promise<void> {
  const ticketData = tickets.get(interaction.channelId);
  if (!ticketData) {
    await interaction.reply({ content: "Could not find ticket data for this channel.", ephemeral: true });
    return;
  }

  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({ content: "Only **Verified Testers** can submit results.", ephemeral: true });
    return;
  }

  const earnedTier = interaction.fields.getTextInputValue("earned_tier").trim();
  const gamemode = interaction.fields.getTextInputValue("gamemode").trim();

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  if (!guild) { await interaction.editReply({ content: "Could not resolve guild." }); return; }

  // Find and assign the tier role to the player
  let roleAssigned = false;
  try {
    const role = guild.roles.cache.find(
      (r) => r.name.toLowerCase() === earnedTier.toLowerCase()
    );
    if (role) {
      const playerMember = await guild.members.fetch(ticketData.playerId);
      await playerMember.roles.add(role, `Tier result: ${earnedTier} given by ${ticketData.testerName}`);
      roleAssigned = true;
    }
  } catch (err) {
    console.error("Failed to assign role:", err);
  }

  // Post result to #Results channel
  let postedToResults = false;
  try {
    const resultsChannel = guild.channels.cache.find(
      (ch) => ch.name.toLowerCase() === RESULTS_CHANNEL_NAME && ch.isTextBased()
    ) as TextChannel | undefined;

    if (resultsChannel) {
      const resultsEmbed = buildResultsEmbed(ticketData, earnedTier, gamemode);
      await resultsChannel.send({ embeds: [resultsEmbed] });
      postedToResults = true;
    }
  } catch (err) {
    console.error("Failed to post to results channel:", err);
  }

  let reply = `✅ Result submitted!\n**Rank Earned:** ${earnedTier} | **Gamemode:** ${gamemode}`;
  if (roleAssigned) reply += `\n✅ Role **${earnedTier}** assigned to <@${ticketData.playerId}>`;
  else reply += `\n⚠️ Could not find a role named **${earnedTier}** — assign it manually.`;
  if (postedToResults) reply += `\n✅ Result posted to #${RESULTS_CHANNEL_NAME}.`;
  else reply += `\n⚠️ Could not find a **#${RESULTS_CHANNEL_NAME}** channel — check the channel name.`;

  await interaction.editReply({ content: reply });

  // Also post in the ticket so both see the result
  const ticketChannel = interaction.channel as TextChannel;
  if (ticketChannel) {
    const summaryEmbed = new EmbedBuilder()
      .setTitle("✅ Test Complete")
      .setColor(RESULTS_COLOR)
      .addFields(
        { name: "Rank Earned", value: earnedTier, inline: true },
        { name: "Gamemode", value: gamemode, inline: true }
      )
      .setFooter({ text: "Result submitted by tester" })
      .setTimestamp();
    await ticketChannel.send({ content: `<@${ticketData.playerId}>`, embeds: [summaryEmbed] });
  }
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
      } else if (interaction.customId === "give_result_modal") {
        await handleGiveResultModal(interaction);
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
        case "open_queue":    await handleOpenQueue(interaction, encodedName!); break;
        case "close_queue":   await handleCloseQueue(interaction, encodedName!); break;
        case "pull_player":   await handlePullPlayer(interaction, encodedName!); break;
        case "ping_queue":    await handlePingQueue(interaction, encodedName!); break;
        case "join_queue":    await handleJoinQueue(interaction, encodedName!); break;
        case "leave_queue":   await handleLeaveQueue(interaction, encodedName!); break;
        case "give_result":   await handleGiveResult(interaction); break;
        case "close_ticket":  await handleCloseTicket(interaction); break;
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
