import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import type { QueueState } from "./queue.js";

const OPEN_COLOR = 0x2ecc71;
const CLOSED_COLOR = 0xe74c3c;
const PLAYER_COLOR = 0x3498db;
const OFFLINE_COLOR = 0x95a5a6;

function encodeQueueId(name: string): string {
  return name.replace(/:/g, "\u2236");
}

export function buildControlPanelEmbed(queue: QueueState): EmbedBuilder {
  const isOpen = queue.status === "open";
  const embed = new EmbedBuilder()
    .setTitle(`⚙️ ${queue.name} — Control Panel`)
    .setColor(isOpen ? OPEN_COLOR : CLOSED_COLOR)
    .addFields(
      {
        name: "Status",
        value: isOpen ? "🟢 Open" : "🔴 Closed",
        inline: true,
      },
      {
        name: "Active Tester",
        value: isOpen && queue.testerName ? queue.testerName : "None",
        inline: true,
      },
      {
        name: "Players in Queue",
        value: String(queue.players.length),
        inline: true,
      }
    )
    .setFooter({ text: "Apex Tiers — Staff Control Panel" })
    .setTimestamp();
  return embed;
}

export function buildControlPanelButtons(queueName: string): ActionRowBuilder<ButtonBuilder> {
  const id = encodeQueueId(queueName);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`open_queue::${id}`)
      .setLabel("Open Queue")
      .setStyle(ButtonStyle.Success)
      .setEmoji("🟢"),
    new ButtonBuilder()
      .setCustomId(`close_queue::${id}`)
      .setLabel("Close Queue")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🔴"),
    new ButtonBuilder()
      .setCustomId(`pull_player::${id}`)
      .setLabel("Pull Player")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("⬆️"),
    new ButtonBuilder()
      .setCustomId(`ping_queue::${id}`)
      .setLabel("Ping Queue")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🔔")
  );
}

export function buildPlayerInterfaceEmbed(queue: QueueState): EmbedBuilder {
  const isOpen = queue.status === "open";

  let playerList = "No players in queue.";
  if (queue.players.length > 0) {
    playerList = queue.players
      .map((p, i) => `**#${i + 1}** ${p.displayName}`)
      .join("\n");
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
      {
        name: "Status",
        value: isOpen ? "🟢 Open" : "🔴 Closed",
        inline: true,
      },
      {
        name: "Waiting",
        value: String(queue.players.length),
        inline: true,
      }
    )
    .setFooter({ text: "Apex Tiers • Join the queue below" })
    .setTimestamp();
}

export function buildPlayerInterfaceButtons(queueName: string): ActionRowBuilder<ButtonBuilder> {
  const id = encodeQueueId(queueName);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_queue::${id}`)
      .setLabel("Join Queue")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(`leave_queue::${id}`)
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("❌")
  );
}

export function buildOfflineEmbed(queueName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`🎮 ${queueName}`)
    .setColor(OFFLINE_COLOR)
    .setDescription("No testers are online right now.\nCheck back later!")
    .setFooter({ text: "Apex Tiers" })
    .setTimestamp();
}
