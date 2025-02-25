# node-poker-app

**Originally built for Northeastern ACM's Algorithmic Poker event.**

This project is a full-stack poker application built on top of the `@chevtek/poker-engine` library (with some fixes/adjustments for no-limit hold em). It provides a server for hosting poker games and a frontend interface for players to interact with the game.

## Description

The node-poker-app consists of a backend server that manages the game state and a frontend client for user interaction. It utilizes WebSocket connections to enable real-time communication between the server and clients.

## Libraries Used

- Backend: `@chevtek/poker-engine` - primarily built on this engine.
- Frontend: React with TypeScript

## Environment Setup

Create a `.env` file in the root directory with the following variables:

```bash
BACKEND_PORT=3002    # Port for the backend server
WS_URL=localhost     # WebSocket server hostname/IP
```

These variables will be shared between the frontend and backend applications.

## How to Run

1. Create the `.env` file in the root directory as described above
3. Open a terminal in the monorepo root and run:

   **For development:**
   ```bash
   yarn install
   yarn dev
   ```

   **For a docker-based prod build:**
   ```bash
   yarn docker:build
   yarn docker:up
   ```
   

## Documentation

For detailed information about the WebSocket API and how to interact with the poker server, please refer to the README.md file in the backend folder.
