import {
  ChatInputCommandInteraction,
  GuildMember,
  PermissionFlagsBits,
  TextChannel,
} from "discord.js";
import { createQueue, getQueue } from "../queue.js";
import { buildControlPanelButtons, buildControlPanelEmbed } from "../embeds.js";

const VERIFIED_TESTER_ROLE_NAME = "Verified Tester";

function isStaffMember(member: GuildMember | null): boolean {
  if (!member) return false;
  if (member.permissions.has("Administrator")) return true;
  return member.roles.cache.some((r) => r.name === VERIFIED_TESTER_ROLE_NAME);
}

export async function handleSetupControl(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!isStaffMember(interaction.member as GuildMember)) {
    await interaction.reply({
      content:
        "You need the **Verified Tester** role or Administrator permission to use this command.",
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
  const embed = buildControlPanelEmbed(stub);
  const buttons = buildControlPanelButtons(queueName);

  const controlMsg = await (interaction.channel as TextChannel).send({
    embeds: [embed],
    components: [buttons],
  });

  stub.controlPanelMessageId = controlMsg.id;
  stub.controlPanelChannelId = controlMsg.channelId;

  const { setQueue } = await import("../queue.js");
  setQueue(queueName, stub);

  await interaction.editReply({
    content: `✅ Control panel for **${queueName}** has been set up! Player interface will appear in ${targetChannel}.`,
  });
}
