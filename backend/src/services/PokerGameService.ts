import { Table } from "@chevtek/poker-engine";
import { WebSocket, WebSocketServer } from "ws";

interface ConnectedPlayer {
  id: string;
  name: string;
  socket: WebSocket;
}

export class PokerGameService {
  private table: Table;
  private connectedPlayers: Map<string, ConnectedPlayer>;
  private wss: WebSocketServer;

  constructor(wss: WebSocketServer) {
    this.table = new Table(1000, 5, 10);
    this.connectedPlayers = new Map();
    this.wss = wss;
  }

  handleConnection(socket: WebSocket) {
    socket.on("message", (message: string) => {
      try {
        const data = JSON.parse(message);
        this.handleMessage(socket, data);
      } catch (error) {
        this.sendError(socket, "Invalid message format");
      }
    });

    socket.on("close", () => {
      // Find and remove disconnected player
      for (const [playerId, player] of this.connectedPlayers.entries()) {
        if (player.socket === socket) {
          this.handlePlayerLeave(playerId);
          break;
        }
      }
    });
  }

  private handleMessage(socket: WebSocket, message: any) {
    switch (message.type) {
      case "join":
        this.handlePlayerJoin(
          socket,
          message.playerId,
          message.name,
          message.buyIn
        );
        break;
      case "action":
        this.handlePlayerAction(
          message.playerId,
          message.action,
          message.amount
        );
        break;
      case "startGame":
        this.startNewHand();
        break;
      case "restart":
        this.restartGame();
        break;
      default:
        this.sendError(socket, "Unknown message type");
    }
  }

  private handlePlayerJoin(
    socket: WebSocket,
    playerId: string,
    name: string,
    buyIn: number // we'll ignore this parameter
  ) {
    try {
      const FIXED_BUY_IN = 1000;
      this.table.sitDown(playerId, FIXED_BUY_IN);
      this.connectedPlayers.set(playerId, { id: playerId, name, socket });

      // Send initial state to the new player
      this.sendToPlayer(playerId, {
        type: "gameState",
        state: this.getPlayerState(playerId),
      });

      // Broadcast updated player list to all players
      this.broadcast({
        type: "players",
        players: this.getPublicPlayerStates(),
      });
    } catch (error: any) {
      this.sendError(socket, error.message);
    }
  }

  private handlePlayerLeave(playerId: string) {
    const player = this.table.players.find((p) => p?.id === playerId);
    if (player) {
      this.table.standUp(player);
      this.connectedPlayers.delete(playerId);

      this.broadcast({
        type: "players",
        players: this.getPublicPlayerStates(),
      });
    }
  }

  private handlePlayerAction(
    playerId: string,
    action: string,
    amount?: number
  ) {
    try {
      const player = this.table.players.find((p) => p?.id === playerId);
      if (!player) throw new Error("Player not found");
      if (this.table.currentActor?.id !== playerId)
        throw new Error("Not your turn");

      // Check if it's an all-in bet/raise
      const isAllIn = amount === player.stackSize;

      switch (action) {
        case "call":
          player.callAction();
          break;
        case "check":
          player.checkAction();
          break;
        case "fold":
          player.foldAction();
          break;
        case "bet":
          if (amount === undefined) throw new Error("Amount required for bet");
          // Allow any amount for all-in, otherwise enforce minimum bet
          if (!isAllIn && amount < this.table.bigBlind) {
            throw new Error("Bet must be at least the big blind");
          }
          player.betAction(amount);
          break;
        case "raise":
          if (amount === undefined)
            throw new Error("Amount required for raise");

          // Special case for small blind raising to match big blind pre-flop
          const isPreFlop = !this.table.communityCards.length;
          const isSmallBlindPosition = player.bet === this.table.smallBlind;
          const isRaisingToBigBlind =
            isPreFlop && isSmallBlindPosition && amount === this.table.bigBlind;

          // For raises, the amount must increase the current bet by at least the big blind
          const raiseAmount = amount! - (this.table.currentBet || 0);
          if (
            !isAllIn &&
            !isRaisingToBigBlind &&
            raiseAmount < this.table.bigBlind
          ) {
            throw new Error(
              `Raise must increase the current bet by at least the big blind (${this.table.bigBlind})`
            );
          }
          player.raiseAction(amount);
          break;
        default:
          throw new Error("Invalid action");
      }

      this.broadcastGameState();

      // Check if the hand is over
      if (!this.table.currentRound) {
        this.handleHandComplete();
      }
    } catch (error: any) {
      // Send error message to the player
      this.sendError(
        this.connectedPlayers.get(playerId)?.socket!,
        error.message
      );

      // Automatically fold the player
      try {
        const player = this.table.players.find((p) => p?.id === playerId);
        if (player && this.table.currentActor?.id === playerId) {
          player.foldAction();

          // Broadcast that the player was auto-folded
          this.broadcast({
            type: "notification",
            message: `${
              this.connectedPlayers.get(playerId)?.name || "Player"
            } auto-folded due to invalid action: ${error.message}`,
          });

          this.broadcastGameState();

          // Check if the hand is over after the fold
          if (!this.table.currentRound) {
            this.handleHandComplete();
          }
        }
      } catch (foldError) {
        console.error("Error during auto-fold:", foldError);
      }
    }
  }

  private startNewHand() {
    try {
      this.table.dealCards();
      this.broadcastGameState();
    } catch (error) {
      console.error("Error starting new hand:", error);
      this.broadcast({
        type: "error",
        error: "Failed to start new hand. Make sure there are enough players.",
      });
    }
  }

  private restartGame() {
    // Create fresh table
    this.table = new Table(1000, 5, 10);

    // Clear all connected players
    this.connectedPlayers.clear();

    // Broadcast the reset to all players
    this.broadcast({
      type: "gameReset",
      message: "Game has been reset. All players must rejoin.",
    });

    // Broadcast empty game state
    this.broadcastGameState();
  }

  private handleHandComplete() {
    // Broadcast results
    this.broadcast({
      type: "handComplete",
      winners: this.table.winners?.map((w) => ({
        playerId: w.id,
        amount: this.table.pots.reduce(
          (total, pot) =>
            pot.winners?.includes(w)
              ? total + pot.amount / (pot.winners?.length || 1)
              : total,
          0
        ),
      })),
    });

    // Remove auto-start of next hand
    // setTimeout(() => this.startNewHand(), 3000);
  }

  private getPlayerState(playerId: string) {
    const player = this.table.players.find((p) => p?.id === playerId);
    return {
      holeCards: player?.holeCards || [],
      availableActions: player?.legalActions() || [],
      stackSize: player?.stackSize || 0,
      bet: player?.bet || 0,
      isCurrentActor: this.table.currentActor?.id === playerId,
      communityCards: this.table.communityCards,
      pot: this.table.pots.reduce((total, pot) => total + pot.amount, 0),
      currentBet: this.table.currentBet,
      currentRound: this.table.currentRound,
    };
  }

  private getPublicPlayerStates() {
    return this.table.players.map((player) =>
      player
        ? {
            id: player.id,
            name: this.connectedPlayers.get(player.id)?.name,
            stackSize: player.stackSize,
            bet: player.bet,
            folded: player.folded,
            isCurrentActor: this.table.currentActor?.id === player.id,
          }
        : null
    );
  }

  private broadcast(message: any) {
    const messageStr = JSON.stringify(message);
    console.log("Broadcasting message to all clients:", messageStr);

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    });
  }

  private broadcastGameState() {
    // Send public state to all players
    this.broadcast({
      type: "gameState",
      state: {
        communityCards: this.table.communityCards,
        pot: this.table.pots.reduce((total, pot) => total + pot.amount, 0),
        currentBet: this.table.currentBet,
        currentActor: this.table.currentActor?.id,
        currentRound: this.table.currentRound,
        players: this.getPublicPlayerStates(),
      },
    });

    // Send private state to each player
    for (const [playerId, player] of this.connectedPlayers) {
      const currentPlayer = this.table.players.find((p) => p?.id === playerId);
      const isCurrentActor = this.table.currentActor?.id === playerId;

      this.sendToPlayer(playerId, {
        type: "privateState",
        state: {
          holeCards: currentPlayer?.holeCards,
          availableActions: isCurrentActor
            ? this.table.currentActor?.legalActions()
            : [],
          minRaise: this.table.lastRaise ?? this.table.bigBlind,
          maxBet: currentPlayer?.stackSize ?? 0,
        },
      });
    }
  }

  private sendToPlayer(playerId: string, message: any) {
    const player = this.connectedPlayers.get(playerId);
    if (player) {
      const messageStr = JSON.stringify(message);
      console.log(`Sending message to player ${playerId}:`, messageStr);
      player.socket.send(messageStr);
    }
  }

  private sendError(socket: WebSocket, error: string) {
    const message = { type: "error", error };
    const messageStr = JSON.stringify(message);
    console.log("Sending error message:", messageStr);
    socket.send(messageStr);
  }
}
