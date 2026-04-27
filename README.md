# Chess

1v1 online chess with 66+ mutator rules that change the game every 3 moves. Built with Node.js, Express, Socket.IO, and chess.js.

Based on a concept by [DougDoug](https://twitch.tv/dougdoug)



## Features

- **Mutator system** - every 3 moves, the current player picks from 3 random rule changes (e.g. pieces swap, squares become blocked, pawns gain new abilities)
- **66+ rules** with varying durations, categories, and interactions
- **Room codes** - create/join games with human-readable codes
- **Spectator mode** - watch live games
- **Bot opponent** - practice mode with minimax AI

## Setup

### Prerequisites

- Node.js 18+

### Install

```bash
git clone https://github.com/your-username/chess.git
cd chess
npm install
```

### Environment Variables

Create a `.env` file:

```
PORT=3000
BASE_PATH=/chess
```

### Run

```bash
npm start        # production
npm run dev      # development (auto-reload)
```

## Project Structure

- `handlers/` - Socket.IO event handlers (join, move, mutator, spectator)
- `mutators/` - Rule definitions, lifecycle engine, hooks, board utilities
- `public/js/` - Modular client (state, board, UI, socket handlers)
- `utils/` - Validation, config, room codes, RPS logic
- `bots/` - Minimax chess AI

## How Mutators Work

Every 3 moves, the active player is shown 3 randomly-weighted rule cards. They pick one, it activates, then they play their move. Rules can:

- Modify piece movement (knights move like bishops, pawns get extra range)
- Add board hazards (minefields, blocked squares, tornadoes)
- Trigger instant effects (swap pieces, destroy squares, shuffle the board)
- Persist for N moves or until expiry conditions are met

Multiple rules stack simultaneously. The system handles conflicts, field restrictions, and deadlock detection automatically.

##Responsible AI Disclosure

Claude Code used to handle deployments/git pushes and generate changelog summaries because I am lazy. 

## License

[ISC](LICENSE)
