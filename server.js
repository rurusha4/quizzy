const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const rooms = new Map();
const DEFAULT_QUESTIONS = [
  {
    question: "Как называется переедание из-за эмоций, а не голода?",
    answers: ["Физическое переедание", "Эмоциональное переедание", "Осознанное питание", "Интуитивное питание"],
    correct: 1
  },
  {
    question: "Какой гормон связан со стрессом?",
    answers: ["Инсулин", "Мелатонин", "Кортизол", "Адреналин"],
    correct: 2
  },
  {
    question: "Какой голод обычно возникает постепенно?",
    answers: ["Физический", "Эмоциональный", "Оба одновременно", "Ни один"],
    correct: 0
  },
  {
    question: "Нужно ли полностью отказываться от сладкого, чтобы избежать эмоционального переедания?",
    answers: ["Да, всегда", "Нет", "Только вечером", "Только в выходные"],
    correct: 1
  },
  {
    question: "Что может помочь справиться со стрессом без еды?",
    answers: ["Запретить себе есть", "Пропустить следующий приём пищи", "Прогуляться или поговорить с близким", "Игнорировать эмоции"],
    correct: 2
  }
];

function makeCode() {
  let code;
  do { code = String(100000 + Math.floor(Math.random() * 900000)); }
  while (rooms.has(code));
  return code;
}

function publicRoom(room) {
  return {
    code: room.code,
    title: room.title,
    phase: room.phase,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, score: p.score,
      answered: room.answers.has(p.id)
    })).sort((a, b) => b.score - a.score),
    questionIndex: room.questionIndex,
    questionCount: room.questions.length,
    currentQuestion: room.phase === "question" ? {
      question: room.questions[room.questionIndex].question,
      answers: room.questions[room.questionIndex].answers,
      number: room.questionIndex + 1,
      timeLimit: room.timeLimit
    } : null,
    answerCount: room.answers.size
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("roomUpdate", publicRoom(room));
}

function endQuestion(room) {
  if (room.phase !== "question") return;
  clearTimeout(room.timer);
  room.phase = "leaderboard";
  broadcastRoom(room);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ title } = {}, callback) => {
    const code = makeCode();
    const room = {
      code,
      title: (title || "Quizzy — новая игра").slice(0, 70),
      hostId: socket.id,
      players: new Map(),
      questions: DEFAULT_QUESTIONS,
      questionIndex: -1,
      phase: "lobby",
      answers: new Map(),
      timer: null,
      timeLimit: 15
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "host";
    callback?.({ ok: true, code, room: publicRoom(room) });
  });

  socket.on("joinRoom", ({ code, name, avatar } = {}, callback) => {
    const room = rooms.get(String(code || "").trim());
    if (!room) return callback?.({ ok: false, error: "Комната не найдена. Проверь PIN-код." });
    if (room.phase !== "lobby") return callback?.({ ok: false, error: "Игра уже началась." });
    const cleanName = String(name || "").trim().slice(0, 18);
    if (!cleanName) return callback?.({ ok: false, error: "Введи никнейм." });
    const player = { id: socket.id, name: cleanName, avatar: avatar || "🐸", score: 0 };
    room.players.set(socket.id, player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.role = "player";
    callback?.({ ok: true, room: publicRoom(room), player });
    broadcastRoom(room);
  });

  socket.on("startGame", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.phase !== "lobby" || room.players.size === 0) return;
    room.questionIndex = 0;
    room.phase = "question";
    room.answers.clear();
    room.deadline = Date.now() + room.timeLimit * 1000;
    broadcastRoom(room);
    room.timer = setTimeout(() => endQuestion(room), room.timeLimit * 1000);
  });

  socket.on("submitAnswer", ({ answerIndex } = {}, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "question" || socket.data.role !== "player") return callback?.({ ok: false });
    if (room.answers.has(socket.id)) return callback?.({ ok: false, error: "Ответ уже принят." });
    const q = room.questions[room.questionIndex];
    const correct = Number(answerIndex) === q.correct;
    const remaining = Math.max(0, room.deadline - Date.now());
    const points = correct ? 500 + Math.round((remaining / (room.timeLimit * 1000)) * 500) : 0;
    room.answers.set(socket.id, { answerIndex: Number(answerIndex), correct, points });
    const player = room.players.get(socket.id);
    if (player) player.score += points;
    callback?.({ ok: true, correct, points, correctIndex: q.correct });
    broadcastRoom(room);
    if (room.answers.size >= room.players.size) endQuestion(room);
  });

  socket.on("nextQuestion", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.id || room.phase !== "leaderboard") return;
    if (room.questionIndex + 1 >= room.questions.length) {
      room.phase = "finished";
      broadcastRoom(room);
      return;
    }
    room.questionIndex += 1;
    room.answers.clear();
    room.phase = "question";
    room.deadline = Date.now() + room.timeLimit * 1000;
    broadcastRoom(room);
    room.timer = setTimeout(() => endQuestion(room), room.timeLimit * 1000);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    if (room.hostId === socket.id) {
      clearTimeout(room.timer);
      io.to(code).emit("roomClosed");
      rooms.delete(code);
      return;
    }
    room.players.delete(socket.id);
    room.answers.delete(socket.id);
    broadcastRoom(room);
    if (room.phase === "question" && room.players.size > 0 && room.answers.size >= room.players.size) endQuestion(room);
  });
});

server.listen(PORT, () => console.log(`Quizzy is running at http://localhost:${PORT}`));
