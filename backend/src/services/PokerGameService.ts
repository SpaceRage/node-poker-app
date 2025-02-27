import { WebSocket, WebSocketServer } from "ws";
import { Table } from "../@chevtek/poker-engine/src";

interface ConnectedPlayer {
  id: string;
  name: string;
  socket: WebSocket;
}

interface JoinRequest {
  id: string;
  name: string;
  timestamp: number;
}

export class PokerGameService {
  private table: Table;
  private connectedPlayers: Map<string, ConnectedPlayer>;
  private wss: WebSocketServer;
  private socketKey: string;
  private joinRequests: Map<string, JoinRequest>;
  private pendingSockets: Map<string, WebSocket>;
  private turnTimer: NodeJS.Timeout | null = null;
  private readonly TURN_TIMEOUT_MS = 10000; // 10 seconds

  constructor(wss: WebSocketServer) {
    this.table = new Table(1000, 5, 10);
    this.connectedPlayers = new Map();
    this.wss = wss;
    this.socketKey = process.env.SOCKET_KEY || "";
    this.joinRequests = new Map();
    this.pendingSockets = new Map();
  }

  handleConnection(socket: WebSocket) {
    // Clear any stale requests for this socket
    for (const [playerId, pendingSocket] of this.pendingSockets.entries()) {
      if (pendingSocket === socket) {
        this.joinRequests.delete(playerId);
        this.pendingSockets.delete(playerId);
      }
    }

    socket.on("message", (message: string) => {
      try {
        const data = JSON.parse(message);
        this.handleMessage(socket, data);
      } catch (error) {
        this.sendError(socket, "Invalid message format");
      }
    });

    socket.on("close", () => {
      // Clean up any pending requests for this socket
      for (const [playerId, pendingSocket] of this.pendingSockets.entries()) {
        if (pendingSocket === socket) {
          this.joinRequests.delete(playerId);
          this.pendingSockets.delete(playerId);
          this.broadcastJoinRequests();
        }
      }

      // Handle player disconnect
      for (const [playerId, player] of this.connectedPlayers.entries()) {
        if (player.socket === socket) {
          this.handlePlayerLeave(playerId);
          break;
        }
      }
    });
  }

  private handleMessage(socket: WebSocket, message: any) {
    try {
      switch (message.type) {
        case "join":
          // Instead of direct join, create a join request
          this.handleJoinRequest(socket, message.playerId, message.name);
          break;
        case "action":
          this.handlePlayerAction(
            message.playerId,
            message.action,
            message.amount
          );
          break;
        case "requestJoin":
          this.handleJoinRequest(socket, message.playerId, message.name);
          break;
        case "approveJoin":
          if (message.socketKey !== this.socketKey) {
            this.sendError(socket, "Unauthorized admin action");
            return;
          }
          // Add playerId validation
          if (!message.playerId || !this.joinRequests.has(message.playerId)) {
            this.sendError(socket, "Invalid player ID or request not found");
            return;
          }
          this.approveJoinRequest(message.playerId);
          break;
        case "rejectJoin":
          if (message.socketKey !== this.socketKey) {
            this.sendError(socket, "Unauthorized admin action");
            return;
          }
          this.rejectJoinRequest(message.playerId);
          break;
        case "kickPlayer":
          if (message.socketKey !== this.socketKey) {
            this.sendError(socket, "Unauthorized admin action");
            return;
          }
          this.kickPlayer(message.playerId);
          break;
        case "startGame":
          if (message.socketKey !== this.socketKey) {
            this.sendError(socket, "Unauthorized admin action");
            return;
          }
          this.startNewHand();
          break;
        case "restart":
          if (message.socketKey !== this.socketKey) {
            this.sendError(socket, "Unauthorized admin action");
            return;
          }
          this.restartGame();
          break;
        case "updateBlinds":
          if (message.socketKey !== this.socketKey) {
            this.sendError(socket, "Unauthorized admin action");
            return;
          }
          if (message.smallBlind >= message.bigBlind) {
            this.sendError(socket, "Small blind must be less than big blind");
            return;
          }
          this.table.smallBlind = message.smallBlind;
          this.table.bigBlind = message.bigBlind;
          this.broadcast({
            type: "notification",
            message: `Blinds updated to ${message.smallBlind}/${message.bigBlind}`,
          });
          break;
        default:
          this.sendError(socket, "Unknown message type");
      }
    } catch (error: any) {
      this.sendError(socket, error.message);
    }
  }

  private handlePlayerJoin(socket: WebSocket, playerId: string, name: string) {
    try {
      const FIXED_BUY_IN = 1000;

      // Find first available seat
      let seatNumber = 0;
      while (
        this.table.players[seatNumber] !== null &&
        seatNumber < this.table.players.length
      ) {
        seatNumber++;
      }

      if (seatNumber >= this.table.players.length) {
        throw new Error("No available seats!");
      }

      this.table.sitDown(playerId, FIXED_BUY_IN, seatNumber);
      this.connectedPlayers.set(playerId, { id: playerId, name, socket });

      // Broadcast updates
      this.broadcast({
        type: "playerJoined",
        playerId,
        name,
      });

      this.sendToPlayer(playerId, {
        type: "gameState",
        state: this.getPlayerState(playerId),
      });

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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private startTurnTimer() {
    // Clear any existing timer
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
    }

    // Get current actor
    const currentActor = this.table.currentActor;
    if (!currentActor) return;

    // Start new timer
    this.turnTimer = setTimeout(() => {
      try {
        // Check if the same player is still acting
        if (this.table.currentActor?.id === currentActor.id) {
          const player = this.table.players.find(
            (p) => p?.id === currentActor.id
          );
          if (player) {
            // Auto-fold the player
            player.foldAction();

            // Notify all players about the auto-fold
            this.broadcast({
              type: "notification",
              message: `${
                this.connectedPlayers.get(currentActor.id)?.name || "Player"
              } auto-folded due to time limit (10 seconds)`,
            });

            // Update game state
            this.broadcastGameState();

            // Check if hand is complete
            if (!this.table.currentRound) {
              this.handleHandComplete();
            }
          }
        }
      } catch (error) {
        console.error("Error during auto-fold:", error);
      }
    }, this.TURN_TIMEOUT_MS);
  }

  private async handlePlayerAction(
    playerId: string,
    action: string,
    amount?: number
  ) {
    try {
      const player = this.table.players.find((p) => p?.id === playerId);
      if (!player) throw new Error("Player not found");
      if (this.table.currentActor?.id !== playerId)
        throw new Error("Not your turn");

      // Clear the turn timer since the player acted
      if (this.turnTimer) {
        clearTimeout(this.turnTimer);
      }

      // Set the last action
      player.lastAction = amount ? `${action} $${amount}` : action;

      // Clear the last action after 2 seconds
      setTimeout(() => {
        if (player.lastAction) {
          player.lastAction = undefined;
          this.broadcast({
            type: "players",
            players: this.getPublicPlayerStates(),
          });
        }
      }, 2000);

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
          if (!isAllIn && amount < this.table.bigBlind) {
            throw new Error("Bet must be at least the big blind");
          }
          player.betAction(amount);
          break;
        case "raise":
          if (amount === undefined)
            throw new Error("Amount required for raise");

          const isPreFlop = !this.table.communityCards.length;
          const isSmallBlindPosition = player.bet === this.table.smallBlind;
          const isRaisingToBigBlind =
            isPreFlop && isSmallBlindPosition && amount === this.table.bigBlind;

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

      // Add 2-second delay after processing the action
      await this.delay(500);

      this.broadcastGameState();

      // Check if the hand is over
      if (!this.table.currentRound) {
        this.handleHandComplete();
      }

      // After successful action, start timer for next player
      this.startTurnTimer();
    } catch (error: any) {
      this.sendError(
        this.connectedPlayers.get(playerId)?.socket!,
        error.message
      );

      try {
        const player = this.table.players.find((p) => p?.id === playerId);
        if (player && this.table.currentActor?.id === playerId) {
          player.foldAction();

          this.broadcast({
            type: "notification",
            message: `${
              this.connectedPlayers.get(playerId)?.name || "Player"
            } auto-folded due to invalid action: ${error.message}`,
          });

          this.broadcastGameState();

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

      this.broadcast({
        type: "notification",
        message: "Admin has started a new hand",
      });
    } catch (error) {
      console.error("Error starting new hand:", error);
      this.broadcast({
        type: "error",
        error: "Failed to start new hand. Make sure there are enough players.",
      });
    }
  }

  private restartGame() {
    try {
      // First notify all clients about the restart
      this.broadcast({
        type: "gameReset",
        message: "Admin has reset the game. All players must rejoin.",
      });

      // Store current sockets to close them after reset
      const socketsToClose = new Set<WebSocket>();
      this.connectedPlayers.forEach((player) => {
        if (player.socket.readyState === WebSocket.OPEN) {
          socketsToClose.add(player.socket);
        }
      });
      this.pendingSockets.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socketsToClose.add(socket);
        }
      });

      // Clear all game state
      this.table = new Table(1000, 5, 10);

      // Clear all player-related maps
      this.connectedPlayers.clear();
      this.joinRequests.clear();
      this.pendingSockets.clear();

      // Force cleanup of the table
      this.table.cleanUp();
      this.table.communityCards = [];
      delete this.table.winners;
      this.table.pots = [];
      this.table.currentBet = 0;
      this.table.lastRaise = undefined;
      this.table.currentRound = undefined;

      // Clear all players from table
      for (let i = 0; i < this.table.players.length; i++) {
        if (this.table.players[i]) {
          this.table.players[i] = null;
        }
      }

      // Force close all stored socket connections
      socketsToClose.forEach((socket) => {
        try {
          socket.terminate();
        } catch (err) {
          console.error("Error closing client connection:", err);
        }
      });

      // Broadcast empty state to clear UI
      this.broadcast({
        type: "players",
        players: this.getPublicPlayerStates(),
      });
      this.broadcastJoinRequests();

      console.log("Game has been fully reset");
    } catch (error) {
      console.error("Error during game restart:", error);
      this.broadcast({
        type: "error",
        error: "Failed to restart game properly",
      });
    }
  }

  private handleHandComplete() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    // Get winners with their hands
    const winnersWithHands = this.table.winners?.map((w) => ({
      playerId: w.id,
      amount: this.table.pots.reduce(
        (total, pot) =>
          pot.winners?.includes(w)
            ? total + pot.amount / (pot.winners?.length || 1)
            : total,
        0
      ),
      hand: w.hand.descr, // Add hand description
      cards: w.holeCards, // Add hole cards
    }));

    // Broadcast results
    this.broadcast({
      type: "handComplete",
      winners: winnersWithHands,
    });

    // Check for bankrupt players and remove them
    this.table.players.forEach((player) => {
      if (player && player.stackSize === 0) {
        // Remove player from table
        this.table.standUp(player);

        // Remove from connected players
        this.connectedPlayers.delete(player.id);

        // Send message to the bankrupt player
        this.sendToPlayer(player.id, {
          type: "kicked",
          message:
            "You have been removed from the table due to insufficient funds.",
        });

        // Broadcast player removal to all players
        this.broadcast({
          type: "notification",
          message: `${
            this.connectedPlayers.get(player.id)?.name || "Player"
          } has been removed from the table due to insufficient funds.`,
        });
      }
    });

    // Broadcast updated player list
    this.broadcast({
      type: "players",
      players: this.getPublicPlayerStates(),
    });
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
            lastAction: player.lastAction, // Add this field
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
      const currentBet = this.table.currentBet || 0;

      this.sendToPlayer(playerId, {
        type: "privateState",
        state: {
          holeCards: currentPlayer?.holeCards,
          availableActions: isCurrentActor
            ? this.table.currentActor?.legalActions()
            : [],
          minRaise: currentBet + (this.table.lastRaise ?? this.table.bigBlind),
          maxBet: (currentPlayer?.stackSize ?? 0) + (currentPlayer?.bet ?? 0),
          stackSize: currentPlayer?.stackSize ?? 0,
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

  private kickPlayer(playerId: string) {
    const player = this.connectedPlayers.get(playerId);
    if (player) {
      // Send kick message to the player
      this.sendToPlayer(playerId, {
        type: "kicked",
        message: "You have been kicked from the game",
      });

      // Remove player from table
      const tablePlayer = this.table.players.find((p) => p?.id === playerId);
      if (tablePlayer) {
        this.table.standUp(tablePlayer);
      }

      // Remove from connected players
      this.connectedPlayers.delete(playerId);

      // Remove any pending join requests
      this.joinRequests.delete(playerId);
      this.pendingSockets.delete(playerId);

      // Broadcast player removal
      this.broadcast({
        type: "notification",
        message: `${player.name} has been kicked from the game`,
      });

      // Update all clients with new player list
      this.broadcast({
        type: "players",
        players: this.getPublicPlayerStates(),
      });

      // Force close their socket connection
      if (player.socket.readyState === WebSocket.OPEN) {
        player.socket.terminate();
      }
    }
  }

  private handleJoinRequest(socket: WebSocket, playerId: string, name: string) {
    // Check for duplicate names
    const isDuplicateName = Array.from(this.connectedPlayers.values()).some(
      (player) => player.name.toLowerCase() === name.toLowerCase()
    );

    if (isDuplicateName) {
      this.sendError(socket, "Name already taken");
      return;
    }

    // Clear any existing request for this player ID
    if (this.joinRequests.has(playerId)) {
      const oldSocket = this.pendingSockets.get(playerId);
      if (oldSocket && oldSocket !== socket) {
        oldSocket.close();
      }
    }

    const request: JoinRequest = {
      id: playerId,
      name,
      timestamp: Date.now(),
    };

    this.joinRequests.set(playerId, request);
    this.pendingSockets.set(playerId, socket);

    // Broadcast updated join requests
    this.broadcastJoinRequests();

    console.log(`New join request from ${name} (${playerId})`);
  }

  private approveJoinRequest(playerId: string) {
    const request = this.joinRequests.get(playerId);
    const socket = this.pendingSockets.get(playerId);

    if (!request || !socket) {
      console.log("Request or socket not found for playerId:", playerId);
      return;
    }

    // Handle the actual player join
    this.handlePlayerJoin(socket, playerId, request.name);

    // Clean up the request and pending socket
    this.joinRequests.delete(playerId);
    this.pendingSockets.delete(playerId);

    // Broadcast updated join requests to all clients
    this.broadcastJoinRequests();

    console.log(`Approved join request for player ${playerId}`);
  }

  private rejectJoinRequest(playerId: string) {
    const socket = this.pendingSockets.get(playerId);
    if (socket) {
      this.sendError(socket, "Your join request was rejected");
      socket.close();
    }

    this.joinRequests.delete(playerId);
    this.pendingSockets.delete(playerId);
    this.broadcastJoinRequests();
  }

  private broadcastJoinRequests() {
    const requests = Array.from(this.joinRequests.values()).map((request) => ({
      playerId: request.id,
      playerName: request.name,
      timestamp: request.timestamp,
    }));

    this.broadcast({
      type: "joinRequests",
      requests: requests,
    });

    console.log("Broadcasting join requests:", requests);
  }
}
