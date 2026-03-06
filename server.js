// Quiz offline estilo Kahoot - servidor local com painel admin, QR Code, perguntas, respostas e ranking em tempo real
// Como rodar:
// 1) Salve este arquivo como server.js
// 2) No terminal: npm init -y
// 3) Instale: npm i express socket.io qrcode
// 4) Rode: node server.js
// 5) No navegador do administrador: http://localhost:3000/admin
// 6) Para alunos na mesma rede local, descubra o IP da máquina e acesse: http://SEU-IP:3000/play

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '123456';
const ADMIN_TOKEN = crypto.randomBytes(24).toString('hex');

const state = {
  quiz: {
    title: 'Quiz da turma',
    questions: [
      {
        id: 'q1',
        text: 'Qual organela é responsável pela produção de energia na célula?',
        options: ['Lisossomo', 'Mitocôndria', 'Ribossomo', 'Complexo golgiense'],
        correctIndex: 1,
        timeLimit: 20,
      },
      {
        id: 'q2',
        text: 'Qual alternativa representa a função da membrana plasmática?',
        options: [
          'Produzir proteínas',
          'Armazenar DNA',
          'Controlar entrada e saída de substâncias',
          'Realizar respiração celular'
        ],
        correctIndex: 2,
        timeLimit: 20,
      }
    ]
  },
  lobby: {
    players: {},
  },
  game: {
    status: 'idle', // idle | lobby | question | reveal | finished
    currentQuestionIndex: -1,
    questionStartedAt: null,
    answers: {},
    scoreboard: {},
    revealData: null,
    questionTimeout: null,
    nextQuestionTimeout: null,
  }
};

function startLobby() {
  clearGameTimers();
  state.game.status = 'lobby';
  state.game.currentQuestionIndex = -1;
  state.game.questionStartedAt = null;
  resetRoundAnswers();
  resetGameScores();
  emitState();
}

function clearGameTimers() {
  if (state.game.questionTimeout) {
    clearTimeout(state.game.questionTimeout);
    state.game.questionTimeout = null;
  }
  if (state.game.nextQuestionTimeout) {
    clearTimeout(state.game.nextQuestionTimeout);
    state.game.nextQuestionTimeout = null;
  }
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

function sanitizeText(value, fallback = '') {
  return String(value ?? fallback).replace(/[<>]/g, '').trim();
}

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

function getPublicState() {
  return {
    quiz: {
      title: state.quiz.title,
      questionsCount: state.quiz.questions.length,
    },
    lobby: {
      players: Object.values(state.lobby.players).map(p => ({
        id: p.id,
        nickname: p.nickname,
        avatar: p.avatar,
        connected: p.connected,
        score: state.game.scoreboard[p.id] || 0,
      }))
    },
    game: {
      status: state.game.status,
      currentQuestionIndex: state.game.currentQuestionIndex,
      revealData: state.game.revealData,
      ranking: buildRanking(),
    }
  };
}

function buildRanking() {
  return Object.values(state.lobby.players)
    .map(player => ({
      id: player.id,
      nickname: player.nickname,
      avatar: player.avatar,
      score: state.game.scoreboard[player.id] || 0,
    }))
    .sort((a, b) => b.score - a.score);
}

function emitState() {
  io.emit('public:state', getPublicState());
}

function resetGameScores() {
  state.game.scoreboard = {};
  Object.keys(state.lobby.players).forEach(playerId => {
    state.game.scoreboard[playerId] = 0;
  });
}

function resetRoundAnswers() {
  state.game.answers = {};
  state.game.revealData = null;
}

function getCurrentQuestion() {
  return state.quiz.questions[state.game.currentQuestionIndex] || null;
}

function startLobby() {
  state.game.status = 'lobby';
  state.game.currentQuestionIndex = -1;
  state.game.questionStartedAt = null;
  resetRoundAnswers();
  resetGameScores();
  emitState();
}

function startQuestion(index) {
  const question = state.quiz.questions[index];
  if (!question) return false;

  clearGameTimers();

  state.game.status = 'question';
  state.game.currentQuestionIndex = index;
  state.game.questionStartedAt = Date.now();
  resetRoundAnswers();

  io.emit('game:question', {
    index,
    total: state.quiz.questions.length,
    question: {
      id: question.id,
      text: question.text,
      options: question.options,
      timeLimit: question.timeLimit,
    }
  });

  emitState();

  // Quando acabar o tempo, revela automaticamente
  state.game.questionTimeout = setTimeout(() => {
    revealAnswer();

    // Depois de alguns segundos, vai para a próxima
    state.game.nextQuestionTimeout = setTimeout(() => {
      const nextIndex = state.game.currentQuestionIndex + 1;

      if (nextIndex < state.quiz.questions.length) {
        startQuestion(nextIndex);
      } else {
        finishGame();
      }
    }, 5000); // 5 segundos mostrando a resposta/ranking
  }, question.timeLimit * 1000);

  return true;
}

function revealAnswer() {
  const question = getCurrentQuestion();
  if (!question) return false;

  state.game.status = 'reveal';

  const details = Object.values(state.lobby.players).map(player => {
    const answer = state.game.answers[player.id];
    return {
      playerId: player.id,
      nickname: player.nickname,
      avatar: player.avatar,
      selectedIndex: answer ? answer.selectedIndex : null,
      answeredAtMs: answer ? answer.answeredAtMs : null,
      correct: !!(answer && answer.selectedIndex === question.correctIndex),
      score: state.game.scoreboard[player.id] || 0,
    };
  });

  state.game.revealData = {
    questionId: question.id,
    correctIndex: question.correctIndex,
    ranking: buildRanking(),
    answers: details,
  };

  io.emit('game:reveal', state.game.revealData);
  emitState();
  return true;
}

function finishGame() {
  clearGameTimers();
  state.game.status = 'finished';
  state.game.revealData = {
    ranking: buildRanking(),
  };
  io.emit('game:finished', state.game.revealData);
  emitState();
}

function scoreAnswer(question, elapsedMs) {
  const maxMs = question.timeLimit * 1000;
  const safeElapsed = Math.max(0, Math.min(elapsedMs, maxMs));
  const speedFactor = 1 - safeElapsed / maxMs;
  return Math.max(100, Math.round(100 + speedFactor * 400));
}

app.get('/', (req, res) => res.redirect('/play'));

app.post('/api/admin/login', (req, res) => {
  const username = sanitizeText(req.body.username);
  const password = String(req.body.password || '');

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ ok: true, token: ADMIN_TOKEN });
  }

  return res.status(401).json({ ok: false, error: 'Login inválido' });
});

app.get('/api/public/state', (req, res) => {
  res.json(getPublicState());
});

app.get('/api/admin/quiz', adminAuth, (req, res) => {
  res.json({
    title: state.quiz.title,
    questions: state.quiz.questions,
  });
});

app.put('/api/admin/quiz', adminAuth, (req, res) => {
  const title = sanitizeText(req.body.title || 'Quiz da turma', 'Quiz da turma');
  const incomingQuestions = Array.isArray(req.body.questions) ? req.body.questions : [];

  const questions = incomingQuestions
    .map((q, idx) => ({
      id: q.id || `q${idx + 1}_${Date.now()}`,
      text: sanitizeText(q.text),
      options: Array.isArray(q.options) ? q.options.map(opt => sanitizeText(opt)).slice(0, 4) : [],
      correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : 0,
      timeLimit: Math.max(5, Math.min(60, Number(q.timeLimit) || 20)),
    }))
    .filter(q => q.text && q.options.length === 4 && q.options.every(Boolean) && q.correctIndex >= 0 && q.correctIndex < 4);

  if (!questions.length) {
    return res.status(400).json({ error: 'Cadastre ao menos 1 pergunta com 4 alternativas.' });
  }

  state.quiz.title = title;
  state.quiz.questions = questions;
  emitState();
  res.json({ ok: true, quiz: state.quiz });
});

app.post('/api/admin/game/start', adminAuth, (req, res) => {
  startLobby();
  res.json({ ok: true });
});

app.post('/api/admin/game/question/:index', adminAuth, (req, res) => {
  const index = Number(req.params.index);
  const ok = startQuestion(index);
  if (!ok) return res.status(400).json({ error: 'Pergunta não encontrada' });
  res.json({ ok: true });
});

app.post('/api/admin/game/reveal', adminAuth, (req, res) => {
  const ok = revealAnswer();
  if (!ok) return res.status(400).json({ error: 'Nenhuma pergunta ativa' });
  res.json({ ok: true });
});

app.post('/api/admin/game/finish', adminAuth, (req, res) => {
  finishGame();
  res.json({ ok: true });
});

app.post('/api/admin/game/reset', adminAuth, (req, res) => {
  clearGameTimers();
  state.game.status = 'idle';
  state.game.currentQuestionIndex = -1;
  state.game.questionStartedAt = null;
  state.game.answers = {};
  state.game.scoreboard = {};
  state.game.revealData = null;
  emitState();
  res.json({ ok: true });
});

app.get('/api/admin/qrcode', adminAuth, async (req, res) => {
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host');
  const playUrl = `${protocol}://${host}/play`;
  const dataUrl = await QRCode.toDataURL(playUrl, { width: 320, margin: 1 });
  res.json({ playUrl, dataUrl });
});

io.on('connection', (socket) => {
  socket.emit('public:state', getPublicState());

  socket.on('player:join', ({ nickname, avatar }) => {
    const cleanNickname = sanitizeText(nickname, 'Jogador').slice(0, 20) || 'Jogador';
    const cleanAvatar = sanitizeText(avatar || '🎮').slice(0, 4) || '🎮';

    state.lobby.players[socket.id] = {
      id: socket.id,
      nickname: cleanNickname,
      avatar: cleanAvatar,
      connected: true,
    };

    if (state.game.scoreboard[socket.id] == null) {
      state.game.scoreboard[socket.id] = 0;
    }

    socket.emit('player:joined', {
      playerId: socket.id,
      nickname: cleanNickname,
      avatar: cleanAvatar,
    });

    emitState();
  });

  socket.on('player:answer', ({ selectedIndex }) => {
    const player = state.lobby.players[socket.id];
    const question = getCurrentQuestion();
    if (!player || !question || state.game.status !== 'question') return;
    if (state.game.answers[socket.id]) return;

    const elapsedMs = Date.now() - state.game.questionStartedAt;
    const answer = {
      selectedIndex: Number(selectedIndex),
      answeredAtMs: elapsedMs,
    };
    state.game.answers[socket.id] = answer;

    if (answer.selectedIndex === question.correctIndex) {
      state.game.scoreboard[socket.id] = (state.game.scoreboard[socket.id] || 0) + scoreAnswer(question, elapsedMs);
    }

    emitState();
  });

  socket.on('disconnect', () => {
    if (state.lobby.players[socket.id]) {
      state.lobby.players[socket.id].connected = false;
      emitState();
    }
  });
});

function layoutPage(title, body, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    :root {
      --bg1: #2b0d5d;
      --bg2: #6b21a8;
      --panel: rgba(255,255,255,0.12);
      --panel-strong: rgba(255,255,255,0.18);
      --text: #ffffff;
      --muted: #e9d5ff;
      --ok: #22c55e;
      --bad: #ef4444;
      --accent: #facc15;
      --shadow: 0 10px 30px rgba(0,0,0,0.25);
      --radius: 22px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, Arial, sans-serif;
      color: var(--text);
      background: linear-gradient(135deg, var(--bg1), var(--bg2));
      min-height: 100vh;
    }
    .wrap { max-width: 1200px; margin: 0 auto; padding: 20px; }
    .grid { display: grid; gap: 18px; }
    .card {
      background: var(--panel);
      border: 1px solid rgba(255,255,255,0.16);
      box-shadow: var(--shadow);
      border-radius: var(--radius);
      backdrop-filter: blur(12px);
      padding: 18px;
    }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    .between { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    h1,h2,h3,p { margin: 0; }
    .muted { color: var(--muted); }
    input, textarea, select, button {
      font: inherit;
      border-radius: 16px;
      border: none;
    }
    input, textarea, select {
      width: 100%;
      padding: 14px 16px;
      background: rgba(255,255,255,0.92);
      color: #111827;
    }
    textarea { min-height: 84px; resize: vertical; }
    button {
      padding: 12px 16px;
      font-weight: 700;
      cursor: pointer;
      background: #111827;
      color: white;
      box-shadow: var(--shadow);
    }
    button.secondary { background: rgba(255,255,255,0.16); }
    button.success { background: var(--ok); color: #08130c; }
    button.warn { background: var(--accent); color: #2f2400; }
    button.danger { background: var(--bad); }
    .pill {
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.15);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    .question-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
    .answer {
      min-height: 110px;
      border-radius: 22px;
      padding: 18px;
      background: rgba(255,255,255,0.18);
      border: 2px solid transparent;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      font-size: 1.08rem;
      font-weight: 800;
      cursor: pointer;
    }
    .answer.selected { border-color: #fff; transform: scale(0.98); }
    .option1 { background: #dc2626; }
    .option2 { background: #2563eb; }
    .option3 { background: #d97706; }
    .option4 { background: #16a34a; }
    .players { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .player {
      padding: 14px;
      border-radius: 18px;
      background: rgba(255,255,255,0.12);
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
    }
    .rank-item {
      display: grid;
      grid-template-columns: 60px 1fr auto;
      gap: 12px;
      align-items: center;
      padding: 12px;
      background: rgba(255,255,255,0.1);
      border-radius: 18px;
    }
    .hidden { display: none !important; }
    .center { text-align: center; }
    .big { font-size: clamp(1.6rem, 3vw, 3rem); font-weight: 900; }
    .timer { font-size: 2rem; font-weight: 900; }
    .admin-layout { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 18px; }
    @media (max-width: 900px) { .admin-layout { grid-template-columns: 1fr; } }
  </style>
  ${extraHead}
</head>
<body>
  ${body}
</body>
</html>`;
}

app.get('/play', (req, res) => {
  res.send(layoutPage('Quiz Offline - Jogador', `
  <div class="wrap grid">
    <div class="between">
      <div>
        <h1>Quiz da turma</h1>
        <p class="muted">Entre com apelido e participe da partida local.</p>
      </div>
      <div class="pill" id="statusPill">Aguardando conexão</div>
    </div>

    <section class="card" id="joinCard">
      <div class="grid">
        <div class="center"><div class="big">🎓</div></div>
        <input id="nickname" placeholder="Seu apelido" maxlength="20" />
        <input id="avatar" placeholder="Avatar emoji (ex: 😎)" maxlength="4" value="😎" />
        <button id="joinBtn">Entrar no jogo</button>
      </div>
    </section>

    <section class="card hidden" id="waitingCard">
      <div class="grid center">
        <div class="big" id="welcomeText">Você entrou!</div>
        <p class="muted">Espere o professor iniciar a próxima pergunta.</p>
      </div>
    </section>

    <section class="card hidden" id="questionCard">
      <div class="between">
        <div>
          <div class="pill" id="questionMeta">Pergunta</div>
        </div>
        <div class="timer" id="timer">--</div>
      </div>
      <div class="grid" style="margin-top:16px; gap:16px;">
        <div class="big center" id="questionText">Pergunta</div>
        <div class="question-grid" id="answersGrid"></div>
      </div>
    </section>

    <section class="card hidden" id="resultCard">
      <div class="grid center">
        <div class="big" id="resultTitle">Resultado</div>
        <p class="muted" id="resultSubtitle">Aguarde a próxima etapa.</p>
      </div>
    </section>

    <section class="card hidden" id="finalCard">
      <div class="grid">
        <div class="big center">Ranking final</div>
        <div id="finalRanking" class="grid"></div>
      </div>
    </section>
  </div>

  <script>
    const socket = io();
    let playerId = null;
    let selectedIndex = null;
    let timerInterval = null;

    const statusPill = document.getElementById('statusPill');
    const joinCard = document.getElementById('joinCard');
    const waitingCard = document.getElementById('waitingCard');
    const questionCard = document.getElementById('questionCard');
    const resultCard = document.getElementById('resultCard');
    const finalCard = document.getElementById('finalCard');
    const answersGrid = document.getElementById('answersGrid');
    const timerEl = document.getElementById('timer');

    function showOnly(section) {
      [joinCard, waitingCard, questionCard, resultCard, finalCard].forEach(el => el.classList.add('hidden'));
      section.classList.remove('hidden');
    }

    function renderRanking(container, ranking) {
      container.innerHTML = '';
      ranking.forEach((item, idx) => {
        const div = document.createElement('div');
        div.className = 'rank-item';
        div.innerHTML = '<div class="big">#' + (idx + 1) + '</div><div><h3>' + item.avatar + ' ' + item.nickname + '</h3><p class="muted">Pontuação</p></div><div><strong>' + item.score + '</strong></div>';
        container.appendChild(div);
      });
    }

    document.getElementById('joinBtn').onclick = () => {
      const nickname = document.getElementById('nickname').value.trim();
      const avatar = document.getElementById('avatar').value.trim() || '😎';
      if (!nickname) return alert('Digite um apelido.');
      socket.emit('player:join', { nickname, avatar });
    };

    socket.on('connect', () => {
      statusPill.textContent = 'Conectado à sala local';
    });

    socket.on('player:joined', (payload) => {
      playerId = payload.playerId;
      document.getElementById('welcomeText').textContent = payload.avatar + ' ' + payload.nickname + ', você entrou!';
      showOnly(waitingCard);
    });

    socket.on('game:question', ({ index, total, question }) => {
      showOnly(questionCard);
      selectedIndex = null;
      document.getElementById('questionMeta').textContent = 'Pergunta ' + (index + 1) + ' de ' + total;
      document.getElementById('questionText').textContent = question.text;
      answersGrid.innerHTML = '';

      question.options.forEach((option, idx) => {
        const btn = document.createElement('button');
        btn.className = 'answer option' + (idx + 1);
        btn.textContent = option;
        btn.onclick = () => {
          if (selectedIndex !== null) return;
          selectedIndex = idx;
          btn.classList.add('selected');
          socket.emit('player:answer', { selectedIndex: idx });
          document.getElementById('resultTitle').textContent = 'Resposta enviada!';
          document.getElementById('resultSubtitle').textContent = 'Aguarde o professor revelar o resultado.';
        };
        answersGrid.appendChild(btn);
      });

      const deadline = Date.now() + question.timeLimit * 1000;
      clearInterval(timerInterval);
      timerInterval = setInterval(() => {
        const diff = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        timerEl.textContent = diff + 's';
        if (diff <= 0) clearInterval(timerInterval);
      }, 250);
    });

    socket.on('game:reveal', (data) => {
      clearInterval(timerInterval);
      showOnly(resultCard);
      const me = (data.answers || []).find(a => a.playerId === playerId);
      const correct = me ? me.correct : false;
      document.getElementById('resultTitle').textContent = correct ? '✅ Você acertou!' : '❌ Não foi dessa vez';
      document.getElementById('resultSubtitle').textContent = 'Alternativa correta: ' + ((data.correctIndex ?? 0) + 1) + '. Aguarde a próxima pergunta.';
    });

    socket.on('game:finished', (data) => {
      showOnly(finalCard);
      renderRanking(document.getElementById('finalRanking'), data.ranking || []);
    });

    socket.on('public:state', (state) => {
      if (state.game.status === 'finished') {
        showOnly(finalCard);
        renderRanking(document.getElementById('finalRanking'), state.game.ranking || []);
      } else if (playerId && state.game.status !== 'question' && state.game.status !== 'finished') {
        showOnly(waitingCard);
      }
    });
  </script>
  `));
});

app.get('/admin', (req, res) => {
  res.send(layoutPage('Quiz Offline - Admin', `
  <div class="wrap grid">
    <div class="between">
      <div>
        <h1>Painel do administrador</h1>
        <p class="muted">Cadastre perguntas, gere QR Code e controle a partida.</p>
      </div>
      <div class="pill">Login protegido</div>
    </div>

    <section class="card" id="loginSection">
      <div class="grid" style="max-width:420px; margin:0 auto;">
        <input id="adminUser" placeholder="Usuário" value="admin" />
        <input id="adminPass" type="password" placeholder="Senha" value="123456" />
        <button id="loginBtn">Entrar</button>
      </div>
    </section>

    <section id="adminSection" class="hidden grid">
      <div class="admin-layout">
        <div class="grid">
          <div class="card grid">
            <div class="between"><h2>Configuração do quiz</h2><button class="success" id="saveQuizBtn">Salvar quiz</button></div>
            <input id="quizTitle" placeholder="Título do quiz" />
            <div id="questionsEditor" class="grid"></div>
            <button class="secondary" id="addQuestionBtn">+ Adicionar pergunta</button>
          </div>

          <div class="card grid">
            <div class="between">
              <h2>Controle da partida</h2>
              <div class="row">
  <button class="success" id="startGameBtn">Iniciar jogo</button>
  <button class="secondary" id="startLobbyBtn">Abrir lobby</button>
  <button class="warn" id="revealBtn">Revelar resposta</button>
  <button class="danger" id="finishBtn">Finalizar</button>
  <button class="secondary" id="resetBtn">Resetar</button>
  <div style="text-align:right; margin-top:50px; font-size:15px; opacity:0.8;">
  Desenvolvido por <strong>Igor Solarth</strong>
</div>
</div>
            </div>
            <div class="row" id="questionButtons"></div>
          </div>
        </div>

        <div class="grid">
          <div class="card grid center">
            <h2>Entrada por QR Code</h2>
            <img id="qrImage" alt="QR Code" style="width:100%; max-width:280px; margin:0 auto; border-radius:20px; background:white; padding:8px;" />
            <p id="playUrl" class="muted"></p>
          </div>

          <div class="card grid">
            <div class="between"><h2>Jogadores</h2><span class="pill" id="gameStatus">Status: idle</span></div>
            <div id="playersList" class="players"></div>
          </div>

          <div class="card grid">
            <h2>Ranking</h2>
            <div id="rankingList" class="grid"></div>
          </div>
        </div>
      </div>
    </section>
  </div>

  <script>
    const socket = io();
    let adminToken = localStorage.getItem('adminToken') || '';
    let quizData = { title: 'Quiz da turma', questions: [] };

    const loginSection = document.getElementById('loginSection');
    const adminSection = document.getElementById('adminSection');
    const questionsEditor = document.getElementById('questionsEditor');
    const questionButtons = document.getElementById('questionButtons');

    function authHeaders() {
      return { 'Content-Type': 'application/json', 'x-admin-token': adminToken };
    }

    function setLoggedIn(value) {
      loginSection.classList.toggle('hidden', value);
      adminSection.classList.toggle('hidden', !value);
    }

    async function login() {
      const username = document.getElementById('adminUser').value.trim();
      const password = document.getElementById('adminPass').value;
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (!res.ok) return alert('Login inválido.');
      const data = await res.json();
      adminToken = data.token;
      localStorage.setItem('adminToken', adminToken);
      setLoggedIn(true);
      await loadQuiz();
      await loadQr();
    }

    async function loadQuiz() {
      const res = await fetch('/api/admin/quiz', { headers: authHeaders() });
      if (!res.ok) {
        setLoggedIn(false);
        return;
      }
      quizData = await res.json();
      document.getElementById('quizTitle').value = quizData.title || '';
      renderQuestions();
      renderQuestionButtons();
    }

    async function loadQr() {
      const res = await fetch('/api/admin/qrcode', { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      document.getElementById('qrImage').src = data.dataUrl;
      document.getElementById('playUrl').textContent = data.playUrl;
    }

    function renderQuestions() {
      questionsEditor.innerHTML = '';
      quizData.questions.forEach((q, qIdx) => {
        const card = document.createElement('div');
        card.className = 'card grid';
        card.innerHTML = 
          '<div class="between"><h3>Pergunta ' + (qIdx + 1) + '</h3><button class="danger" data-remove="' + qIdx + '">Remover</button></div>' +
          '<textarea data-field="text" data-index="' + qIdx + '" placeholder="Enunciado">' + (q.text || '') + '</textarea>' +
          '<div class="grid">' +
            q.options.map((opt, optIdx) => '<input data-field="option" data-qindex="' + qIdx + '" data-oidx="' + optIdx + '" placeholder="Alternativa ' + (optIdx + 1) + '" value="' + (opt || '') + '" />').join('') +
          '</div>' +
          '<div class="row">' +
            '<label>Correta: <select data-field="correctIndex" data-index="' + qIdx + '">' +
              [0,1,2,3].map(i => '<option value="' + i + '" ' + (q.correctIndex === i ? 'selected' : '') + '>Alternativa ' + (i + 1) + '</option>').join('') +
            '</select></label>' +
            '<label>Tempo: <input type="number" min="5" max="60" data-field="timeLimit" data-index="' + qIdx + '" value="' + (q.timeLimit || 20) + '" /></label>' +
          '</div>';
        questionsEditor.appendChild(card);
      });

      questionsEditor.querySelectorAll('[data-field="text"]').forEach(el => {
        el.oninput = e => quizData.questions[Number(e.target.dataset.index)].text = e.target.value;
      });
      questionsEditor.querySelectorAll('[data-field="option"]').forEach(el => {
        el.oninput = e => quizData.questions[Number(e.target.dataset.qindex)].options[Number(e.target.dataset.oidx)] = e.target.value;
      });
      questionsEditor.querySelectorAll('[data-field="correctIndex"]').forEach(el => {
        el.onchange = e => quizData.questions[Number(e.target.dataset.index)].correctIndex = Number(e.target.value);
      });
      questionsEditor.querySelectorAll('[data-field="timeLimit"]').forEach(el => {
        el.oninput = e => quizData.questions[Number(e.target.dataset.index)].timeLimit = Number(e.target.value);
      });
      questionsEditor.querySelectorAll('[data-remove]').forEach(el => {
        el.onclick = e => {
          quizData.questions.splice(Number(e.target.dataset.remove), 1);
          renderQuestions();
          renderQuestionButtons();
        };
      });
    }

    function renderQuestionButtons() {
      questionButtons.innerHTML = '';
      quizData.questions.forEach((q, idx) => {
        const btn = document.createElement('button');
        btn.textContent = 'Pergunta ' + (idx + 1);
        btn.onclick = () => startQuestion(idx);
        questionButtons.appendChild(btn);
      });
    }

    async function saveQuiz() {
      quizData.title = document.getElementById('quizTitle').value.trim() || 'Quiz da turma';
      const res = await fetch('/api/admin/quiz', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(quizData)
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || 'Erro ao salvar quiz.');
      alert('Quiz salvo com sucesso!');
      await loadQuiz();
    }

    async function post(url) {
      const res = await fetch(url, { method: 'POST', headers: authHeaders() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return alert(data.error || 'Erro na operação.');
    }

    async function startQuestion(idx) {
      await post('/api/admin/game/question/' + idx);
    }

    function renderPlayers(players) {
      const list = document.getElementById('playersList');
      list.innerHTML = '';
      players.forEach(player => {
        const el = document.createElement('div');
        el.className = 'player';
        el.innerHTML = '<div><strong>' + player.avatar + ' ' + player.nickname + '</strong><div class="muted">' + (player.connected ? 'Online' : 'Desconectado') + '</div></div><div>' + player.score + '</div>';
        list.appendChild(el);
      });
    }

    function renderRanking(ranking) {
      const list = document.getElementById('rankingList');
      list.innerHTML = '';
      ranking.forEach((item, idx) => {
        const el = document.createElement('div');
        el.className = 'rank-item';
        el.innerHTML = '<div class="big">#' + (idx + 1) + '</div><div><strong>' + item.avatar + ' ' + item.nickname + '</strong><div class="muted">Pontuação</div></div><div><strong>' + item.score + '</strong></div>';
        list.appendChild(el);
      });
    }

    document.getElementById('loginBtn').onclick = login;
    document.getElementById('saveQuizBtn').onclick = saveQuiz;
    document.getElementById('addQuestionBtn').onclick = () => {
      quizData.questions.push({
        id: 'q' + Date.now(),
        text: '',
        options: ['', '', '', ''],
        correctIndex: 0,
        timeLimit: 20,
      });
      renderQuestions();
      renderQuestionButtons();
    };
    document.getElementById('startLobbyBtn').onclick = () => post('/api/admin/game/start');
    document.getElementById('revealBtn').onclick = () => post('/api/admin/game/reveal');
    document.getElementById('finishBtn').onclick = () => post('/api/admin/game/finish');
    document.getElementById('resetBtn').onclick = () => post('/api/admin/game/reset');
    document.getElementById('startGameBtn').onclick = async () => {
  await post('/api/admin/game/start');
  await post('/api/admin/game/question/0');
};

    socket.on('public:state', (state) => {
      document.getElementById('gameStatus').textContent = 'Status: ' + state.game.status;
      renderPlayers(state.lobby.players || []);
      renderRanking(state.game.ranking || []);
    });

    (async function init() {
      if (!adminToken) return setLoggedIn(false);
      setLoggedIn(true);
      await loadQuiz();
      await loadQr();
    })();
  </script>
  `));
});

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`Painel admin: http://localhost:${PORT}/admin`);
  console.log(`Entrada dos jogadores: http://${getLocalIp()}:${PORT}/play`);
  console.log(`Login admin: ${ADMIN_USER}`);
  console.log(`Senha admin: ${ADMIN_PASS}`);
});
