export interface QueuePlayer {
  id: string;
  username: string;
  displayName: string;
}

export interface QueueState {
  name: string;
  status: "open" | "closed";
  testerId: string;
  testerName: string;
  players: QueuePlayer[];
  controlPanelChannelId: string;
  controlPanelMessageId: string;
  playerPanelChannelId: string | null;
  playerPanelMessageId: string | null;
}

const queues = new Map<string, QueueState>();

export function getQueue(name: string): QueueState | undefined {
  return queues.get(name);
}

export function setQueue(name: string, state: QueueState): void {
  queues.set(name, state);
}

export function createQueue(
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
  };
  queues.set(name, state);
  return state;
}

export function addPlayer(name: string, player: QueuePlayer): boolean {
  const queue = queues.get(name);
  if (!queue) return false;
  if (queue.players.some((p) => p.id === player.id)) return false;
  queue.players.push(player);
  return true;
}

export function removePlayer(name: string, playerId: string): boolean {
  const queue = queues.get(name);
  if (!queue) return false;
  const index = queue.players.findIndex((p) => p.id === playerId);
  if (index === -1) return false;
  queue.players.splice(index, 1);
  return true;
}

export function pullFirstPlayer(name: string): QueuePlayer | null {
  const queue = queues.get(name);
  if (!queue || queue.players.length === 0) return null;
  return queue.players.shift() ?? null;
}

export function getAllQueues(): QueueState[] {
  return Array.from(queues.values());
}
