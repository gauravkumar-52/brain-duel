import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { DEFAULT_QUIZ } from "./defaultQuiz.js";

const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

const app = express();
app.use(cors({ origin: CLIENT_URL }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_URL, methods: ["GET", "POST"] },
});

/* ---------------- constants & in-memory state ---------------- */

const MAX_PLAYERS = { tictactoe: 2, quiz: 8 };
const QUESTION_SECONDS = 15;
const RESULT_PAUSE_MS = 3000;
const BASE_POINTS = 100;
const SPEED_BONUS = 50;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
];

// rooms[roomId] = { id, game, hostId, status, players, ttt, quiz }
const rooms = {};

/* ---------------- helpers ---------------- */

const reply = (cb, payload) => typeof cb === "function" && cb(payload);
const cleanName = (n) => String(n ?? "").trim().slice(0, 20);

function generateRoomId() {
  let id;
  do {
    id = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms[id]);
  return id;
}

// Server-side validation of a custom quiz (client checks can be skipped).
function validateQuestions(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 20) return null;
  const cleaned = [];
  for (const q of list) {
    const text = String(q?.text ?? "").trim().slice(0, 200);
    const options = Array.isArray(q?.options) ? q.options.map((o) => String(o ?? "").trim().slice(0, 100)) : [];
    if (!text || options.length !== 4 || options.some((o) => !o)) return null;
    if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) return null;
    cleaned.push({ text, options, correct: q.correct });
  }
  return cleaned;
}

const newTTT = () => ({ board: Array(9).fill(""), turn: "X", result: null, rematch: [] });
const tttState = (room) => ({ board: room.ttt.board, turn: room.ttt.turn, result: room.ttt.result });

function getResult(board) {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { winner: board[a] };
  }
  if (board.every((cell) => cell)) return { draw: true };
  return null;
}

function publicRoom(room) {
  return {
    id: room.id,
    game: room.game,
    hostId: room.hostId,
    status: room.status,
    players: room.players.map(({ id, name, symbol }) => ({ id, name, symbol })),
    ttt: room.game === "tictactoe" ? tttState(room) : null,
    totalQuestions: room.game === "quiz" ? room.quiz.questions.length : 0,
  };
}

// The client sends roomId, but we only trust the room the socket really joined.
function roomFor(socket, roomId) {
  const room = rooms[socket.data.roomId];
  return room && room.id === roomId ? room : null;
}

const scoreList = (room) =>
  room.players
    .map((p) => ({ id: p.id, name: p.name, score: room.quiz.scores[p.id] || 0 }))
    .sort((a, b) => b.score - a.score);

/* ---------------- quiz flow ---------------- */

function sendQuestion(room) {
  const q = room.quiz;
  q.index += 1;
  if (q.index >= q.questions.length) return endQuiz(room);

  q.answers = {};
  q.open = true;
  q.endsAt = Date.now() + QUESTION_SECONDS * 1000;
  const { text, options } = q.questions[q.index]; // correct answer is NOT sent
  io.to(room.id).emit("new_question", {
    index: q.index,
    total: q.questions.length,
    text,
    options,
    duration: QUESTION_SECONDS,
  });
  q.timer = setTimeout(() => closeQuestion(room), QUESTION_SECONDS * 1000);
}

function closeQuestion(room) {
  const q = room.quiz;
  if (!q.open) return;
  q.open = false;
  clearTimeout(q.timer);
  io.to(room.id).emit("question_result", { correct: q.questions[q.index].correct });
  io.to(room.id).emit("scores_update", { scores: scoreList(room) });
  q.timer = setTimeout(() => sendQuestion(room), RESULT_PAUSE_MS);
}

function endQuiz(room) {
  room.quiz.open = false;
  room.status = "finished";
  io.to(room.id).emit("quiz_over", { scores: scoreList(room) });
}

/* ---------------- leaving / cleanup ---------------- */

function removePlayer(socket) {
  const room = rooms[socket.data.roomId];
  socket.data.roomId = null;
  if (!room) return;
  socket.leave(room.id);

  const idx = room.players.findIndex((p) => p.id === socket.id);
  if (idx === -1) return;
  const [left] = room.players.splice(idx, 1);

  if (room.players.length === 0) {
    if (room.quiz) clearTimeout(room.quiz.timer);
    delete rooms[room.id];
    return;
  }

  if (room.hostId === left.id) room.hostId = room.players[0].id;

  let forfeit = null;
  if (room.game === "tictactoe" && room.status === "playing") {
    forfeit = { winner: room.players[0].symbol, reason: "opponent_left" };
    room.ttt.result = forfeit;
    room.status = "finished";
  }

  io.to(room.id).emit("player_left", { room: publicRoom(room), player: { id: left.id, name: left.name } });
  if (forfeit) io.to(room.id).emit("game_over", forfeit);

  // If everyone still in the room has answered, don't wait for the timer.
  if (room.game === "quiz" && room.status === "playing" && room.quiz.open) {
    if (room.players.every((p) => room.quiz.answers[p.id] !== undefined)) closeQuestion(room);
  }
}

/* ---------------- socket events ---------------- */

io.on("connection", (socket) => {
  socket.data.roomId = null;
  socket.data.lastMessageAt = 0;

  socket.on("create_room", (payload, cb) => {
    const { name, game, questions } = payload || {};
    const playerName = cleanName(name);
    if (!playerName) return reply(cb, { ok: false, error: "name_required" });
    if (!MAX_PLAYERS[game]) return reply(cb, { ok: false, error: "invalid_game" });

    let quizQuestions = DEFAULT_QUIZ;
    if (game === "quiz" && questions !== undefined) {
      quizQuestions = validateQuestions(questions);
      if (!quizQuestions) return reply(cb, { ok: false, error: "invalid_quiz" });
    }

    removePlayer(socket);
    const room = {
      id: generateRoomId(),
      game,
      hostId: socket.id,
      status: "waiting",
      players: [{ id: socket.id, name: playerName, symbol: game === "tictactoe" ? "X" : null }],
      ttt: game === "tictactoe" ? newTTT() : null,
      quiz: game === "quiz"
        ? { questions: quizQuestions, index: -1, scores: {}, answers: {}, open: false, endsAt: 0, timer: null }
        : null,
    };
    rooms[room.id] = room;
    socket.join(room.id);
    socket.data.roomId = room.id;
    reply(cb, { ok: true, room: publicRoom(room), you: socket.id });
  });

  socket.on("join_room", (payload, cb) => {
    const { roomId, name } = payload || {};
    const playerName = cleanName(name);
    if (!playerName) return reply(cb, { ok: false, error: "name_required" });

    const room = rooms[String(roomId ?? "").trim().toUpperCase()];
    if (!room) return reply(cb, { ok: false, error: "room_not_found" });
    if (room.players.some((p) => p.id === socket.id)) return reply(cb, { ok: false, error: "already_in_room" });
    if (room.players.length >= MAX_PLAYERS[room.game]) return reply(cb, { ok: false, error: "room_full" });
    if (room.game === "quiz" && room.status === "playing") return reply(cb, { ok: false, error: "game_in_progress" });

    removePlayer(socket);
    room.players.push({ id: socket.id, name: playerName, symbol: null });
    socket.join(room.id);
    socket.data.roomId = room.id;

    if (room.game === "tictactoe" && room.players.length === 2) {
      room.players[0].symbol = "X";
      room.players[1].symbol = "O";
      room.ttt = newTTT();
      room.status = "playing";
    }

    const snapshot = publicRoom(room);
    reply(cb, { ok: true, room: snapshot, you: socket.id });
    socket.to(room.id).emit("player_joined", { room: snapshot, player: { id: socket.id, name: playerName } });
  });

  socket.on("leave_room", () => removePlayer(socket));

  /* ----- Tic-Tac-Toe ----- */

  socket.on("make_move", ({ roomId, index } = {}) => {
    const room = roomFor(socket, roomId);
    if (!room || room.game !== "tictactoe" || room.status !== "playing") return;
    const player = room.players.find((p) => p.id === socket.id);
    if (!player || player.symbol !== room.ttt.turn) return;                       // not your turn
    if (!Number.isInteger(index) || index < 0 || index > 8 || room.ttt.board[index]) return; // bad / filled cell

    room.ttt.board[index] = player.symbol;
    const result = getResult(room.ttt.board);
    if (result) {
      room.ttt.result = result;
      room.status = "finished";
    } else {
      room.ttt.turn = player.symbol === "X" ? "O" : "X";
    }
    io.to(room.id).emit("game_update", tttState(room));
    if (result) io.to(room.id).emit("game_over", result);
  });

  socket.on("rematch", ({ roomId } = {}) => {
    const room = roomFor(socket, roomId);
    if (!room || room.game !== "tictactoe" || room.status !== "finished" || room.players.length !== 2) return;
    if (!room.ttt.rematch.includes(socket.id)) room.ttt.rematch.push(socket.id);

    if (room.ttt.rematch.length === 2) {
      room.ttt = newTTT();
      room.status = "playing";
      io.to(room.id).emit("game_update", tttState(room));
    } else {
      const me = room.players.find((p) => p.id === socket.id);
      socket.to(room.id).emit("rematch_requested", { by: me.name });
    }
  });

  /* ----- Quiz Clash ----- */

  socket.on("start_quiz", ({ roomId } = {}, cb) => {
    const room = roomFor(socket, roomId);
    if (!room || room.game !== "quiz") return reply(cb, { ok: false, error: "room_not_found" });
    if (room.hostId !== socket.id) return reply(cb, { ok: false, error: "host_only" });
    if (room.status === "playing") return reply(cb, { ok: false, error: "game_in_progress" });

    clearTimeout(room.quiz.timer);
    room.status = "playing";
    room.quiz.index = -1;
    room.quiz.scores = {};
    room.players.forEach((p) => (room.quiz.scores[p.id] = 0));
    reply(cb, { ok: true });
    io.to(room.id).emit("scores_update", { scores: scoreList(room) });
    sendQuestion(room);
  });

  socket.on("submit_answer", ({ roomId, choice } = {}, cb) => {
    const room = roomFor(socket, roomId);
    if (!room || room.game !== "quiz" || room.status !== "playing") return reply(cb, { ok: false });
    const q = room.quiz;
    const now = Date.now();
    if (!q.open || now > q.endsAt) return reply(cb, { ok: false, error: "time_up" });
    if (q.answers[socket.id] !== undefined) return reply(cb, { ok: false, error: "already_answered" });
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return reply(cb, { ok: false });

    q.answers[socket.id] = choice;
    const correct = choice === q.questions[q.index].correct;
    let points = 0;
    if (correct) {
      const remaining = Math.max(0, q.endsAt - now) / (QUESTION_SECONDS * 1000);
      points = BASE_POINTS + Math.round(remaining * SPEED_BONUS); // faster answers earn more
      q.scores[socket.id] = (q.scores[socket.id] || 0) + points;
    }
    reply(cb, { ok: true, correct, points });

    if (room.players.every((p) => q.answers[p.id] !== undefined)) closeQuestion(room);
  });

  /* ----- Chat ----- */

  socket.on("send_message", ({ roomId, text } = {}) => {
    const room = roomFor(socket, roomId);
    if (!room) return;
    const player = room.players.find((p) => p.id === socket.id);
    const body = String(text ?? "").trim().slice(0, 200);
    const now = Date.now();
    if (!player || !body || now - socket.data.lastMessageAt < 500) return; // basic rate limit
    socket.data.lastMessageAt = now;
    io.to(room.id).emit("receive_message", {
      id: `${now}-${socket.id}`,
      senderId: socket.id,
      name: player.name,
      text: body,
      time: now,
    });
  });

  socket.on("disconnect", () => removePlayer(socket));
});

server.listen(PORT, () => console.log(`BrainDuel server running on port ${PORT}`));
