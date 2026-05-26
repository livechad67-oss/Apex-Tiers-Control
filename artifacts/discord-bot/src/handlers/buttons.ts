import {
  ButtonInteraction,
  ChannelType,
  GuildMember,
  TextChannel,
  ThreadAutoArchiveDuration,
} from "discord.js";
import {
  addPlayer,
  getQueue,
  pullFirstPlayer,
  removePlayer,
  setQueue,
} from "../queue.js";
import {
  buildControlPanelEmbed,
  buildOfflineEmbed,
  buildPlayerInterfaceButtons,
  buildPlayerInterfaceEmbed,
} from "../embeds.js";

const VERIFIED_TESTER_ROLE_NAME = "Verified Tester";

function decodeQueueId(id: string): string {
  return id.replace(/\u2236/g, ":");
}

function isStaffMember(member: GuildMember | null): boolean {
  if (!member) return false;
  if (member.permissions.has("Administrator")) return true;
  return member.roles.cache.some(
    (r) => r.name === VERIFIED_TESTER_ROLE_NAME
  );
}

async function updatePlayerPanel(interaction: ButtonInteraction, queueName: string): Promise<void> {
  const queue = getQueue(queueName);
  if (!queue || !queue.playerPanelMessageId || !queue.playerPanelChannelId) return;

  try {
    const channel = await interaction.client.channels.fetch(queue.playerPanelChannelId);
    if (!channel || !(channel instanceof TextChannel)) return;
    const msg = await channel.messages.fetch(queue.playerPanelMessageId);
    await msg.edit({
      embeds: [buildPlayerInterfaceEmbed(queue)],
      components: queue.status === "open" ? [buildPlayerInterfaceButtons(queue.name)] : [],
    });
  } catch {
  }
}

export async function handleOpenQueue(
  interaction: ButtonInteraction,
  encodedName: string
): Promise<void> {
  const queueName = decodeQueueId(encodedName);

  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({
      content: "You need the **Verified Tester** role or Administrator permission to do that.",
      ephemeral: true,
    });
    return;
  }

  const queue = getQueue(queueName);
  if (!queue) {
    await interaction.reply({ content: "Queue not found.", ephemeral: true });
    return;
  }

  if (queue.status === "open") {
    await interaction.reply({ content: "Queue is already open.", ephemeral: true });
    return;
  }

  const member = interaction.member as GuildMember;
  queue.status = "open";
  queue.testerId = interaction.user.id;
  queue.testerName = member.displayName;
  queue.players = [];
  setQueue(queueName, queue);

  await interaction.update({
    embeds: [buildControlPanelEmbed(queue)],
  });

  const publicChannelId = queue.playerPanelChannelId!;
  const publicChannel = await interaction.client.channels.fetch(publicChannelId) as TextChannel;

  await publicChannel.send({
    content: `@everyone The **${queueName}** queue is now **open**! 🟢 Tester: **${queue.testerName}**`,
  });

  const playerMsg = await publicChannel.send({
    embeds: [buildPlayerInterfaceEmbed(queue)],
    components: [buildPlayerInterfaceButtons(queueName)],
  });

  queue.playerPanelMessageId = playerMsg.id;
  setQueue(queueName, queue);
}

export async function handleCloseQueue(
  interaction: ButtonInteraction,
  encodedName: string
): Promise<void> {
  const queueName = decodeQueueId(encodedName);

  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({
      content: "You need the **Verified Tester** role or Administrator permission to do that.",
      ephemeral: true,
    });
    return;
  }

  const queue = getQueue(queueName);
  if (!queue) {
    await interaction.reply({ content: "Queue not found.", ephemeral: true });
    return;
  }

  queue.status = "closed";
  queue.testerId = "";
  queue.testerName = "";
  queue.players = [];
  setQueue(queueName, queue);

  await interaction.update({
    embeds: [buildControlPanelEmbed(queue)],
  });

  if (queue.playerPanelMessageId && queue.playerPanelChannelId) {
    try {
      const ch = await interaction.client.channels.fetch(queue.playerPanelChannelId);
      if (ch instanceof TextChannel) {
        const msg = await ch.messages.fetch(queue.playerPanelMessageId);
        await msg.edit({
          embeds: [buildOfflineEmbed(queueName)],
          components: [],
        });
      }
    } catch {
    }
    queue.playerPanelMessageId = null;
    queue.playerPanelChannelId = null;
    setQueue(queueName, queue);
  }
}

export async function handlePullPlayer(
  interaction: ButtonInteraction,
  encodedName: string
): Promise<void> {
  const queueName = decodeQueueId(encodedName);

  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({
      content: "You need the **Verified Tester** role or Administrator permission to do that.",
      ephemeral: true,
    });
    return;
  }

  const queue = getQueue(queueName);
  if (!queue) {
    await interaction.reply({ content: "Queue not found.", ephemeral: true });
    return;
  }

  if (queue.status !== "open") {
    await interaction.reply({ content: "Queue is not open.", ephemeral: true });
    return;
  }

  const player = pullFirstPlayer(queueName);
  if (!player) {
    await interaction.reply({ content: "No players in the queue.", ephemeral: true });
    return;
  }

  setQueue(queueName, queue);

  await interaction.update({
    embeds: [buildControlPanelEmbed(queue)],
  });

  await updatePlayerPanel(interaction, queueName);

  const publicChannel = await interaction.client.channels.fetch(queue.playerPanelChannelId!) as TextChannel;

  try {
    const threadName = `test-${player.username}`.slice(0, 100);
    const thread = await publicChannel.threads.create({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      type: ChannelType.PrivateThread,
      reason: `Apex Tiers test session for ${player.username}`,
    });

    await thread.members.add(queue.testerId);
    await thread.members.add(player.id);

    await thread.send({
      content:
        `Hey <@${player.id}>! You've been pulled from the **${queueName}** queue.\n` +
        `Your tester is <@${queue.testerId}>. Get ready! ⚔️`,
    });
  } catch (err) {
    console.error("Failed to create private thread:", err);
    await interaction.followUp({
      content: `Pulled **${player.displayName}** but could not create a private thread. Make sure the bot has the correct permissions.`,
      ephemeral: true,
    });
  }
}

export async function handlePingQueue(
  interaction: ButtonInteraction,
  encodedName: string
): Promise<void> {
  const queueName = decodeQueueId(encodedName);

  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({
      content: "You need the **Verified Tester** role or Administrator permission to do that.",
      ephemeral: true,
    });
    return;
  }

  const queue = getQueue(queueName);
  if (!queue) {
    await interaction.reply({ content: "Queue not found.", ephemeral: true });
    return;
  }

  if (queue.players.length === 0) {
    await interaction.reply({ content: "No players in the queue to ping.", ephemeral: true });
    return;
  }

  const mentions = queue.players.map((p) => `<@${p.id}>`).join(" ");

  const publicChannel = await interaction.client.channels.fetch(queue.playerPanelChannelId!) as TextChannel;
  await publicChannel.send({
    content: `🔔 Attention queue members for **${queueName}**: ${mentions}\nYour tester **${queue.testerName}** is still active — get ready!`,
    allowedMentions: { users: queue.players.map((p) => p.id) },
  });

  await interaction.reply({ content: "✅ Pinged all players in the queue.", ephemeral: true });
}

export async function handleJoinQueue(
  interaction: ButtonInteraction,
  encodedName: string
): Promise<void> {
  const queueName = decodeQueueId(encodedName);
  const queue = getQueue(queueName);

  if (!queue) {
    await interaction.reply({ content: "Queue not found.", ephemeral: true });
    return;
  }

  if (queue.status !== "open") {
    await interaction.reply({ content: "This queue is currently closed.", ephemeral: true });
    return;
  }

  const member = interaction.member as GuildMember;
  const added = addPlayer(queueName, {
    id: interaction.user.id,
    username: interaction.user.username,
    displayName: member.displayName,
  });

  if (!added) {
    await interaction.reply({ content: "You're already in the queue!", ephemeral: true });
    return;
  }

  await interaction.update({
    embeds: [buildPlayerInterfaceEmbed(queue)],
    components: [buildPlayerInterfaceButtons(queueName)],
  });

  await updateControlPanel(interaction, queueName);
}

export async function handleLeaveQueue(
  interaction: ButtonInteraction,
  encodedName: string
): Promise<void> {
  const queueName = decodeQueueId(encodedName);
  const queue = getQueue(queueName);

  if (!queue) {
    await interaction.reply({ content: "Queue not found.", ephemeral: true });
    return;
  }

  const removed = removePlayer(queueName, interaction.user.id);
  if (!removed) {
    await interaction.reply({ content: "You're not in the queue.", ephemeral: true });
    return;
  }

  await interaction.update({
    embeds: [buildPlayerInterfaceEmbed(queue)],
    components: [buildPlayerInterfaceButtons(queueName)],
  });

  await updateControlPanel(interaction, queueName);
}

async function updateControlPanel(interaction: ButtonInteraction, queueName: string): Promise<void> {
  const queue = getQueue(queueName);
  if (!queue || !queue.controlPanelMessageId || !queue.controlPanelChannelId) return;

  try {
    const channel = await interaction.client.channels.fetch(queue.controlPanelChannelId);
    if (!channel || !(channel instanceof TextChannel)) return;
    const msg = await channel.messages.fetch(queue.controlPanelMessageId);
    await msg.edit({ embeds: [buildControlPanelEmbed(queue)] });
  } catch {
  }
}
