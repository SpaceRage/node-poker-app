"use client";

import { useGameState } from "@/contexts/GameStateContext";
import { useWebSocket } from "@/contexts/WebSocketContext";
import { useEffect, useState } from "react";
import CardComponent from "./Card";
import JoinRequestsSidebar from "./JoinRequestsSidebar";
import PlayerSpot from "./PlayerSpot";

interface Winner {
  playerId: string;
  amount: number;
  hand: string;
  cards: { _rank: string; _suit: string }[];
}

export default function PokerTable() {
  const { gameState, performAction } = useGameState();
  const { connected } = useWebSocket();
  const [winners, setWinners] = useState<Winner[]>([]);
  const [showWinners, setShowWinners] = useState(false);
  const [smallBlind, setSmallBlind] = useState(5);
  const [bigBlind, setBigBlind] = useState(10);
  const [blindsUpdateMessage, setBlindsUpdateMessage] = useState("");

  useEffect(() => {
    if (gameState?.winners) {
      setWinners(gameState.winners);
      setShowWinners(true);

      // After 5 seconds, hide winners and deal new hand
      const timer = setTimeout(() => {
        setShowWinners(false);
        performAction("startGame");
      }, 5000);

      return () => clearTimeout(timer);
    }
  }, [gameState?.winners, performAction]);

  const handleNewGame = () => {
    performAction("startGame");
  };

  const handleRestart = () => {
    performAction("restart");
  };

  const handleBlindsChange = () => {
    performAction("updateBlinds", undefined, undefined, {
      smallBlind,
      bigBlind,
    });
    setBlindsUpdateMessage("Blinds updated successfully");

    // Clear the message after 3 seconds
    setTimeout(() => {
      setBlindsUpdateMessage("");
    }, 3000);
  };

  if (!connected) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-green-900 to-green-800 flex items-center justify-center">
        <div className="text-white text-xl font-medium">
          Connecting to game server...
        </div>
      </div>
    );
  }

  const getWinnerDisplay = () => {
    if (!winners.length) return "";

    const winnerNames = winners.map((winner) => {
      const player = gameState?.players.find((p) => p?.id === winner.playerId);
      return `${player?.name} ($${winner.amount})`;
    });

    return winnerNames.length === 1
      ? `${winnerNames[0]} wins!`
      : `Split pot: ${winnerNames.join(" & ")}`;
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-green-900 to-green-800 p-8 relative">
      {/* Blind Settings */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-2 z-10">
        <div className="flex gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-white text-sm">Small Blind</label>
            <input
              type="number"
              value={smallBlind}
              onChange={(e) => setSmallBlind(Number(e.target.value))}
              className="w-24 px-2 py-1 rounded bg-gray-800 text-white border border-gray-700"
              min="1"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-white text-sm">Big Blind</label>
            <input
              type="number"
              value={bigBlind}
              onChange={(e) => setBigBlind(Number(e.target.value))}
              className="w-24 px-2 py-1 rounded bg-gray-800 text-white border border-gray-700"
              min="2"
            />
          </div>
          <button
            onClick={handleBlindsChange}
            className="mt-auto mb-1 px-4 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors"
          >
            Update
          </button>
        </div>
        {blindsUpdateMessage && (
          <div className="text-green-400 text-sm animate-fade-in">
            {blindsUpdateMessage}
          </div>
        )}
      </div>

      {/* Always render the sidebar - it will self-hide if there are no requests */}
      <JoinRequestsSidebar />

      {/* Control Buttons */}
      <div className="absolute top-4 right-4 flex gap-4 z-10">
        <button
          onClick={handleNewGame}
          className="bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-6 rounded-full shadow-lg transition-all duration-200 transform hover:scale-105 hover:shadow-xl"
        >
          Deal New Hand
        </button>
        <button
          onClick={handleRestart}
          className="bg-red-600 hover:bg-red-700 text-white font-medium py-2 px-6 rounded-full shadow-lg transition-all duration-200 transform hover:scale-105 hover:shadow-xl"
        >
          Restart Game
        </button>
      </div>

      {/* Table */}
      <div className="relative w-[900px] h-[450px] mx-auto my-20">
        {/* Table Shadow */}
        <div className="absolute inset-0 bg-green-900 rounded-[200px] blur-xl opacity-50"></div>

        {/* Main Table */}
        <div className="relative w-full h-full border-8 border-yellow-900/80 rounded-[200px] bg-gradient-to-b from-green-700 to-green-600 shadow-2xl">
          {/* Table Felt Pattern */}
          <div
            className="absolute inset-0 rounded-[192px] opacity-30"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='0.2'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
            }}
          ></div>

          {/* Table Rim Highlight */}
          <div className="absolute inset-2 rounded-[190px] border border-yellow-500/20"></div>

          {/* Center Container for Community Cards and Pot */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-6 z-10">
            {/* Winner Display */}
            {showWinners && (
              <div className="text-yellow-300 text-3xl font-bold mb-2 animate-bounce drop-shadow-lg">
                {getWinnerDisplay()}
              </div>
            )}

            {/* Community Cards */}
            <div className="flex justify-center gap-3 min-h-[96px]">
              {gameState?.communityCards?.map((card, i) => (
                <CardComponent key={i} card={card} />
              ))}
            </div>

            {/* Pot Display */}
            <div className="text-white text-xl font-medium drop-shadow-lg">
              {gameState?.currentRound ? (
                <>
                  {gameState.pot > 0 && (
                    <div className="bg-black/30 px-6 py-2 rounded-full">
                      Pot: ${gameState.pot}
                    </div>
                  )}
                  <span className="block text-sm text-center mt-2 text-green-200">
                    {gameState.currentRound} round
                  </span>
                </>
              ) : (
                <div className="text-green-200 animate-pulse">
                  Waiting for players...
                </div>
              )}
            </div>
          </div>

          {/* Players */}
          {Array.from({ length: 9 }).map((_, i) => (
            <PlayerSpot
              key={i}
              position={i}
              player={gameState?.players?.[i] || null}
              isCurrentPlayer={false}
              holeCards={null}
              winningHand={
                showWinners
                  ? winners.find(
                      (w) => w.playerId === gameState?.players?.[i]?.id
                    )
                    ? {
                        descr: winners.find(
                          (w) => w.playerId === gameState?.players?.[i]?.id
                        )!.hand,
                        cards: winners.find(
                          (w) => w.playerId === gameState?.players?.[i]?.id
                        )!.cards,
                      }
                    : undefined
                  : undefined
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
