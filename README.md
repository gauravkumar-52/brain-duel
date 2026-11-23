# BrainDuel

Real-time multiplayer game platform: Tic-Tac-Toe and Quiz Clash, live chat, private rooms, and custom quiz creation.

Stack: React.js, Socket.io, Node.js, Express.js, CSS (+ React-Toastify).

## Run

Terminal 1 (server, port 5000):

    cd server
    npm install
    npm run dev

Terminal 2 (client, port 5173):

    cd client
    npm install
    npm run dev

Open http://localhost:5173 in two browser tabs. Create a room in one tab, then join with the room code in the other.

## Environment (optional)

- `server`: `PORT` (default 5000), `CLIENT_URL` (default http://localhost:5173, used for CORS)
- `client`: `VITE_SERVER_URL` (default http://localhost:5000), see `.env.example`

## Socket events

create_room, join_room, leave_room, player_joined, player_left,
make_move, game_update, game_over, rematch, rematch_requested,
start_quiz, new_question, submit_answer, question_result, scores_update, quiz_over,
send_message, receive_message, disconnect
