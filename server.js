const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error("The hosting provider must set a valid PORT environment variable.");
}
const QUESTION_DURATION_MS = 30_000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const PUBLIC_DIR = path.join(__dirname, "public");
const questions = require("./questions");

const game = {
  status: "waiting",
  queue: [],
  players: [],
  questions,
  questionIndex: -1,
};

let questionTimer = null;
let questionDeadline = null;

function scheduleQuestionTimeout() {
  questionDeadline = Date.now() + QUESTION_DURATION_MS;
  questionTimer = setTimeout(advanceQuestion, QUESTION_DURATION_MS);
}

function advanceQuestion() {
  if (questionTimer) clearTimeout(questionTimer);
  questionTimer = null;

  if (game.status !== "playing") return;
  if (game.questionIndex + 1 >= game.questions.length) {
    game.status = "finished";
    questionDeadline = null;
    return;
  }

  game.questionIndex += 1;
  game.players.forEach((player) => { player.answered = false; });
  scheduleQuestionTimeout();
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function getPublicState(deviceId) {
  const question = game.status === "playing" ? game.questions[game.questionIndex] : null;
  const standings = [...game.players].sort((a, b) => b.score - a.score);
  const joinedPlayer = [...game.queue, ...game.players].find((player) => player.deviceId === deviceId);
  return {
    status: game.status,
    deviceJoined: Boolean(joinedPlayer),
    joinedName: joinedPlayer ? joinedPlayer.name : "",
    queue: game.queue.map(({ name }) => ({ name })),
    players: standings.map(({ name, score, answered }) => ({ name, score, answered })),
    questionCount: game.questions.length,
    questionTitles: game.questions.map(({ text }) => text),
    question: question
      ? {
          text: question.text,
          options: question.options,
          number: game.questionIndex + 1,
          total: game.questions.length,
          secondsRemaining: Math.max(0, Math.ceil((questionDeadline - Date.now()) / 1000)),
        }
      : null,
    answeredCount: game.players.filter((player) => player.answered).length,
    podium: game.status === "finished" ? standings.slice(0, 3) : [],
  };
}

function checkAdmin(body) {
  return Boolean(ADMIN_EMAIL && ADMIN_PASSWORD
    && body.email === ADMIN_EMAIL && body.password === ADMIN_PASSWORD);
}

function authorizeAdmin(body, response) {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    sendJson(response, 503, { error: "Der Admin-Zugang ist beim Hosting noch nicht eingerichtet." });
    return false;
  }
  if (!checkAdmin(body)) {
    sendJson(response, 403, { error: "E-Mail oder Passwort stimmt nicht." });
    return false;
  }
  return true;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error("Die Anfrage ist zu groß."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Ungültige Anfrage."));
      }
    });
    request.on("error", reject);
  });
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/state") {
    const url = new URL(request.url, `http://${request.headers.host}`);
    return sendJson(response, 200, getPublicState(url.searchParams.get("deviceId")));
  }

  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Diese Aktion ist nicht verfügbar." });
  }

  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    return sendJson(response, 400, { error: error.message });
  }

  if (pathname === "/api/join") {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 18) : "";
    if (!name) return sendJson(response, 400, { error: "Gib bitte einen Namen ein." });
    const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
    if (!/^[a-f0-9-]{36}$/i.test(deviceId)) {
      return sendJson(response, 400, { error: "Gerätekennung fehlt. Lade die Seite neu." });
    }
    if ([...game.queue, ...game.players].some((player) => player.deviceId === deviceId)) {
      return sendJson(response, 409, { error: "Von diesem Gerät bist du schon dabei." });
    }
    const allNames = [...game.queue, ...game.players].map((player) => player.name.toLowerCase());
    if (allNames.includes(name.toLowerCase())) {
      return sendJson(response, 409, { error: "Der Name ist schon dabei. Nimm bitte einen anderen." });
    }
    if (game.queue.length + game.players.length >= 30) {
      return sendJson(response, 400, { error: "Die Runde ist voll (maximal 30 Leute)." });
    }
    game.queue.push({ name, deviceId });
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === "/api/start") {
    if (!authorizeAdmin(body, response)) return;
    if (game.status === "playing") return sendJson(response, 400, { error: "Die Runde läuft schon." });
    if (!game.queue.length) return sendJson(response, 400, { error: "Noch wartet niemand in der Warteschlange." });
    if (!game.questions.length) return sendJson(response, 400, { error: "Füge zuerst mindestens eine Frage hinzu." });
    game.players = game.queue.map(({ name, deviceId }) => ({ name, deviceId, score: 0, answered: false }));
    game.queue = [];
    game.questionIndex = 0;
    game.status = "playing";
    scheduleQuestionTimeout();
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === "/api/answer") {
    if (game.status !== "playing") return sendJson(response, 400, { error: "Gerade läuft keine Frage." });
    if (Date.now() >= questionDeadline) advanceQuestion();
    if (game.status !== "playing") return sendJson(response, 400, { error: "Die Runde ist schon vorbei." });
    if (body.questionNumber !== game.questionIndex + 1) {
      return sendJson(response, 409, { error: "Diese Frage ist schon vorbei. Die nächste wird geladen." });
    }
    const player = game.players.find((item) => item.name.toLowerCase() === String(body.name).toLowerCase());
    if (!player) return sendJson(response, 404, { error: "Du bist nicht in dieser Runde." });
    if (player.answered) return sendJson(response, 400, { error: "Du hast schon geantwortet." });
    const question = game.questions[game.questionIndex];
    if (!Number.isInteger(body.answer) || body.answer < 0 || body.answer >= question.options.length) {
      return sendJson(response, 400, { error: "Diese Antwort gibt es nicht." });
    }
    if (body.answer === question.correctIndex) player.score += 100;
    player.answered = true;
    if (game.players.every((item) => item.answered)) advanceQuestion();
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === "/api/reset") {
    if (!authorizeAdmin(body, response)) return;
    if (questionTimer) clearTimeout(questionTimer);
    questionTimer = null;
    questionDeadline = null;
    game.status = "waiting";
    game.players = [];
    game.questionIndex = -1;
    return sendJson(response, 200, { ok: true });
  }

  return sendJson(response, 404, { error: "Diese Seite gibt es nicht." });
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname.startsWith("/api/")) {
    return handleApi(request, response, pathname);
  }

  const requestedFile = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, requestedFile);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    response.writeHead(403);
    return response.end("Nicht erlaubt.");
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404);
      return response.end("Datei nicht gefunden.");
    }
    const contentType = filePath.endsWith(".html")
      ? "text/html; charset=utf-8"
      : filePath.endsWith(".png") ? "image/png" : "text/plain; charset=utf-8";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(contents);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Quiz-Ecke ist gestartet.");
});
