"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useWebSocket } from "./WebSocketContext";

import * as dotenv from "dotenv";

dotenv.config();

interface Player {
  id: string;
  name: string;
  stackSize: number;
  bet: number;
  folded: boolean;
  isCurrentActor: boolean;
  lastAction?: string;
}

export interface Card {
  _rank: string;
  _suit: string;
}

interface GameState {
  communityCards: Card[];
  pot: number;
  currentBet: number;
  currentActor: string | null;
  players: (Player | null)[];
  winners?: Winner[];
  currentRound?: string;
}

interface Winner {
  playerId: string;
  amount: number;
  hand: string;
  cards: Card[];
}

interface PrivateState {
  holeCards: Card[];
  availableActions: string[];
}

interface JoinRequest {
  playerId: string;
  playerName: string;
  timestamp: number;
}

interface GameStateContextType {
  gameState: GameState | null;
  privateState: PrivateState | null;
  performAction: (
    action: string,
    amount?: number,
    playerId?: string,
    blinds?: { smallBlind: number; bigBlind: number }
  ) => void;
  joinRequests: JoinRequest[];
}

const GameStateContext = createContext<GameStateContextType>({
  gameState: null,
  privateState: null,
  performAction: () => {},
  joinRequests: [],
});

export function GameStateProvider({ children }: { children: React.ReactNode }) {
  const { connected, sendMessage, addMessageListener } = useWebSocket();
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [privateState, setPrivateState] = useState<PrivateState | null>(null);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);

  useEffect(() => {
    console.log(
      "GameStateContext: Setting up message listener. Connected:",
      connected
    );

    if (!connected) {
      console.log("GameStateContext: Not connected, skipping listener setup");
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const removeListener = addMessageListener((message: any) => {
      console.log("GameStateContext: Received message:", message);

      switch (message.type) {
        case "gameState":
          console.log("GameStateContext: Updating game state:", message.state);
          setGameState(message.state);
          break;
        case "privateState":
          console.log(
            "GameStateContext: Updating private state:",
            message.state
          );
          setPrivateState(message.state);
          break;
        case "players":
          console.log("GameStateContext: Updating players:", message.players);
          setGameState((prevState) => {
            const newState = prevState
              ? {
                  ...prevState,
                  players: message.players,
                }
              : {
                  communityCards: [],
                  pot: 0,
                  currentBet: 0,
                  currentActor: null,
                  players: message.players,
                };
            console.log(
              "GameStateContext: New game state after players update:",
              newState
            );
            return newState;
          });
          break;
        case "handComplete":
          console.log(
            "GameStateContext: Hand complete, updating winners:",
            message.winners
          );
          setGameState((prevState) => ({
            ...prevState!,
            winners: message.winners,
          }));
          break;
        case "notification":
          // You can handle notifications here, perhaps showing them in a toast
          console.log("Game notification:", message.message);
          break;
        case "joinRequests":
          setJoinRequests(message.requests);
          break;
        default:
          console.log(
            "GameStateContext: Unhandled message type:",
            message.type
          );
      }
    });

    return () => {
      console.log("GameStateContext: Cleaning up message listener");
      removeListener();
    };
  }, [connected, addMessageListener]);

  const performAction = useCallback(
    (
      action: string,
      amount?: number,
      playerId?: string,
      blinds?: { smallBlind: number; bigBlind: number }
    ) => {
      if (!sendMessage) return;

      switch (action) {
        case "startGame":
          sendMessage({
            type: "startGame",
            socketKey: process.env.SOCKET_KEY,
          });
          break;
        case "restart":
          sendMessage({
            type: "restart",
            socketKey: process.env.SOCKET_KEY,
          });
          break;
        case "kickPlayer":
          sendMessage({
            type: "kickPlayer",
            socketKey: process.env.SOCKET_KEY,
            playerId: playerId,
          });
          break;
        case "approveJoin":
        case "rejectJoin":
          sendMessage({
            type: action,
            socketKey: process.env.SOCKET_KEY,
            playerId,
          });
          break;
        case "updateBlinds":
          sendMessage({
            type: "updateBlinds",
            socketKey: process.env.SOCKET_KEY,
            smallBlind: blinds?.smallBlind,
            bigBlind: blinds?.bigBlind,
          });
          break;
        default:
          sendMessage({ type: "action", action, amount });
      }
    },
    [sendMessage]
  );

  return (
    <GameStateContext.Provider
      value={{ gameState, privateState, performAction, joinRequests }}
    >
      {children}
    </GameStateContext.Provider>
  );
}

export const useGameState = () => useContext(GameStateContext);
